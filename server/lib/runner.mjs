// FleetPilot: runs. A run is a snapshot of a workflow on chosen hosts. It goes through the job
// queue (library element jobs): hosts in batches, steps in order, a log line for everything, a
// result per host and step. Approvals pause it; any replica continues it.
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { log as serverLog } from '../core/log.mjs';
import { jobs } from './jobs.mjs';
import { record } from './audit.mjs';
import { runPlaybook } from './ansible.mjs';
import { normalizeValues } from './catalog.mjs';
import { STEP_TYPES } from './steps.mjs';
import { groupPaths, hostVars, loginFor, secretVars, publicKeys } from './hostctx.mjs';

const FINAL = ['succeeded', 'partial', 'failed', 'cancelled', 'rejected'];
const BAD = ['failed', 'unreachable'];

// ---------------------------------------------------------------- Workflow definitions
export const TRIGGERS = ['manual', 'schedule', 'host_added', 'template_changed'];

/** A workflow definition, checked: { trigger, targets, batch, approval, steps } */
export function normalizeWorkflow(kind, def = {}) {
  if (!['takeover', 'maintain'].includes(kind)) throw httpError(400, 'bad_kind', 'A workflow is a take-over or a maintenance workflow.');
  const steps = Array.isArray(def.steps) ? def.steps : [];
  if (steps.length > 50) throw httpError(400, 'too_many', 'A workflow can have at most 50 steps.');
  const trigger = TRIGGERS.includes(def.trigger?.type) ? def.trigger.type : 'manual';
  const cron = String(def.trigger?.cron || '').trim();
  if (trigger === 'schedule' && !/^(\S+\s+){4}\S+$/.test(cron)) throw httpError(400, 'bad_schedule', 'A schedule needs five fields, for example 30 2 * * * (every night at 2:30 UTC).');
  const ids = list => (Array.isArray(list) ? list : []).map(String).filter(x => /^\d+$/.test(x)).slice(0, 200);
  const names = list => (Array.isArray(list) ? list : []).map(x => String(x).trim()).filter(x => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x)).slice(0, 50);
  return {
    trigger: { type: trigger, cron: trigger === 'schedule' ? cron : '' },
    targets: { groups: ids(def.targets?.groups), tags: names(def.targets?.tags) },
    batch: { size: Math.max(0, Math.min(1000, Math.round(Number(def.batch?.size) || 0))), unit: def.batch?.unit === 'percent' ? 'percent' : 'hosts' },
    approval: ['role', 'always'].includes(def.approval) ? def.approval : 'role',
    steps: steps.map((s, i) => {
      const t = STEP_TYPES.get(s?.type);
      if (!t) throw httpError(400, 'bad_step', `There is no step "${s?.type}".`);
      if (!t.kinds.includes(kind)) throw httpError(400, 'bad_step', `${t.title} is not a step of a ${kind === 'takeover' ? 'take-over' : 'maintenance'} workflow.`);
      return {
        id: /^[a-z0-9-]{4,40}$/.test(s.id || '') ? s.id : `s${i}-${Math.random().toString(36).slice(2, 8)}`,
        type: t.id, values: normalizeValues(t, s.values || {}, { partial: true }),
        onFailure: ['host', 'run', 'continue'].includes(s.onFailure) ? s.onFailure : 'host',
        when: { tags: names(s.when?.tags), groups: ids(s.when?.groups), os: String(s.when?.os || '').slice(0, 40) }
      };
    })
  };
}

// ---------------------------------------------------------------- Starting runs
/**
 * Starts a workflow (a workflows row) on hosts. by: the ctx of the request (or null for the
 * system), needsApproval: whether the run waits first. Returns the run id.
 */
