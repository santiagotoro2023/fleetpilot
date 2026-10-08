// FleetPilot: the catalog of settings and steps, the playbooks made from them, and the helpers
// below them (YAML, password hashes, IP math, rights). Without a database. When ansible-core is
// installed, every generated playbook is also checked by ansible-playbook --syntax-check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { safeText, normalizeValues, AREAS } from '../../server/lib/catalog.mjs';
import { TYPES, catalogForClient, normalizeDefinition, mergeDefinitions, playOf, previewPlaybook, stateHash, needsOf, portsOf } from '../../server/lib/compile.mjs';
import { toYaml } from '../../server/lib/yaml.mjs';
import { sha512crypt, derivedSalt } from '../../server/lib/crypt.mjs';
import { STEPS, stepsForClient } from '../../server/lib/steps.mjs';
import { parseIp, formatIp, parseCidr, contains, usable } from '../../server/lib/ipam.mjs';
import { normalizePermissions, BUILTIN_ROLES, AREAS as RIGHTS } from '../../server/lib/access.mjs';
import { sampleValues } from './samples.mjs';

let n = 0;
const ok = (v, msg) => { assert.ok(v, msg); n++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++; };

// ---------------------------------------------------------------- The catalog
const areaIds = AREAS.map(a => a.id);
ok(TYPES.size >= 80, `at least 80 settings (${TYPES.size})`);
for (const t of TYPES.values()) {
  ok(areaIds.includes(t.area), `${t.id}: a known area`);
  ok(t.title && t.text && !/[!]/.test(t.title + t.text), `${t.id}: title and text, calm words`);
  assert.ok(!(t.single && t.collect), `${t.id}: single or collecting, not both`);
  // Defaults alone must be valid (a freshly added setting), and so must a filled-in form
  const def = normalizeValues(t, {}, { partial: true });
  ok(def && typeof def === 'object', `${t.id}: defaults`);
  const full = normalizeValues(t, sampleValues(t));
  const play = playOf(new Map([[t.id, full]]), { name: t.title });
  ok(Array.isArray(play.tasks) && play.tasks.length > 0, `${t.id}: becomes tasks`);
  for (const task of play.tasks) {
    const mods = Object.keys(task).filter(k => k.includes('.'));
    ok(mods.length === 1 && mods[0].startsWith('ansible.builtin.'), `${t.id}: ${task.name} uses one module of ansible.builtin (${mods})`);
    ok(typeof task.name === 'string' && task.name.length > 0, `${t.id}: every task has a name`);
  }
}
ok(catalogForClient().types.every(t => t.fields.every(f => typeof f.validate !== 'function')), 'the client gets data, not functions');

// ---------------------------------------------------------------- Texts: only FleetPilot's variables
eq(safeText('Hello {{ fp_name }}'), 'Hello {{ fp_name }}');
assert.throws(() => safeText('{{ lookup("pipe", "id") }}'), /fp_/); n++;
assert.throws(() => safeText('{% for x in y %}'), /./); n++;
assert.throws(() => normalizeValues(TYPES.get('motd'), { motd: '{{ ansible_env }}' }), /./); n++;

// ---------------------------------------------------------------- Definitions and merging
const d = normalizeDefinition({ settings: [{ type: 'timezone', values: { zone: 'Europe/Zurich' } }, { type: 'packages', values: { packages: [{ name: 'htop', state: 'present' }] } }] });
eq(d.settings.length, 2);
ok(d.settings.every(s => /^[a-z0-9-]{4,40}$/.test(s.id)), 'every setting gets an id');
assert.throws(() => normalizeDefinition({ settings: [{ type: 'timezone' }, { type: 'timezone' }] }), /only once/); n++;
assert.throws(() => normalizeDefinition({ settings: [{ type: 'nope' }] }), /There is no setting/); n++;
const site = normalizeDefinition({ settings: [{ type: 'timezone', values: { zone: 'Etc/UTC' } }, { type: 'packages', values: { packages: [{ name: 'htop', state: 'present' }, { name: 'vim', state: 'present' }] } }] });
const host = normalizeDefinition({ settings: [{ type: 'timezone', values: { zone: 'Europe/Zurich' } }, { type: 'packages', values: { packages: [{ name: 'vim', state: 'absent' }, { name: 'curl', state: 'present' }] } }] });
const merged = mergeDefinitions([site, host]);
eq(merged.get('timezone').zone, 'Europe/Zurich', 'the more specific single value wins');
eq(merged.get('packages').packages.map(p => `${p.name}:${p.state}`).sort(), ['curl:present', 'htop:present', 'vim:absent'], 'rows are merged by key, the later row wins');
const off = normalizeDefinition({ settings: [{ type: 'timezone', values: { zone: 'Asia/Tokyo' }, off: true }] });
eq(mergeDefinitions([host, off]).get('timezone').zone, 'Europe/Zurich', 'a setting that is off is left out');
eq(stateHash(mergeDefinitions([site, host])), stateHash(mergeDefinitions([site, host])), 'the hash is stable');
ok(stateHash(mergeDefinitions([site])) !== stateHash(mergeDefinitions([site, host])), 'the hash follows the state');
ok(Array.isArray(needsOf(merged)) && Array.isArray(portsOf(merged).ports) && portsOf(merged).sshPort === 22, 'needs and ports');
const yaml = previewPlaybook(host, 'Test');
ok(yaml.startsWith('# Test: generated by FleetPilot'), 'the playbook says where it comes from');
ok(yaml.includes('ansible.builtin.'), 'and uses ansible.builtin modules');

