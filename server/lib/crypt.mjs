// FleetPilot: SHA-512 crypt ("$6$"), the password hash format every Linux understands, for the
// passwords FleetPilot sets on hosts. The salt can be derived, so the same password gives the
// same hash and a desired state stays without drift.
import crypto from 'node:crypto';

const ITOA = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const sha = (...parts) => { const h = crypto.createHash('sha512'); for (const p of parts) h.update(p); return h.digest(); };
function repeat(buf, len) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = buf[i % buf.length]; return out; }

/** $6$<salt>$<hash> of a password (salt: up to 16 characters of [./0-9A-Za-z]) */
export function sha512crypt(password, salt = randomSalt(), rounds = 5000) {
  const p = Buffer.from(String(password), 'utf8');
  const s = Buffer.from(String(salt).slice(0, 16), 'utf8');
  const b = sha(p, s, p);
  const actx = crypto.createHash('sha512').update(p).update(s);
  actx.update(repeat(b, p.length));
  for (let n = p.length; n > 0; n >>= 1) actx.update(n & 1 ? b : p);
  const a = actx.digest();
  const dpCtx = crypto.createHash('sha512');
  for (let i = 0; i < p.length; i++) dpCtx.update(p);
  const P = repeat(dpCtx.digest(), p.length);
  const dsCtx = crypto.createHash('sha512');
  for (let i = 0; i < 16 + a[0]; i++) dsCtx.update(s);
  const S = repeat(dsCtx.digest(), s.length);
  let c = a;
  for (let i = 0; i < rounds; i++) {
    const h = crypto.createHash('sha512');
    h.update(i & 1 ? P : c);
    if (i % 3) h.update(S);
    if (i % 7) h.update(P);
    h.update(i & 1 ? c : P);
    c = h.digest();
  }
  const order = [[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10],
    [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41]];
  let out = '';
  const b64 = (b2, b1, b0, n) => { let w = (b2 << 16) | (b1 << 8) | b0; for (let i = 0; i < n; i++) { out += ITOA[w & 63]; w >>= 6; } };
  for (const [x, y, z] of order) b64(c[x], c[y], c[z], 4);
  b64(0, 0, c[63], 2);
  return `$6$${rounds === 5000 ? '' : `rounds=${rounds}$`}${s.toString()}$${out}`;
}

export function randomSalt(n = 16) { return Array.from(crypto.randomBytes(n), x => ITOA[x & 63]).join(''); }
/** A salt that is always the same for the same seed (a secret id and its version) */
export function derivedSalt(seed) { return Array.from(crypto.createHash('sha256').update(String(seed)).digest().subarray(0, 16), x => ITOA[x & 63]).join(''); }
