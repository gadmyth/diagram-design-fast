/**
 * check.mjs — zero-dependency validator for generated diagrams.
 *
 *   node check.mjs <file.html> [...]          # validate rendered HTML
 *   node check.mjs --drift <spec.json> <repo-index.json>   # spec vs code drift
 *
 * Exit code 1 when any error-level finding is present.
 */
import { readFileSync } from 'node:fs';
import { pathSegments, rectsOverlap, segDistanceToRect, BUDGET, isMain } from './lib.mjs';

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

function findTags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*?)(/?)>`, 'g');
  let m;
  while ((m = re.exec(html))) out.push({ attrs: parseAttrs(m[1]), index: m.index, raw: m[0], selfClosing: m[2] === '/' });
  return out;
}

function findSvg(html) {
  const start = html.indexOf('<svg');
  if (start < 0) return null;
  const end = html.indexOf('</svg>', start);
  return { start, end, body: html.slice(start, end + 6), head: html.slice(start, html.indexOf('>', start) + 1) };
}

const num = (v) => (v === undefined ? NaN : Number(v));

export function checkHtml(html, file = 'diagram.html') {
  const findings = [];
  const add = (level, msg) => findings.push({ level, msg });

  const svg = findSvg(html);
  if (!svg) {
    add('error', 'no <svg> element found');
    return { findings, ok: false };
  }
  const head = parseAttrs(svg.head.replace(/^<svg/, ''));
  const view = head['data-view'] || 'architecture';
  // <defs> holds arrow markers and patterns — nothing there is painted in canvas space
  const body = svg.body.replace(/<defs\b[\s\S]*?<\/defs>/g, '');

  /* -------- accessible SVG contract -------- */
  if (head.role !== 'img') add('error', 'svg is missing role="img"');
  const labelled = (head['aria-labelledby'] || '').split(/\s+/).filter(Boolean);
  if (!labelled.length) add('error', 'svg is missing aria-labelledby');
  const titleIdx = body.indexOf('<title');
  const defsIdx = body.indexOf('<defs');
  if (titleIdx < 0) add('error', 'svg has no <title>');
  else if (defsIdx >= 0 && titleIdx > defsIdx) add('error', '<title> must be the first child of <svg> (before <defs>)');
  for (const id of labelled) {
    if (!body.includes(`id="${id}"`)) add('error', `aria-labelledby references missing id "${id}"`);
    if (id === 'title' || id === 'desc') add('error', `id "${id}" must be prefixed with the diagram slug`);
  }
  if (!body.includes('<desc')) add('error', 'svg has no <desc>');

  /* -------- viewBox + containment -------- */
  const vb = (head.viewBox || '').split(/\s+/).map(Number);
  if (vb.length !== 4) add('error', 'svg has no valid viewBox');
  const [vx, vy, vw, vh] = vb;

  /* -------- collect geometry -------- */
  const nodes = findTags(body, 'rect').filter((t) => t.attrs['data-role'] === 'node');
  const nodeRects = nodes.map((t) => ({
    id: t.attrs['data-node'], x: num(t.attrs.x), y: num(t.attrs.y), w: num(t.attrs.width), h: num(t.attrs.height),
  }));
  const polygons = findTags(body, 'polygon').map((t) => ({
    id: t.attrs['data-node'],
    pts: (t.attrs.points || '').split(/\s+/).filter(Boolean).map((p) => p.split(',').map(Number)),
  }));
  for (const p of polygons) {
    const xs = p.pts.map((q) => q[0]), ys = p.pts.map((q) => q[1]);
    p.x = Math.min(...xs); p.y = Math.min(...ys);
    p.w = Math.max(...xs) - p.x; p.h = Math.max(...ys) - p.y;
  }
  const allNodes = [...nodeRects, ...polygons];
  const zones = findTags(body, 'rect').filter((t) => t.attrs['data-role'] === 'zone');
  const zoneRects = zones.map((t) => ({ x: num(t.attrs.x), y: num(t.attrs.y), w: num(t.attrs.width), h: num(t.attrs.height) }));
  const masks = findTags(body, 'rect').filter((t) => t.attrs['data-role'] === 'mask').map((t) => ({
    edge: t.attrs['data-edge'], x: num(t.attrs.x), y: num(t.attrs.y), w: num(t.attrs.width), h: num(t.attrs.height),
  }));
  const connectors = findTags(body, 'path').filter((t) => t.attrs['data-role'] === 'connector').map((t) => ({
    id: t.attrs['data-edge'], from: t.attrs['data-from'], to: t.attrs['data-to'],
    d: t.attrs.d || '', segs: pathSegments(t.attrs.d || ''),
  }));

  /* -------- 4px grid on structural geometry -------- */
  for (const n of allNodes) {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (Number.isFinite(n[k]) && Math.abs(n[k] % 4) > 0.001) {
        add('error', `node "${n.id}" ${k}=${n[k]} is off the 4px grid`);
      }
    }
  }
  for (const z of zoneRects) {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (Number.isFinite(z[k]) && Math.abs(z[k] % 4) > 0.001) add('error', `zone ${k}=${z[k]} is off the 4px grid`);
    }
  }

  /* -------- orthogonal connectors, no diagonal -------- */
  for (const c of connectors) {
    for (const s of c.segs) {
      if (s.curve) continue; // rounded elbows are arcs, not slanted strokes
      const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);
      if (dx > 0.5 && dy > 0.5) add('error', `connector "${c.id}" has a diagonal segment (${s.x1},${s.y1})→(${s.x2},${s.y2}) — route it as a rounded elbow`);
    }
  }

  /* -------- label masks: gap to the stroke, no node overlap -------- */
  for (const m of masks) {
    if (!m.edge) continue;
    const c = connectors.find((x) => x.id === m.edge);
    if (!c) continue;
    let best = Infinity;
    for (const s of c.segs) best = Math.min(best, segDistanceToRect(s, m));
    if (best < 6) add('error', `label mask for "${m.edge}" touches its connector (gap ${best.toFixed(1)}px < 6px)`);
    else if (best > 10) add('warn', `label mask for "${m.edge}" sits ${best.toFixed(1)}px from the stroke (style wants 6–10px)`);
    for (const n of allNodes) {
      const r = { x: n.x, y: n.y, w: n.w, h: n.h };
      if (rectsOverlap(r, m)) add('error', `label mask for "${m.edge}" overlaps node "${n.id}"`);
    }
  }

  /* -------- label masks must not overlap each other -------- */
  const edgeMasks = masks.filter((m) => m.edge);
  for (let i = 0; i < edgeMasks.length; i++) {
    for (let j = i + 1; j < edgeMasks.length; j++) {
      if (rectsOverlap(edgeMasks[i], edgeMasks[j])) {
        add('error', `label masks for "${edgeMasks[i].edge}" and "${edgeMasks[j].edge}" overlap`);
      }
    }
  }

  /* -------- node overlap -------- */
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const a = allNodes[i], b = allNodes[j];
      if (rectsOverlap(a, b)) add('error', `nodes "${a.id}" and "${b.id}" overlap`);
    }
  }

  /* -------- ports: perpendicular exit, ≥12px apart on a shared edge --------
   * sequence messages start on a lifeline, not on a box border, so the rule
   * only applies to the layered views. */
  const ports = new Map();
  for (const c of connectors) {
    if (view === 'sequence') break;
    const start = c.segs[0];
    if (!start || !c.from) continue;
    const node = allNodes.find((n) => n.id === c.from);
    if (!node) continue;
    const onTop = Math.abs(start.y1 - node.y) < 0.5 && start.x1 >= node.x && start.x1 <= node.x + node.w;
    const onBottom = Math.abs(start.y1 - (node.y + node.h)) < 0.5 && start.x1 >= node.x && start.x1 <= node.x + node.w;
    const onLeft = Math.abs(start.x1 - node.x) < 0.5 && start.y1 >= node.y && start.y1 <= node.y + node.h;
    const onRight = Math.abs(start.x1 - (node.x + node.w)) < 0.5 && start.y1 >= node.y && start.y1 <= node.y + node.h;
    let side = null;
    if (onTop) side = 'top'; else if (onBottom) side = 'bottom';
    else if (onLeft) side = 'left'; else if (onRight) side = 'right';
    if (!side) {
      add('error', `connector "${c.id}" does not start on the border of node "${c.from}"`);
      continue;
    }
    const horiz = Math.abs(start.x2 - start.x1) > Math.abs(start.y2 - start.y1);
    if ((side === 'top' || side === 'bottom') && horiz) {
      add('error', `connector "${c.id}" leaves "${c.from}" along its ${side} edge — it must leave perpendicular to that edge`);
    }
    if ((side === 'left' || side === 'right') && !horiz) {
      add('error', `connector "${c.id}" leaves "${c.from}" along its ${side} edge — it must leave perpendicular to that edge`);
    }
    const key = `${c.from}:${side}`;
    if (!ports.has(key)) ports.set(key, []);
    ports.get(key).push({ edge: c.id, pt: { x: start.x1, y: start.y1 } });
  }
  for (const [key, list] of ports) {
    for (let i = 1; i < list.length; i++) {
      const d = Math.hypot(list[i].pt.x - list[i - 1].pt.x, list[i].pt.y - list[i - 1].pt.y);
      if (d < 12) add('error', `connectors "${list[i - 1].edge}" and "${list[i].edge}" share edge ${key} with only ${d.toFixed(1)}px between ports (need ≥12px)`);
    }
  }

  /* -------- containment -------- */
  const inside = (x, y) => x >= vx - 0.5 && x <= vx + vw + 0.5 && y >= vy - 0.5 && y <= vy + vh + 0.5;
  for (const n of allNodes) {
    if (!inside(n.x, n.y) || !inside(n.x + n.w, n.y + n.h)) add('error', `node "${n.id}" is outside the viewBox`);
  }
  for (const c of connectors) {
    for (const s of c.segs) {
      if (!inside(s.x1, s.y1) || !inside(s.x2, s.y2)) add('error', `connector "${c.id}" leaves the viewBox`);
    }
  }

  /* -------- budget -------- */
  if (allNodes.length > BUDGET.nodes) add('warn', `${allNodes.length} nodes exceeds the ${BUDGET.nodes}-node budget — split into overview + detail`);
  if (connectors.length > BUDGET.edges) add('warn', `${connectors.length} connectors exceeds the ${BUDGET.edges}-arrow budget — split into overview + detail`);
  const accentCount = findTags(body, 'rect').filter((t) => (t.attrs.fill || '') === 'var(--accent)').length;
  if (accentCount > BUDGET.accent) add('warn', `${accentCount} accent nodes exceeds ${BUDGET.accent} — accent is for 1–2 focal nodes`);
  if (zoneRects.length > BUDGET.zones) add('warn', `${zoneRects.length} zones exceeds ${BUDGET.zones}`);

  /* -------- single-file safety -------- */
  if (/<script/i.test(html)) add('error', 'output contains a <script> tag — diagrams must be script-free');
  const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const u of remote) {
    if (!/fonts\.(googleapis|gstatic)\.com/.test(u)) add('error', `remote asset not allowed: ${u}`);
  }
  if (/<img\b/i.test(html)) add('error', 'output contains an <img> — diagrams must be self-contained');

  return { findings, ok: !findings.some((f) => f.level === 'error') };
}

/* ------------------------------------------------------------------ drift */

export function checkDrift(spec, index) {
  const findings = [];
  const indexEdges = new Set((index.edges || []).map((e) => `${e.from}->${e.to}`));
  for (const w of index.wiring || []) indexEdges.add(`${w.from}->${w.to}`);
  const specEdges = new Set((spec.edges || []).map((e) => `${e.from}->${e.to}`));
  const nodeIds = new Set((spec.nodes || []).map((n) => n.id));
  const indexIds = new Set((index.modules || []).map((m) => m.id));

  for (const e of indexEdges) {
    const [from, to] = e.split('->');
    if (!nodeIds.has(from) && !nodeIds.has(to)) continue;
    if (!specEdges.has(e)) findings.push({ level: 'info', msg: `code dependency not drawn: ${e}` });
  }
  const wiringIds = new Set((index.wiring || []).map((w) => `${w.from}->${w.to}`));
  for (const e of specEdges) {
    const [from, to] = e.split('->');
    if (indexIds.has(from) && indexIds.has(to) && !indexEdges.has(e)) {
      findings.push({ level: 'warn', msg: `diagram edge not backed by code: ${e}${wiringIds.has(e) ? '' : ''}` });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ cli */

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--drift') {
    const spec = JSON.parse(readFileSync(args[1], 'utf8'));
    const index = JSON.parse(readFileSync(args[2], 'utf8'));
    const findings = checkDrift(spec, index);
    for (const f of findings) console.log(`${f.level}: ${f.msg}`);
    console.log(findings.length ? `${findings.length} drift findings` : 'no drift found');
    process.exit(0);
  }
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: node check.mjs <file.html> [...] | --drift <spec.json> <index.json>');
    process.exit(2);
  }
  let failed = 0;
  for (const f of files) {
    const { findings, ok } = checkHtml(readFileSync(f, 'utf8'), f);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${f}`);
    for (const x of findings) console.log(`  ${x.level === 'error' ? 'x' : '!'} ${x.msg}`);
    if (!ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}
