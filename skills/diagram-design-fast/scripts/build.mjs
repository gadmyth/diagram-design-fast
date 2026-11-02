/**
 * build.mjs — one command: spec → layout → HTML → validation.
 *
 *   node build.mjs --spec <spec.json> --out <file.html> [--reflow]
 *
 * Exits non-zero when the rendered file fails validation, so it can gate a commit.
 */
import { writeFileSync } from 'node:fs';
import { loadSpec, saveSpec, isMain } from './lib.mjs';
import { layoutSpec } from './layout.mjs';
import { renderHtml } from './render.mjs';
import { checkHtml } from './check.mjs';

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
  };
  const specFile = flag('spec');
  const out = flag('out');
  if (!specFile || !out) {
    console.error('usage: node build.mjs --spec <spec.json> --out <file.html> [--reflow]');
    process.exit(2);
  }
  const spec = loadSpec(specFile);
  let html;
  try {
    layoutSpec(spec, { reflow: args.includes('--reflow') });
    html = renderHtml(spec);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
  // persist the geometry cache: the next revision can reuse it and keep coordinates stable
  saveSpec(specFile, spec);
  writeFileSync(out, html, 'utf8');
  const { findings, ok } = checkHtml(html, out);
  for (const f of findings) console.log(`  ${f.level === 'error' ? 'x' : '!'} ${f.msg}`);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${out} — ${Object.keys(spec.geo.nodes).length} nodes, ${spec.geo.canvas.w}x${spec.geo.canvas.h}`);
  process.exit(ok ? 0 : 1);
}
