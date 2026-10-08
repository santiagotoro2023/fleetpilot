// FleetPilot API: hosts.
//   GET /api/hosts?q=&group=&state=&tag=&drift=     the hosts the user may see
//   POST /api/hosts                                  { hosts: [{ name, address, port }], groupId, tags, workflowId }
//   GET /api/hosts/:id                               one host with its groups, addresses, runs
//   GET /api/hosts/:id/state                         its desired state: templates, settings, playbook
//   PATCH /api/hosts/:id                             { name, address, port, groupId, tags, notes, state }
//   DELETE /api/hosts/:id                            its secrets stay in the vault
//   POST /api/hosts/bulk                             { ids, action: move|tag|untag|retire|activate|delete, groupId, tags }
//   POST /api/hosts/:id/templates                    { templateId }      DELETE /api/hosts/:id/templates/:templateId
//   POST /api/hosts/:id/ping                         does it answer on its SSH port?
import net from 'node:net';
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { accessOf, hostFilter, need } from '../lib/access.mjs';
import { desiredState, groupPaths } from '../lib/hostctx.mjs';
import { TYPES, playOf } from '../lib/compile.mjs';
import { toYaml } from '../lib/yaml.mjs';
import { assign, subnetOf } from '../lib/ipam.mjs';
import { hostAdded } from './workflows.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ADDRESS = /^([A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9a-fA-F:]{2,39})$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const tagsOf = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map(t => String(t).trim()).filter(Boolean))].map(t => {
  if (!TAG.test(t)) throw httpError(400, 'bad_tag', `"${t}" cannot be a tag: letters, digits, dots, dashes and underscores.`);
  return t;
}).slice(0, 30);
const isId = v => /^\d+$/.test(String(v ?? ''));

const LIST = `select h.id::text, h.name, h.address, h.port, h.kind, h.group_id::text, h.state, h.os, h.os_version, h.tags, h.drift, h.source_id::text, h.last_seen_at, h.last_run_at, h.created_at,
  (h.connection->>'user') as login, g.name as group_name,
  (select json_build_object('id', r.id::text, 'status', rh.status, 'name', r.name, 'at', coalesce(r.finished_at, r.created_at)) from run_hosts rh join runs r on r.id = rh.run_id where rh.host_id = h.id order by r.id desc limit 1) as last_run
  from hosts h left join groups g on g.id = h.group_id`;

export async function hostById(ctx, id, level = 'view') {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such host.');
  const [h] = await query('select * from hosts where id = $1', [id]);
  if (!h) throw httpError(404, 'not_found', 'There is no such host.');
  await need(ctx, 'hosts', level, h.group_id ?? null);
  return h;
}

/** Adds hosts; returns the new ids and what was skipped */
export async function addHosts(ctx, list, { groupId = null, tags = [], sourceId = null } = {}) {
  const added = [], skipped = [];
  for (const raw of list.slice(0, 1000)) {
    const address = String(raw.address ?? '').trim();
    const name = String(raw.name || address.split('.')[0] || '').trim();
    if (!ADDRESS.test(address)) { skipped.push({ name, address, why: 'The address is not an IP address or a host name.' }); continue; }
    if (!NAME.test(name)) { skipped.push({ name, address, why: 'Host names have letters, digits, dots, dashes and underscores.' }); continue; }
    const port = Number(raw.port) || 22;
    if (port < 1 || port > 65535) { skipped.push({ name, address, why: 'The port is not possible.' }); continue; }
    const rows = await query(`insert into hosts (name, address, port, group_id, tags, source_id, external_id) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict do nothing returning id`, [name, address, port, raw.groupId || groupId, [...new Set([...tags, ...(raw.tags || [])])], raw.sourceId || sourceId, String(raw.externalId || '')]);
    if (!rows.length) { skipped.push({ name, address, why: 'A host with this name exists already.' }); continue; }
    const id = String(rows[0].id);
    added.push(id);
    // An address in a known subnet is recorded there
    if (net.isIP(address) && await subnetOf(address)) await assign(address, id, name, { note: 'Added with the host' }).catch(e => skipped.push({ name, address, why: `Added, but its address is not free in IP management: ${e.message}` }));
  }
  if (added.length) await record(ctx, 'host.added', { target: { type: 'hosts', id: added.length === 1 ? added[0] : '', name: added.length === 1 ? list[0].name || list[0].address : `${added.length} hosts` }, count: added.length });
  return { added, skipped };
}

