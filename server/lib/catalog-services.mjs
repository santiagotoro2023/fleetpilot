// FleetPilot: the service catalog. Each service is a setting of the area "services": packages,
// its configuration from a form, the service started, and the ports it needs (the firewall of the
// desired state opens them by itself).
import { T, F, conf, quote } from './catalog.mjs';
import { toYaml } from './yaml.mjs';

const lines = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const portOf = (listen, def) => Number(String(listen || '').split(':').pop()) || def;

/**
 * A service: packages, files (each { dest, content, mode, validate, noLog }), the unit to run,
 * a handler that restarts (or reloads) it, ports, and optional extra tasks before or after.
 */
function service(d) {
  return {
    id: d.id, area: 'services', single: true, title: d.title, text: d.text, fields: d.fields || [], needs: d.needs, summary: d.summary,
    group: d.group,
    ports: d.ports || (() => []),
    tasks: (v, ctx) => {
      const unit = typeof d.unit === 'function' ? d.unit(v) : d.unit;
      const handler = d.reload ? `Reload ${unit}` : `Restart ${unit}`;
      const files = d.files ? d.files(v, ctx) : [];
      return {
        tasks: [
          ...(d.before ? d.before(v, ctx) : []),
          T.apt(typeof d.packages === 'function' ? d.packages(v) : d.packages, 'present', `Install ${d.title}`),
          ...files.map(f => f.dir
            ? T.file(f.name || `Make ${f.dest}`, { path: f.dest, state: 'directory', mode: f.mode || '0755', owner: f.owner || 'root', group: f.group || 'root' })
            : T.copy(f.name || `Write ${f.dest}`, f.dest, f.content, { mode: f.mode, owner: f.owner, group: f.group, validate: f.validate, noLog: f.noLog, notify: unit ? handler : undefined })),
          ...(d.after ? d.after(v, ctx) : []),
          ...(unit ? [{ ...T.service(unit), ...(d.startWhen ? { when: d.startWhen } : {}) }] : [])
        ],
        handlers: unit ? { [handler]: d.check ? [T.cmd(`Check the configuration of ${d.title}`, d.check), d.reload ? T.reload(unit) : T.restart(unit)] : d.reload ? T.reload(unit) : T.restart(unit) } : {}
      };
    }
  };
}

