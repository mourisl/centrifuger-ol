// Web Worker that runs Centrifuger (compiled to WebAssembly) entirely in the
// browser. Reads never leave the user's machine.
//
// Messages in:
//   { type: 'loadIndex', index: name }
//   { type: 'run', index: name, reads: { r1: File, r2?: File }, options: { k, minHitLen, noDust } }
//   { type: 'cleanup' }   (page is closing: delete this tab's result file)
// Messages out:
//   { type: 'index', name, state: 'downloading'|'ready', loaded, total, manifest, cached }
//   { type: 'progress', stage, fraction }
//   { type: 'log', line }
//   { type: 'done', classTsv: Blob (gzip), storage: 'disk'|'memory', reports: { centrifuger, metaphlan, cami, kreport }, stats, timings }
//
// The per-read classification is gzip-compressed as it is written and streams
// straight into a file in the origin private file system (on disk), so its
// size does not count against memory.
// Without OPFS support it is collected in memory instead. Each tab holds a Web
// Lock on its result file, which the browser releases when the tab goes away;
// files whose lock is free are deleted when the page loads and before each run.
//   { type: 'error', message }
import createCentrifuger from './wasm/centrifuger.js';
import createCentrifugerQuant from './wasm/centrifuger-quant.js';
import { mkOutputDevice, gzipper } from './output.js';

const CACHE_NAME = 'centrifuger-index-v3'; // v3: 45 MiB parts (same names as the older 24 MiB parts)
const RESULT_DIR = 'centrifuger-results'; // OPFS directory for classification output
const GZIP_LEVEL = 6;
const OLD_CACHES = ['centrifuger-index-v1', 'centrifuger-index-v2'];

// Only the most recently selected index is kept in memory.
let manifest = null; // manifest of the loaded index
let indexFiles = null; // Map name -> Uint8Array (decompressed .cfr)
let indexPromise = null;
let loadingName = null;
const compiled = {}; // wasm URL -> Promise<WebAssembly.Module>

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

async function openCache() {
  try {
    for (const old of OLD_CACHES) await caches.delete(old);
    return await caches.open(CACHE_NAME);
  } catch (e) {
    return null; // Cache API unavailable (e.g. some private modes); download every time.
  }
}

// Drop cached parts of this index that belong to other versions.
async function pruneCache(dirUrl, keepUrls) {
  const cache = await openCache();
  if (!cache) return;
  for (const req of await cache.keys()) {
    if (req.url.startsWith(dirUrl) && !keepUrls.has(req.url)) await cache.delete(req);
  }
}

async function fetchBytes(url, onProgress) {
  const cache = await openCache();
  let res = cache ? await cache.match(url) : undefined;
  const cached = !!res;
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    if (cache) {
      try {
        await cache.put(url, res.clone());
      } catch (e) {
        // Quota exceeded: keep going without caching.
      }
    }
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, cached);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, cached };
}

async function gunzipIfNeeded(bytes) {
  // Some hosts transparently decode .gz responses; only inflate real gzip data.
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(chunks) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function loadIndex(name) {
  if (indexPromise && loadingName === name) return indexPromise;
  manifest = null;
  indexFiles = null; // release the previous index
  loadingName = name;
  const p = (async () => {
    const dir = new URL(`index/${name}/`, import.meta.url);
    const mres = await fetch(new URL('manifest.json', dir), { cache: 'no-cache' });
    if (!mres.ok) throw new Error(`Cannot load the manifest of index "${name}" (HTTP ${mres.status})`);
    const m = await mres.json();
    const total = m.files.reduce((s, f) => s + f.gzSize, 0);
    const loadedPer = {};
    let allCached = true;
    const report = () =>
      post({ type: 'index', name, state: 'downloading', loaded: Object.values(loadedPer).reduce((a, b) => a + b, 0), total, manifest: m });
    report();
    const urls = new Set();
    const files = new Map();
    // One file and one part at a time, so loading stays light on the computer.
    for (const f of m.files) {
      const chunks = [];
      for (const part of f.parts || [f.url]) {
        const url = new URL(part, dir).href + '?v=' + f.sha256.slice(0, 12);
        urls.add(url);
        const { bytes, cached } = await fetchBytes(url, (n) => {
          loadedPer[url] = n;
          report();
        });
        if (!cached) allCached = false;
        chunks.push(bytes);
      }
      files.set(f.name, await gunzipIfNeeded(concat(chunks)));
    }
    pruneCache(dir.href, urls).catch(() => {});
    if (loadingName !== name) return; // another index was selected meanwhile
    manifest = m;
    indexFiles = files;
    post({ type: 'index', name, state: 'ready', loaded: total, total, manifest: m, cached: allCached });
  })();
  indexPromise = p;
  p.catch(() => {
    if (indexPromise === p) indexPromise = null;
  });
  return p;
}

// Compile each .wasm once and reuse it for every fresh module instance.
function instantiateWith(wasmFile) {
  const url = new URL('wasm/' + wasmFile, import.meta.url).href;
  return (imports, success) => {
    // compileStreaming requires the server to send application/wasm; fall back
    // to a buffered compile for servers that do not (e.g. old python http.server).
    if (!compiled[url])
      compiled[url] = WebAssembly.compileStreaming(fetch(url)).catch(() =>
        fetch(url).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)));
    compiled[url]
      .then((mod) => WebAssembly.instantiate(mod, imports))
      .then((inst) => success(inst, compiled[url]))
      .catch((e) => post({ type: 'error', message: 'Failed to load WebAssembly: ' + e.message }));
    return {};
  };
}

