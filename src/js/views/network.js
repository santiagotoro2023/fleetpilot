// FleetPilot: IP address management. Subnets with their use, VLANs, a check before an address is
// given out, the next free address of a pool; a subnet's page with its address map, pools and
// settings.
import { h, toast } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { main, get, call, can, pageHead, btn, tabs, dialog, field, input, select, table, empty, when, plural, forgetChoices } from '../common.js';

const pref = (ctx, k, d) => ctx.store.prefs[k] ?? d;
const STATES = { assigned: 'Assigned', reserved: 'Reserved', discovered: 'Found on the network', conflict: 'Conflict' };

async function sites() {
  return (await get('/api/groups')).filter(g => g.kind === 'site').map(g => [g.id, g.name]);
}

export async function viewNetwork(ctx) {
  document.title = 'Network';
  const data = await get('/api/network');
  const tab = ctx.query.tab || pref(ctx, 'network.tab', 'subnets');
  const page = h('div', { class: 'page' });
  const mayChange = can('network', 'change');
  page.append(pageHead('Network', 'Subnets, VLANs and every address FleetPilot gives out. An address is free only when FleetPilot does not know it and nothing answers on it.', [
    mayChange ? btn('Add a subnet', 'plus', () => subnetDialog(ctx, null, data.vlans), 'primary') : null,
    mayChange ? btn('Add a VLAN', 'plus', () => vlanDialog(ctx)) : null
  ].filter(Boolean)));
  const body = h('div', {});
  page.append(tabs([['subnets', 'Subnets'], ['vlans', 'VLANs'], ['check', 'Check an address']], tab, id => { ctx.store.setPref('network.tab', id); draw(id); }), body);
  main.append(page);
  const draw = id => {
    body.innerHTML = '';
    if (id === 'vlans') drawVlans(ctx, body, data);
    else if (id === 'check') drawCheck(body, data);
    else drawSubnets(ctx, body, data);
  };
  draw(tab);
}

function useBar(s) {
  const used = s.assigned + s.reserved + s.discovered;
  const pct = s.size ? Math.min(100, Math.round(used / s.size * 100)) : 0;
  return h('div', { class: 'fp-use', title: `${s.assigned} assigned, ${s.reserved} reserved, ${s.discovered} found, of ${s.size}` },
    h('span', { class: 'fp-use-bar' }, h('i', { style: { width: `${pct}%` }, class: pct > 90 ? 'full' : '' })), h('span', { class: 'small muted' }, `${used} of ${s.size}`));
}

function drawSubnets(ctx, body, data) {
  if (!data.subnets.length) {
    body.append(h('div', { class: 'subcard fp-start' }, h('h2', {}, 'No subnets yet'),
      h('p', { class: 'muted' }, 'Add the subnets your hosts live in. FleetPilot then records which address belongs to which host, gives out the next free address of a pool and warns before an address is used twice.'),
      can('network', 'change') ? h('div', { class: 'row' }, btn('Add a subnet', 'plus', () => subnetDialog(ctx, null, data.vlans), 'primary')) : null));
    return;
  }
  body.append(table(['Subnet', 'Name', 'VLAN', 'Site', 'Gateway', 'Pools', 'In use'], data.subnets.map(s => h('tr', {},
    h('td', {}, h('a', { class: 'mono', href: `#/network/${s.id}` }, s.cidr)), h('td', {}, s.name || '–'),
    h('td', {}, s.vid ? `${s.vid}${s.vlan_name ? ` ${s.vlan_name}` : ''}` : '–'), h('td', {}, s.site_name || '–'),
    h('td', { class: 'mono' }, s.gateway || '–'), h('td', {}, s.pools.length ? s.pools.map(p => p.name).join(', ') : '–'), h('td', {}, useBar(s))))));
}

function drawVlans(ctx, body, data) {
  if (!data.vlans.length) { body.append(empty('No VLANs yet. A VLAN groups subnets; hosts get it in their network settings.')); return; }
  const mayChange = can('network', 'change');
  body.append(table(['VLAN', 'Name', 'Site', 'Subnets', 'Description', ''], data.vlans.map(v => h('tr', {},
    h('td', { class: 'mono' }, String(v.vid)), h('td', {}, v.name || '–'), h('td', {}, v.site_name || 'Every site'), h('td', {}, String(v.subnets)), h('td', { class: 'muted' }, v.description || ''),
    h('td', { class: 'fp-actions-cell' }, mayChange ? [btn('Change', '', () => vlanDialog(ctx, v), 'ghost'), btn('Delete', '', async () => {
      if (!(await dialog(`Delete VLAN ${v.vid}`, [h('p', {}, v.subnets ? `${plural(v.subnets, 'subnet keeps', 'subnets keep')} its addresses but no longer belong to a VLAN.` : 'Nothing uses it.')], { ok: 'Delete the VLAN', okClass: 'danger', onOk: () => call(() => api.del(`/api/network/vlans/${v.id}`)) }))) return;
      ctx.rerender();
    }, 'ghost')] : null)))));
}

