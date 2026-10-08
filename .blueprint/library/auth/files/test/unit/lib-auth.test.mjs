// Library element "auth" (blueprint @@BLUEPRINT_VERSION@@): passwords, TOTP, policy and the API of a
// running app server against the test database of test/run.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { hashPassword, verifyPassword, passwordProblems, normalizePolicy, DEFAULT_POLICY, totpCode, totpMatch, base32, unbase32, randomPassword } from '../../server/lib/auth.mjs';
import { apiSession, totp, TEST_USER } from '../lib/auth.mjs';

let n = 0;
// ---------------------------------------------------------------- Without a server
const h = await hashPassword('Tr0ub4dor & 3');
assert.match(h, /^scrypt\$32768\$8\$1\$/); n++;
assert.equal(await verifyPassword('Tr0ub4dor & 3', h), true); n++;
assert.equal(await verifyPassword('Tr0ub4dor & 4', h), false); n++;
const pol = normalizePolicy(DEFAULT_POLICY);
assert.deepEqual(passwordProblems('correct horse battery', pol), []); n++;
assert.match(passwordProblems('short', pol)[0], /at least 12/); n++;
assert.match(passwordProblems('password1234', pol).join(' '), /well-known/); n++;
assert.match(passwordProblems('aaaaaaaaaaaaaaaa', pol).join(' '), /too easy/); n++;
assert.match(passwordProblems('jdoe-is-my-name-ok', pol, { username: 'jdoe' }).join(' '), /user name/); n++;
assert.match(passwordProblems('only lowercase here', { ...pol, requireUpper: true, requireDigit: true }).join(' '), /uppercase[\s\S]*digit/); n++;
assert.equal(normalizePolicy({ minLength: 3, totp: 'maybe', lockoutAttempts: 999 }).minLength, 8, 'limits'); n++;
assert.equal(normalizePolicy({ totp: 'maybe' }).totp, 'none'); n++;
// RFC 6238 test vector (SHA-1, secret "12345678901234567890", T = 59 s → 94287082, 6 digits: 287082)
const rfc = base32(Buffer.from('12345678901234567890'));
assert.equal(totpCode(rfc, 1), '287082'); n++;
assert.equal(unbase32(rfc).toString(), '12345678901234567890'); n++;
assert.ok(totpMatch(rfc, totpCode(rfc, Math.floor(Date.now() / 30000))) > 0); n++;
assert.equal(totpMatch(rfc, '000000', 0), 0); n++;
assert.match(randomPassword(), /^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/); n++;