export async function startRun({ workflow, hostIds, ctx = null, trigger = 'manual', checkOnly = false, needsApproval = false, params = {}, name }) {
  // Every step must be complete before anything runs
  for (const [i, st] of (workflow.definition.steps || []).entries()) {
    const t = STEP_TYPES.get(st.type);
    try { normalizeValues(t, st.values); } catch (e) { throw httpError(400, 'step_incomplete', `Step ${i + 1} (${t.title}): ${e.message.replace(/^[^:]+: /, '')}`); }
  }
  if (!(workflow.definition.steps || []).length) throw httpError(400, 'no_steps', 'This workflow has no steps yet.');
  const hosts = await query('select id, name, state from hosts where id = any($1::bigint[]) order by name', [hostIds]);
  if (!hosts.length) throw httpError(400, 'no_hosts', 'Choose at least one host.');
  if (hosts.length > 5000) throw httpError(400, 'too_many', 'A run can have at most 5000 hosts.');
  const def = workflow.definition;
  const size = def.batch?.size ? (def.batch.unit === 'percent' ? Math.max(1, Math.ceil(hosts.length * def.batch.size / 100)) : def.batch.size) : hosts.length;
  const waits = needsApproval || def.approval === 'always';
  const id = await tx(async c => {
    const [run] = (await c.query(`insert into runs (workflow_id, name, kind, definition, params, trigger, status, check_only, requested_by_id, requested_by, state)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [workflow.id || null, name || workflow.name, workflow.kind, JSON.stringify({ ...def, workflowVersion: workflow.version }), JSON.stringify(params), trigger, waits ? 'awaiting_approval' : 'queued',
      checkOnly, ctx?.user?.id || null, ctx?.user?.username || (trigger === 'manual' ? '' : 'FleetPilot'), JSON.stringify({ batch: 0, step: 0, approvals: {}, connections: {} })])).rows;
    for (const [i, h] of hosts.entries()) await c.query('insert into run_hosts (run_id, host_id, host_name, batch) values ($1, $2, $3, $4)', [run.id, h.id, h.name, Math.floor(i / size)]);
    return String(run.id);
  });
  await runLog(id, null, '', 'info', `${name || workflow.name} on ${hosts.length === 1 ? hosts[0].name : `${hosts.length} hosts`}${size < hosts.length ? `, in batches of ${size}` : ''}, started by ${ctx?.user?.username || 'FleetPilot'} (${trigger.replace('_', ' ')}).`);
  if (waits) await runLog(id, null, '', 'warn', 'Waiting for an approval before it starts.');
  else await enqueueRun(id);
  if (ctx) await record(ctx, 'run.started', { target: { type: 'run', id, name: name || workflow.name }, hosts: hosts.length, approval: waits });
  return id;
}

export async function enqueueRun(id) {
  const jobId = await jobs.enqueue('run.execute', { runId: String(id) }, { dedupeKey: `run:${id}` });
  await query('update runs set job_id = $2 where id = $1', [id, jobId]);
}

// ---------------------------------------------------------------- The log (buffered, written in batches)
let buffer = [], flushing = null;
export async function runLog(runId, step, host, level, line) {
  buffer.push([runId, step, host || '', level, String(line).slice(0, 4000)]);
  if (buffer.length >= 50) await flushLog();
  else if (!flushing) flushing = setTimeout(() => { flushLog().catch(() => {}); }, 300);
}
export async function flushLog() {
  clearTimeout(flushing); flushing = null;
  const rows = buffer; buffer = [];
  if (!rows.length) return;
  const params = [], values = rows.map((r, i) => { params.push(...r); return `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`; });
  await query(`insert into run_logs (run_id, step, host, level, line) values ${values.join(', ')}`, params);
}

// ---------------------------------------------------------------- Executing
/** One line about a change: a new file, lines added and removed, or a state that changed */
function diffLine(d) {
  const obj = t => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const b = obj(d.before), a = obj(d.after);
  if (b || a) {
    const keys = [...new Set([...Object.keys(b || {}), ...Object.keys(a || {})])].filter(k => k !== 'path' && JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k]));
    return keys.length ? `  ${d.path || (a || b).path || ''} ${keys.map(k => `${k}: ${b?.[k] ?? '–'} → ${a?.[k] ?? '–'}`).join(', ')}`.trimEnd() : '';
  }
  const lines = t => String(t || '').split('\n').filter(l => l !== '');
  const before = lines(d.before), after = lines(d.after);
  if (!before.length) return `  ${d.path}: new, ${after.length} lines`;
  const added = after.filter(l => !before.includes(l)).length, removed = before.filter(l => !after.includes(l)).length;
  return `  ${d.path}: ${added} lines added, ${removed} removed`;
}

function eventLine(e) {
  if (e.event === 'play') return ['info', `Play: ${e.name}`];
  if (e.event === 'result') {
    if (e.status === 'skipped') return ['skip', `skipped: ${e.task}`];
    if (e.status === 'ok') return ['ok', `ok: ${e.task}`];
    const extra = [e.msg, e.stderr].filter(Boolean).join('\n').trim();
    if (e.status === 'changed') {
      const diffs = (e.diff || []).map(diffLine).filter(Boolean).join('\n');
      return ['changed', `changed: ${e.task}${diffs ? `\n${diffs}` : ''}`];
    }
    if (e.ignored) return ['warn', `failed (ignored): ${e.task}${extra ? `\n${extra}` : ''}`];
    return ['error', `${e.status === 'unreachable' ? 'unreachable' : 'failed'}: ${e.task}${extra ? `\n${extra}` : ''}`];
  }
  if (e.event === 'warning') return ['warn', e.msg];
  if (e.event === 'line') return [/ERROR|FAILED/.test(e.line) ? 'error' : 'warn', e.line];
  return null;
}

/** Facts from a run become the host's facts in FleetPilot */
async function storeFacts(name, f) {
  if (!f) return;
  await query(`update hosts set facts = $2, os = $3, os_version = $4, last_seen_at = now() where lower(name) = lower($1)`,
    [name, JSON.stringify({ ...f, interfaces: undefined, collected: new Date().toISOString() }), f.distribution || '', f.distribution_version || '']);
}

async function execute(job) {
  const runId = job.payload.runId;
  const [run] = await query('select * from runs where id = $1', [runId]);
  if (!run || FINAL.includes(run.status) || run.status === 'awaiting_approval' || run.status === 'waiting') return { skipped: true };
  await query("update runs set status = 'running', started_at = coalesce(started_at, now()) where id = $1", [runId]);
  const state = run.state || {};
  state.connections = state.connections || {};
  state.approvals = state.approvals || {};
  const save = () => query('update runs set state = $2 where id = $1', [runId, JSON.stringify(state)]);
  const def = run.definition;
  const all = await query(`select h.*, rh.status as run_status, rh.batch from run_hosts rh join hosts h on h.id = rh.host_id where rh.run_id = $1 order by rh.batch, h.name`, [runId]);
  const batches = [...new Set(all.map(h => h.batch))].sort((a, b) => a - b);
  const keys = await publicKeys();
  const log = (step, host, level, line) => runLog(runId, step, host, level, line);

  // Hosts that cannot take part: wrong state for this kind of workflow
  for (const h of all) {
    if (h.run_status !== 'pending') continue;
    const okState = run.kind === 'takeover' ? h.state !== 'managed' || run.params?.again : ['managed', 'unreachable'].includes(h.state);
    if (!okState) {
      h.run_status = 'skipped';
      await query("update run_hosts set status = 'skipped' where run_id = $1 and host_id = $2", [runId, h.id]);
      await log(null, h.name, 'warn', run.kind === 'takeover' ? 'Skipped: FleetPilot manages this host already.' : 'Skipped: not taken over yet. Run a take-over workflow first.');
    } else if (run.kind === 'takeover') await query("update hosts set state = 'taking_over' where id = $1 and state <> 'managed'", [h.id]);
  }

  try {
    for (const b of batches.filter(x => x >= (state.batch || 0))) {
      const firstStep = b === state.batch ? state.step || 0 : 0;
      for (let i = firstStep; i < def.steps.length; i++) {
        if (job.signal.aborted) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
        const s = def.steps[i];
        const type = STEP_TYPES.get(s.type);
        state.batch = b; state.step = i;
        await save();
        if (s.type === 'approval') {
          const key = `${b}:${i}`;
          if (!state.approvals[key]) {
            await query("update runs set status = 'waiting' where id = $1", [runId]);
            await log(i, '', 'warn', `Waiting for an approval${s.values.message ? `: ${s.values.message}` : ''}.`);
            await flushLog();
            return { waiting: key };
          }
          continue;
        }
        let hosts = all.filter(h => h.batch === b && !['failed', 'unreachable', 'skipped'].includes(h.run_status));
        // Conditions of the step
        const paths = await groupPaths();
        const skip = hosts.filter(h => (s.when?.tags?.length && !s.when.tags.some(t => (h.tags || []).includes(t)))
          || (s.when?.groups?.length && !paths.path(h.group_id || 0).some(g => s.when.groups.includes(String(g.id))))
          || (s.when?.os && !`${h.os} ${h.os_version}`.toLowerCase().includes(s.when.os.toLowerCase())));
        for (const h of skip) {
          await query("insert into run_steps (run_id, step, host_id, status, message, finished_at) values ($1, $2, $3, 'skipped', 'The condition of the step does not match', now()) on conflict do nothing", [runId, i, h.id]);
        }
        hosts = hosts.filter(h => !skip.includes(h));
        if (!hosts.length) continue;
        await log(i, '', 'info', `Step ${i + 1}: ${type.title} on ${hosts.length === 1 ? hosts[0].name : `${hosts.length} hosts`}`);
        for (const h of hosts) {
          await query(`insert into run_steps (run_id, step, host_id, status, started_at) values ($1, $2, $3, 'running', now())
            on conflict (run_id, step, host_id) do update set status = 'running', started_at = now(), finished_at = null, message = ''`, [runId, i, h.id]);
          await query("update run_hosts set status = 'running' where run_id = $1 and host_id = $2", [runId, h.id]);
        }
        const outcome = new Map();
        const ctx = {
          run, index: i, values: s.values, hosts, state, signal: job.signal,
          log: (host, level, line) => log(i, host, level, line),
          save,
          done: (h, status, message = '') => { outcome.set(String(h.id), { status, message }); },
          failed: h => BAD.includes(outcome.get(String(h.id))?.status),
          finished: h => outcome.has(String(h.id)),
          rename: (h, name) => { h.name = name; },
          ansible: async ({ plays, hosts: hs = hosts, check = false, vars, secretVars: sv, withSecrets, onEvent }) => {
            if (!hs.length) return new Map();
            const gp = await groupPaths();
            const list = [];
            for (const h of hs) {
              const login = await loginFor(h, state);
              list.push({
                name: h.name, address: h.address, port: h.port, user: login.user, become: login.become, becomePassword: login.becomePassword, keyFile: login.keyFile, hostKeys: h.host_keys,
                vars: { ...(await hostVars(h, gp)), fp_ssh_public_key: keys.fleetKey, ...(vars ? vars(h) : {}) },
                secretVars: { ...(withSecrets && h.desired ? await secretVars(h, h.desired.merged) : {}), ...(sv ? sv(h) : {}) }
              });
            }
            const r = await runPlaybook({
              plays, hosts: list, check, signal: job.signal, hostCaPublic: keys.hostCa,
              onEvent: e => {
                const l = eventLine(e);
                if (l) log(i, e.host || '', l[0], l[1]);
                if (e.facts) storeFacts(e.host, e.facts).catch(() => {});
                onEvent?.(e);
              }
            });
            return r.results;
          }
        };
        try { await type.run(ctx); }
        catch (e) {
          if (e.cancelled || job.signal.aborted) throw e;
          await log(i, '', 'error', e.message || String(e));
          for (const h of hosts) if (!outcome.has(String(h.id))) outcome.set(String(h.id), { status: 'failed', message: e.message });
        }
        // Results of the step
        let stopRun = false;
        for (const h of hosts) {
          const o = outcome.get(String(h.id)) || { status: 'ok', message: '' };
          await query('update run_steps set status = $4, message = $5, finished_at = now() where run_id = $1 and step = $2 and host_id = $3', [runId, i, h.id, o.status, o.message.slice(0, 500)]);
          if (BAD.includes(o.status)) {
            if (o.message) await log(i, h.name, 'error', o.message);
            if (s.onFailure === 'continue') continue;
            h.run_status = o.status;
            await query('update run_hosts set status = $3 where run_id = $1 and host_id = $2', [runId, h.id, o.status]);
            if (o.status === 'unreachable' && run.kind === 'maintain') await query("update hosts set state = 'unreachable' where id = $1", [h.id]);
            if (s.onFailure === 'run') stopRun = true;
          } else {
            if (o.status === 'changed') h.changedAny = true;
            if (run.kind === 'maintain') await query("update hosts set state = 'managed', last_seen_at = now() where id = $1 and state = 'unreachable'", [h.id]);
          }
        }
        if (stopRun) { await log(i, '', 'error', 'The run stops here: this step failed and is set to stop the whole run.'); throw Object.assign(new Error('stopped'), { stopped: true }); }
      }
      state.batch = b + 1; state.step = 0;
      await save();
    }
  } catch (e) {
    if (!e.stopped && !e.cancelled && !job.signal.aborted) { await log(null, '', 'error', `The run stopped: ${e.message}`); serverLog.error('run failed', { run: runId, error: e.stack }); }
    if (e.cancelled || job.signal.aborted) {
      await query("update run_hosts set status = 'skipped' where run_id = $1 and status in ('pending', 'running')", [runId]);
      await finish(runId, 'cancelled', run);
      return { cancelled: true };
    }
  }
  // Every host still pending or running finished well
  for (const h of all) {
    if (['pending', 'running'].includes(h.run_status) || !h.run_status) {
      const st = h.changedAny ? 'changed' : 'ok';
      await query("update run_hosts set status = $3 where run_id = $1 and host_id = $2 and status in ('pending', 'running')", [runId, h.id, st]);
    }
    await query('update hosts set last_run_at = now() where id = $1', [h.id]);
  }
  const counts = (await query('select status, count(*)::int as n from run_hosts where run_id = $1 group by status', [runId])).reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  const good = (counts.ok || 0) + (counts.changed || 0), bad = (counts.failed || 0) + (counts.unreachable || 0) + (counts.pending || 0) + (counts.running || 0);
  await query("update run_hosts set status = 'failed' where run_id = $1 and status in ('pending', 'running')", [runId]);
  const status = bad && !good ? 'failed' : bad ? 'partial' : 'succeeded';
  if (run.kind === 'takeover') {
    await query("update hosts set state = 'failed' where id in (select host_id from run_hosts where run_id = $1 and status in ('failed', 'unreachable')) and state = 'taking_over'", [runId]);
    await query("update hosts set state = 'new' where id in (select host_id from run_hosts where run_id = $1 and status in ('ok', 'changed', 'skipped')) and state = 'taking_over'", [runId]);
  }
  await finish(runId, status, run, counts);
  return { status, counts };
}

async function finish(runId, status, run, counts) {
  const c = counts || (await query('select status, count(*)::int as n from run_hosts where run_id = $1 group by status', [runId])).reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  await query('update runs set status = $2, finished_at = now(), summary = $3 where id = $1', [runId, status, JSON.stringify(c)]);
  const words = { succeeded: 'Finished: every host is done.', partial: 'Finished, but not on every host.', failed: 'Failed.', cancelled: 'Cancelled.' };
  await runLog(runId, null, '', status === 'succeeded' ? 'ok' : status === 'cancelled' ? 'warn' : 'error', `${words[status]} ${Object.entries(c).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  await flushLog();
}

// ---------------------------------------------------------------- Approve, reject, cancel, retry
export async function approve(ctx, runId) {
  const [run] = await query('select * from runs where id = $1', [runId]);
  if (!run) throw httpError(404, 'not_found', 'There is no such run.');
  if (!['awaiting_approval', 'waiting'].includes(run.status)) throw httpError(409, 'not_waiting', 'This run is not waiting for an approval.');
  if (String(run.requested_by_id) === ctx.user.id && !ctx.user.isAdmin) throw httpError(403, 'own_run', 'Someone else has to approve your run.');
  const state = run.state || {};
  if (run.status === 'waiting') state.approvals = { ...(state.approvals || {}), [`${state.batch}:${state.step}`]: ctx.user.username };
  await query("update runs set status = 'queued', state = $2, approved_by = $3, approved_at = now() where id = $1", [runId, JSON.stringify(state), ctx.user.username]);
  await runLog(runId, null, '', 'ok', `Approved by ${ctx.user.username}.`);
  await enqueueRun(runId);
  await record(ctx, 'run.approved', { target: { type: 'run', id: runId, name: run.name } });
}

export async function reject(ctx, runId, reason = '') {
  const [run] = await query('select * from runs where id = $1', [runId]);
  if (!run || !['awaiting_approval', 'waiting'].includes(run.status)) throw httpError(409, 'not_waiting', 'This run is not waiting for an approval.');
  await query("update runs set status = 'rejected', reason = $2, finished_at = now() where id = $1", [runId, String(reason).slice(0, 500)]);
  await query("update run_hosts set status = 'skipped' where run_id = $1 and status in ('pending', 'running')", [runId]);
  if (run.kind === 'takeover') await query("update hosts set state = 'new' where id in (select host_id from run_hosts where run_id = $1) and state = 'taking_over'", [runId]);
  await runLog(runId, null, '', 'warn', `Rejected by ${ctx.user.username}${reason ? `: ${reason}` : ''}.`);
  await flushLog();
  await record(ctx, 'run.rejected', { target: { type: 'run', id: runId, name: run.name }, reason });
}

export async function cancel(ctx, runId) {
  const [run] = await query('select * from runs where id = $1', [runId]);
  if (!run) throw httpError(404, 'not_found', 'There is no such run.');
  if (FINAL.includes(run.status)) throw httpError(409, 'finished', 'This run has finished already.');
  if (run.job_id) await jobs.cancel(run.job_id);
  if (run.status !== 'running') {
    await query("update run_hosts set status = 'skipped' where run_id = $1 and status in ('pending', 'running')", [runId]);
    if (run.kind === 'takeover') await query("update hosts set state = 'new' where id in (select host_id from run_hosts where run_id = $1) and state = 'taking_over'", [runId]);
    await finish(runId, 'cancelled', run);
  } else await runLog(runId, null, '', 'warn', `Cancelled by ${ctx.user.username}. Stopping…`);
  await record(ctx, 'run.cancelled', { target: { type: 'run', id: runId, name: run.name } });
}

// ---------------------------------------------------------------- Jobs
export function defineRunJobs({ resolveTargets }) {
  jobs.define('run.execute', execute);
  // A scheduled workflow: its targets at the time it fires
  jobs.define('run.scheduled', async job => {
    const [wf] = await query('select * from workflows where id = $1 and enabled', [job.payload.workflowId]);
    if (!wf) return { skipped: 'disabled' };
    const hostIds = await resolveTargets(wf);
    if (!hostIds.length) return { skipped: 'no hosts' };
    return { run: await startRun({ workflow: wf, hostIds, trigger: 'schedule' }) };
  });
  jobs.define('runs.prune', async () => {
    const { getSetting } = await import('../api/settings.mjs');
    const days = Number(await getSetting('runs.keep_days')) || 180;
    return { removed: (await query('delete from runs where finished_at < now() - make_interval(days => $1) returning id', [days])).length };
  });
}