function drawCheck(body, data) {
  const ip = input({ mono: true, placeholder: '10.20.0.42', 'aria-label': 'Address' });
  const out = h('div', {});
  const check = async () => {
    if (!ip.value.trim()) return;
    out.innerHTML = '';
    out.append(h('p', { class: 'muted small' }, 'Checking, and asking the network…'));
    const r = await call(() => api.post('/api/network/check', { ip: ip.value.trim() })).catch(() => null);
    out.innerHTML = '';
    if (!r) return;
    const verdict = r.free ? h('div', { class: 'done-banner' }, `${r.ip} is free.`) : h('div', { class: 'fp-note fp-danger' }, `${r.ip} is in use.`);
    out.append(verdict, h('dl', { class: 'kv' },
      h('dt', {}, 'Subnet'), h('dd', {}, r.subnet ? h('a', { href: `#/network/${r.subnet.id}`, class: 'mono' }, r.subnet.cidr) : 'In no subnet of FleetPilot'),
      h('dt', {}, 'In FleetPilot'), h('dd', {}, r.known ? `${STATES[r.known.state] || r.known.state}${r.known.host ? `: ${r.known.host}` : ''}${r.known.note ? ` (${r.known.note})` : ''}` : 'Not recorded'),
      h('dt', {}, 'Host address of'), h('dd', {}, r.hosts.length ? r.hosts.map(x => h('a', { href: `#/hosts/${x.id}`, style: { marginRight: '8px' } }, x.name)) : 'No host'),
      h('dt', {}, 'Answers on the network'), h('dd', {}, r.answers === null ? 'Not asked (the live check is off in the settings)' : r.answers ? 'Yes' : 'No')));
  };
  ip.addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
  const pools = data.subnets.flatMap(s => s.pools.map(p => [p.id, `${p.name} (${s.cidr})`]));
  const pool = select(pools.length ? pools : [['', 'No pools yet']], pools[0]?.[0] || '');
  const nextOut = h('div', {});
  const next = async reserve => {
    if (!pool.value) return;
    nextOut.innerHTML = '';
    nextOut.append(h('p', { class: 'muted small' }, 'Looking for a free address…'));
    const r = await call(() => api.post('/api/network/next', { poolId: pool.value, reserve })).catch(() => null);
    nextOut.innerHTML = '';
    if (r) nextOut.append(h('div', { class: 'done-banner' }, `${reserve ? 'Reserved' : 'Free'}: `, h('b', { class: 'mono' }, `${r.ip}/${r.prefix}`), r.checked ? '' : ' (not asked on the network)'));
  };
  body.append(h('div', { class: 'fp-cols' },
    h('div', { class: 'subcard' }, h('h2', {}, 'Is this address free?'), h('p', { class: 'muted small' }, 'FleetPilot looks at what it knows and asks the address on the network.'),
      h('div', { class: 'row' }, ip, btn('Check', 'search', check, 'primary')), out),
    h('div', { class: 'subcard' }, h('h2', {}, 'The next free address'), h('p', { class: 'muted small' }, 'The lowest address of a pool that is not given out and does not answer.'),
      field('Pool', pool), h('div', { class: 'row' }, btn('Find it', 'search', () => next(false), 'primary'), can('network', 'change') ? btn('Find and reserve it', 'lock', () => next(true)) : null), nextOut)));
}

async function vlanDialog(ctx, v = null) {
  const vid = input({ mono: true, type: 'number', min: 1, max: 4094, value: v?.vid ?? '', style: { width: '110px' } });
  const name = input({ value: v?.name || '', placeholder: 'Servers' });
  const site = select([['', 'Every site'], ...await sites()], v?.site_id || '');
  const desc = input({ value: v?.description || '' });
  const r = await dialog(v ? `Change VLAN ${v.vid}` : 'Add a VLAN', [h('div', { class: 'fp-grid2' }, field('VLAN id', vid, '1 to 4094'), field('Name', name)), field('Site', site), field('Description', desc)], {
    ok: v ? 'Save' : 'Add the VLAN',
    onOk: () => call(() => { const b = { vid: Number(vid.value), name: name.value, siteId: site.value || null, description: desc.value }; return v ? api.patch(`/api/network/vlans/${v.id}`, b) : api.post('/api/network/vlans', b); })
  });
  if (r) ctx.rerender();
}

