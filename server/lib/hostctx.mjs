// FleetPilot: everything a run needs to know about a host: its groups from the site down, its
// desired state (the templates of the site, the groups and the host, merged), the variables
// FleetPilot fills in, the secrets its settings need, and how FleetPilot logs in.
import { query } from '../core/db.mjs';
import { mergeDefinitions, needsOf, stateHash } from './compile.mjs';
import { derivedSalt, sha512crypt } from './crypt.mjs';
import { fleetKey, generatePassword, hostCa, hostSecret, readSecret, sharedSecret, userCa, wireguardKeys } from './vault.mjs';
import { signKey } from './ssh.mjs';

/** All groups as a map, with the path from the site down */
export async function groupPaths() {
  const rows = await query('select id, parent_id, kind, name from groups');
  const by = new Map(rows.map(r => [String(r.id), r]));
  const path = id => { const out = []; let g = by.get(String(id)); const seen = new Set(); while (g && !seen.has(g.id)) { seen.add(g.id); out.unshift(g); g = by.get(String(g.parent_id)); } return out; };
  return { by, path };
}

/** The templates that apply to a host, from the least to the most specific: [{ template, version, definition, via }] */
export async function templatesOf(host, paths) {
  const chain = host.group_id ? paths.path(host.group_id) : [];
  const ids = chain.map(g => String(g.id));
  const rows = await query(`select a.group_id, a.host_id, a.position, a.pinned_version, t.id as template_id, t.name, t.current_version, v.version, v.definition
    from assignments a join templates t on t.id = a.template_id and not t.archived
    join template_versions v on v.template_id = t.id and v.version = coalesce(a.pinned_version, t.current_version)
    where a.group_id = any($1::bigint[]) or a.host_id = $2 order by a.position, a.id`, [ids, host.id]);
  const rank = r => (r.host_id ? ids.length : ids.indexOf(String(r.group_id)));
  return rows.sort((a, b) => rank(a) - rank(b) || a.position - b.position).map(r => ({
    template: String(r.template_id), name: r.name, version: r.version, latest: r.current_version, pinned: r.pinned_version, definition: r.definition,
    via: r.host_id ? { type: 'host' } : { type: 'group', id: String(r.group_id), name: chain.find(g => String(g.id) === String(r.group_id))?.name }
  }));
}

/** The merged desired state of a host: { merged, templates, hash } */
export async function desiredState(host, paths) {
  const templates = await templatesOf(host, paths || await groupPaths());
  const merged = mergeDefinitions(templates.map(t => t.definition));
  return { merged, templates, hash: stateHash(merged) };
}

/** The variables FleetPilot fills in for a host ({{ fp_… }}) */
export async function hostVars(host, paths) {
  const chain = host.group_id ? paths.path(host.group_id) : [];
  const [addr] = await query(`select host(a.ip) as ip, masklen(s.cidr) as prefix, host(s.gateway) as gateway, s.dns, s.search_domains
    from addresses a join subnets s on s.id = a.subnet_id where a.host_id = $1 and a.state = 'assigned' order by (host(a.ip) = $2) desc, a.id limit 1`, [host.id, host.address]);
  const [sub] = addr ? [] : await query('select masklen(cidr) as prefix, host(gateway) as gateway, dns, search_domains from subnets where $1::inet << cidr order by masklen(cidr) desc limit 1', [/^[0-9a-f.:]+$/i.test(host.address) ? host.address : '0.0.0.0']).catch(() => []);
  const s = addr || sub;
  const domain = (s?.search_domains || [])[0] || '';
  const ip = addr ? addr.ip : (/^[0-9.]+$/.test(host.address) ? host.address : '');
  return {
    fp_name: host.name,
    fp_domain: domain,
    fp_fqdn: domain ? `${host.name}.${domain}` : host.name,
    fp_address: host.address,
    fp_ip: ip && s ? `${ip}/${s.prefix}` : '',
    fp_gateway: s?.gateway || '',
    fp_dns: (s?.dns || []).map(String),
    fp_search: s?.search_domains || [],
    fp_group: chain.at(-1)?.name || '',
    fp_site: chain.find(g => g.kind === 'site')?.name || chain[0]?.name || ''
  };
}

/** Fills the secrets a desired state needs for one host: { fp_passwords, fp_host_secret, fp_shared, fp_secret } */
export async function secretVars(host, merged) {
  const out = { fp_passwords: {}, fp_host_secret: {}, fp_shared: {}, fp_secret: {} };
  for (const n of needsOf(merged)) {
    if (n.type === 'password') {
      const s = await hostSecret(host.id, 'password', n.name, n.generate ? async () => ({ username: n.name, data: { username: n.name, password: generatePassword(24) } }) : null);
      if (s) out.fp_passwords[n.name] = sha512crypt(s.data.password, derivedSalt(`${s.id}:${s.version}`));
    } else if (n.type === 'hostSecret') {
      const s = await hostSecret(host.id, 'password', n.name, async () => ({ data: { password: generatePassword(24, false) } }));
      out.fp_host_secret[n.name] = s.data.password;
    } else if (n.type === 'wgkey') {
      const s = await hostSecret(host.id, 'token', `wireguard ${n.name}`, async () => { const k = wireguardKeys(); return { data: { token: k.privateKey }, pub: { publicKey: k.publicKey } }; });
      out.fp_host_secret[`wireguard ${n.name}`] = s.data.token;
    } else if (n.type === 'shared') {
      out.fp_shared[n.key] = await sharedSecret(n.key, n.label, n.length || 24);
    } else if (n.type === 'secret') {
      const s = await readSecret(n.id);
      if (s) out.fp_secret[n.id] = { username: s.username, ...s.data };
    }
  }
  return out;
}

/**
 * How FleetPilot logs in: as the user fleetpilot with its key and a fresh certificate, or (before
 * the take-over finished) as the user and with the key the connect step left in run state.
 */
export async function loginFor(host, runState = {}) {
  const key = await fleetKey();
  const boot = runState.connections?.[String(host.id)];
  if (boot) return { user: boot.user, become: boot.become || false, becomePassword: boot.becomePassword || '', keyFile: { privateKey: key.data.privateKey } };
  const ca = await userCa();
  const certificate = await signKey({ caPrivateKey: ca.data.privateKey, publicKey: key.public.publicKey, identity: `fleetpilot-run-${host.name}`, principals: ['fleetpilot'], validity: '+3h' });
  return { user: host.connection?.user || 'fleetpilot', become: 'sudo', keyFile: { privateKey: key.data.privateKey, certificate } };
}

/** The public keys a host must know: FleetPilot's key, its user CA, its host CA */
export async function publicKeys() {
  const [k, u, h] = await Promise.all([fleetKey(), userCa(), hostCa()]);
  return { fleetKey: k.public.publicKey, userCa: u.public.publicKey, hostCa: h.public.publicKey };
}
