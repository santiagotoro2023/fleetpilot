// FleetPilot: hosts. The map (sites and groups as areas, hosts as cards you drag between them), the
// table (search, filters, many at once), the Proxmox sources, a host's page and a group's page.
import { h, toast, contextMenu, iconBtn } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { confirmFresh } from '../lib/auth.js';
import { main, meta, get, call, can, pageHead, btn, link, tabs, dialog, field, input, select, table, empty, hostState, runState, when, plural, bands, chips, groupOptions, forgetChoices } from '../common.js';

const pref = (ctx, k, d) => ctx.store.prefs[k] ?? d;

// ---------------------------------------------------------------- Shared dialogs
/** Starts a workflow on hosts: choose it, see whether it waits for an approval, go to the run */
export async function runDialog(hostIds, { kind } = {}) {
  const all = await get('/api/workflows');
  const hosts = (await get('/api/hosts')).filter(x => hostIds.includes(x.id));
  const managed = hosts.filter(x => x.state === 'managed' || x.state === 'unreachable').length;
  const wanted = kind || (managed === hosts.length ? 'maintain' : managed === 0 ? 'takeover' : null);
  const list = all.filter(w => w.enabled && (!wanted || w.kind === wanted) && w.builtin !== 'push');
  if (!list.length) { toast('There is no workflow for these hosts yet. Make one under Automate.'); return; }
  const wf = select(list.map(w => [w.id, `${w.name}${w.kind === 'takeover' ? ' (take-over)' : ''}`]), list[0].id);
  const info = h('div', { class: 'small muted fp-steps-preview' });
  const showSteps = () => { const w = list.find(x => x.id === wf.value); info.innerHTML = ''; info.append(h('ol', {}, w.steps.map(s => h('li', {}, s.sentence)))); };
  wf.addEventListener('change', showSteps); showSteps();
  const check = h('input', { type: 'checkbox' });
  const body = [
    h('p', { class: 'small' }, hosts.length === 1 ? `On ${hosts[0].name}.` : `On ${plural(hosts.length, 'host', 'hosts')}: ${hosts.slice(0, 6).map(x => x.name).join(', ')}${hosts.length > 6 ? ', …' : ''}.`),
    field('Workflow', wf), info,
    meta.access.needsApproval ? h('p', { class: 'small fp-note' }, 'Your runs wait for an approval by someone else before they start.') : null,
    managed !== hosts.length && managed ? h('p', { class: 'small fp-note' }, 'Some of these hosts are not taken over yet, others are: each workflow runs only on the hosts it is for and skips the others.') : null
  ];
  const r = await dialog('Run a workflow', body, { ok: 'Start the run', onOk: () => call(() => api.post(`/api/workflows/${wf.value}/run`, { hostIds, checkOnly: check.checked })) });
  if (r?.id) location.hash = `#/runs/${r.id}`;
}

