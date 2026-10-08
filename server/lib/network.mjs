// FleetPilot: the network settings of a desired state as files for whatever the host uses:
// ifupdown (Debian), netplan (Ubuntu) or systemd-networkd. New settings are applied at the very
// end of a run, in the background, so a changed address never cuts the run in the middle.
import { T, conf } from './catalog.mjs';
import { toYaml } from './yaml.mjs';

const PRIMARY = "{{ fp_iface | default(ansible_facts.default_ipv4.interface | default('eth0')) }}";
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

/** Address, gateway of the main interface (Jinja for values that come from the host) */
function main(i) {
  if (!i) return null;
  if (i.method === 'dhcp') return { name: i.name || PRIMARY, dhcp: true, mtu: i.mtu, ipv6: i.ipv6 };
  return {
    name: i.name || PRIMARY,
    address: i.method === 'ipam' ? '{{ fp_ip }}' : i.address,
    gateway: i.gateway || '{{ fp_gateway }}',
    mtu: i.mtu, ipv6: i.ipv6
  };
}

function ifupdown(n) {
  const out = [];
  const iface = (name, method, extra = []) => out.push('', `auto ${name}`, `iface ${name} inet ${method}`, ...extra.filter(Boolean).map(l => `    ${l}`));
  for (const b of n.bonds) {
    for (const m of list(b.members)) out.push('', `iface ${m} inet manual`);
    iface(b.name, b.method === 'dhcp' ? 'dhcp' : b.method === 'static' ? 'static' : 'manual', [b.method === 'static' && `address ${b.address}`, `bond-slaves ${list(b.members).join(' ')}`, `bond-mode ${b.mode}`, 'bond-miimon 100']);
  }
  for (const br of n.bridges) {
    iface(br.name, br.method === 'dhcp' ? 'dhcp' : br.method === 'static' ? 'static' : 'manual', [br.method === 'static' && `address ${br.address}`, `bridge_ports ${list(br.ports).join(' ') || 'none'}`, 'bridge_stp off', 'bridge_fd 0']);
  }
  for (const v of n.vlans) {
    const parent = v.parent || PRIMARY;
    iface(`${parent}.${v.id}`, v.method === 'dhcp' ? 'dhcp' : v.method === 'static' ? 'static' : 'manual', [v.method === 'static' && `address ${v.address}`, `vlan-raw-device ${parent}`]);
  }
  const routes = n.routes.map(r => `up ip route replace ${r.to} via ${r.via}${r.dev ? ` dev ${r.dev}` : ''}`);
  const m = main(n.interface);
  const extras = conf(out.slice(1));
  const mainFile = m ? conf([
    'source /etc/network/interfaces.d/*', '', 'auto lo', 'iface lo inet loopback', '',
    `allow-hotplug ${m.name}`, `auto ${m.name}`,
    `iface ${m.name} inet ${m.dhcp ? 'dhcp' : 'static'}`,
    ...[!m.dhcp && `address ${m.address}`, !m.dhcp && m.gateway && `gateway ${m.gateway}`, m.mtu && `mtu ${m.mtu}`, ...routes].filter(Boolean).map(l => `    ${l}`),
    m.ipv6 === 'off' ? null : `iface ${m.name} inet6 auto`
  ]) : null;
  const pk = [n.vlans.length && 'vlan', n.bonds.length && 'ifenslave', n.bridges.length && 'bridge-utils'].filter(Boolean);
  return {
    tasks: [
      ...(pk.length ? [{ ...T.apt(pk), when: 'fp_ifupdown.stat.exists' }] : []),
      T.copy('Write the extra interfaces (ifupdown)', '/etc/network/interfaces.d/fleetpilot', extras, { when: 'fp_ifupdown.stat.exists and not fp_netplan.stat.exists', notify: 'Apply the network settings' }),
      ...(mainFile ? [T.copy('Write the network settings (ifupdown)', '/etc/network/interfaces', mainFile, { when: 'fp_ifupdown.stat.exists and not fp_netplan.stat.exists', notify: 'Apply the network settings' })] : [])
    ],
    apply: 'systemctl restart networking'
  };
}

