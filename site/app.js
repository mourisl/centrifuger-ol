// UI for Centrifuger Web. All computation happens in worker.js.
import { parseKreport, buildFlows, renderSankey, RANKS } from './sankey.js';
const $ = (id) => document.getElementById(id);

// Minimal module declaring a 64-bit memory; validates only with memory64 support.
const MEMORY64_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0]);
const supported = typeof WebAssembly === 'object' && WebAssembly.validate(MEMORY64_PROBE);

const state = {
  r1: null,
  r2: null,
  running: false,
  loadedIndex: null,
  customIndex: null, // { prefix, files: {1..4: File}, size } when the user picked their own index
  customError: null,
  results: null, // { rows, classTsv (gzip Blob, on disk when OPFS is available), reports, stats, timings }
  sortKey: 'numReads',
  sortAsc: false,
};

const fmtInt = new Intl.NumberFormat();
const fmtBytes = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';
const fmtPct = (x) => (x * 100 >= 10 ? (x * 100).toFixed(1) : (x * 100).toFixed(2)) + '%';
const fmtSec = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s');

function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = !msg;
}

const worker = supported ? new Worker(new URL('worker.js', import.meta.url), { type: 'module' }) : null;
// Best effort: the worker may be stopped before the deletion finishes. Files
// left behind are removed the next time the page loads.
window.addEventListener('pagehide', (e) => {
  if (worker && !e.persisted) worker.postMessage({ type: 'cleanup' });
});

const STORE_KEY = 'centrifuger-web-index';
let catalog = null;

// The user's own index: four <prefix>.<i>.cfr files picked from disk.
const CUSTOM = '__custom__';
const CUSTOM_ENTRY = { name: CUSTOM, custom: true, title: 'Your own index', example: null, defaultRank: 'genus' };
const CUSTOM_WARN_SIZE = 2e9;

function currentIndex() {
  const name = $('index-select').value;
  if (name === CUSTOM) return CUSTOM_ENTRY;
  return catalog ? catalog.indices.find((x) => x.name === name) : null;
}

// Checks a file selection: one shared prefix and all of <prefix>.1-4.cfr.
function readCustomIndex(fileList) {
  const files = {};
  const prefixes = new Set();
  const other = [];
  for (const f of fileList) {
    const m = /^(.+)\.([1-4])\.cfr$/.exec(f.name);
    if (!m) other.push(f.name);
    else {
      prefixes.add(m[1]);
      files[m[2]] = f;
    }
  }
  if (other.length) return { error: `Not Centrifuger index files: ${other.join(', ')}.` };
  if (!prefixes.size) return { error: 'Select the four .cfr files.' };
  if (prefixes.size > 1) return { error: `The files come from different indices: ${[...prefixes].join(', ')}.` };
  const prefix = [...prefixes][0];
  const missing = [1, 2, 3, 4].filter((i) => !files[i]).map((i) => `${prefix}.${i}.cfr`);
  if (missing.length) return { error: `Missing ${missing.join(', ')}.` };
  return { prefix, files, size: [1, 2, 3, 4].reduce((s, i) => s + files[i].size, 0) };
}

function showCustomIndex() {
  const c = state.customIndex;
  $('index-desc').textContent =
    'Classify against a Centrifuger index on this computer; the files are read locally and never uploaded. ' +
    'Select the four files <name>.1.cfr … <name>.4.cfr from one centrifuger-build output ' +
    '(nucleotide or protein indices built by native Centrifuger work as they are).';
  $('index-files').replaceChildren();
  const msg = $('custom-msg');
  msg.classList.toggle('bad', !!(state.customError || (c && c.size > CUSTOM_WARN_SIZE)));
  if (state.customError) msg.textContent = state.customError;
  else if (c)
    msg.textContent =
      `Index "${c.prefix}": 4 files, ${fmtBytes(c.size)}; needs roughly ${fmtBytes(c.size * 1.5)} of memory while running.` +
      (c.size > CUSTOM_WARN_SIZE ? ' This is probably too large for the browser (WebAssembly memory is capped at 8 GB).' : '');
  else msg.textContent = 'No files selected yet. The files have to be selected again after the page is reloaded.';
  const pill = $('index-status');
  pill.textContent = c ? 'Local files' : 'Choose files';
  pill.classList.toggle('ready', !!c);
  $('index-progress').hidden = true;
  $('example').disabled = true;
  $('example-note').textContent = 'No example data for your own index.';
}