/** Adds hosts: one, a list, a range or a CSV file, into a group, optionally taken over right away */
export async function addHostsDialog(defaultGroup = '') {
  const groups = await groupOptions();
  const workflows = (await get('/api/workflows')).filter(w => w.kind === 'takeover' && w.enabled);
  let mode = 'one';
  const one = { name: input({ placeholder: 'web-01' }), address: input({ mono: true, placeholder: '10.20.0.11 or web-01.example.com' }), port: input({ mono: true, value: '22', type: 'number', min: 1, max: 65535, style: { width: '90px' } }) };
  const listArea = h('textarea', { class: 'input mono fp-area', rows: 6, placeholder: 'web-01 10.20.0.11\nweb-02 10.20.0.12 2222\n10.20.0.13', spellcheck: 'false' });
  const range = { from: input({ mono: true, placeholder: '10.20.0.21' }), to: input({ mono: true, placeholder: '10.20.0.30' }), pattern: input({ placeholder: 'app-{n}', value: 'host-{n}' }), start: input({ mono: true, type: 'number', value: '1', style: { width: '90px' } }) };
  const csv = h('textarea', { class: 'input mono fp-area', rows: 6, placeholder: 'name,address,port,tags\nweb-01,10.20.0.11,22,web;debian', spellcheck: 'false' });
  const panes = {
    one: h('div', { class: 'fp-form' }, h('div', { class: 'fp-grid3' }, field('Name', one.name, 'Empty: the first part of the address.'), field('Address', one.address), field('SSH port', one.port))),
    list: h('div', { class: 'fp-form' }, field('One host per line: name and address, or only the address; a port at the end if not 22', listArea)),
    range: h('div', { class: 'fp-form' }, h('div', { class: 'fp-grid3' }, field('From', range.from), field('To', range.to), field('First number', range.start)), field('Names', range.pattern, '{n} becomes the number: 01, 02, …')),
    csv: h('div', { class: 'fp-form' }, field('Columns name, address, port, tags (tags separated by ;)', csv), h('button', { class: 'btn ghost', type: 'button', html: I.upload + 'Read a CSV file', onclick: async () => { const t = await pickText('.csv,text/csv'); if (t) csv.value = t; } }))
  };
  const holder = h('div', {}, panes.one);
  const tabsEl = tabs([['one', 'One'], ['list', 'A list'], ['range', 'A range'], ['csv', 'A CSV file']], 'one', id => { mode = id; holder.innerHTML = ''; holder.append(panes[id]); });
  const group = select([['', 'No group'], ...groups], defaultGroup);
  const tags = input({ placeholder: 'debian, web' });
  const wf = select([['', 'Not now: add them only'], ...workflows.map(w => [w.id, w.name])], '');
  const parse = () => {
    if (mode === 'one') return [{ name: one.name.value.trim(), address: one.address.value.trim(), port: Number(one.port.value) || 22 }];
    if (mode === 'list') return listArea.value.split('\n').map(l => l.trim().split(/[\s,;]+/)).filter(p => p[0]).map(p => (p.length === 1 ? { address: p[0] } : /^\d+$/.test(p[1] || '') ? { address: p[0], port: Number(p[1]) } : { name: p[0], address: p[1], port: Number(p[2]) || 22 }));
    if (mode === 'range') {
      const ip = s => s.trim().split('.').map(Number);
      const a = ip(range.from.value), b = ip(range.to.value);
      if (a.length !== 4 || b.length !== 4 || a.some(isNaN) || b.some(isNaN)) throw new Error('Give a range of IPv4 addresses, like 10.20.0.21 to 10.20.0.30.');
      const toN = x => ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3];
      const na = toN(a), nb = toN(b);
      if (nb < na || nb - na > 999) throw new Error('A range has 1 to 1000 addresses, from the lower to the higher one.');
      const width = String(Number(range.start.value) + (nb - na)).length < 2 ? 2 : String(Number(range.start.value) + (nb - na)).length;
      const out = [];
      for (let n = na, i = Number(range.start.value) || 1; n <= nb; n++, i++) out.push({ name: range.pattern.value.replace('{n}', String(i).padStart(width, '0')), address: [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.') });
      return out;
    }
    const rows = csv.value.split('\n').map(l => l.trim()).filter(Boolean);
    const head = rows[0].toLowerCase().includes('address') ? rows.shift().toLowerCase().split(',').map(s => s.trim()) : ['name', 'address', 'port', 'tags'];
    return rows.map(r => { const c = r.split(','), o = Object.fromEntries(head.map((k, i) => [k, (c[i] || '').trim()])); return { name: o.name, address: o.address || o.ip, port: Number(o.port) || 22, tags: (o.tags || '').split(';').map(s => s.trim()).filter(Boolean) }; });
  };
  const r = await dialog('Add hosts', [tabsEl, holder, h('div', { class: 'fp-grid2', style: { marginTop: '12px' } }, field('Into the group', group), field('Tags', tags, 'Separated by commas.')),
    field('Take them over right away with', wf, 'The take-over logs in with the password of your installation and makes FleetPilot the manager.')], {
    ok: 'Add hosts', wide: true,
    onOk: async () => {
      const hosts = parse();
      if (!hosts.length) throw new Error('Name at least one host.');
      return call(() => api.post('/api/hosts', { hosts, groupId: group.value || null, tags: tags.value, workflowId: wf.value || null }));
    }
  });
  if (!r) return null;
  toast(`${plural(r.added.length, 'host', 'hosts')} added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
  if (r.skipped.length) await dialog('Not added', [table(['Host', 'Why'], r.skipped.map(s => h('tr', {}, h('td', {}, s.name || s.address), h('td', {}, s.why))))]);
  if (r.run) location.hash = `#/runs/${r.run}`;
  return r;
}

function pickText(accept) {
  return new Promise(res => { const i = h('input', { type: 'file', accept }); i.onchange = async () => res(i.files[0] ? await i.files[0].text() : null); i.click(); });
}

// ---------------------------------------------------------------- Hosts: map, table, sources
export async function viewHosts(ctx) {
  document.title = 'Hosts';
  const tab = ctx.query.tab || pref(ctx, 'hosts.tab', 'map');
  const page = h('div', { class: 'page fp-page-wide' });
  page.append(pageHead('Hosts', 'Every host, in its site and group. Drag hosts between groups, or work on many at once in the table.', [
    can('hosts', 'manage') ? btn('Add hosts', 'plus', async () => { if (await addHostsDialog()) ctx.rerender(); }, 'primary') : null,
    can('hosts', 'manage') ? btn('Add a site', 'group', () => groupDialog(ctx, null, 'site')) : null
  ].filter(Boolean)));
  const body = h('div', {});
  page.append(tabs([['map', 'Map'], ['table', 'Table'], ['sources', 'Proxmox']], tab, id => { ctx.store.setPref('hosts.tab', id); draw(id); }), body);
  main.append(page);
  const draw = async id => {
    body.innerHTML = '';
    if (id === 'map') await drawMap(ctx, body);
    else if (id === 'table') await drawTable(ctx, body);
    else await drawSources(ctx, body);
  };
  await draw(tab);
  if (ctx.query.add && can('hosts', 'manage')) { history.replaceState(null, '', '#/hosts'); if (await addHostsDialog()) ctx.rerender(); }
}

async function groupDialog(ctx, parentId, kind = 'group', g = null) {
  const name = input({ value: g?.name || '', placeholder: kind === 'site' ? 'Datacenter 1' : 'Web servers' });
  const desc = input({ value: g?.description || '', placeholder: 'What belongs here' });
  const r = await dialog(g ? `Change ${g.name}` : kind === 'site' ? 'Add a site' : 'Add a group', [field('Name', name), field('Description', desc)], {
    ok: g ? 'Save' : 'Add', onOk: () => call(() => g ? api.patch(`/api/groups/${g.id}`, { name: name.value, description: desc.value }) : api.post('/api/groups', { name: name.value, description: desc.value, kind, parentId: parentId || null }))
  });
  if (r) { forgetChoices(); ctx.rerender(); }
}

async function drawMap(ctx, body) {
  const [groups, hosts] = await Promise.all([get('/api/groups'), get('/api/hosts')]);
  const kids = new Map(), byGroup = new Map();
  for (const g of groups) { const k = g.parent_id || ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(g); }
  for (const x of hosts) { const k = x.group_id || ''; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k).push(x); }
  const filter = input({ type: 'search', placeholder: 'Find a host: name, address, OS or tag', 'aria-label': 'Find a host', class: 'input fp-find' });
  const canvas = h('div', { class: 'canvas-wrap fp-map' });
  const mayMove = can('hosts', 'change');
  let dragging = null;
  const drop = (el, groupId) => {
    el.addEventListener('dragover', e => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); el.classList.add('fp-drop'); });
    el.addEventListener('dragleave', e => { e.stopPropagation(); el.classList.remove('fp-drop'); });
    el.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('fp-drop');
      const d = dragging; dragging = null;
      if (!d) return;
      try {
        if (d.type === 'host') { if (d.from === groupId) return; await call(() => api.patch(`/api/hosts/${d.id}`, { groupId: groupId || null })); toast(`${d.name} moved`); }
        else { if (d.id === groupId) return; await call(() => api.patch(`/api/groups/${d.id}`, { parentId: groupId || null })); toast(`${d.name} moved`); forgetChoices(); }
        ctx.rerender();
      } catch { /* shown */ }
    });
  };
  const hostCard = x => {
    const el = h('a', { class: `fp-hostcard st-${x.state}`, href: `#/hosts/${x.id}`, draggable: mayMove ? 'true' : undefined, 'data-find': `${x.name} ${x.address} ${x.os} ${(x.tags || []).join(' ')}`.toLowerCase(), title: `${x.name} · ${x.address}` },
      h('span', { class: 'fp-dot', 'aria-hidden': 'true' }), h('span', { class: 'fp-hc-name' }, x.name), h('span', { class: 'fp-hc-addr' }, x.address),
      (x.drift?.changed ? h('span', { class: 'fp-hc-drift', title: `${x.drift.changed} differences from the desired state` }, `${x.drift.changed}`) : null));
    el.addEventListener('dragstart', e => { dragging = { type: 'host', id: x.id, name: x.name, from: x.group_id || '' }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', x.name); });
    el.addEventListener('contextmenu', e => contextMenu(e, [
      { label: 'Open', icon: I.right, onClick: () => { location.hash = `#/hosts/${x.id}`; } },
      ...(can('runs', 'run') ? [{ label: 'Run a workflow', icon: I.play, onClick: () => runDialog([x.id]) }] : []),
      ...(can('hosts', 'manage') ? ['-', { label: `Remove ${x.name}`, icon: I.trash, danger: true, onClick: () => removeHosts(ctx, [x]) }] : [])
    ], x.name));
    return el;
  };
  const zone = (g, depth) => {
    const list = byGroup.get(g.id) || [];
    const inner = kids.get(g.id) || [];
    const total = countIn(g.id);
    const head = h('div', { class: 'fp-zone-head', draggable: can('hosts', 'manage') ? 'true' : undefined },
      h('a', { class: 'fp-zone-name', href: `#/hosts/group/${g.id}` }, g.name), h('span', { class: 'fp-zone-meta' }, `${g.kind === 'site' ? 'Site · ' : ''}${plural(total, 'host', 'hosts')}`),
      (g.templates || []).length ? h('span', { class: 'fp-zone-meta', title: g.templates.map(t => t.name).join(', ') }, `· ${plural(g.templates.length, 'template', 'templates')}`) : null,
      h('span', { class: 'grow' }),
      can('hosts', 'manage') ? iconBtn(I.plus, `Add a group inside ${g.name}`, e => { e.preventDefault(); groupDialog(ctx, g.id); }) : null);
    head.addEventListener('dragstart', e => { e.stopPropagation(); dragging = { type: 'group', id: g.id, name: g.name }; e.dataTransfer.setData('text/plain', g.name); });
    const el = h('section', { class: `fp-zone ${g.kind === 'site' ? 'fp-site' : ''} d${Math.min(depth, 3)}` }, head,
      list.length ? h('div', { class: 'fp-cards' }, list.map(hostCard)) : null,
      inner.length ? h('div', { class: 'fp-zones' }, inner.map(c => zone(c, depth + 1))) : null,
      !list.length && !inner.length ? h('p', { class: 'fp-zone-empty' }, mayMove ? 'Empty. Drag hosts here.' : 'Empty.') : null);
    drop(el, g.id);
    return el;
  };
  const countIn = id => (byGroup.get(id) || []).length + (kids.get(id) || []).reduce((n, c) => n + countIn(c.id), 0);
  const roots = kids.get('') || [];
  const loose = byGroup.get('') || [];
  if (!roots.length && !loose.length) {
    canvas.append(h('div', { class: 'fp-map-empty' }, h('p', {}, 'No hosts and no sites yet.'), can('hosts', 'manage') ? h('div', { class: 'row' }, btn('Add a site', 'group', () => groupDialog(ctx, null, 'site')), btn('Add hosts', 'plus', async () => { if (await addHostsDialog()) ctx.rerender(); }, 'primary')) : null));
  } else {
    const wrap = h('div', { class: 'fp-zones fp-top' }, roots.map(g => zone(g, 0)));
    if (loose.length || mayMove) {
      const lz = h('section', { class: 'fp-zone fp-loose' }, h('div', { class: 'fp-zone-head' }, h('span', { class: 'fp-zone-name' }, 'Without a group'), h('span', { class: 'fp-zone-meta' }, plural(loose.length, 'host', 'hosts'))),
        loose.length ? h('div', { class: 'fp-cards' }, loose.map(hostCard)) : h('p', { class: 'fp-zone-empty' }, 'Drag hosts here to take them out of their group.'));
      drop(lz, '');
      wrap.append(lz);
    }
    canvas.append(wrap);
  }
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    canvas.querySelectorAll('.fp-hostcard').forEach(c => c.classList.toggle('fp-dim', !!q && !c.dataset.find.includes(q)));
  });
  body.append(h('div', { class: 'row fp-toolbar' }, filter, h('span', { class: 'small muted' }, `${plural(hosts.length, 'host', 'hosts')} in ${plural(groups.length, 'group', 'groups')}`), h('span', { class: 'grow' }),
    h('span', { class: 'fp-legend small' }, ['managed', 'new', 'taking_over', 'unreachable'].map(s => h('span', { class: `st-${s}` }, h('span', { class: 'fp-dot' }), ({ managed: 'Managed', new: 'Not taken over', taking_over: 'Taking over', unreachable: 'Unreachable or failed' })[s])))), canvas,
  mayMove ? h('p', { class: 'small muted fp-maphint' }, 'Drag a host onto a group to move it. Drag a group by its name to put it inside another. Right-click a host for more.') : null);
}