// ---------------------------------------------------------------- The API of a running server
const url = process.env.@@APP_ENV@@_TEST_DATABASE_URL;
const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, @@APP_ENV@@_DATABASE_URL: url, @@APP_ENV@@_PORT: String(port), @@APP_ENV@@_HOST: '127.0.0.1', @@APP_ENV@@_LOG_LEVEL: 'warn' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
const db = new pg.Client({ connectionString: url });
const call = async (method, path, body, cookie = '') => {
  const r = await fetch(new URL(path, base), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0], raw: r.headers.get('set-cookie') };
};
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'healthz')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)); }
  await db.connect();

  const st = (await call('GET', '/api/auth/state')).body;
  assert.equal(st.user, null); n++;
  if (st.setup) {
    assert.equal((await call('POST', '/api/auth/setup', { code: 'wrong', ...TEST_USER })).status, 403, 'setup needs the code'); n++;
  }
  assert.equal((await call('GET', '/api/auth/users')).status, 401, 'signed out: 401'); n++;
  const admin = await apiSession(base);
  assert.equal((await call('POST', '/api/auth/setup', { code: process.env.@@APP_ENV@@_SETUP_CODE, username: 'second', password: 'another long password 1' })).status, 409, 'only one setup'); n++;
  const me = (await admin('GET', '/api/auth/state')).body.user;
  assert.equal(me.username, TEST_USER.username); assert.equal(me.isAdmin, true); n++;

  // A new account: first password once, must be changed
  const add = await admin('POST', '/api/auth/users', { username: 'Jane.Doe', name: 'Jane Doe' });
  assert.equal(add.status, 201); assert.equal(add.body.username, 'jane.doe'); assert.ok(add.body.password); n++;
  assert.equal((await admin('POST', '/api/auth/users', { username: 'jane.doe' })).status, 409, 'user names are unique'); n++;
  let login = await call('POST', '/api/auth/login', { username: 'jane.doe', password: add.body.password });
  assert.equal(login.status, 200); assert.match(login.raw, /HttpOnly; SameSite=Lax/); n++;
  const jane = login.cookie;
  const js = (await call('GET', '/api/auth/state', null, jane)).body.user;
  assert.deepEqual(js.pending, ['password'], 'must choose an own password first'); n++;
  assert.equal((await call('GET', '/api/auth/sessions', null, jane)).status, 403, 'nothing else before that'); n++;
  assert.equal((await call('POST', '/api/auth/password', { current: add.body.password, password: 'password1234' }, jane)).body.error.code, 'weak_password'); n++;
  assert.equal((await call('POST', '/api/auth/password', { current: add.body.password, password: add.body.password }, jane)).body.error.code, 'password_reused'); n++;
  assert.equal((await call('POST', '/api/auth/password', { current: add.body.password, password: 'a much better passphrase 42' }, jane)).status, 200); n++;
  assert.deepEqual((await call('GET', '/api/auth/state', null, jane)).body.user.pending, []); n++;
  assert.equal((await call('GET', '/api/auth/users', null, jane)).status, 403, 'not an administrator'); n++;

  // Wrong passwords: the same answer as an unknown user, then the lockout
  const wrong = await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'nope nope nope' });
  const unknown = await call('POST', '/api/auth/login', { username: 'nobody.here', password: 'nope nope nope' });
  assert.equal(wrong.status, 401); assert.deepEqual(wrong.body, unknown.body, 'no hint whether an account exists'); n++;
  await admin('PUT', '/api/auth/policy', { lockoutAttempts: 3 });
  for (let i = 0; i < 3; i++) await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'still wrong ' + i });
  assert.equal((await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'a much better passphrase 42' })).status, 401, 'locked after 3 wrong passwords'); n++;
  const list = (await admin('GET', '/api/auth/users')).body;
  const j = list.find(u => u.username === 'jane.doe');
  assert.equal(j.locked, true); n++;
  await admin('PATCH', `/api/auth/users/${j.id}`, { unlock: true });
  login = await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'a much better passphrase 42' });
  assert.equal(login.status, 200, 'unlocked by an administrator'); n++;

  // Two-factor sign-in
  const j2 = login.cookie;
  const start = (await call('POST', '/api/auth/totp/start', null, j2)).body;
  assert.match(start.uri, /^otpauth:\/\/totp\//); n++;
  assert.equal((await call('POST', '/api/auth/totp/confirm', { code: '000000' }, j2)).status, 400); n++;
  const conf = await call('POST', '/api/auth/totp/confirm', { code: totp(start.secret) }, j2);
  assert.equal(conf.body.recoveryCodes.length, 10); n++;
@@IF lib:secrets@@
  const [stored] = (await db.query("select totp_secret from auth_users where username = 'jane.doe'")).rows;
  assert.notEqual(stored.totp_secret, start.secret, 'TOTP secrets are stored encrypted (element secrets)'); n++;
@@END@@
  assert.deepEqual((await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'a much better passphrase 42' })).body, { totp: true }, 'asks for the code'); n++;
  assert.equal((await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'a much better passphrase 42', code: totp(start.secret) })).status, 401, 'a used code does not work twice'); n++;
  const rec = await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'a much better passphrase 42', code: conf.body.recoveryCodes[0] });
  assert.equal(rec.status, 200, 'a recovery code works'); n++;
  assert.equal((await call('POST', '/api/auth/login', { username: 'jane.doe', password: 'a much better passphrase 42', code: conf.body.recoveryCodes[0] })).status, 401, 'once'); n++;

  // Sensitive actions need a fresh confirmation; sessions; reset by an administrator
  await db.query("update auth_sessions set verified_at = now() - interval '1 hour'");
  assert.equal((await call('POST', '/api/auth/recovery-codes', null, rec.cookie)).body.error.code, 'verify_needed'); n++;
  assert.equal((await call('GET', '/api/auth/sessions', null, rec.cookie)).body.filter(s => s.current).length, 1); n++;
  assert.equal((await call('POST', '/api/auth/logout-others', null, rec.cookie)).body.ended >= 1, true); n++;
  assert.equal((await call('GET', '/api/auth/state', null, j2)).body.user, null, 'the other session ended'); n++;
  const reset = await admin('POST', `/api/auth/users/${j.id}/reset-password`);
  assert.ok(reset.body.password); n++;
  assert.equal((await call('GET', '/api/auth/state', null, rec.cookie)).body.user, null, 'a reset signs the user out'); n++;

  // The last administrator stays; nobody deletes themselves
  assert.equal((await admin('PATCH', `/api/auth/users/${me.id}`, { isAdmin: false })).body.error.code, 'last_admin'); n++;
  assert.equal((await admin('DELETE', `/api/auth/users/${me.id}`)).body.error.code, 'self'); n++;
  assert.equal((await admin('DELETE', `/api/auth/users/${j.id}`)).status, 204); n++;
  // Changes from other sites are refused, and sign-out ends the session
  const evil = await fetch(new URL('/api/auth/logout', base), { method: 'POST', headers: { Origin: 'https://evil.example.com', Cookie: rec.cookie } });
  assert.equal(evil.status, 403); n++;
  await admin('PUT', '/api/auth/policy', { lockoutAttempts: 5 });
} finally {
  await db.query("delete from auth_attempts where ip in ('127.0.0.1', '::ffff:127.0.0.1')").catch(() => {});
  await db.end().catch(() => {});
  server.kill();
}
console.log(`lib-auth: ${n} checks passed`);
