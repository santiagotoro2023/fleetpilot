// FleetPilot: runs ansible-playbook. Every run gets a private folder (inventory, playbook, keys,
// known hosts) that is removed afterwards; events come back as JSON lines from the callback in
// server/ansible/fleetpilot.py. Secrets in the inventory are marked !unsafe, so Ansible never
// treats them as templates.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toYaml } from './yaml.mjs';
import { withTemp } from './ssh.mjs';

const CALLBACKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ansible');
const unsafe = v => (v === undefined || v === null ? v : { __unsafe: String(v) });

/** Is Ansible there? (the installer and the image install it: APP_PACKAGES) */
export async function ansibleVersion() {
  return new Promise(res => {
    const p = spawn('ansible-playbook', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => res(null));
    p.on('close', code => res(code === 0 ? (out.match(/core ([\d.]+)/) || [])[1] || 'unknown' : null));
  });
}

/** known_hosts lines: the stored keys of each host, and FleetPilot's host CA for every host */
export function knownHosts(hosts, hostCaPublic) {
  const lines = [];
  for (const h of hosts) {
    const name = h.port && h.port !== 22 ? `[${h.address}]:${h.port}` : h.address;
    for (const k of String(h.hostKeys || '').split('\n').map(s => s.trim()).filter(Boolean)) lines.push(`${name} ${k}`);
  }
  if (hostCaPublic) lines.push(`@cert-authority * ${hostCaPublic}`);
  return lines.join('\n') + '\n';
}

/**
 * Runs plays on hosts.
 *   hosts: [{ name, address, port, user, keyFile?: { privateKey, certificate }, become: 'sudo'|'su'|false, becomePassword?, vars: {…}, secretVars: {…}, hostKeys }]
 *   onEvent(event): every JSON event (play, task, result, stats, warning) and { event: 'line', line } for other output
 * Resolves { code, results: Map(host → { status, changed, failed, unreachable }) }.
 */
export async function runPlaybook({ plays, hosts, check = false, diff = true, signal, onEvent = () => {}, hostCaPublic = '', forks = 25, timeout = 30 }) {
  return withTemp(async dir => {
    fs.mkdirSync(path.join(dir, 'tmp'), { mode: 0o700 });
    const inv = { all: { hosts: {} } };
    for (const h of hosts) {
      const v = {
        ansible_host: h.address, ansible_port: h.port || 22, ansible_user: h.user,
        ansible_python_interpreter: 'auto_silent',
        ...(h.become ? { ansible_become_method: h.become } : { ansible_become: false }),
        ...h.vars
      };
      if (h.keyFile) {
        const kf = path.join(dir, `key-${h.name}`);
        fs.writeFileSync(kf, h.keyFile.privateKey.replace(/\n?$/, '\n'), { mode: 0o600 });
        if (h.keyFile.certificate) fs.writeFileSync(`${kf}-cert.pub`, h.keyFile.certificate + '\n', { mode: 0o600 });
        v.ansible_ssh_private_key_file = kf;
      }
      if (h.becomePassword) v.ansible_become_password = unsafe(h.becomePassword);
      for (const [k, val] of Object.entries(h.secretVars || {})) {
        v[k] = val && typeof val === 'object' ? Object.fromEntries(Object.entries(val).map(([a, b]) => [a, b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).map(([c, d]) => [c, unsafe(d)])) : unsafe(b)])) : unsafe(val);
      }
      inv.all.hosts[h.name] = v;
    }
    fs.writeFileSync(path.join(dir, 'inventory.yml'), toYaml(inv), { mode: 0o600 });
    // su (during a take-over) keeps the PATH of the login user: tools in /usr/sbin must be found
    const PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    fs.writeFileSync(path.join(dir, 'playbook.yml'), toYaml(plays.map(p => ({ ...p, environment: { PATH, ...(p.environment || {}) } }))), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'known_hosts'), knownHosts(hosts, hostCaPublic), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'ansible.cfg'), [
      '[defaults]',
      `stdout_callback = fleetpilot`,
      `callback_plugins = ${CALLBACKS}`,
      'host_key_checking = True',
      `forks = ${forks}`,
      `timeout = ${timeout}`,
      'retry_files_enabled = False',
      'interpreter_python = auto_silent',
      'deprecation_warnings = False',
      'system_warnings = False',
      `local_tmp = ${path.join(dir, 'tmp')}`,
      '',
      '[ssh_connection]',
      `ssh_args = -o ControlMaster=auto -o ControlPersist=60s -o UserKnownHostsFile=${path.join(dir, 'known_hosts')} -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o HashKnownHosts=no -o ServerAliveInterval=15`,
      `control_path_dir = ${path.join(dir, 'cp')}`,
      'pipelining = True',
      ''
    ].join('\n'), { mode: 0o600 });
    const args = ['-i', 'inventory.yml', 'playbook.yml', ...(check ? ['--check'] : []), ...(diff ? ['--diff'] : [])];
    const results = new Map();
    const code = await new Promise((resolve, reject) => {
      const p = spawn('ansible-playbook', args, {
        cwd: dir, signal,
        env: {
          PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
          ANSIBLE_CONFIG: path.join(dir, 'ansible.cfg'), ANSIBLE_HOME: path.join(dir, 'ansible'), ANSIBLE_LOCAL_TEMP: path.join(dir, 'tmp'),
          ANSIBLE_FORCE_COLOR: '0', ANSIBLE_NOCOLOR: '1', ANSIBLE_ACTION_WARNINGS: 'False', PYTHONUNBUFFERED: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let buf = '';
      const line = l => {
        if (!l.trim()) return;
        if (l.startsWith('FPJSON ')) {
          let e;
          try { e = JSON.parse(l.slice(7)); } catch { return; }
          if (e.event === 'stats') results.set(e.host, { status: e.unreachable ? 'unreachable' : e.failed ? 'failed' : e.changed ? 'changed' : 'ok', changed: e.changed, failed: e.failed, unreachable: e.unreachable });
          onEvent(e);
        } else onEvent({ event: 'line', line: l.slice(0, 2000) });
      };
      const feed = d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } };
      p.stdout.on('data', feed);
      p.stderr.on('data', feed);
      p.on('error', e => reject(e.name === 'AbortError' ? Object.assign(new Error('Cancelled.'), { cancelled: true }) : e.code === 'ENOENT' ? new Error('ansible-playbook is not installed on the FleetPilot server.') : e));
      p.on('close', c => { if (buf) line(buf); resolve(c); });
    });
    // Hosts without stats (the playbook stopped early) count as failed
    for (const h of hosts) if (!results.has(h.name)) results.set(h.name, { status: 'failed', changed: 0, failed: 1, unreachable: 0 });
    return { code, results };
  });
}