function showIndex() {
  const ix = currentIndex();
  if (!ix) return;
  $('custom-index').hidden = !ix.custom;
  if (ix.custom) {
    showCustomIndex();
    updateInputs();
    return;
  }
  $('index-desc').textContent =
    `${ix.description} ${fmtInt.format(ix.sequences)} ${ix.protein ? 'proteins' : 'sequences'}, ${ix.taxonomy} taxonomy, built ${ix.built} with ` +
    `Centrifuger ${ix.centrifugerVersion}. Download ${fmtBytes(ix.size)} (cached by your browser after the first run); ` +
    `needs roughly ${fmtBytes(ix.size * 3)} of memory while running.`;
  // The index files themselves, for use with native Centrifuger.
  const links = ix.files.map((f) =>
    Object.assign(document.createElement('a'), {
      href: `index/${ix.name}/${f.name}`,
      download: f.name,
      textContent: `${f.name} (${fmtBytes(f.size)})`,
    })
  );
  const code = Object.assign(document.createElement('code'), { textContent: `centrifuger -x <folder>/${ix.name}` });
  $('index-files').replaceChildren(
    'Download the index for native Centrifuger: ',
    ...links.flatMap((a, i) => (i ? [', ', a] : [a])),
    '. Keep all four files in one folder and run ',
    code,
    '.'
  );
  const pill = $('index-status');
  pill.textContent = state.loadedIndex === ix.name ? (state.loadedCached ? 'Ready (cached)' : 'Ready') : 'Not loaded';
  pill.classList.toggle('ready', state.loadedIndex === ix.name);
  $('index-progress').hidden = true;
  $('example').disabled = !ix.example || state.running;
  $('example-note').textContent = ix.example ? ix.example.label : '';
}

if (!supported) {
  $('unsupported').hidden = false;
  $('example').disabled = true;
  $('index-desc').textContent = 'Unavailable in this browser.';
} else {
  fetch('index/indices.json', { cache: 'no-cache' })
    .then((r) => r.json())
    .then((c) => {
      catalog = c;
      const sel = $('index-select');
      // Nucleotide and protein (translated search) indices in separate groups.
      const groups = [
        ['Nucleotide', c.indices.filter((ix) => !ix.protein)],
        ['Protein (translated search)', c.indices.filter((ix) => ix.protein)],
      ].filter(([, list]) => list.length);
      groups.push(['Your own index', [{ name: CUSTOM, label: 'Use index files from this computer…' }]]);
      sel.replaceChildren(
        ...groups.map(([label, list]) => {
          const g = document.createElement('optgroup');
          g.label = label;
          for (const ix of list) {
            const o = document.createElement('option');
            o.value = ix.name;
            o.textContent = ix.label || `${ix.title} (${fmtBytes(ix.size)})`;
            g.appendChild(o);
          }
          return g;
        })
      );
      let saved = null;
      try {
        saved = localStorage.getItem(STORE_KEY);
      } catch (e) {
        // storage unavailable
      }
      sel.value = saved === CUSTOM || c.indices.some((ix) => ix.name === saved) ? saved : c.default;
      sel.disabled = false;
      showIndex();
    })
    .catch(() => {
      $('index-desc').textContent = 'Could not read index/indices.json.';
    });
  $('index-select').addEventListener('change', () => {
    try {
      localStorage.setItem(STORE_KEY, $('index-select').value);
    } catch (e) {
      // storage unavailable
    }
    showIndex();
  });
  $('custom-files').addEventListener('change', () => {
    const r = readCustomIndex($('custom-files').files);
    state.customIndex = r.error ? null : r;
    state.customError = r.error || null;
    showIndex();
  });
}

// ---------- Inputs ----------
function layout() {
  return document.querySelector('input[name="layout"]:checked').value;
}

function updateInputs() {
  const paired = layout() === 'paired';
  $('drop2').hidden = !paired;
  $('drop1-title').textContent = paired ? 'Mate 1' : 'FASTQ / FASTA file';
  for (const [n, f] of [[1, state.r1], [2, state.r2]]) {
    $(`drop${n}-file`).textContent = f
      ? `${f.name} (${fmtBytes(f.size)})`
      : 'Drop a file here or click to choose' + (n === 1 ? ' (.fq, .fastq, .fa, optionally .gz)' : '');
    $(`drop${n}`).classList.toggle('has-file', !!f);
  }
  const ix = currentIndex();
  $('run').disabled =
    !supported || state.running || !state.r1 || (paired && !state.r2) || !ix || (ix.custom && !state.customIndex);
}