async function subnetDialog(ctx, s = null, vlans = null) {
  vlans ??= (await get('/api/network')).vlans;
  const cidr = input({ mono: true, value: s?.cidr || '', placeholder: '10.20.0.0/24', disabled: !!s });
  const name = input({ value: s?.name || '', placeholder: 'Servers Zurich' });
  const gateway = input({ mono: true, value: s?.gateway || '', placeholder: '10.20.0.1' });
  const vlan = select([['', 'No VLAN'], ...vlans.map(v => [v.id, `${v.vid}${v.name ? ` ${v.name}` : ''}${v.site_name ? ` (${v.site_name})` : ''}`])], s?.vlan_id || '');
  const site = select([['', 'No site'], ...await sites()], s?.site_id || '');
  const dns = input({ mono: true, value: (s?.dns || []).join(', '), placeholder: '10.20.0.53, 10.20.0.54' });
  const search = input({ mono: true, value: (s?.search_domains || []).join(', '), placeholder: 'example.com' });
  const ntp = input({ mono: true, value: (s?.ntp || []).join(', '), placeholder: 'ntp.example.com' });
  const desc = input({ value: s?.description || '' });
  const r = await dialog(s ? `Change ${s.cidr}` : 'Add a subnet', [
    h('div', { class: 'fp-grid2' }, field('Network', cidr, s ? 'The network itself never changes.' : 'Like 10.20.0.0/24 or 2001:db8:20::/64.'), field('Name', name)),
    h('div', { class: 'fp-grid3' }, field('Gateway', gateway), field('VLAN', vlan), field('Site', site)),
    h('p', { class: 'small muted' }, 'Hosts that get an address in this subnet also get these, unless a template says otherwise:'),
    h('div', { class: 'fp-grid3' }, field('DNS servers', dns), field('Search domains', search), field('Time servers', ntp)),
    field('Description', desc)
  ], {
    ok: s ? 'Save' : 'Add the subnet', wide: true,
    onOk: () => call(() => {
      const b = { name: name.value, gateway: gateway.value, vlanId: vlan.value || null, siteId: site.value || null, dns: dns.value, search: search.value, ntp: ntp.value, description: desc.value };
      return s ? api.patch(`/api/network/subnets/${s.id}`, b) : api.post('/api/network/subnets', { ...b, cidr: cidr.value });
    })
  });
  if (!r) return;
  forgetChoices();
  if (!s && r.id) location.hash = `#/network/${r.id}`; else ctx.rerender();
}

// ---------------------------------------------------------------- One subnet
export async function viewSubnet(ctx, id) {
  const s = await get(`/api/network/subnets/${id}`);
  document.title = s.cidr;
  const mayChange = can('network', 'change');
  const tab = ctx.query.tab || pref(ctx, 'subnet.tab', 'addresses');
  const page = h('div', { class: 'page fp-page-wide' });
  page.append(h('p', { class: 'fp-crumb small' }, h('a', { href: '#/network' }, 'Network'), ' / '),
    pageHead(s.cidr, [s.name, s.gateway ? `gateway ${s.gateway}` : '', `${s.size} usable addresses, ${s.first} to ${s.last}`].filter(Boolean).join(' · '), [
      mayChange ? btn('Reserve an address', 'lock', () => addressDialog(ctx, s), 'primary') : null,
      mayChange && s.v === 4 && s.size <= 4096 ? btn('Scan the subnet', 'search', () => scan(ctx, s)) : null,
      mayChange ? btn('Change', 'sliders', () => subnetDialog(ctx, s)) : null,
      mayChange ? btn('Delete', 'trash', async () => {
        if (!(await dialog(`Delete ${s.cidr}`, [h('p', {}, 'Its pools and recorded addresses go with it. Hosts keep their addresses.')], { ok: 'Delete the subnet', okClass: 'danger', onOk: () => call(() => api.del(`/api/network/subnets/${s.id}`)) }))) return;
        forgetChoices(); location.hash = '#/network';
      }, 'ghost') : null
    ].filter(Boolean)));
  const body = h('div', {});
  page.append(tabs([['addresses', 'Addresses'], ['pools', 'Pools'], ['settings', 'Settings for hosts']], tab, t => { ctx.store.setPref('subnet.tab', t); draw(t); }), body);
  main.append(page);
  const draw = t => {
    body.innerHTML = '';
    if (t === 'pools') drawPools(ctx, body, s);
    else if (t === 'settings') body.append(h('dl', { class: 'kv' },
      h('dt', {}, 'Gateway'), h('dd', { class: 'mono' }, s.gateway || '–'),
      h('dt', {}, 'DNS servers'), h('dd', { class: 'mono' }, (s.dns || []).join(', ') || '–'),
      h('dt', {}, 'Search domains'), h('dd', { class: 'mono' }, (s.search_domains || []).join(', ') || '–'),
      h('dt', {}, 'Time servers'), h('dd', { class: 'mono' }, (s.ntp || []).join(', ') || '–'),
      h('dt', {}, 'Description'), h('dd', {}, s.description || '–')));
    else drawAddresses(ctx, body, s);
  };
  draw(tab);
}