async function removeHosts(ctx, list) {
  if (!confirm(`Remove ${list.length === 1 ? list[0].name : plural(list.length, 'host', 'hosts')} from FleetPilot? The hosts themselves are not touched. Their passwords and keys stay in the vault, named after them.`)) return;
  await call(() => api.post('/api/hosts/bulk', { ids: list.map(x => x.id), action: 'delete' }));
  toast(`${list.length === 1 ? list[0].name : plural(list.length, 'host', 'hosts')} removed`);
  ctx.rerender();
}

async function drawTable(ctx, body) {
  const groups = await groupOptions();
  const f = ctx.store.prefs['hosts.filter'] || {};
  const q = input({ type: 'search', placeholder: 'Name, address, OS or tag', value: f.q || '', 'aria-label': 'Search hosts' });
  const g = select([['', 'Every group'], ...groups], f.group || '', { 'aria-label': 'Group' });
  const st = select([['', 'Every state'], ['managed', 'Managed'], ['new', 'Not taken over'], ['failed', 'Take-over failed'], ['unreachable', 'Unreachable'], ['retired', 'Retired']], f.state || '', { 'aria-label': 'State' });
  const drift = h('input', { type: 'checkbox', checked: !!f.drift });
  const list = h('div', {});
  const bar = h('div', { class: 'fp-bulk hidden' });
  const selected = new Set();
  let rows = [];
  const load = async () => {
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (g.value) p.set('group', g.value);
    if (st.value) p.set('state', st.value);
    if (drift.checked) p.set('drift', '1');
    ctx.store.setPref('hosts.filter', { q: q.value, group: g.value, state: st.value, drift: drift.checked });
    rows = await get(`/api/hosts?${p}`);
    selected.clear();
    draw();
  };
  const all = h('input', { type: 'checkbox', 'aria-label': 'Choose all', onchange: e => { rows.forEach(r => (e.target.checked ? selected.add(r.id) : selected.delete(r.id))); draw(); } });
  const draw = () => {
    list.innerHTML = '';
    if (!rows.length) { list.append(empty('No host matches. Change the filters, or add hosts.')); updateBar(); return; }
    all.checked = rows.length && rows.every(r => selected.has(r.id));
    list.append(table([all, 'Host', 'Address', 'Group', 'State', 'System', 'Tags', 'Drift', 'Last run'], rows.map(r => h('tr', { class: selected.has(r.id) ? 'fp-sel' : '' },
      h('td', {}, h('input', { type: 'checkbox', checked: selected.has(r.id), 'aria-label': `Choose ${r.name}`, onchange: e => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); draw(); } })),
      h('td', {}, h('a', { href: `#/hosts/${r.id}` }, r.name)), h('td', {}, r.address + (r.port !== 22 ? `:${r.port}` : '')),
      h('td', { class: 'fp-font' }, r.group_name || '–'), h('td', {}, hostState(r.state)), h('td', { class: 'fp-font' }, [r.os, r.os_version].filter(Boolean).join(' ') || '–'),
      h('td', {}, chips(r.tags)), h('td', {}, r.drift ? (r.drift.changed ? h('span', { class: 'fp-state bad' }, `${r.drift.changed}`) : h('span', { class: 'fp-state ok' }, 'none')) : '–'),
      h('td', {}, r.last_run ? h('a', { href: `#/runs/${r.last_run.id}` }, runState(r.last_run.status)) : '–'))), { cls: 'fp-hosts' }));
    updateBar();
  };
  const updateBar = () => {
    bar.innerHTML = '';
    bar.classList.toggle('hidden', !selected.size);
    if (!selected.size) return;
    const ids = [...selected];
    bar.append(h('b', {}, `${plural(ids.length, 'host', 'hosts')} chosen`),
      can('runs', 'run') ? btn('Run a workflow', 'play', () => runDialog(ids), 'primary') : null,
      can('hosts', 'change') ? btn('Move to a group', 'group', async () => {
        const s = select([['', 'No group'], ...groups], '');
        if (await dialog('Move to a group', [field('Group', s)], { ok: 'Move', onOk: () => call(() => api.post('/api/hosts/bulk', { ids, action: 'move', groupId: s.value || null })) })) { toast('Moved'); load(); }
      }) : null,
      can('hosts', 'change') ? btn('Tags', 'tag', async () => {
        const t = input({ placeholder: 'web, production' }), how = select([['tag', 'Add these tags'], ['untag', 'Remove these tags']], 'tag');
        if (await dialog('Tags', [field('What', how), field('Tags', t)], { ok: 'Apply', onOk: () => call(() => api.post('/api/hosts/bulk', { ids, action: how.value, tags: t.value })) })) { toast('Tags changed'); load(); }
      }) : null,
      can('hosts', 'change') ? btn('Retire', 'stop', async () => { await call(() => api.post('/api/hosts/bulk', { ids, action: 'retire' })); toast('Retired: no workflows run on them'); load(); }, 'ghost') : null,
      can('hosts', 'manage') ? btn('Remove', 'trash', () => removeHosts(ctx, rows.filter(r => selected.has(r.id))), 'ghost danger') : null,
      h('button', { class: 'linkbtn', type: 'button', onclick: () => { selected.clear(); draw(); } }, 'Clear the choice'));
  };
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  [g, st, drift].forEach(el => el.addEventListener('change', load));
  body.append(h('div', { class: 'row fp-toolbar' }, q, g, st, h('label', { class: 'row small' }, drift, 'Drifted only')), bar, list);
  await load();
}

