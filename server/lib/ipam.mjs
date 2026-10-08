// FleetPilot: IP address management. Addresses as BigInt (IPv4 and IPv6), the next free address
// of a pool (never one that is assigned, reserved or answers on the network), and a live probe.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';

export function parseIp(s) {
  const t = String(s || '').trim();
  if (net.isIPv4(t)) return { v: 4, n: t.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n) };
  if (net.isIPv6(t)) {
    let [head, tail] = t.split('::');
    const part = x => (x ? x.split(':') : []);
    let h = part(head), tl = tail === undefined ? [] : part(tail);
    // An embedded IPv4 at the end
    const fix = arr => arr.flatMap(p => (p.includes('.') ? (() => { const n = parseIp(p).n; return [(n >> 16n).toString(16), (n & 0xffffn).toString(16)]; })() : [p]));
    h = fix(h); tl = fix(tl);
    const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - tl.length).fill('0'), ...tl];
    return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return null;
}
export function formatIp(v, n) {
  if (v === 4) return [24n, 16n, 8n, 0n].map(s => String((n >> s) & 255n)).join('.');
  const g = [];
  for (let i = 7; i >= 0; i--) g.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // The longest run of zeros becomes ::
  let best = [-1, 0];
  for (let i = 0; i < 8;) { if (g[i] !== '0') { i++; continue; } let j = i; while (j < 8 && g[j] === '0') j++; if (j - i > best[1]) best = [i, j - i]; i = j; }
  if (best[1] < 2) return g.join(':');
  return `${g.slice(0, best[0]).join(':')}::${g.slice(best[0] + best[1]).join(':')}`;
}
export function parseCidr(s) {
  const [ip, len] = String(s || '').split('/');
  const a = parseIp(ip);
  const bits = a?.v === 4 ? 32 : 128;
  const l = Number(len);
  if (!a || !Number.isInteger(l) || l < 0 || l > bits) return null;
  const host = (1n << BigInt(bits - l)) - 1n;
  const network = a.n & ~host & ((1n << BigInt(bits)) - 1n);
  return { v: a.v, prefix: l, bits, network, broadcast: network | host, size: host + 1n, cidr: `${formatIp(a.v, network)}/${l}` };
}
export const contains = (c, ip) => c.v === ip.v && ip.n >= c.network && ip.n <= c.broadcast;

/** Usable host addresses of a subnet: IPv4 without the network and broadcast address (except /31, /32) */
export function usable(c) {
  if (c.v === 4 && c.prefix < 31) return [c.network + 1n, c.broadcast - 1n];
  return [c.network + (c.v === 6 ? 1n : 0n), c.broadcast];
}

/**
 * Does something answer at this address? TCP to ports that servers, Windows machines and printers
 * open (a refusal is an answer too), then ping. Not 80 and 443: transparent proxies answer those
 * for any address.
 */
export async function probe(ip, { timeout = 700 } = {}) {
  const tcp = port => new Promise(res => {
    const s = net.connect({ host: ip, port, timeout });
    const done = v => { s.destroy(); res(v); };
    s.on('connect', () => done(true));
    s.on('error', e => done(e.code === 'ECONNREFUSED'));
    s.on('timeout', () => done(false));
  });
  const results = await Promise.all([22, 445, 3389, 135, 5985, 9100].map(tcp));
  if (results.some(Boolean)) return true;
  return new Promise(res => {
    const p = spawn('ping', ['-c', '1', '-W', '1', ip], { stdio: 'ignore' });
    p.on('error', () => res(false));
    p.on('close', code => res(code === 0));
  });
}

/** The subnet an address belongs to (the most specific) */
export async function subnetOf(ip) {
  const [s] = await query('select * from subnets where $1::inet << cidr order by masklen(cidr) desc limit 1', [ip]);
  return s || null;
}

/**
 * The next free address of a pool (or of a whole subnet): not assigned, reserved or found, and
 * not answering on the network. With `claim`, it is assigned to the host at once.
 */
