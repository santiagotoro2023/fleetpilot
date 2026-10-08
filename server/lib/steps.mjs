// FleetPilot: the steps a workflow is built from. Each step has a form (fields), a sentence that
// says what it does with these values, and run(ctx), which does it for the hosts of a batch.
// ctx (from runner.mjs): { run, index, values, hosts, state, by, log(host, level, line),
//   ansible({ plays, hosts, check, vars(host), connection }), done(host, status, message), signal, save() }
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { F, T, conf, safeText } from './catalog.mjs';
import { mergeDefinitions, playOf } from './compile.mjs';
import { derivedSalt, sha512crypt } from './crypt.mjs';
import { desiredState, groupPaths } from './hostctx.mjs';
import { nextFree, probe, subnetOf } from './ipam.mjs';
import { signKey, newKeyPair, sshWithPassword, withTemp } from './ssh.mjs';
import { fleetKey, generatePassword, hostCa, readSecret, updateSecret, userCa, hostSecret, createSecret } from './vault.mjs';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sshReload = { name: 'Reload the SSH server', listen: 'Reload the SSH server', 'ansible.builtin.shell': { cmd: 'sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd)' } };

/** Runs one play on every host of the step and reports each host's outcome */
async function playOnAll(ctx, play, { check = false, vars, onEvent } = {}) {
  const r = await ctx.ansible({ plays: [play], hosts: ctx.hosts, check, vars, onEvent });
  for (const h of ctx.hosts) {
    const res = r.get(h.name) || { status: 'failed' };
    ctx.done(h, res.status, res.status === 'changed' ? plural(res.changed, 'change', 'changes') : '');
  }
  return r;
}

