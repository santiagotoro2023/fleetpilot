// Library element "secrets" (blueprint @@BLUEPRINT_VERSION@@): encryption, keys and the check
// against the database, with the test database of test/run.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipher, newKey, parseKey, keyId, setupSecrets, secrets } from '../../server/lib/secrets.mjs';
import { connect, migrate, query, close } from '../../server/core/db.mjs';

let n = 0;
const k1 = parseKey(newKey(), 'k1'), k2 = parseKey(newKey(), 'k2');
const c1 = createCipher(k1);
const t = c1.encrypt('pässwörd 1');
assert.match(t, /^v1\.[0-9a-f]{12}\.[\w-]+\.[\w-]+\.[\w-]*$/); n++;
assert.notEqual(c1.encrypt('pässwörd 1'), t, 'a new IV every time'); n++;
assert.equal(c1.decrypt(t), 'pässwörd 1'); n++;
assert.equal(c1.decrypt(c1.encrypt('')), '', 'empty values work'); n++;
const bad = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
assert.throws(() => c1.decrypt(bad), 'tampering is detected'); n++;
assert.throws(() => createCipher(k2).decrypt(t), /key this server does not have/); n++;
const rotated = createCipher(k2, [k1]);
assert.equal(rotated.decrypt(t), 'pässwörd 1', 'the previous key still decrypts'); n++;
assert.equal(rotated.needsRotation(t), true); n++;
assert.equal(rotated.needsRotation(rotated.encrypt('x')), false); n++;
assert.throws(() => parseKey('short', 'X'), /32 random bytes/); n++;

// The check against the database
await connect({ url: process.env.@@APP_ENV@@_TEST_DATABASE_URL, waitSeconds: 10 });
await migrate();
await query('delete from secret_keys');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
const file = path.join(dir, 'app.key');
delete process.env.@@APP_ENV@@_SECRET_KEY;
process.env.@@APP_ENV@@_SECRET_KEY_FILE = file;
await setupSecrets();
assert.ok(fs.existsSync(file), 'the key file is created on the first start'); n++;
assert.equal((fs.statSync(file).mode & 0o777).toString(8), '400', 'readable only by the app'); n++;
const first = secrets.encrypt('kept');
await setupSecrets();
assert.equal(secrets.decrypt(first), 'kept', 'the same key on the next start'); n++;
fs.rmSync(file);
await assert.rejects(setupSecrets(), /missing/, 'a lost key file is never replaced silently'); n++;
// Moving to a new key: the old one as PREVIOUS keeps everything readable
await query('delete from secret_keys');
const oldKey = newKey(), nextKey = newKey();
process.env.@@APP_ENV@@_SECRET_KEY = oldKey;
await setupSecrets();
const sealed = secrets.encrypt('moved');
process.env.@@APP_ENV@@_SECRET_KEY = nextKey;
await assert.rejects(setupSecrets(), /not the key they were encrypted with/, 'a wrong key stops the app'); n++;
process.env.@@APP_ENV@@_SECRET_KEY_PREVIOUS = oldKey;
await setupSecrets();
assert.equal(secrets.decrypt(sealed), 'moved'); n++;
assert.equal(secrets.needsRotation(sealed), true); n++;
assert.equal(secrets.keyId, keyId(parseKey(nextKey, 'x'))); n++;
delete process.env.@@APP_ENV@@_SECRET_KEY_PREVIOUS;
await setupSecrets();
assert.equal(secrets.decrypt(secrets.encrypt('after')), 'after', 'the new key is recorded'); n++;
await query('delete from secret_keys');
await close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`lib-secrets: ${n} checks passed`);
