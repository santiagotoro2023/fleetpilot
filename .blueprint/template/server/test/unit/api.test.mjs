// The API of @@APP_NAME@@ against a real PostgreSQL (the test database of test/run.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
@@IF lib:auth@@
import { apiSession } from '../lib/auth.mjs';
@@END@@

const url = process.env.@@APP_ENV@@_TEST_DATABASE_URL;
if (!url) { console.error('@@APP_ENV@@_TEST_DATABASE_URL is not set: run the tests with node test/run.mjs'); process.exit(1); }
const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, @@APP_ENV@@_DATABASE_URL: url, @@APP_ENV@@_PORT: String(port), @@APP_ENV@@_HOST: '127.0.0.1', @@APP_ENV@@_LOG_LEVEL: 'warn' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}`;
@@IF lib:auth@@
let cookie = '';   // signed in below (library element auth)
@@END@@
const req = async (method, path, body, headers = {}) => {
@@IF lib:auth@@
  headers = { ...headers, Cookie: cookie };
@@END@@
  const r = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null), headers: r.headers };
};
let n = 0;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)); }
@@IF lib:auth@@
  assert.equal((await req('GET', '/api/items')).status, 401, 'signed out: nothing'); n++;
  cookie = `@@APP_ID@@_session=${(await apiSession(base + '/')).cookie()}`;
@@END@@

  const created = await req('POST', '/api/items', { title: 'First' });
  assert.equal(created.status, 201); assert.equal(created.body.title, 'First'); n++;
  const list = await req('GET', '/api/items');
  assert.ok(list.body.some(i => i.id === created.body.id)); n++;
  assert.equal((await req('POST', '/api/items', { title: '' })).body.error.code, 'title_missing', 'errors are { error: { code, message } }'); n++;
  assert.equal((await req('DELETE', `/api/items/${created.body.id}`)).status, 204); n++;
  assert.equal((await req('DELETE', `/api/items/${created.body.id}`)).status, 404); n++;
  assert.equal((await req('POST', '/api/items', { title: 'x' }, { Origin: 'https://evil.example.com' })).status, 403, 'no changes from other sites'); n++;
  const form = await fetch(base + '/api/items', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(form.status, 415, 'no plain form posts'); n++;
  assert.equal(list.headers.get('content-security-policy')?.startsWith("default-src 'self'"), true, 'security headers on the API'); n++;
  assert.equal((await req('GET', '/api/nothing')).status, 404); n++;
} finally { server.kill(); }
console.log(`api: ${n} checks passed`);
