/**
 * lib.mjs — shared spec model, skin tokens, text metrics, geometry helpers.
 * Zero dependencies. Node >= 18.
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when this module is the process entry point (symlink-safe). */
export function isMain(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}


export const GRID = 4;
export const LABEL_MAX = 22;   // arrow labels: uppercase, truncated with an ellipsis

/**
 * Semantic tokens, aligned with the upstream diagram-design default skin
 * (jet-black / white-smoke / burnt-tangerine). Every text role clears
 * WCAG AA 4.5:1 on its own paper; accent-fg is picked per skin so text on an
 * accent fill stays legible.
 */
export const SKINS = {
  'minimal-light': {
    paper: '#f5f5f5', ink: '#2d3142', 'ink-strong': '#111111',
    muted: '#4f5d75', soft: '#5a6580',
    'paper-2': '#ececec', 'accent-tint': 'rgba(191,69,32,0.08)',
    accent: '#bf4520', 'accent-fg': '#ffffff', link: '#2e5aa8',
    rule: 'rgba(45,49,66,0.12)', 'rule-solid': '#bfc0c0',
  },
  'minimal-dark': {
    paper: '#2d3142', ink: '#f5f5f5', 'ink-strong': '#111111',
    muted: '#bfc0c0', soft: '#949eb2',
    'paper-2': '#393e53', 'accent-tint': 'rgba(240,138,89,0.10)',
    accent: '#f08a59', 'accent-fg': '#111111', link: '#739fdf',
    rule: 'rgba(245,245,245,0.12)', 'rule-solid': 'rgba(191,192,192,0.25)',
  },
  'full-editorial': {
    paper: '#f5f5f5', ink: '#2d3142', 'ink-strong': '#111111',
    muted: '#4f5d75', soft: '#5a6580',
    'paper-2': '#ececec', 'accent-tint': 'rgba(191,69,32,0.08)',
    accent: '#bf4520', 'accent-fg': '#ffffff', link: '#2e5aa8',
    rule: 'rgba(45,49,66,0.12)', 'rule-solid': '#bfc0c0',
  },
};

export const NODE_KINDS = {
  service:    { tag: 'SVC',  shape: 'box',      w: 160, h: 48 },
  client:     { tag: 'UI',   shape: 'box',      w: 160, h: 48 },
  api:        { tag: 'API',  shape: 'box',      w: 160, h: 48 },
  worker:     { tag: 'WRK',  shape: 'box',      w: 160, h: 48 },
  db:         { tag: 'DB',   shape: 'db',       w: 160, h: 48 },
  queue:      { tag: 'MQ',   shape: 'queue',    w: 160, h: 48 },
  cache:      { tag: 'CACHE',shape: 'db',       w: 160, h: 48 },
  external:   { tag: 'EXT',  shape: 'external', w: 160, h: 48 },
  actor:      { tag: 'ACT',  shape: 'box',      w: 160, h: 48 },
  participant:{ tag: '',     shape: 'box',      w: 160, h: 48 },
  step:       { tag: '',     shape: 'box',      w: 160, h: 48 },
  start:      { tag: 'START',shape: 'box',      w: 160, h: 48 },
  end:        { tag: 'END',  shape: 'box',      w: 160, h: 48 },
  decision:   { tag: 'IF',   shape: 'diamond',  w: 128, h: 64 },
};

export const EDGE_KINDS = {
  sync:     { label: 'CALL',    color: 'muted',  dash: null },
  http:     { label: 'HTTP',    color: 'link',   dash: null },
  async:    { label: 'ASYNC',   color: 'muted',  dash: '5,4' },
  optional: { label: 'OPTIONAL',color: 'muted',  dash: '4,3' },
  return:   { label: 'RETURN',  color: 'muted',  dash: '4,3' },
  write:    { label: 'WRITE',   color: 'accent', dash: null },
  event:    { label: 'EVENT',   color: 'muted',  dash: '5,4' },
};

export const BUDGET = { nodes: 9, edges: 12, accent: 2, zones: 3, participants: 5, messages: 12 };

/* ---------- text metrics (calibrated: 0.60em sans / 0.62em mono, CJK 1.0em) ---------- */

export function charWidth(ch, mono) {
  const cp = ch.codePointAt(0);
  if (cp > 0x2e80) return 1.0;              // CJK / fullwidth
  if (cp === 32) return 0.32;               // space
  return mono ? 0.62 : 0.60;
}

export function textWidth(text, size, mono = false) {
  let w = 0;
  for (const ch of String(text ?? '')) w += charWidth(ch, mono) * size;
  return Math.ceil(w);
}