async function drawSources(ctx, body) {
  const list = await get('/api/sources');
  body.append(h('div', { class: 'row fp-toolbar' }, h('p', { class: 'muted grow', style: { margin: 0 } }, 'Proxmox VE clusters list their VMs and containers here, with the addresses the guest agent reports. Choose which ones become hosts.'),
    can('hosts', 'manage') ? btn('Connect a Proxmox cluster', 'plus', () => sourceDialog(ctx), 'primary') : null));
  if (!list.length) { body.append(empty('No cluster connected yet. FleetPilot needs an API token with the role PVEAuditor (read only).')); return; }
  const grid = h('div', { class: 'cardgrid' });
  for (const s of list) {
    grid.append(h('article', { class: 'tile' },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('span', { class: 'pico', html: I.sync }), h('h3', { style: { margin: 0 } }, s.name)),
      h('div', { class: 'small mono muted' }, s.url),
      h('div', { class: 'small' }, `${plural(s.vms, 'VM or container', 'VMs and containers')}, ${s.hosts} of them hosts`),
      s.last_error ? h('div', { class: 'small fp-err' }, s.last_error) : h('div', { class: 'small muted' }, s.last_sync_at ? `Read ${when(s.last_sync_at)}` : 'Not read yet'),
      h('div', { class: 'row' }, btn('Show the VMs', 'table', () => vmsDialog(ctx, s), 'primary'),
        btn('Read now', 'sync', async () => { await call(() => api.post(`/api/sources/${s.id}/sync`)); toast('Read'); ctx.rerender(); }),
        can('hosts', 'manage') ? iconBtn(I.sliders, `Change ${s.name}`, () => sourceDialog(ctx, s)) : null)));
  }
  body.append(grid);
}

