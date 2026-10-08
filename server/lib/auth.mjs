// Library element "auth" (blueprint 1.1.0): sign-in and accounts.
// Passwords hashed with scrypt, sessions in PostgreSQL behind an HttpOnly cookie, a password
// policy, two-factor sign-in with TOTP and recovery codes, lockouts and rate limits, and the
// first administrator created with a setup code. See .blueprint/library/auth/README.md.
//
//   import { auth, requireAdmin, requireFresh } from './lib/auth.mjs'
//   await start({ routes: [auth({ onEvent, encrypt, decrypt, policy: { totp: 'admins' } }), items] })
//
// Every /api/ route needs a signed-in user (ctx.user) except the sign-in routes themselves and the
// paths given as `open`. Users who must change their password or set up two-factor sign-in first
// only reach /api/auth/.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query, tx } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { config } from '../core/config.mjs';
import { log } from '../core/log.mjs';

const scrypt = promisify(crypto.scrypt);
const COOKIE = `${config.appId}_session`;

// ---------------------------------------------------------------- Policy
export const DEFAULT_POLICY = {
  minLength: 12,          // characters
  requireLower: false,
  requireUpper: false,
  requireDigit: false,
  requireSymbol: false,
  blockCommon: true,      // refuse well-known passwords and the user name inside the password
  history: 5,             // the last n passwords cannot be used again (0: off)
  maxAgeDays: 0,          // a password must be changed after n days (0: never)
  totp: 'none',           // two-factor sign-in required for: 'none', 'admins' or 'all'
  sessionIdleMinutes: 60, // signed out after so long without a request
  sessionMaxHours: 12,    // signed out after so long in any case
  lockoutAttempts: 5,     // wrong passwords in a row before the account waits
  lockoutMinutes: 15
};
const LIMITS = {
  minLength: [8, 128], history: [0, 24], maxAgeDays: [0, 3650], sessionIdleMinutes: [5, 1440],
  sessionMaxHours: [1, 720], lockoutAttempts: [3, 50], lockoutMinutes: [1, 1440]
};
let defaults = { ...DEFAULT_POLICY };
let cached = null;   // { at, policy }: read at most every 10 seconds

/** The policy in force: the stored one over the app's defaults over the blueprint's */
export async function getPolicy() {
  if (cached && Date.now() - cached.at < 10_000) return cached.policy;
  const [row] = await query('select policy from auth_settings where id = 1');
  cached = { at: Date.now(), policy: normalizePolicy({ ...defaults, ...(row?.policy || {}) }) };
  return cached.policy;
}
export function normalizePolicy(p) {
  const out = { ...DEFAULT_POLICY };
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (!(k in p)) continue;
    const d = DEFAULT_POLICY[k];
    if (typeof d === 'boolean') out[k] = !!p[k];
    else if (typeof d === 'number') { const [lo, hi] = LIMITS[k]; const v = Math.round(Number(p[k])); out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
    else if (k === 'totp') out[k] = ['none', 'admins', 'all'].includes(p[k]) ? p[k] : d;
  }
  return out;
}

// Well-known passwords (the most used ones of the public leak lists); longer ones are caught by the
// patterns in passwordProblems()
const COMMON = new Set(`password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword
123456789012 1234567890 12345678 123456789 1234567 qwertyuiop qwerty123 qwerty1234 qwertz123
1q2w3e4r5t6y 1qaz2wsx3edc zaq12wsx iloveyou123 letmein123 welcome123 welcome1234 admin123 admin1234
administrator changeme changeme123 sunshine123 football123 baseball123 dragon123 monkey123 master123
trustno1 princess123 starwars123 superman123 batman123 abc123456789 abcdefghijkl 111111111111
000000000000 aaaaaaaaaaaa secret123 default123 root1234 toor1234 test12345678 summer2024 winter2024
spring2024 autumn2024 summer2025 winter2025 summer2026 winter2026 company123 hallo12345678
passwort passwort123 geheim123 qwerasdfzxcv asdfghjkl123 zxcvbnm12345 mustang123 shadow123
michael123 jennifer123 hunter2hunter2`.split(/\s+/));

