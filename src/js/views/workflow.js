// FleetPilot: the workflow editor. On the left how it runs (trigger, hosts, batches, approval),
// in the middle the steps in their order, each in one sentence, on the right the form of the
// chosen step (its values, what happens when it fails, for which hosts it runs).
import { h, toast, contextMenu } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { main, meta, get, call, can, pageHead, btn, dialog, field, input, select, empty, when, plural, renderFields, groupOptions, hostState, runState } from '../common.js';
import { cronText, triggerText } from './automate.js';

const clone = v => JSON.parse(JSON.stringify(v));
const ON_FAILURE = [['host', 'Stop for this host, go on with the others'], ['run', 'Stop the whole run'], ['continue', 'Go on with the next step']];
const PRESETS = [['30 2 * * *', 'Every night'], ['0 6 * * 1', 'Every Monday'], ['0 4 1 * *', 'Once a month'], ['0 * * * *', 'Every hour']];

export async function viewWorkflow(ctx, id) {
  const w = await get(`/api/workflows/${id}`);
  document.title = w.name;
  const mayChange = can('automation', 'change');
  const st = { def: clone(w.definition), name: w.name, description: w.description, enabled: w.enabled, sel: 0, dirty: false, touched: new Set() };
  const groups = await groupOptions();
  const groupName = new Map(groups);
  const saveBtn = btn('Save', 'save', () => save(), 'primary');
  saveBtn.disabled = true;
  const dirtyNote = h('span', { class: 'small muted fp-dirty' });
  const markDirty = () => { st.dirty = true; saveBtn.disabled = false; dirtyNote.textContent = 'Changes not saved'; summary(); };
  const before = e => { if (st.dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', before);
  ctx.onLeave(() => window.removeEventListener('beforeunload', before));

  const page = h('div', { class: 'page fp-page-wide' });
  page.append(h('p', { class: 'fp-crumb small' }, h('a', { href: '#/automate/workflows' }, 'Workflows'), ' / '));
  page.append(pageHead(w.name, `${w.kind === 'takeover' ? 'Take-over workflow: for hosts that are not managed yet.' : 'Maintenance workflow: for managed hosts.'}${w.builtin ? ' Built in.' : ''} Version ${w.version}.`, [
    mayChange ? dirtyNote : null, mayChange ? saveBtn : null,
    can('runs', 'run') ? btn('Run it now', 'play', () => runNow()) : null,
    h('a', { class: 'btn ghost', href: `#/runs?workflow=${w.id}` }, 'Its runs'),
    mayChange ? btn('Duplicate', 'copy', async () => { const r = await call(() => api.post(`/api/workflows/${w.id}/duplicate`, {})).catch(() => null); if (r) location.hash = `#/automate/workflow/${r.id}`; }, 'ghost') : null,
    mayChange && !w.builtin ? btn('Delete', 'trash', async () => {
      if (await dialog(`Delete ${w.name}`, [h('p', {}, 'Its runs stay in the history.')], { ok: 'Delete the workflow', okClass: 'danger', onOk: () => call(() => api.del(`/api/workflows/${w.id}`)) })) { st.dirty = false; location.hash = '#/automate/workflows'; }
    }, 'ghost') : null
  ].filter(Boolean)));

  const sentence = h('div', { class: 'fp-wf-sentence' });
  page.append(sentence);
  const left = h('div', { class: 'fp-wf-how' }), mid = h('div', { class: 'fp-wf-steps' }), side = h('aside', { class: 'fp-wf-side' });
  page.append(h('div', { class: 'fp-wf-grid' }, left, mid, side));
  main.append(page);

  // ------------------------------------------------------------ What it does, in one paragraph
  function summary() {
    const d = st.def;
    const t = d.targets || { groups: [], tags: [] };
    const where = [...t.groups.map(g => `in ${groupName.get(String(g)) || 'a group'}`), ...t.tags.map(x => `tagged ${x}`)];
    const hosts = w.kind === 'takeover' ? 'hosts that are not taken over yet' : 'managed hosts';
    const batch = d.batch?.size ? `${d.batch.size}${d.batch.unit === 'percent' ? ' percent' : d.batch.size === 1 ? ' host' : ' hosts'} at a time` : 'all at once';
    sentence.innerHTML = '';
    sentence.append(h('p', {}, h('b', {}, st.enabled ? triggerText(d.trigger) : 'Switched off: it does not start by itself'), `, on ${hosts}${where.length ? ` ${where.join(' or ')}` : ''}, ${batch}. `,
      d.approval === 'always' ? 'Every run waits for an approval. ' : 'Runs wait for an approval when the roles of the person who starts them ask for one. ',
      `${plural(d.steps.length, 'step', 'steps')}, one after the other.`));
  }

  // ------------------------------------------------------------ How it runs
  function drawHow() {
    left.innerHTML = '';
    const d = st.def, ro = !mayChange;
    const name = input({ value: st.name, disabled: ro, oninput: e => { st.name = e.target.value; markDirty(); } });
    const desc = h('textarea', { class: 'input fp-area', rows: 3, disabled: ro, oninput: e => { st.description = e.target.value; markDirty(); } });
    desc.value = st.description || '';
    const on = h('input', { type: 'checkbox', checked: st.enabled, disabled: ro, onchange: e => { st.enabled = e.target.checked; markDirty(); } });
    const triggers = [['manual', 'When someone starts it'], ['schedule', 'On a schedule'], ...(w.kind === 'takeover' ? [['host_added', 'When a host is added']] : [['template_changed', 'When a template gets a new version']])];
    const trig = select(triggers, d.trigger.type, { disabled: ro });
    const cron = input({ mono: true, value: d.trigger.cron || '30 2 * * *', disabled: ro, placeholder: 'minute hour day month weekday' });
    const cronSays = h('span', { class: 'fp-help' });
    const cronBox = h('div', { class: 'fp-cron' }, field('Schedule (UTC)', cron), cronSays, h('div', { class: 'row' }, PRESETS.map(([c, t]) => h('button', { type: 'button', class: 'btn ghost fp-preset', disabled: ro, onclick: () => { cron.value = c; setCron(); } }, t))));
    const setCron = () => { d.trigger.cron = cron.value.trim(); cronSays.textContent = cronText(d.trigger.cron) === d.trigger.cron ? 'Five fields: minute, hour, day of month, month, weekday.' : `Runs ${cronText(d.trigger.cron)}.`; markDirty(); };
    cron.addEventListener('input', setCron);
    cronSays.textContent = d.trigger.cron ? `Runs ${cronText(d.trigger.cron)}.` : '';
    const showCron = () => cronBox.classList.toggle('hidden', d.trigger.type !== 'schedule');
    trig.addEventListener('change', () => { d.trigger.type = trig.value; if (trig.value === 'schedule' && !d.trigger.cron) d.trigger.cron = cron.value.trim(); showCron(); markDirty(); });
    showCron();
    const gsel = h('select', { class: 'input', multiple: true, size: Math.min(6, Math.max(3, groups.length)), disabled: ro, onchange: e => { d.targets.groups = [...e.target.selectedOptions].map(o => o.value); markDirty(); } },
      groups.map(([v, n]) => h('option', { value: v, selected: d.targets.groups.map(String).includes(String(v)) }, n)));
    const tags = input({ value: d.targets.tags.join(', '), disabled: ro, placeholder: 'web, debian', oninput: e => { d.targets.tags = e.target.value.split(/[\s,]+/).filter(Boolean); markDirty(); } });
    const bsize = input({ mono: true, type: 'number', min: 0, max: 1000, value: d.batch.size || 0, disabled: ro, style: { width: '90px' }, oninput: e => { d.batch.size = Number(e.target.value) || 0; markDirty(); } });
    const bunit = select([['hosts', 'hosts'], ['percent', 'percent']], d.batch.unit, { disabled: ro, onchange: e => { d.batch.unit = e.target.value; markDirty(); } });
    const appr = select([['role', 'When the roles of the person ask for it'], ['always', 'Always']], d.approval, { disabled: ro, onchange: e => { d.approval = e.target.value; markDirty(); } });
    const targetsOut = h('div', { class: 'small' });
    left.append(
      h('h4', {}, 'About'), field('Name', name), field('Description', desc),
      h('label', { class: 'row small fp-check' }, on, 'Switched on'),
      h('h4', {}, 'When'), field('It starts', trig), cronBox,
      h('h4', {}, 'On which hosts'),
      h('p', { class: 'small muted' }, groups.length ? 'Hosts in these groups (and the groups inside) or with these tags. Nothing chosen: every host. A run you start by hand can name other hosts.' : 'Every host. Add groups under Hosts to narrow it down.'),
      groups.length ? field('Groups', gsel) : null, field('Tags', tags),
      btn('Show the hosts', 'eye', async () => {
        if (st.dirty) { targetsOut.innerHTML = ''; targetsOut.append(h('p', { class: 'muted' }, 'Save first: the list follows the saved targets.')); return; }
        const list = await get(`/api/workflows/${w.id}/targets`);
        targetsOut.innerHTML = '';
        targetsOut.append(list.length ? h('ul', { class: 'fp-mini' }, list.slice(0, 30).map(x => h('li', {}, h('a', { href: `#/hosts/${x.id}` }, x.name), ' ', hostState(x.state))), list.length > 30 ? h('li', { class: 'muted' }, `and ${list.length - 30} more`) : null) : h('p', { class: 'muted' }, 'No host right now.'));
      }, 'ghost'), targetsOut,
      h('h4', {}, 'How many at once'), h('div', { class: 'row' }, bsize, bunit), h('p', { class: 'small muted' }, '0 means all at once. A batch finishes every step before the next batch starts.'),
      h('h4', {}, 'Approval'), field('A run waits for an approval', appr),
      w.versions?.length ? h('details', { class: 'fp-vars small' }, h('summary', {}, `Versions (${w.versions.length})`), h('ul', { class: 'fp-mini' }, w.versions.map(v => h('li', {}, `Version ${v.version}, ${v.created_by || ''}, ${when(v.created_at)}`)))) : null,
      w.nextAt && w.enabled ? h('p', { class: 'small muted' }, `Next start: ${new Date(w.nextAt).toLocaleString()}.`) : null,
      w.last_run ? h('p', { class: 'small muted' }, 'Last run: ', h('a', { href: `#/runs/${w.last_run.id}` }, runState(w.last_run.status)), ` ${when(w.last_run.at)}`) : null);
  }

  // ------------------------------------------------------------ The steps
  const stepTypes = meta.steps.filter(s => s.kinds.includes(w.kind));
  const savedSentence = new Map((w.steps || []).map(s => [s.id, s.sentence]));
  function drawSteps() {
    mid.innerHTML = '';
    const steps = st.def.steps;
    mid.append(h('h4', {}, 'Steps'));
    if (!steps.length) mid.append(empty('No steps yet. Add the first one.'));
    const ol = h('ol', { class: 'fp-stepcards' });
    steps.forEach((s, i) => {
      const t = meta.stepTypes.get(s.type);
      const conds = [...(s.when?.tags || []).map(x => `tag ${x}`), ...(s.when?.groups || []).map(g => `in ${groupName.get(String(g)) || 'a group'}`), s.when?.os ? `on ${s.when.os}` : null].filter(Boolean);
      const move = d => { const j = i + d; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; st.sel = j; markDirty(); drawSteps(); drawSide(); };
      const remove = () => { steps.splice(i, 1); st.sel = Math.max(0, Math.min(st.sel, steps.length - 1)); markDirty(); drawSteps(); drawSide(); toast(`${t.title} removed`); };
      const li = h('li', { class: `fp-stepcard ar-${t.area}${i === st.sel ? ' cur' : ''}`, tabindex: '0', role: 'button', 'aria-pressed': i === st.sel ? 'true' : 'false',
        onclick: () => { st.sel = i; drawSteps(); drawSide(); }, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); st.sel = i; drawSteps(); drawSide(); } } },
      h('span', { class: 'fp-stepnum' }, String(i + 1)),
      h('div', { class: 'grow' },
        h('b', {}, t.title),
        h('p', { class: 'small muted' }, st.touched.has(s.id) || !savedSentence.has(s.id) ? t.text : savedSentence.get(s.id)),
        h('div', { class: 'row fp-stepchips' },
          s.onFailure !== 'host' ? h('span', { class: 'chip' }, s.onFailure === 'run' ? 'Fails: the run stops' : 'Fails: goes on') : null,
          conds.length ? h('span', { class: 'chip' }, `Only ${conds.join(', ')}`) : null)),
      mayChange ? h('div', { class: 'fp-stepbtns' },
        h('button', { type: 'button', class: 'btn icon ghost', title: 'Earlier', 'aria-label': 'Move earlier', disabled: i === 0, html: I.up, onclick: e => { e.stopPropagation(); move(-1); } }),
        h('button', { type: 'button', class: 'btn icon ghost', title: 'Later', 'aria-label': 'Move later', disabled: i === steps.length - 1, html: I.down, onclick: e => { e.stopPropagation(); move(1); } })) : null);
      if (mayChange) li.addEventListener('contextmenu', e => contextMenu(e, [
        { label: 'Move earlier', icon: I.up, disabled: i === 0, onClick: () => move(-1) },
        { label: 'Move later', icon: I.down, disabled: i === steps.length - 1, onClick: () => move(1) },
        '-', { label: `Remove ${t.title}`, icon: I.trash, danger: true, onClick: remove }], t.title));
      li._remove = remove;
      ol.append(li);
    });
    mid.append(ol);
    if (mayChange) mid.append(addStep());
  }

  function addStep() {
    const wrap = h('div', { class: 'features' });
    const menu = h('div', { class: 'featmenu hidden' }, stepTypes.map(t => h('button', { type: 'button', class: `featitem ar-${t.area}`, onclick: () => {
      const s = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type: t.id, values: {}, onFailure: 'host', when: { tags: [], groups: [], os: '' } };
      st.def.steps.push(s); st.sel = st.def.steps.length - 1; markDirty(); drawSteps(); drawSide();
    } }, h('b', {}, t.title), h('span', {}, t.text))));
    wrap.append(h('button', { type: 'button', class: 'btn addfeat', html: `${I.plus}<span>Add a step</span>`, onclick: () => menu.classList.toggle('hidden') }), menu);
    return wrap;
  }

  // ------------------------------------------------------------ The chosen step
  function drawSide() {
    side.innerHTML = '';
    const s = st.def.steps[st.sel];
    if (!s) { side.append(h('div', { class: 'side-body' }, empty('Choose a step to see what it does.'))); return; }
    const t = meta.stepTypes.get(s.type), ro = !mayChange;
    s.when ??= { tags: [], groups: [], os: '' };
    const touch = () => { st.touched.add(s.id); markDirty(); const card = mid.querySelectorAll('.fp-stepcard')[st.sel]; if (card) card.querySelector('p').textContent = t.text; };
    const fails = select(ON_FAILURE, s.onFailure, { disabled: ro, onchange: e => { s.onFailure = e.target.value; touch(); drawSteps(); } });
    const tags = input({ value: (s.when.tags || []).join(', '), disabled: ro, placeholder: 'All hosts', oninput: e => { s.when.tags = e.target.value.split(/[\s,]+/).filter(Boolean); touch(); } });
    const os = input({ value: s.when.os || '', disabled: ro, placeholder: 'Debian', oninput: e => { s.when.os = e.target.value.trim(); touch(); } });
    const gsel = h('select', { class: 'input', multiple: true, size: Math.min(5, Math.max(3, groups.length)), disabled: ro, onchange: e => { s.when.groups = [...e.target.selectedOptions].map(o => o.value); touch(); drawSteps(); } },
      groups.map(([v, n]) => h('option', { value: v, selected: (s.when.groups || []).map(String).includes(String(v)) }, n)));
    side.append(
      h('div', { class: 'side-head' }, h('span', { class: `fp-stepnum ar-${t.area}` }, String(st.sel + 1)), h('div', {}, h('div', { class: 'fp-side-title' }, t.title), h('div', { class: 'small muted' }, meta.areas.get(t.area)?.title || ''))),
      h('div', { class: 'side-body' },
        h('p', { class: 'small muted' }, t.text),
        t.fields.length ? renderFields(t.fields, s.values, touch, { readOnly: ro }) : h('p', { class: 'small muted' }, 'This step has nothing to set.'),
        h('h4', {}, 'When it fails'), fails,
        h('details', { class: 'fp-vars small', open: !!((s.when.tags || []).length || (s.when.groups || []).length || s.when.os) }, h('summary', {}, 'Only for some hosts'),
          field('With one of these tags', tags), groups.length ? field('In one of these groups', gsel) : null, field('With this system (name or version)', os, 'Like Debian, Ubuntu or 12. Empty: every system.')),
        mayChange ? h('div', { class: 'row', style: { marginTop: '14px' } }, btn(`Remove ${t.title}`, 'trash', () => mid.querySelectorAll('.fp-stepcard')[st.sel]?._remove(), 'ghost danger')) : null));
  }

  async function save() {
    const r = await call(() => api.put(`/api/workflows/${w.id}`, { name: st.name, description: st.description, enabled: st.enabled, definition: st.def })).catch(() => null);
    if (!r) return false;
    st.dirty = false; toast('Workflow saved');
    ctx.rerender();
    return true;
  }

  async function runNow() {
    if (st.dirty) { toast('Save the workflow first.'); return; }
    const list = await get(`/api/workflows/${w.id}/targets`);
    if (!list.length) { toast(w.kind === 'takeover' ? 'No host waits for a take-over in its targets.' : 'No managed host is in its targets.'); return; }
    const check = h('input', { type: 'checkbox' });
    const r = await dialog(`Run ${w.name}`, [
      h('p', {}, `On ${plural(list.length, 'host', 'hosts')}: ${list.slice(0, 8).map(x => x.name).join(', ')}${list.length > 8 ? ', …' : ''}.`),
      h('ol', { class: 'small muted fp-steps-preview' }, w.steps.map(s => h('li', {}, s.sentence))),
      w.kind === 'maintain' ? h('label', { class: 'row small fp-check' }, check, 'Only check: show what would change, change nothing') : null,
      meta.access.needsApproval || st.def.approval === 'always' ? h('p', { class: 'small fp-note' }, 'This run waits for an approval before it starts.') : null
    ], { ok: 'Start the run', onOk: () => call(() => api.post(`/api/workflows/${w.id}/run`, { hostIds: list.map(x => x.id), checkOnly: check.checked })) });
    if (r?.id) location.hash = `#/runs/${r.id}`;
  }

  summary(); drawHow(); drawSteps(); drawSide();
}