async function newModule(factory, wasmFile) {
  return factory({
    instantiateWasm: instantiateWith(wasmFile),
    print: (line) => post({ type: 'log', line }),
    printErr: (line) => post({ type: 'log', line }),
  });
}

function writeIndex(mod, names) {
  mod.FS.mkdir('/idx');
  for (const n of names) mod.FS.writeFile('/idx/' + n, indexFiles.get(n));
}

function callMain(mod, args) {
  let rc;
  try {
    rc = mod.callMain(args);
  } catch (e) {
    // exit() inside the program surfaces as an ExitStatus exception.
    if (e && typeof e.status === 'number') rc = e.status;
    else throw e;
  }
  if (rc !== 0) throw new Error(`Centrifuger exited with status ${rc}. See the log for details.`);
}

function idxName(i) {
  return `${manifest.name}.${i}.cfr`;
}

// Counts reads in the classification TSV as it is written. There is one line
// per (read, assignment), and the lines of one read are consecutive.
function readCounter() {
  const dec = new TextDecoder();
  const stats = { totalReads: 0, classifiedReads: 0 };
  let carry = '';
  let header = true;
  let prev = null;
  const line = (l) => {
    if (header) {
      header = false;
      return;
    }
    const t1 = l.indexOf('\t');
    if (t1 <= 0) return;
    const id = l.slice(0, t1);
    if (id === prev) return;
    prev = id;
    stats.totalReads++;
    if (l.slice(t1 + 1, l.indexOf('\t', t1 + 1)) !== 'unclassified') stats.classifiedReads++;
  };
  return {
    push(bytes) {
      const text = carry + dec.decode(bytes, { stream: true });
      let start = 0;
      for (let end; (end = text.indexOf('\n', start)) >= 0; start = end + 1) line(text.slice(start, end));
      carry = text.slice(start);
    },
    finish() {
      if (carry) line(carry);
      return stats;
    },
  };
}

let current = null; // { dir, name, release }: this tab's latest result file

const lockName = (file) => `${RESULT_DIR}/${file}`;

async function resultDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RESULT_DIR, { create: true });
}

// Takes the lock for a result file and keeps it until release() is called or
// the tab is closed.
async function holdLock(file) {
  if (!navigator.locks) return () => {};
  let release;
  await new Promise((granted) =>
    navigator.locks.request(lockName(file), () => {
      granted();
      return new Promise((r) => (release = r));
    })
  );
  return release;
}

// Deletes result files left by tabs that are gone (their lock is free).
async function sweepResults(dir) {
  const names = [];
  for await (const n of dir.keys()) names.push(n);
  await Promise.all(
    names.map(async (n) => {
      if (current && n === current.name) return;
      const remove = () => dir.removeEntry(n).catch(() => {}); // files still being written cannot be removed
      if (!navigator.locks) return remove();
      await navigator.locks.request(lockName(n), { ifAvailable: true }, (lock) => lock && remove());
    })
  );
}

async function removeCurrent() {
  if (!current) return;
  const { dir, name, release } = current;
  current = null;
  await dir.removeEntry(name).catch(() => {});
  release();
}

// Where the classification TSV goes: a new OPFS file written through a
// synchronous access handle, or, if OPFS is unavailable (e.g. some private
// browsing modes), chunks kept in memory. This tab's previous result is removed.
async function openResultSink() {
  let sink;
  try {
    const dir = await resultDir();
    await removeCurrent();
    await sweepResults(dir);
    const name = `class-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tsv.gz`;
    const release = await holdLock(name);
    current = { dir, name, release };
    const fh = await dir.getFileHandle(name, { create: true });
    const access = await fh.createSyncAccessHandle();
    let pos = 0;
    sink = {
      storage: 'disk',
      write(bytes) {
        try {
          access.write(bytes, { at: pos });
        } catch (e) {
          throw new Error('Could not write the classification to browser storage: ' + e.message);
        }
        pos += bytes.length;
      },
      async finish() {
        access.flush();
        access.close();
        return fh.getFile();
      },
      abort() {
        try {
          access.close();
        } catch (e) {}
      },
    };
  } catch (e) {
    const chunks = [];
    sink = {
      storage: 'memory',
      write(bytes) {
        chunks.push(bytes.slice());
      },
      async finish() {
        return new Blob(chunks, { type: 'application/gzip' });
      },
      abort() {},
    };
  }
  return staged(sink);
}

