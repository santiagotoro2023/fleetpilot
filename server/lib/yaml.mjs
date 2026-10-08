// FleetPilot: writes YAML for the generated playbooks and inventories. Only what JSON has
// (objects, arrays, strings, numbers, booleans, null), always readable and always valid.

const PLAIN = /^[A-Za-z_/][A-Za-z0-9_ ./:@-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  const s = String(v);
  if (s === '') return "''";
  // Plain when it cannot be read as anything else; Jinja ({{ }}) and specials are quoted
  if (PLAIN.test(s) && !RESERVED.test(s) && !/[:#]\s|\s$|^\s|: |#/.test(s) && !/^\d/.test(s)) return s;
  return JSON.stringify(s);
}

function key(k) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
}

function block(s, indent) {
  // Multi-line text as a literal block, kept exactly (with or without the final newline)
  const chomp = s.endsWith('\n') ? (s.endsWith('\n\n') ? '+' : '') : '-';
  const body = s.replace(/\n$/, '').split('\n').map(l => (l ? ' '.repeat(indent) + l : '')).join('\n');
  return `|${chomp}\n${body}`;
}

function emit(v, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return '\n' + v.map(x => {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length && !isUnsafe(x)) {
        const inner = emitObject(x, indent + 2);
        return `${pad}- ${inner.slice(indent + 2)}`;
      }
      return `${pad}- ${value(x, indent + 2)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') return Object.keys(v).length ? '\n' + emitObject(v, indent) : '{}';
  return value(v, indent);
}
// { __unsafe: text }: Ansible must not template this text (!unsafe)
const isUnsafe = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '__unsafe' in v;
function value(v, indent) {
  if (isUnsafe(v)) return '!unsafe ' + value(String(v.__unsafe), indent);
  if (typeof v === 'string' && v.includes('\n')) return block(v, indent);
  if (v && typeof v === 'object') return emit(v, indent);
  return scalar(v);
}
function emitObject(o, indent) {
  const pad = ' '.repeat(indent);
  return Object.entries(o).filter(([, x]) => x !== undefined).map(([k, x]) => {
    const out = x && typeof x === 'object' && !isUnsafe(x) ? emit(x, indent + 2) : value(x, indent + 2);
    return `${pad}${key(k)}:${out.startsWith('\n') ? '' : ' '}${out}`;
  }).join('\n');
}

/** YAML text of a value (a document) */
export function toYaml(v) {
  const out = Array.isArray(v) ? emit(v, 0).replace(/^\n/, '') : v && typeof v === 'object' ? emitObject(v, 0) : scalar(v);
  return out + '\n';
}
