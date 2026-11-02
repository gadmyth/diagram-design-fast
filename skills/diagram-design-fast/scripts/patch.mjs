/**
 * patch.mjs — semantic edits on a diagram spec. Never touches coordinates.
 *
 *   node patch.mjs --spec spec.json --op <op> [flags] [--dry-run]
 *
 * Every op mutates semantics only (labels, membership, edges, tokens).
 * Geometry is recomputed by layout.mjs, which reuses existing positions when
 * the node set is unchanged — that is what keeps a revision cheap.
 */
import { loadSpec, saveSpec, uniqueId, isMain } from './lib.mjs';

const OPS = {
  'set-title': (s, a) => { s.title = a.text ?? ''; return `title → "${s.title}"`; },
  'set-desc': (s, a) => { s.desc = a.text ?? ''; return `desc → "${s.desc}"`; },
  'set-eyebrow': (s, a) => { s.eyebrow = a.text ?? ''; return `eyebrow → "${s.eyebrow}"`; },
  'set-variant': (s, a) => { s.variant = a.variant; return `variant → ${s.variant}`; },
  'set-view': (s, a) => { s.view = a.view; return `view → ${s.view}`; },
  'set-dir': (s, a) => { s.dir = a.dir; return `dir → ${s.dir}`; },
  'set-token': (s, a) => { s.tokens = s.tokens || {}; s.tokens[a.name] = a.value; return `token ${a.name} → ${a.value}`; },
  'set-footer': (s, a) => { s.footer = a.text ?? ''; return `footer set`; },

  'retitle': (s, a) => {
    const n = s.nodes.find((x) => x.id === a.node);
    if (!n) throw new Error(`node "${a.node}" not found`);
    n.label = a.label ?? a.text ?? n.label;
    return `node "${a.node}" label → "${n.label}"`;
  },
  'setsub': (s, a) => {
    const n = s.nodes.find((x) => x.id === a.node);
    if (!n) throw new Error(`node "${a.node}" not found`);
    n.sub = a.text ?? '';
    return `node "${a.node}" sublabel → "${n.sub}"`;
  },
  'setkind': (s, a) => {
    const n = s.nodes.find((x) => x.id === a.node);
    if (!n) throw new Error(`node "${a.node}" not found`);
    n.kind = a.kind;
    return `node "${a.node}" kind → ${n.kind}`;
  },
  'accent': (s, a) => {
    const n = s.nodes.find((x) => x.id === a.node);
    if (!n) throw new Error(`node "${a.node}" not found`);
    n.accent = a.on === 'false' || a.off === 'true' ? false : true;
    return `node "${a.node}" accent → ${n.accent}`;
  },
  'move': (s, a) => {
    const n = s.nodes.find((x) => x.id === a.node);
    if (!n) throw new Error(`node "${a.node}" not found`);
    const g = a.group === 'none' || !a.group ? undefined : a.group;
    n.group = g;
    return `node "${a.node}" group → ${g ?? '(none)'}`;
  },
  'add-node': (s, a) => {
    const taken = new Set(s.nodes.map((n) => n.id));
    const id = a.id || uniqueId(String(a.label || 'node').toLowerCase().replace(/\W+/g, '-'), taken);
    if (s.nodes.some((n) => n.id === id)) throw new Error(`node "${id}" already exists`);
    s.nodes.push({ id, label: a.label ?? id, sub: a.sub ?? '', kind: a.kind ?? 'service', group: a.group, accent: a.accent === 'true' });
    return `added node "${id}"`;
  },
  'remove-node': (s, a) => {
    const before = s.nodes.length;
    s.nodes = s.nodes.filter((n) => n.id !== a.node);
    s.edges = s.edges.filter((e) => e.from !== a.node && e.to !== a.node);
    if (s.nodes.length === before) throw new Error(`node "${a.node}" not found`);
    return `removed node "${a.node}"`;
  },
  'add-edge': (s, a) => {
    const taken = new Set(s.edges.map((e) => e.id).filter(Boolean));
    const id = a.id || uniqueId(`e${s.edges.length + 1}`, taken);
    if (!s.nodes.some((n) => n.id === a.from)) throw new Error(`node "${a.from}" not found`);
    if (!s.nodes.some((n) => n.id === a.to)) throw new Error(`node "${a.to}" not found`);
    s.edges.push({ id, from: a.from, to: a.to, label: a.label ?? '', kind: a.kind ?? 'sync' });
    return `added edge "${id}" ${a.from} → ${a.to}`;
  },
  'remove-edge': (s, a) => {
    const before = s.edges.length;
    s.edges = s.edges.filter((e) => e.id !== a.edge);
    if (s.edges.length === before) throw new Error(`edge "${a.edge}" not found`);
    return `removed edge "${a.edge}"`;
  },
  'set-edge-label': (s, a) => {
    const e = s.edges.find((x) => x.id === a.edge);
    if (!e) throw new Error(`edge "${a.edge}" not found`);
    e.label = a.label ?? a.text ?? '';
    return `edge "${a.edge}" label → "${e.label}"`;
  },
  'set-edge-kind': (s, a) => {
    const e = s.edges.find((x) => x.id === a.edge);
    if (!e) throw new Error(`edge "${a.edge}" not found`);
    e.kind = a.kind;
    return `edge "${a.edge}" kind → ${e.kind}`;
  },
  'add-group': (s, a) => {
    s.groups = s.groups || [];
    if (!s.groups.some((g) => g.id === a.id)) s.groups.push({ id: a.id, label: a.label ?? a.id });
    return `group "${a.id}" ready`;
  },
  'remove-group': (s, a) => {
    s.groups = (s.groups || []).filter((g) => g.id !== a.id);
    for (const n of s.nodes) if (n.group === a.id) delete n.group;
    return `removed group "${a.id}"`;
  },
  'add-message': (s, a) => {
    s.messages = s.messages || [];
    const taken = new Set(s.messages.map((m) => m.id).filter(Boolean));
    const id = a.id || uniqueId(`m${s.messages.length + 1}`, taken);
    s.messages.push({ id, from: a.from, to: a.to, label: a.label ?? '', kind: a.kind ?? 'sync' });
    return `added message "${id}" ${a.from} → ${a.to}`;
  },
  'remove-message': (s, a) => {
    s.messages = (s.messages || []).filter((m) => m.id !== a.id);
    return `removed message "${a.id}"`;
  },
  'add-note': (s, a) => {
    s.notes = s.notes || [];
    s.notes.push({ id: a.id || `n${s.notes.length + 1}`, text: a.text ?? '', at: a.at });
    return `added note`;
  },
};

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, dflt = undefined) => {
    const i = args.indexOf(`--${name}`);
    if (i < 0) return dflt;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
  };
  if (args.includes('--list')) {
    console.log(Object.keys(OPS).join('\n'));
    process.exit(0);
  }
  const specFile = flag('spec');
  const op = flag('op');
  if (!specFile || !op) {
    console.error('usage: node patch.mjs --spec <spec.json> --op <op> [flags] [--dry-run]');
    console.error(`ops: ${Object.keys(OPS).join(', ')}`);
    process.exit(2);
  }
  if (!OPS[op]) {
    console.error(`unknown op "${op}". known: ${Object.keys(OPS).join(', ')}`);
    process.exit(2);
  }
  const spec = loadSpec(specFile);
  const a = {
    node: flag('node'), edge: flag('edge'), id: flag('id'), from: flag('from'), to: flag('to'),
    label: flag('label'), text: flag('text'), sub: flag('sub'), kind: flag('kind'), group: flag('group'),
    on: flag('on'), off: flag('off'), accent: flag('accent'), variant: flag('variant'), view: flag('view'),
    dir: flag('dir'), name: flag('name'), value: flag('value'), at: flag('at'),
  };
  try {
    const msg = OPS[op](spec, a);
    console.log(`${op}: ${msg}`);
    if (!args.includes('--dry-run')) {
      delete spec.reflow;
      saveSpec(specFile, spec);
    }
  } catch (e) {
    console.error(`patch failed: ${e.message}`);
    process.exit(1);
  }
}