export const SERVICES = [
  // ---------------------------------------------------------------- Web and proxies
  service({
    id: 'nginx', group: 'Web and proxies', title: 'nginx', text: 'Web server and reverse proxy, with one site per row.',
    packages: ['nginx'], unit: 'nginx', reload: true, check: 'nginx -t',
    fields: [
      F.rows('sites', 'Sites', [
        F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'www' }), F.text('names', 'Host names', { pattern: 'any', placeholder: 'www.example.com example.com' }),
        F.num('port', 'Port', 80, [1, 65535]), F.text('root', 'Files from', { pattern: 'path', placeholder: '/var/www/html' }),
        F.text('proxy', 'Or pass on to', { pattern: 'url', placeholder: 'http://127.0.0.1:3000' }), F.text('tls', 'TLS certificate name', { pattern: 'name', placeholder: 'www (from TLS certificates)' })
      ]),
      F.bool('removeDefault', 'Remove the default site', true)
    ],
    files: v => v.sites.flatMap(s => [{ dest: `/etc/nginx/sites-available/fp-${s.name}.conf`, content: conf([
      'server {', `    listen ${s.tls ? `${s.port === 80 ? 443 : s.port} ssl` : s.port};`, `    listen [::]:${s.tls ? `${s.port === 80 ? 443 : s.port} ssl` : s.port};`,
      `    server_name ${s.names || '_'};`,
      s.tls ? `    ssl_certificate /etc/ssl/fleetpilot/${s.tls}.crt;\n    ssl_certificate_key /etc/ssl/fleetpilot/${s.tls}.key;\n    ssl_protocols TLSv1.2 TLSv1.3;` : null,
      s.proxy ? `    location / {\n        proxy_pass ${s.proxy};\n        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n    }`
        : `    root ${s.root || '/var/www/html'};\n    index index.html;\n    location / {\n        try_files $uri $uri/ =404;\n    }`,
      '}',
      s.tls && s.port === 80 ? `server {\n    listen 80;\n    listen [::]:80;\n    server_name ${s.names || '_'};\n    return 301 https://$host$request_uri;\n}` : null
    ]) }]),
    after: v => [
      ...v.sites.map(s => T.file(`Switch on the site ${s.name}`, { src: `/etc/nginx/sites-available/fp-${s.name}.conf`, dest: `/etc/nginx/sites-enabled/fp-${s.name}.conf`, state: 'link' }, { notify: 'Reload nginx' })),
      ...(v.removeDefault ? [T.file('Remove the default site', { path: '/etc/nginx/sites-enabled/default', state: 'absent' }, { notify: 'Reload nginx' })] : [])
    ],
    ports: v => v.sites.flatMap(s => s.tls ? [{ port: s.port === 80 ? 443 : s.port, proto: 'tcp', label: 'nginx' }, ...(s.port === 80 ? [{ port: 80, proto: 'tcp', label: 'nginx' }] : [])] : [{ port: s.port, proto: 'tcp', label: 'nginx' }]),
    summary: v => v.sites.length ? v.sites.map(s => s.names || s.name).join(', ') : 'No sites'
  }),
  service({
    id: 'apache', group: 'Web and proxies', title: 'Apache', text: 'The Apache web server with name-based sites.',
    packages: ['apache2'], unit: 'apache2', reload: true, check: 'apache2ctl configtest',
    fields: [F.rows('sites', 'Sites', [F.text('name', 'Name', { pattern: 'name', required: true }), F.text('names', 'Host names', { pattern: 'any', placeholder: 'www.example.com' }), F.num('port', 'Port', 80, [1, 65535]), F.text('root', 'Files from', { pattern: 'path', placeholder: '/var/www/html' }), F.text('proxy', 'Or pass on to', { pattern: 'url' })])],
    files: v => v.sites.map(s => ({ dest: `/etc/apache2/sites-available/fp-${s.name}.conf`, content: conf([
      s.port !== 80 ? `Listen ${s.port}` : null, `<VirtualHost *:${s.port}>`, `    ServerName ${(s.names || 'localhost').split(' ')[0]}`, s.names.split(' ').length > 1 ? `    ServerAlias ${s.names.split(' ').slice(1).join(' ')}` : null,
      s.proxy ? `    ProxyPreserveHost On\n    ProxyPass / ${s.proxy}/\n    ProxyPassReverse / ${s.proxy}/` : `    DocumentRoot ${s.root || '/var/www/html'}`, '</VirtualHost>']) })),
    after: v => [
      ...(v.sites.some(s => s.proxy) ? ['proxy', 'proxy_http'].map(m => T.cmd(`Switch on the module ${m}`, `a2enmod ${m}`, { creates: `/etc/apache2/mods-enabled/${m}.load` })) : []),
      ...v.sites.map(s => T.file(`Switch on the site ${s.name}`, { src: `/etc/apache2/sites-available/fp-${s.name}.conf`, dest: `/etc/apache2/sites-enabled/fp-${s.name}.conf`, state: 'link' }, { notify: 'Reload apache2' }))
    ],
    ports: v => v.sites.map(s => ({ port: s.port, proto: 'tcp', label: 'Apache' })),
    summary: v => v.sites.map(s => s.names || s.name).join(', ') || 'No sites'
  }),
  service({
    id: 'haproxy', group: 'Web and proxies', title: 'HAProxy', text: 'Load balancer for HTTP and TCP, with health checks.',
    packages: ['haproxy'], unit: 'haproxy', reload: true,
    fields: [
      F.rows('frontends', 'Frontends', [F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'web' }), F.num('port', 'Port', 80, [1, 65535]), F.select('mode', 'Mode', [['http', 'HTTP'], ['tcp', 'TCP']]), F.text('servers', 'Servers', { pattern: 'word', placeholder: '10.0.0.11:8080,10.0.0.12:8080' }), F.select('balance', 'Balance', [['roundrobin', 'In turn'], ['leastconn', 'Fewest connections'], ['source', 'By client address']])]),
      F.num('stats', 'Statistics page on port (0: none)', 0, [0, 65535])
    ],
    files: v => [{ dest: '/etc/haproxy/haproxy.cfg', validate: 'haproxy -c -f %s', content: conf([
      'global', '    log /dev/log local0', '    maxconn 20000', '    user haproxy', '    group haproxy', '    daemon', '',
      'defaults', '    log global', '    option dontlognull', '    timeout connect 5s', '    timeout client 60s', '    timeout server 60s',
      ...v.frontends.flatMap(f => ['', `frontend ${f.name}`, `    bind :${f.port}`, `    mode ${f.mode}`, f.mode === 'http' ? '    option httplog\n    option forwardfor' : '    option tcplog', `    default_backend ${f.name}-servers`, '',
        `backend ${f.name}-servers`, `    mode ${f.mode}`, `    balance ${f.balance}`, ...lines(f.servers).map((s, i) => `    server s${i + 1} ${s} check`)]),
      ...(v.stats ? ['', 'listen stats', `    bind :${v.stats}`, '    mode http', '    stats enable', '    stats uri /'] : [])
    ]) }],
    ports: v => [...v.frontends.map(f => ({ port: f.port, proto: 'tcp', label: 'HAProxy' })), ...(v.stats ? [{ port: v.stats, proto: 'tcp', label: 'HAProxy statistics' }] : [])],
    summary: v => v.frontends.map(f => `${f.name} :${f.port}`).join(', ') || 'No frontends'
  }),
  service({
    id: 'caddy', group: 'Web and proxies', title: 'Caddy', text: 'Web server that gets its own certificates from Let\'s Encrypt.',
    packages: ['caddy'], unit: 'caddy', reload: true, check: 'caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile',
    fields: [F.text('email', 'E-mail for Let\'s Encrypt', { pattern: 'any', placeholder: 'ops@example.com' }), F.rows('sites', 'Sites', [F.text('address', 'Address', { pattern: 'any', required: true, placeholder: 'www.example.com' }), F.text('proxy', 'Pass on to', { pattern: 'any', placeholder: '127.0.0.1:3000' }), F.text('root', 'Or files from', { pattern: 'path' })])],
    files: v => [{ dest: '/etc/caddy/Caddyfile', content: conf([v.email ? `{\n    email ${v.email}\n}` : null, ...v.sites.map(s => `${s.address} {\n    ${s.proxy ? `reverse_proxy ${s.proxy}` : `root * ${s.root || '/var/www/html'}\n    file_server`}\n}`)]) }],
    ports: () => [{ port: 80, proto: 'tcp', label: 'Caddy' }, { port: 443, proto: 'tcp', label: 'Caddy' }],
    summary: v => v.sites.map(s => s.address).join(', ') || 'No sites'
  }),
  service({
    id: 'squid', group: 'Web and proxies', title: 'Squid', text: 'A forward proxy for the networks you name.',
    packages: ['squid'], unit: 'squid', check: 'squid -k parse',
    fields: [F.num('port', 'Port', 3128, [1, 65535]), F.lines('allow', 'Networks that may use it', { pattern: 'cidr', placeholder: '10.0.0.0/8' })],
    files: v => [{ dest: '/etc/squid/conf.d/fleetpilot.conf', content: conf([`http_port ${v.port}`, ...v.allow.map((n, i) => `acl fp_net${i} src ${n}`), ...v.allow.map((n, i) => `http_access allow fp_net${i}`)]) }],
    ports: v => [{ port: v.port, proto: 'tcp', from: v.allow, label: 'Squid' }],
    summary: v => `Port ${v.port} for ${v.allow.join(', ') || 'nobody yet'}`
  }),

  // ---------------------------------------------------------------- Containers
  service({
    id: 'docker', group: 'Containers', title: 'Docker', text: 'Docker Engine with Compose, from Debian or from Docker\'s own repository.',
    packages: v => v.source === 'docker' ? ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'] : ['docker.io', 'docker-compose'],
    unit: 'docker',
    fields: [
      F.select('source', 'From', [['docker', 'Docker\'s repository (newest)'], ['debian', 'The distribution']]),
      F.lines('users', 'Users who may use Docker', { pattern: 'user', placeholder: 'alice' }),
      F.text('logSize', 'Container logs at most', { pattern: 'duration', default: '50m' }), F.num('logFiles', 'Log files per container', 3, [1, 50]),
      F.bool('liveRestore', 'Containers keep running during a Docker update', true),
      F.lines('mirrors', 'Registry mirrors', { pattern: 'url', placeholder: 'https://mirror.example.com' })
    ],
    before: v => v.source === 'docker' ? [
      T.file('Make the folder for signing keys', { path: '/etc/apt/keyrings', state: 'directory', mode: '0755' }),
      { name: 'Download the signing key of Docker', 'ansible.builtin.get_url': { url: 'https://download.docker.com/linux/{{ ansible_facts.distribution | lower }}/gpg', dest: '/etc/apt/keyrings/docker.asc', mode: '0644' } },
      T.copy('Add the Docker repository', '/etc/apt/sources.list.d/docker.list', "deb [arch={{ 'amd64' if ansible_facts.architecture == 'x86_64' else 'arm64' }} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/{{ ansible_facts.distribution | lower }} {{ ansible_facts.distribution_release }} stable\n")
    ] : [],
    files: v => [{ dir: true, dest: '/etc/docker' }, { dest: '/etc/docker/daemon.json', content: JSON.stringify({ 'log-driver': 'json-file', 'log-opts': { 'max-size': v.logSize, 'max-file': String(v.logFiles) }, 'live-restore': v.liveRestore, ...(v.mirrors.length ? { 'registry-mirrors': v.mirrors } : {}) }, null, 2) + '\n' }],
    after: v => v.users.map(u => ({ name: `Let ${u} use Docker`, 'ansible.builtin.user': { name: u, groups: ['docker'], append: true } })),
    summary: v => `${v.source === 'docker' ? 'Docker CE' : 'docker.io'}${v.users.length ? ` for ${v.users.join(', ')}` : ''}`
  }),
  service({
    id: 'podman', group: 'Containers', title: 'Podman', text: 'Containers without a daemon, also for users without root.',
    packages: ['podman', 'podman-compose', 'uidmap', 'slirp4netns'], unit: null,
    fields: [F.lines('registries', 'Registries to search', { pattern: 'host', default: ['docker.io'] })],
    files: v => [{ dir: true, dest: '/etc/containers/registries.conf.d' }, { dest: '/etc/containers/registries.conf.d/50-fleetpilot.conf', content: conf([`unqualified-search-registries = [${v.registries.map(r => quote(r)).join(', ')}]`]) }],
    summary: v => `Searches ${v.registries.join(', ')}`
  }),

  // ---------------------------------------------------------------- Databases
  service({
    id: 'postgresql', group: 'Databases', title: 'PostgreSQL', text: 'The PostgreSQL of the distribution, with who may connect from where.',
    packages: ['postgresql'], unit: 'postgresql',
    fields: [
      F.text('listen', 'Listen on', { pattern: 'word', default: 'localhost', placeholder: 'localhost or * or 10.0.0.5' }), F.num('maxConnections', 'Connections at most', 100, [10, 10000]),
      F.text('memory', 'Shared buffers', { pattern: 'duration', default: '128MB' }),
      F.rows('access', 'Who may connect', [F.text('database', 'Database', { pattern: 'word', default: 'all' }), F.text('user', 'User', { pattern: 'word', default: 'all' }), F.text('from', 'From', { pattern: 'cidr', required: true, placeholder: '10.0.0.0/8' })])
    ],
    before: () => [T.cmd('Find out the PostgreSQL version', "sh -c 'ls /etc/postgresql 2>/dev/null | sort -V | tail -1'", { register: 'fp_pg', changed: false, checkMode: false })],
    files: v => [{ name: 'Configure PostgreSQL', dest: '/etc/postgresql/{{ fp_pg.stdout }}/main/conf.d/fleetpilot.conf', content: conf([`listen_addresses = '${v.listen}'`, `max_connections = ${v.maxConnections}`, `shared_buffers = ${v.memory.replace(/M$/, 'MB').replace(/G$/, 'GB')}`]) }],
    after: v => [T.block('Allow the connections', { path: '/etc/postgresql/{{ fp_pg.stdout }}/main/pg_hba.conf', marker: '# {mark} FleetPilot access', block: v.access.map(a => `host ${a.database} ${a.user} ${a.from} scram-sha-256`).join('\n') }, { notify: 'Restart postgresql' })],
    ports: v => v.listen !== 'localhost' ? [{ port: 5432, proto: 'tcp', from: v.access.map(a => a.from), label: 'PostgreSQL' }] : [],
    summary: v => `Listens on ${v.listen}${v.access.length ? `, ${v.access.length} access rules` : ''}`
  }),
  service({
    id: 'mariadb', group: 'Databases', title: 'MariaDB', text: 'The MariaDB server of the distribution.',
    packages: ['mariadb-server'], unit: 'mariadb',
    fields: [F.text('bind', 'Listen on', { pattern: 'ip', default: '127.0.0.1' }), F.num('port', 'Port', 3306, [1, 65535]), F.num('maxConnections', 'Connections at most', 151, [10, 10000]), F.text('bufferPool', 'Buffer pool', { pattern: 'duration', default: '128M' }), F.lines('from', 'Allowed from', { pattern: 'cidr' })],
    files: v => [{ dest: '/etc/mysql/mariadb.conf.d/90-fleetpilot.cnf', content: conf(['[mysqld]', `bind-address = ${v.bind}`, `port = ${v.port}`, `max_connections = ${v.maxConnections}`, `innodb_buffer_pool_size = ${v.bufferPool}`]) }],
    ports: v => v.bind !== '127.0.0.1' ? [{ port: v.port, proto: 'tcp', from: v.from, label: 'MariaDB' }] : [],
    summary: v => `${v.bind}:${v.port}`
  }),
  service({
    id: 'redis', group: 'Databases', title: 'Redis', text: 'In-memory store, with a password from the vault.',
    packages: ['redis-server'], unit: 'redis-server',
    fields: [F.text('bind', 'Listen on', { pattern: 'any', default: '127.0.0.1 ::1' }), F.num('port', 'Port', 6379, [1, 65535]), F.text('maxmemory', 'Memory at most', { pattern: 'duration', default: '256mb' }), F.select('policy', 'When full', [['allkeys-lru', 'Drop the least used keys'], ['noeviction', 'Refuse new writes'], ['volatile-lru', 'Drop keys with an expiry']]), F.bool('password', 'Require a password (made and kept in the vault)', true), F.lines('from', 'Allowed from', { pattern: 'cidr' })],
    needs: v => v.password ? [{ type: 'hostSecret', name: 'redis', label: 'Redis password' }] : [],
    files: v => [{ dest: '/etc/redis/fleetpilot.conf', mode: '0640', owner: 'redis', group: 'redis', noLog: true, content: conf([`bind ${v.bind}`, `port ${v.port}`, `maxmemory ${v.maxmemory}`, `maxmemory-policy ${v.policy}`, v.password ? "requirepass {{ fp_host_secret['redis'] }}" : null]) }],
    after: () => [T.line('Read the FleetPilot settings of Redis', { path: '/etc/redis/redis.conf', line: 'include /etc/redis/fleetpilot.conf' }, { notify: 'Restart redis-server' })],
    ports: v => v.bind.includes('127.0.0.1') && !v.bind.includes('0.0.0.0') ? [] : [{ port: v.port, proto: 'tcp', from: v.from, label: 'Redis' }],
    summary: v => `${v.bind}:${v.port}${v.password ? ', with password' : ''}`
  }),

  // ---------------------------------------------------------------- Names, addresses, time
  service({
    id: 'bind', group: 'DNS and DHCP', title: 'BIND (DNS resolver)', text: 'A caching DNS resolver for your networks, with forwarders.',
    packages: ['bind9', 'bind9-utils'], unit: 'named', check: 'named-checkconf',
    fields: [F.lines('forwarders', 'Forward to', { pattern: 'ip', placeholder: '9.9.9.9' }), F.lines('allow', 'Answer queries from', { pattern: 'cidr', placeholder: '10.0.0.0/8' }), F.bool('dnssec', 'Validate DNSSEC', true)],
    files: v => [{ dest: '/etc/bind/named.conf.options', content: conf(['options {', '    directory "/var/cache/bind";', v.forwarders.length ? `    forwarders { ${v.forwarders.join('; ')}; };` : null, `    allow-query { localhost; ${v.allow.map(a => `${a};`).join(' ')} };`, `    allow-recursion { localhost; ${v.allow.map(a => `${a};`).join(' ')} };`, `    dnssec-validation ${v.dnssec ? 'auto' : 'no'};`, '    listen-on-v6 { any; };', '};'], '//') }],
    ports: v => [{ port: 53, proto: 'udp', from: v.allow, label: 'DNS' }, { port: 53, proto: 'tcp', from: v.allow, label: 'DNS' }],
    summary: v => v.forwarders.length ? `Forwards to ${v.forwarders.join(', ')}` : 'Resolves by itself'
  }),
  service({
    id: 'unbound', group: 'DNS and DHCP', title: 'Unbound (DNS resolver)', text: 'A small, validating DNS resolver.',
    packages: ['unbound'], unit: 'unbound', check: 'unbound-checkconf',
    fields: [F.lines('forwarders', 'Forward to', { pattern: 'ip' }), F.lines('allow', 'Answer queries from', { pattern: 'cidr' }), F.bool('tls', 'Forward over TLS (port 853)', false)],
    files: v => [{ dest: '/etc/unbound/unbound.conf.d/fleetpilot.conf', content: conf(['server:', '    interface: 0.0.0.0', '    interface: ::0', ...v.allow.map(a => `    access-control: ${a} allow`),
      ...(v.forwarders.length ? ['forward-zone:', '    name: "."', v.tls ? '    forward-tls-upstream: yes' : null, ...v.forwarders.map(f => `    forward-addr: ${f}${v.tls ? '@853' : ''}`)] : [])]) }],
    ports: v => [{ port: 53, proto: 'udp', from: v.allow, label: 'DNS' }, { port: 53, proto: 'tcp', from: v.allow, label: 'DNS' }],
    summary: v => v.forwarders.length ? `Forwards to ${v.forwarders.join(', ')}` : 'Resolves by itself'
  }),
  service({
    id: 'dnsmasq', group: 'DNS and DHCP', title: 'dnsmasq', text: 'Small DNS forwarder and DHCP server for a lab or a branch.',
    packages: ['dnsmasq'], unit: 'dnsmasq', check: 'dnsmasq --test',
    fields: [F.text('interface', 'On interface', { pattern: 'iface', placeholder: 'ens19' }), F.text('domain', 'Local domain', { pattern: 'host', placeholder: 'lab.example.com' }), F.text('rangeStart', 'DHCP from', { pattern: 'ip' }), F.text('rangeEnd', 'DHCP to', { pattern: 'ip' }), F.text('lease', 'Lease', { pattern: 'word', default: '12h' }), F.text('router', 'Gateway for clients', { pattern: 'ip' }), F.lines('dns', 'Forward DNS to', { pattern: 'ip' })],
    files: v => [{ dest: '/etc/dnsmasq.d/fleetpilot.conf', content: conf([v.interface ? `interface=${v.interface}\nbind-interfaces` : null, v.domain ? `domain=${v.domain}\nlocal=/${v.domain}/` : null, 'no-resolv', ...v.dns.map(d => `server=${d}`), v.rangeStart ? `dhcp-range=${v.rangeStart},${v.rangeEnd},${v.lease}` : null, v.router ? `dhcp-option=option:router,${v.router}` : null]) }],
    ports: v => [{ port: 53, proto: 'udp', label: 'DNS' }, { port: 53, proto: 'tcp', label: 'DNS' }, ...(v.rangeStart ? [{ port: 67, proto: 'udp', label: 'DHCP' }] : [])],
    summary: v => v.rangeStart ? `DHCP ${v.rangeStart} to ${v.rangeEnd}` : 'DNS only'
  }),
  service({
    id: 'kea', group: 'DNS and DHCP', title: 'Kea (DHCP server)', text: 'ISC Kea DHCPv4 with a pool and fixed reservations.',
    packages: ['kea-dhcp4-server'], unit: 'kea-dhcp4-server',
    fields: [
      F.text('interface', 'On interface', { pattern: 'iface', required: true, placeholder: 'ens19' }), F.text('subnet', 'Subnet', { pattern: 'cidr', required: true, placeholder: '10.40.0.0/24' }),
      F.text('poolStart', 'Pool from', { pattern: 'ip', required: true }), F.text('poolEnd', 'Pool to', { pattern: 'ip', required: true }), F.text('router', 'Gateway', { pattern: 'ip' }), F.lines('dns', 'DNS servers', { pattern: 'ip' }), F.text('domain', 'Domain', { pattern: 'host' }),
      F.num('lease', 'Lease (seconds)', 86400, [60, 31536000]),
      F.rows('reservations', 'Reservations', [F.text('mac', 'MAC', { pattern: 'word', required: true, placeholder: '52:54:00:12:34:56' }), F.text('ip', 'Address', { pattern: 'ip', required: true }), F.text('hostname', 'Name', { pattern: 'host' })])
    ],
    files: v => [{ dest: '/etc/kea/kea-dhcp4.conf', validate: 'kea-dhcp4 -t %s', content: JSON.stringify({ Dhcp4: {
      'interfaces-config': { interfaces: [v.interface] }, 'lease-database': { type: 'memfile', persist: true, name: '/var/lib/kea/kea-leases4.csv' }, 'valid-lifetime': v.lease,
      'option-data': [...(v.dns.length ? [{ name: 'domain-name-servers', data: v.dns.join(', ') }] : []), ...(v.domain ? [{ name: 'domain-name', data: v.domain }] : [])],
      subnet4: [{ id: 1, subnet: v.subnet, pools: [{ pool: `${v.poolStart} - ${v.poolEnd}` }], 'option-data': v.router ? [{ name: 'routers', data: v.router }] : [], reservations: v.reservations.map(r => ({ 'hw-address': r.mac, 'ip-address': r.ip, ...(r.hostname ? { hostname: r.hostname } : {}) })) }],
      loggers: [{ name: 'kea-dhcp4', 'output-options': [{ output: 'syslog' }], severity: 'INFO' }]
    } }, null, 2) + '\n' }],
    ports: () => [{ port: 67, proto: 'udp', label: 'DHCP' }],
    summary: v => `${v.subnet}, ${v.poolStart} to ${v.poolEnd}`
  }),

  // ---------------------------------------------------------------- VPN, files, high availability
  service({
    id: 'wireguard', group: 'VPN and files', title: 'WireGuard', text: 'A WireGuard interface with its peers. The private key is made on the host\'s behalf and kept in the vault.',
    packages: ['wireguard', 'wireguard-tools'], unit: v => `wg-quick@${v.name}`,
    fields: [F.text('name', 'Interface', { pattern: 'iface', default: 'wg0' }), F.text('address', 'Address with prefix', { pattern: 'cidr', required: true, placeholder: '10.99.0.1/24' }), F.num('port', 'Listen port', 51820, [1, 65535]),
      F.rows('peers', 'Peers', [F.text('name', 'Name', { pattern: 'any', required: true }), F.text('publicKey', 'Public key', { pattern: 'word', required: true }), F.text('allowed', 'Allowed addresses', { pattern: 'word', placeholder: '10.99.0.2/32' }), F.text('endpoint', 'Endpoint', { pattern: 'hostport' }), F.num('keepalive', 'Keepalive (s)', 0, [0, 3600])])],
    needs: v => [{ type: 'wgkey', name: v.name, label: `WireGuard ${v.name}` }],
    files: v => [{ dest: `/etc/wireguard/${v.name}.conf`, mode: '0600', noLog: true, content: conf(['[Interface]', `Address = ${v.address}`, `ListenPort = ${v.port}`, `PrivateKey = {{ fp_host_secret['wireguard ${v.name}'] }}`,
      ...v.peers.flatMap(p => ['', `# ${p.name}`, '[Peer]', `PublicKey = ${p.publicKey}`, `AllowedIPs = ${p.allowed}`, p.endpoint ? `Endpoint = ${p.endpoint}` : null, p.keepalive ? `PersistentKeepalive = ${p.keepalive}` : null])]) }],
    ports: v => [{ port: v.port, proto: 'udp', label: 'WireGuard' }],
    summary: v => `${v.name} ${v.address}, ${v.peers.length} peers`
  }),
  service({
    id: 'samba', group: 'VPN and files', title: 'Samba (SMB shares)', text: 'Windows file shares.',
    packages: ['samba'], unit: 'smbd', check: 'testparm -s',
    fields: [F.text('workgroup', 'Workgroup', { pattern: 'name', default: 'WORKGROUP' }), F.lines('allow', 'Allowed from', { pattern: 'cidr' }), F.rows('shares', 'Shares', [F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'projects' }), F.text('path', 'Folder', { pattern: 'path', required: true, placeholder: '/srv/projects' }), F.text('users', 'Users', { pattern: 'word', placeholder: 'alice,@staff' }), F.bool('readOnly', 'Read only', false), F.bool('guest', 'Guests allowed', false)])],
    files: v => [...v.shares.map(s => ({ dir: true, dest: s.path, mode: '0775' })), { dest: '/etc/samba/smb.conf', content: conf(['[global]', `   workgroup = ${v.workgroup}`, '   server role = standalone server', '   server min protocol = SMB2_10', '   map to guest = bad user', v.allow.length ? `   hosts allow = 127.0.0.1 ${v.allow.join(' ')}` : null, '   log file = /var/log/samba/log.%m', '   max log size = 1000',
      ...v.shares.flatMap(s => ['', `[${s.name}]`, `   path = ${s.path}`, `   read only = ${s.readOnly ? 'yes' : 'no'}`, `   guest ok = ${s.guest ? 'yes' : 'no'}`, s.users ? `   valid users = ${lines(s.users).join(' ')}` : null])]) }],
    ports: v => [{ port: 445, proto: 'tcp', from: v.allow, label: 'SMB' }],
    summary: v => v.shares.map(s => s.name).join(', ') || 'No shares'
  }),
  service({
    id: 'nfs', group: 'VPN and files', title: 'NFS server', text: 'NFS exports for Linux clients.',
    packages: ['nfs-kernel-server'], unit: 'nfs-server',
    fields: [F.rows('exports', 'Exports', [F.text('path', 'Folder', { pattern: 'path', required: true, placeholder: '/srv/nfs/data' }), F.text('clients', 'Clients', { pattern: 'cidr', required: true, placeholder: '10.0.0.0/24' }), F.text('options', 'Options', { pattern: 'word', default: 'rw,sync,no_subtree_check' })])],
    files: v => [...v.exports.map(e => ({ dir: true, dest: e.path })), { dir: true, dest: '/etc/exports.d' }, { dest: '/etc/exports.d/fleetpilot.exports', content: conf(v.exports.map(e => `${e.path} ${e.clients}(${e.options})`)) }],
    after: () => [T.cmd('Publish the exports', 'exportfs -ra', { changed: false })],
    ports: v => [{ port: 2049, proto: 'tcp', from: v.exports.map(e => e.clients), label: 'NFS' }],
    summary: v => v.exports.map(e => e.path).join(', ') || 'No exports'
  }),
  service({
    id: 'keepalived', group: 'VPN and files', title: 'Keepalived (shared address)', text: 'A virtual address that moves to another host when one fails (VRRP).',
    packages: ['keepalived'], unit: 'keepalived',
    fields: [F.rows('instances', 'Shared addresses', [F.text('name', 'Name', { pattern: 'name', required: true, placeholder: 'web' }), F.text('interface', 'Interface', { pattern: 'iface', placeholder: 'ens18' }), F.num('router', 'Router id', 51, [1, 255]), F.text('vip', 'Shared address', { pattern: 'cidr', required: true, placeholder: '10.20.0.100/24' }), F.select('role', 'Role', [['BACKUP', 'Equal (highest priority wins)'], ['MASTER', 'Preferred']]), F.num('priority', 'Priority', 100, [1, 254])])],
    needs: v => v.instances.map(i => ({ type: 'shared', key: `vrrp:${i.name}`, length: 8, label: `VRRP ${i.name}` })),
    files: v => [{ dest: '/etc/keepalived/keepalived.conf', mode: '0600', noLog: true, content: conf(v.instances.flatMap(i => [`vrrp_instance ${i.name} {`, `    state ${i.role}`, `    interface ${i.interface || '{{ ansible_facts.default_ipv4.interface }}'}`, `    virtual_router_id ${i.router}`, `    priority ${i.priority}`, '    advert_int 1', '    authentication {', '        auth_type PASS', `        auth_pass {{ fp_shared['vrrp:${i.name}'] }}`, '    }', '    virtual_ipaddress {', `        ${i.vip}`, '    }', '}'])) }],
    ports: () => [{ raw: 'ip protocol vrrp', label: 'VRRP' }],
    summary: v => v.instances.map(i => i.vip).join(', ') || 'None'
  }),

  // ---------------------------------------------------------------- Monitoring
  service({
    id: 'nodeexporter', group: 'Monitoring', title: 'Prometheus node exporter', text: 'Hardware and system metrics for Prometheus.',
    packages: ['prometheus-node-exporter'], unit: 'prometheus-node-exporter',
    fields: [F.text('listen', 'Listen on', { pattern: 'word', default: ':9100' }), F.lines('from', 'Allowed from', { pattern: 'cidr' }), F.bool('systemd', 'Also report systemd units', true)],
    files: v => [{ dest: '/etc/default/prometheus-node-exporter', content: conf([`ARGS="--web.listen-address=${v.listen}${v.systemd ? ' --collector.systemd' : ''}"`]) }],
    ports: v => [{ port: portOf(v.listen, 9100), proto: 'tcp', from: v.from, label: 'node exporter' }],
    summary: v => v.listen
  }),
  service({
    id: 'prometheus', group: 'Monitoring', title: 'Prometheus', text: 'Collects metrics from the targets you name.',
    packages: ['prometheus'], unit: 'prometheus', reload: true, check: 'promtool check config /etc/prometheus/prometheus.yml',
    fields: [F.text('interval', 'Collect every', { pattern: 'word', default: '30s' }), F.text('retention', 'Keep for', { pattern: 'word', default: '30d' }), F.rows('jobs', 'Targets', [F.text('name', 'Job', { pattern: 'name', required: true, placeholder: 'nodes' }), F.text('targets', 'Targets', { pattern: 'word', placeholder: '10.0.0.11:9100,10.0.0.12:9100' })]), F.lines('from', 'Web page allowed from', { pattern: 'cidr' })],
    files: v => [{ dest: '/etc/prometheus/prometheus.yml', content: '# Managed by FleetPilot\n' + toYaml({ global: { scrape_interval: v.interval }, scrape_configs: [{ job_name: 'prometheus', static_configs: [{ targets: ['localhost:9090'] }] }, ...v.jobs.map(j => ({ job_name: j.name, static_configs: [{ targets: lines(j.targets) }] }))] }) },
      { dest: '/etc/default/prometheus', content: conf([`ARGS="--storage.tsdb.retention.time=${v.retention}"`]) }],
    ports: v => [{ port: 9090, proto: 'tcp', from: v.from, label: 'Prometheus' }],
    summary: v => `${v.jobs.length} jobs, every ${v.interval}`
  }),
  service({
    id: 'grafana', group: 'Monitoring', title: 'Grafana', text: 'Dashboards, from Grafana\'s repository, with the admin password in the vault.',
    packages: ['grafana'], unit: 'grafana-server',
    fields: [F.num('port', 'Port', 3000, [1, 65535]), F.text('domain', 'Address', { pattern: 'host', placeholder: 'grafana.example.com' }), F.lines('from', 'Allowed from', { pattern: 'cidr' })],
    needs: () => [{ type: 'hostSecret', name: 'grafana admin', label: 'Grafana admin password' }],
    before: () => [
      T.file('Make the folder for signing keys', { path: '/etc/apt/keyrings', state: 'directory', mode: '0755' }),
      { name: 'Download the signing key of Grafana', 'ansible.builtin.get_url': { url: 'https://apt.grafana.com/gpg.key', dest: '/etc/apt/keyrings/grafana.asc', mode: '0644' } },
      T.copy('Add the Grafana repository', '/etc/apt/sources.list.d/grafana.list', 'deb [signed-by=/etc/apt/keyrings/grafana.asc] https://apt.grafana.com stable main\n')
    ],
    files: v => [{ dest: '/etc/default/grafana-server', mode: '0640', group: 'grafana', noLog: true, content: conf(['GRAFANA_USER=grafana', 'GRAFANA_GROUP=grafana', 'GRAFANA_HOME=/usr/share/grafana', 'LOG_DIR=/var/log/grafana', 'DATA_DIR=/var/lib/grafana', 'CONF_DIR=/etc/grafana', 'CONF_FILE=/etc/grafana/grafana.ini', 'PID_FILE_DIR=/run/grafana', 'RESTART_ON_UPGRADE=true',
      `GF_SERVER_HTTP_PORT=${v.port}`, v.domain ? `GF_SERVER_DOMAIN=${v.domain}` : null, "GF_SECURITY_ADMIN_PASSWORD={{ fp_host_secret['grafana admin'] }}", 'GF_ANALYTICS_REPORTING_ENABLED=false']) }],
    ports: v => [{ port: v.port, proto: 'tcp', from: v.from, label: 'Grafana' }],
    summary: v => `Port ${v.port}`
  }),
  service({
    id: 'zabbix', group: 'Monitoring', title: 'Zabbix agent', text: 'The agent for your Zabbix server.',
    packages: ['zabbix-agent'], unit: 'zabbix-agent',
    fields: [F.text('server', 'Zabbix server', { pattern: 'host', required: true, placeholder: 'zabbix.example.com' }), F.bool('active', 'Active checks too', true), F.text('hostname', 'Name in Zabbix', { pattern: 'host', default: '{{ fp_name }}' })],
    files: v => [{ dest: '/etc/zabbix/zabbix_agentd.conf.d/fleetpilot.conf', content: conf([`Server=${v.server}`, v.active ? `ServerActive=${v.server}` : 'ServerActive=', `Hostname=${v.hostname}`]) }],
    ports: v => [{ port: 10050, proto: 'tcp', from: [], label: 'Zabbix' }],
    summary: v => v.server
  }),

  // ---------------------------------------------------------------- Security and mail
  service({
    id: 'clamav', group: 'Security and mail', title: 'ClamAV', text: 'Virus scanner with daily signature updates.',
    packages: ['clamav', 'clamav-daemon', 'clamav-freshclam'], unit: 'clamav-freshclam',
    fields: [F.num('checks', 'Signature updates per day', 12, [1, 50]), F.bool('daemon', 'Run the scanning daemon (needs about 1.5 GB memory)', false)],
    after: v => [T.line('Set the update interval', { path: '/etc/clamav/freshclam.conf', regexp: '^Checks ', line: `Checks ${v.checks}` }, { notify: 'Restart clamav-freshclam' }), T.service('clamav-daemon', { state: v.daemon ? 'started' : 'stopped', enabled: v.daemon, name: v.daemon ? 'Start the scanning daemon' : 'Stop the scanning daemon' })],
    summary: v => `${v.checks} updates a day${v.daemon ? ', daemon on' : ''}`
  }),
  service({
    id: 'postfix', group: 'Security and mail', title: 'Mail relay (Postfix)', text: 'Sends the host\'s mail (cron, alerts) through your mail server.',
    packages: ['postfix', 'bsd-mailx'], unit: 'postfix',
    fields: [F.text('relay', 'Mail server', { pattern: 'any', required: true, placeholder: '[smtp.example.com]:587' }), F.text('from', 'Domain of the sender', { pattern: 'host', placeholder: 'example.com' }), F.text('root', 'Mail for root goes to', { pattern: 'any', placeholder: 'ops@example.com' })],
    after: v => [
      ...[['relayhost', v.relay], ['inet_interfaces', 'loopback-only'], ['mydestination', ''], ['myhostname', '{{ fp_fqdn }}'], ...(v.from ? [['myorigin', v.from]] : [])]
        .map(([k, val]) => T.line(`Set ${k}`, { path: '/etc/postfix/main.cf', regexp: `^${k}\\s*=`, line: `${k} = ${val}` }, { notify: 'Restart postfix' })),
      ...(v.root ? [T.line('Forward mail for root', { path: '/etc/aliases', regexp: '^root:', line: `root: ${v.root}` }, { notify: 'Update the mail aliases' })] : [])
    ],
    summary: v => `Through ${v.relay}`
  }),

  // ---------------------------------------------------------------- Tools for virtual machines and administration
  service({
    id: 'qemuagent', group: 'Virtual machines', title: 'QEMU guest agent', text: 'Lets Proxmox and KVM see the addresses of the VM and shut it down cleanly.',
    packages: ['qemu-guest-agent'], unit: 'qemu-guest-agent', fields: [], summary: () => 'On',
    // Only a VM has the agent's device: on other machines it is installed, not started
    startWhen: "ansible_facts.virtualization_role == 'guest' and ansible_facts.virtualization_type in ['kvm', 'qemu']"
  }),
  service({
    id: 'vmtools', group: 'Virtual machines', title: 'VMware tools', text: 'open-vm-tools for VMs on VMware.',
    packages: ['open-vm-tools'], unit: 'open-vm-tools', fields: [], summary: () => 'On',
    startWhen: "ansible_facts.virtualization_type == 'VMware'"
  }),
  service({
    id: 'cockpit', group: 'Virtual machines', title: 'Cockpit', text: 'A web console for the host.',
    packages: ['cockpit'], unit: 'cockpit.socket',
    fields: [F.num('port', 'Port', 9090, [1, 65535]), F.lines('from', 'Allowed from', { pattern: 'cidr' })],
    files: v => [{ dir: true, dest: '/etc/systemd/system/cockpit.socket.d' }, { dest: '/etc/systemd/system/cockpit.socket.d/listen.conf', content: conf(['[Socket]', 'ListenStream=', `ListenStream=${v.port}`]) }],
    ports: v => [{ port: v.port, proto: 'tcp', from: v.from, label: 'Cockpit' }],
    summary: v => `Port ${v.port}`
  }),
  service({
    id: 'lldpd', group: 'Virtual machines', title: 'LLDP', text: 'Tells switches who is connected where, and learns it from them.',
    packages: ['lldpd'], unit: 'lldpd',
    fields: [F.text('description', 'Description', { pattern: 'any', default: '{{ fp_name }}' })],
    files: v => [{ dest: '/etc/lldpd.d/fleetpilot.conf', content: conf([`configure system description ${quote(v.description)}`]) }],
    summary: () => 'On'
  })
];

// Handlers that some services notify but do not restart themselves
export const EXTRA_HANDLERS = {
  'Update the mail aliases': T.cmd('Update the mail aliases', 'newaliases')
};
