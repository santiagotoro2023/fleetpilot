// FleetPilot end to end: a fresh Debian 12 in a container (test/e2e/debian12.Dockerfile) is
// taken over with the built-in workflow, checked for drift, and its root password rotated.
// It needs Docker and ansible-core and takes a few minutes, so it runs only with FLEETPILOT_E2E=1
// (otherwise it says it was skipped).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { apiSession } from '../lib/auth.mjs';
import { sha512crypt } from '../../server/lib/crypt.mjs';

const why = process.env.FLEETPILOT_E2E !== '1' ? 'set FLEETPILOT_E2E=1 to run it'
  : spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0 ? 'Docker is not running'
    : spawnSync('ansible-playbook', ['--version'], { stdio: 'ignore' }).status !== 0 ? 'ansible-core is not installed' : '';
if (why) { console.log(`takeover: skipped (${why})`); process.exit(0); }

let n = 0;
const docker = (...a) => { const r = spawnSync('docker', a, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`docker ${a[0]}: ${r.stderr}`); return r.stdout.trim(); };
docker('build', '-q', '-t', 'fleetpilot-e2e-debian12', '-f', 'test/e2e/debian12.Dockerfile', 'test/e2e');
const name = `fleetpilot-e2e-${process.pid}`;
docker('run', '-d', '--rm', '--name', name, '--hostname', 'e2e-01', '--privileged', '--cgroupns=host', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '--tmpfs', '/run/lock', 'fleetpilot-e2e-debian12');
const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, FLEETPILOT_DATABASE_URL: process.env.FLEETPILOT_TEST_DATABASE_URL, FLEETPILOT_PORT: String(port), FLEETPILOT_HOST: '127.0.0.1', FLEETPILOT_LOG_LEVEL: 'warn' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'healthz')).ok) break; } catch { /* not yet */ } await sleep(100); }
  const ip = docker('inspect', name, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
  for (let i = 0; i < 60; i++) { if (spawnSync('docker', ['exec', name, 'systemctl', 'is-active', 'ssh'], { encoding: 'utf8' }).stdout.trim() === 'active') break; await sleep(500); }
  const req = await apiSession(base);
  const call = async (m, p, b) => { const r = await req(m, p, b); assert.ok(r.status < 300, `${m} ${p}: ${JSON.stringify(r.body)}`); return r.body; };
  const runOf = async id => { for (let i = 0; i < 900; i++) { const r = await call('GET', `/api/runs/${id}`); if (['succeeded', 'partial', 'failed', 'cancelled'].includes(r.status)) return r; await sleep(1000); } throw new Error('the run did not finish'); };
  const why = async id => (await call('GET', `/api/runs/${id}/log?after=0`)).lines.map(l => `${l.host} ${l.level} ${l.line}`).join('\n');

  const login = await call('POST', '/api/vault', { kind: 'login', name: 'Debian install', username: 'admin', data: { password: 'install-pw', becomePassword: 'root-pw' } });
  const wfs = await call('GET', '/api/workflows');
  const take = wfs.find(w => w.builtin === 'takeover');
  take.definition.steps[0].values.credential = login.id;
  await call('PUT', `/api/workflows/${take.id}`, { definition: take.definition });
  const base1 = (await call('GET', '/api/templates')).find(t => t.name === 'Debian base');
  const site = await call('POST', '/api/groups', { name: 'Lab', kind: 'site' });
  await call('POST', `/api/templates/${base1.id}/assign`, { groupId: site.id });
  const added = await call('POST', '/api/hosts', { hosts: [{ name: 'e2e-01', address: ip }], groupId: site.id, workflowId: take.id });

  // The take-over
  const r1 = await runOf(added.run);
  assert.equal(r1.status, 'succeeded', await why(added.run)); n++;
  const host = await call('GET', `/api/hosts/${added.added[0]}`);
  assert.equal(host.state, 'managed'); n++;
  assert.equal(host.connection.user, 'fleetpilot'); n++;
  assert.equal(host.os, 'Debian'); n++;
  assert.match(docker('exec', name, 'cat', '/etc/ssh/sshd_config.d/10-fleetpilot.conf'), /PasswordAuthentication no/); n++;
  assert.ok(!docker('exec', name, 'cat', '/root/.ssh/authorized_keys').includes('fleetpilot-bootstrap'), 'the key of the first login is gone'); n++;
  assert.match(docker('exec', name, 'ls', '/etc/ssh'), /ssh_host_ed25519_key-cert\.pub/); n++;

  // The vault has the new root password, and it is the one on the host
  const secrets = await call('GET', `/api/vault?host=${host.id}`);
  const rootPw = secrets.find(s => s.kind === 'password' && s.username === 'root');
  const pw = (await call('POST', `/api/vault/${rootPw.id}/reveal`, {})).password;
  const shadow = docker('exec', name, 'getent', 'shadow', 'root').split(':')[1];
  assert.equal(sha512crypt(pw, shadow.split('$')[2]), shadow, 'the root password in the vault is the one on the host'); n++;

  // No drift right after the take-over
  const check = wfs.find(w => w.builtin === 'check');
  const r2 = await runOf((await call('POST', `/api/workflows/${check.id}/run`, { hostIds: [host.id] })).id);
  assert.equal(r2.status, 'succeeded', await why(r2.id)); n++;
  assert.equal((await call('GET', `/api/hosts/${host.id}`)).drift.changed, 0, 'no drift'); n++;

  // A change by hand is drift; applying the desired state removes it
  docker('exec', name, 'sh', '-c', 'echo "PermitRootLogin yes" > /etc/ssh/sshd_config.d/10-fleetpilot.conf');
  await runOf((await call('POST', `/api/workflows/${check.id}/run`, { hostIds: [host.id] })).id);
  assert.ok((await call('GET', `/api/hosts/${host.id}`)).drift.changed >= 1, 'a change by hand shows as drift'); n++;
  const apply = wfs.find(w => w.builtin === 'apply');
  assert.equal((await runOf((await call('POST', `/api/workflows/${apply.id}/run`, { hostIds: [host.id] })).id)).status, 'succeeded'); n++;
  assert.match(docker('exec', name, 'cat', '/etc/ssh/sshd_config.d/10-fleetpilot.conf'), /PermitRootLogin prohibit-password/); n++;

  // Rotating: a new version in the vault, and the host has it
  const rotate = wfs.find(w => w.builtin === 'rotate');
  assert.equal((await runOf((await call('POST', `/api/workflows/${rotate.id}/run`, { hostIds: [host.id] })).id)).status, 'succeeded'); n++;
  const pw2 = (await call('POST', `/api/vault/${rootPw.id}/reveal`, {})).password;
  assert.notEqual(pw2, pw); n++;
  const shadow2 = docker('exec', name, 'getent', 'shadow', 'root').split(':')[1];
  assert.equal(sha512crypt(pw2, shadow2.split('$')[2]), shadow2); n++;
} finally {
  server.kill();
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
console.log(`takeover: ${n} checks passed`);