function ipNum(ip) { return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0); }
function numIp(n) { return [24, 16, 8, 0].map(b => Math.floor(n / 2 ** b) % 256).join('.'); }

function drawAddresses(ctx, body, s) {
  const byIp = new Map(s.addresses.map(a => [a.ip, a]));
  if (s.v === 4 && s.size <= 1024) {
    const first = ipNum(s.first), poolOf = n => s.pools.find(p => n >= ipNum(p.first) && n <= ipNum(p.last));
    const grid = h('div', { class: 'fp-ipmap', role: 'grid', 'aria-label': `Addresses of ${s.cidr}` });
    for (let i = 0; i < s.size; i++) {
      const n = first + i, ip = numIp(n), a = byIp.get(ip), pool = poolOf(n);
      const st = ip === s.gateway ? 'gateway' : a ? a.state : 'free';
      const title = `${ip}: ${st === 'gateway' ? 'the gateway' : st === 'free' ? 'free' : `${STATES[st]}${a.hostname ? `, ${a.hostname}` : ''}`}${pool ? ` · pool ${pool.name}` : ''}`;
      grid.append(h('button', { type: 'button', class: `fp-ip ip-${st}${pool ? ' in-pool' : ''}`, title, 'aria-label': title,
        onclick: () => { if (st === 'gateway') return; if (a) addressInfo(ctx, s, a); else if (can('network', 'change')) addressDialog(ctx, s, ip); } }, String(n % 256)));
    }
    body.append(h('div', { class: 'fp-legend small' }, ['free', 'assigned', 'reserved', 'discovered', 'conflict', 'gateway'].map(k => h('span', {}, h('i', { class: `fp-ip ip-${k}` }), { free: 'Free', gateway: 'Gateway', ...STATES }[k])), h('span', {}, h('i', { class: 'fp-ip ip-free in-pool' }), 'In a pool')), grid);
  }
  if (!s.addresses.length) { body.append(empty('No address recorded yet. Addresses of hosts are recorded on their own; reserve others here or scan the subnet.')); return; }
  body.append(h('h2', { class: 'fp-sec' }, 'Recorded addresses'), table(['Address', 'State', 'Host', 'MAC', 'Note', 'Seen'], s.addresses.map(a => h('tr', {},
    h('td', {}, h('a', { href: 'javascript:void 0', class: 'mono', onclick: () => addressInfo(ctx, s, a) }, a.ip)), h('td', {}, h('span', { class: `fp-state ${a.state === 'assigned' ? 'ok' : a.state === 'conflict' ? 'bad' : a.state === 'discovered' ? 'wait' : 'idle'}` }, STATES[a.state] || a.state)),
    h('td', {}, a.host_id ? h('a', { href: `#/hosts/${a.host_id}` }, a.hostname) : a.hostname || '–'), h('td', { class: 'mono' }, a.mac || '–'), h('td', { class: 'muted' }, a.note || ''), h('td', { class: 'muted' }, a.last_seen_at ? when(a.last_seen_at) : '–')))));
}

