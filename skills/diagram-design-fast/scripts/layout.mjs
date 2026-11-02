/**
 * layout.mjs — spec → geometry. Deterministic, no LLM in the loop.
 *
 *   node layout.mjs --spec spec.json [--reflow]
 *
 * Writes the `geo` block back into the spec file. Layouts:
 *   architecture / flow  layered (ranks + bands + orthogonal elbow routing)
 *   sequence             lifelines + message arrows
 *
 * Rules enforced here (diagram-design compatible):
 *   - node origins / sizes / gaps on a 4px grid
 *   - connectors orthogonal only, rounded elbows (r=8)
 *   - arrow labels always masked, 8px clear of the stroke
 *   - shared edges fan their ports (L*k/(N+1))
 *   - parallel routes offset >= 12px
 */
import { loadSpec, saveSpec, nodeSize, snap, textWidth, arrowLabel, segDistanceToRect, EDGE_KINDS, BUDGET, isMain } from './lib.mjs';

const MARGIN = 32;
const BAND_GAP = 96;   // vertical channel between bands (TB)
const COL_GAP = 96;    // horizontal channel between columns (LR)
const NODE_GAP = 40;   // gap between siblings
const ZONE_PAD = 12;
const ZONE_HEAD = 36;  // eyebrow space above the first node in a zone
const SIDE_CHANNEL = 32;
const LABEL_GAP = 8;
const PORT_MIN = 12;
const ELBOW = 8;

/* ------------------------------------------------------------------ ranks */

function assignRanks(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const deg = new Map(indeg);
  while (q.length) {
    const u = q.shift();
    for (const v of adj.get(u) || []) {
      rank.set(v, Math.max(rank.get(v), rank.get(u) + 1));
      deg.set(v, deg.get(v) - 1);
      if (deg.get(v) === 0) q.push(v);
    }
  }
  return rank;
}

function orderBands(nodes, edges, rank) {
  // compact the ranks: tiering can leave holes (rank 0, 2 but not 1)
  const used = [...new Set(nodes.map((n) => rank.get(n.id)))].sort((a, b) => a - b);
  const remap = new Map(used.map((r, i) => [r, i]));
  for (const n of nodes) rank.set(n.id, remap.get(rank.get(n.id)));

  const bands = [];
  const maxRank = used.length ? remap.get(used[used.length - 1]) : 0;
  for (let r = 0; r <= maxRank; r++) bands.push([]);
  const specIndex = new Map(nodes.map((n, i) => [n.id, i]));
  for (const n of nodes) bands[rank.get(n.id)].push(n);
  const posIn = (arr) => new Map(arr.map((n, i) => [n.id, i]));

  for (let iter = 0; iter < 4; iter++) {
    for (let r = 1; r < bands.length; r++) {
      const prevPos = posIn(bands[r - 1]);
      const bary = (n) => {
        const preds = edges.filter((e) => e.to === n.id && prevPos.has(e.from)).map((e) => prevPos.get(e.from));
        if (!preds.length) return null;
        return preds.reduce((a, b) => a + b, 0) / preds.length;
      };
      const cur = new Map(bands[r].map((n, i) => [n.id, i]));
      // members of the same group stay adjacent so a group renders as one zone,
      // and connected nodes stay adjacent so a same-band edge has room for its label
      const bandEdges = edges.filter((e) => rank.get(e.from) === r && rank.get(e.to) === r);
      const cluster = (list) => {
        const rest = list.slice();
        const out = [];
        const connected = (a, b) => bandEdges.some((e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id));
        while (rest.length) {
          let pick = 0;
          if (out.length) {
            const last = out[out.length - 1];
            const idx = rest.findIndex((n) => connected(last, n));
            if (idx >= 0) pick = idx;
          }
          const chosen = rest.splice(pick, 1)[0];
          out.push(chosen);
        }
        return out;
      };
      bands[r].sort((a, b) => {
        const ga = a.group || '', gb = b.group || '';
        if (ga !== gb) return ga < gb ? -1 : 1;
        const ba = bary(a), bb = bary(b);
        if (ba === null && bb === null) return specIndex.get(a.id) - specIndex.get(b.id);
        if (ba === null) return -1;
        if (bb === null) return 1;
        return ba - bb || cur.get(a.id) - cur.get(b.id);
      });
      // regroup by group, then cluster connected nodes inside each group
      const grouped = new Map();
      for (const n of bands[r]) {
        const key = n.group || '';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(n);
      }
      bands[r] = [...grouped.values()].flatMap((list) => cluster(list));
    }
  }
  return bands;
}

