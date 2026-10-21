// Run the WebAssembly Centrifuger under Node on the upstream example data and
// compare the output byte-for-byte with the native binaries built from the
// same source (make native). Classification runs the way the website does:
// output through a device and gzip-compressed in the module (site/output.js),
// and quantification reads the gzipped table. Usage: node test/node_parity.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmDir = join(root, 'site/wasm');
const exampleDir = join(root, 'centrifuger-src/example');
const workDir = join(root, 'build/example');
const native = join(root, 'build/native');
mkdirSync(workDir, { recursive: true });

const prefix = join(workDir, 'ex');
execFileSync(join(native, 'centrifuger-build'), ['-r', join(exampleDir, 'ref.fa'),
  '--taxonomy-tree', join(exampleDir, 'nodes.dmp'), '--name-table', join(exampleDir, 'names.dmp'),
  '--conversion-table', join(exampleDir, 'ref_seqid.map'), '-o', prefix, '-t', '4'], { stdio: 'ignore' });

const reads = ['example_1.fq', 'example_2.fq'].map((f) => join(exampleDir, f));
const { mkOutputDevice, gzipper } = await import(join(root, 'site/output.js'));

// With gzip, the output goes through the website's device + gzip path and is
// decompressed here for comparison.
async function runWasm(factory, files, args, outPath, gzip = false) {
  const log = [];
  const mod = await factory({ print: (s) => log.push(s), printErr: (s) => log.push(s) });
  mod.FS.mkdir('/data');
  for (const f of files) mod.FS.writeFile('/data/' + basename(f), readFileSync(f));
  const chunks = [];
  let gz;
  if (gzip) {
    gz = gzipper(mod, 6, (b) => chunks.push(Buffer.from(b)));
    mkOutputDevice(mod, outPath, (bytes) => gz.write(bytes));
  }
  const rc = mod.callMain(['--wasm-stdout', outPath, ...args]);
  if (rc !== 0) throw new Error(`wasm exited with ${rc}\n${log.join('\n')}`);
  if (!gzip) return mod.FS.readFile(outPath, { encoding: 'utf8' });
  gz.end();
  const packed = Buffer.concat(chunks);
  const text = gunzipSync(packed).toString();
  console.log(`  gzip output: ${packed.length} bytes for ${text.length} (${(text.length / packed.length).toFixed(1)}x)`);
  return text;
}

const { default: createCentrifuger } = await import(join(wasmDir, 'centrifuger.js'));
const { default: createCentrifugerQuant } = await import(join(wasmDir, 'centrifuger-quant.js'));

const idxFiles = [1, 2, 3, 4].map((i) => `${prefix}.${i}.cfr`);
let failed = 0;
function compare(name, wasmOut, nativeOut) {
  writeFileSync(join(workDir, `wasm_${name}`), wasmOut);
  const ok = wasmOut === nativeOut;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${wasmOut.split('\n').length - 1} lines)`);
}

for (const [mode, readArgs] of [['paired', ['-1', '/data/example_1.fq', '-2', '/data/example_2.fq']],
  ['single', ['-u', '/data/example_1.fq']]]) {
  const t0 = Date.now();
  const cls = await runWasm(createCentrifuger, [...idxFiles, ...reads],
    ['-x', '/data/ex', ...readArgs, '-t', '1'], '/class.tsv', true);
  const t1 = Date.now();
  const nativeArgs = ['-x', prefix, ...readArgs.map((a) => a.startsWith('/data/') ? join(exampleDir, basename(a)) : a), '-t', '1'];
  const nativeCls = execFileSync(join(native, 'centrifuger'), nativeArgs, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  compare(`${mode}_class.tsv`, cls, nativeCls);
  console.log(`  wasm classification took ${t1 - t0} ms`);

  const clsPath = join(workDir, `native_${mode}_class.tsv`);
  writeFileSync(clsPath, nativeCls);
  writeFileSync(clsPath + '.gz', gzipSync(nativeCls));
  for (const fmt of ['0', '1', '2', '3']) {
    const q = await runWasm(createCentrifugerQuant, [...idxFiles, clsPath + '.gz'],
      ['-x', '/data/ex', '-c', '/data/' + basename(clsPath) + '.gz', '--output-format', fmt], '/quant.tsv');
    const nq = execFileSync(join(native, 'centrifuger-quant'), ['-x', prefix, '-c', clsPath, '--output-format', fmt],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    compare(`${mode}_quant_fmt${fmt}.tsv`, q, nq);
  }
}
// Every prebuilt website index (gzip parts, as served) on its example reads.
// PARITY_SITE points at another site directory, e.g. a staging build.
const siteDir = process.env.PARITY_SITE ? resolve(process.env.PARITY_SITE) : join(root, 'site');
const catalogPath = join(siteDir, 'index/indices.json');
const only = process.argv.slice(2);
if (existsSync(catalogPath)) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  for (const entry of catalog.indices) {
    if (only.length && !only.includes(entry.name)) continue;
    if (!entry.example) continue;
    const dir = join(siteDir, 'index', entry.name);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const idxDir = join(workDir, 'site_index', entry.name);
    mkdirSync(idxDir, { recursive: true });
    const files = manifest.files.map((f) => {
      const p = join(idxDir, f.name);
      const gz = Buffer.concat((f.parts || [f.url]).map((part) => readFileSync(join(dir, part))));
      writeFileSync(p, gunzipSync(gz));
      return p;
    });
    const prefix = join(idxDir, manifest.name);
    const reads = join(siteDir, entry.example.url);
    const t0 = Date.now();
    const cls = await runWasm(createCentrifuger, [...files, reads],
      ['-x', '/data/' + manifest.name, '-u', '/data/' + basename(reads), '-t', '1'], '/class.tsv', true);
    const t1 = Date.now();
    const nativeCls = execFileSync(join(native, 'centrifuger'), ['-x', prefix, '-u', reads, '-t', '1'],
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 }).toString();
    compare(`${entry.name}_class.tsv`, cls, nativeCls);
    console.log(`  wasm classification took ${t1 - t0} ms (index load + example reads)`);
    const clsPath = join(workDir, `native_${entry.name}_class.tsv`);
    writeFileSync(clsPath, nativeCls);
    writeFileSync(clsPath + '.gz', gzipSync(nativeCls));
    for (const fmt of ['0', '1', '2', '3']) {
      const q = await runWasm(createCentrifugerQuant, [...files, clsPath + '.gz'],
        ['-x', '/data/' + manifest.name, '-c', '/data/' + basename(clsPath) + '.gz', '--output-format', fmt], '/quant.tsv');
      const nq = execFileSync(join(native, 'centrifuger-quant'), ['-x', prefix, '-c', clsPath, '--output-format', fmt],
        { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 }).toString();
      compare(`${entry.name}_quant_fmt${fmt}.tsv`, q, nq);
    }
  }
}
process.exit(failed ? 1 : 0);