/** What is wrong with a new password, as sentences (empty when it is fine) */
export function passwordProblems(pw, policy, { username = '', name = '' } = {}) {
  const p = [];
  const s = String(pw || '');
  if ([...s].length < policy.minLength) p.push(`Use at least ${policy.minLength} characters.`);
  if ([...s].length > 256) p.push('Use at most 256 characters.');
  if (policy.requireLower && !/\p{Ll}/u.test(s)) p.push('Use at least one lowercase letter.');
  if (policy.requireUpper && !/\p{Lu}/u.test(s)) p.push('Use at least one uppercase letter.');
  if (policy.requireDigit && !/\d/.test(s)) p.push('Use at least one digit.');
  if (policy.requireSymbol && !/[^\p{L}\d]/u.test(s)) p.push('Use at least one character that is not a letter or digit.');
  if (policy.blockCommon) {
    const low = s.toLowerCase();
    const plain = low.replace(/[^a-z0-9]/g, '');
    if (COMMON.has(low) || COMMON.has(plain)) p.push('This password is on the lists of well-known passwords.');
    else if (new Set(low).size < 5 || '01234567890123456789abcdefghijklmnopqrstuvwxyzqwertyuiopasdfghjklzxcvbnm'.includes(low)) p.push('This password is too easy to guess.');
    else if (username && username.length >= 3 && low.includes(username.toLowerCase())) p.push('Do not use your user name in the password.');
    else if (name && name.length >= 4 && name.split(/\s+/).some(w => w.length >= 4 && low.includes(w.toLowerCase()))) p.push('Do not use your name in the password.');
  }
  return p;
}

// ---------------------------------------------------------------- Passwords
const N = 32768, R = 8, P = 1;
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pw).normalize('NFKC'), salt, 32, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [kind, n, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const key = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 });
  return crypto.timingSafeEqual(key, want);
}
// Same work for unknown users as for known ones: no hint from the answer time
const DUMMY = hashPassword(crypto.randomBytes(16).toString('hex'));

/** A readable random password: 4 groups of 5 letters and digits (about 100 bits) */
export function randomPassword() {
  const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => abc[crypto.randomInt(abc.length)];
  return Array.from({ length: 4 }, () => Array.from({ length: 5 }, pick).join('')).join('-');
}

// ---------------------------------------------------------------- TOTP (RFC 6238: SHA-1, 6 digits, 30 s)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpCode(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
export const totpCounter = (t = Date.now()) => Math.floor(t / 30_000);
/** The counter of a valid code (one step of clock drift either way), or 0 */
export function totpMatch(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  for (const d of [0, -1, 1]) {
    const counter = totpCounter(now) + d;
    if (counter < 1) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, counter)), Buffer.from(c))) return counter;
  }
  return 0;
}

