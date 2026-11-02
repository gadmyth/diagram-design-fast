/**
 * index-repo.mjs — turn a source tree into a compact, reusable index.
 *
 *   node index-repo.mjs --root <repo> --out <dir> [--update] [--max-files 4000]
 *
 * Supported: Python, TypeScript/JavaScript, Java, Go, C.
 *
 * Outputs:
 *   <dir>/repo-index.json   machine readable: modules, symbols, deps, entrypoints
 *   <dir>/repo-summary.md   the digest an agent actually reads (small, dense)
 *
 * `--update` re-parses only files whose content hash changed.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, extname, dirname, basename } from 'node:path';
import { isMain } from './lib.mjs';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'bin', 'obj',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.idea', '.vscode', '.next', '.nuxt', '.gradle', '.terraform', 'coverage', '.tox',
  '.skills', '.mavis', 'site-packages', 'third_party', 'thirdparty',
]);
const LANGS = {
  '.py': 'python', '.pyi': 'python',
  '.ts': 'ts', '.tsx': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.java': 'java', '.go': 'go', '.c': 'c', '.h': 'c',
};

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

function walk(root, maxFiles, out = []) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        if (SKIP_DIRS.has(e.name)) continue;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(p);
      } else if (e.isFile()) {
        const lang = LANGS[extname(e.name)];
        if (!lang) continue;
        if (/\.(min|bundle)\.(js|ts)$/.test(e.name)) continue;
        if (out.length >= maxFiles) return out;
        out.push({ path: p, lang });
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------- parsers */

