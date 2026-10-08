// FleetPilot: what every view shares. The API with error handling, the catalog and the rights of
// the signed-in user (meta), chips for states, small builders, dialogs, and the form renderer that
// draws every setting and step from the field definitions of the server.
import { h, toast } from './core/ui.js';
import { api } from './core/api.js';
import { authError } from './lib/auth.js';
import { I } from './icons.js';

export const main = document.querySelector('.main');
export const meta = { catalog: null, steps: null, access: null, version: '', ansible: null, vaultKinds: {} };

/** Loads what the web app needs once (after signing in) */
export async function loadMeta() {
  Object.assign(meta, await api.get('/api/meta'));
  meta.types = new Map(meta.catalog.types.map(t => [t.id, t]));
  meta.stepTypes = new Map(meta.steps.map(s => [s.id, s]));
  meta.areas = new Map(meta.catalog.areas.map(a => [a.id, a]));
}

/** May the user do this somewhere? (the server checks again, per group) */
export function can(area, level) {
  if (meta.access?.admin) return true;
  const levels = meta.access?.areas?.[area]?.levels || [];
  return levels.indexOf(meta.access?.rights?.[area] || 'none') >= levels.indexOf(level);
}

/** Calls the API; errors become a toast (a lapsed session shows the sign-in) */
export async function call(fn, { quiet = false } = {}) {
  try { return await fn(); }
  catch (e) { if (!authError(e) && !quiet) toast(e.message); throw e; }
}
export const get = path => call(() => api.get(path));