/** Arrow-label text: uppercase, capped, ellipsis when it has to be cut. */
export function arrowLabel(text, max = LABEL_MAX) {
  const t = String(text ?? '').toUpperCase();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function fitLabel(text, size, maxW, mono = false) {
  const t = String(text ?? '');
  if (textWidth(t, size, mono) <= maxW) return t;
  let out = '';
  for (const ch of t) {
    if (textWidth(out + ch + '…', size, mono) > maxW) break;
    out += ch;
  }
  return out + '…';
}

/* ---------- small helpers ---------- */

export const snap = (v) => Math.round(v / GRID) * GRID;
export const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function uniqueId(base, taken) {
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  taken.add(id);
  return id;
}

/* ---------- spec io ---------- */

export function loadSpec(file) {
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  spec.nodes ??= [];
  spec.edges ??= [];
  spec.groups ??= [];
  spec.messages ??= [];
  spec.notes ??= [];
  spec.tokens ??= {};
  spec.variant ??= 'minimal-light';
  spec.view ??= 'architecture';
  return spec;
}

export function saveSpec(file, spec) {
  writeFileSync(file, JSON.stringify(spec, null, 2) + '\n', 'utf8');
}

export function skinOf(spec) {
  return { ...SKINS[spec.variant] ?? SKINS['minimal-light'], ...(spec.tokens || {}) };
}

/* ---------- node geometry ---------- */

export function nodeSize(node) {
  const kind = NODE_KINDS[node.kind] ?? NODE_KINDS.service;
  let w = node.w ?? kind.w;
  const h = node.h ?? kind.h;
  const label = String(node.label ?? node.id);
  const maxText = w - 24;
  if (textWidth(label, 12) > maxText) {
    // grow within the allowed width ladder before shrinking the text
    const ladder = [160, 180, 200, 240, 320];
    for (const cand of ladder) {
      if (cand > w && textWidth(label, 12) <= cand - 24) { w = cand; break; }
    }
  }
  return { w: snap(w), h: snap(h), shape: kind.shape, tag: kind.tag };
}

/* ---------- polyline → rounded elbow path ---------- */

export function roundedPolyline(points, r = 8) {
  if (!points || points.length < 2) return '';
  let d = `M ${fmt(points[0].x)},${fmt(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], prev = points[i - 1], next = points[i + 1];
    const v1x = p.x - prev.x, v1y = p.y - prev.y;
    const v2x = next.x - p.x, v2y = next.y - p.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p1 = { x: p.x - (v1x / l1) * rr, y: p.y - (v1y / l1) * rr };
    const p2 = { x: p.x + (v2x / l2) * rr, y: p.y + (v2y / l2) * rr };
    d += ` L ${fmt(p1.x)},${fmt(p1.y)} Q ${fmt(p.x)},${fmt(p.y)} ${fmt(p2.x)},${fmt(p2.y)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${fmt(last.x)},${fmt(last.y)}`;
  return d;
}

/* ---------- segment helpers (used by check.mjs) ---------- */

export function parsePathPoints(d) {
  const out = [];
  const re = /([MLHVQCAmlhvqca])\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g;
  let m;
  let cx = 0, cy = 0;
  while ((m = re.exec(d))) {
    const cmd = m[1].toUpperCase();
    if (cmd === 'H') { cx = Number(m[2]); out.push({ x: cx, y: cy }); continue; }
    if (cmd === 'V') { cy = Number(m[3]); out.push({ x: cx, y: cy }); continue; }
    cx = Number(m[2]); cy = Number(m[3]);
    out.push({ x: cx, y: cy });
  }
  return out;
}

const CMD_ARITY = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, A: 7, S: 4, T: 2, Z: 0 };

export function pathSegments(d) {
  const tokens = String(d || '').match(/[MLHVQCAZmlhvqcaz]|-?[\d.]+(?:e-?\d+)?/g) || [];
  const segs = [];
  let cx = 0, cy = 0, cmd = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[MLHVQCAZmlhvqcaz]/.test(t)) { cmd = t.toUpperCase(); i++; if (cmd === 'Z') { cx = 0; cy = 0; } continue; }
    if (!cmd) { i++; continue; }
    const arity = CMD_ARITY[cmd];
    const nums = tokens.slice(i, i + arity).map(Number);
    if (nums.length < arity) break;
    i += arity;
    if (cmd === 'M') { cx = nums[0]; cy = nums[1]; }
    else if (cmd === 'L') { segs.push({ x1: cx, y1: cy, x2: nums[0], y2: nums[1], curve: false }); cx = nums[0]; cy = nums[1]; }
    else if (cmd === 'H') { segs.push({ x1: cx, y1: cy, x2: nums[0], y2: cy, curve: false }); cx = nums[0]; }
    else if (cmd === 'V') { segs.push({ x1: cx, y1: cy, x2: cx, y2: nums[0], curve: false }); cy = nums[0]; }
    else if (cmd === 'Q') { segs.push({ x1: cx, y1: cy, x2: nums[2], y2: nums[3], curve: true }); cx = nums[2]; cy = nums[3]; }
    else if (cmd === 'C') { segs.push({ x1: cx, y1: cy, x2: nums[4], y2: nums[5], curve: true }); cx = nums[4]; cy = nums[5]; }
    else if (cmd === 'A') { segs.push({ x1: cx, y1: cy, x2: nums[5], y2: nums[6], curve: true }); cx = nums[5]; cy = nums[6]; }
  }
  return segs;
}

export function segDistanceToRect(seg, rect) {
  const { x, y, w, h } = rect;
  const x1 = clamp(seg.x1, x, x + w), y1 = clamp(seg.y1, y, y + h);
  const x2 = clamp(seg.x2, x, x + w), y2 = clamp(seg.y2, y, y + h);
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((x1 - seg.x1) * dx + (y1 - seg.y1) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const px = seg.x1 + t * dx, py = seg.y1 + t * dy;
  return Math.hypot(px - x1, py - y1);
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function distPointRect(p, r) {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