export default function hosts(app) {
  app.get('/api/hosts', async ctx => {
    await need(ctx, 'hosts', 'view');
    const [scope, params] = await hostFilter(ctx);
    const where = [scope], q = ctx.query;
    const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (q.q) add("(h.name ilike ? or h.address ilike ? or h.os ilike ? or array_to_string(h.tags, ' ') ilike ?)", `%${String(q.q).slice(0, 100).replace(/[%_]/g, '')}%`);
    if (q.group && isId(q.group)) add('h.group_id in (with recursive t(id) as (select ?::bigint union all select g.id from groups g join t on g.parent_id = t.id) select id from t)', q.group);
    if (q.ungrouped) where.push('h.group_id is null');
    if (q.state) add('h.state = ?', String(q.state));
    if (q.tag) add('? = any(h.tags)', String(q.tag));
    if (q.drift) where.push("(h.drift->>'changed')::int > 0");
    if (q.source && isId(q.source)) add('h.source_id = ?', q.source);
    return query(`${LIST} where ${where.join(' and ')} order by lower(h.name) limit 5000`, params);
  });

  app.post('/api/hosts', async ctx => {
    const b = ctx.body || {};
    const groupId = isId(b.groupId) ? String(b.groupId) : null;
    await need(ctx, 'hosts', 'manage', groupId ?? undefined);
    if (groupId && !(await query('select 1 from groups where id = $1', [groupId])).length) throw httpError(400, 'no_group', 'This group does not exist.');
    const list = Array.isArray(b.hosts) ? b.hosts : [];
    if (!list.length) throw httpError(400, 'no_hosts', 'Name at least one host.');
    if (list.length > 1000) throw httpError(400, 'too_many', 'At most 1000 hosts at once.');
    const r = await addHosts(ctx, list, { groupId, tags: tagsOf(b.tags) });
    let run = null;
    if (r.added.length && isId(b.workflowId)) {
      const { runWorkflow } = await import('./workflows.mjs');
      run = await runWorkflow(ctx, b.workflowId, r.added);
    } else if (r.added.length) await hostAdded(r.added);
    return { status: 201, body: { ...r, run } };
  });

  app.get('/api/hosts/:id', async ctx => {
    const h = await hostById(ctx, ctx.params.id);
    const paths = await groupPaths();
    const a = await accessOf(ctx);
    const [addresses, runs, secrets, vm] = await Promise.all([
      query('select a.id::text, host(a.ip) as ip, a.state, s.cidr, s.name as subnet from addresses a join subnets s on s.id = a.subnet_id where a.host_id = $1 order by a.ip', [h.id]),
      query('select r.id::text, r.name, r.kind, r.status, rh.status as host_status, r.created_at, r.finished_at, r.requested_by from run_hosts rh join runs r on r.id = rh.run_id where rh.host_id = $1 order by r.id desc limit 30', [h.id]),
      a.can('vault', 'view', h.group_id ?? null) ? query("select id::text, kind, name, username, public, version, updated_at, rotated_at from secrets where scope = 'host' and host_id = $1 order by lower(name)", [h.id]) : [],
      query('select v.*, s.name as source from source_vms v join sources s on s.id = v.source_id where v.host_id = $1', [h.id])
    ]);
    return {
      ...h, id: String(h.id), group_id: h.group_id && String(h.group_id), source_id: h.source_id && String(h.source_id),
      path: h.group_id ? paths.path(h.group_id).map(g => ({ id: String(g.id), name: g.name, kind: g.kind })) : [],
      host_keys: h.host_keys ? h.host_keys.split('\n').filter(Boolean).map(k => k.split(' ')[0]) : [],
      addresses, runs, secrets, vm: vm[0] || null,
      may: { change: a.can('hosts', 'change', h.group_id ?? null), manage: a.can('hosts', 'manage', h.group_id ?? null), run: a.can('runs', 'run', h.group_id ?? null), vault: a.can('vault', 'view', h.group_id ?? null) }
    };
  });

  app.get('/api/hosts/:id/state', async ctx => {
    const h = await hostById(ctx, ctx.params.id);
    const state = await desiredState(h);
    const applied = await query('select template_id::text, applied_version, applied_at from host_templates where host_id = $1', [h.id]);
    const settings = [...state.merged].map(([type, v]) => { const t = TYPES.get(type); return { type, area: t.area, title: t.title, summary: t.summary ? t.summary(v) : '' }; });
    return {
      templates: state.templates.map(t => ({ ...t, definition: undefined, applied: applied.find(a => a.template_id === t.template) || null })),
      settings, drift: h.drift,
      playbook: `# The desired state of ${h.name}, as FleetPilot applies it (variables are filled in per host)\n` + toYaml([playOf(state.merged, { name: `Desired state of ${h.name}`, hosts: h.name })])
    };
  });

  app.patch('/api/hosts/:id', async ctx => {
    const h = await hostById(ctx, ctx.params.id, 'change');
    const b = ctx.body || {};
    const next = { name: h.name, address: h.address, port: h.port, group_id: h.group_id, tags: h.tags, notes: h.notes, state: h.state };
    if ('name' in b) { if (!NAME.test(String(b.name))) throw httpError(400, 'bad_name', 'Host names have letters, digits, dots, dashes and underscores.'); next.name = String(b.name); }
    if ('address' in b) { if (!ADDRESS.test(String(b.address))) throw httpError(400, 'bad_address', 'The address is not an IP address or a host name.'); next.address = String(b.address); }
    if ('port' in b) { const p = Number(b.port); if (!(p >= 1 && p <= 65535)) throw httpError(400, 'bad_port', 'The port is not possible.'); next.port = p; }
    if ('groupId' in b) {
      next.group_id = isId(b.groupId) ? String(b.groupId) : null;
      await need(ctx, 'hosts', 'change', next.group_id ?? null);
    }
    if ('tags' in b) next.tags = tagsOf(b.tags);
    if ('notes' in b) next.notes = String(b.notes).slice(0, 4000);
    if ('state' in b) {
      if (b.state === 'retired') next.state = 'retired';
      else if (b.state === 'active') next.state = h.connection?.user === 'fleetpilot' ? 'managed' : 'new';
    }
    try {
      await query('update hosts set name = $2, address = $3, port = $4, group_id = $5, tags = $6, notes = $7, state = $8, updated_at = now() where id = $1',
        [h.id, next.name, next.address, next.port, next.group_id, next.tags, next.notes, next.state]);
    } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'Another host has this name.'); throw e; }
    await record(ctx, 'host.changed', { target: { type: 'host', id: h.id, name: next.name }, changes: Object.keys(b) });
    return (await query(`${LIST} where h.id = $1`, [h.id]))[0];
  });

  app.del('/api/hosts/:id', async ctx => {
    const h = await hostById(ctx, ctx.params.id, 'manage');
    await removeHost(ctx, h);
    return null;
  });

  app.post('/api/hosts/bulk', async ctx => {
    const b = ctx.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(isId).slice(0, 5000);
    if (!ids.length) throw httpError(400, 'no_hosts', 'Choose hosts first.');
    const list = await query('select * from hosts where id = any($1::bigint[])', [ids]);
    const a = await accessOf(ctx);
    const level = b.action === 'delete' ? 'manage' : 'change';
    for (const h of list) if (!a.can('hosts', level, h.group_id ?? null)) throw httpError(403, 'not_allowed', `Your roles do not allow this for ${h.name}.`);
    let n = 0;
    if (b.action === 'move') {
      const g = isId(b.groupId) ? String(b.groupId) : null;
      if (g) await need(ctx, 'hosts', 'change', g);
      n = (await query('update hosts set group_id = $2, updated_at = now() where id = any($1::bigint[]) returning id', [ids, g])).length;
    } else if (b.action === 'tag' || b.action === 'untag') {
      const t = tagsOf(b.tags);
      n = (await query(b.action === 'tag'
        ? 'update hosts set tags = array(select distinct x from unnest(tags || $2::text[]) x), updated_at = now() where id = any($1::bigint[]) returning id'
        : 'update hosts set tags = array(select x from unnest(tags) x where not x = any($2::text[])), updated_at = now() where id = any($1::bigint[]) returning id', [ids, t])).length;
    } else if (b.action === 'retire' || b.action === 'activate') {
      n = (await query(b.action === 'retire' ? "update hosts set state = 'retired' where id = any($1::bigint[]) returning id"
        : "update hosts set state = case when connection->>'user' = 'fleetpilot' then 'managed' else 'new' end where id = any($1::bigint[]) and state = 'retired' returning id", [ids])).length;
    } else if (b.action === 'delete') {
      for (const h of list) { await removeHost(ctx, h); n++; }
    } else throw httpError(400, 'bad_action', 'This is not something hosts can do together.');
    if (b.action !== 'delete') await record(ctx, `host.bulk_${b.action}`, { target: { type: 'hosts', name: `${n} hosts` }, ids, groupId: b.groupId, tags: b.tags });
    return { changed: n };
  });

  app.post('/api/hosts/:id/templates', async ctx => {
    const h = await hostById(ctx, ctx.params.id, 'change');
    if (!isId(ctx.body?.templateId)) throw httpError(400, 'no_template', 'Choose a template.');
    const [t] = await query('select id, name from templates where id = $1 and not archived', [ctx.body.templateId]);
    if (!t) throw httpError(404, 'not_found', 'There is no such template.');
    await query(`insert into assignments (template_id, host_id, position) values ($1, $2, (select coalesce(max(position), 0) + 1 from assignments where host_id = $2)) on conflict do nothing`, [t.id, h.id]);
    await record(ctx, 'template.assigned', { target: { type: 'host', id: h.id, name: h.name }, template: t.name });
    return null;
  });
  app.del('/api/hosts/:id/templates/:templateId', async ctx => {
    const h = await hostById(ctx, ctx.params.id, 'change');
    await query('delete from assignments where host_id = $1 and template_id = $2', [h.id, isId(ctx.params.templateId) ? ctx.params.templateId : 0]);
    await record(ctx, 'template.unassigned', { target: { type: 'host', id: h.id, name: h.name }, template: ctx.params.templateId });
    return null;
  });

  app.post('/api/hosts/:id/ping', async ctx => {
    const h = await hostById(ctx, ctx.params.id);
    const t0 = Date.now();
    const ok = await new Promise(res => {
      const s = net.connect({ host: h.address, port: h.port, timeout: 3000 });
      const done = v => { s.destroy(); res(v); };
      s.on('connect', () => done(true)); s.on('error', () => done(false)); s.on('timeout', () => done(false));
    });
    if (ok) await query('update hosts set last_seen_at = now() where id = $1', [h.id]);
    return { reachable: ok, ms: Date.now() - t0 };
  });
}

/** Removes a host; its secrets stay in the vault as global entries named after it */
async function removeHost(ctx, h) {
  await tx(async c => {
    await c.query("update secrets set scope = 'global', host_id = null, name = left($2 || ': ' || name, 120), updated_at = now() where scope = 'host' and host_id = $1", [h.id, `${h.name} #${h.id}`]);
    await c.query("delete from addresses where host_id = $1 and state = 'assigned'", [h.id]);
    await c.query('delete from hosts where id = $1', [h.id]);
  });
  await record(ctx, 'host.removed', { target: { type: 'host', id: h.id, name: h.name } });
}
