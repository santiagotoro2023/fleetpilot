// FleetPilot API: the vault.
//   GET /api/vault?scope=&host=&q=          entries (never their values)
//   POST /api/vault                         { scope, groupId, hostId, kind, name, username, data, generate }
//   GET /api/vault/:id                      one entry and its versions
//   PUT /api/vault/:id                      { name, username, data, generate }: a new version
//   POST /api/vault/:id/reveal              { version }: the values, after a fresh confirmation (recorded)
//   DELETE /api/vault/:id
//   GET /api/vault/fleetpilot               FleetPilot's public key and certificate authorities
//   POST /api/vault/certificate             { publicKey, hours }: a short-lived SSH certificate for yourself
import crypto from 'node:crypto';
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { requireFresh } from '../lib/auth.mjs';
import { accessOf, need } from '../lib/access.mjs';
import { KINDS, createSecret, generatePassword, readSecret, updateSecret, meta, unseal, userCa } from '../lib/vault.mjs';
import { fingerprint, signKey } from '../lib/ssh.mjs';
import { publicKeys } from '../lib/hostctx.mjs';
import { getSetting } from './settings.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));
const str = (v, n) => String(v ?? '').slice(0, n);

/** The values of an entry, checked per kind; public facts derived (fingerprints, expiry) */
async function shape(kind, b, prev = {}) {
  const d = b.data || {};
  const gen = b.generate ? generatePassword(Math.min(128, Math.max(12, Number(b.generate.length) || 24)), b.generate.symbols !== false) : null;
  switch (kind) {
    case 'login': return { data: { password: gen || str(d.password ?? prev.password ?? '', 500), becomePassword: str(d.becomePassword ?? prev.becomePassword ?? '', 500) }, pub: {} };
    case 'password': return { data: { password: gen || str(d.password ?? prev.password ?? '', 500) }, pub: {} };
    case 'token': return { data: { token: str(d.token ?? prev.token ?? '', 8000) }, pub: {} };
    case 'note': return { data: { text: str(d.text ?? prev.text ?? '', 20000) }, pub: {} };
    case 'ssh_key': {
      const privateKey = str(d.privateKey ?? prev.privateKey ?? '', 20000);
      if (privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) throw httpError(400, 'bad_key', 'This is not a private key (-----BEGIN … PRIVATE KEY-----).');
      const publicKey = str(d.publicKey ?? '', 4000).trim();
      return { data: { privateKey, ...(d.certificate ? { certificate: str(d.certificate, 8000) } : prev.certificate ? { certificate: prev.certificate } : {}) }, pub: publicKey ? { publicKey, fingerprint: await fingerprint(publicKey).catch(() => '') } : undefined };
    }
    case 'ssh_cert': return { data: { certificate: str(d.certificate ?? prev.certificate ?? '', 8000) }, pub: {} };
    case 'tls': {
      const certificate = str(d.certificate ?? prev.certificate ?? '', 40000).trim(), key = str(d.key ?? prev.key ?? '', 20000).trim();
      let pub = {};
      if (certificate) {
        try { const x = new crypto.X509Certificate(certificate); pub = { subject: x.subject.replace(/\n/g, ', '), validTo: new Date(x.validTo).toISOString(), names: x.subjectAltName || '' }; }
        catch { throw httpError(400, 'bad_certificate', 'The certificate is not a PEM certificate.'); }
      }
      return { data: { certificate, key }, pub };
    }
    default: throw httpError(400, 'bad_kind', 'This kind of secret does not exist.');
  }
}

async function load(ctx, id, level) {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such secret.');
  const [s] = await query('select s.*, h.group_id as host_group, h.name as host_name, g.name as group_name from secrets s left join hosts h on h.id = s.host_id left join groups g on g.id = s.group_id where s.id = $1', [id]);
  if (!s) throw httpError(404, 'not_found', 'There is no such secret.');
  await need(ctx, 'vault', level, s.scope === 'host' ? s.host_group ?? null : s.scope === 'group' ? s.group_id : undefined);
  if (s.scope === 'system' && level === 'change') throw httpError(403, 'system', 'FleetPilot\'s own keys are made and kept by FleetPilot.');
  return s;
}

