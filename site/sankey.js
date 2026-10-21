// Sankey diagram of how reads (or abundance) flow from domain down to species.
//
// The tree comes from centrifuger-quant's Kraken-style report (indentation gives
// the parent, the rank code gives the rank); values come from the Centrifuger
// table, which holds clade-level reads and abundance for the same taxIDs.
// Each taxon's directly assigned amount flows from its domain to the deepest of
// the seven ranks in its lineage, so a flow that stops early means those reads
// could not be resolved further.

export const RANKS = [
  ['D', 'domain'],
  ['P', 'phylum'],
  ['C', 'class'],
  ['O', 'order'],
  ['F', 'family'],
  ['G', 'genus'],
  ['S', 'species'],
];
const COL = Object.fromEntries(RANKS.map(([code], i) => [code, i]));
const N_COLORS = 8; // categorical slots in style.css (--series-1..8)
const NS = 'http://www.w3.org/2000/svg';

// Parses the Kraken-style report into Map taxID -> { taxID, code, name, parent, children }.
export function parseKreport(text) {
  const nodes = new Map();
  const stack = [];
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 6 || f[3] === 'U') continue;
    const raw = f[5];
    const name = raw.trimStart();
    const depth = (raw.length - name.length) / 2;
    const node = {
      taxID: Number(f[4]),
      code: f[3],
      name: name.replace(/_/g, ' '),
      pct: Number(f[0]) / 100,
      cladeReads: Number(f[1]),
      parent: depth > 0 ? stack[depth - 1] : null,
      children: [],
    };
    if (node.parent) node.parent.children.push(node);
    stack[depth] = node;
    stack.length = depth + 1;
    nodes.set(node.taxID, node);
  }
  return nodes;
}

// Builds the diagram's nodes and links.
//   tree: from parseKreport; rows: Centrifuger table rows (taxID, readShare, abundance)
//   measure: 'readShare' | 'abundance'; topN: taxa kept per rank (the rest become "Other")
export function buildFlows(tree, rows, measure, topN) {
  const byId = new Map(rows.map((r) => [r.taxID, r]));
  const root = [...tree.values()].find((n) => !n.parent);
  const rootReads = root ? root.cladeReads : 1;
  const value = (n) => {
    const r = byId.get(n.taxID);
    if (r) return r[measure];
    return measure === 'abundance' ? n.pct : n.cladeReads / rootReads;
  };
  // Phylum colors follow read share whatever the measure, so they stay put.
  const phyla = [...tree.values()]
    .filter((n) => n.code === 'P')
    .sort((a, b) => (byId.get(b.taxID)?.readShare ?? 0) - (byId.get(a.taxID)?.readShare ?? 0));
  const slotOf = new Map(phyla.slice(0, Math.min(N_COLORS, topN)).map((n, i) => [n.taxID, i + 1]));

  // Flow units: one per taxon with a directly assigned amount.
  const units = [];
  let unranked = 0;
  for (const n of tree.values()) {
    const direct = value(n) - n.children.reduce((s, c) => s + value(c), 0);
    if (!(direct > 1e-9)) continue;
    const at = new Array(RANKS.length).fill(null);
    for (let a = n; a; a = a.parent) if (a.code in COL && !at[COL[a.code]]) at[COL[a.code]] = a;
    const deepest = at.reduce((k, a, i) => (a ? i : k), -1);
    if (deepest < 0) {
      unranked += direct;
      continue;
    }
    units.push({ value: direct, at: at.slice(0, deepest + 1), slot: (at[1] && slotOf.get(at[1].taxID)) || 0 });
  }

  // Keep the top taxa of each rank; merge the rest into one "Other" node per rank.
  const nodeId = (c, a) => (a ? `t${a.taxID}` : `gap${c}`);
  const totals = RANKS.map(() => new Map());
  for (const u of units)
    u.at.forEach((a, c) => totals[c].set(nodeId(c, a), (totals[c].get(nodeId(c, a)) || 0) + u.value));
  const kept = totals.map((m) => new Set([...m].sort((x, y) => y[1] - x[1]).slice(0, topN).map(([id]) => id)));
  const nodes = new Map();
  const display = (c, a) => {
    const raw = nodeId(c, a);
    const id = kept[c].has(raw) ? raw : `other${c}`;
    if (!nodes.has(id)) {
      const kind = id.startsWith('other') ? 'other' : a ? 'taxon' : 'gap';
      nodes.set(id, {
        id,
        col: c,
        kind,
        taxID: kind === 'taxon' ? a.taxID : null,
        name: kind === 'taxon' ? a.name : kind === 'gap' ? `No ${RANKS[c][1]} assigned` : 'Other',
        members: new Set(),
        value: 0,
        out: 0,
      });
    }
    const node = nodes.get(id);
    node.members.add(raw);
    return node;
  };

  const links = new Map();
  for (const u of units) {
    const path = u.at.map((a, c) => display(c, a));
    const keys = [];
    path.forEach((node, c) => {
      node.value += u.value;
      if (c === 0) return;
      const key = `${path[c - 1].id}>${node.id}>${u.slot}`;
      if (!links.has(key)) links.set(key, { key, source: path[c - 1], target: node, slot: u.slot, value: 0 });
      links.get(key).value += u.value;
      path[c - 1].out += u.value;
      keys.push(key);
    });
    for (const node of path) {
      node.flows ??= new Set();
      for (const k of keys) node.flows.add(k);
    }
  }
  const phylumName = new Map(phyla.map((n) => [slotOf.get(n.taxID), n.name]));
  return { nodes: [...nodes.values()], links: [...links.values()], unranked, phylumName, slots: slotOf.size };
}

