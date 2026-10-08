// FleetPilot API: hypervisors that list their machines (Proxmox VE).
//   GET /api/sources                          POST /api/sources { name, url, tokenId, token, verifyTls, fingerprint, groupId }
//   PATCH|DELETE /api/sources/:id             POST /api/sources/fingerprint { url }: the certificate to pin
//   POST /api/sources/:id/sync                reads the VMs now
//   GET /api/sources/:id/vms                  the VMs found, with the host each one is
//   POST /api/sources/:id/import              { vmIds, groupId, workflowId }: VMs become hosts
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { need } from '../lib/access.mjs';
import { createSecret, readSecret, updateSecret } from '../lib/vault.mjs';
import { fetchFingerprint, listVms } from '../lib/proxmox.mjs';
import { addHosts } from './hosts.mjs';
import { hostAdded, runWorkflow } from './workflows.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const COLS = 's.id::text, s.kind, s.name, s.url, s.token_id, s.verify_tls, s.fingerprint, s.group_id::text, s.last_sync_at, s.last_error, s.created_at, g.name as group_name';

async function load(id) {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such source.');
  const [s] = await query('select * from sources where id = $1', [id]);
  if (!s) throw httpError(404, 'not_found', 'There is no such source.');
  return s;
}

/** Reads the VMs of a source and keeps them (also links them to hosts with the same name or address) */
export async function syncSource(s) {
  const secret = s.secret_id ? await readSecret(s.secret_id) : null;
  try {
    const vms = await listVms(s, secret?.data?.token || '');
    for (const v of vms) {
      await query(`insert into source_vms (source_id, external_id, node, name, type, status, ips, tags, os, seen_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
        on conflict (source_id, external_id) do update set node = $3, name = $4, type = $5, status = $6, ips = case when cardinality($7::text[]) > 0 then $7 else source_vms.ips end, tags = $8, os = case when $9 <> '' then $9 else source_vms.os end, seen_at = now()`,
      [s.id, v.externalId, v.node, v.name, v.type, v.status, v.ips, v.tags, v.os]);
    }
    await query(`update source_vms v set host_id = h.id from hosts h where v.source_id = $1 and v.host_id is null and (h.source_id = $1 and h.external_id = v.external_id or lower(h.name) = lower(v.name))`, [s.id]);
    // VMs that are gone from Proxmox are forgotten (their hosts stay)
    await query("delete from source_vms where source_id = $1 and seen_at < now() - interval '1 minute'", [s.id]);
    await query("update sources set last_sync_at = now(), last_error = '' where id = $1", [s.id]);
    return { vms: vms.length };
  } catch (e) {
    await query('update sources set last_error = $2 where id = $1', [s.id, e.message.slice(0, 500)]);
    throw httpError(502, 'source_failed', e.message);
  }
}

