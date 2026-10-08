// FleetPilot: the vault. Every value is encrypted with the key of the library element secrets;
// old versions are kept (the last 10), so a half finished rotation never locks anyone out.
import crypto from 'node:crypto';
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { secrets } from './secrets.mjs';
import { newKeyPair } from './ssh.mjs';

export const KINDS = {
  login: 'Login (user and password)', password: 'Password', ssh_key: 'SSH key pair', ssh_cert: 'SSH certificate',
  token: 'API token', tls: 'TLS certificate and key', note: 'Secret note'
};
const KEEP = 10;

/** A random password: letters and digits, with symbols when asked; never ambiguous characters */
export function generatePassword(length = 24, symbols = true) {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', ...(symbols ? ['-_.:+=!%@'] : [])];
  const all = sets.join('');
  for (;;) {
    const pw = Array.from({ length }, () => all[crypto.randomInt(all.length)]).join('');
    if (sets.every(s => [...pw].some(c => s.includes(c)))) return pw;
  }
}

/** A WireGuard key pair (x25519, base64) */
export function wireguardKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const b64 = k => Buffer.from(k.export({ format: 'jwk' })[k.type === 'private' ? 'd' : 'x'], 'base64url').toString('base64');
  return { privateKey: b64(privateKey), publicKey: b64(publicKey) };
}

export const seal = data => secrets.encrypt(JSON.stringify(data));
export const unseal = text => JSON.parse(secrets.decrypt(text));

const COLS = 'id, scope, group_id, host_id, kind, name, username, public, version, created_by, created_at, updated_at, rotated_at';
export const meta = r => r && ({ ...r, id: String(r.id), group_id: r.group_id && String(r.group_id), host_id: r.host_id && String(r.host_id) });

export async function createSecret({ scope = 'global', groupId = null, hostId = null, kind, name, username = '', data, pub = {}, by = '' }, c = null) {
  const q = c ? (s, a) => c.query(s, a).then(r => r.rows) : query;
  const rows = await q(`insert into secrets (scope, group_id, host_id, kind, name, username, data, public, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    on conflict do nothing returning ${COLS}`, [scope, groupId, hostId, kind, name, username, seal(data), JSON.stringify(pub), by]);
  if (!rows.length) throw httpError(409, 'name_taken', `There is already a secret called "${name}" here.`);
  return meta(rows[0]);
}

/** A new value: the old one goes into the history */
export async function updateSecret(id, { data, username, pub, by = '', rotated = false }) {
  return tx(async c => {
    const [cur] = (await c.query('select * from secrets where id = $1 for update', [id])).rows;
    if (!cur) throw httpError(404, 'not_found', 'There is no such secret.');
    await c.query('insert into secret_versions (secret_id, version, data, created_by) values ($1, $2, $3, $4)', [id, cur.version, cur.data, cur.created_by]);
    await c.query('delete from secret_versions where secret_id = $1 and version <= $2', [id, cur.version - KEEP]);
    const [row] = (await c.query(`update secrets set data = coalesce($2, data), username = coalesce($3, username), public = coalesce($4, public), version = version + 1,
      created_by = $5, updated_at = now(), rotated_at = case when $6 then now() else rotated_at end where id = $1 returning ${COLS}`,
    [id, data === undefined ? null : seal(data), username ?? null, pub ? JSON.stringify(pub) : null, by, rotated])).rows;
    return meta(row);
  });
}

export async function readSecret(id) {
  const [r] = await query(`select ${COLS}, data from secrets where id = $1`, [id]);
  if (!r) return null;
  return { ...meta(r), data: unseal(r.data) };
}

/** A secret of a host by kind and name, made when missing (make() gives { data, pub, username }) */
export async function hostSecret(hostId, kind, name, make) {
  const [r] = await query(`select ${COLS}, data from secrets where scope = 'host' and host_id = $1 and lower(name) = lower($2)`, [hostId, name]);
  if (r) return { ...meta(r), data: unseal(r.data) };
  if (!make) return null;
  const m = await make();
  try { await createSecret({ scope: 'host', hostId, kind, name, username: m.username || '', data: m.data, pub: m.pub || {}, by: 'FleetPilot' }); }
  catch (e) { if (e.code !== 'name_taken') throw e; }
  return hostSecret(hostId, kind, name);
}

/** A secret of FleetPilot itself (its key, the certificate authorities), made on first use */
export async function systemSecret(name, make) {
  const [r] = await query(`select ${COLS}, data from secrets where scope = 'system' and lower(name) = lower($1)`, [name]);
  if (r) return { ...meta(r), data: unseal(r.data) };
  const m = await make();
  try { await createSecret({ scope: 'system', kind: m.kind || 'ssh_key', name, data: m.data, pub: m.pub || {}, by: 'FleetPilot' }); }
  catch (e) { if (e.code !== 'name_taken') throw e; }
  return systemSecret(name, make);
}

const keyPair = comment => async () => { const k = await newKeyPair(comment); return { data: { privateKey: k.privateKey }, pub: { publicKey: k.publicKey, fingerprint: k.fingerprint } }; };
/** FleetPilot's own SSH key and its two certificate authorities */
export const fleetKey = () => systemSecret('FleetPilot SSH key', keyPair('fleetpilot'));
export const userCa = () => systemSecret('SSH user certificate authority', keyPair('FleetPilot user CA'));
export const hostCa = () => systemSecret('SSH host certificate authority', keyPair('FleetPilot host CA'));

/** A shared secret (the same on every host that uses it), made on first use */
export async function sharedSecret(key, label, length = 24) {
  return (await systemSecret(`Shared: ${label || key}`, async () => ({ kind: 'password', data: { password: generatePassword(length, false) } }))).data.password;
}
