// FleetPilot API: workflows (a trigger and steps) and starting them.
//   GET /api/workflows                  GET /api/workflows/:id (with versions)
//   POST /api/workflows                 { name, description, kind, definition }
//   PUT /api/workflows/:id              { name, description, definition, enabled }: a new version
//   DELETE /api/workflows/:id
//   POST /api/workflows/:id/duplicate
//   POST /api/workflows/:id/run         { hostIds | groupIds | tags, checkOnly }
//   POST /api/workflows/:id/targets     the hosts it would run on, without running
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { jobs } from '../lib/jobs.mjs';
import { accessOf, need } from '../lib/access.mjs';
import { normalizeWorkflow, startRun } from '../lib/runner.mjs';
import { STEP_TYPES } from '../lib/steps.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));
const str = (v, n) => String(v ?? '').trim().slice(0, n);

export const describeSteps = def => (def.steps || []).map(s => {
  const t = STEP_TYPES.get(s.type);
  let sentence = '';
  try { sentence = t.describe(s.values); } catch { sentence = t.text; }
  return { ...s, title: t.title, area: t.area, sentence };
});

async function load(id) {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such workflow.');
  const [w] = await query('select * from workflows where id = $1', [id]);
  if (!w) throw httpError(404, 'not_found', 'There is no such workflow.');
  return w;
}
const out = w => ({ ...w, id: String(w.id), steps: describeSteps(w.definition) });

/** Hosts in the target groups (and everything inside) or with the target tags; all hosts when none are set */
export async function resolveTargets(wf, { groupIds, tags } = {}) {
  const g = groupIds ?? wf.definition.targets?.groups ?? [], t = tags ?? wf.definition.targets?.tags ?? [];
  const states = wf.kind === 'takeover' ? ['new', 'failed', 'unreachable'] : ['managed', 'unreachable'];
  const rows = await query(`with recursive inside(id) as (select unnest($1::bigint[]) union select g.id from groups g join inside on g.parent_id = inside.id)
    select h.id::text from hosts h where h.state = any($3::text[]) and (
      (cardinality($1::bigint[]) = 0 and cardinality($2::text[]) = 0)
      or h.group_id in (select id from inside) or h.tags && $2::text[]) order by h.name`, [g, t, states]);
  return rows.map(r => r.id);
}

/** Every enabled workflow with a schedule becomes a job schedule (and the others none) */
export async function scheduleWorkflows() {
  const list = await query('select * from workflows');
  const want = new Set();
  for (const w of list) {
    if (w.enabled && w.definition.trigger?.type === 'schedule' && w.definition.trigger.cron) {
      want.add(`workflow-${w.id}`);
      await jobs.schedule(`workflow-${w.id}`, w.definition.trigger.cron, 'run.scheduled', { workflowId: String(w.id) });
    }
  }
  for (const s of await jobs.schedules()) if (s.name.startsWith('workflow-') && !want.has(s.name)) await jobs.unschedule(s.name);
}

/** New hosts start the take-over workflows that are triggered by "host added" and target them */
export async function hostAdded(hostIds) {
  const list = await query("select * from workflows where enabled and kind = 'takeover' and definition->'trigger'->>'type' = 'host_added'");
  for (const wf of list) {
    const targets = new Set(await resolveTargets(wf));
    const ids = hostIds.filter(id => targets.has(String(id)));
    if (ids.length) await startRun({ workflow: wf, hostIds: ids, trigger: 'host_added' }).catch(() => {});
  }
}

/** Starts a workflow on hosts for the user of the request, with an approval when their roles ask for one */
export async function runWorkflow(ctx, workflowId, hostIds, { checkOnly = false, params = {}, name, definition } = {}) {
  const wf = await load(workflowId);
  if (definition) wf.definition = definition;
  if (!wf.enabled) throw httpError(409, 'disabled', 'This workflow is switched off.');
  const a = await accessOf(ctx);
  const hosts = await query('select id, name, group_id from hosts where id = any($1::bigint[])', [hostIds]);
  if (!hosts.length) throw httpError(400, 'no_hosts', 'Choose at least one host.');
  for (const h of hosts) if (!a.can('runs', 'run', h.group_id ?? null)) throw httpError(403, 'not_allowed', `Your roles do not allow runs on ${h.name}.`);
  const needsApproval = hosts.some(h => a.needsApproval(h.group_id ?? null));
  return startRun({ workflow: wf, hostIds: hosts.map(h => h.id), ctx, checkOnly, needsApproval, params, name });
}

