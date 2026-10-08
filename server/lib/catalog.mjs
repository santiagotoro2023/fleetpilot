// FleetPilot: the catalog of everything a template can describe. Each setting type has a form
// (fields, which the web app draws) and turns its values into Ansible tasks (ansible.builtin only,
// so ansible-core is enough). The settings themselves live in catalog-settings.mjs and
// catalog-services.mjs; this file has the areas, the field rules and the task helpers.
import { httpError } from '../core/http.mjs';

// The areas of a desired state. Each has a signal color in the web app (src/css/app.css).
export const AREAS = [
  { id: 'system', title: 'System', text: 'Name, time, language, kernel and the basics every host needs.' },
  { id: 'network', title: 'Network', text: 'Addresses, VLANs, bonds, bridges, routes and name resolution.' },
  { id: 'access', title: 'Access', text: 'Users, passwords, keys, sudo and the SSH server.' },
  { id: 'services', title: 'Services', text: 'Ready-made services with their common options.' },
  { id: 'packages', title: 'Packages', text: 'Packages, repositories and automatic updates.' },
  { id: 'storage', title: 'Storage', text: 'Mounts, network shares, swap and log rotation.' },
  { id: 'security', title: 'Security', text: 'Firewall, hardening, intrusion prevention, certificates and auditing.' },
  { id: 'monitoring', title: 'Monitoring', text: 'Agents, exporters, SNMP and log forwarding.' },
  { id: 'schedules', title: 'Schedules', text: 'Cron jobs and systemd timers.' },
  { id: 'files', title: 'Files', text: 'Files, directories, lines in files and commands, for everything else.' }
];

// Variables a text may use; FleetPilot fills them per host. Nothing else may be templated: user
// text never reaches Ansible's template engine on the FleetPilot server.
export const VARIABLES = [
  ['fp_name', 'The host name in FleetPilot', 'web-01'],
  ['fp_fqdn', 'The full name (host name and domain)', 'web-01.example.com'],
  ['fp_domain', 'The domain (of the host or its subnet)', 'example.com'],
  ['fp_address', 'The address FleetPilot connects to', '10.20.0.11'],
  ['fp_ip', 'The address with prefix from IP management', '10.20.0.11/24'],
  ['fp_gateway', 'The gateway of the host\'s subnet', '10.20.0.1'],
  ['fp_group', 'The group of the host', 'Web servers'],
  ['fp_site', 'The site of the host', 'Datacenter 1']
];
const VAR_NAMES = new Set(VARIABLES.map(v => v[0]));

