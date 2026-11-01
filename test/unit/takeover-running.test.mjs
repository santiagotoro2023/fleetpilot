// FleetPilot end to end: "Take over a running server" on four Debian 12 containers that already
// run something. It must make FleetPilot the manager and change nothing else on a normal server and
// on one with its own account fleetpilot (like the FleetPilot server itself), and change nothing at
// all where someone else made an account svc-fleetpilot or where SSH trusts another certificate authority. Needs Docker and ansible-core,
// runs only with FLEETPILOT_E2E=1 (otherwise it says it was skipped).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { apiSession } from '../lib/auth.mjs';

const why = process.env.FLEETPILOT_E2E !== '1' ? 'set FLEETPILOT_E2E=1 to run it'
  : spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0 ? 'Docker is not running'
    : spawnSync('ansible-playbook', ['--version'], { stdio: 'ignore' }).status !== 0 ? 'ansible-core is not installed' : '';
if (why) { console.log(`takeover-running: skipped (${why})`); process.exit(0); }

let n = 0;
const docker = (...a) => { const r = spawnSync('docker', a, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`docker ${a.slice(0, 3).join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const sh = (c, cmd) => docker('exec', c, 'sh', '-c', cmd);
docker('build', '-q', '-t', 'fleetpilot-e2e-debian12', '-f', 'test/e2e/debian12.Dockerfile', 'test/e2e');
const names = { plain: `fp-adopt-plain-${process.pid}`, account: `fp-adopt-account-${process.pid}`, svc: `fp-adopt-svc-${process.pid}`, ca: `fp-adopt-ca-${process.pid}`, legacy: `fp-adopt-legacy-${process.pid}` };
const hostnames = { plain: 'running-01', account: 'running-02', svc: 'running-03', ca: 'running-04', legacy: 'running-05' };
for (const k of Object.keys(names)) docker('run', '-d', '--rm', '--name', names[k], '--hostname', hostnames[k], '--privileged', '--cgroupns=host', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw', '--tmpfs', '/run', '--tmpfs', '/run/lock', 'fleetpilot-e2e-debian12');
const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, FLEETPILOT_DATABASE_URL: process.env.FLEETPILOT_TEST_DATABASE_URL, FLEETPILOT_PORT: String(port), FLEETPILOT_HOST: '127.0.0.1', FLEETPILOT_LOG_LEVEL: 'warn' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'healthz')).ok) break; } catch { /* not yet */ } await sleep(100); }
  for (const c of Object.values(names)) for (let i = 0; i < 60; i++) { if (spawnSync('docker', ['exec', c, 'systemctl', 'is-active', 'ssh'], { encoding: 'utf8' }).stdout.trim() === 'active') break; await sleep(500); }

  // What the servers already have: an own account fleetpilot with its own password and key (the
  // FleetPilot server itself) and another admin password, someone else's svc-fleetpilot, a corporate CA
  sh(names.account, "useradd -m -s /bin/bash fleetpilot && echo 'fleetpilot:my-own-pw' | chpasswd && mkdir -p ~fleetpilot/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwnKeyOfTheOwner owner@laptop' > ~fleetpilot/.ssh/authorized_keys && echo 'admin:other-pw' | chpasswd");
  sh(names.svc, "useradd -m -s /bin/bash -c 'Not FleetPilot' svc-fleetpilot");
  sh(names.ca, "ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/corp_ca && echo 'TrustedUserCAKeys /etc/ssh/corp_ca.pub' > /etc/ssh/sshd_config.d/00-corp.conf && systemctl reload ssh");
  const before = {};
  const look = c => sh(c, "hostname; getent shadow root admin fleetpilot svc-fleetpilot; cat ~fleetpilot/.ssh/authorized_keys ~svc-fleetpilot/.ssh/authorized_keys 2>/dev/null; sshd -T | grep -E '^(passwordauthentication|permitrootlogin|trustedusercakeys|authorizedprincipalsfile) '; ls /etc/ssh/sshd_config.d; ls /etc/sudoers.d 2>/dev/null | grep -v README; cat /etc/timezone; command -v nft || echo no-firewall");
  for (const k of Object.keys(names)) before[k] = look(names[k]);

  const req = await apiSession(base);
  const call = async (m, p, b) => { const r = await req(m, p, b); assert.ok(r.status < 300, `${m} ${p}: ${JSON.stringify(r.body)}`); return r.body; };
  const runOf = async id => { for (let i = 0; i < 900; i++) { const r = await call('GET', `/api/runs/${id}`); if (['succeeded', 'partial', 'failed', 'cancelled'].includes(r.status)) return r; await sleep(1000); } throw new Error('the run did not finish'); };

  const ip = c => docker('inspect', c, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
  // A host FleetPilot 1.1 took over: its account fleetpilot, sudo, certificate login, SSH setting naming it
  const fp = await call('GET', '/api/vault/fleetpilot');
  sh(names.legacy, `umask 022 && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 sudo >/dev/null && useradd -m -s /bin/bash -c FleetPilot fleetpilot && passwd -l fleetpilot >/dev/null && \
    mkdir -p ~fleetpilot/.ssh && echo '${fp.fleetKey}' > ~fleetpilot/.ssh/authorized_keys && chown -R fleetpilot: ~fleetpilot/.ssh && \
    echo 'fleetpilot ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/fleetpilot && chmod 440 /etc/sudoers.d/fleetpilot && \
    echo '${fp.userCa}' > /etc/ssh/fleetpilot_user_ca.pub && mkdir -p /etc/ssh/auth_principals && echo fleetpilot > /etc/ssh/auth_principals/fleetpilot && \
    printf 'TrustedUserCAKeys /etc/ssh/fleetpilot_user_ca.pub\\nAuthorizedPrincipalsFile /etc/ssh/auth_principals/%%u\\n' > /etc/ssh/sshd_config.d/09-fleetpilot.conf && \
    printf 'AllowUsers admin fleetpilot\\n' > /etc/ssh/sshd_config.d/10-fleetpilot.conf && systemctl reload ssh`);
  const legacyKeys = sh(names.legacy, 'cat /etc/ssh/ssh_host_*_key.pub').split('\n').map(l => l.split(' ').slice(0, 2).join(' ')).join('\n');
  const legacyId = (await call('POST', '/api/hosts', { hosts: [{ name: 'running-05', address: ip(names.legacy) }] })).added[0];
  const db = new pg.Client({ connectionString: process.env.FLEETPILOT_TEST_DATABASE_URL });
  await db.connect();
  await db.query(`update hosts set state = 'managed', connection = '{"user":"fleetpilot","method":"certificate"}', host_keys = $2 where id = $1`, [legacyId, legacyKeys]);
  await db.end();
  const legacyBefore = sh(names.legacy, 'getent shadow root admin; cat /etc/timezone; hostname');

  const login = await call('POST', '/api/vault', { kind: 'login', name: 'Running servers', username: 'admin', data: { password: 'install-pw', becomePassword: 'root-pw' } });
  const wfs = await call('GET', '/api/workflows');
  const adopt = wfs.find(w => w.builtin === 'adopt');
  assert.equal(adopt.name, 'Take over a running server'); n++;
  assert.deepEqual(adopt.steps.map(s => s.type), ['connect', 'enroll', 'facts', 'check']); n++;
  adopt.definition.steps[0].values.credential = login.id;
  await call('PUT', `/api/workflows/${adopt.id}`, { definition: adopt.definition });
  // Hosts named as in Proxmox, not as they call themselves; one has a login of its own
  const added = await call('POST', '/api/hosts', { hosts: [{ name: 'vm-plain', address: ip(names.plain) }, { name: 'vm-account', address: ip(names.account) }, { name: 'vm-svc', address: ip(names.svc) }, { name: 'vm-ca', address: ip(names.ca) }] });
  const [plainId, accountId, svcId, caId] = added.added;
  await call('POST', '/api/vault', { scope: 'host', hostId: accountId, kind: 'login', name: 'Login', username: 'admin', data: { password: 'other-pw', becomePassword: 'root-pw' } });
  // A template that would change things, so the check has something to show
  const tpl = await call('POST', '/api/templates', { name: 'Zurich time', definition: { settings: [{ type: 'timezone', values: { zone: 'Europe/Zurich' } }] } });
  await call('POST', `/api/templates/${tpl.id}/assign`, { hostId: plainId });

  const run = await runOf((await call('POST', `/api/workflows/${adopt.id}/run`, { hostIds: [...added.added, legacyId] })).id);
  const log = (await call('GET', `/api/runs/${run.id}/log?after=0`)).lines.map(l => `${l.host} ${l.level} ${l.line}`).join('\n');
  const hosts = Object.fromEntries((await call('GET', '/api/hosts')).map(h => [h.id, h]));

  // The normal server and the one with its own account fleetpilot: managed, with their own names in
  // FleetPilot, and nothing they had changed (the account fleetpilot keeps its password and its key)
  const lines = t => t.split('\n').filter(Boolean);
  for (const [id, k] of [[plainId, 'plain'], [accountId, 'account']]) {
    assert.equal(hosts[id].state, 'managed', log); n++;
    assert.equal(hosts[id].name, hostnames[k], 'the host keeps its own name, FleetPilot takes it over'); n++;
    const after = look(names[k]);
    const changed = lines(after).filter(l => !lines(before[k]).includes(l));
    const gone = lines(before[k]).filter(l => !lines(after).includes(l) && !/^(trustedusercakeys|authorizedprincipalsfile) none$/.test(l));
    assert.deepEqual(gone, [], `${k}: nothing the server had is gone or different: ${gone.join(' | ')}`); n++;
    assert.ok(changed.every(l => /^(svc-fleetpilot:|ssh-ed25519 \S+ fleetpilot|0[89]-fleetpilot|svc-fleetpilot$|trustedusercakeys \/etc\/ssh\/fleetpilot_user_ca\.pub|authorizedprincipalsfile \/etc\/ssh\/auth_principals\/%u)/.test(l)), `${k}: only FleetPilot's own access was added: ${changed.join(' | ')}`); n++;
    assert.match(after, new RegExp(`^${hostnames[k]}$`, 'm'), `${k}: the host name did not change`); n++;
    assert.match(after, /^passwordauthentication yes$/m, `${k}: password logins still work`); n++;
    assert.ok(!sh(names[k], 'cat /home/admin/.ssh/authorized_keys 2>/dev/null || true').includes('fleetpilot-bootstrap'), `${k}: the key of the first login is gone`); n++;
  }
  assert.equal((await call('GET', `/api/hosts/${accountId}`)).connection.user, 'svc-fleetpilot'); n++;
  const drift = (await call('GET', `/api/hosts/${plainId}`)).drift;
  assert.ok(drift && drift.changed >= 1, 'the check shows what the template would change'); n++;
  assert.doesNotMatch(sh(names.plain, 'cat /etc/timezone'), /Zurich/, 'and changes nothing'); n++;

  // Someone else's svc-fleetpilot, and a corporate CA: refused, unchanged
  for (const [id, k, re] of [[svcId, 'svc', /account svc-fleetpilot exists here already/], [caId, 'ca', /trusts another certificate authority/]]) {
    assert.notEqual(hosts[id].state, 'managed'); n++;
    assert.match(log, re); n++;
    assert.equal(look(names[k]), before[k], `${k}: nothing changed`); n++;
    assert.ok(!sh(names[k], 'cat /home/admin/.ssh/authorized_keys 2>/dev/null || true').includes('fleetpilot-bootstrap'), `${k}: the key of the first login was taken back`); n++;
  }
  // (vm-account was taken over with its own login only: its admin password differs from the others)

  // The host of FleetPilot 1.1: logged in with the certificate as before, moved to svc-fleetpilot,
  // the old account and its rights gone, FleetPilot's SSH setting names the new account, nothing else changed
  assert.match(log, /running-05\s+ok\s+FleetPilot manages this host already: it logs in as fleetpilot/); n++;
  assert.equal(hosts[legacyId].state, 'managed', log); n++;
  assert.equal((await call('GET', `/api/hosts/${legacyId}`)).connection.user, 'svc-fleetpilot'); n++;
  assert.equal(sh(names.legacy, 'getent passwd fleetpilot || true'), '', 'the old account is gone'); n++;
  assert.equal(sh(names.legacy, 'ls /etc/sudoers.d /etc/ssh/auth_principals | grep -v README | sort | tr "\\n" " "'), '/etc/ssh/auth_principals: /etc/sudoers.d: svc-fleetpilot svc-fleetpilot', 'only the rights of svc-fleetpilot are left'); n++;
  assert.equal(sh(names.legacy, 'cat /etc/ssh/sshd_config.d/10-fleetpilot.conf'), 'AllowUsers admin svc-fleetpilot'); n++;
  assert.equal(sh(names.legacy, 'getent shadow root admin; cat /etc/timezone; hostname'), legacyBefore, 'passwords, time zone and name as they were'); n++;
  // And once more: a take-over of a host that has svc-fleetpilot already changes nothing
  const again = await runOf((await call('POST', `/api/workflows/${adopt.id}/run`, { hostIds: [legacyId] })).id);
  assert.equal(again.status, 'succeeded', (await call('GET', `/api/runs/${again.id}/log?after=0`)).lines.map(l => `${l.host} ${l.level} ${l.line}`).join('\n')); n++;
  assert.equal((await call('GET', `/api/hosts/${legacyId}`)).connection.user, 'svc-fleetpilot'); n++;
  assert.equal(run.status, 'partial'); n++;
} finally {
  server.kill();
  for (const c of Object.values(names)) spawnSync('docker', ['rm', '-f', c], { stdio: 'ignore' });
}
console.log(`takeover-running: ${n} checks passed`);