function netplan(n, dns) {
  const net = { version: 2, renderer: 'networkd' };
  const addr = (method, address) => method === 'dhcp' ? { dhcp4: true } : method === 'static' ? { dhcp4: false, addresses: [address] } : { dhcp4: false };
  const m = main(n.interface);
  const nameservers = dns ? { addresses: dns.servers.length ? dns.servers : '{{ fp_dns | default([]) }}', search: dns.search.length ? dns.search : '{{ fp_search | default([]) }}' } : undefined;
  const eth = {};
  for (const b of n.bonds) for (const x of list(b.members)) eth[x] = { dhcp4: false };
  for (const br of n.bridges) for (const x of list(br.ports)) eth[x] = { dhcp4: false };
  const routes = n.routes.map(r => ({ to: r.to, via: r.via }));
  if (m) {
    eth[m.name] = {
      ...(m.dhcp ? { dhcp4: true } : { dhcp4: false, addresses: [m.address], routes: [{ to: 'default', via: m.gateway }, ...routes] }),
      ...(m.mtu ? { mtu: m.mtu } : {}), ...(m.ipv6 === 'off' ? { 'link-local': [] } : { dhcp6: false, 'accept-ra': true }),
      ...(nameservers ? { nameservers } : {})
    };
  }
  if (Object.keys(eth).length) net.ethernets = eth;
  if (n.bonds.length) net.bonds = Object.fromEntries(n.bonds.map(b => [b.name, { interfaces: list(b.members), parameters: { mode: b.mode, 'mii-monitor-interval': 100 }, ...addr(b.method, b.address) }]));
  if (n.bridges.length) net.bridges = Object.fromEntries(n.bridges.map(b => [b.name, { interfaces: list(b.ports), parameters: { stp: false, 'forward-delay': 0 }, ...addr(b.method, b.address) }]));
  if (n.vlans.length) net.vlans = Object.fromEntries(n.vlans.map(v => [`vlan${v.id}`, { id: v.id, link: v.parent || PRIMARY, ...addr(v.method, v.address) }]));
  const text = '# Managed by FleetPilot: changes here are overwritten.\n' + toYaml({ network: net })
    // Jinja lists must stay Jinja expressions, not strings
    .replace(/"(\{\{ fp_(dns|search) \| default\(\[\]\) \}\})"/g, '$1');
  return {
    tasks: [T.copy('Write the network settings (netplan)', '/etc/netplan/90-fleetpilot.yaml', text, { mode: '0600', when: 'fp_netplan.stat.exists', notify: 'Apply the network settings' })],
    apply: 'netplan apply'
  };
}

/** Tasks for the merged network settings of a desired state; empty when it has none */
export function networkTasks(merged) {
  const n = {
    interface: merged.interface || null,
    vlans: merged.vlans?.vlans || [], bonds: merged.bonds?.bonds || [], bridges: merged.bridges?.bridges || [], routes: merged.routes?.routes || []
  };
  const dns = merged.dns || null;
  const tasks = [], handlers = {};
  if (n.interface || n.vlans.length || n.bonds.length || n.bridges.length || n.routes.length) {
    tasks.push(
      { name: 'Find out whether the host uses netplan', 'ansible.builtin.stat': { path: '/etc/netplan' }, register: 'fp_netplan' },
      { name: 'Find out whether the host uses ifupdown', 'ansible.builtin.stat': { path: '/etc/network/interfaces' }, register: 'fp_ifupdown' }
    );
    const a = ifupdown(n), b = netplan(n, dns);
    tasks.push(...a.tasks, ...b.tasks);
    // Applied in the background after a moment, so this connection can finish first
    handlers['Apply the network settings'] = {
      name: 'Apply the network settings',
      'ansible.builtin.shell': { cmd: `nohup sh -c 'sleep 3; if [ -d /etc/netplan ]; then ${b.apply}; else ${a.apply}; fi' >/dev/null 2>&1 &` },
      async: 30, poll: 0
    };
  }
  if (dns) {
    const servers = dns.servers.length ? dns.servers.map(s => `nameserver ${s}`).join('\n') : '{% for s in fp_dns | default([]) %}nameserver {{ s }}\n{% endfor %}';
    const search = dns.search.length ? dns.search.join(' ') : "{{ fp_search | default([]) | join(' ') }}";
    tasks.push(
      { name: 'Find out whether systemd-resolved runs', 'ansible.builtin.stat': { path: '/run/systemd/resolve/stub-resolv.conf' }, register: 'fp_resolved' },
      T.file('Make the folder for resolver settings', { path: '/etc/systemd/resolved.conf.d', state: 'directory', mode: '0755' }, { when: 'fp_resolved.stat.exists' }),
      T.copy('Set the DNS servers (systemd-resolved)', '/etc/systemd/resolved.conf.d/fleetpilot.conf',
        `# Managed by FleetPilot\n[Resolve]\nDNS=${dns.servers.length ? dns.servers.join(' ') : "{{ fp_dns | default([]) | join(' ') }}"}\nDomains=${search}\n`, { when: 'fp_resolved.stat.exists', notify: 'Restart the resolver' }),
      { ...T.copy('Set the DNS servers (/etc/resolv.conf)', '/etc/resolv.conf', `# Managed by FleetPilot\n${servers}${servers.endsWith('\n') ? '' : '\n'}search ${search}\n`, { when: 'not fp_resolved.stat.exists' }), 'ansible.builtin.copy': { dest: '/etc/resolv.conf', content: `# Managed by FleetPilot\n${servers}${servers.endsWith('\n') ? '' : '\n'}search ${search}\n`, owner: 'root', group: 'root', mode: '0644', unsafe_writes: true } }
    );
    handlers['Restart the resolver'] = T.restart('systemd-resolved');
  }
  return { tasks, handlers };
}