async function sourceDialog(ctx, s = null) {
  const groups = await groupOptions();
  const v = { name: input({ value: s?.name || '', placeholder: 'Cluster 1' }), url: input({ mono: true, value: s?.url || '', placeholder: 'https://pve1.example.com:8006' }), tokenId: input({ mono: true, value: s?.token_id || '', placeholder: 'fleetpilot@pve!inventory' }),
    token: input({ mono: true, type: 'password', placeholder: s ? 'Leave empty to keep the stored secret' : 'The secret of the token' }), fp: input({ mono: true, value: s?.fingerprint || '', placeholder: 'AB:CD:… (for a self-signed certificate)' }) };
  const verify = h('input', { type: 'checkbox', checked: s ? s.verify_tls : true });
  const group = select([['', 'No group'], ...groups], s?.group_id || '');
  const readFp = btn('Read it from the server', 'download', async () => { const r = await call(() => api.post('/api/sources/fingerprint', { url: v.url.value })); v.fp.value = r.fingerprint; toast('Compare it with the one on the Proxmox page before you trust it'); }, 'ghost');
  const r = await dialog(s ? `Change ${s.name}` : 'Connect a Proxmox cluster', [
    h('p', { class: 'small muted' }, 'In Proxmox: Datacenter, Permissions, API Tokens: make a token without privilege separation for a user with the role PVEAuditor on /. FleetPilot only reads.'),
    h('div', { class: 'fp-grid2' }, field('Name', v.name), field('Address', v.url)), h('div', { class: 'fp-grid2' }, field('Token id', v.tokenId), field('Secret', v.token)),
    h('label', { class: 'row small' }, verify, 'Check the certificate'), field('Or trust this certificate (SHA-256 fingerprint)', v.fp), readFp,
    field('New hosts from here go into', group),
    s ? h('button', { class: 'btn ghost danger', type: 'button', html: I.trash + `Disconnect ${s.name}`, onclick: async e => { if (!confirm(`Disconnect ${s.name}? Its hosts stay.`)) return; await call(() => api.del(`/api/sources/${s.id}`)); e.target.closest('dialog').close(); toast('Disconnected'); ctx.rerender(); } }) : null
  ], { ok: s ? 'Save' : 'Connect', onOk: () => call(() => {
    const b = { name: v.name.value, url: v.url.value, tokenId: v.tokenId.value, verifyTls: verify.checked, fingerprint: v.fp.value, groupId: group.value || null };
    if (v.token.value) b.token = v.token.value;
    return s ? api.patch(`/api/sources/${s.id}`, b) : api.post('/api/sources', b);
  }) });
  if (r) { if (r.sync?.error) toast(`Connected, but reading failed: ${r.sync.error}`); ctx.rerender(); }
}

async function vmsDialog(ctx, s) {
  const vms = await get(`/api/sources/${s.id}/vms`);
  const groups = await groupOptions();
  const workflows = (await get('/api/workflows')).filter(w => w.kind === 'takeover' && w.enabled);
  const chosen = new Set();
  const rows = vms.map(v => h('tr', {},
    h('td', {}, v.host_id ? '' : h('input', { type: 'checkbox', 'aria-label': `Choose ${v.name}`, disabled: !v.ips.length, onchange: e => (e.target.checked ? chosen.add(v.id) : chosen.delete(v.id)) })),
    h('td', {}, v.name), h('td', {}, `${v.type === 'lxc' ? 'Container' : 'VM'} ${v.external_id.split('/')[1]}`), h('td', {}, v.node), h('td', {}, v.status),
    h('td', { class: 'mono' }, v.ips.join(', ') || h('span', { class: 'muted fp-font' }, 'unknown')), h('td', {}, chips(v.tags)),
    h('td', {}, v.host_id ? h('a', { href: `#/hosts/${v.host_id}` }, v.host_name) : '')));
  const group = select([['', 'No group'], ...groups], s.group_id || '');
  const wf = select([['', 'Not now'], ...workflows.map(w => [w.id, w.name])], '');
  const r = await dialog(`VMs and containers of ${s.name}`, [
    vms.length ? table(['', 'Name', 'Id', 'Node', 'State', 'Addresses', 'Tags', 'Host'], rows) : empty('Nothing found. Is the token allowed to read the cluster?'),
    h('p', { class: 'small muted' }, 'Addresses come from the QEMU guest agent (VMs) or the container. Without one, add the host by its address.'),
    h('div', { class: 'fp-grid2' }, field('Into the group', group), field('Take them over with', wf))
  ], { ok: 'Add the chosen as hosts', wide: true, onOk: () => { if (!chosen.size) throw new Error('Choose VMs first.'); return call(() => api.post(`/api/sources/${s.id}/import`, { vmIds: [...chosen], groupId: group.value || null, workflowId: wf.value || null })); } });
  if (r) { toast(`${plural(r.added, 'host', 'hosts')} added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`); if (r.run) location.hash = `#/runs/${r.run}`; else ctx.rerender(); }
}

// ---------------------------------------------------------------- One host
export async function viewHost(ctx, id) {
  const x = await get(`/api/hosts/${id}`);
  document.title = x.name;
  const tab = ctx.query.tab || 'overview';
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'fp-crumb small' }, h('a', { href: '#/hosts' }, 'Hosts'), ...x.path.flatMap(g => [' / ', h('a', { href: `#/hosts/group/${g.id}` }, g.name)])));
  page.append(pageHead(x.name, null, [
    x.may.run ? btn('Run a workflow', 'play', () => runDialog([x.id]), 'primary') : null,
    btn('Is it there?', 'target', async () => { const r = await call(() => api.post(`/api/hosts/${x.id}/ping`)); toast(r.reachable ? `${x.name} answers on port ${x.port} (${r.ms} ms)` : `${x.name} does not answer on port ${x.port}`); })
  ].filter(Boolean)));
  page.querySelector('.fp-head h1').after(h('div', { class: 'row fp-subhead' }, hostState(x.state), h('span', { class: 'mono small' }, `${x.address}${x.port !== 22 ? `:${x.port}` : ''}`), x.os ? h('span', { class: 'small muted' }, `${x.os} ${x.os_version}`) : null, ...chips(x.tags)));
  const body = h('div', {});
  const list = [['overview', 'Overview'], ['state', 'Desired state'], ...(x.may.vault ? [['secrets', 'Secrets']] : []), ['runs', 'Runs'], ...(x.may.change ? [['edit', 'Change']] : [])];
  page.append(tabs(list, tab, t => { history.replaceState(null, '', `#/hosts/${x.id}?tab=${t}`); draw(t); }), body);
  main.append(page);
  const draw = async t => {
    body.innerHTML = '';
    if (t === 'overview') hostOverview(x, body);
    else if (t === 'state') await hostState_(ctx, x, body);
    else if (t === 'secrets') await hostSecrets(ctx, x, body);
    else if (t === 'runs') hostRuns(x, body);
    else hostEdit(ctx, x, body);
  };
  await draw(tab);
}

