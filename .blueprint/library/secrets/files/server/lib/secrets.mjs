// Library element "secrets" (blueprint @@BLUEPRINT_VERSION@@): sensitive values encrypted at rest
// with AES-256-GCM and a key that lives outside the database (spec/12-library.md, secrets).
//
//   import { secrets, setupSecrets } from './lib/secrets.mjs'
//   await start({ routes: [setupSecrets, …] })    checks the key once the database is migrated
//   const token = secrets.encrypt('s3cret')       'v1.<key id>.<iv>.<tag>.<data>' (base64url)
//   secrets.decrypt(token)                         's3cret'
//   secrets.needsRotation(token)                   true when made with the previous key
//
// The key (32 random bytes, base64) comes from @@APP_ENV@@_SECRET_KEY, or from the file named by
// @@APP_ENV@@_SECRET_KEY_FILE, which is created when it is missing and nothing was encrypted yet.
// @@APP_ENV@@_SECRET_KEY_PREVIOUS keeps an old key readable while the app re-encrypts with the new one.
// A new key: node server/lib/secrets.mjs --new-key
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../core/db.mjs';

const env = k => (process.env[`@@APP_ENV@@_${k}`] ?? '').trim();
const b64u = b => Buffer.from(b).toString('base64url');

export const newKey = () => crypto.randomBytes(32).toString('base64');
export const keyId = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

/** A 32-byte key from its base64 text, or an error that says what is wrong */
export function parseKey(text, where) {
  const key = Buffer.from(String(text || '').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${where} must be 32 random bytes in base64 (make one with: node server/lib/secrets.mjs --new-key)`);
  return key;
}

/** Encryption with a current key and, optionally, older keys that can still decrypt */
export function createCipher(current, previous = []) {
  const keys = new Map([current, ...previous].map(k => [keyId(k), k]));
  const id = keyId(current);
  return {
    keyId: id,
    keyIds: [...keys.keys()],
    encrypt(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', current, iv);
      const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return ['v1', id, b64u(iv), b64u(c.getAuthTag()), b64u(data)].join('.');
    },
    decrypt(token) {
      const [v, kid, iv, tag, data] = String(token || '').split('.');
      if (v !== 'v1' || !kid || iv === undefined || data === undefined) throw new Error('Not an encrypted value.');
      const key = keys.get(kid);
      if (!key) throw new Error('This value was encrypted with a key this server does not have.');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
    },
    needsRotation: token => String(token || '').split('.')[1] !== id
  };
}

let cipher = null;
const ready = () => { if (!cipher) throw new Error('secrets: setupSecrets did not run (add it to the routes in server/main.mjs)'); return cipher; };
export const secrets = {
  encrypt: t => ready().encrypt(t),
  decrypt: t => ready().decrypt(t),
  needsRotation: t => ready().needsRotation(t),
  get keyId() { return ready().keyId; }
};

/** The current key from the environment; the key file is created when allowed */
export function loadKey({ mayCreate = false } = {}) {
  if (env('SECRET_KEY')) return parseKey(env('SECRET_KEY'), '@@APP_ENV@@_SECRET_KEY');
  const file = env('SECRET_KEY_FILE');
  if (!file) throw new Error('No key for the stored secrets: set @@APP_ENV@@_SECRET_KEY (or @@APP_ENV@@_SECRET_KEY_FILE). Make one with: node server/lib/secrets.mjs --new-key');
  if (!fs.existsSync(file) && mayCreate) {
    try { fs.writeFileSync(file, newKey() + '\n', { flag: 'wx', mode: 0o400 }); }
    catch (e) { if (e.code !== 'EEXIST') throw new Error(`Cannot create the key file ${file}: ${e.message}`); }
  }
  if (!fs.existsSync(file)) throw new Error(`The key file ${file} (@@APP_ENV@@_SECRET_KEY_FILE) is missing. Restore it from your backup of the key.`);
  return parseKey(fs.readFileSync(file, 'utf8'), `The key file ${file}`);
}

/**
 * Checks the key against the database: the first key is recorded, later starts must use it
 * (or name it as @@APP_ENV@@_SECRET_KEY_PREVIOUS while moving to a new one).
 */
export async function setupSecrets() {
  const known = (await query('select id from secret_keys')).map(r => r.id);
  const current = loadKey({ mayCreate: known.length === 0 });
  const previous = env('SECRET_KEY_PREVIOUS') ? [parseKey(env('SECRET_KEY_PREVIOUS'), '@@APP_ENV@@_SECRET_KEY_PREVIOUS')] : [];
  const c = createCipher(current, previous);
  if (known.length && !c.keyIds.some(id => known.includes(id))) {
    throw new Error(`The key for the stored secrets (id ${c.keyId}) is not the key they were encrypted with (${known.join(', ')}). Restore the right key, or give the old one as @@APP_ENV@@_SECRET_KEY_PREVIOUS to move to a new one.`);
  }
  await query('insert into secret_keys (id) values ($1) on conflict do nothing', [c.keyId]);
  cipher = c;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv[2] === '--new-key') console.log(newKey());
  else { console.error('Usage: node server/lib/secrets.mjs --new-key'); process.exit(1); }
}
