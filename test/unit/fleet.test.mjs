// FleetPilot: the API of a running app server against the test database of test/run.mjs.
// Groups, hosts, IP management, the vault, templates, workflows, runs with approvals, roles.
// Runs go to 127.0.0.1 port 1, where nothing answers: they fail fast and show how failures look.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { apiSession } from '../lib/auth.mjs';

let n = 0;
const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, ['server/main.mjs'], { env: { ...process.env, FLEETPILOT_DATABASE_URL: process.env.FLEETPILOT_TEST_DATABASE_URL, FLEETPILOT_PORT: String(port), FLEETPILOT_HOST: '127.0.0.1', FLEETPILOT_LOG_LEVEL: 'warn' }, stdio: 'inherit' });
const base = `http://127.0.0.1:${port}/`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + 'healthz')).ok) break; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 100)); }
const req = await apiSession(base);
const call = async (method, path, body, status) => {
  const r = await req(method, path, body);
  if (status !== undefined) { assert.equal(r.status, status, `${method} ${path}: ${JSON.stringify(r.body)}`); n++; }
  return r.body;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function finished(id) {
  for (let i = 0; i < 300; i++) {
    const r = await call('GET', `/api/runs/${id}`);
    if (['succeeded', 'partial', 'failed', 'cancelled', 'rejected'].includes(r.status)) return r;
    await sleep(200);
  }
  throw new Error(`run ${id} did not finish`);
}

try {
  // ------------------------------------------------------------ Meta and settings
  const meta = await call('GET', '/api/meta', null, 200);
  assert.ok(meta.catalog.types.length >= 80 && meta.steps.length >= 15 && meta.access.admin); n++;
  assert.equal((await call('PUT', '/api/settings', { 'network.live_check': false }, 200))['network.live_check'], false); n++;
  await call('PUT', '/api/settings', { 'runs.keep_days': 1 }, 400);

  // ------------------------------------------------------------ Groups
  const site = await call('POST', '/api/groups', { name: 'Zurich', kind: 'site' }, 201);
  const web = await call('POST', '/api/groups', { name: 'Web', parentId: site.id }, 201);
  await call('PATCH', `/api/groups/${web.id}`, { description: 'Web servers' }, 200);
  const tree = await call('GET', '/api/groups', null, 200);
  assert.equal(tree.find(g => g.id === web.id).parent_id, site.id); n++;
  await call('PATCH', `/api/groups/${site.id}`, { parentId: web.id }, 400);

  // ------------------------------------------------------------ IP management (before the hosts: their addresses are recorded)
  const vlan = await call('POST', '/api/network/vlans', { vid: 20, name: 'Servers', siteId: site.id }, 201);
  await call('POST', '/api/network/vlans', { vid: 20, siteId: site.id }, 409);
  await call('POST', '/api/network/vlans', { vid: 5000 }, 400);
  const sub = await call('POST', '/api/network/subnets', { cidr: '10.20.0.0/24', name: 'Servers', gateway: '10.20.0.1', vlanId: vlan.id, siteId: site.id, dns: '10.20.0.53', search: 'example.com' }, 201);
  await call('POST', '/api/network/subnets', { cidr: '10.20.0.128/25' }, 409);
  await call('POST', '/api/network/subnets', { cidr: '10.30.0.0/24', gateway: '10.31.0.1' }, 400);
  const pool = await call('POST', `/api/network/subnets/${sub.id}/pools`, { name: 'Web', first: '10.20.0.10', last: '10.20.0.20' }, 201);
  await call('POST', `/api/network/subnets/${sub.id}/pools`, { first: '10.20.0.15', last: '10.20.0.30' }, 409);
  await call('POST', `/api/network/subnets/${sub.id}/pools`, { first: '10.21.0.1', last: '10.21.0.2' }, 400);

  // ------------------------------------------------------------ Hosts
  const added = await call('POST', '/api/hosts', { hosts: [{ name: 'web-01', address: '10.20.0.11' }, { name: 'web-02', address: '10.20.0.12' }, { name: 'bad name', address: '10.20.0.13' }, { name: 'dead', address: '127.0.0.1', port: 1 }], groupId: web.id, tags: 'debian, web' }, 201);
  assert.equal(added.added.length, 3); n++;
  assert.match(added.skipped[0].why, /letters, digits/); n++;
  const again = await call('POST', '/api/hosts', { hosts: [{ name: 'web-01', address: '10.20.0.99' }] }, 201);
  assert.equal(again.skipped[0].why, 'A host with this name exists already.'); n++;
  const [web1, web2, dead] = added.added;
  assert.equal((await call('GET', '/api/hosts?q=web-0', null, 200)).length, 2); n++;
  assert.equal((await call('GET', `/api/hosts?group=${site.id}`, null, 200)).length, 3, 'a site lists the hosts of its groups'); n++;
  await call('POST', '/api/hosts/bulk', { ids: [web1, web2], action: 'tag', tags: 'prod' }, 200);
  assert.deepEqual((await call('GET', `/api/hosts/${web1}`, null, 200)).tags.sort(), ['debian', 'prod', 'web']); n++;
  await call('POST', '/api/hosts/bulk', { ids: [web1], action: 'tag', tags: 'not a tag' }, 400);
  assert.equal((await call('POST', `/api/hosts/${dead}/ping`, null, 200)).reachable, false); n++;
  await call('PATCH', `/api/groups/${web.id}`, { name: 'Web servers' }, 200);
  await call('DELETE', `/api/groups/${web.id}`, null, 409);

  // Addresses: the hosts' addresses are taken; the next free one skips them
  const check = await call('POST', '/api/network/check', { ip: '10.20.0.11' }, 200);
  assert.equal(check.free, false); n++;
  assert.equal(check.known.host, 'web-01'); n++;
  assert.equal((await call('POST', '/api/network/check', { ip: '10.20.0.40' }, 200)).free, true); n++;
  assert.equal((await call('POST', '/api/network/next', { poolId: pool.id }, 200)).ip, '10.20.0.10'); n++;
  assert.equal((await call('POST', '/api/network/next', { poolId: pool.id, reserve: true, hostname: 'printer' }, 200)).ip, '10.20.0.10'); n++;
  assert.equal((await call('POST', '/api/network/next', { poolId: pool.id }, 200)).ip, '10.20.0.13', 'reserved and assigned addresses are skipped'); n++;
  const a = await call('POST', `/api/network/subnets/${sub.id}/addresses`, { ip: '10.20.0.200', state: 'reserved', note: 'Switch' }, 201);
  await call('POST', `/api/network/subnets/${sub.id}/addresses`, { ip: '10.20.0.200' }, 409);
  await call('POST', `/api/network/subnets/${sub.id}/addresses`, { ip: '10.99.0.1' }, 400);
  await call('PATCH', `/api/network/addresses/${a.id}`, { mac: '52:54:00:00:00:01' }, 204);
  const detail = await call('GET', `/api/network/subnets/${sub.id}`, null, 200);
  assert.deepEqual(detail.addresses.map(x => x.ip), ['10.20.0.10', '10.20.0.11', '10.20.0.12', '10.20.0.200']); n++;
  await call('DELETE', `/api/network/addresses/${a.id}`, null, 204);
  await call('DELETE', `/api/network/subnets/${sub.id}`, null, 409);
  assert.equal((await call('GET', '/api/network', null, 200)).subnets[0].assigned, 2); n++;

  // ------------------------------------------------------------ The vault
  const login = await call('POST', '/api/vault', { kind: 'login', name: 'Install', username: 'admin', data: { password: 'install-pw', becomePassword: 'root-pw' } }, 201);
  assert.equal(login.data, undefined, 'values never come back in lists'); n++;
  assert.ok(!JSON.stringify(await call('GET', '/api/vault', null, 200)).includes('install-pw')); n++;
  assert.equal((await call('POST', `/api/vault/${login.id}/reveal`, {}, 200)).password, 'install-pw'); n++;
  const v2 = await call('PUT', `/api/vault/${login.id}`, { generate: { length: 20 } }, 200);
  assert.equal(v2.version, 2); n++;
  const now = await call('POST', `/api/vault/${login.id}/reveal`, {}, 200);
  assert.equal(now.password.length, 20); n++;
  assert.equal(now.becomePassword, 'root-pw', 'other values stay'); n++;
  assert.equal((await call('POST', `/api/vault/${login.id}/reveal`, { version: 1 }, 200)).password, 'install-pw', 'old versions stay readable'); n++;
  await call('POST', '/api/vault', { kind: 'ssh_key', name: 'Bad', data: { privateKey: 'nope' } }, 400);
  const keys = await call('GET', '/api/vault/fleetpilot', null, 200);
  const system = (await call('GET', '/api/vault?scope=system', null, 200));
  assert.ok(system.length >= 3, 'FleetPilot made its key and certificate authorities on first use'); n++;
  await call('PUT', `/api/vault/${system[0].id}`, { data: {} }, 403);
  assert.match(keys.userCa, /^ssh-ed25519 /); n++;
  const own = await call('POST', '/api/vault/certificate', { publicKey: keys.fleetKey, hours: 2 }, 200);
  assert.match(own.certificate, /^ssh-ed25519-cert-v01@openssh.com /); n++;
  assert.equal(own.principal, 'fp-admin'); n++;

  // ------------------------------------------------------------ Templates
  const starters = await call('GET', '/api/templates', null, 200);
  assert.deepEqual(starters.map(t => t.name).sort(), ['Debian base', 'Web server']); n++;
  const def = { settings: [{ type: 'timezone', values: { zone: 'Europe/Zurich' } }, { type: 'packages', values: { packages: [{ name: 'htop', state: 'present' }] } }] };
  const tpl = await call('POST', '/api/templates', { name: 'Zurich base', description: 'Time and tools', definition: def }, 201);
  await call('POST', '/api/templates', { name: 'Zurich base', definition: def }, 409);
  await call('POST', '/api/templates', { name: 'Broken', definition: { settings: [{ type: 'motd', values: { motd: '{{ lookup("pipe", "id") }}' } }] } }, 400);
  await call('POST', '/api/templates', { name: 'Unknown secret', definition: { settings: [{ type: 'mounts', values: { mounts: [{ path: '/srv/share', type: 'cifs', source: '//nas/share', credential: '999999' }] } }] } }, 400);
  const pre = await call('POST', '/api/templates/preview', { definition: def, name: 'Zurich base' }, 200);
  assert.match(pre.playbook, /Europe\/Zurich/); n++;
  def.settings[0].values.zone = 'Europe/Berlin';
  assert.equal((await call('POST', `/api/templates/${tpl.id}/versions`, { definition: def, note: 'Berlin' }, 200)).version, 2); n++;
  const v1 = await call('GET', `/api/templates/${tpl.id}?version=1`, null, 200);
  assert.match(v1.playbook, /Zurich/, 'old versions keep their playbook'); n++;
  assert.equal(v1.versions.length, 2); n++;
  await call('POST', `/api/templates/${tpl.id}/assign`, { groupId: site.id }, 204);
  await call('POST', `/api/templates/${tpl.id}/assign`, { hostId: web1, pinnedVersion: 1 }, 204);
  const usage = await call('GET', `/api/templates/${tpl.id}/usage`, null, 200);
  assert.equal(usage.assignments.length, 2); n++;
  assert.equal(usage.hosts.length, 3, 'every host of the site uses it'); n++;
  const state = await call('GET', `/api/hosts/${web1}/state`, null, 200);
  assert.ok(state.settings.some(s => s.type === 'timezone' && /Zurich/.test(s.summary)), 'the pinned version wins on the host'); n++;
  assert.match(state.playbook, /hosts: web-01/); n++;
  await call('POST', `/api/templates/${tpl.id}/push`, { all: true }, 400);
  await call('DELETE', `/api/templates/${tpl.id}`, null, 409);
  const copy = await call('POST', `/api/templates/${tpl.id}/duplicate`, {}, 201);
  assert.equal(copy.name, 'Zurich base (copy)'); n++;
  await call('DELETE', `/api/templates/${copy.id}`, null, 204);

  // ------------------------------------------------------------ Workflows
  const wfs = await call('GET', '/api/workflows', null, 200);
  assert.deepEqual(wfs.map(w => w.builtin).filter(Boolean).sort(), ['apply', 'check', 'push', 'reboot', 'rotate', 'takeover', 'update']); n++;
  assert.ok(wfs.every(w => w.steps.every(s => s.sentence)), 'every step says what it does'); n++;
  await call('DELETE', `/api/workflows/${wfs.find(w => w.builtin === 'apply').id}`, null, 409);
  await call('POST', '/api/workflows', { name: 'Wrong', kind: 'maintain', definition: { steps: [{ type: 'connect' }] } }, 400);
  await call('POST', '/api/workflows', { name: 'Bad schedule', kind: 'maintain', definition: { trigger: { type: 'schedule', cron: 'often' }, steps: [{ type: 'check' }] } }, 400);
  const take = await call('POST', '/api/workflows', { name: 'Take over the lab', kind: 'takeover', definition: { steps: [{ type: 'connect', values: { become: 'su' } }, { type: 'enroll' }] } }, 201);
  await call('POST', `/api/workflows/${take.id}/run`, { hostIds: [dead] }, 400);
  take.definition.steps[0].values.credential = login.id;
  take.definition.targets = { groups: [web.id], tags: [] };
  const saved = await call('PUT', `/api/workflows/${take.id}`, { definition: take.definition }, 200);
  assert.equal(saved.version, 2); n++;
  assert.equal((await call('POST', `/api/workflows/${take.id}/targets`, {}, 200)).length, 3); n++;
  const nightly = await call('POST', '/api/workflows', { name: 'Nightly check', kind: 'maintain', definition: { trigger: { type: 'schedule', cron: '15 1 * * *' }, steps: [{ type: 'check' }] } }, 201);
  assert.ok((await call('GET', `/api/workflows/${nightly.id}`, null, 200)).nextAt, 'a schedule gets its next start'); n++;

  // ------------------------------------------------------------ Runs: a take-over that cannot connect
  const run = await call('POST', `/api/workflows/${take.id}/run`, { hostIds: [dead] }, 201);
  const r1 = await finished(run.id);
  assert.equal(r1.status, 'failed'); n++;
  assert.equal(r1.hosts[0].status, 'unreachable'); n++;
  assert.ok(r1.results.some(x => x.step === 0 && x.status === 'unreachable'), 'the grid shows where it stopped'); n++;
  assert.ok(!r1.results.some(x => x.step === 1 && x.status !== 'pending'), 'the next step never ran'); n++;
  const log = await call('GET', `/api/runs/${run.id}/log?after=0`, null, 200);
  const ids = log.lines.map(l => Number(l.id));
  assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'log lines in their order'); n++;
  assert.ok(log.lines.some(l => /answer|refused/i.test(l.line)), 'the log says why'); n++;
  assert.equal((await call('GET', `/api/runs/${run.id}/log?after=${ids[ids.length - 1]}`, null, 200)).lines.length, 0); n++;
  assert.equal((await call('GET', `/api/hosts/${dead}`, null, 200)).state, 'failed', 'a failed take-over marks the host'); n++;
  const retry = await call('POST', `/api/runs/${run.id}/retry`, { failedOnly: true }, 201);
  assert.equal((await finished(retry.id)).status, 'failed'); n++;

  // Approvals: a workflow that always waits, rejected once and approved once
  const careful = await call('POST', '/api/workflows', { name: 'Careful', kind: 'takeover', definition: { approval: 'always', steps: [{ type: 'connect', values: { credential: login.id, become: 'su' } }] } }, 201);
  const w1 = await call('POST', `/api/workflows/${careful.id}/run`, { hostIds: [dead] }, 201);
  assert.equal((await call('GET', `/api/runs/${w1.id}`, null, 200)).status, 'awaiting_approval'); n++;
  assert.equal((await call('GET', '/api/overview', null, 200)).counts.approvals, 1); n++;
  await call('POST', `/api/runs/${w1.id}/reject`, { reason: 'Not today' }, 204);
  const rej = await call('GET', `/api/runs/${w1.id}`, null, 200);
  assert.equal(rej.status, 'rejected'); n++;
  assert.equal(rej.reason, 'Not today'); n++;
  const w2 = await call('POST', `/api/workflows/${careful.id}/run`, { hostIds: [dead] }, 201);
  await call('POST', `/api/runs/${w2.id}/approve`, {}, 204);
  const appr = await finished(w2.id);
  assert.equal(appr.approved_by, 'admin'); n++;
  assert.equal(appr.status, 'failed'); n++;
  await call('POST', `/api/runs/${w2.id}/approve`, {}, 409);
  assert.equal((await call('GET', `/api/runs?workflow=${careful.id}`, null, 200)).length, 2); n++;
  assert.equal((await call('GET', `/api/runs?host=${dead}&status=failed`, null, 200)).length, 3); n++;

  // ------------------------------------------------------------ Roles and accounts
  const roles = await call('GET', '/api/access/roles', null, 200);
  assert.deepEqual(roles.map(r => r.name).sort(), ['Engineer', 'Operator', 'Trainee', 'Viewer']); n++;
  const role = await call('POST', '/api/access/roles', { name: 'Zurich web', permissions: { hosts: 'change', runs: 'run', vault: 'everything', needsApproval: true }, scope: [web.id] }, 201);
  assert.equal(role.permissions.vault, 'none'); n++;
  assert.deepEqual(role.scope_group_ids, [web.id]); n++;
  const user = await call('POST', '/api/auth/users', { username: 'jdoe', name: 'Jane Doe' }, 201);
  await call('PUT', `/api/access/users/${user.id}/roles`, { roleIds: [role.id] }, 200);
  assert.deepEqual((await call('GET', '/api/access/users', null, 200)).find(u => u.username === 'jdoe').roles.map(r => r.name), ['Zurich web']); n++;
  await call('DELETE', `/api/access/roles/${role.id}`, null, 204);

  // ------------------------------------------------------------ Overview, audit, removing
  const ov = await call('GET', '/api/overview', null, 200);
  assert.equal(ov.counts.hosts, 3); n++;
  assert.ok(ov.attention.failedRuns.length >= 1 && ov.attention.notTakenOver.some(x => x.id === dead)); n++;
  const audit = await call('GET', '/api/audit?limit=500', null, 200);
  for (const action of ['host.added', 'secret.revealed', 'template.saved', 'run.rejected', 'role.created']) { assert.ok(audit.some(e => e.action === action), action); n++; }
  await call('DELETE', `/api/hosts/${web2}`, null, 204);
  assert.ok((await call('GET', '/api/vault', null, 200)).every(s => s.host_id !== web2)); n++;
  assert.equal((await call('POST', '/api/network/check', { ip: '10.20.0.12' }, 200)).free, true, 'a removed host frees its address'); n++;
} finally {
  server.kill();
}
console.log(`fleet: ${n} checks passed`);