// ---------------------------------------------------------------- Field rules
const PATTERNS = {
  path: [/^\/[A-Za-z0-9._/@+=:,~-]*$/, 'an absolute path like /srv/data'],
  name: [/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, dots, dashes and underscores'],
  user: [/^[a-z_][a-z0-9_-]{0,31}\$?$/, 'a Linux user name: lowercase letters, digits, dashes, underscores'],
  host: [/^(\{\{ ?fp_[a-z]+ ?\}\}|[A-Za-z0-9*]([A-Za-z0-9*.-]{0,252}))(\.\{\{ ?fp_[a-z]+ ?\}\})?$/, 'a host name like www.example.com'],
  hostport: [/^[A-Za-z0-9.:[\]-]+:\d{1,5}$/, 'host:port like 10.0.0.5:8080'],
  ip: [/^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]{2,39})$/, 'an address like 10.0.0.1'],
  cidr: [/^([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]{2,39})\/\d{1,3}$/, 'a network like 10.0.0.0/24'],
  ipOrCidr: [/^(any|([0-9]{1,3}(\.[0-9]{1,3}){3}|[0-9A-Fa-f:]{2,39})(\/\d{1,3})?)$/, 'an address or network like 10.0.0.0/24, or any'],
  url: [/^(https?|ftp):\/\/[^\s"'<>\\]+$/, 'an address like https://example.com/file'],
  iface: [/^[A-Za-z0-9._@:-]{1,15}$/, 'an interface name like eth0 or ens18'],
  word: [/^[A-Za-z0-9._,:=+@%/-]*$/, 'letters, digits and . _ , : = + @ % / -'],
  octal: [/^0?[0-7]{3,4}$/, 'a mode like 0644'],
  duration: [/^\d+\s*([KMGTkmgt][Bb]?|s|min|h|d|w|m|month|months|year|years)?$/, 'a size or duration like 500M or 1month'],
  cron: [/^(@(reboot|hourly|daily|weekly|monthly|yearly)|(\S+\s+){4}\S+)$/, 'five fields like */15 * * * * or @daily'],
  any: [/^[^\n\r]*$/, 'one line']
};

/** Text that may reach Ansible: only the FleetPilot variables may be templated */
export function safeText(s, label = 'This text') {
  const t = String(s ?? '');
  if (/\{%|\{#/.test(t)) throw httpError(400, 'bad_value', `${label}: {% and {# cannot be used.`);
  for (const m of t.matchAll(/\{\{(.*?)\}\}/gs)) {
    const v = m[1].trim();
    if (!VAR_NAMES.has(v)) throw httpError(400, 'bad_value', `${label}: only these variables can be used: ${[...VAR_NAMES].map(n => `{{ ${n} }}`).join(', ')}.`);
  }
  if (/\{\{/.test(t.replace(/\{\{.*?\}\}/gs, ''))) throw httpError(400, 'bad_value', `${label}: an opened {{ is not closed.`);
  return t;
}

function coerce(f, v, label) {
  const name = `${label}: ${f.label}`;
  if (v === undefined || v === null || v === '') v = f.default ?? (f.type === 'lines' || f.type === 'rows' ? [] : f.type === 'bool' ? false : '');
  switch (f.type) {
    case 'bool': return v === true || v === 'true' || v === 1;
    case 'number': {
      if (v === '' && f.optional) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw httpError(400, 'bad_value', `${name}: a number, please.`);
      const [lo, hi] = f.range || [0, 1e9];
      if (n < lo || n > hi) throw httpError(400, 'bad_value', `${name}: from ${lo} to ${hi}.`);
      return Math.round(n);
    }
    case 'select': {
      const ok = f.options.map(o => o[0]);
      if (!ok.includes(v)) return f.default ?? ok[0];
      return v;
    }
    case 'lines': {
      const arr = (Array.isArray(v) ? v : String(v).split('\n')).map(x => String(x).trim()).filter(Boolean);
      if (arr.length > (f.max || 200)) throw httpError(400, 'bad_value', `${name}: at most ${f.max || 200} lines.`);
      return arr.map(x => check(f, x, name));
    }
    case 'rows': {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length > (f.max || 200)) throw httpError(400, 'bad_value', `${name}: at most ${f.max || 200} rows.`);
      return arr.map(r => Object.fromEntries(f.columns.map(c => [c.key, coerce(c, r?.[c.key], name)])))
        .filter(r => f.columns.some(c => c.required && r[c.key] !== '' && r[c.key] !== null));
    }
    case 'secret': {
      const s = String(v);
      if (s && !/^\d+$/.test(s)) throw httpError(400, 'bad_value', `${name}: choose an entry of the vault.`);
      return s;
    }
    case 'textarea': {
      const s = String(v);
      if (s.length > (f.maxLength || 65536)) throw httpError(400, 'bad_value', `${name}: too long.`);
      return f.raw ? s : safeText(s, name);
    }
    default: return check(f, String(v).trim(), name);
  }
}
function check(f, s, name) {
  if (s.length > (f.maxLength || 500)) throw httpError(400, 'bad_value', `${name}: too long.`);
  if (s === '') return s;
  const [re, what] = PATTERNS[f.pattern || 'any'];
  if (!re.test(s)) throw httpError(400, 'bad_value', `${name}: ${what}.`);
  return safeText(s, name);
}

/** The values of a setting, checked and completed with defaults */
export function normalizeValues(type, values = {}, { partial = false } = {}) {
  const out = {};
  for (const f of type.fields) out[f.key] = coerce(f, values?.[f.key], type.title);
  if (partial) return out;
  for (const f of type.fields) {
    if (f.required && (out[f.key] === '' || (Array.isArray(out[f.key]) && !out[f.key].length))) throw httpError(400, 'bad_value', `${type.title}: ${f.label} is needed.`);
  }
  return out;
}

// ---------------------------------------------------------------- Task helpers (ansible.builtin)
export const T = {
  apt: (names, state = 'present', name) => ({ name: name || `Install ${names.join(', ')}`, 'ansible.builtin.apt': { name: names, state, update_cache: true, cache_valid_time: 3600 } }),
  copy: (name, dest, content, o = {}) => ({
    name, 'ansible.builtin.copy': { dest, content, owner: o.owner || 'root', group: o.group || 'root', mode: o.mode || '0644', ...(o.validate ? { validate: o.validate } : {}) },
    ...(o.notify ? { notify: [].concat(o.notify) } : {}), ...(o.noLog ? { no_log: true } : {}), ...(o.when ? { when: o.when } : {})
  }),
  file: (name, args, o = {}) => ({ name, 'ansible.builtin.file': args, ...(o.notify ? { notify: [].concat(o.notify) } : {}), ...(o.when ? { when: o.when } : {}) }),
  line: (name, args, o = {}) => ({ name, 'ansible.builtin.lineinfile': args, ...(o.notify ? { notify: [].concat(o.notify) } : {}), ...(o.when ? { when: o.when } : {}) }),
  block: (name, args, o = {}) => ({ name, 'ansible.builtin.blockinfile': args, ...(o.notify ? { notify: [].concat(o.notify) } : {}), ...(o.when ? { when: o.when } : {}), ...(o.noLog ? { no_log: true } : {}) }),
  service: (unit, { state = 'started', enabled = true, name } = {}) => ({ name: name || `${state === 'stopped' ? 'Stop' : 'Start'} ${unit}${enabled ? ' and start it at boot' : ''}`, 'ansible.builtin.systemd': { name: unit, state, enabled } }),
  restart: unit => ({ name: `Restart ${unit}`, 'ansible.builtin.systemd': { name: unit, state: 'restarted', daemon_reload: true } }),
  reload: unit => ({ name: `Reload ${unit}`, 'ansible.builtin.systemd': { name: unit, state: 'reloaded' } }),
  cmd: (name, cmd, o = {}) => ({ name, 'ansible.builtin.command': { cmd, ...(o.creates ? { creates: o.creates } : {}) }, ...(o.changed === false ? { changed_when: false } : {}), ...(o.when ? { when: o.when } : {}), ...(o.register ? { register: o.register } : {}), ...(o.checkMode === false ? { check_mode: false } : {}) }),
  shell: (name, cmd, o = {}) => ({ name, 'ansible.builtin.shell': { cmd, ...(o.creates ? { creates: o.creates } : {}) }, ...(o.changed === false ? { changed_when: false } : o.changedWhen ? { changed_when: o.changedWhen } : {}), ...(o.when ? { when: o.when } : {}), ...(o.register ? { register: o.register } : {}), ...(o.checkMode === false ? { check_mode: false } : {}), ...(o.noLog ? { no_log: true } : {}) })
};

/** The lines of a config file: a header and the lines, with a final newline */
export const conf = (lines, comment = '#') => `${comment} Managed by FleetPilot: changes here are overwritten.\n${lines.filter(l => l !== null && l !== undefined).join('\n')}\n`;
export const quote = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

// Field builders, to keep the definitions short
export const F = {
  text: (key, label, o = {}) => ({ key, label, type: 'text', ...o }),
  area: (key, label, o = {}) => ({ key, label, type: 'textarea', ...o }),
  num: (key, label, def, range, o = {}) => ({ key, label, type: 'number', default: def, range, ...o }),
  bool: (key, label, def = false, o = {}) => ({ key, label, type: 'bool', default: def, ...o }),
  select: (key, label, options, o = {}) => ({ key, label, type: 'select', options, default: o.default ?? options[0][0], ...o }),
  lines: (key, label, o = {}) => ({ key, label, type: 'lines', ...o }),
  rows: (key, label, columns, o = {}) => ({ key, label, type: 'rows', columns, ...o }),
  secret: (key, label, kinds, o = {}) => ({ key, label, type: 'secret', kinds, ...o })
};