// ---------------------------------------------------------------- Formatting
export function when(t) {
  if (!t) return '–';
  const d = new Date(t), now = Date.now(), s = (now - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400 && new Date(now).getDate() === d.getDate()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
export function duration(a, b) {
  if (!a) return '';
  const s = Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`;
}
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- Chips and marks
const HOST_STATES = { new: ['New', 'idle'], taking_over: ['Taking over', 'busy'], managed: ['Managed', 'ok'], unreachable: ['Unreachable', 'bad'], failed: ['Take-over failed', 'bad'], retired: ['Retired', 'idle'] };
const RUN_STATES = {
  awaiting_approval: ['Waiting for approval', 'wait'], queued: ['Queued', 'busy'], running: ['Running', 'busy'], waiting: ['Waiting for approval', 'wait'],
  succeeded: ['Succeeded', 'ok'], partial: ['Partly failed', 'bad'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', 'idle'], rejected: ['Rejected', 'idle'],
  ok: ['OK', 'ok'], changed: ['Changed', 'ok'], unreachable: ['Unreachable', 'bad'], skipped: ['Skipped', 'idle'], pending: ['Pending', 'idle']
};
export const hostState = s => { const [t, k] = HOST_STATES[s] || [s, 'idle']; return h('span', { class: `fp-state ${k}` }, t); };
export const runState = s => { const [t, k] = RUN_STATES[s] || [s, 'idle']; return h('span', { class: `fp-state ${k}` }, t); };
export const runStateText = s => (RUN_STATES[s] || [s])[0];
/** Stripes in the colors of the areas a thing touches */
export const bands = areas => h('span', { class: 'fp-bands', 'aria-hidden': 'true' }, [...new Set(areas)].map(a => h('i', { class: `bg-${a}`, title: meta.areas?.get(a)?.title || a })));
export const chips = list => (list || []).map(t => h('span', { class: 'chip' }, t));

// ---------------------------------------------------------------- Builders
/** The head of a page: title, intro, and actions on the right (the primary one first) */
export function pageHead(title, intro, actions = []) {
  return h('div', { class: 'fp-head' },
    h('div', { class: 'grow' }, h('h1', {}, title), intro ? h('p', { class: 'muted fp-intro' }, intro) : null),
    actions.length ? h('div', { class: 'row fp-actions' }, actions) : null);
}
export const btn = (label, icon, onclick, cls = '') => h('button', { class: `btn ${cls}`.trim(), type: 'button', onclick, html: (icon ? I[icon] : '') + `<span>${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>` });
export const link = (label, href, icon, cls = '') => h('a', { class: `btn ${cls}`.trim(), href, html: (icon ? I[icon] : '') + `<span>${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>` });

/** Tabs with role=tablist; onChange(id) draws the panel; the choice is remembered per key */
export function tabs(list, current, onChange, { sub = true } = {}) {
  const el = h('div', { class: `tabs${sub ? ' subtabs' : ''}`, role: 'tablist' });
  const draw = cur => {
    el.innerHTML = '';
    for (const [id, label] of list) {
      el.append(h('button', { type: 'button', role: 'tab', class: id === cur ? 'cur' : '', 'aria-selected': id === cur ? 'true' : 'false', onclick: () => { draw(id); onChange(id); } }, label));
    }
  };
  draw(current);
  return el;
}

/** A dialog: title, body nodes, buttons; resolves with what onOk returns (or null when closed) */
export function dialog(title, body, { ok = 'Save', okClass = 'primary', onOk, cancel = 'Cancel', wide = false } = {}) {
  return new Promise(resolve => {
    const dlg = h('dialog', { class: `dlg${wide ? ' fp-wide' : ''}` });
    const close = v => { dlg.close(); dlg.remove(); resolve(v); };
    const okBtn = onOk ? h('button', { class: `btn ${okClass}`, type: 'submit' }, ok) : null;
    const form = h('form', { onsubmit: async e => {
      e.preventDefault();
      if (!onOk) return close(true);
      okBtn.disabled = true;
      try { const v = await onOk(); if (v !== false) close(v ?? true); } catch (err) { if (!authError(err)) toast(err.message); }
      okBtn.disabled = false;
    } }, h('h3', {}, title), h('div', { class: 'fp-dlg-body' }, body),
    h('div', { class: 'row', style: { marginTop: '14px' } }, okBtn, h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, onOk ? cancel : 'Close')));
    dlg.append(form);
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(null); });
    document.body.append(dlg);
    dlg.showModal();
    const first = form.querySelector('input:not([type=checkbox]), select, textarea');
    if (first) first.focus();
  });
}

export const field = (label, input, help) => h('label', { class: 'field' }, label, input, help ? h('span', { class: 'fp-help' }, help) : null);
export const input = (attrs = {}) => h('input', { class: `input${attrs.mono ? ' mono' : ''}`, spellcheck: 'false', ...attrs, mono: undefined });
export function select(options, value, attrs = {}) {
  return h('select', { class: 'input', ...attrs }, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
}
export const empty = text => h('p', { class: 'empty' }, text);

/** A table with a head; rows are arrays of cells (nodes or text) */
export function table(head, rows, { cls = '' } = {}) {
  return h('div', { class: 'fp-tablewrap' }, h('table', { class: `tbl fp-table ${cls}`.trim() },
    h('thead', {}, h('tr', {}, head.map(c => h('th', {}, c)))),
    h('tbody', {}, rows)));
}

// ---------------------------------------------------------------- Sources of choices (groups, pools, templates, vault)
const cache = new Map();
export async function choices(source) {
  if (cache.has(source) && Date.now() - cache.get(source).at < 15000) return cache.get(source).list;
  let list = [];
  if (source === 'groups') list = await groupOptions();
  if (source === 'pools') list = (await api.get('/api/network/pools')).map(p => [p.id, `${p.name} (${p.first} to ${p.last}, ${p.cidr})`]);
  if (source === 'templates') list = (await api.get('/api/templates')).filter(t => !t.archived).map(t => [t.id, t.name]);
  if (source.startsWith('vault:')) {
    const kinds = source.slice(6).split(',');
    list = can('vault', 'view') ? (await api.get('/api/vault')).filter(s => kinds.includes(s.kind) && ['global', 'group'].includes(s.scope)).map(s => [s.id, `${s.name}${s.username ? ` (${s.username})` : ''}`]) : [];
  }
  cache.set(source, { at: Date.now(), list });
  return list;
}
export const forgetChoices = () => cache.clear();
/** "Site / Group / Subgroup" for every group */
export async function groupOptions() {
  const groupList = await api.get('/api/groups');
  const by = new Map(groupList.map(g => [g.id, g]));
  const path = g => { const out = []; let x = g; const seen = new Set(); while (x && !seen.has(x.id)) { seen.add(x.id); out.unshift(x.name); x = by.get(x.parent_id); } return out.join(' / '); };
  return groupList.map(g => [g.id, path(g)]).sort((a, b) => a[1].localeCompare(b[1]));
}

// ---------------------------------------------------------------- The form renderer
const PATTERN_INPUT = { path: 'mono', cidr: 'mono', ip: 'mono', ipOrCidr: 'mono', url: 'mono', iface: 'mono', octal: 'mono', cron: 'mono', hostport: 'mono', word: 'mono', duration: 'mono', user: 'mono', host: 'mono' };

/**
 * Draws fields from the server's definitions into a container.
 * values: the current values (changed in place), onChange(values) after every change.
 * Fields with `when` show only when other values match; `source` fields offer choices.
 */
export function renderFields(fields, values, onChange, { readOnly = false } = {}) {
  const wrap = h('div', { class: 'fp-fields' });
  const changed = () => { refreshWhen(); onChange?.(values); };
  const rows = [];
  for (const f of fields) {
    if (!(f.key in values)) values[f.key] = f.default ?? (f.type === 'lines' || f.type === 'rows' ? [] : f.type === 'bool' ? false : '');
    const el = fieldEl(f, values, changed, readOnly);
    rows.push([f, el]);
    wrap.append(el);
  }
  function refreshWhen() {
    for (const [f, el] of rows) {
      if (!f.when) continue;
      const ok = Object.entries(f.when).every(([k, v]) => [].concat(v).includes(values[k]));
      el.classList.toggle('hidden', !ok);
    }
  }
  refreshWhen();
  return wrap;
}

function fieldEl(f, values, changed, ro) {
  const set = v => { values[f.key] = v; changed(); };
  const help = f.help ? h('span', { class: 'fp-help' }, f.help) : null;
  if (f.type === 'bool') {
    return h('label', { class: 'row small fp-check' }, h('input', { type: 'checkbox', checked: !!values[f.key], disabled: ro, onchange: e => set(e.target.checked) }), f.label);
  }
  if (f.type === 'rows') return rowsEl(f, values, changed, ro);
  let control;
  if (f.source || f.type === 'secret') {
    const src = f.source || `vault:${(f.kinds || ['login']).join(',')}`;
    const multi = f.type === 'lines';
    control = h('select', { class: 'input', disabled: ro, multiple: multi || undefined, size: multi ? 5 : undefined, onchange: e => set(multi ? [...e.target.selectedOptions].map(o => o.value) : e.target.value) });
    const cur = values[f.key];
    control.append(h('option', { value: '' }, multi ? '' : 'Choose…'));
    choices(src).then(list => {
      control.innerHTML = '';
      if (!multi) control.append(h('option', { value: '' }, list.length ? 'Choose…' : src.startsWith('vault') ? 'Nothing in the vault yet' : 'Nothing to choose yet'));
      for (const [v, t] of list) control.append(h('option', { value: v, selected: multi ? (cur || []).map(String).includes(String(v)) : String(v) === String(cur) }, t));
    }).catch(() => {});
  } else if (f.type === 'select') {
    control = select(f.options, values[f.key], { disabled: ro, onchange: e => set(e.target.value) });
  } else if (f.type === 'number') {
    control = h('input', { class: 'input mono fp-num', type: 'number', value: values[f.key] ?? '', min: f.range?.[0], max: f.range?.[1], disabled: ro, oninput: e => set(e.target.value === '' ? '' : Number(e.target.value)) });
  } else if (f.type === 'textarea') {
    control = h('textarea', { class: 'input mono fp-area', rows: 4, spellcheck: 'false', placeholder: f.placeholder || '', disabled: ro, oninput: e => set(e.target.value) });
    control.value = values[f.key] || '';
  } else if (f.type === 'lines') {
    control = h('textarea', { class: 'input mono fp-area', rows: Math.max(2, Math.min(6, (values[f.key] || []).length + 1)), spellcheck: 'false', placeholder: f.placeholder || 'One per line', disabled: ro, oninput: e => set(e.target.value.split('\n').map(s => s.trim()).filter(Boolean)) });
    control.value = (values[f.key] || []).join('\n');
  } else {
    control = h('input', { class: `input ${PATTERN_INPUT[f.pattern] || ''}`.trim(), value: values[f.key] ?? '', placeholder: f.placeholder || '', spellcheck: 'false', disabled: ro, oninput: e => set(e.target.value) });
  }
  return h('label', { class: `field${f.type === 'textarea' || f.type === 'lines' ? ' fp-wide-field' : ''}` }, f.label + (f.required ? '' : ''), control, help);
}

function rowsEl(f, values, changed, ro) {
  const box = h('div', { class: 'fp-rows' });
  const list = values[f.key] = Array.isArray(values[f.key]) ? values[f.key] : [];
  const draw = () => {
    box.innerHTML = '';
    box.append(h('div', { class: 'fp-rows-head small muted' }, f.label));
    if (!list.length) box.append(empty('None yet.'));
    list.forEach((row, i) => {
      for (const c of f.columns) if (!(c.key in row)) row[c.key] = c.default ?? (c.type === 'bool' ? false : '');
      const cells = renderFields(f.columns, row, () => changed(), { readOnly: ro });
      box.append(h('div', { class: 'item fp-row' }, cells, ro ? null : h('button', { class: 'btn icon ghost fp-row-del', type: 'button', title: 'Remove this row', 'aria-label': 'Remove this row', html: I.trash, onclick: () => { list.splice(i, 1); draw(); changed(); } })));
    });
    if (!ro) box.append(h('button', { class: 'btn ghost fp-row-add', type: 'button', html: I.plus + 'Add a row', onclick: () => { list.push({}); draw(); changed(); box.querySelector('.fp-row:last-of-type input, .fp-row:last-of-type select')?.focus(); } }));
  };
  draw();
  return box;
}