// Output arrives in small pieces; gather it into large writes,
// which are much faster for OPFS and keep the in-memory Blob in few pieces.
// The sink must consume the bytes it is given before returning.
function staged(sink, size = 1 << 20) {
  const buf = new Uint8Array(size);
  let n = 0;
  const flush = () => {
    if (n) sink.write(buf.subarray(0, n));
    n = 0;
  };
  return {
    storage: sink.storage,
    write(bytes) {
      if (n + bytes.length > size) flush();
      if (bytes.length >= size) sink.write(bytes);
      else {
        buf.set(bytes, n);
        n += bytes.length;
      }
    },
    finish() {
      flush();
      return sink.finish();
    },
    abort: sink.abort,
  };
}

async function run({ index, reads, options }) {
  const timings = {};
  let t = performance.now();
  post({ type: 'progress', stage: 'Loading index', fraction: 0 });
  await loadIndex(index);
  if (!manifest || manifest.name !== index) throw new Error('The selected index changed during the run.');
  timings.index = performance.now() - t;

  // Classification
  t = performance.now();
  const cls = await newModule(createCentrifuger, 'centrifuger.wasm');
  writeIndex(cls, [idxName(1), idxName(2), idxName(4)]);
  cls.FS.mkdir('/in');
  cls.FS.mkdir('/out');
  const blobs = [{ name: 'reads_1', data: reads.r1 }];
  if (reads.r2) blobs.push({ name: 'reads_2', data: reads.r2 });
  cls.FS.mount(cls.WORKERFS, { blobs }, '/in');
  const sink = await openResultSink();
  const counter = readCounter();
  const gz = gzipper(cls, GZIP_LEVEL, (bytes) => sink.write(bytes));
  mkOutputDevice(cls, '/out/class.tsv', (bytes) => {
    counter.push(bytes);
    gz.write(bytes);
  });
  post({ type: 'log', line: sink.storage === 'disk'
    ? 'Writing the classification to browser disk storage (OPFS).'
    : 'Browser disk storage (OPFS) is unavailable; keeping the classification in memory.' });

  // Report progress from the position of WORKERFS reads in the input file(s).
  const totalBytes = blobs.reduce((s, b) => s + b.data.size, 0);
  const posByFile = {};
  const origRead = cls.WORKERFS.stream_ops.read;
  let lastPost = 0;
  cls.WORKERFS.stream_ops.read = function (stream, buffer, offset, length, position) {
    const n = origRead.call(this, stream, buffer, offset, length, position);
    posByFile[stream.node.name] = Number(position) + n;
    const now = performance.now();
    if (now - lastPost > 200) {
      lastPost = now;
      const done = Object.values(posByFile).reduce((a, b) => a + b, 0);
      post({ type: 'progress', stage: 'Classifying reads', fraction: Math.min(1, done / totalBytes) });
    }
    return n;
  };

  const args = ['--wasm-stdout', '/out/class.tsv', '-x', '/idx/' + manifest.name, '-t', '1'];
  if (reads.r2) args.push('-1', '/in/reads_1', '-2', '/in/reads_2');
  else args.push('-u', '/in/reads_1');
  if (options.k && options.k > 1) args.push('-k', String(options.k));
  if (options.minHitLen) args.push('--min-hitlen', String(options.minHitLen));
  if (options.noDust) args.push('--no-dust');
  post({ type: 'progress', stage: 'Classifying reads', fraction: 0 });
  try {
    callMain(cls, args);
    gz.end();
  } catch (e) {
    sink.abort();
    throw e;
  }
  cls.FS.unmount('/in');
  const classTsv = await sink.finish();
  const stats = counter.finish();
  timings.classify = performance.now() - t;

  // Quantification (fresh instances: the program keeps getopt/global state).
  // The classification file is mounted with WORKERFS, so it is read from disk.
  t = performance.now();
  post({ type: 'progress', stage: 'Estimating abundance', fraction: 1 });
  // centrifuger-quant --output-format: 0 centrifuge, 1 MetaPhlAn, 2 CAMI, 3 Kraken report
  const formats = { centrifuger: '0', metaphlan: '1', cami: '2', kreport: '3' };
  const reports = {};
  for (const [key, fmt] of Object.entries(formats)) {
    const q = await newModule(createCentrifugerQuant, 'centrifuger-quant.wasm');
    writeIndex(q, [idxName(2), idxName(3)]);
    q.FS.mkdir('/c');
    q.FS.mount(q.WORKERFS, { blobs: [{ name: 'class.tsv.gz', data: classTsv }] }, '/c');
    callMain(q, ['--wasm-stdout', '/quant.tsv', '-x', '/idx/' + manifest.name, '-c', '/c/class.tsv.gz', '--output-format', fmt]);
    reports[key] = q.FS.readFile('/quant.tsv', { encoding: 'utf8' });
    q.FS.unmount('/c');
  }
  timings.quant = performance.now() - t;

  post({ type: 'done', classTsv, storage: sink.storage, reports, stats, timings });
}

resultDir().then(sweepResults).catch(() => {});

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'loadIndex') await loadIndex(msg.index);
    else if (msg.type === 'run') await run(msg);
    else if (msg.type === 'cleanup') await removeCurrent();
  } catch (e) {
    post({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};