/** A group is a tier: every member shares the deepest rank of the group. */
function applyGroupTiers(nodes, rank) {
  const groups = new Map();
  for (const n of nodes) {
    if (!n.group) continue;
    if (!groups.has(n.group)) groups.set(n.group, rank.get(n.id));
    else groups.set(n.group, Math.max(groups.get(n.group), rank.get(n.id)));
  }
  for (const n of nodes) {
    if (n.group && groups.has(n.group)) rank.set(n.id, groups.get(n.group));
  }
  return rank;
}

/* ------------------------------------------------------------------ ports */

/** Distribute ports along one edge of a node: L*k/(N+1). */
function portPositions(items, length, offset) {
  const n = items.length;
  const out = new Map();
  items.forEach((it, i) => {
    const t = (i + 1) / (n + 1);
    out.set(it.key, offset + length * t);
  });
  return out;
}

/* ------------------------------------------------------------------ layout */

function layoutLayered(spec, geoPrev) {
  const dir = spec.dir === 'LR' ? 'LR' : 'TB';
  const nodes = spec.nodes.map((n) => {
    const size = nodeSize(n);
    return { ...n, ...size };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = spec.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

  const rank = applyGroupTiers(nodes, assignRanks(nodes, edges));
  const bands = orderBands(nodes, edges, rank);
  const hasGroups = nodes.some((n) => n.group);

  const place = new Map();
  // a labelled edge between two neighbours needs room for its label above the line
  const gapFor = (a, b) => {
    const edge = edges.find((e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id));
    if (!edge || !edge.label) return NODE_GAP;
    const tw = textWidth(arrowLabel(edge.label), 8, true);
    return Math.max(NODE_GAP, snap(tw + 24));
  };
  if (dir === 'TB') {
    let y = MARGIN + (hasGroups ? ZONE_HEAD : 0);
    for (const band of bands) {
      const bandH = band.length ? Math.max(...band.map((n) => n.h)) : 0;
      let x = MARGIN;
      band.forEach((n, i) => {
        place.set(n.id, { x: snap(x), y: snap(y) });
        const next = band[i + 1];
        x += n.w + (next ? gapFor(n, next) : NODE_GAP);
      });
      y += bandH + BAND_GAP;
    }
  } else {
    let x = MARGIN;
    for (const band of bands) {
      const bandW = band.length ? Math.max(...band.map((n) => n.w)) : 0;
      let y = MARGIN;
      for (const n of band) {
        place.set(n.id, { x: snap(x), y: snap(y) });
        y += n.h + NODE_GAP;
      }
      x += bandW + COL_GAP;
    }
  }

  // centre each band / column on a common cross-axis
  if (dir === 'TB') {
    const width = Math.max(...bands.map((b) => b.reduce((s, n) => s + n.w, 0) + NODE_GAP * Math.max(0, b.length - 1)));
    const contentW = width + MARGIN * 2;
    for (const band of bands) {
      const bandW = band.reduce((s, n) => s + n.w, 0) + NODE_GAP * Math.max(0, band.length - 1);
      const shift = Math.max(0, Math.round((width - bandW) / 2));
      for (const n of band) place.get(n.id).x = snap(place.get(n.id).x + shift);
    }
    var contentRight = contentW;
  } else {
    const height = Math.max(...bands.map((b) => b.reduce((s, n) => s + n.h, 0) + NODE_GAP * Math.max(0, b.length - 1)));
    for (const band of bands) {
      const bandH = band.reduce((s, n) => s + n.h, 0) + NODE_GAP * Math.max(0, band.length - 1);
      const shift = Math.max(0, Math.round((height - bandH) / 2));
      for (const n of band) place.get(n.id).y = snap(place.get(n.id).y + shift);
    }
    var contentRight = Math.max(...nodes.map((n) => place.get(n.id).x + n.w)) + SIDE_CHANNEL;
  }

  // reuse previous positions when the node set is unchanged (cheap revisions)
  if (geoPrev?.nodes && !spec.reflow) {
    const prevIds = Object.keys(geoPrev.nodes);
    const same = prevIds.length === nodes.length
      && nodes.every((n) => geoPrev.nodes[n.id]
        && geoPrev.nodes[n.id].w === n.w
        && geoPrev.nodes[n.id].h === n.h);
    // sizes unchanged -> keep the previous coordinates, so a revision moves nothing
    if (same) for (const n of nodes) place.set(n.id, { x: geoPrev.nodes[n.id].x, y: geoPrev.nodes[n.id].y });
  }

  const geoNodes = {};
  for (const n of nodes) {
    const p = place.get(n.id);
    geoNodes[n.id] = { x: p.x, y: p.y, w: n.w, h: n.h, shape: n.shape, tag: n.tag, kind: n.kind, accent: !!n.accent, label: n.label, sub: n.sub ?? '' };
  }

  /* -------- zones: one box per group (a group is a tier) -------- */
  const zones = [];
  const groupLabel = new Map((spec.groups || []).map((g) => [g.id, g.label ?? g.id]));
  const byGroup = new Map();
  for (const n of nodes) {
    if (!n.group) continue;
    if (!byGroup.has(n.group)) byGroup.set(n.group, []);
    byGroup.get(n.group).push(n);
  }
  for (const [gid, members] of byGroup) {
    const minX = Math.min(...members.map((n) => geoNodes[n.id].x));
    const maxX = Math.max(...members.map((n) => geoNodes[n.id].x + geoNodes[n.id].w));
    const minY = Math.min(...members.map((n) => geoNodes[n.id].y));
    const maxY = Math.max(...members.map((n) => geoNodes[n.id].y + geoNodes[n.id].h));
    zones.push({
      id: gid, label: groupLabel.get(gid) ?? gid,
      x: snap(minX - ZONE_PAD), y: snap(minY - ZONE_HEAD),
      w: snap(maxX - minX + ZONE_PAD * 2), h: snap(maxY - minY + ZONE_HEAD + ZONE_PAD),
    });
  }

  /* -------- routing -------- */
  const geoEdges = [];
  const outPorts = new Map();  // `${node}:${side}` → items
  const inPorts = new Map();

  const sideOf = (id, side) => `${id}:${side}`;
  const push = (map, id, side, key) => {
    const k = sideOf(id, side);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ key });
  };

  for (const e of edges) {
    const u = geoNodes[e.from], v = geoNodes[e.to];
    const ru = rank.get(e.from), rv = rank.get(e.to);
    let uSide, vSide;
    if (dir === 'TB') {
      if (rv > ru) { uSide = 'bottom'; vSide = 'top'; }
      else if (rv === ru) { uSide = v.x >= u.x ? 'right' : 'left'; vSide = v.x >= u.x ? 'left' : 'right'; }
      else { uSide = 'right'; vSide = 'right'; }
    } else {
      if (rv > ru) { uSide = 'right'; vSide = 'left'; }
      else if (rv === ru) { uSide = v.y >= u.y ? 'bottom' : 'top'; vSide = v.y >= u.y ? 'top' : 'bottom'; }
      else { uSide = 'bottom'; vSide = 'bottom'; }
    }
    push(outPorts, e.from, uSide, e.id);
    push(inPorts, e.to, vSide, e.id);
  }

  // resolve port coordinates per (node, side)
  const portCoord = new Map(); // edgeId -> {u:{x,y,side}, v:{x,y,side}}
  for (const [key, items] of outPorts) {
    const [id, side] = key.split(':');
    const n = geoNodes[id];
    const len = side === 'top' || side === 'bottom' ? n.w : n.h;
    const offset = side === 'top' || side === 'bottom' ? n.x : n.y;
    const coords = portPositions(items, len, offset);
    for (const it of items) {
      const c = coords.get(it.key);
      const p = { side, x: c, y: c };
      if (side === 'top') { p.x = c; p.y = n.y; }
      else if (side === 'bottom') { p.x = c; p.y = n.y + n.h; }
      else if (side === 'left') { p.x = n.x; p.y = c; }
      else { p.x = n.x + n.w; p.y = c; }
      portCoord.set(it.key, { ...(portCoord.get(it.key) || {}), u: p });
    }
  }
  for (const [key, items] of inPorts) {
    const [id, side] = key.split(':');
    const n = geoNodes[id];
    const len = side === 'top' || side === 'bottom' ? n.w : n.h;
    const offset = side === 'top' || side === 'bottom' ? n.x : n.y;
    const coords = portPositions(items, len, offset);
    for (const it of items) {
      const c = coords.get(it.key);
      const p = { side, x: c, y: c };
      if (side === 'top') { p.x = c; p.y = n.y; }
      else if (side === 'bottom') { p.x = c; p.y = n.y + n.h; }
      else if (side === 'left') { p.x = n.x; p.y = c; }
      else { p.x = n.x + n.w; p.y = c; }
      const cur = portCoord.get(it.key) || {};
      portCoord.set(it.key, { ...cur, v: p });
    }
  }

  // channel offsets: keep parallel routes >= 12px apart
  const channelUse = new Map();
  const channelFor = (key) => {
    const c = (channelUse.get(key) || 0);
    channelUse.set(key, c + 1);
    return c;
  };

  for (const e of edges) {
    const pc = portCoord.get(e.id);
    if (!pc?.u || !pc?.v) continue;
    const u = geoNodes[e.from], v = geoNodes[e.to];
    const ru = rank.get(e.from), rv = rank.get(e.to);
    let pts;

    if (dir === 'TB') {
      if (rv > ru) {
        const midY = snap(u.y + u.h + BAND_GAP / 2 + channelFor(`band:${ru}`) * 12);
        if (Math.abs(pc.u.x - pc.v.x) < 0.5) {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.v.x, y: pc.v.y }];
        } else {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.u.x, y: midY }, { x: pc.v.x, y: midY }, { x: pc.v.x, y: pc.v.y }];
        }
      } else if (rv === ru) {
        const midX = snap((pc.u.x + pc.v.x) / 2);
        if (Math.abs(pc.u.y - pc.v.y) < 0.5) {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.v.x, y: pc.v.y }];
        } else {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: midX, y: pc.u.y }, { x: midX, y: pc.v.y }, { x: pc.v.x, y: pc.v.y }];
        }
      } else {
        const sideX = snap(contentRight + SIDE_CHANNEL + channelFor(`side:${ru}`) * 12);
        pts = [{ x: pc.u.x, y: pc.u.y }, { x: sideX, y: pc.u.y }, { x: sideX, y: pc.v.y }, { x: pc.v.x, y: pc.v.y }];
      }
    } else {
      if (rv > ru) {
        const midX = snap(u.x + u.w + COL_GAP / 2 + channelFor(`col:${ru}`) * 12);
        if (Math.abs(pc.u.y - pc.v.y) < 0.5) {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.v.x, y: pc.v.y }];
        } else {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: midX, y: pc.u.y }, { x: midX, y: pc.v.y }, { x: pc.v.x, y: pc.v.y }];
        }
      } else if (rv === ru) {
        const midY = snap((pc.u.y + pc.v.y) / 2);
        if (Math.abs(pc.u.x - pc.v.x) < 0.5) {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.v.x, y: pc.v.y }];
        } else {
          pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.u.x, y: midY }, { x: pc.v.x, y: midY }, { x: pc.v.x, y: pc.v.y }];
        }
      } else {
        const sideY = snap(Math.max(...nodes.map((n) => geoNodes[n.id].y + geoNodes[n.id].h)) + SIDE_CHANNEL + channelFor(`side:${ru}`) * 12);
        pts = [{ x: pc.u.x, y: pc.u.y }, { x: pc.u.x, y: sideY }, { x: pc.v.x, y: sideY }, { x: pc.v.x, y: pc.v.y }];
      }
    }

    geoEdges.push({ id: e.id, from: e.from, to: e.to, kind: e.kind || 'sync', label: e.label || '', points: pts });
  }

  /* -------- arrow labels -------- */
  const nodeRects = Object.values(geoNodes).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const overlapsNode = (m) => nodeRects.some((r) => r.x < m.x + m.w && m.x < r.x + r.w && r.y < m.y + m.h && m.y < r.y + r.h);
  const clearOfSegments = (m, segs) => {
    let best = Infinity;
    for (const s of segs) best = Math.min(best, segDistanceToRect(s, m));
    return best;
  };
  const placedMasks = [];
  for (const ge of geoEdges) {
    const kind = EDGE_KINDS[ge.kind] ?? EDGE_KINDS.sync;
    const text = arrowLabel(ge.label);
    if (!text) { ge.labelMask = null; continue; }
    const tw = textWidth(text, 8, true);
    const mw = snap(tw + 16);
    const segs = [];
    for (let i = 1; i < ge.points.length; i++) {
      const a = ge.points[i - 1], b = ge.points[i];
      segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, len: Math.hypot(b.x - a.x, b.y - a.y) });
    }
    const verticals = segs.filter((s) => Math.abs(s.x1 - s.x2) < 0.5 && s.len >= 24).sort((a, b) => b.len - a.len);
    const horizontals = segs.filter((s) => Math.abs(s.y1 - s.y2) < 0.5 && s.len >= mw).sort((a, b) => b.len - a.len);
    const candidates = [];
    for (const s of verticals) {
      const cy = (s.y1 + s.y2) / 2;
      candidates.push({ x: snap(s.x1 + LABEL_GAP), y: snap(cy - 6), w: mw, h: 12 });
      candidates.push({ x: snap(s.x1 - LABEL_GAP - mw), y: snap(cy - 6), w: mw, h: 12 });
    }
    for (const s of horizontals) {
      const cx = (s.x1 + s.x2) / 2;
      candidates.push({ x: snap(cx - mw / 2), y: snap(s.y1 - LABEL_GAP - 12), w: mw, h: 12 });
      candidates.push({ x: snap(cx - mw / 2), y: snap(s.y1 + LABEL_GAP), w: mw, h: 12 });
    }
    let mask = null;
    for (const c of candidates) {
      if (overlapsNode(c)) continue;
      if (placedMasks.some((p) => p.x < c.x + c.w && c.x < p.x + p.w && p.y < c.y + c.h && c.y < p.y + p.h)) continue;
      const gap = clearOfSegments(c, segs);
      if (gap < 6 || gap > 12) continue;
      mask = c;
      break;
    }
    if (!mask) {
      // nothing clean: keep the label but park it in the first candidate slot
      const fallback = candidates[0] || { x: snap(ge.points[0].x + LABEL_GAP), y: snap(ge.points[0].y - 6), w: mw, h: 12 };
      mask = fallback;
      ge.labelWarning = 'label had no clean slot';
    }
    ge.labelMask = mask;
    placedMasks.push(mask);
    ge.labelText = text;
    ge.color = kind.color;
    ge.dash = kind.dash;
  }

  /* -------- canvas -------- */
  const maxRight = Math.max(...nodes.map((n) => geoNodes[n.id].x + geoNodes[n.id].w));
  const maxBottom = Math.max(...nodes.map((n) => geoNodes[n.id].y + geoNodes[n.id].h));
  const width = snap(Math.max(maxRight + MARGIN + SIDE_CHANNEL, MARGIN * 2 + 320));
  const legendTop = snap(maxBottom + 40);
  const legend = layoutLegend(buildLegend(spec, { edges: geoEdges, nodes: geoNodes }), width, legendTop);
  const height = snap(legend.bottom + 24);

  return { canvas: { w: width, h: height }, nodes: geoNodes, zones, edges: geoEdges, legend, legendY: legendTop, contentBottom: snap(maxBottom) };
}

