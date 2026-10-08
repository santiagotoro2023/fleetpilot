// FleetPilot API: IP address management.
//   GET /api/network                       subnets with VLANs and use, and the VLANs
//   POST /api/network/vlans                PATCH|DELETE /api/network/vlans/:id
//   POST /api/network/subnets              GET|PATCH|DELETE /api/network/subnets/:id
//   POST /api/network/subnets/:id/pools    DELETE /api/network/pools/:id
//   GET /api/network/pools                 every pool (for workflow steps)
//   POST /api/network/subnets/:id/addresses  { ip, state, hostId, hostname, note }
//   PATCH|DELETE /api/network/addresses/:id
//   POST /api/network/next                 { poolId | subnetId, reserve, hostname }: the next free address
//   POST /api/network/check                { ip }: known, used by a host, answering?
//   POST /api/network/subnets/:id/scan     probes every address (a job); found ones are recorded
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { record } from '../lib/audit.mjs';
import { need } from '../lib/access.mjs';
import { jobs } from '../lib/jobs.mjs';
import { checkAddress, contains, formatIp, nextFree, parseCidr, parseIp, probe, usable } from '../lib/ipam.mjs';
import { getSetting } from './settings.mjs';

const isId = v => /^\d+$/.test(String(v ?? ''));
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const ipList = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean).map(s => { if (!parseIp(s)) throw httpError(400, 'bad_ip', `${s} is not an IP address.`); return s; }).slice(0, 10);
const nameList = v => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map(s => String(s).trim()).filter(Boolean).map(s => { if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(s)) throw httpError(400, 'bad_value', `${s} is not a domain or host name.`); return s; }).slice(0, 10);

async function subnetById(id) {
  if (!isId(id)) throw httpError(404, 'not_found', 'There is no such subnet.');
  const [s] = await query('select * from subnets where id = $1', [id]);
  if (!s) throw httpError(404, 'not_found', 'There is no such subnet.');
  return s;
}

function subnetValues(b, cur = {}) {
  const cidrIn = 'cidr' in b ? parseCidr(b.cidr) : parseCidr(cur.cidr);
  if (!cidrIn) throw httpError(400, 'bad_cidr', 'Write the subnet like 10.20.0.0/24.');
  if (cidrIn.v === 4 && cidrIn.prefix < 16) throw httpError(400, 'too_big', 'IPv4 subnets can be at most a /16.');
  const gateway = 'gateway' in b ? (str(b.gateway, 45) || null) : cur.gateway;
  if (gateway) { const g = parseIp(gateway); if (!g || !contains(cidrIn, g)) throw httpError(400, 'bad_gateway', 'The gateway must be an address inside the subnet.'); }
  return {
    cidr: cidrIn.cidr, name: 'name' in b ? str(b.name, 80) : cur.name || '', gateway,
    vlan_id: 'vlanId' in b ? (isId(b.vlanId) ? String(b.vlanId) : null) : cur.vlan_id, site_id: 'siteId' in b ? (isId(b.siteId) ? String(b.siteId) : null) : cur.site_id,
    dns: 'dns' in b ? ipList(b.dns) : cur.dns || [], search_domains: 'search' in b ? nameList(b.search) : cur.search_domains || [], ntp: 'ntp' in b ? nameList(b.ntp) : cur.ntp || [],
    description: 'description' in b ? str(b.description, 500) : cur.description || ''
  };
}

jobs.define('network.scan', async job => {
  const s = await subnetById(job.payload.subnetId);
  const c = parseCidr(s.cidr);
  const [first, last] = usable(c);
  if (last - first > 4096n) return { skipped: 'Only subnets with at most 4096 addresses are scanned.' };
  let found = 0, done = 0;
  const all = []; for (let n = first; n <= last; n++) all.push(formatIp(c.v, n));
  for (let i = 0; i < all.length && !job.signal.aborted; i += 64) {
    const part = all.slice(i, i + 64);
    const res = await Promise.all(part.map(ip => probe(ip, { timeout: 500 })));
    for (const [k, ip] of part.entries()) {
      if (!res[k]) continue;
      found++;
      await query(`insert into addresses (subnet_id, ip, state, note, last_seen_at) values ($1, $2, 'discovered', 'Found by a scan', now())
        on conflict (ip) do update set last_seen_at = now()`, [s.id, ip]);
    }
    done += part.length;
    await job.progress({ done, total: all.length, found });
  }
  return { total: all.length, found };
});

