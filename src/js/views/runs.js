// FleetPilot: runs. The list (going, waiting for an approval, finished), and a run's page: which
// host is at which step (a host × step grid), approval, cancelling, running again, and the live log.
import { h, toast } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { main, get, call, can, pageHead, btn, tabs, dialog, field, input, select, table, empty, when, duration, plural, runState, runStateText } from '../common.js';

const TRIGGERS = { manual: 'Started by hand', schedule: 'On its schedule', host_added: 'A host was added', template_changed: 'A template changed', api: 'Through the API' };
const ACTIVE = ['queued', 'running', 'awaiting_approval', 'waiting'];
const MARK = { ok: I.check, changed: I.check, failed: I.x, unreachable: I.x, skipped: I.minus, running: I.timer, pending: '' };

export async function viewRuns(ctx) {
  document.title = 'Runs';
  const q = ctx.query;
  const tab = q.workflow || q.host ? 'all' : q.tab || ctx.store.prefs['runs.tab'] || 'all';
  const page = h('div', { class: 'page' });
  page.append(pageHead('Runs', 'Every time a workflow ran or runs: on which hosts, by whom, and what happened.', [
    can('runs', 'run') ? h('a', { class: 'btn primary', href: '#/hosts?tab=table' }, 'Start a run on hosts') : null
  ].filter(Boolean)));
  if (q.workflow || q.host) page.append(h('p', { class: 'small muted' }, q.workflow ? 'Runs of one workflow. ' : 'Runs on one host. ', h('a', { href: '#/runs' }, 'Show all runs')));
  const body = h('div', {});
  page.append(tabs([['all', 'All'], ['active', 'Going'], ['waiting', 'Waiting for approval'], ['failed', 'Failed']], tab, id => { ctx.store.setPref('runs.tab', id); draw(id); }), body);
  main.append(page);
  let timer;
  ctx.onLeave(() => clearInterval(timer));
  const draw = async id => {
    clearInterval(timer);
    body.innerHTML = '';
    const params = new URLSearchParams();
    if (id === 'active') params.set('active', '1');
    if (id === 'waiting') params.set('waiting', '1');
    if (id === 'failed') params.set('status', 'failed');
    if (q.workflow) params.set('workflow', q.workflow);
    if (q.host) params.set('host', q.host);
    const box = h('div', {});
    body.append(box);
    let rows = await get(`/api/runs?${params}`);
    const paint = () => {
      box.innerHTML = '';
      if (!rows.length) { box.append(empty(id === 'waiting' ? 'No run waits for an approval.' : id === 'active' ? 'Nothing runs right now.' : 'No runs yet. Start a workflow on hosts, or let a schedule start one.')); return; }
      box.append(runTable(rows));
      if (rows.length % 50 === 0) box.append(h('div', { class: 'row', style: { marginTop: '10px' } }, btn('Show older runs', 'down', async () => {
        const p = new URLSearchParams(params); p.set('before', rows[rows.length - 1].id);
        rows = rows.concat(await get(`/api/runs?${p}`)); paint();
      }, 'ghost')));
    };
    paint();
    // Fresh states while something runs
    timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !rows.some(r => ACTIVE.includes(r.status))) return;
      const fresh = await api.get(`/api/runs?${params}`).catch(() => null);
      if (fresh && box.isConnected) { rows = fresh; paint(); }
    }, 4000);
  };
  await draw(tab);
}

export function runTable(rows) {
  return table(['Run', 'State', 'Why', 'Hosts', 'By', 'When', 'Took'], rows.map(r => h('tr', {},
    h('td', {}, h('a', { href: `#/runs/${r.id}` }, r.name), r.check_only ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, 'check only') : null),
    h('td', {}, runState(r.status)), h('td', { class: 'muted' }, TRIGGERS[r.trigger] || r.trigger),
    h('td', { title: r.host_names || '' }, r.hosts === 1 ? r.host_names : plural(r.hosts, 'host', 'hosts')),
    h('td', {}, r.requested_by || 'FleetPilot'), h('td', { class: 'muted' }, when(r.created_at)),
    h('td', { class: 'muted' }, r.started_at ? duration(r.started_at, r.finished_at) : '–'))));
}