// ---------------------------------------------------------------- YAML
eq(toYaml({ a: 'x: y', b: ['1', 2], c: { d: true } }).trim().split('\n').length >= 4, true);
ok(toYaml({ s: { __unsafe: '{{ not }}' } }).includes('!unsafe'), 'raw file contents are marked !unsafe');
ok(toYaml({ s: 'yes' }).includes('"yes"'), 'strings that YAML would read as booleans are quoted');

// ---------------------------------------------------------------- Password hashes (glibc SHA-512 crypt)
eq(sha512crypt('Hello world!', 'saltstring'), '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
eq(derivedSalt('host-1:root'), derivedSalt('host-1:root'), 'the same seed, the same salt: an unchanged password changes nothing');
ok(/^[./0-9A-Za-z]{16}$/.test(derivedSalt('x')), 'a crypt salt');

// ---------------------------------------------------------------- IP math
eq(formatIp(4, parseIp('10.20.0.11').n), '10.20.0.11');
eq(formatIp(6, parseIp('2001:db8::1').n), '2001:db8::1');
eq(formatIp(6, parseIp('2001:db8:0:0:1:0:0:1').n), '2001:db8::1:0:0:1');
eq(parseCidr('10.20.0.77/24').cidr, '10.20.0.0/24');
eq(parseCidr('10.20.0.0/33'), null);
const c = parseCidr('10.20.0.0/24');
ok(contains(c, parseIp('10.20.0.200')) && !contains(c, parseIp('10.20.1.1')), 'contains');
eq(usable(c).map(x => formatIp(4, x)), ['10.20.0.1', '10.20.0.254']);
eq(usable(parseCidr('10.0.0.0/31')).map(x => formatIp(4, x)), ['10.0.0.0', '10.0.0.1'], 'a /31 has two usable addresses');
eq(parseIp('not an ip'), null);

// ---------------------------------------------------------------- Steps and rights
const kinds = new Set(STEPS.flatMap(s => s.kinds));
eq([...kinds].sort(), ['maintain', 'takeover']);
for (const s of STEPS) {
  ok(areaIds.includes(s.area) && s.title && s.text, `${s.id}: area, title, text`);
  const v = normalizeValues(s, {}, { partial: true });
  ok(typeof s.describe(v) === 'string', `${s.id}: says what it does`);
  ok(typeof s.run === 'function', `${s.id}: can run`);
}
ok(stepsForClient().every(s => !('run' in s)), 'the client gets no code');
eq(normalizePermissions({ hosts: 'manage', runs: 'everything' }).runs, 'none', 'unknown levels become none');
ok(BUILTIN_ROLES.every(r => Object.keys(RIGHTS).every(a => RIGHTS[a].levels.includes(normalizePermissions(r.permissions)[a]))), 'built-in roles use known levels');

// ---------------------------------------------------------------- ansible-playbook --syntax-check
const ap = spawnSync('ansible-playbook', ['--version'], { encoding: 'utf8' });
if (ap.status === 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-syntax-'));
  // Every setting in one play (with sample values), plus every setting alone with its defaults
  const all = new Map([...TYPES.values()].map(t => [t.id, normalizeValues(t, sampleValues(t))]));
  const plays = [playOf(all, { name: 'Everything' }), ...[...TYPES.values()].map(t => playOf(new Map([[t.id, normalizeValues(t, {}, { partial: true })]]), { name: t.title }))];
  fs.writeFileSync(path.join(dir, 'all.yml'), toYaml(plays));
  const r = spawnSync('ansible-playbook', ['--syntax-check', '-i', 'localhost,', path.join(dir, 'all.yml')], { encoding: 'utf8', env: { ...process.env, ANSIBLE_NOCOLOR: '1' } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `syntax check:\n${r.stdout}\n${r.stderr}`); n++;
  console.log(`(ansible ${ap.stdout.split('\n')[0].match(/[\d.]+/)?.[0]}: ${plays.length} plays pass the syntax check)`);
}

console.log(`catalog: ${n} checks passed`);