export default function network(app) {
  app.get('/api/network', async ctx => {
    await need(ctx, 'network', 'view');
    const subnets = await query(`select s.id::text, s.cidr, s.name, s.gateway, s.dns, s.search_domains, s.ntp, s.description, s.vlan_id::text, s.site_id::text, v.vid, v.name as vlan_name, g.name as site_name,
      (select count(*)::int from addresses a where a.subnet_id = s.id and a.state = 'assigned') as assigned,
      (select count(*)::int from addresses a where a.subnet_id = s.id and a.state = 'reserved') as reserved,
      (select count(*)::int from addresses a where a.subnet_id = s.id and a.state in ('discovered', 'conflict')) as discovered,
      (select coalesce(json_agg(json_build_object('id', p.id::text, 'name', p.name, 'first', host(p.first_ip), 'last', host(p.last_ip), 'purpose', p.purpose) order by p.first_ip), '[]') from pools p where p.subnet_id = s.id) as pools
      from subnets s left join vlans v on v.id = s.vlan_id left join groups g on g.id = s.site_id order by s.cidr`);
    for (const s of subnets) { const c = parseCidr(s.cidr); const [a, b] = usable(c); s.size = Number(b - a + 1n > 1000000000n ? 1000000000n : b - a + 1n); }
    const vlans = await query(`select v.id::text, v.vid, v.name, v.description, v.site_id::text, g.name as site_name, (select count(*)::int from subnets s where s.vlan_id = v.id) as subnets
      from vlans v left join groups g on g.id = v.site_id order by g.name nulls first, v.vid`);
    return { subnets, vlans };
  });

  // ------------------------------------------------------------ VLANs
  app.post('/api/network/vlans', async ctx => {
    await need(ctx, 'network', 'change');
    const b = ctx.body || {};
    const vid = Number(b.vid);
    if (!(Number.isInteger(vid) && vid >= 1 && vid <= 4094)) throw httpError(400, 'bad_vid', 'A VLAN id is a number from 1 to 4094.');
    const rows = await query('insert into vlans (site_id, vid, name, description) values ($1, $2, $3, $4) on conflict do nothing returning id', [isId(b.siteId) ? b.siteId : null, vid, str(b.name, 80), str(b.description, 500)]);
    if (!rows.length) throw httpError(409, 'vlan_taken', `VLAN ${vid} exists already at this site.`);
    await record(ctx, 'vlan.created', { target: { type: 'vlan', id: rows[0].id, name: `VLAN ${vid} ${str(b.name, 80)}`.trim() } });
    return { status: 201, body: { id: String(rows[0].id) } };
  });
  app.patch('/api/network/vlans/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const [v] = await query('select * from vlans where id = $1', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!v) throw httpError(404, 'not_found', 'There is no such VLAN.');
    const b = ctx.body || {};
    const vid = 'vid' in b ? Number(b.vid) : v.vid;
    if (!(Number.isInteger(vid) && vid >= 1 && vid <= 4094)) throw httpError(400, 'bad_vid', 'A VLAN id is a number from 1 to 4094.');
    try { await query('update vlans set vid = $2, name = $3, description = $4, site_id = $5 where id = $1', [v.id, vid, 'name' in b ? str(b.name, 80) : v.name, 'description' in b ? str(b.description, 500) : v.description, 'siteId' in b ? (isId(b.siteId) ? b.siteId : null) : v.site_id]); }
    catch (e) { if (e.code === '23505') throw httpError(409, 'vlan_taken', `VLAN ${vid} exists already at this site.`); throw e; }
    await record(ctx, 'vlan.changed', { target: { type: 'vlan', id: v.id, name: `VLAN ${vid}` } });
    return null;
  });
  app.del('/api/network/vlans/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const [v] = await query('delete from vlans where id = $1 returning *', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!v) throw httpError(404, 'not_found', 'There is no such VLAN.');
    await record(ctx, 'vlan.deleted', { target: { type: 'vlan', id: v.id, name: `VLAN ${v.vid}` } });
    return null;
  });

  // ------------------------------------------------------------ Subnets
  app.post('/api/network/subnets', async ctx => {
    await need(ctx, 'network', 'change');
    const v = subnetValues(ctx.body || {});
    const overlap = await query('select cidr from subnets where cidr && $1::cidr', [v.cidr]);
    if (overlap.length) throw httpError(409, 'overlap', `${v.cidr} overlaps ${overlap[0].cidr}.`);
    const [row] = await query(`insert into subnets (cidr, name, gateway, vlan_id, site_id, dns, search_domains, ntp, description) values ($1, $2, $3, $4, $5, $6::inet[], $7, $8, $9) returning id`,
      [v.cidr, v.name, v.gateway, v.vlan_id, v.site_id, v.dns, v.search_domains, v.ntp, v.description]);
    // Hosts that are already in this subnet get their address recorded
    await query(`insert into addresses (subnet_id, ip, state, host_id, hostname, note) select $1, h.address::inet, 'assigned', h.id, h.name, 'The address of the host'
      from hosts h where h.address ~ '^[0-9.]+$' and h.address::inet << $2::cidr on conflict (ip) do nothing`, [row.id, v.cidr]);
    await record(ctx, 'subnet.created', { target: { type: 'subnet', id: row.id, name: v.cidr } });
    return { status: 201, body: { id: String(row.id) } };
  });

  app.get('/api/network/subnets/:id', async ctx => {
    await need(ctx, 'network', 'view');
    const s = await subnetById(ctx.params.id);
    const addresses = await query(`select a.id::text, host(a.ip) as ip, a.state, a.host_id::text, coalesce(h.name, a.hostname) as hostname, a.mac, a.note, a.last_seen_at
      from addresses a left join hosts h on h.id = a.host_id where a.subnet_id = $1 order by a.ip`, [s.id]);
    const pools = await query('select id::text, name, host(first_ip) as first, host(last_ip) as last, purpose from pools where subnet_id = $1 order by first_ip', [s.id]);
    const c = parseCidr(s.cidr);
    const [a, b] = usable(c);
    return { ...s, id: String(s.id), vlan_id: s.vlan_id && String(s.vlan_id), site_id: s.site_id && String(s.site_id), dns: (s.dns || []).map(String), addresses, pools, first: formatIp(c.v, a), last: formatIp(c.v, b), size: Number(b - a + 1n > 65536n ? 65536n : b - a + 1n), v: c.v };
  });

  app.patch('/api/network/subnets/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const s = await subnetById(ctx.params.id);
    const b = { ...(ctx.body || {}) };
    delete b.cidr;   // the network itself never changes: a new subnet instead
    const v = subnetValues(b, { ...s, dns: (s.dns || []).map(String) });
    await query('update subnets set name = $2, gateway = $3, vlan_id = $4, site_id = $5, dns = $6::inet[], search_domains = $7, ntp = $8, description = $9, updated_at = now() where id = $1',
      [s.id, v.name, v.gateway, v.vlan_id, v.site_id, v.dns, v.search_domains, v.ntp, v.description]);
    await record(ctx, 'subnet.changed', { target: { type: 'subnet', id: s.id, name: s.cidr }, changes: Object.keys(b) });
    return null;
  });

  app.del('/api/network/subnets/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const s = await subnetById(ctx.params.id);
    const [c] = await query("select count(*)::int as n from addresses where subnet_id = $1 and state = 'assigned'", [s.id]);
    if (c.n) throw httpError(409, 'in_use', `${c.n} addresses of ${s.cidr} belong to hosts. Release them first.`);
    await query('delete from subnets where id = $1', [s.id]);
    await record(ctx, 'subnet.deleted', { target: { type: 'subnet', id: s.id, name: s.cidr } });
    return null;
  });

  // ------------------------------------------------------------ Pools
  app.get('/api/network/pools', async ctx => {
    await need(ctx, 'network', 'view');
    return query(`select p.id::text, p.name, host(p.first_ip) as first, host(p.last_ip) as last, p.purpose, s.cidr, s.name as subnet from pools p join subnets s on s.id = p.subnet_id order by s.cidr, p.first_ip`);
  });
  app.post('/api/network/subnets/:id/pools', async ctx => {
    await need(ctx, 'network', 'change');
    const s = await subnetById(ctx.params.id);
    const b = ctx.body || {};
    const c = parseCidr(s.cidr), f = parseIp(b.first), l = parseIp(b.last);
    if (!f || !l || !contains(c, f) || !contains(c, l) || f.n > l.n) throw httpError(400, 'bad_range', `The range must be inside ${s.cidr}, from the lower to the higher address.`);
    const name = str(b.name, 80) || `${b.first} to ${b.last}`;
    const overlap = await query('select name from pools where subnet_id = $1 and first_ip <= $3::inet and last_ip >= $2::inet', [s.id, b.first, b.last]);
    if (overlap.length) throw httpError(409, 'overlap', `This range overlaps the pool ${overlap[0].name}.`);
    const [row] = await query('insert into pools (subnet_id, name, first_ip, last_ip, purpose) values ($1, $2, $3, $4, $5) returning id', [s.id, name, b.first, b.last, str(b.purpose, 200)]);
    await record(ctx, 'pool.created', { target: { type: 'pool', id: row.id, name }, subnet: s.cidr });
    return { status: 201, body: { id: String(row.id) } };
  });
  app.del('/api/network/pools/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const [p] = await query('delete from pools where id = $1 returning *', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!p) throw httpError(404, 'not_found', 'There is no such pool.');
    await record(ctx, 'pool.deleted', { target: { type: 'pool', id: p.id, name: p.name } });
    return null;
  });

  // ------------------------------------------------------------ Addresses
  app.post('/api/network/subnets/:id/addresses', async ctx => {
    await need(ctx, 'network', 'change');
    const s = await subnetById(ctx.params.id);
    const b = ctx.body || {};
    const ip = parseIp(b.ip);
    if (!ip || !contains(parseCidr(s.cidr), ip)) throw httpError(400, 'bad_ip', `The address must be inside ${s.cidr}.`);
    const state = ['assigned', 'reserved'].includes(b.state) ? b.state : 'reserved';
    const hostId = state === 'assigned' && isId(b.hostId) ? String(b.hostId) : null;
    const rows = await query(`insert into addresses (subnet_id, ip, state, host_id, hostname, mac, note) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (ip) do update set state = $3, host_id = $4, hostname = $5, mac = $6, note = $7, updated_at = now() where addresses.state in ('discovered', 'conflict') returning id`,
    [s.id, b.ip, state, hostId, str(b.hostname, 253), str(b.mac, 40), str(b.note, 500)]);
    if (!rows.length) throw httpError(409, 'address_taken', `${b.ip} is in use already.`);
    await record(ctx, `address.${state}`, { target: { type: 'address', id: rows[0].id, name: b.ip }, hostname: b.hostname });
    return { status: 201, body: { id: String(rows[0].id) } };
  });
  app.patch('/api/network/addresses/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const [a] = await query('select * from addresses where id = $1', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!a) throw httpError(404, 'not_found', 'There is no such address.');
    const b = ctx.body || {};
    const state = ['assigned', 'reserved', 'discovered', 'conflict'].includes(b.state) ? b.state : a.state;
    await query('update addresses set state = $2, hostname = $3, mac = $4, note = $5, host_id = $6, updated_at = now() where id = $1',
      [a.id, state, 'hostname' in b ? str(b.hostname, 253) : a.hostname, 'mac' in b ? str(b.mac, 40) : a.mac, 'note' in b ? str(b.note, 500) : a.note, 'hostId' in b ? (isId(b.hostId) ? b.hostId : null) : a.host_id]);
    await record(ctx, 'address.changed', { target: { type: 'address', id: a.id, name: String(a.ip) } });
    return null;
  });
  app.del('/api/network/addresses/:id', async ctx => {
    await need(ctx, 'network', 'change');
    const [a] = await query('delete from addresses where id = $1 returning id, host(ip) as ip', [isId(ctx.params.id) ? ctx.params.id : 0]);
    if (!a) throw httpError(404, 'not_found', 'There is no such address.');
    await record(ctx, 'address.released', { target: { type: 'address', id: a.id, name: a.ip } });
    return null;
  });

  app.post('/api/network/next', async ctx => {
    const b = ctx.body || {};
    await need(ctx, 'network', b.reserve ? 'change' : 'view');
    const live = await getSetting('network.liveCheck');
    const r = await nextFree({ poolId: isId(b.poolId) ? b.poolId : null, subnetId: isId(b.subnetId) ? b.subnetId : null, liveCheck: live, claim: null, skip: Math.min(1000, Number(b.skip) || 0) });
    if (b.reserve) {
      await query("insert into addresses (subnet_id, ip, state, hostname, note) values ($1, $2, 'reserved', $3, $4)", [r.subnetId, r.ip, str(b.hostname, 253), str(b.note, 500) || `Reserved by ${ctx.user.username}`]);
      await record(ctx, 'address.reserved', { target: { type: 'address', name: r.ip }, hostname: b.hostname });
    }
    return { ...r, checked: live };
  });

  app.post('/api/network/check', async ctx => {
    await need(ctx, 'network', 'view');
    return checkAddress(str(ctx.body?.ip, 45), { live: await getSetting('network.liveCheck') });
  });

  app.post('/api/network/subnets/:id/scan', async ctx => {
    await need(ctx, 'network', 'change');
    const s = await subnetById(ctx.params.id);
    const id = await jobs.enqueue('network.scan', { subnetId: String(s.id) }, { dedupeKey: `scan:${s.id}` });
    await record(ctx, 'subnet.scanned', { target: { type: 'subnet', id: s.id, name: s.cidr } });
    return { status: 202, body: { job: id } };
  });
  app.get('/api/network/jobs/:id', async ctx => {
    await need(ctx, 'network', 'view');
    const j = await jobs.get(isId(ctx.params.id) ? ctx.params.id : 0);
    if (!j || !j.kind.startsWith('network.')) throw httpError(404, 'not_found', 'There is no such job.');
    return { status: j.status, progress: j.progress, result: j.result, error: j.error };
  });
}