export default function workflows(app) {
  app.get('/api/workflows', async ctx => {
    await need(ctx, 'automation', 'view');
    const rows = await query(`select w.*, (select json_build_object('id', r.id::text, 'status', r.status, 'at', coalesce(r.finished_at, r.created_at)) from runs r where r.workflow_id = w.id order by r.id desc limit 1) as last_run,
      (select next_at from job_schedules where name = 'workflow-' || w.id) as next_at from workflows w order by w.kind desc, lower(w.name)`);
    return rows.map(out);
  });

  app.get('/api/workflows/:id', async ctx => {
    await need(ctx, 'automation', 'view');
    const w = await load(ctx.params.id);
    const versions = await query('select version, created_by, created_at from workflow_versions where workflow_id = $1 order by version desc limit 50', [w.id]);
    const [sched] = await query("select next_at from job_schedules where name = $1", [`workflow-${w.id}`]);
    return { ...out(w), versions, nextAt: sched?.next_at || null };
  });

  app.post('/api/workflows', async ctx => {
    await need(ctx, 'automation', 'change');
    const b = ctx.body || {};
    const name = str(b.name, 80);
    if (!name) throw httpError(400, 'name_missing', 'Give the workflow a name.');
    const kind = b.kind === 'takeover' ? 'takeover' : 'maintain';
    const def = normalizeWorkflow(kind, b.definition || { steps: kind === 'takeover' ? [{ type: 'connect', values: {} }, { type: 'enroll', values: {} }] : [{ type: 'apply', values: {} }] });
    const w = await tx(async c => {
      const rows = (await c.query('insert into workflows (name, description, kind, definition, created_by) values ($1, $2, $3, $4, $5) on conflict do nothing returning *', [name, str(b.description, 1000), kind, JSON.stringify(def), ctx.user.username])).rows;
      if (!rows.length) throw httpError(409, 'name_taken', 'There is a workflow with this name already.');
      await c.query('insert into workflow_versions (workflow_id, version, definition, created_by) values ($1, 1, $2, $3)', [rows[0].id, JSON.stringify(def), ctx.user.username]);
      return rows[0];
    });
    await scheduleWorkflows();
    await record(ctx, 'workflow.created', { target: { type: 'workflow', id: w.id, name } });
    return { status: 201, body: out(w) };
  });

  app.put('/api/workflows/:id', async ctx => {
    await need(ctx, 'automation', 'change');
    const w = await load(ctx.params.id);
    const b = ctx.body || {};
    const def = b.definition ? normalizeWorkflow(w.kind, b.definition) : w.definition;
    const name = 'name' in b ? str(b.name, 80) : w.name;
    if (!name) throw httpError(400, 'name_missing', 'Give the workflow a name.');
    const changed = JSON.stringify(def) !== JSON.stringify(w.definition);
    const row = await tx(async c => {
      let r;
      try {
        r = (await c.query('update workflows set name = $2, description = $3, definition = $4, enabled = $5, version = version + $6, updated_at = now() where id = $1 returning *',
          [w.id, name, 'description' in b ? str(b.description, 1000) : w.description, JSON.stringify(def), 'enabled' in b ? !!b.enabled : w.enabled, changed ? 1 : 0])).rows[0];
      } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'There is a workflow with this name already.'); throw e; }
      if (changed) await c.query('insert into workflow_versions (workflow_id, version, definition, created_by) values ($1, $2, $3, $4)', [w.id, r.version, JSON.stringify(def), ctx.user.username]);
      return r;
    });
    await scheduleWorkflows();
    await record(ctx, 'workflow.changed', { target: { type: 'workflow', id: w.id, name }, version: row.version });
    return out(row);
  });

  app.post('/api/workflows/:id/duplicate', async ctx => {
    await need(ctx, 'automation', 'change');
    const w = await load(ctx.params.id);
    let name = `${w.name} (copy)`;
    for (let i = 2; (await query('select 1 from workflows where lower(name) = lower($1)', [name])).length; i++) name = `${w.name} (copy ${i})`;
    const row = await tx(async c => {
      const [r] = (await c.query('insert into workflows (name, description, kind, definition, enabled, created_by) values ($1, $2, $3, $4, false, $5) returning *', [name.slice(0, 80), w.description, w.kind, JSON.stringify(w.definition), ctx.user.username])).rows;
      await c.query('insert into workflow_versions (workflow_id, version, definition, created_by) values ($1, 1, $2, $3)', [r.id, JSON.stringify(w.definition), ctx.user.username]);
      return r;
    });
    await record(ctx, 'workflow.created', { target: { type: 'workflow', id: row.id, name }, from: w.name });
    return { status: 201, body: out(row) };
  });

  app.del('/api/workflows/:id', async ctx => {
    await need(ctx, 'automation', 'change');
    const w = await load(ctx.params.id);
    if (w.builtin) throw httpError(409, 'builtin', 'Built-in workflows can be changed or switched off, not deleted.');
    await query('delete from workflows where id = $1', [w.id]);
    await scheduleWorkflows();
    await record(ctx, 'workflow.deleted', { target: { type: 'workflow', id: w.id, name: w.name } });
    return null;
  });

  app.post('/api/workflows/:id/targets', async ctx => {
    await need(ctx, 'automation', 'view');
    const w = await load(ctx.params.id);
    const ids = await resolveTargets(w, { groupIds: ctx.body?.groupIds, tags: ctx.body?.tags });
    return query('select id::text, name, state from hosts where id = any($1::bigint[]) order by name', [ids]);
  });

  app.post('/api/workflows/:id/run', async ctx => {
    const w = await load(ctx.params.id);
    const b = ctx.body || {};
    let ids = (Array.isArray(b.hostIds) ? b.hostIds : []).filter(isId);
    if (!ids.length && (b.groupIds?.length || b.tags?.length || b.targets)) ids = await resolveTargets(w, { groupIds: (b.groupIds || []).filter(isId), tags: b.tags || [] });
    const id = await runWorkflow(ctx, w.id, ids, { checkOnly: !!b.checkOnly });
    return { status: 201, body: { id } };
  });
}