function hostOverview(x, body) {
  const f = x.facts || {};
  const kv = (pairs) => h('dl', { class: 'kv fp-kv' }, pairs.filter(p => p[1] !== undefined && p[1] !== null && p[1] !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const mem = f.memtotal_mb ? `${(f.memtotal_mb / 1024).toFixed(1)} GB` : '';
  const up = f.uptime_seconds ? `${Math.floor(f.uptime_seconds / 86400)} days ${Math.floor(f.uptime_seconds % 86400 / 3600)} h` : '';
  body.append(h('div', { class: 'fp-cols' },
    h('section', { class: 'fp-card' }, h('h2', {}, 'Host'), kv([
      ['Address', `${x.address}${x.port !== 22 ? ` (SSH port ${x.port})` : ''}`], ['State', hostState(x.state)], ['FleetPilot logs in as', x.connection?.user ? `${x.connection.user} (${x.connection.method || 'key'})` : 'not yet: take the host over'],
      ['Host keys known', x.host_keys.join(', ') || 'none yet'], ['Added', when(x.created_at)], ['Last seen', when(x.last_seen_at)], ['Last run', when(x.last_run_at)],
      ['Proxmox', x.vm ? `${x.vm.source}: ${x.vm.type === 'lxc' ? 'container' : 'VM'} ${x.vm.external_id.split('/')[1]} on ${x.vm.node}` : '']
    ]), x.addresses.length ? h('div', {}, h('h4', { class: 'fp-h4' }, 'Addresses in IP management'), table(['Address', 'Subnet', 'State'], x.addresses.map(a => h('tr', {}, h('td', {}, a.ip), h('td', {}, `${a.cidr}${a.subnet ? ` ${a.subnet}` : ''}`), h('td', { class: 'fp-font' }, a.state))))) : null),
    h('section', { class: 'fp-card' }, h('h2', {}, 'System'), f.collected ? kv([
      ['Operating system', [f.distribution, f.distribution_version, f.distribution_release && `(${f.distribution_release})`].filter(Boolean).join(' ')], ['Kernel', f.kernel], ['Architecture', f.architecture],
      ['CPUs', f.processor_vcpus], ['Memory', mem], ['Runs on', [f.virtualization_role === 'guest' ? `a ${f.virtualization_type} guest` : f.virtualization_role === 'host' ? 'bare metal or a hypervisor' : '', f.product_name !== 'NA' && f.product_name].filter(Boolean).join(', ')],
      ['Name on the host', f.fqdn || f.hostname], ['Default route', f.default_ipv4?.gateway ? `${f.default_ipv4.gateway} via ${f.default_ipv4.interface}` : ''], ['IPv4 addresses', (f.all_ipv4_addresses || []).join(', ')],
      ['Up for', up], ['Read', when(f.collected)]
    ]) : empty('Nothing read yet. Facts arrive with the first run on this host.')),
    x.notes ? h('section', { class: 'fp-card' }, h('h2', {}, 'Notes'), h('p', { class: 'fp-notes' }, x.notes)) : null));
}

async function hostState_(ctx, x, body) {
  const s = await get(`/api/hosts/${x.id}/state`);
  const templates = can('automation', 'view') ? await get('/api/templates') : [];
  const own = s.templates.filter(t => t.via.type === 'host').map(t => t.template);
  body.append(h('p', { class: 'muted fp-intro' }, 'What this host should look like: the templates of its site and groups, and its own, merged from the most general to the most specific. The more specific value wins.'));
  // Drift
  if (s.drift) {
    const d = s.drift;
    body.append(d.changed
      ? h('div', { class: 'fp-card fp-drift' }, h('h2', {}, `${plural(d.changed, 'difference', 'differences')} from the desired state`), h('p', { class: 'small muted' }, `Found ${when(d.at)}. Applying the desired state changes these:`),
        h('div', { class: 'list' }, (d.tasks || []).map(t => h('div', { class: 'item' }, h('b', { class: 'small' }, t.task), ...(t.diff || []).map(df => h('pre', { class: 'fp-diff' }, `${df.path || ''}\n${diffText(df)}`))))),
        x.may.run ? h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Apply the desired state', 'play', () => runDialog([x.id], { kind: 'maintain' }), 'primary')) : null)
      : h('div', { class: 'done-banner' }, `In line with its desired state (checked ${when(d.at)}).`));
  }
  body.append(h('h2', { class: 'fp-sec' }, 'Templates'));
  if (!s.templates.length) body.append(empty('No template applies to this host yet. Add one here, or to its site or group.'));
  else body.append(table(['Template', 'From', 'Version', 'On the host', ''], s.templates.map(t => h('tr', {},
    h('td', {}, h('a', { href: `#/automate/template/${t.template}` }, t.name)), h('td', { class: 'fp-font' }, t.via.type === 'host' ? 'This host' : t.via.name),
    h('td', {}, t.pinned ? `${t.version} (kept)` : String(t.version)),
    h('td', {}, t.applied ? (t.applied.applied_version < t.version ? h('span', { class: 'fp-state wait' }, `version ${t.applied.applied_version}`) : h('span', { class: 'fp-state ok' }, `version ${t.applied.applied_version}`)) : h('span', { class: 'fp-state idle' }, 'not yet')),
    h('td', {}, t.via.type === 'host' && x.may.change ? iconBtn(I.x, `Remove ${t.name} from this host`, async () => { await call(() => api.del(`/api/hosts/${x.id}/templates/${t.template}`)); toast('Removed'); ctx.rerender(); }) : null)))));
  if (x.may.change && templates.length) {
    const s2 = select([['', 'Choose a template'], ...templates.filter(t => !t.archived && !own.includes(t.id)).map(t => [t.id, t.name])], '');
    body.append(h('div', { class: 'row', style: { marginTop: '10px' } }, s2, btn('Add to this host', 'plus', async () => { if (!s2.value) return; await call(() => api.post(`/api/hosts/${x.id}/templates`, { templateId: s2.value })); toast('Added'); ctx.rerender(); })));
  }
  body.append(h('h2', { class: 'fp-sec' }, 'Settings'));
  if (!s.settings.length) body.append(empty('Nothing set.'));
  for (const a of meta.catalog.areas) {
    const list = s.settings.filter(x2 => x2.area === a.id);
    if (!list.length) continue;
    body.append(h('div', { class: `fp-arealist ar-${a.id}` }, h('h4', { class: 'fp-h4' }, a.title), list.map(x2 => h('div', { class: 'fp-setline' }, h('b', {}, x2.title), h('span', { class: 'muted' }, x2.summary)))));
  }
  body.append(h('details', { class: 'sect' }, h('summary', {}, 'The playbook for this host'), h('div', { class: 'sect-body' }, h('div', { class: 'console fp-yaml' }, h('pre', {}, s.playbook)))));
}

export function diffText(d) {
  const lines = t => String(t || '').split('\n');
  const before = lines(d.before), after = lines(d.after);
  const out = [];
  for (const l of before) if (!after.includes(l) && l) out.push(`- ${l}`);
  for (const l of after) if (!before.includes(l) && l) out.push(`+ ${l}`);
  return out.slice(0, 60).join('\n') || '(the file state changes)';
}

async function hostSecrets(ctx, x, body) {
  const list = await get(`/api/vault?host=${x.id}`);
  body.append(h('p', { class: 'muted fp-intro' }, 'The passwords and keys FleetPilot made for this host, and what you added. Showing a value asks for a fresh confirmation and is recorded.'));
  if (!list.length) body.append(empty('Nothing yet. A take-over or "Set new passwords" puts the passwords here.'));
  else body.append(secretTable(ctx, list));
  if (can('vault', 'change')) body.append(h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Add a secret for this host', 'plus', async () => { const { secretDialog } = await import('./settings.js'); if (await secretDialog({ scope: 'host', hostId: x.id })) ctx.rerender(); })));
}

/** A table of vault entries with "Show" (after a fresh confirmation) */
export function secretTable(ctx, list) {
  return table(['Name', 'Kind', 'User', 'Version', 'Changed', ''], list.map(s => h('tr', {},
    h('td', {}, s.name), h('td', { class: 'fp-font' }, meta.vaultKinds[s.kind] || s.kind), h('td', {}, s.username || '–'), h('td', {}, String(s.version)), h('td', { class: 'fp-font' }, when(s.rotated_at || s.updated_at)),
    h('td', {}, can('vault', 'reveal') ? btn('Show', 'eye', () => revealSecret(s), 'ghost') : null))));
}

export async function revealSecret(s, version) {
  let r;
  try { r = await api.post(`/api/vault/${s.id}/reveal`, version ? { version } : {}); }
  catch (e) {
    if (e.code !== 'verify_needed') { toast(e.message); return; }
    if (!(await confirmFresh('Confirm that it is you'))) return;
    r = await call(() => api.post(`/api/vault/${s.id}/reveal`, version ? { version } : {}));
  }
  const rows = Object.entries(r).filter(([, v]) => v !== '' && v !== undefined && v !== null);
  const names = { username: 'User', password: 'Password', becomePassword: 'Root password', token: 'Token', privateKey: 'Private key', certificate: 'Certificate', key: 'Key', text: 'Text' };
  await dialog(`${s.host_name ? `${s.host_name}: ` : ''}${s.name}${version ? ` (version ${version})` : ''}`, rows.map(([k, v]) => {
    const multi = String(v).includes('\n') || String(v).length > 80;
    const el = multi ? h('textarea', { class: 'input mono fp-area', rows: 6, readonly: true }) : h('input', { class: 'input mono', readonly: true, value: v });
    if (multi) el.value = v;
    return h('div', { class: 'fp-reveal' }, field(names[k] || k, el), iconBtn(I.copy, `Copy ${names[k] || k}`, () => { navigator.clipboard?.writeText(String(v)); toast('Copied'); }));
  }));
}

function hostRuns(x, body) {
  if (!x.runs.length) { body.append(empty('No run on this host yet.')); return; }
  body.append(table(['Run', 'On this host', 'Run state', 'Started by', 'When'], x.runs.map(r => h('tr', {},
    h('td', {}, h('a', { href: `#/runs/${r.id}` }, r.name)), h('td', {}, runState(r.host_status)), h('td', {}, runState(r.status)), h('td', {}, r.requested_by || 'FleetPilot'), h('td', { class: 'fp-font' }, when(r.finished_at || r.created_at))))));
}

async function hostEdit(ctx, x, body) {
  const groups = await groupOptions();
  const v = { name: input({ value: x.name }), address: input({ mono: true, value: x.address }), port: input({ mono: true, type: 'number', value: x.port, min: 1, max: 65535 }), tags: input({ value: (x.tags || []).join(', ') }) };
  const group = select([['', 'No group'], ...groups], x.group_id || '');
  const notes = h('textarea', { class: 'input fp-area', rows: 4 }); notes.value = x.notes || '';
  body.append(h('form', { class: 'subcard fp-form', onsubmit: async e => {
    e.preventDefault();
    await call(() => api.patch(`/api/hosts/${x.id}`, { name: v.name.value, address: v.address.value, port: Number(v.port.value), groupId: group.value || null, tags: v.tags.value, notes: notes.value }));
    toast('Saved'); ctx.rerender();
  } }, h('div', { class: 'fp-grid3' }, field('Name', v.name), field('Address', v.address), field('SSH port', v.port)), h('div', { class: 'fp-grid2' }, field('Group', group), field('Tags', v.tags, 'Separated by commas.')),
  field('Notes', notes), h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'))));
  body.append(h('div', { class: 'row fp-danger' },
    x.state === 'retired' ? btn('Bring it back', 'reset', async () => { await call(() => api.patch(`/api/hosts/${x.id}`, { state: 'active' })); toast('Active again'); ctx.rerender(); })
      : btn('Retire', 'stop', async () => { await call(() => api.patch(`/api/hosts/${x.id}`, { state: 'retired' })); toast('Retired: no workflows run on it'); ctx.rerender(); }, 'ghost'),
    x.may.manage ? btn(`Remove ${x.name}`, 'trash', async () => { if (!confirm(`Remove ${x.name} from FleetPilot? The host itself is not touched. Its passwords and keys stay in the vault, named after it.`)) return; await call(() => api.del(`/api/hosts/${x.id}`)); toast(`${x.name} removed`); location.hash = '#/hosts'; }, 'ghost danger') : null));
}

// ---------------------------------------------------------------- One group
export async function viewGroup(ctx, id) {
  const [groups, all] = await Promise.all([get('/api/groups'), groupOptions()]);
  const g = groups.find(x => x.id === String(id));
  if (!g) throw new Error('There is no such group.');
  document.title = g.name;
  const label = all.find(([gid]) => gid === g.id)?.[1] || g.name;
  const hosts = await get(`/api/hosts?group=${g.id}`);
  const page = h('div', { class: 'page' });
  page.append(h('div', { class: 'fp-crumb small' }, h('a', { href: '#/hosts' }, 'Hosts'), ` / ${label.split(' / ').slice(0, -1).join(' / ')}`.replace(/ \/ $/, '')));
  page.append(pageHead(g.name, g.description || (g.kind === 'site' ? 'A site: everything below it gets its templates.' : 'A group: its hosts and groups get its templates.'), [
    hosts.length && can('runs', 'run') ? btn(`Run a workflow on ${plural(hosts.length, 'host', 'hosts')}`, 'play', () => runDialog(hosts.map(x => x.id)), 'primary') : null,
    can('hosts', 'manage') ? btn('Add a group inside', 'plus', () => groupDialog(ctx, g.id)) : null,
    can('hosts', 'manage') ? btn('Add hosts here', 'plus', async () => { if (await addHostsDialog(g.id)) ctx.rerender(); }) : null
  ].filter(Boolean)));
  const tab = ctx.query.tab || 'hosts';
  const body = h('div', {});
  page.append(tabs([['hosts', `Hosts (${hosts.length})`], ['templates', 'Templates'], ...(can('hosts', 'manage') ? [['edit', 'Change']] : [])], tab, t => { history.replaceState(null, '', `#/hosts/group/${g.id}?tab=${t}`); draw(t); }), body);
  main.append(page);
  const draw = async t => {
    body.innerHTML = '';
    if (t === 'hosts') {
      if (!hosts.length) body.append(empty('No host here or in the groups inside.'));
      else body.append(table(['Host', 'Address', 'Group', 'State', 'System', 'Drift'], hosts.map(r => h('tr', {}, h('td', {}, h('a', { href: `#/hosts/${r.id}` }, r.name)), h('td', {}, r.address), h('td', { class: 'fp-font' }, r.group_name), h('td', {}, hostState(r.state)), h('td', { class: 'fp-font' }, r.os || '–'), h('td', {}, r.drift ? String(r.drift.changed) : '–')))));
    } else if (t === 'templates') {
      body.append(h('p', { class: 'muted fp-intro' }, `Templates of ${g.name} apply to every host in it and in the groups inside it. Later ones win over earlier ones, groups inside win over this one.`));
      if (!g.templates.length) body.append(empty('No template here yet.'));
      else body.append(table(['Template', 'Version', ''], g.templates.map(t2 => h('tr', {}, h('td', {}, h('a', { href: `#/automate/template/${t2.id}` }, t2.name)), h('td', {}, t2.pinned ? `kept at ${t2.pinned}` : 'always the newest'),
        h('td', {}, can('hosts', 'change') ? iconBtn(I.x, `Remove ${t2.name} from ${g.name}`, async () => { const u = await get(`/api/templates/${t2.id}/usage`); const a = u.assignments.find(z => z.group_id === g.id); await call(() => api.del(`/api/templates/${t2.id}/assign/${a.id}`)); toast('Removed'); ctx.rerender(); }) : null)))));
      if (can('hosts', 'change') && can('automation', 'view')) {
        const list = (await get('/api/templates')).filter(t2 => !t2.archived && !g.templates.some(x => x.id === t2.id));
        const s = select([['', 'Choose a template'], ...list.map(t2 => [t2.id, t2.name])], '');
        body.append(h('div', { class: 'row', style: { marginTop: '10px' } }, s, btn(`Add to ${g.name}`, 'plus', async () => { if (!s.value) return; await call(() => api.post(`/api/templates/${s.value}/assign`, { groupId: g.id })); toast('Added'); ctx.rerender(); })));
      }
    } else {
      const name = input({ value: g.name }), desc = input({ value: g.description }), parent = select([['', g.kind === 'site' ? 'Nothing: it is a site' : 'Nothing: make it a site'], ...all.filter(([gid, l]) => gid !== g.id && !l.startsWith(label + ' / '))], g.parent_id || '');
      body.append(h('form', { class: 'subcard fp-form', onsubmit: async e => { e.preventDefault(); await call(() => api.patch(`/api/groups/${g.id}`, { name: name.value, description: desc.value, parentId: parent.value || null, kind: parent.value ? 'group' : 'site' })); forgetChoices(); toast('Saved'); ctx.rerender(); } },
        field('Name', name), field('Description', desc), field('Inside', parent), h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'))));
      body.append(h('div', { class: 'row fp-danger' }, btn(`Delete ${g.name}`, 'trash', async () => { if (!confirm(`Delete ${g.name}? Only an empty group can be deleted.`)) return; await call(() => api.del(`/api/groups/${g.id}`)); forgetChoices(); toast('Deleted'); location.hash = '#/hosts'; }, 'ghost danger')));
    }
  };
  await draw(tab);
}
