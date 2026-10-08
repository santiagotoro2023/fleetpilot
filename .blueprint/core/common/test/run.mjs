// Runs the tests of @@APP_NAME@@ the same way as in every blueprint project (blueprint @@BLUEPRINT_VERSION@@).
//
//   node test/run.mjs                 unit tests: test/unit/*.test.mjs
//   node test/run.mjs --browser       browser tests: test/browser/*.test.mjs against a local server
//   node test/run.mjs --browser ui    only the files whose name starts with "ui"
//
// Every test file is a plain script: it exits with 0 when everything passed and prints
// one line at the end that says what it checked ("engine: 37 tests passed").
@@IF server@@
// The server tests need PostgreSQL: @@APP_ENV@@_TEST_DATABASE_URL, or Docker (a temporary
// postgres:17-alpine container is started and removed again). The test database is
// emptied before the tests.
@@END@@
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const browser = argv.includes('--browser');
const only = argv.filter(a => !a.startsWith('--'));
const dir = path.join(ROOT, 'test', browser ? 'browser' : 'unit');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs') && (!only.length || only.some(o => f.startsWith(o)))).sort();
if (!files.length) { console.error(`No tests in ${path.relative(ROOT, dir)}${only.length ? ` matching ${only.join(', ')}` : ''}`); process.exit(1); }

const env = { ...process.env, OUT: process.env.OUT || path.join(ROOT, 'test', '.output') };
fs.mkdirSync(env.OUT, { recursive: true });
const stops = [];
const stopAll = () => { for (const s of stops.reverse()) { try { s(); } catch { /* ignore */ } } };
process.on('exit', stopAll);
process.on('SIGINT', () => process.exit(130));

@@IF server@@
// ---------------------------------------------------------------- Test database
async function testDatabase() {
  let url = process.env.@@APP_ENV@@_TEST_DATABASE_URL;
  if (!url) {
    if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
      console.error('The tests need PostgreSQL: set @@APP_ENV@@_TEST_DATABASE_URL=postgres://user:pass@host:5432/db (it is emptied!) or start Docker.');
      process.exit(1);
    }
    const name = `@@APP_ID@@-test-${process.pid}`;
    const r = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_USER=test', '-e', 'POSTGRES_DB=test', '-p', '127.0.0.1::5432', 'postgres:17-alpine'], { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
    stops.push(() => spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }));
    const port = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split('\n')[0].split(':').pop();
    url = `postgres://test:test@127.0.0.1:${port}/test`;
    for (let i = 0; i < 60; i++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'test', '-d', 'test', '-h', '127.0.0.1'], { stdio: 'ignore' }).status === 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  // Empty the test database: every run starts from nothing
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema if exists public cascade; create schema public');
  await c.end();
  return url;
}
const dbUrl = await testDatabase();
env.@@APP_ENV@@_TEST_DATABASE_URL = dbUrl;
@@END@@
@@IF lib:secrets@@
// A fresh key for the stored secrets of every test run
env.@@APP_ENV@@_SECRET_KEY = (await import('node:crypto')).randomBytes(32).toString('base64');
@@END@@
@@IF lib:auth@@
// The setup code of the first administrator (test/lib/browser.mjs signs in with it)
env.@@APP_ENV@@_SETUP_CODE = 'test-setup-code';
@@END@@

if (browser) {
@@IF static@@
  // The web app from src/, served with the same headers as nginx in production
  const srv = await serve({ root: path.join(ROOT, 'src'), version: fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() });
  stops.push(() => srv.close());
  env.BASE = `http://127.0.0.1:${srv.port}/`;
@@END@@
@@IF server@@
  // The app server itself, with the web app from src/ and the test database
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'main.mjs')], {
    env: { ...env, @@APP_ENV@@_DATABASE_URL: dbUrl, @@APP_ENV@@_PORT: String(port), @@APP_ENV@@_HOST: '127.0.0.1', @@APP_ENV@@_WEB_DIR: path.join(ROOT, 'src'), @@APP_ENV@@_VERSION: 'test', @@APP_ENV@@_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  stops.push(() => child.kill());
  env.BASE = `http://127.0.0.1:${port}/`;
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(env.BASE + 'healthz')).ok; } catch { await new Promise(r => setTimeout(r, 100)); } }
  if (!up) { console.error('The app server did not start (see above).'); process.exit(1); }
@@END@@
}

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const name = f.replace(/\.test\.mjs$/, '');
  const out = await new Promise(res => {
    let text = '';
    const p = spawn(process.execPath, [path.join(dir, f)], { env, cwd: ROOT });
    p.stdout.on('data', d => { text += d; });
    p.stderr.on('data', d => { text += d; });
    p.on('close', code => res({ code, text }));
  });
  const last = out.text.trim().split('\n').filter(Boolean).pop() || '';
  if (out.code === 0) console.log(`\x1b[32m ✓ \x1b[0m ${name}: ${last.replace(new RegExp(`^${name}: `), '')}`);
  else { failed++; console.log(`\x1b[31m ✗ \x1b[0m ${name} failed:\n${out.text.trim().replace(/^/gm, '    ')}`); }
}
console.log(`${files.length - failed} of ${files.length} ${browser ? 'browser' : 'unit'} test files passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
stopAll();
process.exit(failed ? 1 : 0);