for (const n of [1, 2]) {
  const input = $(`file${n}`);
  const drop = $(`drop${n}`);
  input.addEventListener('change', () => {
    state[`r${n}`] = input.files[0] || null;
    updateInputs();
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    // Dropping two files on mate 1 fills both mates.
    if (n === 1 && files.length >= 2) {
      document.querySelector('input[name="layout"][value="paired"]').checked = true;
      files.sort((a, b) => a.name.localeCompare(b.name));
      state.r1 = files[0];
      state.r2 = files[1];
    } else {
      state[`r${n}`] = files[0];
    }
    updateInputs();
  });
}
document.querySelectorAll('input[name="layout"]').forEach((r) => r.addEventListener('change', updateInputs));

$('example').addEventListener('click', async () => {
  try {
    const ix = currentIndex();
    if (!ix || !ix.example) return;
    const res = await fetch(ix.example.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    state.r1 = new File([blob], ix.example.url.split('/').pop());
    state.r2 = null;
    document.querySelector('input[name="layout"][value="single"]').checked = true;
    updateInputs();
    startRun();
  } catch (e) {
    showError('Could not load the example data: ' + e.message);
  }
});

// ---------- Running ----------
function setProgress(stage, fraction) {
  $('run-status').hidden = false;
  $('stage-text').textContent = stage;
  $('stage-pct').textContent = fraction == null ? '' : Math.round(fraction * 100) + '%';
  $('run-bar').style.width = (fraction == null ? 0 : fraction * 100) + '%';
}

function startRun() {
  if (state.running || !state.r1) return;
  const paired = layout() === 'paired';
  if (paired && !state.r2) return;
  const ix = currentIndex();
  if (!ix || (ix.custom && !state.customIndex)) return;
  const custom = ix.custom ? state.customIndex : null;
  state.running = true;
  state.runIndex = ix;
  $('index-select').disabled = true;
  showError('');
  updateInputs();
  $('example').disabled = true;
  setProgress('Starting…', 0);
  state.startedAt = performance.now();
  const k = parseInt($('opt-k').value, 10);
  const minHitLen = parseInt($('opt-minhit').value, 10);
  log(`--- Run: ${state.r1.name}${paired ? ' + ' + state.r2.name : ''} against ${custom ? 'your index "' + custom.prefix + '"' : ix.name}`);
  if (custom) state.loadedIndex = null; // the worker releases any prebuilt index
  worker.postMessage({
    type: 'run',
    index: custom ? { custom: true, prefix: custom.prefix, files: custom.files } : ix.name,
    reads: { r1: state.r1, r2: paired ? state.r2 : null },
    options: {
      k: Number.isFinite(k) && k > 0 ? k : 1,
      minHitLen: Number.isFinite(minHitLen) && minHitLen > 0 ? minHitLen : null,
    },
  });
}
$('run').addEventListener('click', startRun);

function finishRun() {
  state.running = false;
  $('index-select').disabled = !catalog;
  updateInputs();
  showIndex();
}

if (worker) {
  worker.onmessage = (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'index': {
        if (m.name !== $('index-select').value) break;
        const pill = $('index-status');
        $('index-progress').hidden = m.state === 'ready';
        $('index-progress').querySelector('.bar').style.width = (m.total ? (m.loaded / m.total) * 100 : 0) + '%';
        if (m.state === 'ready') {
          state.loadedIndex = m.name;
          state.loadedCached = m.cached;
          pill.textContent = m.cached ? 'Ready (cached)' : 'Ready';
          pill.classList.add('ready');
        } else {
          pill.textContent = `Downloading ${fmtBytes(m.loaded)} / ${fmtBytes(m.total)}`;
          if (state.running) setProgress('Downloading index', m.total ? m.loaded / m.total : null);
        }
        break;
      }
      case 'progress':
        setProgress(m.stage, m.fraction);
        break;
      case 'log':
        log(m.line);
        break;
      case 'done':
        setProgress('Done', 1);
        m.timings.total = performance.now() - state.startedAt;
        showResults(m);
        finishRun();
        break;
      case 'error':
        showError(m.message);
        log('ERROR: ' + m.message);
        $('run-status').hidden = true;
        finishRun();
        break;
    }
  };
  worker.onerror = (e) => {
    showError('The worker failed: ' + (e.message || 'unknown error'));
    finishRun();
  };
}

