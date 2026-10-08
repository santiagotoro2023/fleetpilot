// Signs the tests of FleetPilot in (blueprint 1.1.0, library element auth): the
// first test creates the administrator with the setup code of test/run.mjs and, when the policy
// asks for it, sets up two-factor sign-in; the session is kept in test/.output for the next tests.
//
//   const req = await apiSession(base)          req(method, path, body) → { status, body }
//   await signIn(context, base)                 a Playwright context, signed in
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TEST_USER = { username: 'admin', name: 'Test administrator', password: 'correct horse battery staple 7' };
const OUT = process.env.OUT || 'test/.output';
const FILE = path.join(OUT, 'auth-session.json');
const COOKIE = 'fleetpilot_session';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
/** The TOTP code of a secret, `step` periods from now */
export function totp(secret, step = 0) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

const saved = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = s => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ ...saved(), ...s })); };

/** A function for API calls with a signed-in session (cookie kept between test files) */
export async function apiSession(base, user = TEST_USER) {
  let cookie = saved().cookie || '';
  const req = async (method, p, body) => {
    const r = await fetch(new URL(p, base), { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set && set.startsWith(`${COOKIE}=`)) cookie = set.split(';')[0].split('=')[1];
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null), headers: r.headers };
  };
  let state = (await req('GET', '/api/auth/state')).body;
  if (!state.user) {
    if (state.setup) {
      const r = await req('POST', '/api/auth/setup', { code: process.env.FLEETPILOT_SETUP_CODE, ...user });
      if (r.status !== 201) throw new Error(`setup: ${JSON.stringify(r.body)}`);
    } else {
      let r = await req('POST', '/api/auth/login', { username: user.username, password: user.password });
      if (r.body?.totp) {
        const secret = saved().totp;
        for (const step of [0, 1]) { r = await req('POST', '/api/auth/login', { username: user.username, password: user.password, code: totp(secret, step) }); if (r.status === 200) break; }
      }
      if (r.status !== 200) throw new Error(`sign-in: ${JSON.stringify(r.body)}`);
    }
    state = (await req('GET', '/api/auth/state')).body;
  }
  if (state.user.pending.includes('totp')) {
    const s = (await req('POST', '/api/auth/totp/start')).body;
    const r = await req('POST', '/api/auth/totp/confirm', { code: totp(s.secret) });
    if (r.status !== 200) throw new Error(`two-factor setup: ${JSON.stringify(r.body)}`);
    save({ totp: s.secret });
  }
  save({ cookie });
  req.cookie = () => cookie;
  return req;
}

/** Signs a Playwright browser context in */
export async function signIn(context, base) {
  const req = await apiSession(base);
  const u = new URL(base);
  await context.addCookies([{ name: COOKIE, value: req.cookie(), domain: u.hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
}
