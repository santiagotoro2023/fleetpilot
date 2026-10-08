// FleetPilot API: templates (a desired configuration from forms) and where they apply.
//   GET /api/templates                       with counts of where they apply and hosts behind
//   GET /api/templates/:id?version=          one template, a version of it, its versions
//   POST /api/templates                      { name, description, definition }
//   POST /api/templates/:id/versions         { definition, note, name, description }: saves a new version
//   POST /api/templates/preview              { definition, name }: the playbook as YAML
//   PATCH /api/templates/:id                 { name, description, archived }
//   POST /api/templates/:id/duplicate        DELETE /api/templates/:id (only when used nowhere)
//   GET /api/templates/:id/usage             where it applies, which hosts have which version applied
//   POST /api/templates/:id/assign           { groupId | hostId, pinnedVersion }
//   DELETE /api/templates/:id/assign/:aid
//   POST /api/templates/:id/push             { hostIds | all }: applies the newest version to hosts
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { need } from '../lib/access.mjs';
import { normalizeDefinition, previewPlaybook, TYPES } from '../lib/compile.mjs';
import { startRun } from '../lib/runner.mjs';
import { runWorkflow } from './workflows.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));
const str = (v, n) => String(v ?? '').trim().slice(0, n);

async function load(id) {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such template.');
  const [t] = await query('select * from templates where id = $1', [id]);
  if (!t) throw httpError(404, 'not_found', 'There is no such template.');
  return t;
}

/** Vault entries referenced by a definition must exist; referencing needs the right to see the vault */
async function checkSecrets(ctx, def) {
  const ids = [];
  for (const s of def.settings) {
    const t = TYPES.get(s.type);
    for (const f of t.fields) {
      if (f.type === 'secret' && s.values[f.key]) ids.push(s.values[f.key]);
      if (f.type === 'rows') for (const c of f.columns.filter(c => c.type === 'secret')) for (const r of s.values[f.key]) if (r[c.key]) ids.push(r[c.key]);
    }
  }
  if (!ids.length) return;
  await need(ctx, 'vault', 'view');
  const found = await query("select id::text from secrets where id = any($1::bigint[]) and scope in ('global', 'group')", [ids]);
  const missing = ids.filter(i => !found.some(f => f.id === String(i)));
  if (missing.length) throw httpError(400, 'no_secret', 'A setting uses a vault entry that does not exist (or belongs to one host).');
}

/** Hosts that use a template: by assignment (their groups or themselves) and by what was applied */
async function hostsUsing(templateId) {
  return query(`with recursive inside(id) as (select group_id from assignments where template_id = $1 and group_id is not null
      union select g.id from groups g join inside on g.parent_id = inside.id)
    select h.id::text, h.name, h.state, h.group_id, ht.applied_version, ht.applied_at,
      (h.group_id in (select id from inside) or exists (select 1 from assignments a where a.template_id = $1 and a.host_id = h.id)) as assigned
    from hosts h left join host_templates ht on ht.host_id = h.id and ht.template_id = $1
    where h.group_id in (select id from inside) or exists (select 1 from assignments a where a.template_id = $1 and a.host_id = h.id) or ht.host_id is not null
    order by h.name`, [templateId]);
}