export const STEPS = [
  // ---------------------------------------------------------------- Take-over
  {
    id: 'connect', kinds: ['takeover'], area: 'access', title: 'Connect with a login',
    text: 'Logs in with a user name and password from the vault, accepts the host key, and leaves a key for FleetPilot. Installs Python when it is missing.',
    fields: [
      F.secret('credential', 'Login', ['login'], { required: true, help: 'A login of the vault, for example the user and password of your standard installation.' }),
      F.select('become', 'Become root with', [['su', 'su and the root password of the login'], ['sudo', 'sudo and the password of the user'], ['none', 'Nothing: the login is root']])
    ],
    describe: v => `Logs in with a login from the vault and becomes root with ${v.become === 'none' ? 'nothing (root itself)' : v.become}.`,
    async run(ctx) {
      if (!ctx.values.credential) throw httpError(400, 'no_login', 'Choose the login to connect with.');
      const login = await readSecret(ctx.values.credential);
      if (!login) throw httpError(400, 'no_login', 'The login of this step is no longer in the vault.');
      const user = login.username || login.data.username;
      const password = login.data.password || '';
      const key = await fleetKey();
      const pub = key.public.publicKey.split(' ').slice(0, 2).join(' ');
      ctx.state.connections = ctx.state.connections || {};
      await Promise.all(ctx.hosts.map(async h => {
        await withTemp(async dir => {
          const known = path.join(dir, 'known_hosts');
          ctx.log(h.name, 'info', `Logging in as ${user} with a password`);
          const cmd = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qF '${pub}' ~/.ssh/authorized_keys || echo '${pub} fleetpilot-bootstrap' >> ~/.ssh/authorized_keys) && echo fleetpilot-ok`;
          let r;
          try { r = await sshWithPassword({ host: h.address, port: h.port, user, password, command: cmd, knownHosts: known, signal: ctx.signal }); }
          catch (e) { return ctx.done(h, 'unreachable', e.message); }
          if (!r.stdout.includes('fleetpilot-ok')) {
            const why = /Permission denied|Authentication failed/i.test(r.stderr) ? 'The login was refused: check the user name and password, and whether this user may log in over SSH.'
              : /Connection refused/i.test(r.stderr) ? 'No SSH server answers on this port.'
                : /timed out|No route|unreachable|Could not resolve/i.test(r.stderr) ? 'The host does not answer.' : (r.stderr.trim().split('\n').pop() || 'The login failed.');
            ctx.log(h.name, 'error', why);
            return ctx.done(h, /answer|refused$/i.test(why) ? 'unreachable' : 'failed', why);
          }
          const keys = fs.existsSync(known) ? fs.readFileSync(known, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ').slice(1, 3).join(' ')) : [];
          await query('update hosts set host_keys = $2, updated_at = now() where id = $1', [h.id, [...new Set(keys)].join('\n')]);
          h.host_keys = [...new Set(keys)].join('\n');
          ctx.log(h.name, 'ok', `Logged in. Host key accepted (${keys.length} kinds). FleetPilot's key was added for ${user}.`);
          ctx.state.connections[String(h.id)] = { user, become: user === 'root' || ctx.values.become === 'none' ? false : ctx.values.become, becomePassword: ctx.values.become === 'su' ? (login.data.becomePassword || login.data.rootPassword || password) : password };
        });
      }));
      await ctx.save();
      const ready = ctx.hosts.filter(h => ctx.state.connections[String(h.id)] && !ctx.finished(h));
      if (!ready.length) return;
      // Python for Ansible, with raw commands (works without Python)
      const r = await ctx.ansible({
        hosts: ready,
        plays: [{ name: 'Prepare the host for Ansible', hosts: 'all', gather_facts: false, become: true, environment: false, tasks: [
          { name: 'Install Python when it is missing', 'ansible.builtin.raw': 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; command -v python3 >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 >/dev/null) && echo ready', changed_when: false },
          { name: 'Check that Ansible works', 'ansible.builtin.ping': {} }
        ] }]
      });
      for (const h of ready) { const res = r.get(h.name); ctx.done(h, res?.status === 'ok' || res?.status === 'changed' ? 'ok' : res?.status || 'failed', res?.status === 'failed' ? 'Becoming root failed, or Python could not be installed.' : ''); }
    }
  },
  {
    id: 'enroll', kinds: ['takeover'], area: 'access', title: 'Make FleetPilot the manager',
    text: 'Creates the user fleetpilot with sudo, trusts FleetPilot\'s certificates, and from then on logs in only that way.',
    fields: [
      F.bool('hostCert', 'Give the host a certificate (no more host key questions for anyone)', true),
      F.bool('removeBootstrap', 'Remove the key left by the first login', true)
    ],
    describe: v => `Creates the user fleetpilot, trusts FleetPilot's certificates${v.hostCert ? ', signs the host key' : ''}, and checks the new login.`,
    async run(ctx) {
      const [key, uca] = await Promise.all([fleetKey(), userCa()]);
      const tasks = [
        { name: 'Create the user fleetpilot', 'ansible.builtin.user': { name: 'fleetpilot', comment: 'FleetPilot', shell: '/bin/bash', create_home: true, password_lock: true } },
        T.file('Make the SSH folder of fleetpilot', { path: '~fleetpilot/.ssh', state: 'directory', owner: 'fleetpilot', group: 'fleetpilot', mode: '0700' }),
        T.copy('Let FleetPilot\'s key log in', '~fleetpilot/.ssh/authorized_keys', key.public.publicKey + '\n', { owner: 'fleetpilot', group: 'fleetpilot', mode: '0600' }),
        T.apt(['sudo']),
        T.copy('Give fleetpilot sudo', '/etc/sudoers.d/fleetpilot', conf(['fleetpilot ALL=(ALL:ALL) NOPASSWD: ALL']), { mode: '0440', validate: 'visudo -cf %s' }),
        T.copy('Trust FleetPilot\'s user certificates', '/etc/ssh/fleetpilot_user_ca.pub', uca.public.publicKey + '\n'),
        T.file('Make the folder for principals', { path: '/etc/ssh/auth_principals', state: 'directory', mode: '0755' }),
        T.copy('Let FleetPilot\'s certificates log in as fleetpilot', '/etc/ssh/auth_principals/fleetpilot', 'fleetpilot\n'),
        T.copy('Configure certificate logins', '/etc/ssh/sshd_config.d/09-fleetpilot.conf', conf(['TrustedUserCAKeys /etc/ssh/fleetpilot_user_ca.pub', 'AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u']), { notify: 'Reload the SSH server' }),
        ...(ctx.values.hostCert ? [{ name: 'Read the host key', 'ansible.builtin.slurp': { src: '/etc/ssh/ssh_host_ed25519_key.pub' } }] : [])
      ];
      const hostKeys = new Map();
      await playOnAll(ctx, { name: 'Make FleetPilot the manager', hosts: 'all', become: true, gather_facts: false, tasks, handlers: [sshReload] }, {
        onEvent: e => { if (e.event === 'result' && e.content) hostKeys.set(e.host, Buffer.from(e.content, 'base64').toString('utf8').trim()); }
      });
      let ok = ctx.hosts.filter(h => !ctx.failed(h));
      if (ctx.values.hostCert && ok.length) {
        const hca = await hostCa();
        const certs = new Map();
        for (const h of ok) {
          const pub = hostKeys.get(h.name);
          if (!pub) continue;
          certs.set(h.name, await signKey({ caPrivateKey: hca.data.privateKey, publicKey: pub, identity: `host-${h.name}`, principals: [...new Set([h.name, h.address, ...(h.vars?.fp_fqdn ? [h.vars.fp_fqdn] : [])])], validity: '+520w', host: true }));
        }
        await ctx.ansible({
          hosts: ok.filter(h => certs.has(h.name)), vars: h => ({ fp_host_cert: certs.get(h.name) }),
          plays: [{ name: 'Give the host its certificate', hosts: 'all', become: true, gather_facts: false, tasks: [
            T.copy('Write the host certificate', '/etc/ssh/ssh_host_ed25519_key-cert.pub', '{{ fp_host_cert }}\n', { notify: 'Reload the SSH server' }),
            T.copy('Offer the host certificate', '/etc/ssh/sshd_config.d/08-fleetpilot-hostcert.conf', conf(['HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub']), { notify: 'Reload the SSH server' })
          ], handlers: [sshReload] }]
        });
      }
      // From now on as fleetpilot with a certificate: that is the check
      const boot = { ...ctx.state.connections };
      for (const h of ok) delete ctx.state.connections?.[String(h.id)];
      ok = ok.filter(h => !ctx.failed(h));
      const r = await ctx.ansible({
        hosts: ok,
        plays: [{ name: 'Log in as fleetpilot', hosts: 'all', become: true, gather_facts: true, tasks: [
          { name: 'Check the new login', 'ansible.builtin.ping': {} },
          ...(ctx.values.removeBootstrap ? [{ name: 'Remove the key of the first login', 'ansible.builtin.lineinfile': { path: '~{{ fp_boot_user }}/.ssh/authorized_keys', regexp: 'fleetpilot-bootstrap$', state: 'absent' }, when: "fp_boot_user != 'fleetpilot'" }] : [])
        ] }],
        vars: h => ({ fp_boot_user: boot[String(h.id)]?.user || 'fleetpilot' })
      });
      for (const h of ok) {
        const res = r.get(h.name);
        if (res && (res.status === 'ok' || res.status === 'changed')) {
          await query("update hosts set connection = $2, state = 'managed', updated_at = now() where id = $1", [h.id, JSON.stringify({ user: 'fleetpilot', method: 'certificate', since: new Date().toISOString() })]);
          ctx.log(h.name, 'ok', 'FleetPilot manages this host now: it logs in as fleetpilot with a certificate.');
          ctx.done(h, 'changed', 'Managed by FleetPilot');
        } else {
          ctx.state.connections[String(h.id)] = boot[String(h.id)];
          ctx.done(h, 'failed', 'The login as fleetpilot did not work.');
        }
      }
      await ctx.save();
    }
  },

  // ---------------------------------------------------------------- Identity and addresses
  {
    id: 'facts', kinds: ['takeover', 'maintain'], area: 'system', title: 'Collect facts',
    text: 'Reads the operating system, kernel, CPUs, memory and interfaces of the host into FleetPilot.',
    fields: [],
    describe: () => 'Reads the system, hardware and interfaces into FleetPilot.',
    run: ctx => playOnAll(ctx, { name: 'Collect facts', hosts: 'all', become: true, gather_facts: true, tasks: [{ name: 'Facts collected', 'ansible.builtin.debug': { msg: '{{ ansible_facts.distribution }} {{ ansible_facts.distribution_version }}' } }] })
  },
  {
    id: 'hostname', kinds: ['takeover', 'maintain'], area: 'system', title: 'Set the host name',
    text: 'Sets the host name on the host. With a pattern, FleetPilot first gives the host a new name like web-01, web-02.',
    fields: [
      F.text('pattern', 'Name pattern', { pattern: 'any', placeholder: 'web-{n}  ({n}: the next free number, {site}, {group})', help: 'Empty: keep the name the host has in FleetPilot.' }),
      F.num('digits', 'Digits of {n}', 2, [1, 6]),
      F.text('domain', 'Domain', { pattern: 'host', placeholder: 'Empty: the domain of the subnet' })
    ],
    describe: v => v.pattern ? `Renames the host to ${v.pattern.replace('{n}', '0'.repeat(v.digits - 1) + '1')} (the next free number) and sets that name.` : 'Sets the host name from FleetPilot on the host.',
    async run(ctx) {
      if (ctx.values.pattern) {
        const paths = await groupPaths();
        for (const h of ctx.hosts) {
          const chain = h.group_id ? paths.path(h.group_id) : [];
          const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const base = ctx.values.pattern.replace('{site}', slug(chain[0]?.name)).replace('{group}', slug(chain.at(-1)?.name));
          if (!base.includes('{n}')) { await rename(ctx, h, base); continue; }
          for (let n = 1; n < 10 ** ctx.values.digits; n++) {
            const name = base.replace('{n}', String(n).padStart(ctx.values.digits, '0'));
            if (name === h.name) break;
            if (await rename(ctx, h, name, true)) break;
          }
        }
      }
      const fqdn = ctx.values.domain ? `{{ fp_name }}.${ctx.values.domain}` : '{{ fp_fqdn }}';
      await playOnAll(ctx, { name: 'Set the host name', hosts: 'all', become: true, gather_facts: false, tasks: [
        { name: 'Set the host name', 'ansible.builtin.hostname': { name: '{{ fp_name }}' } },
        T.line('Name the host in /etc/hosts', { path: '/etc/hosts', unsafe_writes: true, regexp: '^127\\.0\\.1\\.1\\s', line: `127.0.1.1 ${fqdn} {{ fp_name }}` })
      ] });
    }
  },
  {
    id: 'ipam', kinds: ['takeover', 'maintain'], area: 'network', title: 'Give the host an address',
    text: 'Takes the next free address of a pool (checked on the network first), writes the network settings, and waits for the host at its new address.',
    fields: [
      F.text('pool', 'Pool', { pattern: 'word', required: true, source: 'pools' }),
      F.bool('dns', 'Set the DNS servers and search domains of the subnet too', true),
      F.num('wait', 'Wait for the host at the new address (seconds)', 120, [20, 900])
    ],
    describe: () => 'Takes the next free address of the pool, configures it, and waits for the host there.',
    async run(ctx) {
      const plans = new Map();
      for (const h of ctx.hosts) {
        try {
          const a = await nextFree({ poolId: ctx.values.pool, claim: { hostId: h.id, hostname: h.name, note: `Run ${ctx.run.id}` } });
          const subnet = await subnetOf(a.ip);
          plans.set(h.name, { ...a, subnet });
          ctx.log(h.name, 'info', `Address ${a.ip}/${a.prefix} from the pool (nothing answered there).`);
        } catch (e) { ctx.done(h, 'failed', e.message); }
      }
      const hosts = ctx.hosts.filter(h => plans.has(h.name));
      if (!hosts.length) return;
      const merged = mergeDefinitions([{ settings: [
        { type: 'interface', values: { method: 'ipam', address: '', gateway: '', name: '', mtu: 0, ipv6: 'auto' } },
        ...(ctx.values.dns ? [{ type: 'dns', values: { servers: [], search: [] } }] : [])
      ] }]);
      const play = playOf(merged, { name: 'Configure the new address' });
      const r = await ctx.ansible({
        hosts, plays: [play],
        vars: h => { const p = plans.get(h.name); return { fp_ip: `${p.ip}/${p.prefix}`, fp_gateway: p.subnet?.gateway ? String(p.subnet.gateway) : '', fp_dns: (p.subnet?.dns || []).map(String), fp_search: p.subnet?.search_domains || [] }; }
      });
      await Promise.all(hosts.map(async h => {
        const res = r.get(h.name), p = plans.get(h.name);
        if (!res || res.status === 'failed' || res.status === 'unreachable') {
          await query("delete from addresses where host(ip) = $1 and host_id = $2 and note = $3", [p.ip, h.id, `Run ${ctx.run.id}`]);
          return ctx.done(h, res?.status || 'failed', 'The new address could not be configured. The address went back to the pool.');
        }
        if (p.ip === h.address) return ctx.done(h, 'ok', `Already at ${p.ip}`);
        ctx.log(h.name, 'info', `Waiting for ${h.name} at ${p.ip}…`);
        const t0 = Date.now();
        let up = false;
        while (!up && Date.now() - t0 < ctx.values.wait * 1000 && !ctx.signal.aborted) {
          await new Promise(res2 => setTimeout(res2, 4000));
          up = await probe(p.ip);
        }
        if (!up) return ctx.done(h, 'failed', `${h.name} does not answer at ${p.ip}. It may still have its old address (${h.address}); check its console.`);
        const old = h.address;
        await query('update hosts set address = $2, updated_at = now() where id = $1', [h.id, p.ip]);
        await query("delete from addresses where host(ip) = $1 and host_id = $2", [old, h.id]);
        h.address = p.ip;
        ctx.log(h.name, 'changed', `${h.name} answers at ${p.ip}. FleetPilot uses that address from now on.`);
        ctx.done(h, 'changed', `${old} → ${p.ip}`);
      }));
    }
  },

  // ---------------------------------------------------------------- Desired state
  {
    id: 'apply', kinds: ['takeover', 'maintain'], area: 'system', title: 'Apply the desired state',
    text: 'Applies the templates of the host\'s site, groups and the host itself.',
    fields: [],
    describe: () => 'Applies the desired state from the templates of the site, the groups and the host.',
    run: ctx => applyState(ctx, { check: false })
  },
  {
    id: 'templates', kinds: ['takeover', 'maintain'], area: 'system', title: 'Apply templates',
    text: 'Applies only the templates you choose, in this order, whatever else the host has.',
    fields: [F.lines('templates', 'Templates', { pattern: 'word', required: true, source: 'templates' })],
    describe: v => `Applies ${plural(v.templates.length, 'chosen template', 'chosen templates')}.`,
    run: ctx => applyState(ctx, { check: false, only: ctx.values.templates })
  },
  {
    id: 'check', kinds: ['maintain'], area: 'system', title: 'Check for drift',
    text: 'Compares each host with its desired state without changing anything, and shows what differs.',
    fields: [],
    describe: () => 'Compares the hosts with their desired state, without changing anything.',
    run: ctx => applyState(ctx, { check: true })
  },

  // ---------------------------------------------------------------- Accounts and keys
  {
    id: 'passwords', kinds: ['takeover', 'maintain'], area: 'access', title: 'Set new passwords',
    text: 'Makes a new random password for each user on each host, sets it, and keeps it in the vault (the old one stays in the history).',
    fields: [
      F.lines('users', 'Users', { pattern: 'user', default: ['root'], required: true, help: 'One per line, for example root and the user of the installation.' }),
      F.num('length', 'Length', 24, [12, 128]), F.bool('symbols', 'With symbols', true)
    ],
    describe: v => `Sets new ${v.length}-character passwords for ${v.users.join(', ')} and keeps them in the vault.`,
    async run(ctx) {
      const plans = new Map();
      for (const h of ctx.hosts) {
        const list = [];
        for (const user of ctx.values.users) {
          const pw = generatePassword(ctx.values.length, ctx.values.symbols);
          let s = await hostSecret(h.id, 'password', user);
          const prev = s ? s.data : null;
          s = s ? await updateSecret(s.id, { data: { username: user, password: pw }, username: user, by: `Run ${ctx.run.id}`, rotated: true })
            : await createSecret({ scope: 'host', hostId: h.id, kind: 'password', name: user, username: user, data: { username: user, password: pw }, by: `Run ${ctx.run.id}` });
          list.push({ user, hash: sha512crypt(pw, derivedSalt(`${s.id}:${s.version}`)), secretId: s.id, prev });
        }
        plans.set(h.name, list);
      }
      const r = await ctx.ansible({
        hosts: ctx.hosts, secretVars: h => ({ fp_new_passwords: Object.fromEntries(plans.get(h.name).map(p => [p.user, p.hash])) }),
        plays: [{ name: 'Set new passwords', hosts: 'all', become: true, gather_facts: false, tasks: ctx.values.users.map(u => ({
          name: `Set the new password of ${u}`, 'ansible.builtin.user': { name: u, password: `{{ fp_new_passwords['${u}'] }}`, update_password: 'always' }, no_log: true
        })) }]
      });
      for (const h of ctx.hosts) {
        const res = r.get(h.name);
        if (res?.status === 'ok' || res?.status === 'changed') {
          ctx.log(h.name, 'changed', `New passwords for ${ctx.values.users.join(', ')} are in the vault.`);
          ctx.done(h, 'changed', plural(ctx.values.users.length, 'password', 'passwords'));
        } else {
          // Not set: the vault goes back to the passwords the host still has
          for (const p of plans.get(h.name)) if (p.prev) await updateSecret(p.secretId, { data: p.prev, by: `Run ${ctx.run.id} (not applied)` });
          ctx.done(h, res?.status || 'failed', 'The passwords were not changed. The vault has the current ones.');
        }
      }
    }
  },
  {
    id: 'keys', kinds: ['takeover', 'maintain'], area: 'access', title: 'Make SSH keys for users',
    text: 'Makes a new key pair for each user on each host, lets it log in, and keeps the private key in the vault. Optionally a certificate from FleetPilot as well.',
    fields: [F.lines('users', 'Users', { pattern: 'user', required: true, default: ['root'] }), F.bool('cert', 'Also a certificate from FleetPilot', true), F.num('days', 'Certificate valid for (days)', 30, [1, 3650], { when: { cert: true } })],
    describe: v => `Makes a key pair${v.cert ? ' and a certificate' : ''} for ${v.users.join(', ')} on each host and keeps them in the vault.`,
    async run(ctx) {
      const uca = ctx.values.cert ? await userCa() : null;
      const plans = new Map();
      for (const h of ctx.hosts) {
        const list = [];
        for (const user of ctx.values.users) {
          const k = await newKeyPair(`${user}@${h.name}`);
          const cert = uca ? await signKey({ caPrivateKey: uca.data.privateKey, publicKey: k.publicKey, identity: `${user}@${h.name}`, principals: [`${user}@${h.name}`], validity: `+${ctx.values.days}d` }) : '';
          const name = `${user} SSH key`;
          const s = await hostSecret(h.id, 'ssh_key', name);
          const data = { username: user, privateKey: k.privateKey, ...(cert ? { certificate: cert } : {}) };
          const pub = { publicKey: k.publicKey, fingerprint: k.fingerprint, ...(cert ? { certificateValidDays: ctx.values.days } : {}) };
          if (s) await updateSecret(s.id, { data, pub, by: `Run ${ctx.run.id}`, rotated: true });
          else await createSecret({ scope: 'host', hostId: h.id, kind: 'ssh_key', name, username: user, data, pub, by: `Run ${ctx.run.id}` });
          list.push({ user, publicKey: k.publicKey });
        }
        plans.set(h.name, list);
      }
      await playOnAll(ctx, { name: 'Let the new keys log in', hosts: 'all', become: true, gather_facts: false, tasks: ctx.values.users.flatMap((u, i) => [
        T.file(`Make the SSH folder of ${u}`, { path: `~${u}/.ssh`, state: 'directory', owner: u, mode: '0700' }),
        T.block(`Let the key of ${u} log in`, { path: `~${u}/.ssh/authorized_keys`, create: true, owner: u, mode: '0600', marker: `# {mark} FleetPilot key of ${u}`, block: `{{ fp_new_keys[${i}] }}` }),
        ...(ctx.values.cert ? [T.file('Make the folder for principals', { path: '/etc/ssh/auth_principals', state: 'directory', mode: '0755' }),
          T.line(`Let the certificate of ${u} log in`, { path: `/etc/ssh/auth_principals/${u}`, line: `${u}@{{ fp_name }}`, create: true, mode: '0644' })] : [])
      ]) }, { vars: h => ({ fp_new_keys: plans.get(h.name).map(p => p.publicKey) }) });
    }
  },
  {
    id: 'nopasswords', kinds: ['takeover', 'maintain'], area: 'access', title: 'Turn off SSH password logins',
    text: 'Only keys and certificates may log in over SSH from now on. FleetPilot already logs in with its certificate, so it keeps access.',
    fields: [F.bool('root', 'Root may not log in over SSH at all', false)],
    describe: v => `Turns off SSH logins with passwords${v.root ? ' and root logins' : ''}.`,
    run: ctx => playOnAll(ctx, { name: 'Turn off SSH password logins', hosts: 'all', become: true, gather_facts: false, tasks: [
      T.copy('Allow only keys and certificates', '/etc/ssh/sshd_config.d/07-fleetpilot-keys-only.conf', conf(['PasswordAuthentication no', 'KbdInteractiveAuthentication no', ctx.values.root ? 'PermitRootLogin no' : 'PermitRootLogin prohibit-password']), { notify: 'Reload the SSH server' })
    ], handlers: [sshReload] })
  },

  // ---------------------------------------------------------------- Maintenance
  {
    id: 'update', kinds: ['takeover', 'maintain'], area: 'packages', title: 'Update packages',
    text: 'Installs all available updates and removes packages that are no longer needed.',
    fields: [F.select('mode', 'Updates', [['dist', 'All, also new dependencies (dist-upgrade)'], ['safe', 'Only without new packages (safe)']]), F.bool('autoremove', 'Remove packages no longer needed', true)],
    describe: v => `Installs ${v.mode === 'safe' ? 'safe' : 'all'} updates${v.autoremove ? ' and cleans up' : ''}.`,
    run: ctx => playOnAll(ctx, { name: 'Update packages', hosts: 'all', become: true, gather_facts: false, tasks: [
      { name: 'Install the updates', 'ansible.builtin.apt': { update_cache: true, upgrade: ctx.values.mode, autoremove: ctx.values.autoremove } }
    ] })
  },
  {
    id: 'reboot', kinds: ['takeover', 'maintain'], area: 'system', title: 'Reboot',
    text: 'Reboots the hosts and waits until they are back.',
    fields: [F.bool('onlyNeeded', 'Only when updates need it', true), F.num('timeout', 'Wait at most (seconds)', 600, [60, 3600])],
    describe: v => v.onlyNeeded ? 'Reboots the hosts that need it after updates, and waits.' : 'Reboots the hosts and waits until they are back.',
    run: ctx => playOnAll(ctx, { name: 'Reboot', hosts: 'all', become: true, gather_facts: false, tasks: [
      ...(ctx.values.onlyNeeded ? [{ name: 'Find out whether a reboot is needed', 'ansible.builtin.stat': { path: '/var/run/reboot-required' }, register: 'fp_reboot' }] : []),
      { name: 'Reboot and wait', 'ansible.builtin.reboot': { reboot_timeout: ctx.values.timeout, msg: 'Reboot by FleetPilot' }, ...(ctx.values.onlyNeeded ? { when: 'fp_reboot.stat.exists' } : {}) }
    ] })
  },
  {
    id: 'command', kinds: ['takeover', 'maintain'], area: 'files', title: 'Run a command',
    text: 'Runs a shell command on every host. For what no other step covers.',
    fields: [F.area('command', 'Command', { required: true, placeholder: 'systemctl restart myapp' }), F.bool('root', 'As root', true), F.bool('mayFail', 'Go on when it fails', false)],
    describe: v => `Runs: ${String(v.command).split('\n')[0].slice(0, 80)}`,
    run: ctx => playOnAll(ctx, { name: 'Run a command', hosts: 'all', become: !!ctx.values.root, gather_facts: false, tasks: [
      { name: 'Run the command', 'ansible.builtin.shell': { cmd: safeText(ctx.values.command, 'The command') }, ...(ctx.values.mayFail ? { ignore_errors: true } : {}) }
    ] })
  },

  // ---------------------------------------------------------------- In FleetPilot
  {
    id: 'approval', kinds: ['takeover', 'maintain'], area: 'security', title: 'Wait for an approval',
    text: 'The run stops here until someone who may approve runs says go on.',
    fields: [F.text('message', 'What to check before approving', { pattern: 'any', placeholder: 'Look at the drift above before the changes are applied.' })],
    describe: v => v.message ? `Waits for an approval: ${v.message}` : 'Waits for an approval before going on.',
    run: async () => {}   // handled by the runner
  },
  {
    id: 'group', kinds: ['takeover', 'maintain'], area: 'system', title: 'Move to a group',
    text: 'Moves the hosts into a group in FleetPilot (and so gives them its templates).',
    fields: [F.text('group', 'Group', { pattern: 'word', required: true, source: 'groups' })],
    describe: () => 'Moves the hosts into a group in FleetPilot.',
    async run(ctx) {
      const [g] = await query('select id, name from groups where id = $1', [ctx.values.group]);
      if (!g) throw httpError(400, 'no_group', 'The group of this step no longer exists.');
      for (const h of ctx.hosts) {
        await query('update hosts set group_id = $2, updated_at = now() where id = $1', [h.id, g.id]);
        h.group_id = g.id;
        ctx.done(h, 'changed', `In ${g.name}`);
      }
    }
  },
  {
    id: 'tags', kinds: ['takeover', 'maintain'], area: 'system', title: 'Set tags',
    text: 'Adds and removes tags of the hosts in FleetPilot.',
    fields: [F.lines('add', 'Add', { pattern: 'name' }), F.lines('remove', 'Remove', { pattern: 'name' })],
    describe: v => [v.add.length && `Adds ${v.add.join(', ')}`, v.remove.length && `removes ${v.remove.join(', ')}`].filter(Boolean).join(', ') || 'Changes no tags.',
    async run(ctx) {
      for (const h of ctx.hosts) {
        const [r] = await query('update hosts set tags = array(select distinct t from unnest(array_cat(tags, $2::text[])) t where not t = any($3::text[])), updated_at = now() where id = $1 returning tags', [h.id, ctx.values.add, ctx.values.remove]);
        ctx.done(h, 'changed', r.tags.join(', '));
      }
    }
  },
  {
    id: 'wait', kinds: ['takeover', 'maintain'], area: 'schedules', title: 'Wait',
    text: 'Pauses the run, for example to let a service settle before the next batch.',
    fields: [F.num('minutes', 'Minutes', 5, [1, 1440])],
    describe: v => `Waits ${plural(v.minutes, 'minute', 'minutes')}.`,
    async run(ctx) {
      const end = Date.now() + ctx.values.minutes * 60_000;
      while (Date.now() < end && !ctx.signal.aborted) await new Promise(r => setTimeout(r, 1000));
      for (const h of ctx.hosts) ctx.done(h, 'ok', '');
    }
  }
];
export const STEP_TYPES = new Map(STEPS.map(s => [s.id, s]));

