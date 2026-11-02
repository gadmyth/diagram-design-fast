/**
 * render.mjs — spec (+geo) → self-contained HTML with inline SVG.
 *
 *   node render.mjs --spec spec.json --out diagram.html
 *
 * The HTML is a *rendered artefact*. The spec is the source of truth: never
 * hand-edit the HTML, patch the spec and re-render.
 */
import { writeFileSync } from 'node:fs';
import { loadSpec, skinOf, textWidth, fitLabel, fmt, snap, arrowLabel, EDGE_KINDS, isMain } from './lib.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function nodeMarkup(n, id) {
  const accent = n.accent;
  // upstream's default node fill is `paper`; boxes read as hairline outlines on the page
  const fill = accent ? 'var(--accent)' : 'var(--paper)';
  const stroke = accent ? 'var(--accent)' : 'var(--ink)';
  const nameFill = accent ? 'var(--accent-fg)' : 'var(--ink)';
  const subFill = accent ? 'var(--accent-fg)' : 'var(--muted)';
  const dash = n.shape === 'external' ? ' stroke-dasharray="4,3"' : '';
  const parts = [];
  parts.push(`<rect data-role="mask" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" fill="var(--paper)"/>`);

  if (n.shape === 'diamond') {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
    parts.push(`<polygon data-role="node" data-node="${esc(id)}" points="${cx},${n.y} ${n.x + n.w},${cy} ${cx},${n.y + n.h} ${n.x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`);
  } else {
    parts.push(`<rect data-role="node" data-node="${esc(id)}" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1"${dash}/>`);
  }

  if (n.shape === 'queue') {
    parts.push(`<line x1="${n.x + n.w - 30}" y1="${n.y + 14}" x2="${n.x + n.w - 30}" y2="${n.y + n.h - 14}" stroke="${accent ? 'var(--accent-fg)' : 'var(--muted)'}" stroke-width="0.8" opacity="0.45"/>`);
    parts.push(`<line x1="${n.x + n.w - 22}" y1="${n.y + 18}" x2="${n.x + n.w - 22}" y2="${n.y + n.h - 18}" stroke="${accent ? 'var(--accent-fg)' : 'var(--muted)'}" stroke-width="0.8" opacity="0.45"/>`);
  }

  if (n.tag && n.shape !== 'diamond') {
    parts.push(`<rect x="${n.x + 8}" y="${n.y + 6}" width="28" height="12" rx="2" fill="transparent" stroke="${accent ? 'var(--accent-fg)' : 'var(--ink)'}" stroke-width="0.8" opacity="0.5"/>`);
    parts.push(`<text x="${n.x + 22}" y="${n.y + 15}" fill="${accent ? 'var(--accent-fg)' : 'var(--soft)'}" font-size="7" font-family="var(--f-eyebrow)" text-anchor="middle" letter-spacing="0.08em">${esc(n.tag)}</text>`);
  }

  const cx = n.x + n.w / 2;
  const hasSub = !!n.sub;
  const name = fitLabel(n.label, 12, n.w - 28);
  parts.push(`<text data-role="node-name" x="${cx}" y="${snap(n.y + (hasSub ? 26 : 28))}" fill="${nameFill}" font-size="12" font-weight="600" font-family="var(--f-node)" text-anchor="middle">${esc(name)}</text>`);
  if (hasSub) {
    const sub = fitLabel(n.sub, 9, n.w - 20, true);
    const subY = n.shape === 'db' ? n.y + 36 : n.y + 42;
    parts.push(`<text data-role="node-sub" x="${cx}" y="${snap(subY)}" fill="${subFill}" font-size="9" font-family="var(--f-sub)" text-anchor="middle">${esc(sub)}</text>`);
  }
  return parts.join('\n      ');
}