// ---------- Results ----------
function parseQuant(text) {
  const lines = text.trim().split('\n');
  const header = lines.shift().split('\t');
  return lines.map((l) => {
    const f = l.split('\t');
    const row = {};
    header.forEach((h, i) => (row[h] = f[i]));
    return {
      name: (row.name || '').replace(/_/g, ' '),
      taxID: Number(row.taxID),
      taxRank: row.taxRank,
      genomeSize: Number(row.genomeSize),
      numReads: Number(row.numReads),
      numUniqueReads: Number(row.numUniqueReads),
      abundance: Number(row.abundance),
    };
  });
}

function showResults(m) {
  const rows = parseQuant(m.reports.centrifuger);
  const rootReads = rows.find((r) => r.taxID === 1)?.numReads || m.stats.classifiedReads || 1;
  for (const r of rows) r.readShare = r.numReads / rootReads;
  state.results = { rows, tree: parseKreport(m.reports.kreport), ...m };
  if (state.runIndex && state.runIndex.defaultRank) $('rank').value = state.runIndex.defaultRank;
  $('results').hidden = false;
  $('st-reads').textContent = fmtInt.format(m.stats.totalReads);
  $('st-class').textContent = m.stats.totalReads
    ? `${fmtPct(m.stats.classifiedReads / m.stats.totalReads)}`
    : '–';
  $('st-time').textContent = fmtSec(m.timings.total);
  log(
    `Done: ${m.stats.classifiedReads}/${m.stats.totalReads} reads classified; ` +
      `index ${fmtSec(m.timings.index)}, classification ${fmtSec(m.timings.classify)}, quantification ${fmtSec(m.timings.quant)}`
  );
  render();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function visibleRows() {
  const rank = $('rank').value;
  const q = $('filter').value.trim().toLowerCase();
  let rows = state.results.rows.filter((r) => rank === 'all' || r.taxRank === rank);
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || String(r.taxID) === q);
  const k = state.sortKey;
  const dir = state.sortAsc ? 1 : -1;
  rows.sort((a, b) => (typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k]) * dir);
  return rows;
}

function render() {
  if (!state.results) return;
  const rank = $('rank').value;
  const rankRows = state.results.rows.filter((r) => rank === 'all' || r.taxRank === rank);
  $('st-taxa-label').textContent = rank === 'all' ? 'Taxa' : rank[0].toUpperCase() + rank.slice(1) + ' detected';
  $('st-taxa').textContent = fmtInt.format(rankRows.filter((r) => r.numReads > 0).length);
  renderTable(visibleRows());
  renderChart(rankRows);
  renderFlow();
}

function renderFlow() {
  const measure = $('measure').value === 'abundance' ? 'abundance' : 'readShare';
  const measureLabel = measure === 'abundance' ? 'abundance' : 'classified reads';
  const flows = buildFlows(state.results.tree, state.results.rows, measure, Number($('sankey-top').value));
  renderSankey($('sankey'), flows, { fmt: fmtPct, measureLabel, tip: $('sankey-tip') });

  const legend = [];
  for (let s = 1; s <= flows.slots; s++)
    if (flows.links.some((l) => l.slot === s)) legend.push([s, flows.phylumName.get(s)]);
  if (flows.links.some((l) => l.slot === 0)) legend.push([0, legend.length ? 'Other or no phylum' : 'All flows']);
  $('sankey-legend').replaceChildren(
    ...legend.map(([s, name]) => {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = `swatch s${s}`;
      item.append(sw, name);
      return item;
    })
  );

  if (!flows.nodes.length) {
    $('sankey-caption').textContent = 'No reads were classified to a domain or below, so there are no flows to show.';
    return;
  }
  const cols = new Set(flows.nodes.map((n) => n.col));
  const missing = RANKS.filter((r, i) => !cols.has(i)).map((r) => r[1]);
  $('sankey-caption').textContent =
    `Band width is the share of ${measureLabel}; colors mark the phylum. A band that stops early carries reads ` +
    `that could not be resolved to a lower rank. Beyond the top ${$('sankey-top').value} taxa at each rank, ` +
    `the rest are merged into "Other". ` +
    (missing.length ? `This taxonomy has no ${missing.join(', ')} assignments for these reads. ` : '') +
    (flows.unranked > 1e-3 ? `${fmtPct(flows.unranked)} assigned above the domain level is not shown. ` : '') +
    `The rank and filter controls apply to the chart and table only.`;
}