export default function templates(app) {
  app.get('/api/templates', async ctx => {
    await need(ctx, 'automation', 'view');
    return query(`select t.id::text, t.name, t.description, t.current_version, t.archived, t.updated_at, v.definition,
      (select count(*)::int from assignments a where a.template_id = t.id) as assignments,
      (select count(*)::int from host_templates ht where ht.template_id = t.id) as applied,
      (select count(*)::int from host_templates ht where ht.template_id = t.id and ht.applied_version < t.current_version) as behind
      from templates t left join template_versions v on v.template_id = t.id and v.version = t.current_version order by t.archived, lower(t.name)`);
  });

  app.get('/api/templates/:id', async ctx => {
    await need(ctx, 'automation', 'view');
    const t = await load(ctx.params.id);
    const version = isId(ctx.query.version) ? Number(ctx.query.version) : t.current_version;
    const [v] = await query('select * from template_versions where template_id = $1 and version = $2', [t.id, version]);
    const versions = await query('select version, note, created_by, created_at from template_versions where template_id = $1 order by version desc limit 100', [t.id]);
    return { ...t, id: String(t.id), version, definition: v?.definition || { settings: [] }, playbook: v?.playbook || '', note: v?.note || '', versions };
  });

  app.post('/api/templates/preview', async ctx => {
    await need(ctx, 'automation', 'view');
    const def = normalizeDefinition(ctx.body?.definition || {});
    return { playbook: previewPlaybook(def, str(ctx.body?.name, 80) || 'Template') };
  });

  app.post('/api/templates', async ctx => {
    await need(ctx, 'automation', 'change');
    const b = ctx.body || {};
    const name = str(b.name, 80);
    if (!name) throw httpError(400, 'name_missing', 'Give the template a name.');
    const def = normalizeDefinition(b.definition || { settings: [] });
    await checkSecrets(ctx, def);
    const t = await tx(async c => {
      const rows = (await c.query('insert into templates (name, description, current_version, created_by) values ($1, $2, 1, $3) on conflict do nothing returning *', [name, str(b.description, 1000), ctx.user.username])).rows;
      if (!rows.length) throw httpError(409, 'name_taken', 'There is a template with this name already.');
      await c.query('insert into template_versions (template_id, version, definition, playbook, note, created_by) values ($1, 1, $2, $3, $4, $5)', [rows[0].id, JSON.stringify(def), previewPlaybook(def, name), str(b.note, 200) || 'First version', ctx.user.username]);
      return rows[0];
    });
    await record(ctx, 'template.created', { target: { type: 'template', id: t.id, name } });
    return { status: 201, body: { ...t, id: String(t.id) } };
  });

  app.post('/api/templates/:id/versions', async ctx => {
    await need(ctx, 'automation', 'change');
    const t = await load(ctx.params.id);
    const b = ctx.body || {};
    const def = normalizeDefinition(b.definition || { settings: [] });
    await checkSecrets(ctx, def);
    const name = 'name' in b ? str(b.name, 80) : t.name;
    if (!name) throw httpError(400, 'name_missing', 'Give the template a name.');
    const v = await tx(async c => {
      const [cur] = (await c.query('select current_version from templates where id = $1 for update', [t.id])).rows;
      const next = cur.current_version + 1;
      try {
        await c.query('update templates set current_version = $2, name = $3, description = $4, updated_at = now() where id = $1', [t.id, next, name, 'description' in b ? str(b.description, 1000) : t.description]);
      } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'There is a template with this name already.'); throw e; }
      await c.query('insert into template_versions (template_id, version, definition, playbook, note, created_by) values ($1, $2, $3, $4, $5, $6)', [t.id, next, JSON.stringify(def), previewPlaybook(def, name), str(b.note, 200), ctx.user.username]);
      return next;
    });
    await record(ctx, 'template.saved', { target: { type: 'template', id: t.id, name }, version: v, note: b.note });
    // Workflows triggered by "template changed" run on the hosts that use it
    const wfs = await query("select * from workflows where enabled and kind = 'maintain' and definition->'trigger'->>'type' = 'template_changed'");
    if (wfs.length) {
      const hosts = (await hostsUsing(t.id)).filter(h => h.assigned && h.state === 'managed').map(h => h.id);
      for (const wf of wfs) if (hosts.length) await startRun({ workflow: wf, hostIds: hosts, trigger: 'template_changed', params: { templateId: String(t.id) } }).catch(() => {});
    }
    return { version: v };
  });

  app.patch('/api/templates/:id', async ctx => {
    await need(ctx, 'automation', 'change');
    const t = await load(ctx.params.id);
    const b = ctx.body || {};
    try {
      await query('update templates set name = $2, description = $3, archived = $4, updated_at = now() where id = $1',
        [t.id, 'name' in b ? str(b.name, 80) || t.name : t.name, 'description' in b ? str(b.description, 1000) : t.description, 'archived' in b ? !!b.archived : t.archived]);
    } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'There is a template with this name already.'); throw e; }
    await record(ctx, 'template.changed', { target: { type: 'template', id: t.id, name: b.name || t.name }, changes: Object.keys(b) });
    return null;
  });

  app.post('/api/templates/:id/duplicate', async ctx => {
    await need(ctx, 'automation', 'change');
    const t = await load(ctx.params.id);
    const [v] = await query('select definition from template_versions where template_id = $1 and version = $2', [t.id, t.current_version]);
    let name = `${t.name} (copy)`;
    for (let i = 2; (await query('select 1 from templates where lower(name) = lower($1)', [name])).length; i++) name = `${t.name} (copy ${i})`;
    const row = await tx(async c => {
      const [r] = (await c.query('insert into templates (name, description, current_version, created_by) values ($1, $2, 1, $3) returning id', [name.slice(0, 80), t.description, ctx.user.username])).rows;
      await c.query('insert into template_versions (template_id, version, definition, playbook, note, created_by) values ($1, 1, $2, $3, $4, $5)', [r.id, JSON.stringify(v.definition), previewPlaybook(v.definition, name), `Copy of ${t.name}`, ctx.user.username]);
      return r;
    });
    await record(ctx, 'template.created', { target: { type: 'template', id: row.id, name }, from: t.name });
    return { status: 201, body: { id: String(row.id), name } };
  });

  app.del('/api/templates/:id', async ctx => {
    await need(ctx, 'automation', 'change');
    const t = await load(ctx.params.id);
    const [u] = await query('select (select count(*)::int from assignments where template_id = $1) as a', [t.id]);
    if (u.a) throw httpError(409, 'in_use', `${t.name} still applies to ${u.a} groups or hosts. Remove it there first, or archive it.`);
    await query('delete from templates where id = $1', [t.id]);
    await record(ctx, 'template.deleted', { target: { type: 'template', id: t.id, name: t.name } });
    return null;
  });

  app.get('/api/templates/:id/usage', async ctx => {
    await need(ctx, 'automation', 'view');
    const t = await load(ctx.params.id);
    const assignments = await query(`select a.id::text, a.group_id::text, a.host_id::text, a.pinned_version, g.name as group_name, g.kind as group_kind, h.name as host_name
      from assignments a left join groups g on g.id = a.group_id left join hosts h on h.id = a.host_id where a.template_id = $1 order by g.name, h.name`, [t.id]);
    const hosts = (await hostsUsing(t.id)).map(h => ({ ...h, group_id: undefined }));
    return { current: t.current_version, assignments, hosts };
  });

  app.post('/api/templates/:id/assign', async ctx => {
    const t = await load(ctx.params.id);
    const b = ctx.body || {};
    const groupId = isId(b.groupId) ? String(b.groupId) : null, hostId = groupId ? null : isId(b.hostId) ? String(b.hostId) : null;
    if (!groupId && !hostId) throw httpError(400, 'no_target', 'Choose a site, a group or a host.');
    let targetName;
    if (groupId) { const [g] = await query('select name from groups where id = $1', [groupId]); if (!g) throw httpError(404, 'not_found', 'There is no such group.'); targetName = g.name; await need(ctx, 'hosts', 'change', groupId); }
    else { const [h] = await query('select name, group_id from hosts where id = $1', [hostId]); if (!h) throw httpError(404, 'not_found', 'There is no such host.'); targetName = h.name; await need(ctx, 'hosts', 'change', h.group_id ?? null); }
    const pinned = isId(b.pinnedVersion) ? Number(b.pinnedVersion) : null;
    await query(`insert into assignments (template_id, group_id, host_id, pinned_version, position) values ($1, $2, $3, $4,
      (select coalesce(max(position), 0) + 1 from assignments where group_id is not distinct from $2::bigint and host_id is not distinct from $3::bigint))
      on conflict (template_id, coalesce(group_id, 0), coalesce(host_id, 0)) do update set pinned_version = $4`, [t.id, groupId, hostId, pinned]);
    await record(ctx, 'template.assigned', { target: { type: groupId ? 'group' : 'host', id: groupId || hostId, name: targetName }, template: t.name, pinned });
    return null;
  });

  app.del('/api/templates/:id/assign/:aid', async ctx => {
    const t = await load(ctx.params.id);
    const [a] = await query('select a.*, g.name as gname, h.name as hname, h.group_id as hgroup from assignments a left join groups g on g.id = a.group_id left join hosts h on h.id = a.host_id where a.id = $1 and a.template_id = $2', [isId(ctx.params.aid) ? ctx.params.aid : 0, t.id]);
    if (!a) throw httpError(404, 'not_found', 'This template does not apply there.');
    await need(ctx, 'hosts', 'change', a.group_id ? String(a.group_id) : a.hgroup ?? null);
    await query('delete from assignments where id = $1', [a.id]);
    await record(ctx, 'template.unassigned', { target: { type: a.group_id ? 'group' : 'host', id: a.group_id || a.host_id, name: a.gname || a.hname }, template: t.name });
    return null;
  });

  app.post('/api/templates/:id/push', async ctx => {
    const t = await load(ctx.params.id);
    const b = ctx.body || {};
    const using = await hostsUsing(t.id);
    let ids = (Array.isArray(b.hostIds) ? b.hostIds.map(String) : using.filter(h => b.all || h.applied_version < t.current_version).map(h => h.id));
    ids = ids.filter(id => using.some(h => h.id === id && h.state === 'managed'));
    if (!ids.length) throw httpError(400, 'no_hosts', 'No managed host uses this template (or all have the newest version).');
    const [wf] = await query("select * from workflows where builtin = 'push'");
    if (!wf) throw httpError(500, 'no_workflow', 'The built-in workflow "Apply templates" is missing.');
    const def = { ...wf.definition, steps: [{ id: 'push', type: 'templates', values: { templates: [String(t.id)] }, onFailure: 'host', when: { tags: [], groups: [], os: '' } }] };
    const id = await runWorkflow(ctx, wf.id, ids, { name: `Push ${t.name} version ${t.current_version}`, definition: def, params: { templateId: String(t.id) } });
    return { status: 201, body: { id } };
  });
}