async function rename(ctx, h, name, onlyIfFree = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) throw httpError(400, 'bad_name', `"${name}" is not a valid host name.`);
  const taken = (await query('select 1 from hosts where lower(name) = lower($1) and id <> $2', [name, h.id])).length;
  if (taken) { if (onlyIfFree) return false; throw httpError(409, 'name_taken', `Another host is called ${name}.`); }
  await query('update hosts set name = $2, updated_at = now() where id = $1', [h.id, name]);
  ctx.log(h.name, 'changed', `Renamed to ${name}`);
  ctx.rename(h, name);
  return true;
}

/** Applies (or checks) the desired state; hosts with the same state share one play */
async function applyState(ctx, { check, only }) {
  const paths = await groupPaths();
  const groups = new Map();
  for (const h of ctx.hosts) {
    let state;
    if (only) {
      const rows = await query(`select t.id, t.current_version as version, v.definition from templates t join template_versions v on v.template_id = t.id and v.version = t.current_version where t.id = any($1::bigint[])`, [only]);
      const byId = new Map(rows.map(r => [String(r.id), r]));
      const list = only.map(id => byId.get(String(id))).filter(Boolean);
      state = { merged: mergeDefinitions(list.map(r => r.definition)), templates: list.map(r => ({ template: String(r.id), version: r.version })) };
    } else state = await desiredState(h, paths);
    h.desired = state;
    const key = JSON.stringify([...state.merged]);
    if (!groups.has(key)) groups.set(key, { merged: state.merged, hosts: [] });
    groups.get(key).hosts.push(h);
  }
  const plays = [], drift = new Map();
  for (const g of groups.values()) plays.push(playOf(g.merged, { name: check ? 'Check the desired state' : 'Apply the desired state', hosts: g.hosts.map(h => h.name).join(','), check }));
  const r = await ctx.ansible({
    plays, hosts: ctx.hosts, check, withSecrets: true,
    onEvent: e => {
      if (check && e.event === 'result' && e.status === 'changed') {
        if (!drift.has(e.host)) drift.set(e.host, []);
        drift.get(e.host).push({ task: e.task, diff: (e.diff || []).slice(0, 3) });
      }
    }
  });
  for (const h of ctx.hosts) {
    const res = r.get(h.name) || { status: 'failed' };
    if (check) {
      const d = drift.get(h.name) || [];
      await query('update hosts set drift = $2, updated_at = now() where id = $1', [h.id, JSON.stringify({ at: new Date().toISOString(), changed: d.length, tasks: d.slice(0, 50), failed: res.status === 'failed' || res.status === 'unreachable' })]);
      ctx.done(h, res.status === 'changed' ? 'changed' : res.status, res.status === 'failed' || res.status === 'unreachable' ? '' : d.length ? `${plural(d.length, 'difference', 'differences')}` : 'In line with its desired state');
    } else {
      if (res.status === 'ok' || res.status === 'changed') {
        for (const t of h.desired.templates) {
          await query(`insert into host_templates (host_id, template_id, applied_version) values ($1, $2, $3)
            on conflict (host_id, template_id) do update set applied_version = $3, applied_at = now()`, [h.id, t.template, t.version]);
        }
        if (!only) await query("update hosts set drift = jsonb_build_object('at', now(), 'changed', 0, 'tasks', '[]'::jsonb), updated_at = now() where id = $1", [h.id]);
        // A changed SSH port in the desired state: FleetPilot follows it
        const port = h.desired.merged.get('sshd')?.port;
        if (port && port !== h.port) await query('update hosts set port = $2 where id = $1', [h.id, port]);
      }
      ctx.done(h, res.status, res.status === 'changed' ? plural(res.changed, 'change', 'changes') : res.status === 'ok' ? 'Nothing to change' : '');
    }
  }
}

/** Step types for the web app */
export function stepsForClient() {
  return STEPS.map(s => ({ id: s.id, kinds: s.kinds, area: s.area, title: s.title, text: s.text, fields: s.fields }));
}