function arrowPath(points) {
  // rounded elbows, r=8 — implemented inline to keep the lib dependency-free
  const r = 8;
  if (points.length < 2) return '';
  let d = `M ${fmt(points[0].x)},${fmt(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], prev = points[i - 1], next = points[i + 1];
    const v1x = p.x - prev.x, v1y = p.y - prev.y, v2x = next.x - p.x, v2y = next.y - p.y;
    const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p1 = { x: p.x - (v1x / l1) * rr, y: p.y - (v1y / l1) * rr };
    const p2 = { x: p.x + (v2x / l2) * rr, y: p.y + (v2y / l2) * rr };
    d += ` L ${fmt(p1.x)},${fmt(p1.y)} Q ${fmt(p.x)},${fmt(p.y)} ${fmt(p2.x)},${fmt(p2.y)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${fmt(last.x)},${fmt(last.y)}`;
  return d;
}

const MARKER = {
  muted: 'arrow', accent: 'arrow-accent', link: 'arrow-link',
};

export function renderHtml(spec) {
  const g = spec.geo;
  if (!g) throw new Error('spec has no geo — run layout.mjs first');
  const skin = skinOf(spec);
  const slug = (spec.slug || 'diagram').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const { w, h } = g.canvas;
  const fontSource = spec.font_source || 'system';

  const css = `
:root{
  --paper:${skin.paper}; --ink:${skin.ink}; --muted:${skin.muted}; --soft:${skin.soft};
  --paper-2:${skin['paper-2']}; --accent:${skin.accent}; --accent-fg:${skin['accent-fg']}; --link:${skin.link};
  --rule:${skin.rule};
  --rule-solid:${skin['rule-solid']};
  --f-title:"Instrument Serif",Georgia,"Songti SC",serif;
  --f-node:Geist,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
  --f-sub:"Geist Mono",ui-monospace,Menlo,Consolas,monospace;
  --f-eyebrow:Geist,"Helvetica Neue",Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--f-node)}
main{max-width:1080px;margin:0 auto;padding:56px 32px 72px}
.eyebrow{margin:0 0 10px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--soft);font-family:var(--f-eyebrow)}
h1{margin:0 0 10px;font-family:var(--f-title);font-weight:400;font-size:36px;line-height:1.15;letter-spacing:-.01em}
.subtitle{margin:0 0 36px;max-width:68ch;font-size:14px;line-height:1.6;color:var(--muted)}
.figure{margin:0;overflow-x:auto;-webkit-overflow-scrolling:touch}
.figure svg{display:block;min-width:${w}px}
.cards{display:grid;grid-template-columns:1.1fr 1fr .9fr;gap:16px;margin-top:40px}
.card{background:#fff;border:1px solid var(--rule);border-radius:6px;padding:20px}
.card h3{margin:8px 0 10px;font-size:15px;font-weight:600}
.card ul{margin:0;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.7}
.card .card-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);color:var(--soft);font-size:12px;font-family:var(--f-sub)}
@media (max-width:760px){.cards{grid-template-columns:1fr}}
`.trim();

  const fontLink = fontSource === 'google'
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;600&family=Geist+Mono:wght@400&display=swap" rel="stylesheet">`
    : '';

  /* ---- defs ---- */
  const defs = `
    <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="var(--muted)"/></marker>
    <marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="var(--accent)"/></marker>
    <marker id="arrow-link" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="var(--link)"/></marker>`;

  /* ---- zones ---- */
  const zoneParts = (g.zones || []).map((z) => {
    const lw = textWidth(z.label, 7, false) + 16;
    return `      <g data-role="zone" data-zone="${esc(z.id)}">
        <rect data-role="zone" x="${z.x}" y="${z.y}" width="${z.w}" height="${z.h}" rx="8" fill="var(--ink)" fill-opacity="0.02" stroke="var(--ink)" stroke-opacity="0.10" stroke-width="0.8"/>
        <rect data-role="mask" x="${z.x + 12}" y="${z.y + 4}" width="${snap(lw)}" height="12" rx="2" fill="var(--paper)"/>
        <text x="${z.x + 12 + snap(lw) / 2}" y="${z.y + 13}" fill="var(--soft)" font-size="7" font-family="var(--f-eyebrow)" text-anchor="middle" letter-spacing="0.14em">${esc(z.label)}</text>
      </g>`;
  });

  /* ---- connectors ---- */
  const connParts = [];
  for (const e of g.edges || []) {
    const kind = EDGE_KINDS[e.kind] ?? EDGE_KINDS.sync;
    const color = e.color || kind.color;
    const dash = e.dash || kind.dash;
    connParts.push(`      <path data-role="connector" data-edge="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" d="${arrowPath(e.points)}" fill="none" stroke="var(--${color})" stroke-width="1.2"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${MARKER[color] || 'arrow'})"/>`);
  }
  for (const m of g.messages || []) {
    const kind = EDGE_KINDS[m.kind] ?? EDGE_KINDS.sync;
    const color = m.color || kind.color;
    const dash = m.dash || kind.dash;
    connParts.push(`      <path data-role="connector" data-edge="${esc(m.id)}" data-from="${esc(m.from)}" data-to="${esc(m.to)}" d="${arrowPath(m.points)}" fill="none" stroke="var(--${color})" stroke-width="1.2"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${MARKER[color] || 'arrow'})"/>`);
  }

  /* ---- labels ---- */
  const labelParts = [];
  for (const e of [...(g.edges || []), ...(g.messages || [])]) {
    const labelText = e.labelText ?? arrowLabel(e.label);
    if (!e.labelMask || !labelText) continue;
    const m = e.labelMask;
    labelParts.push(`      <g data-role="edge-label-group" data-edge="${esc(e.id)}">
        <rect data-role="mask" data-edge="${esc(e.id)}" x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" rx="2" fill="var(--paper)"/>
        <text data-role="edge-label" x="${snap(m.x + m.w / 2)}" y="${snap(m.y + 9)}" fill="var(--soft)" font-size="8" font-family="var(--f-sub)" text-anchor="middle" letter-spacing="0.06em">${esc(labelText)}</text>
      </g>`);
  }

  /* ---- nodes ---- */
  const nodeParts = Object.entries(g.nodes || {}).map(([id, n]) => `      <g data-node="${esc(id)}">\n      ${nodeMarkup(n, id)}\n      </g>`);

  /* ---- sequence extras ---- */
  const lifelineParts = (g.lifelines || []).map((l) => `      <line data-role="lifeline" x1="${l.x}" y1="${l.from}" x2="${l.x}" y2="${l.to}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 3"/>`);
  const fragParts = (g.fragments || []).map((f) => {
    const lw = textWidth(f.label, 7) + 16;
    return `      <g data-role="fragment" data-fragment="${esc(f.id)}">
        <rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="8" fill="none" stroke="var(--ink)" stroke-opacity="0.18" stroke-width="0.8" stroke-dasharray="4 3"/>
        <rect data-role="mask" x="${f.x + 8}" y="${f.y - 6}" width="${snap(lw)}" height="12" rx="2" fill="var(--paper)"/>
        <text x="${f.x + 8 + snap(lw) / 2}" y="${f.y + 3}" fill="var(--soft)" font-size="7" font-family="var(--f-eyebrow)" text-anchor="middle" letter-spacing="0.12em">${esc(f.label)}</text>
      </g>`;
  });

  /* ---- legend ---- */
  const legend = g.legend?.rows || [];
  const legendParts = [];
  for (const row of legend) {
    legendParts.push(`      <line x1="32" y1="${row.y - 8}" x2="${g.canvas.w - 32}" y2="${row.y - 8}" stroke="var(--ink)" stroke-opacity="0.10" stroke-width="0.8"/>`);
    legendParts.push(`      <text x="32" y="${row.y + 8}" fill="var(--soft)" font-size="8" font-family="var(--f-eyebrow)" letter-spacing="0.14em">LEGEND</text>`);
    for (const item of row.items) {
      if (item.shape === 'box') {
        legendParts.push(`      <rect x="${item.x}" y="${row.y - 2}" width="12" height="12" rx="2" fill="var(--paper-2)" stroke="var(--${item.color})" stroke-width="1"${item.dash ? ` stroke-dasharray="${item.dash}"` : ''}/>`);
      } else {
        legendParts.push(`      <line x1="${item.x}" y1="${row.y + 4}" x2="${item.x + 24}" y2="${row.y + 4}" stroke="var(--${item.color})" stroke-width="1.2"${item.dash ? ` stroke-dasharray="${item.dash}"` : ''}/>`);
      }
      legendParts.push(`      <text x="${item.x + 32}" y="${row.y + 8}" fill="var(--muted)" font-size="8" font-family="var(--f-eyebrow)" letter-spacing="0.06em">${esc(item.label)}</text>`);
    }
  }

  const svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" data-view="${esc(spec.view || 'architecture')}" aria-labelledby="${slug}-title ${slug}-desc" font-family="var(--f-node)">
      <title id="${slug}-title">${esc(spec.title || slug)}</title>
      <desc id="${slug}-desc">${esc(spec.desc || spec.title || slug)}</desc>
      <defs>${defs}
      </defs>
      <rect width="100%" height="100%" fill="var(--paper)"/>
      ${zoneParts.join('\n      ')}
      ${fragParts.join('\n      ')}
      ${lifelineParts.join('\n      ')}
      ${connParts.join('\n      ')}
      ${labelParts.join('\n      ')}
      ${nodeParts.join('\n      ')}
      ${legendParts.join('\n      ')}
    </svg>`;

  const cards = (spec.cards || []).length ? `
    <section class="cards">
      ${spec.cards.map((c) => `<article class="card">
        <p class="eyebrow">${esc(c.eyebrow || '')}</p>
        <h3><span class="card-dot"></span> ${esc(c.title || '')}</h3>
        <ul>${(c.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      </article>`).join('\n      ')}
    </section>` : '';

  return `<!DOCTYPE html>
<html lang="${esc(spec.lang || 'zh-CN')}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title || slug)}</title>
${fontLink}
<style>${css}</style>
</head>
<body>
<main>
  <p class="eyebrow">${esc(spec.eyebrow || 'ARCHITECTURE')}</p>
  <h1>${esc(spec.title || slug)}</h1>
  ${spec.desc ? `<p class="subtitle">${esc(spec.desc)}</p>` : ''}
  <figure class="figure">${svg}</figure>
  ${cards}
  <footer>${esc(spec.footer || 'Generated from a spec file — edit the spec, not this file.')}</footer>
</main>
</body>
</html>
`;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  const specFile = get('--spec');
  const out = get('--out');
  if (!specFile || !out) {
    console.error('usage: node render.mjs --spec <spec.json> --out <file.html>');
    process.exit(2);
  }
  const spec = loadSpec(specFile);
  writeFileSync(out, renderHtml(spec), 'utf8');
  console.log(`rendered ${out}`);
}
