// Library element "audit" (blueprint 1.1.1): who did what, when and from where.
//
//   import { audit, record } from './lib/audit.mjs'
//   await start({ routes: [auth({ onEvent: record }), audit(), items] })
//   await record(ctx, 'item.deleted', { target: { type: 'item', id, name }, title })
//
// Rows are only ever added (and removed after the retention time, default 400 days).
// GET /api/audit is for administrators (or whoever `can(ctx)` allows).
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { log } from '../core/log.mjs';

const SECRET_KEYS = /pass(word)?|secret|token|key|code|cookie/i;
/** Details without anything that looks like a secret, and not too large */
export function clean(details = {}) {
  const walk = (v, depth) => {
    if (depth > 4) return '…';
    if (Array.isArray(v)) return v.slice(0, 50).map(x => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, SECRET_KEYS.test(k) && typeof x !== 'object' && typeof x !== 'boolean' ? '(hidden)' : walk(x, depth + 1)]));
    return typeof v === 'string' ? v.slice(0, 500) : v;
  };
  return walk(details, 0);
}

/** Records an event. ctx: the request (its user and address), or null for the system */
export async function record(ctx, action, { target, ...details } = {}) {
  try {
    const u = ctx?.user;
    await query(`insert into audit_events (actor_id, actor, action, target_type, target_id, target_name, details, ip)
      values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [u?.id ?? null, u ? u.username : (details.username ? String(details.username) : 'system'), action, target?.type || '', String(target?.id ?? ''), String(target?.name ?? '').slice(0, 200), JSON.stringify(clean(details)), ctx?.clientIp || '']);
  } catch (e) { log.error('audit: could not record', { action, error: e.message }); }
}

/** The route module: GET /api/audit with filters, for administrators */
export function audit({ can = ctx => ctx.user?.isAdmin, retentionDays = 400 } = {}) {
  return async function auditRoutes(app) {
    // Old rows go once a day (whichever replica gets there first)
    const prune = () => query('delete from audit_events where at < now() - make_interval(days => $1)', [retentionDays]).catch(() => {});
    setInterval(prune, 24 * 3600_000).unref();

    app.get('/api/audit', async ctx => {
      if (!(await can(ctx))) throw httpError(403, 'not_allowed', 'Only administrators can read the audit log.');
      const q = ctx.query, where = [], args = [];
      const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
      if (q.before && /^\d+$/.test(q.before)) add('id < ?', q.before);
      if (q.actor) add('actor = ?', String(q.actor).slice(0, 100));
      if (q.action) add('action like ?', String(q.action).replace(/[%_]/g, '') + '%');
      if (q.type) add('target_type = ?', String(q.type).slice(0, 50));
      if (q.target) add('target_id = ?', String(q.target).slice(0, 100));
      if (q.q) add("(actor ilike ? or action ilike $X or target_name ilike $X or details::text ilike $X)".replace(/\$X/g, `$${args.length + 1}`), `%${String(q.q).slice(0, 100).replace(/[%_]/g, '')}%`);
      const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
      const rows = await query(`select id, at, actor, action, target_type, target_id, target_name, details, ip from audit_events
        ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit ${limit}`, args);
      return rows.map(r => ({ ...r, id: String(r.id) }));
    });
  };
}
