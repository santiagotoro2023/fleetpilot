// FleetPilot: the overview. The state of the fleet at a glance, and below only what needs someone.
import { h } from '../core/ui.js';
import { statTiles } from '../lib/stats.js';
import { main, get, can, pageHead, link, table, runState, when, plural, empty, hostState } from '../common.js';

export async function viewOverview(ctx) {
  document.title = 'Overview';
  let page = build(await get('/api/overview'));
  main.append(page);
  // Fresh numbers every 15 seconds while the page is open, in place
  const t = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    const d = await get('/api/overview').catch(() => null);
    if (!d || !page.isConnected) return;
    const top = main.scrollTop, next = build(d);
    page.replaceWith(next); page = next; main.scrollTop = top;
  }, 15000);
  ctx.onLeave(() => clearInterval(t));
}

function build(d) {
  const c = d.counts, a = d.attention;
  const page = h('div', { class: 'page' });
  page.append(pageHead('Overview', 'How the fleet is doing, and what needs you.'));
  if (!c.hosts && can('hosts', 'manage')) {
    page.append(h('div', { class: 'subcard fp-start' },
      h('h2', {}, 'Start with your hosts'),
      h('p', { class: 'muted' }, 'Add hosts by address, a list or a range, or let FleetPilot find the VMs of a Proxmox cluster. Then take them over: FleetPilot logs in once with the password of your installation and manages them with certificates from then on.'),
      h('div', { class: 'row' }, link('Add hosts', '#/hosts?add=1', 'plus', 'primary'), link('Connect a Proxmox cluster', '#/hosts?tab=sources', 'sync'))));
  }
  const tiles = [
    { value: c.hosts ?? 0, label: 'hosts' },
    { value: c.managed ?? 0, label: 'managed', state: c.managed && c.managed === c.hosts ? 'ok' : undefined },
    { value: c.waiting ?? 0, label: 'not taken over' },
    { value: c.unreachable ?? 0, label: 'unreachable', state: c.unreachable ? 'bad' : undefined },
    { value: c.drifted ?? 0, label: 'drifted', state: c.drifted ? 'bad' : undefined },
    { value: c.running ?? 0, label: 'runs going' },
    { value: c.approvals ?? 0, label: 'waiting for approval', state: c.approvals ? 'bad' : undefined },
    { value: c.failed ?? 0, label: 'failed today', state: c.failed ? 'bad' : undefined }
  ];
  page.append(statTiles(tiles));
  const section = (title, rows, emptyText) => [h('h2', { class: 'fp-sec' }, title), ...(rows.length ? rows : [empty(emptyText)])];
  const runRow = r => h('tr', {}, h('td', {}, h('a', { href: `#/runs/${r.id}` }, r.name)), h('td', {}, runState(r.status)), h('td', {}, r.done !== undefined ? `${r.done} of ${plural(r.hosts, 'host', 'hosts')}` : plural(r.hosts ?? 0, 'host', 'hosts')), h('td', { class: 'muted' }, r.requested_by || ''), h('td', { class: 'muted' }, when(r.finished_at || r.started_at || r.created_at)));
  const nothing = !a.approvals.length && !a.running.length && !a.failedRuns.length && !a.unreachable.length && !a.drifted.length && !a.notTakenOver.length;
  if (nothing && c.hosts) page.append(h('div', { class: 'done-banner fp-allgood' }, 'All is well: nothing needs you right now.'));
  if (a.approvals.length) page.append(...section('Waiting for an approval', [table(['Run', 'State', 'Hosts', 'Started by', 'When'], a.approvals.map(runRow))]));
  if (a.running.length) page.append(...section('Running now', [table(['Run', 'State', 'Progress', 'Started by', 'Since'], a.running.map(runRow))]));
  if (a.failedRuns.length) page.append(...section('Failed in the last 7 days', [table(['Run', 'State', 'Hosts', '', 'Finished'], a.failedRuns.map(r => runRow({ ...r, hosts: Object.values(r.summary || {}).reduce((x, y) => x + y, 0) })))]));
  if (a.unreachable.length) page.append(...section('Unreachable hosts', [table(['Host', 'Address', 'Last seen'], a.unreachable.map(x => h('tr', {}, h('td', {}, h('a', { href: `#/hosts/${x.id}` }, x.name)), h('td', { class: 'mono' }, x.address), h('td', { class: 'muted' }, when(x.last_seen_at)))))]));
  if (a.drifted.length) page.append(...section('Hosts that drifted from their desired state', [table(['Host', 'Differences', 'Checked'], a.drifted.map(x => h('tr', {}, h('td', {}, h('a', { href: `#/hosts/${x.id}?tab=state` }, x.name)), h('td', {}, String(x.changed)), h('td', { class: 'muted' }, when(x.at)))))]));
  if (a.notTakenOver.length) page.append(...section('Not taken over yet', [table(['Host', 'Address', 'State', 'Added'], a.notTakenOver.map(x => h('tr', {}, h('td', {}, h('a', { href: `#/hosts/${x.id}` }, x.name)), h('td', { class: 'mono' }, x.address), h('td', {}, hostState(x.state)), h('td', { class: 'muted' }, when(x.created_at)))))]));
  return page;
}
