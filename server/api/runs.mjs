// FleetPilot API: runs.
//   GET /api/runs?status=&waiting=1&host=&workflow=&before=     newest first
//   GET /api/runs/:id                    the run, its steps, hosts and the host × step results
//   GET /api/runs/:id/log?after=&host=   log lines after an id (for the live log)
//   POST /api/runs/:id/approve           POST /api/runs/:id/reject { reason }
//   POST /api/runs/:id/cancel            POST /api/runs/:id/retry { failedOnly }
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { accessOf, need } from '../lib/access.mjs';
import { approve, cancel, reject, flushLog, startRun } from '../lib/runner.mjs';
import { describeSteps } from './workflows.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));

/** Runs the user may see: those with at least one host in their groups (or started by them) */
async function visible(ctx) {
  const a = await accessOf(ctx);
  const s = a.scope('runs', 'view');
  if (s === null) return ['true', []];
  return [`(r.requested_by_id = $1 or exists (select 1 from run_hosts rh join hosts h on h.id = rh.host_id where rh.run_id = r.id and h.group_id = any($2::bigint[])))`, [ctx.user.id, [...s]]];
}

async function loadRun(ctx, id) {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such run.');
  await need(ctx, 'runs', 'view');
  const [where, params] = await visible(ctx);
  const [r] = await query(`select r.* from runs r where r.id = $${params.length + 1} and ${where}`, [...params, id]);
  if (!r) throw httpError(404, 'not_found', 'There is no such run.');
  return r;
}

export default function runs(app) {
  app.get('/api/runs', async ctx => {
    await need(ctx, 'runs', 'view');
    const [where, params] = await visible(ctx);
    const w = [where], q = ctx.query;
    const add = (sql, v) => { params.push(v); w.push(sql.replace('?', `$${params.length}`)); };
    if (q.status) add('r.status = ?', String(q.status));
    if (q.waiting) w.push("r.status in ('awaiting_approval', 'waiting')");
    if (q.active) w.push("r.status in ('queued', 'running', 'awaiting_approval', 'waiting')");
    if (q.host && isId(q.host)) add('exists (select 1 from run_hosts x where x.run_id = r.id and x.host_id = ?)', q.host);
    if (q.workflow && isId(q.workflow)) add('r.workflow_id = ?', q.workflow);
    if (q.before && isId(q.before)) add('r.id < ?', q.before);
    const limit = Math.min(200, Number(q.limit) || 50);
    return (await query(`select r.id::text, r.name, r.kind, r.status, r.trigger, r.check_only, r.requested_by, r.approved_by, r.created_at, r.started_at, r.finished_at, r.summary, r.workflow_id::text,
      (select count(*)::int from run_hosts rh where rh.run_id = r.id) as hosts,
      (select string_agg(host_name, ', ' order by host_name) from (select host_name from run_hosts rh where rh.run_id = r.id limit 3) x) as host_names
      from runs r where ${w.join(' and ')} order by r.id desc limit ${limit}`, params));
  });

  app.get('/api/runs/:id', async ctx => {
    const r = await loadRun(ctx, ctx.params.id);
    const a = await accessOf(ctx);
    const hosts = await query('select rh.host_id::text as id, rh.host_name as name, rh.status, rh.batch, h.address, h.group_id from run_hosts rh left join hosts h on h.id = rh.host_id where rh.run_id = $1 order by rh.batch, rh.host_name', [r.id]);
    const steps = await query('select step, host_id::text, status, message, started_at, finished_at from run_steps where run_id = $1', [r.id]);
    const mayApprove = ['awaiting_approval', 'waiting'].includes(r.status) && (String(r.requested_by_id) !== ctx.user.id || a.admin) && hosts.every(h => a.can('runs', 'approve', h.group_id ?? null));
    return {
      ...r, id: String(r.id), workflow_id: r.workflow_id && String(r.workflow_id), state: { batch: r.state?.batch, step: r.state?.step },
      steps: describeSteps(r.definition), hosts: hosts.map(h => ({ ...h, group_id: undefined })), results: steps,
      may: { approve: mayApprove, cancel: !['succeeded', 'partial', 'failed', 'cancelled', 'rejected'].includes(r.status) && (String(r.requested_by_id) === ctx.user.id || a.can('runs', 'approve')), retry: a.can('runs', 'run') }
    };
  });

  app.get('/api/runs/:id/log', async ctx => {
    const r = await loadRun(ctx, ctx.params.id);
    await flushLog();
    const after = isId(ctx.query.after) ? ctx.query.after : '0';
    const rows = await query(`select id::text, at, step, host, level, line from run_logs where run_id = $1 and id > $2 ${ctx.query.host ? 'and host = $3' : ''} order by run_logs.id limit 2000`,
      ctx.query.host ? [r.id, after, String(ctx.query.host)] : [r.id, after]);
    return { status: r.status, lines: rows };
  });

  app.post('/api/runs/:id/approve', async ctx => {
    const r = await loadRun(ctx, ctx.params.id);
    const a = await accessOf(ctx);
    const hosts = await query('select h.group_id, h.name from run_hosts rh join hosts h on h.id = rh.host_id where rh.run_id = $1', [r.id]);
    for (const h of hosts) if (!a.can('runs', 'approve', h.group_id ?? null)) throw httpError(403, 'not_allowed', `Your roles do not allow approving runs on ${h.name}.`);
    await approve(ctx, r.id);
    return null;
  });
  app.post('/api/runs/:id/reject', async ctx => {
    const r = await loadRun(ctx, ctx.params.id);
    if (String(r.requested_by_id) !== ctx.user.id) await need(ctx, 'runs', 'approve');
    await reject(ctx, r.id, ctx.body?.reason || '');
    return null;
  });
  app.post('/api/runs/:id/cancel', async ctx => {
    const r = await loadRun(ctx, ctx.params.id);
    if (String(r.requested_by_id) !== ctx.user.id) await need(ctx, 'runs', 'approve');
    await cancel(ctx, r.id);
    return null;
  });
  app.post('/api/runs/:id/retry', async ctx => {
    const r = await loadRun(ctx, ctx.params.id);
    const a = await accessOf(ctx);
    const rows = await query(`select h.id, h.group_id from run_hosts rh join hosts h on h.id = rh.host_id where rh.run_id = $1 ${ctx.body?.failedOnly ? "and rh.status in ('failed', 'unreachable', 'skipped')" : ''}`, [r.id]);
    if (!rows.length) throw httpError(400, 'no_hosts', 'There are no hosts to run again.');
    for (const h of rows) if (!a.can('runs', 'run', h.group_id ?? null)) throw httpError(403, 'not_allowed', 'Your roles do not allow runs on all of these hosts.');
    const def = { ...r.definition };
    const id = await startRun({ workflow: { id: r.workflow_id, name: r.name, kind: r.kind, definition: def, version: def.workflowVersion }, hostIds: rows.map(h => h.id), ctx, needsApproval: rows.some(h => a.needsApproval(h.group_id ?? null)), checkOnly: r.check_only, params: r.params });
    return { status: 201, body: { id } };
  });
}
