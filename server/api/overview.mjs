// FleetPilot API: the overview. The state of the fleet in numbers, and only what needs attention.
//   GET /api/overview
import { query } from '../core/db.mjs';
import { accessOf, hostFilter } from '../lib/access.mjs';

export default function overview(app) {
  app.get('/api/overview', async ctx => {
    const a = await accessOf(ctx);
    const [where, params] = await hostFilter(ctx);
    const canHosts = a.can('hosts', 'view'), canRuns = a.can('runs', 'view');
    const [c] = canHosts ? await query(`select count(*)::int as hosts,
        count(*) filter (where state = 'managed')::int as managed,
        count(*) filter (where state in ('new', 'failed', 'taking_over'))::int as waiting,
        count(*) filter (where state = 'unreachable')::int as unreachable,
        count(*) filter (where (drift->>'changed')::int > 0)::int as drifted
      from hosts h where state <> 'retired' and ${where}`, params) : [{}];
    const runs = canRuns ? (await query(`select count(*) filter (where status in ('queued', 'running'))::int as running,
        count(*) filter (where status in ('awaiting_approval', 'waiting'))::int as approvals,
        count(*) filter (where status in ('failed', 'partial') and finished_at > now() - interval '24 hours')::int as failed
      from runs`))[0] : {};
    const list = (sql, p = params) => canHosts ? query(sql, p) : [];
    return {
      counts: { ...c, ...runs },
      attention: {
        approvals: canRuns ? await query(`select id::text, name, status, requested_by, created_at, (select count(*)::int from run_hosts rh where rh.run_id = r.id) as hosts from runs r
          where status in ('awaiting_approval', 'waiting') order by r.id desc limit 20`) : [],
        running: canRuns ? await query(`select id::text, name, status, requested_by, started_at, created_at, (select count(*)::int from run_hosts rh where rh.run_id = r.id) as hosts,
          (select count(*)::int from run_hosts rh where rh.run_id = r.id and rh.status in ('ok', 'changed', 'failed', 'unreachable', 'skipped')) as done from runs r
          where status in ('queued', 'running') order by r.id desc limit 20`) : [],
        failedRuns: canRuns ? await query(`select id::text, name, status, finished_at, summary from runs where status in ('failed', 'partial') and finished_at > now() - interval '7 days' order by runs.id desc limit 10`) : [],
        unreachable: await list(`select h.id::text, h.name, h.address, h.last_seen_at from hosts h where h.state = 'unreachable' and ${where} order by h.name limit 20`),
        drifted: await list(`select h.id::text, h.name, (h.drift->>'changed')::int as changed, h.drift->>'at' as at from hosts h where (h.drift->>'changed')::int > 0 and h.state <> 'retired' and ${where} order by (h.drift->>'changed')::int desc limit 20`),
        notTakenOver: await list(`select h.id::text, h.name, h.address, h.state, h.created_at from hosts h where h.state in ('new', 'failed') and ${where} order by h.created_at desc limit 20`)
      }
    };
  });
}