/* ------------------------------------------------------------------ sequence */

function layoutSequence(spec) {
  const nodes = spec.nodes.map((n) => ({ ...n, ...nodeSize(n) }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const GAP = 80;
  const total = nodes.reduce((s, n) => s + n.w, 0) + GAP * Math.max(0, nodes.length - 1);
  let x = MARGIN;
  const geoNodes = {};
  for (const n of nodes) {
    geoNodes[n.id] = { x: snap(x), y: MARGIN, w: n.w, h: n.h, shape: 'box', tag: n.kind ? (n.tag ?? '') : '', kind: n.kind, accent: !!n.accent, label: n.label, sub: n.sub ?? '' };
    x += n.w + GAP;
  }
  const center = (id) => {
    const n = geoNodes[id];
    return n ? n.x + n.w / 2 : 0;
  };
  const lifelines = nodes.map((n) => ({
    id: n.id, x: snap(center(n.id)), from: MARGIN + n.h, to: 0,
  }));

  const messages = (spec.messages || []).filter((m) => byId.has(m.from) && byId.has(m.to));
  const MSG_TOP = MARGIN + 80;
  const MSG_STEP = 56;
  const geoMsgs = messages.map((m, i) => {
    const y = snap(MSG_TOP + i * MSG_STEP);
    const x1 = center(m.from), x2 = center(m.to);
    const self = m.from === m.to;
    let points;
    if (self) {
      points = [{ x: x1, y }, { x: x1 + 36, y }, { x: x1 + 36, y: y - 24 }, { x: x1 + 8, y: y - 24 }];
    } else {
      points = [{ x: x1, y }, { x: x2, y }];
    }
    const kind = EDGE_KINDS[m.kind] ?? EDGE_KINDS.sync;
    const text = arrowLabel(m.label);
    const tw = textWidth(text, 8, true);
    const midX = self ? x1 + 22 : (x1 + x2) / 2;
    return {
      id: m.id ?? `m${i}`, from: m.from, to: m.to, kind: m.kind || 'sync',
      label: text, color: kind.color, dash: kind.dash, points,
      labelMask: text ? { x: snap(midX - (tw + 16) / 2), y: snap(y - LABEL_GAP - 12), w: snap(tw + 16), h: 12 } : null,
    };
  });

  const lastY = geoMsgs.length ? geoMsgs[geoMsgs.length - 1].points[0].y : MSG_TOP;
  for (const l of lifelines) l.to = snap(lastY + 32);

  const fragLeft = snap(Math.min(...nodes.map((n) => geoNodes[n.id].x)) - 16);
  const fragRight = snap(Math.max(...nodes.map((n) => geoNodes[n.id].x + geoNodes[n.id].w)) + 16);
  const participantBottom = snap(MARGIN + Math.max(...nodes.map((n) => n.h)));
  const fragments = (spec.fragments || []).map((f) => {
    const start = Math.max(0, geoMsgs.findIndex((m) => m.id === f.from_msg));
    let end = geoMsgs.findIndex((m) => m.id === f.to_msg);
    if (end < 0) end = geoMsgs.length - 1;
    const rows = geoMsgs.slice(start, end + 1);
    const ys = rows.flatMap((m) => m.points.map((p) => p.y));
    const top = snap(Math.max(participantBottom + 8, Math.min(...ys) - 24));
    const bottom = snap(Math.max(...ys) + 24);
    return { id: f.id ?? 'frag', kind: f.kind || 'alt', label: f.label || '', x: fragLeft, y: top, w: snap(fragRight - fragLeft), h: snap(bottom - top) };
  });

  const maxRight = Math.max(...nodes.map((n) => geoNodes[n.id].x + geoNodes[n.id].w));
  const maxBottom = Math.max(lastY + 32, ...fragments.map((f) => f.y + f.h));
  const width = snap(Math.max(maxRight + MARGIN + SIDE_CHANNEL, MARGIN * 2 + 320));
  const legendTop = snap(maxBottom + 40);
  const legend = layoutLegend(buildLegend(spec, { edges: geoMsgs, nodes: geoNodes }), width, legendTop);
  const height = snap(legend.bottom + 24);

  return { canvas: { w: width, h: height }, nodes: geoNodes, zones: [], edges: [], messages: geoMsgs, lifelines, fragments, legend, legendY: legendTop, contentBottom: snap(maxBottom) };
}

/* ------------------------------------------------------------------ legend */

export function buildLegend(spec, geo) {
  const items = [];
  const seen = new Set();
  const add = (label, color, dash) => {
    const k = `${label}|${color}|${dash || ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push({ label, color, dash: dash || null });
  };
  const edgeList = geo.edges?.length ? geo.edges : (geo.messages || []);
  for (const e of edgeList) {
    const kind = EDGE_KINDS[e.kind] ?? EDGE_KINDS.sync;
    add(kind.label, kind.color, kind.dash);
  }
  const kinds = new Set(Object.values(geo.nodes || {}).map((n) => n.kind));
  const addNode = (label, dash = null) => {
    const k = `node:${label}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push({ label, color: 'muted', dash, shape: 'box' });
  };
  if (kinds.has('db')) addNode('DATA');
  if (kinds.has('queue')) addNode('QUEUE');
  if (kinds.has('external')) addNode('EXTERNAL', '4,3');
  return items.slice(0, 6);
}

/** Lay the legend out as one or more rows that fit the canvas width. */
function layoutLegend(items, width, top) {
  const rows = [];
  let row = { items: [], y: top };
  let x = 32 + 80;
  const nextRow = () => {
    rows.push(row);
    row = { items: [], y: top + rows.length * 24 };
    x = 32 + 80;
  };
  for (const it of items) {
    const w = (it.shape === 'box' ? 12 : 24) + 8 + textWidth(it.label, 8) + 32;
    if (x + w > width - 32 && row.items.length) nextRow();
    row.items.push({ ...it, x });
    x += w;
  }
  if (row.items.length) rows.push(row);
  const bottom = rows.length ? rows[rows.length - 1].y + 16 : top;
  return { rows, bottom, height: rows.length ? rows[rows.length - 1].y - top + 24 : 0 };
}

/* ------------------------------------------------------------------ cli */

export function layoutSpec(spec, { reflow = false } = {}) {
  if (!spec.nodes || !spec.nodes.length) {
    throw new Error('spec has no nodes — add at least one node before building');
  }
  spec.reflow = reflow || spec.reflow || false;
  const geo = spec.view === 'sequence'
    ? layoutSequence(spec)
    : layoutLayered(spec, spec.geo);
  spec.geo = geo;
  return spec;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const file = get('--spec');
  if (!file) {
    console.error('usage: node layout.mjs --spec <spec.json> [--reflow]');
    process.exit(2);
  }
  const spec = loadSpec(file);
  layoutSpec(spec, { reflow: args.includes('--reflow') });
  saveSpec(file, spec);
  const g = spec.geo;
  const warn = [];
  const nodeCount = Object.keys(g.nodes).length;
  const edgeCount = (g.edges?.length || 0) + (g.messages?.length || 0);
  if (nodeCount > BUDGET.nodes) warn.push(`nodes ${nodeCount} > ${BUDGET.nodes} — split into overview + detail`);
  if (edgeCount > BUDGET.edges) warn.push(`edges ${edgeCount} > ${BUDGET.edges} — split into overview + detail`);
  const accents = Object.values(g.nodes).filter((n) => n.accent).length;
  if (accents > BUDGET.accent) warn.push(`accent nodes ${accents} > ${BUDGET.accent} — reserve accent for 1-2 focal nodes`);
  console.log(`laid out ${file}: ${nodeCount} nodes, ${edgeCount} edges, canvas ${g.canvas.w}x${g.canvas.h}`);
  for (const w of warn) console.log(`  ! ${w}`);
}
