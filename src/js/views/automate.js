// FleetPilot: automation. Workflows (take-over and maintenance: what runs, when, how), templates
// (the desired state, built from settings) and the catalog of every setting a template can hold.
import { h } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { main, meta, get, call, can, pageHead, btn, tabs, dialog, field, input, empty, when, plural, bands, runState } from '../common.js';

const TRIGGER_TEXT = {
  manual: () => 'When someone starts it',
  schedule: t => `On a schedule: ${cronText(t.cron)}`,
  host_added: () => 'When a host is added',
  template_changed: () => 'When a template gets a new version'
};
export const triggerText = t => (TRIGGER_TEXT[t?.type] || TRIGGER_TEXT.manual)(t || {});

/** A five-field cron line in words, for the common cases; the line itself otherwise */
export function cronText(cron) {
  const p = String(cron || '').trim().split(/\s+/);
  if (p.length !== 5) return cron || '';
  const [mi, ho, dom, mo, dow] = p;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const time = /^\d+$/.test(mi) && /^\d+$/.test(ho) ? `${ho.padStart(2, '0')}:${mi.padStart(2, '0')} UTC` : null;
  if (time && dom === '*' && mo === '*' && dow === '*') return `every day at ${time}`;
  if (time && dom === '*' && mo === '*' && /^[0-6]$/.test(dow)) return `every ${days[Number(dow)]} at ${time}`;
  if (time && dom === '*' && mo === '*' && dow === '1-5') return `on weekdays at ${time}`;
  if (time && /^\d+$/.test(dom) && mo === '*' && dow === '*') return `on day ${dom} of every month at ${time}`;
  if (/^\d+$/.test(mi) && ho === '*' && dom === '*' && mo === '*' && dow === '*') return `every hour at minute ${mi}`;
  if (/^\*\/\d+$/.test(mi) && ho === '*' && dom === '*' && mo === '*' && dow === '*') return `every ${mi.slice(2)} minutes`;
  return cron;
}

export async function viewAutomate(ctx, tab) {
  document.title = 'Automate';
  tab = ['workflows', 'templates', 'catalog'].includes(tab) ? tab : ctx.store.prefs['automate.tab'] || 'workflows';
  const page = h('div', { class: 'page' });
  const mayChange = can('automation', 'change');
  page.append(pageHead('Automate', 'Templates say what a host should look like; workflows say what runs, on which hosts and when.', [
    mayChange ? btn('New workflow', 'plus', () => newWorkflow(), 'primary') : null,
    mayChange ? btn('New template', 'plus', () => { location.hash = '#/automate/template/new'; }) : null
  ].filter(Boolean)));
  const body = h('div', {});
  page.append(tabs([['workflows', 'Workflows'], ['templates', 'Templates'], ['catalog', 'What templates can set']], tab, id => { ctx.store.setPref('automate.tab', id); history.replaceState(null, '', `#/automate/${id}`); draw(id); }), body);
  main.append(page);
  const draw = async id => {
    body.innerHTML = '';
    if (id === 'templates') await drawTemplates(body);
    else if (id === 'catalog') drawCatalog(body);
    else await drawWorkflows(body);
  };
  await draw(tab);
}

// ---------------------------------------------------------------- Workflows
async function drawWorkflows(body) {
  const list = await get('/api/workflows');
  const section = (kind, title, text) => {
    const items = list.filter(w => w.kind === kind);
    body.append(h('h2', { class: 'fp-sec' }, title), h('p', { class: 'muted small' }, text));
    if (!items.length) { body.append(empty('None yet.')); return; }
    body.append(h('div', { class: 'cardgrid' }, items.map(wfTile)));
  };
  section('takeover', 'Take-over workflows', 'Run once on a new host: they log in with the login of your installation and make FleetPilot its manager. From then on FleetPilot logs in with certificates.');
  section('maintain', 'Maintenance workflows', 'Run on managed hosts: by hand, on a schedule, or when something changes.');
}

function wfTile(w) {
  return h('a', { class: `tile fp-wf${w.enabled ? '' : ' fp-off'}`, href: `#/automate/workflow/${w.id}` },
    h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('span', { class: 'pico', html: w.kind === 'takeover' ? I.key : I.flow }), h('h3', { style: { margin: 0 } }, w.name)),
    bands(w.steps.map(s => s.area)),
    h('p', { class: 'muted small' }, w.description || `${plural(w.steps.length, 'step', 'steps')}.`),
    h('ol', { class: 'fp-steplist small' }, w.steps.slice(0, 5).map(s => h('li', {}, s.title)), w.steps.length > 5 ? h('li', { class: 'muted' }, `and ${w.steps.length - 5} more`) : null),
    h('div', { class: 'small muted fp-wf-meta' },
      h('span', {}, w.enabled ? triggerText(w.definition.trigger) : 'Switched off'),
      w.next_at && w.enabled ? h('span', {}, `next ${new Date(w.next_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`) : null,
      w.last_run ? h('span', {}, 'last ', runState(w.last_run.status)) : null));
}