// ---------------------------------------------------------------- Helpers
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let hooks = { onEvent: null, encrypt: s => s, decrypt: s => s };
const event = (ctx, action, details = {}) => { try { hooks.onEvent?.(ctx, action, details); } catch (e) { log.warn('auth event hook failed', { error: e.message }); } };

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
}
const isHttps = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || config.canonical.startsWith('https:');
function setCookie(ctx, value, maxAgeSeconds) {
  ctx.res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax${isHttps(ctx.req) ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`);
}

/** What a user may see of an account */
export const publicUser = u => ({
  id: String(u.id), username: u.username, name: u.name, email: u.email, isAdmin: u.is_admin, disabled: u.disabled,
  totpEnabled: u.totp_enabled, mustChangePassword: u.must_change_password, lastLoginAt: u.last_login_at, createdAt: u.created_at,
  locked: !!(u.locked_until && new Date(u.locked_until) > new Date())
});
const USER_COLS = 'id, username, name, email, is_admin, disabled, totp_enabled, must_change_password, last_login_at, created_at, locked_until, password_changed_at';

/** What a signed-in user still has to do before using the app: 'password', 'totp' */
function pending(u, policy) {
  const out = [];
  const aged = policy.maxAgeDays > 0 && Date.now() - new Date(u.password_changed_at).getTime() > policy.maxAgeDays * 864e5;
  if (u.must_change_password || aged) out.push('password');
  if (!u.totp_enabled && (policy.totp === 'all' || (policy.totp === 'admins' && u.is_admin))) out.push('totp');
  return out;
}

async function newSession(ctx, userId, policy, { verified = true } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`insert into auth_sessions (token_hash, user_id, expires_at, ip, user_agent, verified_at)
    values ($1, $2, now() + make_interval(hours => $3), $4, $5, ${verified ? 'now()' : 'null'})`,
  [sha(token), userId, policy.sessionMaxHours, ctx.clientIp || '', String(ctx.req.headers['user-agent'] || '').slice(0, 200)]);
  setCookie(ctx, token, policy.sessionMaxHours * 3600);
}

/** The session of a request: { session, user } or null */
async function findSession(ctx, policy) {
  const token = cookies(ctx.req)[COOKIE];
  if (!token || token.length > 100) return null;
  const [row] = await query(`select s.id as session_id, s.last_seen_at, s.verified_at, u.* from auth_sessions s join auth_users u on u.id = s.user_id
    where s.token_hash = $1 and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => $2) and not u.disabled`, [sha(token), policy.sessionIdleMinutes]);
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 30_000) await query('update auth_sessions set last_seen_at = now() where id = $1', [row.session_id]);
  return row;
}

export function requireUser(ctx) { if (!ctx.user) throw httpError(401, 'signed_out', 'Sign in first.'); return ctx.user; }
export function requireAdmin(ctx) {
  requireUser(ctx);
  if (!ctx.user.isAdmin) throw httpError(403, 'not_allowed', 'Only administrators can do this.');
  return ctx.user;
}
/** For sensitive actions: the user proved who they are (password or two-factor code) within the last minutes */
export async function requireFresh(ctx, minutes = 5) {
  requireUser(ctx);
  const [s] = await query('select verified_at from auth_sessions where id = $1', [ctx.user.sessionId]);
  if (!s?.verified_at || Date.now() - new Date(s.verified_at).getTime() > minutes * 60_000) {
    throw httpError(403, 'verify_needed', ctx.user.totpEnabled ? 'Confirm with a code from your authenticator app.' : 'Confirm with your password.');
  }
}

async function limitedIp(ip) {
  const [r] = await query("select count(*)::int as n from auth_attempts where ip = $1 and not ok and at > now() - interval '15 minutes'", [ip]);
  return r.n >= 30;
}
async function attempt(ip, username, ok) {
  await query('insert into auth_attempts (ip, username, ok) values ($1, $2, $3)', [ip, username, ok]);
  if (Math.random() < 0.02) await query("delete from auth_attempts where at < now() - interval '30 days'");
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const usernameOf = v => str(v, 63).toLowerCase();
const LOGIN_FAILED = 'The user name or password is wrong, or there were too many attempts. Try again in a few minutes.';

async function checkNewPassword(policy, pw, user) {
  const p = passwordProblems(pw, policy, { username: user.username, name: user.name });
  if (p.length) throw httpError(400, 'weak_password', p.join(' '));
  if (await verifyPassword(pw, user.password_hash)) throw httpError(400, 'password_reused', 'Choose a new password, not the current one.');
  for (const old of (user.password_history || []).slice(0, policy.history)) {
    if (await verifyPassword(pw, old)) throw httpError(400, 'password_reused', `Choose a password you did not use for your last ${policy.history} passwords.`);
  }
}
async function storePassword(c, userId, pw, policy, { mustChange = false } = {}) {
  const hash = await hashPassword(pw);
  const [u] = (await c.query('select password_hash, password_history from auth_users where id = $1', [userId])).rows;
  const history = [u.password_hash, ...(u.password_history || [])].slice(0, Math.max(policy.history, 0));
  await c.query('update auth_users set password_hash = $2, password_history = $3, password_changed_at = now(), must_change_password = $4, updated_at = now() where id = $1',
    [userId, hash, JSON.stringify(history), mustChange]);
}

function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
  return { codes, hashes: codes.map(c => sha(c)) };
}

/** The setup code for the first administrator: from the environment, or made once and kept in the database */
async function setupCode() {
  const fixed = (process.env[`${config.appId.toUpperCase().replace(/-/g, '_')}_SETUP_CODE`] || '').trim();
  if (fixed) return fixed;
  const code = Array.from({ length: 3 }, () => crypto.randomBytes(3).toString('hex')).join('-');
  const [r] = await query('update auth_settings set setup_code = coalesce(setup_code, $1) where id = 1 returning setup_code', [code]);
  return r.setup_code;
}
const noUsers = async () => (await query('select not exists (select 1 from auth_users) as none'))[0].none;

// ---------------------------------------------------------------- The routes
const PUBLIC = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/setup', '/api/auth/logout']);
// What a user who must first change the password or set up two-factor sign-in can reach
const PENDING_OK = new Set(['/api/auth/password', '/api/auth/totp/start', '/api/auth/totp/confirm']);

/**
 * The route module of the element.
 * options: onEvent(ctx, action, details) for an audit log; encrypt/decrypt for the TOTP secrets
 * (library element secrets); policy: the app's defaults; open: more paths that need no sign-in.
 */
export function auth({ onEvent, encrypt, decrypt, policy = {}, open = [] } = {}) {
  hooks = { onEvent, encrypt: encrypt || (s => s), decrypt: decrypt || (s => s) };
  defaults = { ...DEFAULT_POLICY, ...policy };
  const openPaths = new Set([...PUBLIC, ...open]);

  return async function authRoutes(app) {
    if (await noUsers()) log.warn('No administrator yet: open the app and create one with this setup code', { setup_code: await setupCode() });

    // Every API request: who is it?
    app.use(async ctx => {
      const pol = await getPolicy();
      const s = await findSession(ctx, pol);
      if (s) {
        ctx.user = { id: String(s.id), username: s.username, name: s.name, isAdmin: s.is_admin, totpEnabled: s.totp_enabled, sessionId: String(s.session_id), pending: pending(s, pol) };
      }
      if (openPaths.has(ctx.path)) return;
      if (!ctx.user) throw httpError(401, 'signed_out', 'Sign in first.');
      if (ctx.user.pending.length && !PENDING_OK.has(ctx.path)) throw httpError(403, 'setup_needed', ctx.user.pending.includes('password') ? 'Choose a new password first.' : 'Set up two-factor sign-in first.');
    });

    app.get('/api/auth/state', async ctx => {
      const pol = await getPolicy();
      const p = { minLength: pol.minLength, requireLower: pol.requireLower, requireUpper: pol.requireUpper, requireDigit: pol.requireDigit, requireSymbol: pol.requireSymbol, totp: pol.totp };
      if (!ctx.user) return { setup: await noUsers(), user: null, policy: p };
      const [u] = await query(`select ${USER_COLS} from auth_users where id = $1`, [ctx.user.id]);
      return { setup: false, user: { ...publicUser(u), pending: ctx.user.pending }, policy: p };
    });

    app.post('/api/auth/setup', async ctx => {
      const b = ctx.body || {};
      if (!(await noUsers())) throw httpError(409, 'already_set_up', 'There is an administrator already. Sign in instead.');
      if (await limitedIp(ctx.clientIp)) throw httpError(429, 'too_many', 'Too many attempts. Try again in a few minutes.');
      const code = await setupCode();
      const given = str(b.code, 100);
      if (given.length !== code.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(code))) {
        await attempt(ctx.clientIp, '', false);
        throw httpError(403, 'wrong_code', 'The setup code is wrong. It is in the log of the server and was shown by the installer.');
      }
      const username = usernameOf(b.username), name = str(b.name, 120);
      if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(username)) throw httpError(400, 'bad_username', 'User names have 2 to 63 characters: lowercase letters, digits, dots, dashes and underscores.');
      const pol = await getPolicy();
      const problems = passwordProblems(b.password, pol, { username, name });
      if (problems.length) throw httpError(400, 'weak_password', problems.join(' '));
      const hash = await hashPassword(b.password);
      const u = await tx(async c => {
        await c.query('lock table auth_users in exclusive mode');
        if ((await c.query('select 1 from auth_users limit 1')).rows.length) throw httpError(409, 'already_set_up', 'There is an administrator already. Sign in instead.');
        const [row] = (await c.query('insert into auth_users (username, name, password_hash, is_admin) values ($1, $2, $3, true) returning id', [username, name, hash])).rows;
        await c.query('update auth_settings set setup_code = null where id = 1');
        return row;
      });
      await newSession(ctx, u.id, pol);
      ctx.user = { id: String(u.id), username, name, isAdmin: true };
      event(ctx, 'auth.setup', { username });
      return { status: 201, body: { ok: true } };
    });

    app.post('/api/auth/login', async ctx => {
      const b = ctx.body || {};
      const username = usernameOf(b.username);
      if (await limitedIp(ctx.clientIp)) throw httpError(429, 'too_many', 'Too many attempts from this address. Try again in a few minutes.');
      const pol = await getPolicy();
      const [u] = await query('select * from auth_users where username = $1', [username]);
      const okPw = u ? await verifyPassword(String(b.password ?? ''), u.password_hash) : (await verifyPassword(String(b.password ?? ''), await DUMMY), false);
      const locked = u?.locked_until && new Date(u.locked_until) > new Date();
      if (!u || !okPw || locked || u.disabled) {
        await attempt(ctx.clientIp, username, false);
        if (u && !okPw && !locked) {
          await query(`update auth_users set failed_logins = failed_logins + 1,
            locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end where id = $1`, [u.id, pol.lockoutAttempts, pol.lockoutMinutes]);
        }
        event({ ...ctx, user: null }, 'auth.login_failed', { username });
        throw httpError(401, 'login_failed', LOGIN_FAILED);
      }
      if (u.totp_enabled) {
        const code = str(b.code, 20);
        if (!code) return { totp: true };
        const counter = totpMatch(hooks.decrypt(u.totp_secret), code);
        let ok = counter > Number(u.totp_last_counter);
        if (ok) await query('update auth_users set totp_last_counter = $2 where id = $1', [u.id, counter]);
        if (!ok && !counter) {
          // A recovery code: works once
          const h = sha(code.toLowerCase());
          if ((u.recovery_codes || []).includes(h)) {
            ok = true;
            await query('update auth_users set recovery_codes = $2 where id = $1', [u.id, JSON.stringify(u.recovery_codes.filter(x => x !== h))]);
            event({ ...ctx, user: { id: String(u.id), username: u.username } }, 'auth.recovery_code_used', {});
          }
        }
        if (!ok) {
          await attempt(ctx.clientIp, username, false);
          await query(`update auth_users set failed_logins = failed_logins + 1,
            locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end where id = $1`, [u.id, pol.lockoutAttempts, pol.lockoutMinutes]);
          throw httpError(401, 'code_wrong', 'The code is wrong or was used already. Wait for the next one.');
        }
      }
      await attempt(ctx.clientIp, username, true);
      await query('update auth_users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [u.id]);
      await newSession(ctx, u.id, pol);
      event({ ...ctx, user: { id: String(u.id), username: u.username, name: u.name } }, 'auth.login', {});
      return { ok: true };
    });

    app.post('/api/auth/logout', async ctx => {
      const token = cookies(ctx.req)[COOKIE];
      if (token) await query('delete from auth_sessions where token_hash = $1', [sha(token)]);
      setCookie(ctx, '', 0);
      if (ctx.user) event(ctx, 'auth.logout', {});
      return null;
    });

    app.post('/api/auth/logout-others', async ctx => {
      const r = await query('delete from auth_sessions where user_id = $1 and id <> $2 returning id', [ctx.user.id, ctx.user.sessionId]);
      event(ctx, 'auth.logout_others', { sessions: r.length });
      return { ended: r.length };
    });

    app.get('/api/auth/sessions', async ctx => (await query(`select id, created_at, last_seen_at, ip, user_agent from auth_sessions
      where user_id = $1 and expires_at > now() order by last_seen_at desc`, [ctx.user.id])).map(s => ({ ...s, id: String(s.id), current: String(s.id) === ctx.user.sessionId })));

    app.del('/api/auth/sessions/:id', async ctx => {
      const r = await query('delete from auth_sessions where id = $1 and user_id = $2 returning id', [/^\d+$/.test(ctx.params.id) ? ctx.params.id : 0, ctx.user.id]);
      if (!r.length) throw httpError(404, 'not_found', 'There is no such session.');
      return null;
    });

    app.post('/api/auth/password', async ctx => {
      const b = ctx.body || {};
      const pol = await getPolicy();
      const [u] = await query('select * from auth_users where id = $1', [ctx.user.id]);
      if (!(await verifyPassword(String(b.current ?? ''), u.password_hash))) throw httpError(400, 'wrong_password', 'Your current password is wrong.');
      await checkNewPassword(pol, String(b.password ?? ''), u);
      await tx(c => storePassword(c, u.id, String(b.password), pol));
      // Other sessions end: whoever knew the old password is out
      await query('delete from auth_sessions where user_id = $1 and id <> $2', [u.id, ctx.user.sessionId]);
      event(ctx, 'auth.password_changed', {});
      return { ok: true };
    });

    app.post('/api/auth/verify', async ctx => {
      const b = ctx.body || {};
      const [u] = await query('select * from auth_users where id = $1', [ctx.user.id]);
      let ok = false;
      if (u.totp_enabled) {
        const counter = totpMatch(hooks.decrypt(u.totp_secret), b.code);
        ok = counter > Number(u.totp_last_counter);
        if (ok) await query('update auth_users set totp_last_counter = $2 where id = $1', [u.id, counter]);
      } else ok = await verifyPassword(String(b.password ?? ''), u.password_hash);
      if (!ok) { await attempt(ctx.clientIp, u.username, false); throw httpError(400, 'verify_failed', u.totp_enabled ? 'The code is wrong or was used already. Wait for the next one.' : 'The password is wrong.'); }
      await query('update auth_sessions set verified_at = now() where id = $1', [ctx.user.sessionId]);
      return { ok: true };
    });

    app.post('/api/auth/totp/start', async ctx => {
      const [u] = await query('select * from auth_users where id = $1', [ctx.user.id]);
      if (u.totp_enabled) throw httpError(409, 'totp_on', 'Two-factor sign-in is already on.');
      const secret = base32(crypto.randomBytes(20));
      await query('update auth_users set totp_secret = $2 where id = $1', [u.id, hooks.encrypt(secret)]);
      const label = encodeURIComponent(`${config.appName}:${u.username}`);
      return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(config.appName)}&algorithm=SHA1&digits=6&period=30` };
    });

    app.post('/api/auth/totp/confirm', async ctx => {
      const [u] = await query('select * from auth_users where id = $1', [ctx.user.id]);
      if (u.totp_enabled) throw httpError(409, 'totp_on', 'Two-factor sign-in is already on.');
      if (!u.totp_secret) throw httpError(400, 'totp_not_started', 'Start the setup first.');
      const counter = totpMatch(hooks.decrypt(u.totp_secret), ctx.body?.code);
      if (!counter) throw httpError(400, 'code_wrong', 'The code does not match. Check the time on your phone and try the next code.');
      const { codes, hashes } = newRecoveryCodes();
      await query('update auth_users set totp_enabled = true, totp_last_counter = $2, recovery_codes = $3, updated_at = now() where id = $1', [u.id, counter, JSON.stringify(hashes)]);
      await query('update auth_sessions set verified_at = now() where id = $1', [ctx.user.sessionId]);
      event(ctx, 'auth.totp_enabled', {});
      return { recoveryCodes: codes };
    });

    app.post('/api/auth/totp/disable', async ctx => {
      const pol = await getPolicy();
      const [u] = await query('select * from auth_users where id = $1', [ctx.user.id]);
      if (pol.totp === 'all' || (pol.totp === 'admins' && u.is_admin)) throw httpError(403, 'totp_required', 'Two-factor sign-in is required for your account.');
      if (!(await verifyPassword(String(ctx.body?.password ?? ''), u.password_hash))) throw httpError(400, 'wrong_password', 'Your password is wrong.');
      await query("update auth_users set totp_enabled = false, totp_secret = null, recovery_codes = '[]', updated_at = now() where id = $1", [u.id]);
      event(ctx, 'auth.totp_disabled', {});
      return { ok: true };
    });

    app.post('/api/auth/recovery-codes', async ctx => {
      await requireFresh(ctx);
      const { codes, hashes } = newRecoveryCodes();
      await query('update auth_users set recovery_codes = $2 where id = $1 and totp_enabled', [ctx.user.id, JSON.stringify(hashes)]);
      event(ctx, 'auth.recovery_codes_renewed', {});
      return { recoveryCodes: codes };
    });

    // ------------------------------------------------------------ Accounts (administrators)
    app.get('/api/auth/users', async ctx => {
      requireAdmin(ctx);
      return (await query(`select ${USER_COLS} from auth_users order by username`)).map(publicUser);
    });

    app.post('/api/auth/users', async ctx => {
      requireAdmin(ctx);
      const b = ctx.body || {};
      const username = usernameOf(b.username);
      if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(username)) throw httpError(400, 'bad_username', 'User names have 2 to 63 characters: lowercase letters, digits, dots, dashes and underscores.');
      const pol = await getPolicy();
      const password = b.password ? String(b.password) : randomPassword();
      const problems = passwordProblems(password, pol, { username, name: str(b.name, 120) });
      if (problems.length) throw httpError(400, 'weak_password', problems.join(' '));
      const rows = await query(`insert into auth_users (username, name, email, password_hash, is_admin, must_change_password) values ($1, $2, $3, $4, $5, true)
        on conflict (username) do nothing returning ${USER_COLS}`, [username, str(b.name, 120), str(b.email, 200), await hashPassword(password), !!b.isAdmin]);
      if (!rows.length) throw httpError(409, 'username_taken', 'This user name is taken.');
      event(ctx, 'auth.user_created', { username, isAdmin: !!b.isAdmin, target: { type: 'user', id: String(rows[0].id), name: username } });
      return { status: 201, body: { ...publicUser(rows[0]), password: b.password ? undefined : password } };
    });

    const userParam = async (ctx) => {
      if (!/^\d+$/.test(ctx.params.id)) throw httpError(404, 'not_found', 'There is no such user.');
      const [u] = await query('select * from auth_users where id = $1', [ctx.params.id]);
      if (!u) throw httpError(404, 'not_found', 'There is no such user.');
      return u;
    };
    const otherAdmins = async id => (await query('select count(*)::int as n from auth_users where is_admin and not disabled and id <> $1', [id]))[0].n;

    app.patch('/api/auth/users/:id', async ctx => {
      requireAdmin(ctx);
      const u = await userParam(ctx);
      const b = ctx.body || {};
      const next = { name: 'name' in b ? str(b.name, 120) : u.name, email: 'email' in b ? str(b.email, 200) : u.email, is_admin: 'isAdmin' in b ? !!b.isAdmin : u.is_admin, disabled: 'disabled' in b ? !!b.disabled : u.disabled };
      if ((u.is_admin && !next.is_admin) || (!u.disabled && next.disabled)) {
        if (u.is_admin && !(await otherAdmins(u.id))) throw httpError(409, 'last_admin', 'This is the last active administrator. Make someone else an administrator first.');
      }
      const [row] = await query(`update auth_users set name = $2, email = $3, is_admin = $4, disabled = $5, updated_at = now(),
        locked_until = case when $6 then null else locked_until end, failed_logins = case when $6 then 0 else failed_logins end where id = $1 returning ${USER_COLS}`,
      [u.id, next.name, next.email, next.is_admin, next.disabled, b.unlock === true]);
      if (next.disabled) await query('delete from auth_sessions where user_id = $1', [u.id]);
      event(ctx, 'auth.user_changed', { target: { type: 'user', id: String(u.id), name: u.username }, changes: Object.keys(b) });
      return publicUser(row);
    });

    app.post('/api/auth/users/:id/reset-password', async ctx => {
      requireAdmin(ctx);
      const u = await userParam(ctx);
      const pol = await getPolicy();
      const password = randomPassword();
      await tx(c => storePassword(c, u.id, password, { ...pol, history: Math.max(pol.history, 1) }, { mustChange: true }));
      await query('update auth_users set failed_logins = 0, locked_until = null where id = $1', [u.id]);
      await query('delete from auth_sessions where user_id = $1', [u.id]);
      event(ctx, 'auth.password_reset', { target: { type: 'user', id: String(u.id), name: u.username } });
      return { password };
    });

    app.post('/api/auth/users/:id/reset-totp', async ctx => {
      requireAdmin(ctx);
      const u = await userParam(ctx);
      await query("update auth_users set totp_enabled = false, totp_secret = null, recovery_codes = '[]', updated_at = now() where id = $1", [u.id]);
      await query('delete from auth_sessions where user_id = $1', [u.id]);
      event(ctx, 'auth.totp_reset', { target: { type: 'user', id: String(u.id), name: u.username } });
      return { ok: true };
    });

    app.del('/api/auth/users/:id', async ctx => {
      requireAdmin(ctx);
      const u = await userParam(ctx);
      if (String(u.id) === ctx.user.id) throw httpError(409, 'self', 'You cannot delete your own account.');
      if (u.is_admin && !(await otherAdmins(u.id))) throw httpError(409, 'last_admin', 'This is the last active administrator.');
      await query('delete from auth_users where id = $1', [u.id]);
      event(ctx, 'auth.user_deleted', { target: { type: 'user', id: String(u.id), name: u.username } });
      return null;
    });

    app.get('/api/auth/policy', async ctx => { requireAdmin(ctx); return getPolicy(); });
    app.put('/api/auth/policy', async ctx => {
      requireAdmin(ctx);
      const p = normalizePolicy({ ...(await getPolicy()), ...(ctx.body || {}) });
      await query('update auth_settings set policy = $1 where id = 1', [JSON.stringify(p)]);
      cached = null;
      event(ctx, 'auth.policy_changed', { policy: p });
      return p;
    });
  };
}
