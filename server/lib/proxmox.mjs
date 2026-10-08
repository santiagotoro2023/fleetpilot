// FleetPilot: Proxmox VE. Lists the virtual machines and containers of a cluster with an API
// token, and their addresses (from the QEMU guest agent or the container's interfaces).
// Self-signed certificates are fine when their fingerprint is pinned.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';


/** GET a path of the Proxmox API: resolves the "data" of the answer */
export function pveGet(source, path, { token, timeout = 15000 } = {}) {
  const url = new URL(`/api2/json${path}`, source.url);
  const lib = url.protocol === 'https:' ? https : http;
  const pin = String(source.fingerprint || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET', timeout,
      headers: { Authorization: `PVEAPIToken=${source.token_id}=${token}`, Accept: 'application/json' },
      ...(url.protocol === 'https:' ? {
        rejectUnauthorized: source.verify_tls && !pin,
        checkServerIdentity: (host, cert) => {
          if (!pin) return source.verify_tls ? tls.checkServerIdentity(host, cert) : undefined;
          const fp = String(cert.fingerprint256 || '').replace(/:/g, '').toUpperCase();
          if (fp !== pin) return new Error(`The certificate of ${host} has the fingerprint ${cert.fingerprint256}, not the one you gave.`);
          return undefined;
        }
      } : {})
    }, res => {
      let body = '';
      res.on('data', d => { body += d; if (body.length > 20e6) req.destroy(new Error('The answer is too large.')); });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Proxmox refused the token: check the token id and secret.'));
        if (res.statusCode === 403) return reject(new Error('The token may not read this (give it the role PVEAuditor on /).'));
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`Proxmox answered ${res.statusCode} for ${path}.`), { status: res.statusCode }));
        try { resolve(JSON.parse(body).data); } catch { reject(new Error('Proxmox sent an answer that is not JSON.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url.host} did not answer in time.`)));
    req.on('error', e => reject(e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || e.code === 'SELF_SIGNED_CERT_IN_CHAIN' || e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      ? new Error('The certificate of Proxmox is self-signed: give its SHA-256 fingerprint, or switch off the check.') : e));
    req.end();
  });
}

/** The fingerprint (SHA-256) of the certificate a server shows, to pin it */
export function fetchFingerprint(urlText) {
  const url = new URL(urlText);
  return new Promise((resolve, reject) => {
    const s = https.request(url, { method: 'HEAD', rejectUnauthorized: false, timeout: 10000 }, res => { res.resume(); resolve(s.socket?.getPeerCertificate?.()?.fingerprint256 || ''); });
    s.on('socket', sock => sock.on('secureConnect', () => { const fp = sock.getPeerCertificate()?.fingerprint256; if (fp) { resolve(fp); s.destroy(); } }));
    s.on('timeout', () => s.destroy(new Error('No answer.')));
    s.on('error', e => (e.message === 'socket hang up' ? null : reject(e)));
    s.end();
  });
}

const ipv4 = s => /^\d+\.\d+\.\d+\.\d+$/.test(s) && !s.startsWith('127.') && !s.startsWith('169.254.');

/** Every VM and container: [{ externalId, node, name, type, status, tags, ips, os }] */
export async function listVms(source, token) {
  const res = await pveGet(source, '/cluster/resources?type=vm', { token });
  const vms = (res || []).filter(r => (r.type === 'qemu' || r.type === 'lxc') && !r.template);
  const out = [];
  await Promise.all(vms.map(async v => {
    const item = { externalId: `${v.type}/${v.vmid}`, vmid: v.vmid, node: v.node, name: String(v.name || `vm${v.vmid}`), type: v.type, status: v.status || '', tags: String(v.tags || '').split(/[;,]/).filter(Boolean), ips: [], os: '' };
    if (v.status === 'running') {
      try {
        if (v.type === 'qemu') {
          const net = await pveGet(source, `/nodes/${encodeURIComponent(v.node)}/qemu/${v.vmid}/agent/network-get-interfaces`, { token, timeout: 8000 });
          item.ips = (net?.result || []).filter(i => i.name !== 'lo').flatMap(i => (i['ip-addresses'] || []).map(a => a['ip-address'])).filter(ipv4);
          const os = await pveGet(source, `/nodes/${encodeURIComponent(v.node)}/qemu/${v.vmid}/agent/get-osinfo`, { token, timeout: 8000 }).catch(() => null);
          item.os = os?.result?.['pretty-name'] || '';
        } else {
          const net = await pveGet(source, `/nodes/${encodeURIComponent(v.node)}/lxc/${v.vmid}/interfaces`, { token, timeout: 8000 });
          item.ips = (net || []).filter(i => i.name !== 'lo').map(i => String(i.inet || '').split('/')[0]).filter(ipv4);
        }
      } catch { /* no guest agent: no addresses */ }
    }
    out.push(item);
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