async function newWorkflow() {
  let kind = 'maintain';
  const name = input({ placeholder: 'Monthly updates' });
  const desc = input({ placeholder: 'What it is for' });
  const choice = h('div', { class: 'fp-kind' });
  const draw = () => {
    choice.innerHTML = '';
    for (const [k, t, x] of [['takeover', 'Take-over', 'For new hosts: log in with a password once, make FleetPilot the manager.'], ['maintain', 'Maintenance', 'For managed hosts: apply, update, rotate, reboot, check.']]) {
      choice.append(h('button', { type: 'button', class: `fp-kindbtn${kind === k ? ' cur' : ''}`, 'aria-pressed': kind === k ? 'true' : 'false', onclick: () => { kind = k; draw(); } }, h('b', {}, t), h('span', { class: 'small muted' }, x)));
    }
  };
  draw();
  const r = await dialog('New workflow', [field('Kind', choice), field('Name', name), field('Description', desc)], {
    ok: 'Create the workflow', onOk: () => call(() => api.post('/api/workflows', { name: name.value, description: desc.value, kind }))
  });
  if (r?.id) location.hash = `#/automate/workflow/${r.id}`;
}

// ---------------------------------------------------------------- Templates
async function drawTemplates(body) {
  const list = await get('/api/templates');
  if (!list.length) { body.append(empty('No templates yet. A template is a desired state built from settings: users, packages, services, firewall rules and more.')); return; }
  const active = list.filter(t => !t.archived), archived = list.filter(t => t.archived);
  const tile = t => {
    const settings = t.definition?.settings || [];
    const areas = settings.map(s => meta.types.get(s.type)?.area).filter(Boolean);
    return h('a', { class: `tile${t.archived ? ' fp-off' : ''}`, href: `#/automate/template/${t.id}` },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('span', { class: 'pico', html: I.doc }), h('h3', { style: { margin: 0 } }, t.name)),
      bands(areas),
      h('p', { class: 'muted small' }, t.description || `${plural(settings.length, 'setting', 'settings')}.`),
      h('div', { class: 'row' }, settings.slice(0, 6).map(s => h('span', { class: 'chip' }, meta.types.get(s.type)?.title || s.type)), settings.length > 6 ? h('span', { class: 'small muted' }, `+${settings.length - 6}`) : null),
      h('div', { class: 'small muted fp-wf-meta' }, h('span', {}, `Version ${t.current_version}`), h('span', {}, t.assignments ? `applies in ${plural(t.assignments, 'place', 'places')}` : 'not in use'),
        t.behind ? h('span', { class: 'fp-state wait' }, `${plural(t.behind, 'host', 'hosts')} behind`) : null));
  };
  body.append(h('div', { class: 'cardgrid' }, active.map(tile)));
  if (archived.length) body.append(h('details', { class: 'sect', style: { marginTop: '20px' } }, h('summary', {}, `Archived (${archived.length})`), h('div', { class: 'sect-body' }, h('div', { class: 'cardgrid' }, archived.map(tile)))));
}

// ---------------------------------------------------------------- The catalog
function drawCatalog(body) {
  const find = input({ type: 'search', class: 'input fp-find', placeholder: 'Find a setting: nginx, firewall, users …', 'aria-label': 'Find a setting' });
  const out = h('div', {});
  const draw = () => {
    out.innerHTML = '';
    const q = find.value.trim().toLowerCase();
    for (const a of meta.catalog.areas) {
      const types = meta.catalog.types.filter(t => t.area === a.id && (!q || `${t.title} ${t.text} ${t.id}`.toLowerCase().includes(q)));
      if (!types.length) continue;
      out.append(h('div', { class: 'fp-areahead' }, h('i', { class: `bg-${a.id}` }), h('h2', {}, a.title), h('span', { class: 'muted small' }, a.text)),
        h('div', { class: 'cardgrid fp-catalog' }, types.map(t => h('article', { class: `tile ar-${a.id}` }, h('h3', {}, t.title), h('p', { class: 'muted small' }, t.text),
          h('div', { class: 'small muted' }, t.collect ? 'Rows from every template that applies are put together.' : 'The most specific template wins.')))));
    }
    if (!out.children.length) out.append(empty('No setting matches.'));
  };
  find.addEventListener('input', draw);
  body.append(h('p', { class: 'muted small' }, `${meta.catalog.types.length} settings in ${meta.catalog.areas.length} areas. Every one becomes plain Ansible tasks; you see the playbook of a template while you build it.`), h('div', { class: 'fp-toolbar' }, find), out);
  draw();
}