async function addressInfo(ctx, s, a) {
  const mayChange = can('network', 'change');
  const state = select(Object.entries(STATES), a.state, { disabled: !mayChange });
  const hostname = input({ value: a.hostname || '', disabled: !mayChange || !!a.host_id });
  const mac = input({ mono: true, value: a.mac || '', disabled: !mayChange, placeholder: '52:54:00:12:34:56' });
  const note = input({ value: a.note || '', disabled: !mayChange });
  const body = [h('div', { class: 'fp-grid2' }, field('State', state), field('Host name', hostname, a.host_id ? 'The address of a host in FleetPilot.' : '')), h('div', { class: 'fp-grid2' }, field('MAC address', mac), field('Note', note))];
  if (mayChange) body.push(h('div', { class: 'row' }, btn('Release the address', 'trash', async () => {
    await call(() => api.del(`/api/network/addresses/${a.id}`)); document.querySelector('dialog.dlg')?.close(); document.querySelector('dialog.dlg')?.remove(); toast(`${a.ip} released`); ctx.rerender();
  }, 'ghost')));
  const r = await dialog(a.ip, body, mayChange ? { ok: 'Save', onOk: () => call(() => api.patch(`/api/network/addresses/${a.id}`, { state: state.value, hostname: hostname.value, mac: mac.value, note: note.value })) } : {});
  if (r && mayChange) ctx.rerender();
}

async function addressDialog(ctx, s, ip = '') {
  const addr = input({ mono: true, value: ip, placeholder: s.first });
  const hostname = input({ placeholder: 'printer-2' });
  const mac = input({ mono: true, placeholder: '52:54:00:12:34:56' });
  const note = input({ placeholder: 'What it is for' });
  const nextBtn = btn('Take the next free one', 'search', async () => {
    const r = await call(() => api.post('/api/network/next', { subnetId: s.id })).catch(() => null);
    if (r) addr.value = r.ip;
  }, 'ghost');
  const r = await dialog(`Reserve an address in ${s.cidr}`, [h('div', { class: 'row' }, field('Address', addr), nextBtn), h('div', { class: 'fp-grid2' }, field('Host name', hostname), field('MAC address', mac)), field('Note', note)], {
    ok: 'Reserve it', onOk: () => call(() => api.post(`/api/network/subnets/${s.id}/addresses`, { ip: addr.value.trim(), state: 'reserved', hostname: hostname.value, mac: mac.value, note: note.value }))
  });
  if (r) ctx.rerender();
}

function drawPools(ctx, body, s) {
  const mayChange = can('network', 'change');
  body.append(h('p', { class: 'muted small' }, 'A pool is a range of addresses FleetPilot gives out to hosts, one after another, for example in the IP address step of a take-over.'));
  if (s.pools.length) body.append(table(['Pool', 'From', 'To', 'Purpose', ''], s.pools.map(p => h('tr', {}, h('td', {}, p.name), h('td', { class: 'mono' }, p.first), h('td', { class: 'mono' }, p.last), h('td', { class: 'muted' }, p.purpose || ''),
    h('td', {}, mayChange ? btn('Delete', '', async () => { if (await dialog(`Delete the pool ${p.name}`, [h('p', {}, 'Addresses given out from it stay as they are.')], { ok: 'Delete the pool', okClass: 'danger', onOk: () => call(() => api.del(`/api/network/pools/${p.id}`)) })) { forgetChoices(); ctx.rerender(); } }, 'ghost') : null)))));
  else body.append(empty('No pools yet.'));
  if (!mayChange) return;
  body.append(h('div', { class: 'row', style: { marginTop: '12px' } }, btn('Add a pool', 'plus', async () => {
    const name = input({ placeholder: 'Servers' }), first = input({ mono: true, placeholder: s.first }), last = input({ mono: true, placeholder: s.last }), purpose = input({ placeholder: 'Static addresses for new servers' });
    const r = await dialog('Add a pool', [field('Name', name), h('div', { class: 'fp-grid2' }, field('From', first), field('To', last)), field('Purpose', purpose)], {
      ok: 'Add the pool', onOk: () => call(() => api.post(`/api/network/subnets/${s.id}/pools`, { name: name.value, first: first.value.trim(), last: last.value.trim(), purpose: purpose.value }))
    });
    if (r) { forgetChoices(); ctx.rerender(); }
  })));
}

async function scan(ctx, s) {
  const r = await call(() => api.post(`/api/network/subnets/${s.id}/scan`, {})).catch(() => null);
  if (!r) return;
  toast('The scan runs. Found addresses are recorded as they answer.');
  const t = setInterval(async () => {
    const j = await api.get(`/api/network/jobs/${r.job}`).catch(() => null);
    if (!j || ['done', 'failed', 'cancelled'].includes(j.status)) {
      clearInterval(t);
      if (j?.status === 'done') { toast(j.result?.skipped || `Scan done: ${plural(j.result?.found ?? 0, 'address answers', 'addresses answer')}`); if (location.hash.startsWith(`#/network/${s.id}`)) ctx.rerender(); }
      else if (j) toast(`The scan stopped: ${j.error || j.status}`);
    }
  }, 2000);
  ctx.onLeave(() => clearInterval(t));
}