export default function vault(app) {
  app.get('/api/vault', async ctx => {
    await need(ctx, 'vault', 'view');
    const a = await accessOf(ctx);
    const s = a.scope('vault', 'view');
    const params = [], where = [];
    if (s !== null) { params.push([...s]); where.push(`(s.scope in ('global', 'system') or s.group_id = any($1::bigint[]) or h.group_id = any($1::bigint[]))`); }
    const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (ctx.query.scope) add('s.scope = ?', String(ctx.query.scope));
    if (isId(ctx.query.host)) add('s.host_id = ?', ctx.query.host);
    if (ctx.query.kind) add('s.kind = ?', String(ctx.query.kind));
    if (ctx.query.q) add('(s.name ilike ? or s.username ilike ? or h.name ilike ?)', `%${String(ctx.query.q).slice(0, 80).replace(/[%_]/g, '')}%`);
    return (await query(`select s.id, s.scope, s.group_id, s.host_id, s.kind, s.name, s.username, s.public, s.version, s.created_by, s.created_at, s.updated_at, s.rotated_at, h.name as host_name, g.name as group_name
      from secrets s left join hosts h on h.id = s.host_id left join groups g on g.id = s.group_id ${where.length ? 'where ' + where.join(' and ') : ''}
      order by (s.scope = 'system'), s.scope, lower(coalesce(h.name, g.name, '')), lower(s.name) limit 2000`, params)).map(r => ({ ...meta(r), host_name: r.host_name, group_name: r.group_name }));
  });

  app.post('/api/vault', async ctx => {
    const b = ctx.body || {};
    const scope = ['global', 'group', 'host'].includes(b.scope) ? b.scope : 'global';
    const groupId = scope === 'group' && isId(b.groupId) ? String(b.groupId) : null;
    const hostId = scope === 'host' && isId(b.hostId) ? String(b.hostId) : null;
    if (scope === 'group' && !groupId) throw httpError(400, 'no_group', 'Choose the group.');
    if (scope === 'host' && !hostId) throw httpError(400, 'no_host', 'Choose the host.');
    let where;
    if (hostId) { const [h] = await query('select group_id from hosts where id = $1', [hostId]); if (!h) throw httpError(404, 'not_found', 'There is no such host.'); where = h.group_id ?? null; }
    await need(ctx, 'vault', 'change', hostId ? where : groupId ?? undefined);
    if (!(b.kind in KINDS)) throw httpError(400, 'bad_kind', 'Choose what kind of secret it is.');
    const name = str(b.name, 120).trim();
    if (!name) throw httpError(400, 'name_missing', 'Give the secret a name.');
    const { data, pub } = await shape(b.kind, b);
    const s = await createSecret({ scope, groupId, hostId, kind: b.kind, name, username: str(b.username, 120).trim(), data, pub: pub || {}, by: ctx.user.username });
    await record(ctx, 'secret.created', { target: { type: 'secret', id: s.id, name }, kind: b.kind, scope });
    return { status: 201, body: s };
  });

  app.get('/api/vault/fleetpilot', async ctx => {
    await need(ctx, 'hosts', 'view');
    return publicKeys();
  });

  app.post('/api/vault/certificate', async ctx => {
    await need(ctx, 'hosts', 'change');
    const pubKey = str(ctx.body?.publicKey, 4000).trim();
    if (!/^(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa) [A-Za-z0-9+/=]+( .*)?$/.test(pubKey)) throw httpError(400, 'bad_key', 'Paste your public key (one line, ssh-ed25519 AAAA…).');
    const hours = Math.min(24, Math.max(1, Math.round(Number(ctx.body?.hours) || 1)));
    await requireFresh(ctx, await getSetting('vault.reveal_minutes'));
    const ca = await userCa();
    const certificate = await signKey({ caPrivateKey: ca.data.privateKey, publicKey: pubKey, identity: `${ctx.user.username}@fleetpilot`, principals: [`fp-${ctx.user.username}`], validity: `+${hours}h` });
    await record(ctx, 'ssh_certificate.issued', { target: { type: 'user', id: ctx.user.id, name: ctx.user.username }, hours });
    return { certificate, principal: `fp-${ctx.user.username}`, hours };
  });

  app.get('/api/vault/:id', async ctx => {
    const s = await load(ctx, ctx.params.id, 'view');
    const versions = await query('select version, created_by, created_at from secret_versions where secret_id = $1 order by version desc', [s.id]);
    return { ...meta(s), host_name: s.host_name, group_name: s.group_name, data: undefined, versions };
  });

  app.put('/api/vault/:id', async ctx => {
    const s = await load(ctx, ctx.params.id, 'change');
    const b = ctx.body || {};
    const prev = unseal(s.data);
    const { data, pub } = await shape(s.kind, b, prev);
    if ('name' in b && str(b.name, 120).trim() && str(b.name, 120).trim() !== s.name) {
      try { await query('update secrets set name = $2 where id = $1', [s.id, str(b.name, 120).trim()]); } catch (e) { if (e.code === '23505') throw httpError(409, 'name_taken', 'There is a secret with this name here already.'); throw e; }
    }
    const r = await updateSecret(s.id, { data, pub, username: 'username' in b ? str(b.username, 120).trim() : undefined, by: ctx.user.username, rotated: !!b.generate });
    await record(ctx, 'secret.changed', { target: { type: 'secret', id: s.id, name: s.name }, version: r.version });
    return r;
  });

  app.post('/api/vault/:id/reveal', async ctx => {
    const s = await load(ctx, ctx.params.id, 'reveal');
    if (s.scope === 'system' && !ctx.user.isAdmin) throw httpError(403, 'not_allowed', 'Only administrators can show FleetPilot\'s own keys.');
    await requireFresh(ctx, await getSetting('vault.reveal_minutes'));
    let data;
    const v = ctx.body?.version;
    if (isId(v) && Number(v) !== s.version) {
      const [old] = await query('select data from secret_versions where secret_id = $1 and version = $2', [s.id, v]);
      if (!old) throw httpError(404, 'not_found', 'There is no such version.');
      data = unseal(old.data);
    } else data = (await readSecret(s.id)).data;
    await record(ctx, 'secret.revealed', { target: { type: 'secret', id: s.id, name: s.host_name ? `${s.host_name}: ${s.name}` : s.name }, version: isId(v) ? Number(v) : s.version });
    return { username: s.username, ...data };
  });

  app.del('/api/vault/:id', async ctx => {
    const s = await load(ctx, ctx.params.id, 'change');
    const used = await query("select t.name from templates t join template_versions v on v.template_id = t.id and v.version = t.current_version where v.definition::text like $1", [`%"${s.id}"%`]);
    if (used.length) throw httpError(409, 'in_use', `The template ${used[0].name} uses this secret. Change the template first.`);
    await query('delete from secrets where id = $1', [s.id]);
    await record(ctx, 'secret.deleted', { target: { type: 'secret', id: s.id, name: s.name } });
    return null;
  });
}
