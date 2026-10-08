// Library element "audit" (blueprint @@BLUEPRINT_VERSION@@): recording, hiding secrets, the API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { clean, record } from '../../server/lib/audit.mjs';
import { connect, migrate, query, close } from '../../server/core/db.mjs';
import { apiSession } from '../lib/auth.mjs';

let n = 0;
assert.deepEqual(clean({ password: 'x', nested: { apiToken: 'y', ok: 1 }, list: ['a'] }), { password: '(hidden)', nested: { apiToken: '(hidden)', ok: 1 }, list: ['a'] }); n++;
assert.equal(clean({ s: 'z'.repeat(900) }).s.length, 500); n++;

const url = process.env.@@APP_ENV@@_TEST_DATABASE_URL;
await connect({ url, waitSeconds: 10 });
await migrate();
await record({ user: { id: '1', username: 'tester' }, clientIp: '192.0.2.7' }, 'test.thing_done', { target: { type: 'thing', id: 42, name: 'The thing' }, secret: 'never' });
const [row] = await query("select * from audit_events where action = 'test.thing_done' order by id desc limit 1");
assert.equal(row.actor, 'tester'); assert.equal(row.target_name, 'The thing'); assert.equal(row.ip, '192.0.2.7'); n++;
assert.equal(row.details.secret, '(hidden)', 'secrets never reach the log'); n++;
await close();

const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, @@APP_ENV@@_DATABASE_URL: url, @@APP_ENV@@_PORT: String(port), @@APP_ENV@@_HOST: '127.0.0.1', @@APP_ENV@@_LOG_LEVEL: 'warn' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'healthz')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)); }
  assert.equal((await fetch(base + 'api/audit')).status, 401, 'signed out: nothing'); n++;
  const admin = await apiSession(base);
  const all = (await admin('GET', '/api/audit?limit=500')).body;
  assert.ok(all.some(e => e.action === 'test.thing_done')); n++;
  assert.ok(all.some(e => e.action.startsWith('auth.')), 'sign-ins are recorded'); n++;
  const found = (await admin('GET', '/api/audit?q=The%20thing')).body;
  assert.ok(found.length >= 1 && found.every(e => JSON.stringify(e).includes('The thing'))); n++;
  const page = (await admin('GET', `/api/audit?before=${all[0].id}&limit=1`)).body;
  assert.equal(page.length, 1); assert.ok(BigInt(page[0].id) < BigInt(all[0].id)); n++;
} finally { server.kill(); }
console.log(`lib-audit: ${n} checks passed`);
