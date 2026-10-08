// FleetPilot: the template editor. Settings from the catalog, area by area, each a form; the
// playbook FleetPilot makes from them, live beside the forms; where the template applies, which
// hosts are behind, and pushing a new version to them; the versions and going back to one.
import { h, toast, contextMenu } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { main, meta, get, call, can, pageHead, btn, tabs, dialog, field, input, select, table, empty, when, plural, bands, hostState, renderFields, groupOptions } from '../common.js';

const clone = v => JSON.parse(JSON.stringify(v));

export async function viewTemplate(ctx, id) {
  const isNew = id === 'new';
  const t = isNew ? { name: '', description: '', definition: { settings: [] }, versions: [], current_version: 0, archived: false } : await get(`/api/templates/${id}`);
  document.title = isNew ? 'New template' : t.name;
  const mayChange = can('automation', 'change');
  const st = { def: clone(t.definition), name: t.name, description: t.description, dirty: false, restoredFrom: null };
  const page = h('div', { class: 'page fp-page-wide' });
  const saveBtn = btn(isNew ? 'Create the template' : 'Save a new version', 'save', () => save(), 'primary');
  const dirtyNote = h('span', { class: 'small muted fp-dirty' });
  const markDirty = () => { st.dirty = true; saveBtn.disabled = false; dirtyNote.textContent = st.restoredFrom ? `Changes from version ${st.restoredFrom}, not saved` : 'Changes not saved'; schedulePreview(); };
  saveBtn.disabled = !isNew;
  const before = e => { if (st.dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', before);
  ctx.onLeave(() => window.removeEventListener('beforeunload', before));

  page.append(h('p', { class: 'fp-crumb small' }, h('a', { href: '#/automate/templates' }, 'Templates'), ' / '));
  page.append(pageHead(isNew ? 'New template' : t.name, isNew ? 'Pick the settings this template sets. FleetPilot writes the Ansible playbook for you.' : `Version ${t.current_version}${t.archived ? ' · archived' : ''} · ${t.description || 'No description'}`, mayChange ? [
    dirtyNote, saveBtn,
    !isNew ? btn('Duplicate', 'copy', async () => { const r = await call(() => api.post(`/api/templates/${t.id}/duplicate`, {})).catch(() => null); if (r) location.hash = `#/automate/template/${r.id}`; }) : null,
    !isNew ? btn(t.archived ? 'Restore' : 'Archive', '', async () => { await call(() => api.patch(`/api/templates/${t.id}`, { archived: !t.archived })); ctx.rerender(); }, 'ghost') : null,
    !isNew ? btn('Delete', 'trash', async () => {
      if (await dialog(`Delete ${t.name}`, [h('p', {}, 'The template and all its versions go. Hosts keep what was applied to them.')], { ok: 'Delete the template', okClass: 'danger', onOk: () => call(() => api.del(`/api/templates/${t.id}`)) })) { st.dirty = false; location.hash = '#/automate/templates'; }
    }, 'ghost') : null
  ].filter(Boolean) : []));

  // Name and description: always at hand
  const nameIn = input({ value: st.name, placeholder: 'Web server', disabled: !mayChange, oninput: e => { st.name = e.target.value; markDirty(); } });
  const descIn = input({ value: st.description, placeholder: 'What hosts with this template are for', disabled: !mayChange, oninput: e => { st.description = e.target.value; markDirty(); } });
  page.append(h('div', { class: 'fp-grid2 fp-tpl-names' }, field('Name', nameIn), field('Description', descIn)));

  const body = h('div', {});
  const tabList = [['settings', 'Settings'], ['playbook', 'Playbook'], ...(isNew ? [] : [['usage', 'Where it applies'], ['versions', `Versions (${t.versions.length})`]])];
  const tab = ctx.query.tab && tabList.some(x => x[0] === ctx.query.tab) ? ctx.query.tab : 'settings';
  page.append(tabs(tabList, tab, x => draw(x)), body);
  main.append(page);

  // ------------------------------------------------------------ The live playbook
  const pre = h('pre', {});
  const preBox = () => h('div', { class: 'console fp-yaml' }, pre);
  const previewNote = h('p', { class: 'small muted' });
  let timer = null, seq = 0;
  async function preview() {
    const n = ++seq;
    try {
      const r = await api.post('/api/templates/preview', { definition: st.def, name: st.name || 'Template' });
      if (n !== seq) return;
      pre.textContent = r.playbook; previewNote.textContent = 'Plain Ansible from ansible-core, made from the settings on the left.'; previewNote.classList.remove('fp-err');
    } catch (e) {
      if (n !== seq) return;
      previewNote.textContent = e.message; previewNote.classList.add('fp-err');
    }
  }
  function schedulePreview() { clearTimeout(timer); timer = setTimeout(preview, 450); }
  ctx.onLeave(() => clearTimeout(timer));

  const draw = async x => {
    body.innerHTML = '';
    if (x === 'playbook') { body.append(previewNote, preBox()); preview(); }
    else if (x === 'usage') await drawUsage(ctx, body, t);
    else if (x === 'versions') drawVersions(body, t, def => { st.def = clone(def.definition); st.restoredFrom = def.version; markDirty(); page.querySelector('[role=tab]')?.click(); toast(`Version ${def.version} is in the editor: save it to make it the newest`); });
    else {
      const editor = h('div', { class: 'fp-tpl-editor' });
      body.append(h('div', { class: 'fp-tpl' }, editor, h('aside', { class: 'fp-tpl-side' }, h('h4', {}, 'The playbook'), previewNote, preBox())));
      drawEditor(editor, st, mayChange, markDirty);
      preview();
    }
  };
  await draw(tab);

  async function save() {
    if (!st.name.trim()) { toast('Give the template a name.'); nameIn.focus(); return; }
    if (isNew) {
      const r = await call(() => api.post('/api/templates', { name: st.name, description: st.description, definition: st.def })).catch(() => null);
      if (!r) return;
      st.dirty = false; toast('Template created');
      location.hash = `#/automate/template/${r.id}?tab=usage`;
      return;
    }
    const usage = await get(`/api/templates/${t.id}/usage`).catch(() => ({ hosts: [] }));
    const managed = usage.hosts.filter(x => x.assigned && x.state === 'managed');
    const note = input({ placeholder: 'What changed, in a few words' });
    const push = h('input', { type: 'checkbox', checked: false });
    const r = await dialog(`Save version ${t.current_version + 1}`, [
      field('Note', note),
      managed.length && can('runs', 'run') ? h('label', { class: 'row small fp-check' }, push, `Apply the new version now to the ${plural(managed.length, 'managed host', 'managed hosts')} that use it`) : h('p', { class: 'small muted' }, 'No managed host uses this template yet.'),
      h('p', { class: 'small muted' }, 'Hosts keep the version they have until it is applied: by a run you start, a workflow, or the push on "Where it applies".')
    ], { ok: 'Save', onOk: () => call(() => api.post(`/api/templates/${t.id}/versions`, { definition: st.def, name: st.name, description: st.description, note: note.value })) });
    if (!r) return;
    st.dirty = false;
    toast(`Version ${r.version} saved`);
    if (push.checked) {
      const run = await call(() => api.post(`/api/templates/${t.id}/push`, { all: true })).catch(() => null);
      if (run?.id) { location.hash = `#/runs/${run.id}`; return; }
    }
    ctx.rerender();
  }
}

// ---------------------------------------------------------------- The settings, area by area
function drawEditor(el, st, mayChange, markDirty) {
  el.innerHTML = '';
  const list = st.def.settings;
  if (!list.length) el.append(h('div', { class: 'subcard fp-start' }, h('h2', {}, 'No settings yet'), h('p', { class: 'muted' }, 'Add what hosts with this template should have: users and keys, packages, a firewall, a web server, mounts, cron jobs and more. Each setting is a short form.')));
  for (const a of meta.catalog.areas) {
    const inArea = list.filter(s => meta.types.get(s.type)?.area === a.id);
    if (!inArea.length) continue;
    el.append(h('div', { class: 'fp-areahead' }, h('i', { class: `bg-${a.id}` }), h('h2', {}, a.title), h('span', { class: 'muted small' }, plural(inArea.length, 'setting', 'settings'))));
    for (const s of inArea) el.append(settingCard(s));
  }
  if (mayChange) el.append(addMenu());

  function settingCard(s) {
    const type = meta.types.get(s.type);
    const remove = () => {
      const i = list.indexOf(s); if (i < 0) return;
      list.splice(i, 1); markDirty(); drawEditor(el, st, mayChange, markDirty);
      toast(`${type.title} removed`);
    };
    const status = h('span', { class: `sect-status${s.off ? '' : ' on'}` }, s.off ? 'off' : 'on');
    const summary = h('summary', {}, h('span', { class: 'fp-sum-title' }, type.title), status);
    summary.addEventListener('contextmenu', e => { if (mayChange) contextMenu(e, [{ label: `Remove ${type.title}`, icon: I.trash, danger: true, onClick: remove }], type.title); });
    const off = h('input', { type: 'checkbox', checked: !!s.off, disabled: !mayChange, onchange: e => { if (e.target.checked) s.off = true; else delete s.off; status.textContent = s.off ? 'off' : 'on'; status.classList.toggle('on', !s.off); markDirty(); } });
    return h('details', { class: `sect fp-setting ar-${type.area}`, open: true }, summary,
      h('div', { class: 'sect-body' },
        h('p', { class: 'muted small' }, type.text),
        renderFields(type.fields, s.values, () => markDirty(), { readOnly: !mayChange }),
        mayChange ? h('div', { class: 'row fp-setting-foot' }, h('label', { class: 'row small fp-check' }, off, 'Leave out for now'), h('span', { class: 'grow' }), btn(`Remove ${type.title}`, 'trash', remove, 'ghost danger')) : null));
  }

  function addMenu() {
    const wrap = h('div', { class: 'features' });
    const menu = h('div', { class: 'featmenu fp-addmenu hidden' });
    const find = input({ type: 'search', placeholder: 'Find a setting: nginx, users, firewall …', 'aria-label': 'Find a setting' });
    const items = h('div', {});
    const used = new Set(list.map(s => s.type));
    const fill = () => {
      items.innerHTML = '';
      const q = find.value.trim().toLowerCase();
      for (const a of meta.catalog.areas) {
        const types = meta.catalog.types.filter(x => x.area === a.id && !used.has(x.id) && (!q || `${x.title} ${x.text} ${x.id}`.toLowerCase().includes(q)));
        if (!types.length) continue;
        items.append(h('div', { class: 'fp-addarea small' }, h('i', { class: `bg-${a.id}` }), a.title));
        for (const x of types) items.append(h('button', { type: 'button', class: `featitem ar-${a.id}`, onclick: () => add(x) }, h('b', {}, x.title), h('span', {}, x.text)));
      }
      if (!items.children.length) items.append(empty('Nothing matches, or every matching setting is in the template already.'));
    };
    const add = x => {
      list.push({ id: Math.random().toString(16).slice(2, 14), type: x.id, values: {} });
      markDirty(); drawEditor(el, st, mayChange, markDirty);
      const cards = el.querySelectorAll('.fp-setting');
      const card = [...cards].find(c => c.querySelector('.fp-sum-title')?.textContent === x.title);
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card?.querySelector('input:not([type=checkbox]), select, textarea')?.focus({ preventScroll: true });
    };
    find.addEventListener('input', fill);
    menu.append(find, items);
    const open = h('button', { type: 'button', class: 'btn addfeat', html: `${I.plus}<span>Add a setting</span> <span class="small muted">users, packages, nginx, firewall, …</span>`, onclick: () => { menu.classList.toggle('hidden'); if (!menu.classList.contains('hidden')) { fill(); find.focus(); } } });
    wrap.append(open, menu);
    wrap.append(h('details', { class: 'fp-vars small' }, h('summary', {}, 'Variables you can use in texts'),
      h('p', { class: 'muted' }, 'FleetPilot fills these per host. Nothing else in a text is read as a variable.'),
      h('dl', { class: 'kv' }, meta.catalog.variables.flatMap(([k, d, ex]) => [h('dt', {}, `{{ ${k} }}`), h('dd', {}, `${d}, like ${ex}`)]))));
    return wrap;
  }
}

// ---------------------------------------------------------------- Where it applies
async function drawUsage(ctx, body, t) {
  const u = await get(`/api/templates/${t.id}/usage`);
  const mayAssign = can('hosts', 'change');
  body.append(h('h2', { class: 'fp-sec' }, 'Applies to'), h('p', { class: 'muted small' }, 'A template given to a site or group applies to every host inside. Settings of more specific templates win: site, then group, then the host itself.'));
  if (u.assignments.length) body.append(table(['Where', 'Version', ''], u.assignments.map(a => h('tr', {},
    h('td', {}, a.group_id ? h('a', { href: `#/hosts/group/${a.group_id}` }, `${a.group_kind === 'site' ? 'Site' : 'Group'} ${a.group_name}`) : h('a', { href: `#/hosts/${a.host_id}` }, `Host ${a.host_name}`)),
    h('td', {}, a.pinned_version ? `Stays at version ${a.pinned_version}` : 'Always the newest'),
    h('td', {}, mayAssign ? btn('Remove', '', async () => { await call(() => api.del(`/api/templates/${t.id}/assign/${a.id}`)); ctx.rerender(); }, 'ghost') : null)))));
  else body.append(empty('It applies nowhere yet.'));
  if (mayAssign) {
    const [groups, hosts] = await Promise.all([groupOptions(), get('/api/hosts')]);
    const target = select([['', 'Choose…'], ...groups.map(([v, n]) => [`g${v}`, n]), ...hosts.map(x => [`h${x.id}`, `Host ${x.name}`])], '');
    const pin = select([['', 'Always the newest version'], ...t.versions.map(v => [v.version, `Stay at version ${v.version}`])], '');
    body.append(h('div', { class: 'row fp-assign' }, field('Apply it to', target), field('Version', pin), btn('Apply it there', 'plus', async () => {
      if (!target.value) return toast('Choose a site, a group or a host.');
      const b = target.value.startsWith('g') ? { groupId: target.value.slice(1) } : { hostId: target.value.slice(1) };
      await call(() => api.post(`/api/templates/${t.id}/assign`, { ...b, pinnedVersion: pin.value || null }));
      toast('Applied'); ctx.rerender();
    })));
  }

  body.append(h('h2', { class: 'fp-sec' }, 'Hosts'));
  if (!u.hosts.length) { body.append(empty('No host uses this template yet.')); return; }
  const behind = u.hosts.filter(x => x.state === 'managed' && (x.applied_version ?? 0) < u.current);
  const picked = new Set();
  const mayRun = can('runs', 'run');
  body.append(h('p', { class: 'muted small' }, `The newest version is ${u.current}. ${behind.length ? `${plural(behind.length, 'managed host has', 'managed hosts have')} an older one or none yet.` : 'Every managed host has it.'}`));
  const push = async b => { const r = await call(() => api.post(`/api/templates/${t.id}/push`, b)).catch(() => null); if (r?.id) location.hash = `#/runs/${r.id}`; };
  if (mayRun) body.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
    btn(`Push version ${u.current} to the hosts behind`, 'play', () => push({}), 'primary'),
    btn('Push to every host that uses it', 'play', () => push({ all: true })),
    btn('Push to the chosen hosts', 'play', () => (picked.size ? push({ hostIds: [...picked] }) : toast('Choose hosts in the table first.')))));
  body.append(table([mayRun ? '' : null, 'Host', 'State', 'Applied', 'Why it is here'].filter(x => x !== null), u.hosts.map(x => h('tr', {},
    mayRun ? h('td', {}, h('input', { type: 'checkbox', 'aria-label': `Choose ${x.name}`, disabled: x.state !== 'managed', onchange: e => (e.target.checked ? picked.add(x.id) : picked.delete(x.id)) })) : null,
    h('td', {}, h('a', { href: `#/hosts/${x.id}` }, x.name)), h('td', {}, hostState(x.state)),
    h('td', {}, x.applied_version ? h('span', { class: `fp-state ${x.applied_version < u.current ? 'wait' : 'ok'}` }, `Version ${x.applied_version}${x.applied_version < u.current ? ', behind' : ''}`) : h('span', { class: 'muted' }, 'Not yet'), x.applied_at ? h('span', { class: 'small muted' }, ` ${when(x.applied_at)}`) : null),
    h('td', { class: 'muted' }, x.assigned ? 'It applies to the host' : 'Used before: it no longer applies')))));
}

// ---------------------------------------------------------------- Versions
function drawVersions(body, t, restore) {
  const mayChange = can('automation', 'change');
  body.append(h('p', { class: 'muted small' }, 'Every save is a version. Look at the playbook of an older one, or bring it back into the editor and save it as the newest.'));
  body.append(table(['Version', 'Note', 'By', 'When', ''], t.versions.map(v => h('tr', {},
    h('td', {}, String(v.version), v.version === t.current_version ? h('span', { class: 'chip on', style: { marginLeft: '6px' } }, 'newest') : null),
    h('td', {}, v.note || '–'), h('td', {}, v.created_by || ''), h('td', { class: 'muted' }, when(v.created_at)),
    h('td', { class: 'fp-actions-cell' },
      btn('Playbook', 'doc', async () => { const x = await get(`/api/templates/${t.id}?version=${v.version}`); const p = h('pre', {}); p.textContent = x.playbook; await dialog(`${t.name}, version ${v.version}`, [h('div', { class: 'console fp-yaml' }, p)], { wide: true }); }, 'ghost'),
      mayChange && v.version !== t.current_version ? btn('Bring it back', 'reset', async () => { const x = await get(`/api/templates/${t.id}?version=${v.version}`); restore(x); }, 'ghost') : null)))));
}
