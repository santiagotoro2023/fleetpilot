// FleetPilot API: roles and who has them (administrators).
//   GET /api/access/roles               POST /api/access/roles { name, description, permissions, scope }
//   PATCH /api/access/roles/:id         DELETE /api/access/roles/:id
//   GET /api/access/users               accounts with their roles
//   PUT /api/access/users/:id/roles     { roleIds }
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { requireAdmin } from '../lib/auth.mjs';
import { record } from '../lib/audit.mjs';
import { normalizePermissions } from '../lib/access.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const out = r => ({ ...r, id: String(r.id), scope_group_ids: (r.scope_group_ids || []).map(String) });
const scopeOf = v => (Array.isArray(v) ? v : []).filter(isId).map(String).slice(0, 100);

export default function access(app) {
  app.get('/api/access/roles', async ctx => {
    requireAdmin(ctx);
    return (await query('select r.*, (select count(*)::int from user_roles ur where ur.role_id = r.id) as users from roles r order by r.builtin desc, lower(r.name)')).map(out);
  });

  app.post('/api/access/roles', async ctx => {
    requireAdmin(ctx);
    const b = ctx.body || {};
    const name = str(b.name, 60);
    if (!name) throw httpError(400, 'name_missing', 'Give the role a name.');
    const rows = await query('insert into roles (name, description, permissions, scope_group_ids) values ($1, $2, $3, $4) on conflict do nothing returning *',
      [name, str(b.description, 500), JSON.stringify(normalizePermissions(b.permissions)), scopeOf(b.scope)]);
    if (!rows.length) throw httpError(409, 'name_taken', 'There is a role with this name already.');
    await record(ctx, 'role.created', { target: { type: 'role', id: rows[0].id, name }, permissions: rows[0].permissions });
    return { status: 201, body: out(rows[0]) };
  });

  app.patch('/api/access/roles/:id', async ctx => {
    requireAdmin(ctx);
    const [r] = await query('select * from roles where id = $1', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!r) throw httpError(404, 'not_found', 'There is no such role.');
    const b = ctx.body || {};
    try {
      const [row] = await query('update roles set name = $2, description = $3, permissions = $4, scope_group_ids = $5, updated_at = now() where id = $1 returning *',
        [r.id, 'name' in b ? str(b.name, 60) || r.name : r.name, 'description' in b ? str(b.description, 500) : r.description,
          JSON.stringify('permissions' in b ? normalizePermissions(b.permissions) : r.permissions), 'scope' in b ? scopeOf(b.scope) : r.scope_group_ids]);
      await record(ctx, 'role.changed', { target: { type: 'role', id: r.id, name: row.name }, permissions: row.permissions, scope: row.scope_group_ids });
      return out(row);
    } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'There is a role with this name already.'); throw e; }
  });

  app.del('/api/access/roles/:id', async ctx => {
    requireAdmin(ctx);
    const [r] = await query('select * from roles where id = $1', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!r) throw httpError(404, 'not_found', 'There is no such role.');
    await query('delete from roles where id = $1', [r.id]);
    await record(ctx, 'role.deleted', { target: { type: 'role', id: r.id, name: r.name } });
    return null;
  });

  app.get('/api/access/users', async ctx => {
    requireAdmin(ctx);
    return query(`select u.id::text, u.username, u.is_admin, coalesce(json_agg(json_build_object('id', r.id::text, 'name', r.name)) filter (where r.id is not null), '[]') as roles
      from auth_users u left join user_roles ur on ur.user_id = u.id left join roles r on r.id = ur.role_id group by u.id order by u.username`);
  });

  app.put('/api/access/users/:id/roles', async ctx => {
    requireAdmin(ctx);
    const [u] = await query('select id, username from auth_users where id = $1', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!u) throw httpError(404, 'not_found', 'There is no such user.');
    const ids = (Array.isArray(ctx.body?.roleIds) ? ctx.body.roleIds : []).filter(isId);
    const roles = await query('select id, name from roles where id = any($1::bigint[])', [ids]);
    await tx(async c => {
      await c.query('delete from user_roles where user_id = $1', [u.id]);
      for (const r of roles) await c.query('insert into user_roles (user_id, role_id) values ($1, $2)', [u.id, r.id]);
    });
    await record(ctx, 'user.roles_changed', { target: { type: 'user', id: u.id, name: u.username }, roles: roles.map(r => r.name) });
    return roles.map(r => ({ id: String(r.id), name: r.name }));
  });
}
