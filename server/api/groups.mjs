// FleetPilot API: sites and groups, a tree.
//   GET /api/groups            the tree with counts and assigned templates
//   POST /api/groups           { name, kind, parentId, description }
//   PATCH /api/groups/:id      { name, description, parentId, position }
//   DELETE /api/groups/:id     only when empty (no groups, no hosts inside)
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { need } from '../lib/access.mjs';

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const id = v => (v === null || v === undefined || v === '' ? null : /^\d+$/.test(String(v)) ? String(v) : (() => { throw httpError(400, 'bad_id', 'There is no such group.'); })());

export async function groupRows() {
  const rows = await query(`select g.*, (select count(*)::int from hosts h where h.group_id = g.id) as hosts,
    (select count(*)::int from hosts h where h.group_id = g.id and h.state = 'managed') as managed,
    (select coalesce(json_agg(json_build_object('id', t.id::text, 'name', t.name, 'pinned', a.pinned_version) order by a.position, a.id), '[]') from assignments a join templates t on t.id = a.template_id where a.group_id = g.id) as templates
    from groups g order by g.position, lower(g.name)`);
  return rows.map(g => ({ ...g, id: String(g.id), parent_id: g.parent_id && String(g.parent_id) }));
}

export default function groups(app) {
  app.get('/api/groups', async ctx => { await need(ctx, 'hosts', 'view'); return groupRows(); });

  app.post('/api/groups', async ctx => {
    const b = ctx.body || {};
    const parent = id(b.parentId);
    await need(ctx, 'hosts', 'manage', parent ?? undefined);
    const name = str(b.name, 80);
    if (!name) throw httpError(400, 'name_missing', 'Give the group a name.');
    const kind = b.kind === 'site' && !parent ? 'site' : 'group';
    if (parent && !(await query('select 1 from groups where id = $1', [parent])).length) throw httpError(400, 'no_parent', 'The group above does not exist.');
    const rows = await query(`insert into groups (parent_id, kind, name, description, position) values ($1, $2, $3, $4, (select coalesce(max(position), 0) + 1 from groups where parent_id is not distinct from $1::bigint))
      on conflict do nothing returning id`, [parent, kind, name, str(b.description, 500)]);
    if (!rows.length) throw httpError(409, 'name_taken', 'There is a group with this name here already.');
    await record(ctx, 'group.created', { target: { type: 'group', id: rows[0].id, name }, kind });
    return { status: 201, body: (await groupRows()).find(g => g.id === String(rows[0].id)) };
  });

  app.patch('/api/groups/:id', async ctx => {
    const gid = id(ctx.params.id);
    const [g] = await query('select * from groups where id = $1', [gid]);
    if (!g) throw httpError(404, 'not_found', 'There is no such group.');
    await need(ctx, 'hosts', 'manage', gid);
    const b = ctx.body || {};
    let parent = 'parentId' in b ? id(b.parentId) : g.parent_id;
    if (parent) {
      // Never into itself or below itself
      const all = await query('select id, parent_id from groups');
      const up = new Map(all.map(r => [String(r.id), r.parent_id && String(r.parent_id)]));
      for (let p = String(parent); p; p = up.get(p)) if (p === String(gid)) throw httpError(400, 'loop', 'A group cannot go into itself or into a group inside it.');
      await need(ctx, 'hosts', 'manage', parent);
    }
    const name = 'name' in b ? str(b.name, 80) : g.name;
    if (!name) throw httpError(400, 'name_missing', 'Give the group a name.');
    const kind = parent ? 'group' : (b.kind === 'site' || b.kind === 'group' ? b.kind : g.kind);
    try {
      await query('update groups set name = $2, description = $3, parent_id = $4, kind = $5, position = coalesce($6, position), updated_at = now() where id = $1',
        [gid, name, 'description' in b ? str(b.description, 500) : g.description, parent, kind, Number.isInteger(b.position) ? b.position : null]);
    } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'There is a group with this name here already.'); throw e; }
    await record(ctx, 'group.changed', { target: { type: 'group', id: gid, name }, changes: Object.keys(b) });
    return (await groupRows()).find(x => x.id === String(gid));
  });

  app.del('/api/groups/:id', async ctx => {
    const gid = id(ctx.params.id);
    const [g] = await query('select * from groups where id = $1', [gid]);
    if (!g) throw httpError(404, 'not_found', 'There is no such group.');
    await need(ctx, 'hosts', 'manage', gid);
    const [c] = await query('select (select count(*)::int from groups where parent_id = $1) as groups, (select count(*)::int from hosts where group_id = $1) as hosts', [gid]);
    if (c.groups || c.hosts) throw httpError(409, 'not_empty', `${g.name} still has ${c.hosts} hosts and ${c.groups} groups. Move them out first.`);
    await query('delete from groups where id = $1', [gid]);
    await record(ctx, 'group.deleted', { target: { type: 'group', id: gid, name: g.name } });
    return null;
  });
}