// Draws the diagram into `container` (replacing its content).
//   opts: { fmt: value -> text, measureLabel, tip: tooltip element }
export function renderSankey(container, flows, opts) {
  const cols = [];
  for (const n of flows.nodes) (cols[n.col] ??= []).push(n);
  const ncol = cols.length;
  if (!ncol) {
    container.textContent = '';
    return;
  }
  const W = 960;
  const top = 24;
  const nodeW = 12;
  const labelSpace = 170;
  const pad = 14; // also the minimum label pitch
  const maxN = Math.max(...cols.map((c) => c.length));
  const H = Math.max(300, 120 + maxN * 30);
  const gap = ncol > 1 ? (W - labelSpace - nodeW - 4) / (ncol - 1) : 0;
  const k = Math.min(
    ...cols.map((c) => (H - top - 14 - pad * (c.length - 1)) / c.reduce((s, n) => s + n.value, 0))
  );

  // Order: largest first in the first column; then by the position of the
  // incoming flows, so bands cross as little as possible. Gap/Other go last.
  const last = (n) => (n.kind === 'taxon' ? 0 : n.kind === 'gap' ? 1 : 2);
  cols.forEach((col, c) => {
    for (const n of col) {
      if (c === 0) n.order = -n.value;
      else {
        let w = 0;
        let s = 0;
        for (const l of flows.links)
          if (l.target === n) {
            s += l.value * (l.source.y + l.source.h / 2);
            w += l.value;
          }
        n.order = w ? s / w : 0;
      }
    }
    col.sort((a, b) => last(a) - last(b) || a.order - b.order || b.value - a.value);
    let y = top;
    for (const n of col) {
      n.x = 2 + c * gap;
      n.y = y;
      n.h = Math.max(1, n.value * k);
      y += n.h + pad;
    }
  });

  // Stack the bands at both ends of each node.
  for (const n of flows.nodes) {
    n.outY = n.y;
    n.inY = n.y;
  }
  const sorted = [...flows.links].sort((a, b) => a.target.y - b.target.y || a.slot - b.slot);
  for (const l of sorted) {
    l.w = Math.max(0.5, l.value * k);
    l.y0 = l.source.outY;
    l.source.outY += l.value * k;
  }
  sorted.sort((a, b) => a.source.y - b.source.y || a.slot - b.slot);
  for (const l of sorted) {
    l.y1 = l.target.inY;
    l.target.inY += l.value * k;
  }

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Sankey diagram of ${opts.measureLabel} from domain to species`);
  const el = (parent, tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v);
    if (text != null) e.textContent = text;
    parent.appendChild(e);
    return e;
  };

  for (let c = 0; c < ncol; c++) {
    const name = RANKS[c][1];
    el(svg, 'text', { x: 2 + c * gap, y: 12, class: 'sk-rank' }, name[0].toUpperCase() + name.slice(1));
  }

  const linkG = el(svg, 'g', {});
  const linkEls = new Map();
  for (const l of flows.links) {
    const x0 = l.source.x + nodeW;
    const x1 = l.target.x;
    const xm = (x0 + x1) / 2;
    const d =
      `M${x0},${l.y0}C${xm},${l.y0} ${xm},${l.y1} ${x1},${l.y1}` +
      `L${x1},${l.y1 + l.w}C${xm},${l.y1 + l.w} ${xm},${l.y0 + l.w} ${x0},${l.y0 + l.w}Z`;
    const p = el(linkG, 'path', { d, class: `sk-link s${l.slot}` });
    linkEls.set(l.key, p);
    const phylum = flows.phylumName.get(l.slot);
    p.addEventListener('pointerenter', (ev) =>
      focus(new Set([l.key]), ev, `<b>${esc(l.source.name)} → ${esc(l.target.name)}</b>` +
        `<br>${opts.fmt(l.value)} of ${opts.measureLabel}` + (phylum ? `<br><span class="muted">Phylum ${esc(phylum)}</span>` : ''))
    );
    p.addEventListener('pointermove', move);
    p.addEventListener('pointerleave', blur);
  }

  const nodeG = el(svg, 'g', {});
  const labels = [];
  for (const n of flows.nodes) {
    const g = el(nodeG, 'g', { class: 'sk-node', tabindex: 0 });
    el(g, 'rect', { x: n.x, y: n.y, width: nodeW, height: n.h, rx: 2, class: `sk-bar ${n.kind}` });
    const label = n.kind === 'other' ? `Other (${n.members.size})` : n.name;
    // Tall nodes put the value on a second line, leaving the name the full width.
    const twoLines = n.h >= 26;
    const lx = n.x + nodeW + 5;
    const t = el(g, 'text', { x: lx, y: n.y + n.h / 2 + (twoLines ? -2 : 4), class: 'sk-label' });
    const nameSpan = el(t, 'tspan', {}, label);
    el(t, 'tspan', twoLines ? { class: 'sk-val', x: lx, dy: 13 } : { class: 'sk-val', dx: 4 }, opts.fmt(n.value));
    // Generous hit target: the bar plus its label (width set once the label is fitted).
    const hit = el(g, 'rect', { x: n.x - 3, y: n.y - 4, width: gap, height: n.h + 8, class: 'sk-hit' });
    labels.push({ fit: twoLines ? nameSpan : t, nameSpan, label, hit, avail: (n.col === ncol - 1 ? labelSpace : gap) - nodeW - 10 });
    const rank = RANKS[n.col][1];
    let html =
      n.kind === 'taxon'
        ? `<b>${esc(n.name)}</b> <span class="muted">${rank} · taxID ${n.taxID}</span>`
        : n.kind === 'gap'
          ? `<b>No ${rank} assigned</b><br><span class="muted">Lineages without a ${rank} in the taxonomy</span>`
          : `<b>Other ${rank} taxa</b> <span class="muted">(${n.members.size} merged)</span>`;
    html += `<br>${opts.fmt(n.value)} of ${opts.measureLabel}`;
    const stop = n.value - n.out;
    if (n.col < ncol - 1 && stop > n.value * 1e-3)
      html += `<br><span class="muted">${opts.fmt(stop)} not resolved below ${rank}</span>`;
    const show = (ev) => focus(n.flows || new Set(), ev, html);
    g.addEventListener('pointerenter', show);
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerleave', blur);
    g.addEventListener('focus', () => show(null));
    g.addEventListener('blur', blur);
  }

  function focus(keys, ev, html) {
    svg.classList.add('sk-active');
    for (const [key, p] of linkEls) p.classList.toggle('on', keys.has(key));
    if (opts.tip) {
      opts.tip.innerHTML = html;
      opts.tip.hidden = false;
      move(ev);
    }
  }
  function move(ev) {
    if (!opts.tip || !opts.tip.offsetParent) return;
    // Positioned within the tooltip's offset parent (outside the scrolling wrapper).
    const box = opts.tip.offsetParent.getBoundingClientRect();
    const ref = ev || { clientX: container.getBoundingClientRect().left + 40, clientY: container.getBoundingClientRect().top };
    const tw = opts.tip.offsetWidth;
    let x = ref.clientX - box.left + 14;
    if (x + tw > box.width) x = Math.max(0, x - tw - 28);
    opts.tip.style.transform = `translate(${x}px, ${ref.clientY - box.top + 14}px)`;
  }
  function blur() {
    svg.classList.remove('sk-active');
    if (opts.tip) opts.tip.hidden = true;
  }

  container.replaceChildren(svg);
  // Shorten each label to fit before the next column (needs the SVG in the page to measure).
  for (const { fit, nameSpan, label, hit, avail } of labels) {
    let len = fit.getComputedTextLength();
    if (len > avail) {
      let lo = 1;
      let hi = label.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        nameSpan.textContent = label.slice(0, mid) + '…';
        if (fit.getComputedTextLength() <= avail) lo = mid;
        else hi = mid - 1;
      }
      nameSpan.textContent = label.slice(0, lo) + '…';
      len = fit.getComputedTextLength();
    }
    hit.setAttribute('width', nodeW + 14 + Math.min(len, avail));
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