// ---------------------------------------------------------------- One run
export async function viewRun(ctx, id) {
  let r = await get(`/api/runs/${id}`);
  document.title = r.name;
  const page = h('div', { class: 'page fp-page-wide' });
  const head = h('div', {}), grid = h('div', {}), logBox = h('div', {});
  page.append(h('p', { class: 'fp-crumb small' }, h('a', { href: '#/runs' }, 'Runs'), ' / '), head, grid, logBox);
  main.append(page);

  const paintHead = () => {
    head.innerHTML = '';
    const may = r.may;
    const finished = !ACTIVE.includes(r.status);
    head.append(pageHead(r.name, null, [
      may.approve ? btn('Approve', 'check', () => act('approve'), 'primary') : null,
      may.approve || (may.cancel && ['awaiting_approval', 'waiting'].includes(r.status)) ? btn('Reject', 'x', async () => {
        const reason = input({ placeholder: 'Why not' });
        if (await dialog('Reject this run', [field('Reason', reason, 'The person who started it sees it.')], { ok: 'Reject the run', okClass: 'danger', onOk: () => call(() => api.post(`/api/runs/${r.id}/reject`, { reason: reason.value })) })) refresh();
      }) : null,
      may.cancel && !['awaiting_approval', 'waiting'].includes(r.status) ? btn('Cancel the run', 'stop', async () => {
        if (await dialog('Cancel this run', [h('p', {}, 'The step that runs now ends on every host; no further step starts. What was changed stays changed.')], { ok: 'Cancel the run', okClass: 'danger', cancel: 'Let it run', onOk: () => call(() => api.post(`/api/runs/${r.id}/cancel`, {})) })) refresh();
      }, 'ghost') : null,
      finished && may.retry ? btn('Run it again', 'reset', () => retry(false)) : null,
      finished && may.retry && r.hosts.some(x => ['failed', 'unreachable', 'skipped'].includes(x.status)) ? btn('Again on the failed hosts', 'reset', () => retry(true), 'ghost') : null,
      r.workflow_id ? h('a', { class: 'btn ghost', href: `#/automate/workflow/${r.workflow_id}` }, 'The workflow') : null
    ].filter(Boolean)));
    const counts = {};
    for (const x of r.hosts) counts[x.status] = (counts[x.status] || 0) + 1;
    head.append(h('div', { class: 'row fp-runmeta' }, runState(r.status), r.check_only ? h('span', { class: 'chip' }, 'Only a check: nothing was changed') : null,
      h('span', { class: 'small muted' }, `${TRIGGERS[r.trigger] || r.trigger}${r.requested_by ? ` by ${r.requested_by}` : ''}, ${when(r.created_at)}`),
      r.approved_by ? h('span', { class: 'small muted' }, `${r.status === 'rejected' ? 'Rejected' : 'Approved'} by ${r.approved_by}`) : null,
      r.started_at ? h('span', { class: 'small muted' }, `${finished ? 'Took' : 'Running for'} ${duration(r.started_at, r.finished_at)}`) : null,
      ...Object.entries(counts).map(([k, n]) => h('span', { class: `fp-state ${k === 'ok' || k === 'changed' ? 'ok' : k === 'failed' || k === 'unreachable' ? 'bad' : k === 'running' ? 'busy' : 'idle'}` }, `${n} ${runStateText(k).toLowerCase()}`))));
    if (r.reason) head.append(h('p', { class: 'fp-note' }, `Reason: ${r.reason}`));
    if (['awaiting_approval', 'waiting'].includes(r.status)) head.append(h('div', { class: 'fp-note fp-waitnote' }, r.status === 'awaiting_approval'
      ? (r.may.approve ? 'This run waits for your approval. Look at the steps and the hosts, then approve or reject it.' : 'This run waits for an approval by someone whose roles allow it.')
      : (r.may.approve ? 'The run stopped at an approval step and waits for you.' : 'The run stopped at an approval step and waits for someone to approve it.')));
  };

  const paintGrid = () => {
    grid.innerHTML = '';
    const res = new Map(r.results.map(x => [`${x.step}:${x.host_id}`, x]));
    const batches = new Set(r.hosts.map(x => x.batch)).size;
    const cur = r.state?.step;
    grid.append(h('h2', { class: 'fp-sec' }, 'Hosts and steps'));
    grid.append(h('div', { class: 'fp-tablewrap' }, h('table', { class: 'tbl fp-table fp-matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Host'), batches > 1 ? h('th', {}, 'Batch') : null, r.steps.map((s, i) => h('th', { title: s.sentence, class: `ar-${s.area}${ACTIVE.includes(r.status) && cur === i ? ' cur' : ''}` }, h('span', { class: 'fp-thnum' }, String(i + 1)), ' ', s.title)), h('th', {}, 'Result'))),
      h('tbody', {}, r.hosts.map(x => h('tr', {},
        h('td', {}, h('a', { href: `#/hosts/${x.id}` }, x.name), h('div', { class: 'small muted mono' }, x.address || '')),
        batches > 1 ? h('td', { class: 'muted' }, String(x.batch + 1)) : null,
        r.steps.map((s, i) => { const c = res.get(`${i}:${x.id}`); const stt = c?.status || 'pending'; return h('td', { class: `fp-cell st-${stt}`, title: `${s.title}: ${runStateText(stt)}${c?.message ? `. ${c.message}` : ''}` }, h('span', { class: 'fp-mark', 'aria-hidden': 'true', html: MARK[stt] || '' }), c?.message ? h('span', { class: 'fp-cellmsg' }, c.message) : null); }),
        h('td', {}, runState(x.status))))))));
    grid.append(h('details', { class: 'fp-vars small' }, h('summary', {}, 'What each step does'), h('ol', { class: 'fp-steps-preview' }, r.steps.map(s => h('li', {}, h('b', {}, s.title), `: ${s.sentence}`, s.onFailure === 'run' ? ' If it fails, the run stops.' : s.onFailure === 'continue' ? ' If it fails, the host goes on.' : '')))));
  };

  // ------------------------------------------------------------ The live log
  let after = '0', hostFilter = '';
  const pre = h('pre', { 'aria-live': 'polite' });
  const follow = h('input', { type: 'checkbox', checked: true });
  const hostSel = select([['', 'Every host'], ...r.hosts.map(x => [x.name, x.name])], '', { onchange: e => { hostFilter = e.target.value; after = '0'; pre.innerHTML = ''; pullLog(); } });
  logBox.append(h('h2', { class: 'fp-sec' }, 'Log'), h('div', { class: 'row fp-logbar' }, hostSel, h('label', { class: 'row small fp-check' }, follow, 'Follow the newest lines'),
    btn('Download the log', 'download', async () => {
      const all = await get(`/api/runs/${r.id}/log?after=0`);
      const text = all.lines.map(l => `${new Date(l.at).toISOString()} ${l.host || '-'} [${l.level}] ${l.line}`).join('\n');
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `fleetpilot-run-${r.id}.log` }); document.body.append(a); a.click(); a.remove();
    }, 'ghost')), h('div', { class: 'console fp-log' }, pre));
  const fmt = l => h('span', { class: `lg-${l.level}` }, `${new Date(l.at).toLocaleTimeString(undefined, { hour12: false })}  ${l.host ? `${l.host.padEnd(14)} ` : ''}${l.line}\n`);
  let pulling = false;
  async function pullLog() {
    if (pulling) return;
    pulling = true;
    try {
      const d = await api.get(`/api/runs/${r.id}/log?after=${after}${hostFilter ? `&host=${encodeURIComponent(hostFilter)}` : ''}`);
      if (d.lines.length) {
        after = d.lines[d.lines.length - 1].id;
        pre.append(...d.lines.map(fmt));
        if (follow.checked) pre.scrollTop = pre.scrollHeight;
      }
      if (!pre.childNodes.length && !d.lines.length) pre.textContent = ACTIVE.includes(r.status) ? 'Nothing logged yet.\n' : 'This run logged nothing.\n';
      else if (pre.firstChild?.nodeType === 3) pre.firstChild.remove();
    } catch { /* the next pull tries again */ }
    pulling = false;
  }

  async function refresh() {
    const fresh = await api.get(`/api/runs/${r.id}`).catch(() => null);
    if (!fresh || !page.isConnected) return;
    r = fresh; paintHead(); paintGrid();
  }
  async function act(what) { await call(() => api.post(`/api/runs/${r.id}/${what}`, {})).catch(() => null); toast(what === 'approve' ? 'Approved: the run starts' : 'Done'); refresh(); }
  async function retry(failedOnly) {
    const n = await call(() => api.post(`/api/runs/${r.id}/retry`, { failedOnly })).catch(() => null);
    if (n?.id) location.hash = `#/runs/${n.id}`;
  }

  paintHead(); paintGrid(); await pullLog();
  const t1 = setInterval(() => { if (document.visibilityState === 'visible' && ACTIVE.includes(r.status)) pullLog(); }, 1500);
  const t2 = setInterval(() => { if (document.visibilityState === 'visible' && ACTIVE.includes(r.status)) refresh().then(() => { if (!ACTIVE.includes(r.status)) pullLog(); }); }, 3000);
  ctx.onLeave(() => { clearInterval(t1); clearInterval(t2); });
}
