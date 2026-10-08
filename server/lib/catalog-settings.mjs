// FleetPilot: the setting types of every area except services (catalog-services.mjs).
// A type: { id, area, title, text, fields, single | collect: { field, key }, tasks(v, ctx), summary(v), needs?(v), ports?(v) }
//   single   one per host: the most specific template wins
//   collect  rows of all templates are put together (a later row with the same key wins)
// tasks() returns { tasks, handlers } in ansible.builtin; ctx has ports (all open ports), sshPort.
import { T, F, conf, quote, slug } from './catalog.mjs';

const H = {   // handlers used by several settings
  sysctl: { 'Apply kernel settings': T.cmd('Apply kernel settings', 'sysctl --system') },
  sshd: { 'Reload the SSH server': [T.cmd('Check the SSH server configuration', 'sshd -t'), T.reload('ssh')] },
  daemon: { 'Reload systemd': { name: 'Reload systemd', 'ansible.builtin.systemd': { daemon_reload: true } } }
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const SETTINGS = [
  // ---------------------------------------------------------------- System
  {
    id: 'hostname', area: 'system', single: true, title: 'Host name',
    text: 'Sets the host name from FleetPilot and the matching line in /etc/hosts.',
    fields: [
      F.text('domain', 'Domain', { pattern: 'host', placeholder: 'example.com', help: 'Empty: the domain of the host\'s subnet, if it has one.' }),
      F.bool('hostsLine', 'Write the name into /etc/hosts (127.0.1.1)', true)
    ],
    tasks: v => {
      const fqdn = v.domain ? `{{ fp_name }}.${v.domain}` : '{{ fp_fqdn }}';
      return {
        tasks: [
          { name: 'Set the host name', 'ansible.builtin.hostname': { name: '{{ fp_name }}' } },
          ...(v.hostsLine ? [T.line('Name the host in /etc/hosts', { path: '/etc/hosts', unsafe_writes: true, regexp: '^127\\.0\\.1\\.1\\s', line: `127.0.1.1 ${fqdn} {{ fp_name }}` })] : [])
        ]
      };
    },
    summary: v => v.domain ? `The FleetPilot name with the domain ${v.domain}` : 'The FleetPilot name of each host'
  },
  {
    id: 'timezone', area: 'system', single: true, title: 'Time zone',
    text: 'Sets the time zone of the host.',
    fields: [F.text('zone', 'Time zone', { default: 'Etc/UTC', pattern: 'word', placeholder: 'Europe/Zurich', required: true })],
    tasks: v => ({
      tasks: [
        T.file('Set the time zone', { src: `/usr/share/zoneinfo/${v.zone}`, dest: '/etc/localtime', state: 'link', force: true }),
        T.copy('Write /etc/timezone', '/etc/timezone', `${v.zone}\n`)
      ]
    }),
    summary: v => v.zone
  },
  {
    id: 'locale', area: 'system', single: true, title: 'Language and keyboard',
    text: 'The language of messages and formats, more languages to have, and the keyboard layout.',
    fields: [
      F.text('lang', 'Language', { default: 'en_US.UTF-8', pattern: 'word', required: true }),
      F.lines('extra', 'More languages to generate', { pattern: 'word', placeholder: 'de_CH.UTF-8' }),
      F.text('keyboard', 'Keyboard layout', { default: 'us', pattern: 'word', placeholder: 'ch' }),
      F.text('variant', 'Keyboard variant', { pattern: 'word', placeholder: 'de' })
    ],
    tasks: v => {
      const locales = [...new Set([v.lang, ...v.extra])];
      return {
        tasks: [
          T.apt(['locales', 'keyboard-configuration'], 'present', 'Install the language support'),
          ...locales.map(l => T.line(`Offer the language ${l}`, { path: '/etc/locale.gen', regexp: `^#?\\s*${l.replace(/\./g, '\\.')}\\s`, line: `${l} ${l.split('.')[1] || 'UTF-8'}` }, { notify: 'Generate languages' })),
          T.copy('Set the language', '/etc/default/locale', `LANG=${v.lang}\n`),
          ...(v.keyboard ? [T.copy('Set the keyboard layout', '/etc/default/keyboard', conf([`XKBMODEL="pc105"`, `XKBLAYOUT=${quote(v.keyboard)}`, `XKBVARIANT=${quote(v.variant)}`, 'XKBOPTIONS=""', 'BACKSPACE="guess"']))] : [])
        ],
        handlers: { 'Generate languages': T.cmd('Generate languages', 'locale-gen') }
      };
    },
    summary: v => `${v.lang}${v.keyboard ? `, keyboard ${v.keyboard}${v.variant ? ` ${v.variant}` : ''}` : ''}`
  },
  {
    id: 'ntp', area: 'system', single: true, title: 'Time servers',
    text: 'Keeps the clock right with chrony and the time servers you name.',
    fields: [
      F.lines('servers', 'Time servers', { pattern: 'host', placeholder: 'ntp.example.com', default: [] , help: 'One per line. Empty: the public Debian pool.' }),
      F.bool('only', 'Use only these servers (not the public pool)', true),
      F.bool('serve', 'Serve the time to other hosts', false),
      F.lines('allow', 'Networks that may ask for the time', { pattern: 'cidr', when: { serve: true } })
    ],
    tasks: v => ({
      tasks: [
        T.apt(['chrony']),
        T.copy('Name the time servers', '/etc/chrony/sources.d/fleetpilot.sources', conf(v.servers.map(s => `server ${s} iburst`)), { notify: 'Restart chrony' }),
        ...(v.only && v.servers.length ? [{ name: 'Use only the named time servers', 'ansible.builtin.replace': { path: '/etc/chrony/chrony.conf', regexp: '^(pool|server) ', replace: '#\\1 ' }, notify: ['Restart chrony'] }] : []),
        T.copy('Serve the time', '/etc/chrony/conf.d/fleetpilot.conf', conf(v.serve ? (v.allow.length ? v.allow.map(a => `allow ${a}`) : ['allow']) : ['# Not serving the time']), { notify: 'Restart chrony' }),
        T.service('chrony')
      ],
      handlers: { 'Restart chrony': T.restart('chrony') }
    }),
    ports: v => v.serve ? [{ port: 123, proto: 'udp', from: v.allow }] : [],
    summary: v => v.servers.length ? `${v.servers.join(', ')}${v.serve ? ', serves the time' : ''}` : 'The public pool'
  },
  {
    id: 'banner', area: 'system', single: true, title: 'Login messages',
    text: 'The message after login (MOTD), and a notice before login on the console and over SSH.',
    fields: [
      F.area('motd', 'After login', { placeholder: 'Managed by FleetPilot. Changes by hand are overwritten.' }),
      F.area('notice', 'Before login', { placeholder: 'Authorized use only. Activity is logged.' }),
      F.bool('ssh', 'Show the notice before an SSH login too', true)
    ],
    tasks: v => ({
      tasks: [
        T.copy('Write the message after login', '/etc/motd', v.motd ? v.motd.replace(/\n?$/, '\n') : ''),
        T.copy('Write the notice before login', '/etc/issue.net', v.notice ? v.notice.replace(/\n?$/, '\n') : ''),
        T.copy('Write the notice for the console', '/etc/issue', v.notice ? v.notice.replace(/\n?$/, '\n') : '\\S\nKernel \\r on an \\m\n\n'),
        T.copy('Show the notice over SSH', '/etc/ssh/sshd_config.d/05-fleetpilot-banner.conf', conf([v.ssh && v.notice ? 'Banner /etc/issue.net' : 'Banner none']), { notify: 'Reload the SSH server' })
      ],
      handlers: H.sshd
    }),
    summary: v => [v.motd && 'after login', v.notice && 'before login'].filter(Boolean).join(' and ') || 'No messages'
  },
  {
    id: 'sysctl', area: 'system', collect: { field: 'values', key: 'key' }, title: 'Kernel settings',
    text: 'Values for /proc/sys (sysctl), kept in /etc/sysctl.d/90-fleetpilot.conf.',
    fields: [F.rows('values', 'Settings', [F.text('key', 'Key', { pattern: 'word', required: true, placeholder: 'net.ipv4.ip_forward' }), F.text('value', 'Value', { pattern: 'any', placeholder: '1' })])],
    tasks: v => ({
      tasks: [T.copy('Write the kernel settings', '/etc/sysctl.d/90-fleetpilot.conf', conf(v.values.map(r => `${r.key} = ${r.value}`)), { notify: 'Apply kernel settings' })],
      handlers: H.sysctl
    }),
    summary: v => plural(v.values.length, 'value', 'values')
  },
  {
    id: 'modules', area: 'system', collect: { field: 'modules', key: 'name' }, title: 'Kernel modules',
    text: 'Modules to load at boot, and modules that must never load.',
    fields: [F.rows('modules', 'Modules', [F.text('name', 'Module', { pattern: 'name', required: true, placeholder: 'br_netfilter' }), F.select('mode', 'Then', [['load', 'Load at boot'], ['block', 'Never load']])])],
    tasks: v => ({
      tasks: [
        T.file('Make the folder for modules to load', { path: '/etc/modules-load.d', state: 'directory', mode: '0755' }),
        T.file('Make the folder for module rules', { path: '/etc/modprobe.d', state: 'directory', mode: '0755' }),
        T.copy('Load modules at boot', '/etc/modules-load.d/fleetpilot.conf', conf(v.modules.filter(m => m.mode === 'load').map(m => m.name))),
        T.copy('Block modules', '/etc/modprobe.d/fleetpilot-blocked.conf', conf(v.modules.filter(m => m.mode === 'block').flatMap(m => [`blacklist ${m.name}`, `install ${m.name} /bin/false`]))),
        ...v.modules.filter(m => m.mode === 'load').map(m => T.cmd(`Load ${m.name} now`, `modprobe ${m.name}`, { changed: false }))
      ]
    }),
    summary: v => v.modules.map(m => m.mode === 'load' ? m.name : `no ${m.name}`).join(', ') || 'None'
  },
  {
    id: 'grub', area: 'system', single: true, title: 'Boot parameters',
    text: 'Kernel parameters in GRUB. They take effect after the next reboot.',
    fields: [F.text('params', 'Parameters', { pattern: 'any', placeholder: 'quiet net.ifnames=0 console=ttyS0', default: 'quiet' })],
    tasks: v => ({
      tasks: [T.line('Set the boot parameters', { path: '/etc/default/grub', regexp: '^GRUB_CMDLINE_LINUX_DEFAULT=', line: `GRUB_CMDLINE_LINUX_DEFAULT=${quote(v.params)}` }, { notify: 'Update GRUB' })],
      handlers: { 'Update GRUB': T.cmd('Update GRUB', 'update-grub') }
    }),
    summary: v => v.params || 'No parameters'
  },
  {
    id: 'swap', area: 'system', single: true, title: 'Swap',
    text: 'A swap file of the size you choose, and how eagerly the kernel uses it.',
    fields: [F.num('size', 'Swap file in MB (0: none)', 0, [0, 262144]), F.num('swappiness', 'Swappiness', 60, [0, 200], { help: '0 to 200. Lower keeps more in memory.' })],
    tasks: v => ({
      tasks: [
        ...(v.size > 0 ? [
          T.cmd('Make the swap file', `fallocate -l ${v.size}M /swapfile`, { creates: '/swapfile' }),
          T.file('Protect the swap file', { path: '/swapfile', mode: '0600', owner: 'root', group: 'root' }),
          T.shell('Prepare the swap file', 'blkid /swapfile | grep -q swap || { mkswap /swapfile >/dev/null; echo made; }', { register: 'fp_swap', changedWhen: "'made' in fp_swap.stdout" }),
          T.line('Use the swap file at boot', { path: '/etc/fstab', regexp: '^/swapfile\\s', line: '/swapfile none swap sw 0 0' }),
          T.shell('Turn the swap file on', 'swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile', { changed: false })
        ] : []),
        T.copy('Set the swappiness', '/etc/sysctl.d/91-fleetpilot-swap.conf', conf([`vm.swappiness = ${v.swappiness}`]), { notify: 'Apply kernel settings' })
      ],
      handlers: H.sysctl
    }),
    summary: v => `${v.size ? `${v.size} MB swap file` : 'No swap file'}, swappiness ${v.swappiness}`
  },
  {
    id: 'journald', area: 'system', single: true, title: 'System log',
    text: 'How much the systemd journal keeps, and for how long.',
    fields: [
      F.text('maxUse', 'At most', { default: '500M', pattern: 'duration' }),
      F.text('retention', 'For at most', { default: '1month', pattern: 'duration' }),
      F.bool('persistent', 'Keep the log across reboots', true),
      F.bool('syslog', 'Also hand messages to syslog', false)
    ],
    tasks: v => ({
      tasks: [
        T.file('Make the folder for journal settings', { path: '/etc/systemd/journald.conf.d', state: 'directory', mode: '0755' }),
        T.copy('Set the journal limits', '/etc/systemd/journald.conf.d/fleetpilot.conf', conf(['[Journal]', `Storage=${v.persistent ? 'persistent' : 'volatile'}`, `SystemMaxUse=${v.maxUse}`, `MaxRetentionSec=${v.retention}`, `ForwardToSyslog=${v.syslog ? 'yes' : 'no'}`]), { notify: 'Restart journald' })
      ],
      handlers: { 'Restart journald': T.restart('systemd-journald') }
    }),
    summary: v => `${v.maxUse}, ${v.retention}${v.persistent ? ', kept across reboots' : ''}`
  },
  {
    id: 'proxy', area: 'system', single: true, title: 'Proxy',
    text: 'A proxy for package downloads and for programs that read http_proxy.',
    fields: [
      F.text('http', 'HTTP proxy', { pattern: 'url', placeholder: 'http://proxy.example.com:3128' }),
      F.text('https', 'HTTPS proxy', { pattern: 'url', placeholder: 'Empty: the same as HTTP' }),
      F.text('noProxy', 'Not for', { pattern: 'word', default: 'localhost,127.0.0.1', placeholder: 'localhost,127.0.0.1,.example.com' }),
      F.bool('apt', 'Use it for packages', true)
    ],
    tasks: v => {
      const https = v.https || v.http;
      return {
        tasks: [
          T.copy('Set the proxy for programs', '/etc/profile.d/fleetpilot-proxy.sh', conf(v.http ? [`export http_proxy=${quote(v.http)} HTTP_PROXY=${quote(v.http)}`, `export https_proxy=${quote(https)} HTTPS_PROXY=${quote(https)}`, `export no_proxy=${quote(v.noProxy)} NO_PROXY=${quote(v.noProxy)}`] : [])),
          ...['http_proxy', 'https_proxy', 'no_proxy'].map(k => T.line(`Set ${k} for services`, v.http ? { path: '/etc/environment', regexp: `^${k}=`, line: `${k}=${k === 'no_proxy' ? v.noProxy : k === 'https_proxy' ? https : v.http}` } : { path: '/etc/environment', regexp: `^${k}=`, state: 'absent' })),
          T.copy('Set the proxy for packages', '/etc/apt/apt.conf.d/90fleetpilot-proxy', conf(v.http && v.apt ? [`Acquire::http::Proxy ${quote(v.http)};`, `Acquire::https::Proxy ${quote(https)};`] : [], '//'))
        ]
      };
    },
    summary: v => v.http || 'No proxy'
  },
  {
    id: 'hosts', area: 'system', collect: { field: 'entries', key: 'ip' }, title: 'Entries in /etc/hosts',
    text: 'Names for addresses, without DNS.',
    fields: [F.rows('entries', 'Entries', [F.text('ip', 'Address', { pattern: 'ip', required: true, placeholder: '10.20.0.5' }), F.text('names', 'Names', { pattern: 'any', placeholder: 'db.example.com db' })])],
    tasks: v => ({ tasks: [T.block('Write the entries into /etc/hosts', { path: '/etc/hosts', unsafe_writes: true, marker: '# {mark} FleetPilot entries', block: v.entries.map(e => `${e.ip} ${e.names}`).join('\n') })] }),
    summary: v => plural(v.entries.length, 'entry', 'entries')
  },
  {
    id: 'reboot', area: 'system', single: true, title: 'Reboot when needed',
    text: 'Reboots the host at the end when installed updates ask for it (/var/run/reboot-required).',
    fields: [F.bool('allowed', 'Reboot when needed', true), F.num('timeout', 'Wait for the host at most (seconds)', 600, [60, 3600])],
    tasks: v => ({
      tasks: v.allowed ? [
        { name: 'Find out whether a reboot is needed', 'ansible.builtin.stat': { path: '/var/run/reboot-required' }, register: 'fp_reboot' },
        { name: 'Reboot because updates need it', 'ansible.builtin.reboot': { reboot_timeout: v.timeout, msg: 'Reboot by FleetPilot: updates need it' }, when: 'fp_reboot.stat.exists' }
      ] : []
    }),
    summary: v => v.allowed ? 'Reboots when updates need it' : 'Never reboots by itself'
  },

  // ---------------------------------------------------------------- Network (the files are written by network.mjs)
  {
    id: 'interface', area: 'network', single: true, title: 'Address of the host',
    text: 'The main interface: an address from IP management, a fixed one, or DHCP.',
    fields: [
      F.select('method', 'Address', [['ipam', 'From IP management (the host\'s address)'], ['static', 'A fixed address'], ['dhcp', 'DHCP']]),
      F.text('address', 'Fixed address with prefix', { pattern: 'cidr', placeholder: '10.20.0.11/24', when: { method: 'static' } }),
      F.text('gateway', 'Gateway', { pattern: 'ip', placeholder: 'Empty: the subnet\'s gateway', when: { method: ['static', 'ipam'] } }),
      F.text('name', 'Interface', { pattern: 'iface', placeholder: 'Empty: the one with the default route' }),
      F.num('mtu', 'MTU', 0, [0, 9216], { help: '0: leave it as it is' }),
      F.select('ipv6', 'IPv6', [['auto', 'Automatic (router advertisements)'], ['off', 'Off on this interface']])
    ],
    summary: v => ({ ipam: 'Address from IP management', static: `Fixed ${v.address}`, dhcp: 'DHCP' }[v.method])
  },
  {
    id: 'vlans', area: 'network', collect: { field: 'vlans', key: 'id' }, title: 'VLAN interfaces',
    text: 'Tagged VLANs on a physical interface, a bond or a bridge.',
    fields: [F.rows('vlans', 'VLANs', [
      F.num('id', 'VLAN', 10, [1, 4094], { required: true }), F.text('parent', 'On', { pattern: 'iface', placeholder: 'ens18' }),
      F.select('method', 'Address', [['none', 'No address'], ['static', 'Fixed'], ['dhcp', 'DHCP']]), F.text('address', 'Address with prefix', { pattern: 'cidr', placeholder: '10.30.0.11/24' })
    ])],
    summary: v => v.vlans.map(x => `VLAN ${x.id}`).join(', ') || 'None'
  },
  {
    id: 'bonds', area: 'network', collect: { field: 'bonds', key: 'name' }, title: 'Bonds',
    text: 'Several interfaces as one, for more bandwidth or a spare link.',
    fields: [F.rows('bonds', 'Bonds', [
      F.text('name', 'Name', { pattern: 'iface', required: true, placeholder: 'bond0' }), F.text('members', 'Interfaces', { pattern: 'word', placeholder: 'ens18,ens19' }),
      F.select('mode', 'Mode', [['active-backup', 'Active and spare'], ['802.3ad', 'LACP (802.3ad)'], ['balance-alb', 'Adaptive load balancing']]),
      F.select('method', 'Address', [['none', 'No address'], ['static', 'Fixed'], ['dhcp', 'DHCP']]), F.text('address', 'Address with prefix', { pattern: 'cidr' })
    ])],
    summary: v => v.bonds.map(b => `${b.name} (${b.members})`).join(', ') || 'None'
  },
  {
    id: 'bridges', area: 'network', collect: { field: 'bridges', key: 'name' }, title: 'Bridges',
    text: 'Bridges for virtual machines and containers.',
    fields: [F.rows('bridges', 'Bridges', [
      F.text('name', 'Name', { pattern: 'iface', required: true, placeholder: 'br0' }), F.text('ports', 'Ports', { pattern: 'word', placeholder: 'ens19' }),
      F.select('method', 'Address', [['none', 'No address'], ['static', 'Fixed'], ['dhcp', 'DHCP']]), F.text('address', 'Address with prefix', { pattern: 'cidr' })
    ])],
    summary: v => v.bridges.map(b => b.name).join(', ') || 'None'
  },
  {
    id: 'routes', area: 'network', collect: { field: 'routes', key: 'to' }, title: 'Static routes',
    text: 'Routes to other networks through a gateway.',
    fields: [F.rows('routes', 'Routes', [F.text('to', 'Network', { pattern: 'cidr', required: true, placeholder: '10.50.0.0/16' }), F.text('via', 'Through', { pattern: 'ip', placeholder: '10.20.0.254' }), F.text('dev', 'Interface', { pattern: 'iface', placeholder: 'Empty: the main one' })])],
    summary: v => v.routes.map(r => `${r.to} via ${r.via}`).join(', ') || 'None'
  },
  {
    id: 'dns', area: 'network', single: true, title: 'Name resolution',
    text: 'DNS servers and search domains. Empty fields take the values of the host\'s subnet.',
    fields: [F.lines('servers', 'DNS servers', { pattern: 'ip', placeholder: '10.20.0.53' }), F.lines('search', 'Search domains', { pattern: 'host', placeholder: 'example.com' })],
    summary: v => v.servers.length ? v.servers.join(', ') : 'From the subnet'
  },
  {
    id: 'ipv6', area: 'network', single: true, title: 'IPv6 on the host',
    text: 'Turns IPv6 off on all interfaces when your networks do not use it.',
    fields: [F.bool('disable', 'Turn IPv6 off', false)],
    tasks: v => ({ tasks: [T.copy('Set IPv6', '/etc/sysctl.d/93-fleetpilot-ipv6.conf', conf(v.disable ? ['net.ipv6.conf.all.disable_ipv6 = 1', 'net.ipv6.conf.default.disable_ipv6 = 1'] : ['# IPv6 stays on']), { notify: 'Apply kernel settings' })], handlers: H.sysctl }),
    summary: v => v.disable ? 'Off' : 'On'
  },

  // ---------------------------------------------------------------- Access
  {
    id: 'users', area: 'access', collect: { field: 'users', key: 'username' }, title: 'Users',
    text: 'Local accounts, their groups, sudo rights and a first password that FleetPilot makes and keeps in the vault.',
    fields: [F.rows('users', 'Users', [
      F.text('username', 'User', { pattern: 'user', required: true, placeholder: 'alice' }),
      F.text('name', 'Full name', { pattern: 'any', placeholder: 'Alice Doe' }),
      F.text('groups', 'Groups', { pattern: 'word', placeholder: 'adm,systemd-journal' }),
      F.select('sudo', 'sudo', [['none', 'No sudo'], ['password', 'With password'], ['nopassword', 'Without password']]),
      F.select('shell', 'Shell', [['/bin/bash', 'bash'], ['/bin/sh', 'sh'], ['/usr/bin/zsh', 'zsh'], ['/usr/sbin/nologin', 'No login']]),
      F.select('state', 'State', [['present', 'Present'], ['absent', 'Removed'], ['locked', 'Locked']])
    ])],
    needs: v => v.users.filter(u => u.state !== 'absent').map(u => ({ type: 'password', name: u.username, generate: true })),
    tasks: v => {
      const tasks = [];
      if (v.users.some(u => u.sudo !== 'none' && u.state === 'present')) tasks.push(T.apt(['sudo']));
      for (const u of v.users) {
        const groups = u.groups.split(',').map(g => g.trim()).filter(Boolean);
        if (u.state === 'absent') {
          tasks.push({ name: `Remove the user ${u.username}`, 'ansible.builtin.user': { name: u.username, state: 'absent', remove: false } });
          tasks.push(T.file(`Remove the sudo rights of ${u.username}`, { path: `/etc/sudoers.d/fp-${u.username}`, state: 'absent' }));
          continue;
        }
        tasks.push({ name: `Create the user ${u.username}`, 'ansible.builtin.user': { name: u.username, comment: u.name, shell: u.shell, groups, append: true, password: `{{ fp_passwords['${u.username}'] | default(omit) }}`, update_password: 'on_create', password_lock: u.state === 'locked' }, no_log: true });
        tasks.push(u.sudo === 'none'
          ? T.file(`No sudo for ${u.username}`, { path: `/etc/sudoers.d/fp-${u.username}`, state: 'absent' })
          : T.copy(`Give ${u.username} sudo`, `/etc/sudoers.d/fp-${u.username}`, conf([`${u.username} ALL=(ALL:ALL) ${u.sudo === 'nopassword' ? 'NOPASSWD: ' : ''}ALL`]), { mode: '0440', validate: 'visudo -cf %s' }));
      }
      return { tasks };
    },
    summary: v => v.users.map(u => u.username).join(', ') || 'None'
  },
  {
    id: 'groups', area: 'access', collect: { field: 'groups', key: 'name' }, title: 'Groups',
    text: 'Local groups, for example for shared folders.',
    fields: [F.rows('groups', 'Groups', [F.text('name', 'Group', { pattern: 'user', required: true, placeholder: 'developers' }), F.num('gid', 'Group id', 0, [0, 4294967294], { help: '0: chosen by the system' }), F.select('state', 'State', [['present', 'Present'], ['absent', 'Removed']])])],
    tasks: v => ({ tasks: v.groups.map(g => ({ name: `${g.state === 'absent' ? 'Remove' : 'Create'} the group ${g.name}`, 'ansible.builtin.group': { name: g.name, state: g.state, ...(g.gid ? { gid: g.gid } : {}) } })) }),
    summary: v => v.groups.map(g => g.name).join(', ') || 'None'
  },
  {
    id: 'root', area: 'access', single: true, title: 'The root account',
    text: 'Whether root may log in with a password at all. Its password is set by the workflow "Rotate passwords".',
    fields: [F.bool('lock', 'Lock the root password (use sudo instead)', false)],
    tasks: v => ({ tasks: [{ name: v.lock ? 'Lock the root password' : 'Leave the root password usable', 'ansible.builtin.user': { name: 'root', password_lock: v.lock } }] }),
    summary: v => v.lock ? 'Password locked' : 'Password usable'
  },
  {
    id: 'keys', area: 'access', collect: { field: 'keys', key: 'key' }, title: 'Authorized SSH keys',
    text: 'Public keys that may log in as a user.',
    fields: [
      F.rows('keys', 'Keys', [F.text('user', 'User', { pattern: 'user', required: true, placeholder: 'alice' }), F.text('key', 'Public key', { pattern: 'any', maxLength: 2000, required: true, placeholder: 'ssh-ed25519 AAAA… alice@laptop' })]),
      F.bool('exclusive', 'Remove keys that are not listed here (FleetPilot\'s own key stays)', false)
    ],
    tasks: v => {
      const users = [...new Set(v.keys.map(k => k.user))];
      return {
        tasks: users.flatMap(u => [
          T.file(`Make the SSH folder of ${u}`, { path: `~${u}/.ssh`, state: 'directory', owner: u, group: u, mode: '0700' }),
          v.exclusive
            ? T.copy(`Set the keys of ${u}`, `~${u}/.ssh/authorized_keys`, [...v.keys.filter(k => k.user === u).map(k => k.key), ...(u === 'fleetpilot' ? ['{{ fp_ssh_public_key }}'] : [])].join('\n') + '\n', { owner: u, group: u, mode: '0600' })
            : T.block(`Add the keys of ${u}`, { path: `~${u}/.ssh/authorized_keys`, create: true, owner: u, group: u, mode: '0600', marker: '# {mark} FleetPilot keys', block: v.keys.filter(k => k.user === u).map(k => k.key).join('\n') })
        ])
      };
    },
    summary: v => plural(v.keys.length, 'key', 'keys')
  },
  {
    id: 'sshd', area: 'access', single: true, title: 'SSH server',
    text: 'Port, password and root logins, who may log in, and modern ciphers only.',
    fields: [
      F.num('port', 'Port', 22, [1, 65535]),
      F.bool('passwords', 'Allow logins with a password', false),
      F.select('root', 'Root login', [['prohibit-password', 'Only with a key'], ['no', 'Never'], ['yes', 'Also with a password']]),
      F.text('allowUsers', 'Only these users', { pattern: 'word', placeholder: 'Empty: everybody. alice,bob' }),
      F.text('allowGroups', 'Only these groups', { pattern: 'word', placeholder: 'sshusers' }),
      F.num('maxTries', 'Attempts per connection', 4, [1, 20]),
      F.num('idle', 'End idle sessions after (minutes, 0: never)', 0, [0, 1440]),
      F.bool('forwarding', 'Allow forwarding (tunnels, agent, X11)', false),
      F.bool('modern', 'Only modern ciphers and key exchanges', true)
    ],
    tasks: v => {
      const users = v.allowUsers ? [...new Set([...v.allowUsers.split(','), 'fleetpilot'])].join(' ') : '';
      return {
        tasks: [T.copy('Configure the SSH server', '/etc/ssh/sshd_config.d/10-fleetpilot.conf', conf([
          `Port ${v.port}`,
          `PasswordAuthentication ${v.passwords ? 'yes' : 'no'}`,
          `KbdInteractiveAuthentication ${v.passwords ? 'yes' : 'no'}`,
          `PermitRootLogin ${v.root}`,
          users ? `AllowUsers ${users}` : null,
          v.allowGroups ? `AllowGroups ${v.allowGroups.split(',').join(' ')}` : null,
          `MaxAuthTries ${v.maxTries}`,
          v.idle ? `ClientAliveInterval 60\nClientAliveCountMax ${v.idle}` : null,
          `AllowTcpForwarding ${v.forwarding ? 'yes' : 'no'}`, `AllowAgentForwarding ${v.forwarding ? 'yes' : 'no'}`, `X11Forwarding ${v.forwarding ? 'yes' : 'no'}`,
          v.modern ? 'KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org\nCiphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com\nMACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com' : null
        ]), { notify: 'Reload the SSH server' })],
        handlers: H.sshd
      };
    },
    ports: v => [{ port: v.port, proto: 'tcp', ssh: true }],
    summary: v => `Port ${v.port}, ${v.passwords ? 'passwords allowed' : 'keys only'}, root ${({ 'prohibit-password': 'with a key', no: 'never', yes: 'with a password' })[v.root]}`
  },
  {
    id: 'sudo', area: 'access', single: true, title: 'sudo rules',
    text: 'How long sudo remembers a password, and whether every command is logged.',
    fields: [F.num('timeout', 'Remember the password for (minutes)', 15, [0, 1440]), F.bool('log', 'Log every command with its output', false), F.bool('lecture', 'Show the warning at the first use', true)],
    tasks: v => ({
      tasks: [T.apt(['sudo']), T.copy('Set the sudo rules', '/etc/sudoers.d/00-fleetpilot', conf([`Defaults timestamp_timeout=${v.timeout}`, v.log ? 'Defaults log_output\nDefaults!/usr/bin/sudoreplay !log_output\nDefaults logfile=/var/log/sudo.log' : null, `Defaults lecture=${v.lecture ? 'once' : 'never'}`]), { mode: '0440', validate: 'visudo -cf %s' })]
    }),
    summary: v => `${v.timeout} min${v.log ? ', every command logged' : ''}`
  },
  {
    id: 'pwquality', area: 'access', single: true, title: 'Password rules on the host',
    text: 'How strong the passwords of local users must be (pwquality).',
    fields: [F.num('minlen', 'Shortest password', 12, [6, 64]), F.num('minclass', 'Kinds of characters (lower, upper, digits, others)', 0, [0, 4]), F.num('maxrepeat', 'At most the same character in a row (0: any)', 3, [0, 10]), F.bool('dictcheck', 'Refuse dictionary words', true)],
    tasks: v => ({
      tasks: [T.apt(['libpam-pwquality']), T.file('Make the folder for password rules', { path: '/etc/security/pwquality.conf.d', state: 'directory', mode: '0755' }),
        T.copy('Set the password rules', '/etc/security/pwquality.conf.d/fleetpilot.conf', conf([`minlen = ${v.minlen}`, `minclass = ${v.minclass}`, `maxrepeat = ${v.maxrepeat}`, `dictcheck = ${v.dictcheck ? 1 : 0}`, 'enforce_for_root']))]
    }),
    summary: v => `At least ${v.minlen} characters`
  },
  {
    id: 'faillock', area: 'access', single: true, title: 'Lockout after wrong passwords',
    text: 'Locks a local account for a while after wrong passwords (pam_faillock).',
    fields: [F.num('deny', 'Wrong passwords before the lock', 5, [1, 50]), F.num('unlock', 'Locked for (seconds)', 900, [0, 86400]), F.bool('root', 'Lock root too', false)],
    tasks: v => ({
      tasks: [
        T.copy('Set the lockout', '/etc/security/faillock.conf', conf([`deny = ${v.deny}`, `unlock_time = ${v.unlock}`, v.root ? 'even_deny_root' : null, 'audit', 'silent'])),
        T.copy('Describe the lockout for PAM', '/usr/share/pam-configs/faillock', 'Name: Lock accounts after wrong passwords (FleetPilot)\nDefault: yes\nPriority: 0\nAuth-Type: Primary\nAuth:\n\t[default=die]\tpam_faillock.so authfail\n', { notify: 'Update PAM' }),
        T.copy('Describe the lockout check for PAM', '/usr/share/pam-configs/faillock_notify', 'Name: Check the account lockout (FleetPilot)\nDefault: yes\nPriority: 1024\nAuth-Type: Primary\nAuth:\n\trequisite\tpam_faillock.so preauth\nAccount-Type: Primary\nAccount:\n\trequired\tpam_faillock.so\n', { notify: 'Update PAM' })
      ],
      handlers: { 'Update PAM': T.cmd('Update PAM', 'pam-auth-update --package --enable faillock faillock_notify') }
    }),
    summary: v => `${v.deny} attempts, ${Math.round(v.unlock / 60)} min`
  },
  {
    id: 'timeout', area: 'access', single: true, title: 'Idle shells',
    text: 'Ends idle shell sessions on the console and over SSH.',
    fields: [F.num('minutes', 'After (minutes, 0: never)', 15, [0, 1440])],
    tasks: v => ({ tasks: [T.copy('Set the idle time', '/etc/profile.d/fleetpilot-timeout.sh', conf(v.minutes ? [`TMOUT=${v.minutes * 60}`, 'readonly TMOUT', 'export TMOUT'] : []))] }),
    summary: v => v.minutes ? `${v.minutes} min` : 'Never'
  },
  {
    id: 'certlogin', area: 'access', single: true, title: 'Logins with SSH certificates',
    text: 'People sign in with a short-lived certificate from FleetPilot instead of keys copied to every host.',
    fields: [F.rows('logins', 'Who may log in as whom', [F.text('local', 'Local user', { pattern: 'user', required: true, placeholder: 'root' }), F.text('people', 'FleetPilot users', { pattern: 'word', placeholder: 'alice,bob' })])],
    tasks: v => ({
      tasks: [
        T.file('Make the folder for principals', { path: '/etc/ssh/auth_principals', state: 'directory', mode: '0755' }),
        ...v.logins.map(l => T.copy(`Let FleetPilot users log in as ${l.local}`, `/etc/ssh/auth_principals/${l.local}`, conf([...(l.local === 'fleetpilot' ? ['fleetpilot'] : []), ...l.people.split(',').filter(Boolean).map(p => `fp-${p.trim()}`)])))
      ]
    }),
    summary: v => v.logins.map(l => `${l.people || 'nobody'} as ${l.local}`).join(', ') || 'Nobody'
  },

  // ---------------------------------------------------------------- Packages
  {
    id: 'packages', area: 'packages', collect: { field: 'packages', key: 'name' }, title: 'Packages',
    text: 'Packages to install, keep up to date or remove.',
    fields: [F.rows('packages', 'Packages', [F.text('name', 'Package', { pattern: 'word', required: true, placeholder: 'htop' }), F.select('state', 'State', [['present', 'Installed'], ['latest', 'Always the newest'], ['absent', 'Removed']])])],
    tasks: v => {
      const by = s => v.packages.filter(p => p.state === s).map(p => p.name);
      return { tasks: [['present', 'Install'], ['latest', 'Update'], ['absent', 'Remove']].filter(([s]) => by(s).length).map(([s, verb]) => T.apt(by(s), s, `${verb} ${by(s).join(', ')}`)) };
    },
    summary: v => v.packages.map(p => p.state === 'absent' ? `no ${p.name}` : p.name).join(', ') || 'None'
  },
  {
    id: 'repos', area: 'packages', collect: { field: 'repos', key: 'name' }, title: 'Package sources',
    text: 'More apt repositories, each with its signing key.',
    fields: [F.rows('repos', 'Sources', [
      F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'docker' }), F.text('url', 'Address', { pattern: 'url', placeholder: 'https://download.docker.com/linux/debian' }),
      F.text('suite', 'Suite', { pattern: 'word', placeholder: 'Empty: the release of the host' }), F.text('components', 'Components', { pattern: 'any', default: 'main' }),
      F.text('key', 'Signing key', { pattern: 'url', placeholder: 'https://download.docker.com/linux/debian/gpg' })
    ])],
    tasks: v => ({
      tasks: [
        T.file('Make the folder for signing keys', { path: '/etc/apt/keyrings', state: 'directory', mode: '0755' }),
        ...v.repos.flatMap(r => [
          ...(r.key ? [{ name: `Download the signing key of ${r.name}`, 'ansible.builtin.get_url': { url: r.key, dest: `/etc/apt/keyrings/fp-${r.name}.asc`, mode: '0644' } }] : []),
          T.copy(`Add the source ${r.name}`, `/etc/apt/sources.list.d/fp-${r.name}.list`, conf([`deb [${r.key ? `signed-by=/etc/apt/keyrings/fp-${r.name}.asc ` : ''}arch={{ 'amd64' if ansible_facts.architecture == 'x86_64' else 'arm64' }}] ${r.url} ${r.suite || '{{ ansible_facts.distribution_release }}'} ${r.components}`]), { notify: 'Update the package lists' })
        ]),
        { name: 'Update the package lists now', 'ansible.builtin.meta': 'flush_handlers' }
      ],
      handlers: { 'Update the package lists': { name: 'Update the package lists', 'ansible.builtin.apt': { update_cache: true } } }
    }),
    summary: v => v.repos.map(r => r.name).join(', ') || 'None'
  },
  {
    id: 'unattended', area: 'packages', single: true, title: 'Automatic updates',
    text: 'Installs updates by itself every day (unattended-upgrades).',
    fields: [
      F.select('scope', 'Which updates', [['security', 'Security updates'], ['all', 'All updates of the release']]),
      F.bool('reboot', 'Reboot by itself when needed', false), F.text('rebootTime', 'At', { pattern: 'word', default: '03:30', when: { reboot: true } }),
      F.bool('removeUnused', 'Remove packages that are no longer needed', true)
    ],
    tasks: v => ({
      tasks: [T.apt(['unattended-upgrades', 'apt-listchanges']),
        T.copy('Switch on the daily updates', '/etc/apt/apt.conf.d/20auto-upgrades', conf(['APT::Periodic::Update-Package-Lists "1";', 'APT::Periodic::Unattended-Upgrade "1";'], '//')),
        T.copy('Choose the automatic updates', '/etc/apt/apt.conf.d/52fleetpilot-unattended', conf([
          'Unattended-Upgrade::Origins-Pattern {', '  "origin=Debian,codename=${distro_codename},label=Debian-Security";', '  "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";', '  "origin=Ubuntu,archive=${distro_codename}-security";',
          ...(v.scope === 'all' ? ['  "origin=Debian,codename=${distro_codename},label=Debian";', '  "origin=Debian,codename=${distro_codename}-updates";', '  "origin=Ubuntu,archive=${distro_codename}-updates";'] : []), '};',
          `Unattended-Upgrade::Automatic-Reboot "${v.reboot}";`, `Unattended-Upgrade::Automatic-Reboot-Time "${v.rebootTime}";`, `Unattended-Upgrade::Remove-Unused-Dependencies "${v.removeUnused}";`], '//'))]
    }),
    summary: v => `${v.scope === 'all' ? 'All' : 'Security'} updates${v.reboot ? `, reboot at ${v.rebootTime}` : ''}`
  },
  {
    id: 'holds', area: 'packages', collect: { field: 'packages', key: 'name' }, title: 'Held packages',
    text: 'Packages that keep their version until you release them.',
    fields: [F.rows('packages', 'Packages', [F.text('name', 'Package', { pattern: 'word', required: true, placeholder: 'postgresql-15' }), F.select('selection', 'State', [['hold', 'Held'], ['install', 'Released']])])],
    tasks: v => ({ tasks: v.packages.map(p => ({ name: `${p.selection === 'hold' ? 'Hold' : 'Release'} ${p.name}`, 'ansible.builtin.dpkg_selections': { name: p.name, selection: p.selection } })) }),
    summary: v => v.packages.filter(p => p.selection === 'hold').map(p => p.name).join(', ') || 'None'
  },

  // ---------------------------------------------------------------- Storage
  {
    id: 'mounts', area: 'storage', collect: { field: 'mounts', key: 'path' }, title: 'Mounts and shares',
    text: 'Disks, NFS and SMB shares, mounted at boot. SMB credentials come from the vault.',
    fields: [F.rows('mounts', 'Mounts', [
      F.text('path', 'Mount point', { pattern: 'path', required: true, placeholder: '/srv/data' }),
      F.select('type', 'Type', [['nfs', 'NFS'], ['cifs', 'SMB (CIFS)'], ['ext4', 'ext4'], ['xfs', 'XFS'], ['tmpfs', 'tmpfs'], ['none', 'Bind mount']]),
      F.text('source', 'Source', { pattern: 'any', placeholder: 'nas:/export/data, //nas/share or UUID=…' }),
      F.text('options', 'Options', { pattern: 'word', default: 'defaults', placeholder: 'defaults,_netdev' }),
      F.secret('credential', 'Login (SMB)', ['login'])
    ])],
    needs: v => v.mounts.filter(m => m.type === 'cifs' && m.credential).map(m => ({ type: 'secret', id: m.credential })),
    tasks: v => {
      const pk = [...new Set(v.mounts.map(m => ({ nfs: 'nfs-common', cifs: 'cifs-utils', xfs: 'xfsprogs' })[m.type]).filter(Boolean))];
      return {
        tasks: [
          ...(pk.length ? [T.apt(pk)] : []),
          ...v.mounts.flatMap(m => {
            const credFile = `/etc/fleetpilot/cifs-${slug(m.path)}.cred`;
            const opts = m.type === 'cifs' && m.credential ? `${m.options},credentials=${credFile}` : m.type === 'none' ? `bind,${m.options}` : m.options;
            return [
              ...(m.type === 'cifs' && m.credential ? [T.file('Make the folder for share logins', { path: '/etc/fleetpilot', state: 'directory', mode: '0700' }),
                T.copy(`Write the login for ${m.path}`, credFile, `username={{ fp_secret['${m.credential}'].username }}\npassword={{ fp_secret['${m.credential}'].password }}\n`, { mode: '0600', noLog: true })] : []),
              T.file(`Make the mount point ${m.path}`, { path: m.path, state: 'directory', mode: '0755' }),
              T.line(`Mount ${m.path} at boot`, { path: '/etc/fstab', regexp: `^\\S+\\s+${m.path.replace(/[.]/g, '\\.')}\\s`, line: `${m.source} ${m.path} ${m.type} ${opts} 0 ${['ext4', 'xfs'].includes(m.type) ? 2 : 0}` }),
              T.shell(`Mount ${m.path} now`, `findmnt -rn ${m.path} >/dev/null || mount ${m.path}`, { changed: false })
            ];
          })
        ]
      };
    },
    summary: v => v.mounts.map(m => m.path).join(', ') || 'None'
  },
  {
    id: 'logrotate', area: 'storage', collect: { field: 'rules', key: 'name' }, title: 'Log rotation',
    text: 'Rotates the logs of your own applications.',
    fields: [F.rows('rules', 'Rules', [
      F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'myapp' }), F.text('path', 'Files', { pattern: 'path', placeholder: '/var/log/myapp/*.log' }),
      F.select('every', 'Every', [['daily', 'Day'], ['weekly', 'Week'], ['monthly', 'Month']]), F.num('keep', 'Keep', 14, [1, 1000]), F.text('maxsize', 'Also when larger than', { pattern: 'duration', placeholder: '100M' })
    ])],
    tasks: v => ({ tasks: v.rules.map(r => T.copy(`Rotate the logs of ${r.name}`, `/etc/logrotate.d/fp-${r.name}`, conf([`${r.path} {`, `  ${r.every}`, `  rotate ${r.keep}`, r.maxsize ? `  maxsize ${r.maxsize}` : null, '  missingok', '  notifempty', '  compress', '  delaycompress', '  copytruncate', '}']))) }),
    summary: v => v.rules.map(r => r.name).join(', ') || 'None'
  },
  {
    id: 'lvm', area: 'storage', collect: { field: 'volumes', key: 'lv' }, title: 'Grow logical volumes',
    text: 'Grows LVM volumes and their filesystems into free space (never shrinks).',
    fields: [F.rows('volumes', 'Volumes', [F.text('lv', 'Volume', { pattern: 'path', required: true, placeholder: '/dev/vg0/root' }), F.text('size', 'To', { pattern: 'word', default: '+100%FREE', placeholder: '+100%FREE or 50G' })])],
    tasks: v => ({ tasks: v.volumes.map(x => T.shell(`Grow ${x.lv}`, `lvextend -r ${x.size.startsWith('+') && x.size.includes('%') ? `-l ${x.size}` : `-L ${x.size}`} ${x.lv} 2>&1 || true`, { changedWhen: "'successfully resized' in fp_out.stdout", register: 'fp_out' })) }),
    summary: v => v.volumes.map(x => `${x.lv} to ${x.size}`).join(', ') || 'None'
  },

  // ---------------------------------------------------------------- Security
  {
    id: 'firewall', area: 'security', single: true, title: 'Firewall',
    text: 'nftables: incoming connections only where allowed. Ports of the services in the desired state are opened by themselves, SSH always.',
    fields: [
      F.select('incoming', 'Incoming connections', [['drop', 'Only what is allowed'], ['accept', 'All (the firewall only logs)']]),
      F.lines('sshFrom', 'SSH from', { pattern: 'ipOrCidr', placeholder: 'Empty: from anywhere. 10.0.0.0/8' }),
      F.rows('allow', 'Also allow', [F.text('port', 'Port', { pattern: 'word', required: true, placeholder: '8080 or 8000-8100' }), F.select('proto', 'Protocol', [['tcp', 'TCP'], ['udp', 'UDP']]), F.text('from', 'From', { pattern: 'ipOrCidr', placeholder: 'any' })]),
      F.bool('ping', 'Answer ping', true),
      F.bool('forward', 'Let traffic pass through (routers, containers)', true)
    ],
    tasks: (v, ctx) => {
      // One rule per address family; "any" or nothing means from everywhere
      const rule = (from, match, comment) => {
        const list = [].concat(from || []).filter(f => f && f !== 'any');
        const v4 = list.filter(x => !x.includes(':')), v6 = list.filter(x => x.includes(':'));
        const srcs = list.length ? [v4.length && `ip saddr { ${v4.join(', ')} }`, v6.length && `ip6 saddr { ${v6.join(', ')} }`].filter(Boolean) : [''];
        return srcs.map(src => '    ' + [src, match, 'accept', comment ? `comment ${quote(comment)}` : ''].filter(Boolean).join(' '));
      };
      const sshPorts = [...new Set((ctx.ports || []).filter(p => p.ssh).map(p => p.port).concat(ctx.sshPort || 22))];
      const rules = [
        ...sshPorts.flatMap(p => rule(v.sshFrom, `tcp dport ${p}`, 'SSH')),
        ...(ctx.ports || []).filter(p => !p.ssh).flatMap(p => rule(p.from, p.raw || `${p.proto} dport ${p.port}`, p.label)),
        ...v.allow.flatMap(a => rule(a.from, `${a.proto} dport ${a.port}`))
      ];
      const text = conf([
        '# Only the table of FleetPilot: Docker and other tools keep their own',
        'table inet fleetpilot',
        'delete table inet fleetpilot',
        'table inet fleetpilot {',
        '  chain input {',
        `    type filter hook input priority filter; policy ${v.incoming};`,
        '    ct state established,related accept',
        '    ct state invalid drop',
        '    iif lo accept',
        ...(v.ping ? ['    meta l4proto icmp accept', '    meta l4proto ipv6-icmp accept'] : ['    meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept']),
        ...rules,
        v.incoming === 'accept' ? '    log prefix "fleetpilot-in " level info' : null,
        '  }',
        '  chain forward {',
        `    type filter hook forward priority filter; policy ${v.forward ? 'accept' : 'drop'};`,
        '  }',
        '}'
      ]);
      return {
        tasks: [
          T.apt(['nftables']),
          T.copy('Write the firewall rules', '/etc/nftables.conf', text.startsWith('#') ? `#!/usr/sbin/nft -f\n${text}` : text, { mode: '0755', validate: 'nft -c -f %s', notify: 'Load the firewall rules' }),
          T.service('nftables')
        ],
        handlers: { 'Load the firewall rules': T.cmd('Load the firewall rules', 'nft -f /etc/nftables.conf') }
      };
    },
    summary: v => `${v.incoming === 'drop' ? 'Only allowed connections' : 'All connections, logged'}${v.allow.length ? `, ${plural(v.allow.length, 'extra rule', 'extra rules')}` : ''}`
  },
  {
    id: 'fail2ban', area: 'security', single: true, title: 'Ban attackers (fail2ban)',
    text: 'Bans addresses that try too many wrong logins over SSH.',
    fields: [F.num('maxretry', 'Wrong logins', 5, [1, 100]), F.num('findtime', 'Within (minutes)', 10, [1, 1440]), F.num('bantime', 'Ban for (minutes)', 60, [1, 525600]), F.lines('ignore', 'Never ban', { pattern: 'ipOrCidr', placeholder: '10.0.0.0/8' })],
    tasks: v => ({
      tasks: [T.apt(['fail2ban', 'python3-systemd']),
        T.copy('Configure fail2ban', '/etc/fail2ban/jail.d/fleetpilot.local', conf(['[DEFAULT]', `bantime = ${v.bantime}m`, `findtime = ${v.findtime}m`, `maxretry = ${v.maxretry}`, `ignoreip = 127.0.0.1/8 ::1 ${v.ignore.join(' ')}`.trim(), 'banaction = nftables', '', '[sshd]', 'enabled = true', 'backend = systemd']), { notify: 'Restart fail2ban' }),
        T.service('fail2ban')],
      handlers: { 'Restart fail2ban': T.restart('fail2ban') }
    }),
    summary: v => `${v.maxretry} tries in ${v.findtime} min, ban for ${v.bantime} min`
  },
  {
    id: 'hardening', area: 'security', single: true, title: 'Hardening',
    text: 'Common hardening measures for the kernel and the system. Each one can be switched off.',
    fields: [
      F.bool('coredumps', 'No core dumps', true), F.bool('dmesg', 'Only root reads kernel messages', true), F.bool('kptr', 'Hide kernel addresses', true),
      F.bool('ptrace', 'Processes may only debug their own children', true), F.bool('redirects', 'Ignore ICMP redirects and source routes', true),
      F.bool('syncookies', 'SYN cookies against floods', true), F.bool('martians', 'Log impossible addresses', false), F.bool('rpfilter', 'Drop packets with spoofed sources', true),
      F.bool('filesystems', 'Block rare filesystems (cramfs, hfs, udf, …)', true), F.bool('usb', 'Block USB storage', false), F.bool('umask', 'New files private by default (umask 027)', false)
    ],
    tasks: v => ({
      tasks: [
        T.copy('Write the kernel hardening', '/etc/sysctl.d/92-fleetpilot-hardening.conf', conf([
          v.coredumps ? 'fs.suid_dumpable = 0\nkernel.core_pattern = |/bin/false' : null, v.dmesg ? 'kernel.dmesg_restrict = 1' : null, v.kptr ? 'kernel.kptr_restrict = 2' : null,
          v.ptrace ? 'kernel.yama.ptrace_scope = 1' : null,
          v.redirects ? 'net.ipv4.conf.all.accept_redirects = 0\nnet.ipv4.conf.default.accept_redirects = 0\nnet.ipv4.conf.all.send_redirects = 0\nnet.ipv4.conf.all.accept_source_route = 0\nnet.ipv6.conf.all.accept_redirects = 0\nnet.ipv6.conf.default.accept_redirects = 0' : null,
          v.syncookies ? 'net.ipv4.tcp_syncookies = 1' : null, v.martians ? 'net.ipv4.conf.all.log_martians = 1' : null, v.rpfilter ? 'net.ipv4.conf.all.rp_filter = 1\nnet.ipv4.conf.default.rp_filter = 1' : null
        ]), { notify: 'Apply kernel settings' }),
        T.copy('Limit core dumps', '/etc/security/limits.d/fleetpilot.conf', conf(v.coredumps ? ['* hard core 0'] : [])),
        T.file('Make the folder for module rules', { path: '/etc/modprobe.d', state: 'directory', mode: '0755' }),
        T.copy('Block rare filesystems and USB storage', '/etc/modprobe.d/fleetpilot-hardening.conf', conf([
          ...(v.filesystems ? ['cramfs', 'freevxfs', 'hfs', 'hfsplus', 'jffs2', 'udf'] : []).map(m => `install ${m} /bin/false`), v.usb ? 'install usb-storage /bin/false' : null])),
        T.line('Set the default umask', { path: '/etc/login.defs', regexp: '^UMASK\\s', line: `UMASK\t\t${v.umask ? '027' : '022'}` })
      ],
      handlers: H.sysctl
    }),
    summary: v => `${Object.values(v).filter(x => x === true).length} measures`
  },
  {
    id: 'apparmor', area: 'security', single: true, title: 'AppArmor',
    text: 'Confines programs to what their profiles allow.',
    fields: [F.bool('enabled', 'On', true), F.bool('extra', 'Install the extra profiles', false)],
    tasks: v => ({ tasks: v.enabled ? [T.apt(['apparmor', 'apparmor-utils', ...(v.extra ? ['apparmor-profiles', 'apparmor-profiles-extra'] : [])]), T.service('apparmor')] : [T.service('apparmor', { state: 'stopped', enabled: false, name: 'Switch AppArmor off' })] }),
    summary: v => v.enabled ? 'On' : 'Off'
  },
  {
    id: 'auditd', area: 'security', single: true, title: 'Auditing (auditd)',
    text: 'Records logins, changes to accounts, sudo and changes to system files.',
    fields: [F.bool('identity', 'Changes to users, groups and passwords', true), F.bool('sudoers', 'Changes to sudo rules', true), F.bool('sshd', 'Changes to the SSH configuration', true), F.bool('modules', 'Loading kernel modules', true), F.bool('time', 'Changes to the clock', true), F.area('custom', 'Own rules', { raw: true, placeholder: '-w /etc/myapp/ -p wa -k myapp' })],
    tasks: v => ({
      tasks: [T.apt(['auditd']),
        T.copy('Write the audit rules', '/etc/audit/rules.d/50-fleetpilot.rules', conf([
          v.identity ? '-w /etc/passwd -p wa -k identity\n-w /etc/group -p wa -k identity\n-w /etc/shadow -p wa -k identity\n-w /etc/gshadow -p wa -k identity' : null,
          v.sudoers ? '-w /etc/sudoers -p wa -k sudoers\n-w /etc/sudoers.d/ -p wa -k sudoers' : null, v.sshd ? '-w /etc/ssh/sshd_config -p wa -k sshd\n-w /etc/ssh/sshd_config.d/ -p wa -k sshd' : null,
          v.modules ? '-w /sbin/insmod -p x -k modules\n-w /sbin/modprobe -p x -k modules\n-a always,exit -F arch=b64 -S init_module,finit_module,delete_module -k modules' : null,
          v.time ? '-a always,exit -F arch=b64 -S adjtimex,settimeofday,clock_settime -k time\n-w /etc/localtime -p wa -k time' : null,
          ...String(v.custom || '').split('\n').filter(l => /^-[wa]\s/.test(l.trim())).map(l => l.trim())
        ]), { mode: '0640', notify: 'Load the audit rules' }), T.service('auditd')],
      handlers: { 'Load the audit rules': T.cmd('Load the audit rules', 'augenrules --load') }
    }),
    summary: v => `${['identity', 'sudoers', 'sshd', 'modules', 'time'].filter(k => v[k]).length} areas${v.custom ? ' and own rules' : ''}`
  },
  {
    id: 'tls', area: 'security', collect: { field: 'certs', key: 'name' }, title: 'TLS certificates',
    text: 'Certificates and their keys from the vault, written where services find them.',
    fields: [F.rows('certs', 'Certificates', [F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'www' }), F.secret('secret', 'Certificate in the vault', ['tls']), F.text('dir', 'Folder', { pattern: 'path', default: '/etc/ssl/fleetpilot' })])],
    needs: v => v.certs.filter(c => c.secret).map(c => ({ type: 'secret', id: c.secret })),
    tasks: v => ({
      tasks: v.certs.filter(c => c.secret).flatMap(c => [
        T.file(`Make the folder ${c.dir}`, { path: c.dir, state: 'directory', mode: '0755' }),
        T.copy(`Write the certificate ${c.name}`, `${c.dir}/${c.name}.crt`, `{{ fp_secret['${c.secret}'].certificate }}`, { mode: '0644' }),
        T.copy(`Write the key of ${c.name}`, `${c.dir}/${c.name}.key`, `{{ fp_secret['${c.secret}'].key }}`, { mode: '0600', noLog: true })
      ])
    }),
    summary: v => v.certs.map(c => c.name).join(', ') || 'None'
  },
  {
    id: 'cas', area: 'security', collect: { field: 'cas', key: 'name' }, title: 'Trusted certificate authorities',
    text: 'Your own certificate authorities, trusted by the whole system.',
    fields: [F.rows('cas', 'Authorities', [F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'company-root' }), F.area('pem', 'Certificate (PEM)', { raw: true, placeholder: '-----BEGIN CERTIFICATE-----' })])],
    tasks: v => ({
      tasks: [T.apt(['ca-certificates']), ...v.cas.filter(c => /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(c.pem.trim()))
        .map(c => T.copy(`Trust ${c.name}`, `/usr/local/share/ca-certificates/fp-${c.name}.crt`, c.pem.trim() + '\n', { notify: 'Update the trusted authorities' }))],
      handlers: { 'Update the trusted authorities': T.cmd('Update the trusted authorities', 'update-ca-certificates') }
    }),
    summary: v => v.cas.map(c => c.name).join(', ') || 'None'
  },

  // ---------------------------------------------------------------- Monitoring
  {
    id: 'snmp', area: 'monitoring', single: true, title: 'SNMP agent',
    text: 'snmpd for your monitoring system: SNMPv3 with a user and passwords from the vault, or a read-only v2c community.',
    fields: [
      F.select('version', 'Version', [['v3', 'SNMPv3 (encrypted)'], ['v2c', 'v2c (community, not encrypted)']]),
      F.text('user', 'v3 user', { pattern: 'name', default: 'monitor', when: { version: 'v3' } }),
      F.text('community', 'Community', { pattern: 'name', default: 'public', when: { version: 'v2c' } }),
      F.lines('from', 'Allowed from', { pattern: 'cidr', placeholder: '10.0.0.0/8' }),
      F.text('location', 'Location', { pattern: 'any', placeholder: 'Rack 4, Datacenter 1' }), F.text('contact', 'Contact', { pattern: 'any', placeholder: 'ops@example.com' })
    ],
    needs: v => v.version === 'v3' ? [{ type: 'shared', key: `snmp:${v.user}:auth`, label: `SNMP ${v.user} authentication` }, { type: 'shared', key: `snmp:${v.user}:priv`, label: `SNMP ${v.user} privacy` }] : [],
    tasks: v => ({
      tasks: [T.apt(['snmpd']),
        T.copy('Configure the SNMP agent', '/etc/snmp/snmpd.conf', conf([
          'agentAddress udp:161,udp6:[::1]:161', `sysLocation ${v.location || 'unknown'}`, `sysContact ${v.contact || 'unknown'}`,
          ...(v.version === 'v3' ? [`createUser ${v.user} SHA-256 "{{ fp_shared['snmp:${v.user}:auth'] }}" AES "{{ fp_shared['snmp:${v.user}:priv'] }}"`, `rouser ${v.user} priv`]
            : (v.from.length ? v.from : ['127.0.0.1/32']).map(n => `rocommunity ${v.community} ${n}`))
        ]), { mode: '0600', noLog: true, notify: 'Restart snmpd' }), T.service('snmpd')],
      handlers: { 'Restart snmpd': T.restart('snmpd') }
    }),
    ports: v => [{ port: 161, proto: 'udp', from: v.from, label: 'SNMP' }],
    summary: v => v.version === 'v3' ? `SNMPv3 user ${v.user}` : `v2c, community ${v.community}`
  },
  {
    id: 'syslog', area: 'monitoring', single: true, title: 'Log forwarding',
    text: 'Sends the logs to a central log server (rsyslog).',
    fields: [F.text('target', 'Log server', { pattern: 'host', required: true, placeholder: 'logs.example.com' }), F.num('port', 'Port', 514, [1, 65535]), F.select('proto', 'Protocol', [['udp', 'UDP'], ['tcp', 'TCP']]), F.select('level', 'From level', [['*', 'Everything'], ['info', 'Info'], ['notice', 'Notice'], ['warning', 'Warning'], ['err', 'Error']])],
    tasks: v => ({
      tasks: [T.apt(['rsyslog']), T.copy('Forward the logs', '/etc/rsyslog.d/90-fleetpilot-forward.conf', conf([`*.${v.level} action(type="omfwd" target=${quote(v.target)} port="${v.port}" protocol="${v.proto}" queue.type="LinkedList" queue.size="10000" action.resumeRetryCount="-1")`]), { notify: 'Restart rsyslog' }), T.service('rsyslog')],
      handlers: { 'Restart rsyslog': T.restart('rsyslog') }
    }),
    summary: v => `${v.target}:${v.port} (${v.proto})`
  },
  {
    id: 'smart', area: 'monitoring', single: true, title: 'Disk health (SMART)',
    text: 'Watches physical disks and logs signs of failure. Not useful on virtual machines.',
    fields: [F.bool('enabled', 'On', true)],
    tasks: v => ({ tasks: v.enabled ? [T.apt(['smartmontools']), T.service('smartmontools')] : [] }),
    summary: v => v.enabled ? 'On' : 'Off'
  },

  // ---------------------------------------------------------------- Schedules
  {
    id: 'cron', area: 'schedules', collect: { field: 'jobs', key: 'name' }, title: 'Cron jobs',
    text: 'Commands that run at fixed times.',
    fields: [F.rows('jobs', 'Jobs', [
      F.text('name', 'Name', { pattern: 'any', required: true, placeholder: 'Clean old exports' }), F.text('schedule', 'When', { pattern: 'cron', default: '0 3 * * *', placeholder: '0 3 * * *' }),
      F.text('user', 'As', { pattern: 'user', default: 'root' }), F.text('command', 'Command', { pattern: 'any', maxLength: 2000, placeholder: 'find /srv/exports -mtime +30 -delete' }),
      F.select('state', 'State', [['present', 'Present'], ['absent', 'Removed']])
    ])],
    tasks: v => ({
      tasks: v.jobs.map(j => {
        const special = j.schedule.startsWith('@') ? j.schedule.slice(1) : null;
        const [minute, hour, day, month, weekday] = special ? [] : j.schedule.split(/\s+/);
        return { name: `${j.state === 'absent' ? 'Remove' : 'Schedule'} "${j.name}"`, 'ansible.builtin.cron': { name: `FleetPilot: ${j.name}`, user: j.user, job: j.command, state: j.state, ...(special ? { special_time: special } : { minute, hour, day, month, weekday }) } };
      })
    }),
    summary: v => v.jobs.map(j => j.name).join(', ') || 'None'
  },
  {
    id: 'timers', area: 'schedules', collect: { field: 'timers', key: 'name' }, title: 'systemd timers',
    text: 'Commands that run on a calendar, with their output in the journal.',
    fields: [F.rows('timers', 'Timers', [
      F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'backup' }), F.text('when', 'When', { pattern: 'any', default: 'daily', placeholder: 'daily, Mon *-*-* 03:00 or *:0/15' }),
      F.text('user', 'As', { pattern: 'user', default: 'root' }), F.text('command', 'Command', { pattern: 'any', maxLength: 2000, placeholder: '/usr/local/bin/backup.sh' })
    ])],
    tasks: v => ({
      tasks: v.timers.flatMap(t => [
        T.copy(`Describe the job ${t.name}`, `/etc/systemd/system/fp-${t.name}.service`, conf(['[Unit]', `Description=FleetPilot: ${t.name}`, '', '[Service]', 'Type=oneshot', `User=${t.user}`, `ExecStart=/bin/sh -c ${quote(t.command)}`]), { notify: 'Reload systemd' }),
        T.copy(`Schedule ${t.name}`, `/etc/systemd/system/fp-${t.name}.timer`, conf(['[Unit]', `Description=FleetPilot: ${t.name}`, '', '[Timer]', `OnCalendar=${t.when}`, 'Persistent=true', '', '[Install]', 'WantedBy=timers.target']), { notify: 'Reload systemd' }),
        { name: 'Reload systemd for the new timer', 'ansible.builtin.meta': 'flush_handlers' },
        T.service(`fp-${t.name}.timer`, { name: `Start the timer ${t.name}` })
      ]),
      handlers: H.daemon
    }),
    summary: v => v.timers.map(t => `${t.name} (${t.when})`).join(', ') || 'None'
  },

  // ---------------------------------------------------------------- Files
  {
    id: 'files', area: 'files', collect: { field: 'files', key: 'path' }, title: 'Files',
    text: 'Files with the content you write. FleetPilot variables are filled in only when you choose so.',
    fields: [F.rows('files', 'Files', [
      F.text('path', 'Path', { pattern: 'path', required: true, placeholder: '/etc/myapp/config.ini' }), F.area('content', 'Content', { raw: true, placeholder: 'key = value' }),
      F.text('owner', 'Owner', { pattern: 'user', default: 'root' }), F.text('group', 'Group', { pattern: 'user', default: 'root' }), F.text('mode', 'Mode', { pattern: 'octal', default: '0644' }),
      F.bool('variables', 'Fill in {{ fp_… }} variables', false)
    ])],
    unsafe: true,
    tasks: v => ({
      tasks: v.files.map(f => ({ name: `Write ${f.path}`, 'ansible.builtin.copy': { dest: f.path, content: f.variables ? f.content : { __unsafe: f.content }, owner: f.owner, group: f.group, mode: f.mode } }))
    }),
    summary: v => v.files.map(f => f.path).join(', ') || 'None'
  },
  {
    id: 'dirs', area: 'files', collect: { field: 'dirs', key: 'path' }, title: 'Folders',
    text: 'Folders with their owner and mode.',
    fields: [F.rows('dirs', 'Folders', [F.text('path', 'Path', { pattern: 'path', required: true, placeholder: '/srv/app' }), F.text('owner', 'Owner', { pattern: 'user', default: 'root' }), F.text('group', 'Group', { pattern: 'user', default: 'root' }), F.text('mode', 'Mode', { pattern: 'octal', default: '0755' }), F.select('state', 'State', [['directory', 'Present'], ['absent', 'Removed']])])],
    tasks: v => ({ tasks: v.dirs.map(d => T.file(`${d.state === 'absent' ? 'Remove' : 'Make'} ${d.path}`, d.state === 'absent' ? { path: d.path, state: 'absent' } : { path: d.path, state: 'directory', owner: d.owner, group: d.group, mode: d.mode })) }),
    summary: v => v.dirs.map(d => d.path).join(', ') || 'None'
  },
  {
    id: 'lines', area: 'files', collect: { field: 'lines', key: 'line' }, title: 'Lines in files',
    text: 'Makes sure a line is in a file (or is not), replacing the line that matches a pattern.',
    fields: [F.rows('lines', 'Lines', [F.text('path', 'File', { pattern: 'path', required: true, placeholder: '/etc/default/grub' }), F.text('match', 'Replaces the line matching', { pattern: 'any', placeholder: '^GRUB_TIMEOUT=' }), F.text('line', 'Line', { pattern: 'any', required: true, placeholder: 'GRUB_TIMEOUT=2' }), F.select('state', 'State', [['present', 'Present'], ['absent', 'Removed']])])],
    tasks: v => ({ tasks: v.lines.map(l => T.line(`${l.state === 'absent' ? 'Remove a line from' : 'Set a line in'} ${l.path}`, { path: l.path, line: l.line, state: l.state, create: l.state === 'present', ...(l.match ? { regexp: l.match } : {}) })) }),
    summary: v => plural(v.lines.length, 'line', 'lines')
  },
  {
    id: 'downloads', area: 'files', collect: { field: 'downloads', key: 'dest' }, title: 'Downloads',
    text: 'Files downloaded from an address, checked against a checksum when you give one.',
    fields: [F.rows('downloads', 'Downloads', [F.text('url', 'From', { pattern: 'url', required: true }), F.text('dest', 'To', { pattern: 'path', required: true, placeholder: '/usr/local/bin/tool' }), F.text('checksum', 'Checksum', { pattern: 'word', placeholder: 'sha256:…' }), F.text('mode', 'Mode', { pattern: 'octal', default: '0644' })])],
    tasks: v => ({ tasks: v.downloads.map(d => ({ name: `Download ${d.dest}`, 'ansible.builtin.get_url': { url: d.url, dest: d.dest, mode: d.mode, ...(d.checksum ? { checksum: d.checksum } : {}) } })) }),
    summary: v => v.downloads.map(d => d.dest).join(', ') || 'None'
  },
  {
    id: 'commands', area: 'files', collect: { field: 'commands', key: 'name' }, title: 'Commands',
    text: 'A command for what nothing else covers. It runs once when you name a file it creates, otherwise every time.',
    fields: [F.rows('commands', 'Commands', [F.text('name', 'Name', { pattern: 'any', required: true, placeholder: 'Initialize the app' }), F.area('command', 'Command (sh)', { placeholder: '/opt/app/setup.sh --init' }), F.text('creates', 'Runs only when this file is missing', { pattern: 'path', placeholder: '/opt/app/.initialized' })])],
    tasks: v => ({ tasks: v.commands.map(c => T.shell(c.name, c.command, { creates: c.creates || undefined })) }),
    summary: v => v.commands.map(c => c.name).join(', ') || 'None'
  },
  {
    id: 'remove', area: 'files', collect: { field: 'paths', key: 'path' }, title: 'Removed files',
    text: 'Files and folders that must not exist.',
    fields: [F.rows('paths', 'Paths', [F.text('path', 'Path', { pattern: 'path', required: true, placeholder: '/etc/cron.d/old-job' })])],
    tasks: v => ({ tasks: v.paths.map(p => T.file(`Remove ${p.path}`, { path: p.path, state: 'absent' })) }),
    summary: v => v.paths.map(p => p.path).join(', ') || 'None'
  }
];