function firstDoc(text, lang) {
  if (lang === 'python') {
    const m = text.match(/^\s*(?:"""|''')([^\n"']{1,160})/);
    return m ? m[1].trim() : '';
  }
  const lines = text.split('\n').slice(0, 12);
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('//')) return t.replace(/^\/\/\s*/, '').replace(/^\*\s*/, '').slice(0, 160);
    if (t.startsWith('#')) return t.replace(/^#\s*/, '').slice(0, 160);
    if (t.startsWith('/*')) return t.replace(/^\/\*+/, '').replace(/\*+\/$/, '').replace(/^\*+\s*/, '').slice(0, 160);
    if (t.startsWith('package ')) continue;
    return '';
  }
  return '';
}

function parsePython(text, rel) {
  const id = rel.replace(/\.pyi?$/, '').replace(/\//g, '.').replace(/\.__init__$/, '');
  const symbols = [];
  const imports = [];
  for (const line of text.split('\n')) {
    let m;
    if ((m = line.match(/^\s*class\s+([A-Za-z_]\w*)/m))) symbols.push(m[1]);
    else if ((m = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/m))) symbols.push(m[1]);
    else if ((m = line.match(/^\s*from\s+([.\w]+)\s+import/m))) imports.push(m[1].replace(/^\.+/, ''));
    else if ((m = line.match(/^\s*import\s+([\w.]+)/m))) imports.push(m[1].split('.')[0]);
  }
  return { id, symbols: [...new Set(symbols)].slice(0, 12), imports: [...new Set(imports)].slice(0, 24), entry: /if\s+__name__\s*==\s*["']__main__["']/.test(text) };
}

function parseTs(text, rel) {
  const id = rel.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  const symbols = [];
  const imports = [];
  const re = /(?:^|\n)\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text))) symbols.push(m[2]);
  const impRe = /(?:import\s[^'"]*from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  while ((m = impRe.exec(text))) imports.push(m[1]);
  const entry = /\b(main|bootstrap|server|app|cli)\s*[:=]\s*(async\s*)?\(/.test(text) || /\bprocess\.argv\b/.test(text);
  return { id, symbols: [...new Set(symbols)].slice(0, 12), imports: [...new Set(imports)].slice(0, 24), entry };
}

function parseJava(text, rel) {
  const pkg = (text.match(/^\s*package\s+([\w.]+)\s*;/m) || [, ''])[1];
  const symbols = [];
  const imports = [];
  const re = /\b(class|interface|enum|record)\s+([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(text))) symbols.push(m[2]);
  const impRe = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm;
  while ((m = impRe.exec(text))) imports.push(m[1]);
  const cls = symbols[0] || basename(rel, '.java');
  const id = pkg ? `${pkg}.${cls}` : rel.replace(/\.java$/, '');
  return { id, symbols: [...new Set(symbols)].slice(0, 12), imports: [...new Set(imports)].slice(0, 24), entry: /public\s+static\s+void\s+main\s*\(/.test(text) };
}

function parseGo(text, rel) {
  const dir = rel.replace(/\.go$/, '').replace(/\/[^/]+$/, '') || 'main';
  const symbols = [];
  const imports = [];
  const re = /^(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/gm;
  let m;
  while ((m = re.exec(text))) symbols.push(m[1] || m[2]);
  const impBlock = text.match(/import\s*\(([\s\S]*?)\)/);
  if (impBlock) {
    for (const l of impBlock[1].split('\n')) {
      const mm = l.match(/["`]([^"`]+)["`]/);
      if (mm) imports.push(mm[1]);
    }
  }
  const single = text.match(/^import\s+(?:\w+\s+)?"([^"]+)"/m);
  if (single) imports.push(single[1]);
  return { id: dir, symbols: [...new Set(symbols)].slice(0, 12), imports: [...new Set(imports)].slice(0, 24), entry: /^func\s+main\s*\(/m.test(text) };
}

function parseC(text, rel) {
  const id = rel.replace(/\.(c|h)$/, '');
  const symbols = [];
  const imports = [];
  const re = /^(?:static\s+)?[\w*]+\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm;
  let m;
  while ((m = re.exec(text))) symbols.push(m[1]);
  const incRe = /#include\s*["<]([^">]+)[">]/g;
  while ((m = incRe.exec(text))) imports.push(m[1]);
  const structRe = /\bstruct\s+([A-Za-z_]\w*)/g;
  while ((m = structRe.exec(text))) symbols.push(m[1]);
  return { id, symbols: [...new Set(symbols)].slice(0, 12), imports: [...new Set(imports)].slice(0, 24), entry: /\bint\s+main\s*\(/.test(text) };
}

const PARSERS = { python: parsePython, ts: parseTs, java: parseJava, go: parseGo, c: parseC };

/* --------------------------------------------------------------- wiring */

/** URL-ish literals a file mentions — the seam between services. */
function extractPaths(text) {
  const out = new Set();
  const re = /['"`]((?:https?:\/\/[^'"`\s]+)|(\/[a-z0-9][a-z0-9\-._\/]{2,60}))['"`]/gi;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    if (!raw || raw.includes('//') && !raw.startsWith('http')) continue;
    if (raw.length < 4 || raw.length > 64) continue;
    if (!/^(\/|http)/.test(raw)) continue;
    const path = raw.replace(/^https?:\/\/[^/]+/, '') || '/';
    out.add(path);
  }
  return [...out];
}

const SERVER_MARKERS = /(add_route|route\(|HandleFunc|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|\.get\(['"]\/|\.post\(['"]\/|@app\.|app\.route|router\.|serve\(|ListenAndServe|http\.Handle)/;
const CLIENT_MARKERS = /(fetch\(|requests\.(get|post|put|delete)|axios\.|urlopen\(|http\.(get|post)|postJson\(|getJson\(|\.request\(|curl -)/;

/** Normalise a path to a comparable key: '/api/login' -> 'login'. */
function pathKey(p) {
  const segs = p.split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1].toLowerCase() : '';
}

/**
 * Cross-language wiring: a file that registers a path and a file that calls it
 * are related even when no import links them (Go gateway -> Python service).
 */
function inferWiring(files, parsed) {
  const servers = [];
  const clients = [];
  for (const f of files) {
    const p = parsed.get(f.path);
    if (!p) continue;
    const text = f.text;
    const paths = extractPaths(text);
    if (!paths.length) continue;
    if (SERVER_MARKERS.test(text)) servers.push({ id: p.id, path: f.path, paths });
    else if (CLIENT_MARKERS.test(text)) clients.push({ id: p.id, path: f.path, paths });
  }
  const edges = [];
  const seen = new Set();
  for (const c of clients) {
    for (const cp of c.paths) {
      const key = pathKey(cp);
      if (!key) continue;
      for (const sv of servers) {
        if (sv.id === c.id) continue;
        const hit = sv.paths.find((sp) => pathKey(sp) === key);
        if (!hit) continue;
        const k = `${c.id}->${sv.id}:${hit}`;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from: c.id, to: sv.id, via: hit, kind: 'http' });
        break;
      }
    }
  }
  return edges;
}

/* --------------------------------------------------------------- resolution */

function resolveImports(mod, modulesById, byPath) {
  const deps = new Set();
  for (const imp of mod.imports) {
    if (!imp) continue;
    if (mod.lang === 'python') {
      if (modulesById.has(imp)) deps.add(imp);
      else {
        for (const cand of modulesById.keys()) {
          if (cand === imp || cand.startsWith(imp + '.')) { deps.add(cand); break; }
        }
        // `from app.core import db` -> app.core.db (module import, not symbol import)
        const last = imp.split('.').pop();
        if (modulesById.has(`${imp}.${last}`)) deps.add(`${imp}.${last}`);
      }
    } else if (mod.lang === 'ts') {
      const clean = imp.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
      const candidates = [];
      if (clean.startsWith('.')) {
        const base = `${dirname(mod.path)}/${clean}`.replace(/\\/g, '/').replace(/\/\.\//g, '/');
        candidates.push(base, `${base}/index`);
      } else {
        candidates.push(clean, clean.replace(/^(@[^/]+\/[^/]+|[^/]+)\/?/, ''));
      }
      for (const cand of candidates) {
        for (const [id, path] of byPath) {
          const p = path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
          if (p === cand || p.endsWith('/' + cand)) { deps.add(id); break; }
        }
        if ([...deps].some((d) => d)) break;
      }
    } else if (mod.lang === 'java') {
      const pkg = imp.replace(/\.[A-Za-z_]\w*$/, '');
      for (const [id] of modulesById) {
        if (id.startsWith(pkg + '.')) { deps.add(id); break; }
      }
    } else if (mod.lang === 'go') {
      for (const [id] of modulesById) {
        if (imp.endsWith('/' + id) || imp === id) { deps.add(id); break; }
      }
    } else if (mod.lang === 'c') {
      const base = imp.replace(/\.h$/, '');
      for (const [id] of modulesById) {
        if (id.endsWith(base)) { deps.add(id); break; }
      }
    }
  }
  return [...deps].filter((d) => d !== mod.id);
}

/* --------------------------------------------------------------- main */

function buildIndex(root, outDir, maxFiles, prev) {
  const files = walk(root, maxFiles);
  const modules = [];
  const fileHashes = prev?.files ? { ...prev.files } : {};
  const fileTexts = new Map();
  let parsed = 0, reused = 0;

  for (const f of files) {
    const rel = relative(root, f.path);
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    const hash = sha1(text);
    const prevHash = fileHashes[rel];
    fileHashes[rel] = hash;
    if (prev && prevHash === hash) {
      const old = prev.modules?.find((m) => m.path === rel);
      if (old) {
        modules.push({ ...old, imports: old.imports || [] });
        fileTexts.set(f.path, text);
        reused++;
        continue;
      }
    }
    try {
      const parsedMod = PARSERS[f.lang](text, rel);
      fileTexts.set(f.path, text);
      modules.push({
        id: parsedMod.id, path: rel, lang: f.lang,
        symbols: parsedMod.symbols, imports: parsedMod.imports,
        entry: parsedMod.entry, doc: firstDoc(text, f.lang).slice(0, 160),
      });
      parsed++;
    } catch { /* skip unparsable file */ }
  }

  const modulesById = new Map();
  const byPath = new Map();
  for (const m of modules) {
    if (!modulesById.has(m.id)) modulesById.set(m.id, m);
    byPath.set(m.id, m.path);
  }
  const edges = [];
  const seenEdge = new Set();
  for (const m of modules) {
    m.deps = resolveImports(m, modulesById, byPath);
    for (const d of m.deps) {
      const key = `${m.id}->${d}`;
      if (!seenEdge.has(key)) { seenEdge.add(key); edges.push({ from: m.id, to: d }); }
    }
  }

  const langs = {};
  for (const m of modules) langs[m.lang] = (langs[m.lang] || 0) + 1;

  // cross-language wiring (server registers a path, client calls it)
  const wiring = inferWiring(
    files.map((f) => ({ path: relative(root, f.path), text: fileTexts.get(f.path) || '' })),
    new Map(modules.map((m) => [m.path, m])),
  );

  const index = {
    root, generated_at: new Date().toISOString(), languages: langs,
    modules: modules.map((m) => ({ id: m.id, path: m.path, lang: m.lang, symbols: m.symbols, deps: m.deps, entry: !!m.entry, doc: m.doc })),
    edges, wiring, files: fileHashes,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'repo-index.json'), JSON.stringify(index, null, 2), 'utf8');
  writeFileSync(join(outDir, 'repo-summary.md'), buildSummary(index), 'utf8');
  return { index, parsed, reused, total: modules.length };
}

function buildSummary(index) {
  const fanIn = new Map();
  for (const e of index.edges) fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1);
  const scored = index.modules
    .map((m) => ({ m, score: (m.entry ? 100 : 0) + (fanIn.get(m.id) || 0) * 3 + m.symbols.length }))
    .sort((a, b) => b.score - a.score);

  const L = [];
  L.push('# Repo index');
  L.push('');
  L.push(`generated: ${index.generated_at} · modules: ${index.modules.length} · edges: ${index.edges.length}`);
  L.push('');
  L.push('## Languages');
  for (const [l, n] of Object.entries(index.languages).sort((a, b) => b[1] - a[1])) L.push(`- ${l}: ${n}`);
  L.push('');

  const entries = index.modules.filter((m) => m.entry);
  if (entries.length) {
    L.push('## Entry points');
    for (const m of entries.slice(0, 20)) L.push(`- \`${m.path}\`${m.doc ? ` — ${m.doc}` : ''}`);
    L.push('');
  }

  L.push('## Modules (most depended-on first)');
  L.push('');
  L.push('| module | lang | symbols | deps | doc |');
  L.push('|---|---|---|---|---|');
  for (const { m } of scored.slice(0, 120)) {
    L.push(`| \`${m.id}\` | ${m.lang} | ${m.symbols.slice(0, 6).join(', ') || '—'} | ${m.deps.length} | ${(m.doc || '').replace(/\|/g, '/').slice(0, 80)} |`);
  }
  L.push('');

  L.push('## Internal dependencies');
  L.push('');
  for (const e of index.edges.slice(0, 200)) L.push(`- ${e.from} → ${e.to}`);
  if (index.edges.length > 200) L.push(`- … ${index.edges.length - 200} more (see repo-index.json)`);
  L.push('');

  if ((index.wiring || []).length) {
    L.push('## Inferred wiring (no import link — verify before drawing)');
    L.push('');
    for (const w of index.wiring) L.push(`- ${w.from} → ${w.to}  (${w.via})`);
    L.push('');
  }
  return L.join('\n');
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const root = flag('root', process.cwd());
  const outDir = flag('out', join(root, '.dd-fast'));
  const maxFiles = Number(flag('max-files', '4000'));
  if (!existsSync(root)) { console.error(`root not found: ${root}`); process.exit(2); }

  let prev = null;
  const idxPath = join(outDir, 'repo-index.json');
  if (args.includes('--update') && existsSync(idxPath)) {
    try { prev = JSON.parse(readFileSync(idxPath, 'utf8')); } catch { prev = null; }
  }
  const { index, parsed, reused } = buildIndex(root, outDir, maxFiles, prev);
  console.log(`indexed ${index.modules.length} modules (${parsed} parsed, ${reused} reused) → ${join(outDir, 'repo-summary.md')}`);
}