export default function sources(app) {
  app.get('/api/sources', async ctx => {
    await need(ctx, 'hosts', 'view');
    return query(`select ${COLS}, (select count(*)::int from source_vms v where v.source_id = s.id) as vms, (select count(*)::int from source_vms v where v.source_id = s.id and v.host_id is not null) as hosts
      from sources s left join groups g on g.id = s.group_id order by lower(s.name)`);
  });

  app.post('/api/sources/fingerprint', async ctx => {
    await need(ctx, 'hosts', 'manage');
    try { return { fingerprint: await fetchFingerprint(str(ctx.body?.url, 300)) }; }
    catch (e) { throw httpError(502, 'no_answer', `No certificate from that address: ${e.message}`); }
  });

  app.post('/api/sources', async ctx => {
    await need(ctx, 'hosts', 'manage');
    const b = ctx.body || {};
    const name = str(b.name, 80), url = str(b.url, 300).replace(/\/+$/, '');
    if (!name) throw httpError(400, 'name_missing', 'Give the source a name.');
    if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(:\d+)?$/.test(url)) throw httpError(400, 'bad_url', 'The address looks like https://pve.example.com:8006');
    if (!/^[A-Za-z0-9._@!-]+![A-Za-z0-9._-]+$/.test(str(b.tokenId, 200))) throw httpError(400, 'bad_token', 'The token id looks like fleetpilot@pve!inventory');
    if (!str(b.token, 200)) throw httpError(400, 'no_token', 'Give the secret of the token.');
    const secret = await createSecret({ scope: 'system', kind: 'token', name: `Proxmox token: ${name}`, username: str(b.tokenId, 200), data: { token: str(b.token, 200) }, by: ctx.user.username }).catch(e => { if (e.code === 'name_taken') throw httpError(409, 'name_taken', 'There is a source with this name already.'); throw e; });
    const rows = await query(`insert into sources (name, url, token_id, secret_id, verify_tls, fingerprint, group_id) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing returning *`,
      [name, url, str(b.tokenId, 200), secret.id, b.verifyTls !== false, str(b.fingerprint, 200), isId(b.groupId) ? b.groupId : null]);
    if (!rows.length) { await query('delete from secrets where id = $1', [secret.id]); throw httpError(409, 'name_taken', 'There is a source with this name already.'); }
    await record(ctx, 'source.created', { target: { type: 'source', id: rows[0].id, name }, url });
    let sync = null;
    try { sync = await syncSource(rows[0]); } catch (e) { sync = { error: e.message }; }
    return { status: 201, body: { id: String(rows[0].id), sync } };
  });

  app.patch('/api/sources/:id', async ctx => {
    await need(ctx, 'hosts', 'manage');
    const s = await load(ctx.params.id);
    const b = ctx.body || {};
    const url = 'url' in b ? str(b.url, 300).replace(/\/+$/, '') : s.url;
    if (!/^https?:\/\/[A-Za-z0-9.:[\]-]+(:\d+)?$/.test(url)) throw httpError(400, 'bad_url', 'The address looks like https://pve.example.com:8006');
    await query('update sources set name = $2, url = $3, token_id = $4, verify_tls = $5, fingerprint = $6, group_id = $7, updated_at = now() where id = $1',
      [s.id, 'name' in b ? str(b.name, 80) || s.name : s.name, url, 'tokenId' in b ? str(b.tokenId, 200) : s.token_id, 'verifyTls' in b ? !!b.verifyTls : s.verify_tls, 'fingerprint' in b ? str(b.fingerprint, 200) : s.fingerprint, 'groupId' in b ? (isId(b.groupId) ? b.groupId : null) : s.group_id]);
    if (str(b.token, 200) && s.secret_id) await updateSecret(s.secret_id, { data: { token: str(b.token, 200) }, by: ctx.user.username, rotated: true });
    await record(ctx, 'source.changed', { target: { type: 'source', id: s.id, name: s.name }, changes: Object.keys(b).filter(k => k !== 'token') });
    return null;
  });

  app.del('/api/sources/:id', async ctx => {
    await need(ctx, 'hosts', 'manage');
    const s = await load(ctx.params.id);
    await query('delete from sources where id = $1', [s.id]);
    if (s.secret_id) await query('delete from secrets where id = $1', [s.secret_id]);
    await record(ctx, 'source.deleted', { target: { type: 'source', id: s.id, name: s.name } });
    return null;
  });

  app.post('/api/sources/:id/sync', async ctx => {
    await need(ctx, 'hosts', 'view');
    return syncSource(await load(ctx.params.id));
  });

  app.get('/api/sources/:id/vms', async ctx => {
    await need(ctx, 'hosts', 'view');
    const s = await load(ctx.params.id);
    return query(`select v.id::text, v.external_id, v.node, v.name, v.type, v.status, v.ips, v.tags, v.os, v.seen_at, v.host_id::text, h.name as host_name, h.state as host_state
      from source_vms v left join hosts h on h.id = v.host_id where v.source_id = $1 order by lower(v.name)`, [s.id]);
  });

  app.post('/api/sources/:id/import', async ctx => {
    const s = await load(ctx.params.id);
    const b = ctx.body || {};
    const groupId = isId(b.groupId) ? String(b.groupId) : s.group_id ? String(s.group_id) : null;
    await need(ctx, 'hosts', 'manage', groupId ?? undefined);
    const ids = (Array.isArray(b.vmIds) ? b.vmIds : []).filter(isId);
    const vms = await query('select * from source_vms where source_id = $1 and id = any($2::bigint[]) and host_id is null', [s.id, ids]);
    const list = [], skipped = [];
    for (const v of vms) {
      if (!v.ips.length) { skipped.push({ name: v.name, why: 'No address known: start the VM with the QEMU guest agent, or add it by its address.' }); continue; }
      list.push({ name: v.name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63) || `vm${v.external_id.split('/')[1]}`, address: v.ips[0], tags: v.tags.filter(t => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t)), sourceId: s.id, externalId: v.external_id });
    }
    const r = await addHosts(ctx, list, { groupId });
    await query('update source_vms v set host_id = h.id from hosts h where v.source_id = $1 and h.source_id = $1 and h.external_id = v.external_id and v.host_id is null', [s.id]);
    let run = null;
    if (r.added.length && isId(b.workflowId)) run = await runWorkflow(ctx, b.workflowId, r.added);
    else if (r.added.length) await hostAdded(r.added);
    return { added: r.added.length, skipped: [...skipped, ...r.skipped], run };
  });
}