function renderTable(rows) {
  const tbody = $('table').querySelector('tbody');
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 2000)) {
    const tr = document.createElement('tr');
    const cells = [
      [r.name, 'name'],
      [r.taxRank, ''],
      [String(r.taxID), 'num'],
      [fmtInt.format(r.numReads), 'num'],
      [fmtInt.format(r.numUniqueReads), 'num'],
      [fmtPct(r.readShare), 'num'],
      [fmtPct(r.abundance), 'num'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  document.querySelectorAll('#table th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.key === state.sortKey);
    th.classList.toggle('asc', th.dataset.key === state.sortKey && state.sortAsc);
  });
}

function renderChart(rankRows) {
  const measure = $('measure').value === 'abundance' ? 'abundance' : 'readShare';
  const top = rankRows
    .filter((r) => r[measure] > 0)
    .sort((a, b) => b[measure] - a[measure])
    .slice(0, 15);
  const chart = $('chart');
  if (!top.length) {
    chart.textContent = '';
    $('chart-caption').textContent = 'No taxa at this rank.';
    return;
  }
  const W = 900;
  const rowH = 24;
  const labelW = 300;
  const valW = 70;
  const H = top.length * rowH + 4;
  const max = top[0][measure];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Top ${top.length} taxa by ${measure === 'abundance' ? 'abundance' : 'read share'}`);
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  const barW = W - labelW - valW - 16;
  top.forEach((r, i) => {
    const y = i * rowH + 2;
    const name = r.name.length > 42 ? r.name.slice(0, 41) + '…' : r.name;
    el('text', { x: labelW - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'lbl' }, name).appendChild(
      Object.assign(document.createElementNS(ns, 'title'), { textContent: `${r.name} (taxID ${r.taxID})` })
    );
    el('rect', { x: labelW, y: y + 4, width: barW, height: rowH - 8, rx: 3, class: 'track' });
    el('rect', { x: labelW, y: y + 4, width: Math.max(1, (r[measure] / max) * barW), height: rowH - 8, rx: 3, class: 'bar' });
    el('text', { x: W - 4, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'val' }, fmtPct(r[measure]));
  });
  chart.replaceChildren(svg);
  let caption =
    `Top ${top.length} taxa at ${$('rank').value === 'all' ? 'all ranks' : 'the ' + $('rank').value + ' rank'} by ` +
    (measure === 'abundance' ? 'length-normalized abundance.' : 'share of classified reads.');
  if ($('rank').value !== 'all') {
    const resolved = rankRows.reduce((s, r) => s + r.readShare, 0);
    caption += ` ${fmtPct(Math.min(1, resolved))} of classified reads are resolved to this rank; the rest are assigned to higher ranks.`;
  }
  $('chart-caption').textContent = caption;
}

['rank', 'measure'].forEach((id) => $(id).addEventListener('change', render));
$('sankey-top').addEventListener('change', () => state.results && renderFlow());
$('filter').addEventListener('input', () => state.results && renderTable(visibleRows()));
document.querySelectorAll('#table th').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.key;
    if (state.sortKey === k) state.sortAsc = !state.sortAsc;
    else {
      state.sortKey = k;
      state.sortAsc = k === 'name' || k === 'taxRank';
    }
    renderTable(visibleRows());
  })
);

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const baseName = () => (state.r1 ? state.r1.name.replace(/(\.gz)?$/, '').replace(/\.(fq|fastq|fa|fasta|fna)$/, '') : 'reads');
$('dl-class').addEventListener('click', () =>
  download(state.results.classTsv, `${baseName()}.centrifuger.tsv.gz`, 'application/gzip'));
const REPORT_FILES = {
  centrifuger: ['centrifuger_quant.tsv', 'text/tab-separated-values'],
  metaphlan: ['centrifuger_metaphlan.txt', 'text/plain'],
  cami: ['centrifuger_cami.profile', 'text/plain'],
  kreport: ['centrifuger_kreport.txt', 'text/plain'],
};
$('dl-report').addEventListener('click', () => {
  const key = $('report-format').value;
  const [suffix, type] = REPORT_FILES[key];
  download(state.results.reports[key], `${baseName()}.${suffix}`, type);
});

updateInputs();