export async function nextFree({ poolId, subnetId, liveCheck = true, claim = null, skip = 0 }) {
  let subnet, first, last;
  if (poolId) {
    const [p] = await query('select p.*, s.cidr from pools p join subnets s on s.id = p.subnet_id where p.id = $1', [poolId]);
    if (!p) throw httpError(404, 'not_found', 'There is no such pool.');
    subnet = { id: p.subnet_id, cidr: p.cidr };
    first = parseIp(p.first_ip).n; last = parseIp(p.last_ip).n;
  } else {
    const [s] = await query('select * from subnets where id = $1', [subnetId]);
    if (!s) throw httpError(404, 'not_found', 'There is no such subnet.');
    subnet = s;
    [first, last] = usable(parseCidr(s.cidr));
  }
  const c = parseCidr(subnet.cidr);
  const taken = new Set((await query('select host(ip) as ip from addresses where subnet_id = $1', [subnet.id])).map(r => parseIp(r.ip).n));
  const gw = (await query('select host(gateway) as gw from subnets where id = $1', [subnet.id]))[0]?.gw;
  if (gw) taken.add(parseIp(gw).n);
  let tries = 0, skipped = 0;
  for (let n = first; n <= last && tries < 4096; n++) {
    if (taken.has(n)) continue;
    tries++;
    const ip = formatIp(c.v, n);
    if (liveCheck && await probe(ip)) {
      // Something answers: record it as found, so nobody gets it
      await query("insert into addresses (subnet_id, ip, state, note, last_seen_at) values ($1, $2, 'discovered', 'Answered when FleetPilot looked for a free address', now()) on conflict (ip) do nothing", [subnet.id, ip]);
      continue;
    }
    if (skipped < skip) { skipped++; continue; }
    if (claim) {
      const rows = await query(`insert into addresses (subnet_id, ip, state, host_id, hostname, note) values ($1, $2, 'assigned', $3, $4, $5) on conflict (ip) do nothing returning id`,
        [subnet.id, ip, claim.hostId || null, claim.hostname || '', claim.note || '']);
      if (!rows.length) continue;   // taken in the meantime by someone else
    }
    return { ip, prefix: c.prefix, subnetId: String(subnet.id) };
  }
  throw httpError(409, 'pool_full', 'There is no free address left in this range.');
}

/** Checks an address before it is given out: known in FleetPilot, or answering? */
export async function checkAddress(ip, { live = true } = {}) {
  const a = parseIp(ip);
  if (!a) throw httpError(400, 'bad_ip', 'This is not an IP address.');
  const [known] = await query("select a.*, h.name as host_name from addresses a left join hosts h on h.id = a.host_id where a.ip = $1::inet", [ip]);
  const hostUse = await query('select id, name from hosts where address = $1', [ip]);
  const subnet = await subnetOf(ip);
  const answers = live ? await probe(ip) : null;
  return {
    ip, subnet: subnet ? { id: String(subnet.id), cidr: subnet.cidr, name: subnet.name } : null,
    known: known ? { state: known.state, host: known.host_name || known.hostname || null, note: known.note } : null,
    hosts: hostUse.map(h => ({ id: String(h.id), name: h.name })), answers,
    free: !known && !hostUse.length && answers !== true
  };
}

/** Assigns an address to a host (the host's address in FleetPilot can follow) */
export async function assign(ip, hostId, hostname, { note = '' } = {}) {
  return tx(async c => {
    const [s] = (await c.query('select id from subnets where $1::inet << cidr order by masklen(cidr) desc limit 1', [ip])).rows;
    if (!s) throw httpError(400, 'no_subnet', 'This address is in no subnet of FleetPilot. Add the subnet first.');
    const [row] = (await c.query(`insert into addresses (subnet_id, ip, state, host_id, hostname, note) values ($1, $2, 'assigned', $3, $4, $5)
      on conflict (ip) do update set state = 'assigned', host_id = $3, hostname = $4, updated_at = now()
      where addresses.host_id is null or addresses.host_id = $3 or addresses.state = 'discovered' returning id`, [s.id, ip, hostId, hostname, note])).rows;
    if (!row) throw httpError(409, 'address_taken', `${ip} belongs to another host.`);
    return String(row.id);
  });
}
