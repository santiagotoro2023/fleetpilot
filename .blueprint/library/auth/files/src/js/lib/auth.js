// Library element "auth" (blueprint @@BLUEPRINT_VERSION@@): the sign-in pages and account views.
//
//   import { session, guard, accountView, usersView, policyView, confirmFresh, signOut, authError } from './lib/auth.js'
//   await session.load()                      before startApp(): who is signed in
//   function route() { clear(); if (guard(main, route)) return; … }   sign-in, setup, new password, two-factor setup
//   api.get(…).catch(e => authError(e, route) || toast(e.message))   a lapsed session shows the sign-in again
//
// See .blueprint/library/auth/README.md.
import { h, toast } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../core/icons.js';
import { APP_NAME } from '../core/storage.js';

export const session = {
  user: null, setup: false, policy: {},
  async load() {
    const s = await api.get('/api/auth/state');
    Object.assign(session, { user: s.user, setup: s.setup, policy: s.policy || {} });
    return session;
  },
  get ready() { return !!session.user && !(session.user.pending || []).length; }
};

const field = (label, attrs) => h('label', { class: 'field' }, label, h('input', { class: 'input', ...attrs }));
const policyHint = p => {
  const parts = [`at least ${p.minLength || 12} characters`];
  if (p.requireLower) parts.push('a lowercase letter');
  if (p.requireUpper) parts.push('an uppercase letter');
  if (p.requireDigit) parts.push('a digit');
  if (p.requireSymbol) parts.push('a character that is not a letter or digit');
  return `Use ${parts.join(', ')}. A few unusual words in a row make a good password.`;
};
function busy(btn, on) { btn.disabled = on; }
const rerun = () => window.dispatchEvent(new HashChangeEvent('hashchange'));

/** Shows what the person has to do before using the app; true when it rendered something */
export function guard(main) {
  const app = document.querySelector('.app');
  const ready = session.ready;
  app.classList.toggle('auth-out', !ready);
  if (ready) return false;
  document.querySelectorAll('.rail a[data-nav]').forEach(a => a.classList.remove('active'));
  const page = h('div', { class: 'page' }), box = h('div', { class: 'auth-page' });
  page.append(box);
  main.append(page);
  if (session.setup) setupView(box);
  else if (!session.user) signInView(box);
  else if (session.user.pending.includes('password')) newPasswordView(box);
  else totpSetupView(box, { forced: true });
  document.title = APP_NAME;
  return true;
}

/** An API error: a lapsed session shows the sign-in again (true), anything else is the caller's (false) */
export function authError(e) {
  if (e?.status === 401 || e?.code === 'setup_needed') { session.load().then(rerun); return true; }
  return false;
}

export async function signOut() {
  await api.post('/api/auth/logout').catch(() => {});
  await session.load();
  location.hash = '#/';
  rerun();
}

function signInView(box) {
  const user = field('User name', { name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none' });
  const pw = field('Password', { name: 'password', type: 'password', autocomplete: 'current-password' });
  const code = field('Code from your authenticator app', { name: 'code', class: 'input mono', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
  code.classList.add('hidden');
  const fb = h('div', { class: 'feedback bad hidden', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'subcard auth-form', onsubmit: async e => {
    e.preventDefault();
    busy(btn, true); fb.classList.add('hidden');
    try {
      const r = await api.post('/api/auth/login', { username: user.querySelector('input').value, password: pw.querySelector('input').value, code: code.querySelector('input').value || undefined });
      if (r?.totp) {
        code.classList.remove('hidden');
        code.querySelector('input').focus();
        fb.className = 'feedback'; fb.textContent = 'Enter the code from your authenticator app, or one of your recovery codes.';
      } else { await session.load(); rerun(); }
    } catch (err) { fb.className = 'feedback bad'; fb.textContent = err.message; }
    busy(btn, false);
  } }, user, pw, code, fb, h('div', { class: 'row' }, btn));
  box.append(h('h1', {}, 'Sign in'), h('p', { class: 'muted' }, `Sign in to ${APP_NAME} with your account. Forgot your password? An administrator can set a new one for you.`), form);
  setTimeout(() => user.querySelector('input').focus(), 0);
}

function setupView(box) {
  const code = field('Setup code', { name: 'code', class: 'input mono', spellcheck: 'false', autocomplete: 'off', placeholder: 'a1b2c3-d4e5f6-a7b8c9' });
  const user = field('User name', { name: 'username', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none', value: 'admin' });
  const name = field('Your name', { name: 'name', autocomplete: 'name' });
  const pw = field('Password', { name: 'password', type: 'password', autocomplete: 'new-password' });
  const pw2 = field('The password again', { name: 'password2', type: 'password', autocomplete: 'new-password' });
  const fb = h('div', { class: 'feedback bad hidden', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create the administrator');
  const v = el => el.querySelector('input').value;
  box.append(h('h1', {}, `Set up ${APP_NAME}`),
    h('p', { class: 'muted' }, 'Create the first administrator. The setup code is in the log of the server: the installer showed it, and docker compose logs or kubectl logs show it too.'),
    h('form', { class: 'subcard auth-form', onsubmit: async e => {
      e.preventDefault();
      fb.classList.add('hidden');
      if (v(pw) !== v(pw2)) { fb.classList.remove('hidden'); fb.textContent = 'The two passwords are not the same.'; return; }
      busy(btn, true);
      try { await api.post('/api/auth/setup', { code: v(code).trim(), username: v(user), name: v(name), password: v(pw) }); await session.load(); rerun(); }
      catch (err) { fb.classList.remove('hidden'); fb.textContent = err.message; }
      busy(btn, false);
    } }, code, user, name, pw, h('p', { class: 'small muted' }, policyHint(session.policy)), pw2, fb, h('div', { class: 'row' }, btn)));
}

/** The form to change the own password (forced = after a reset or when it got too old) */
function passwordForm({ onDone, forced = false } = {}) {
  const cur = field(forced ? 'The password you signed in with' : 'Current password', { type: 'password', autocomplete: 'current-password' });
  const pw = field('New password', { type: 'password', autocomplete: 'new-password' });
  const pw2 = field('The new password again', { type: 'password', autocomplete: 'new-password' });
  const fb = h('div', { class: 'feedback bad hidden', role: 'alert' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  const v = el => el.querySelector('input').value;
  return h('form', { class: 'subcard auth-form', onsubmit: async e => {
    e.preventDefault();
    fb.classList.add('hidden');
    if (v(pw) !== v(pw2)) { fb.classList.remove('hidden'); fb.textContent = 'The two new passwords are not the same.'; return; }
    busy(btn, true);
    try { await api.post('/api/auth/password', { current: v(cur), password: v(pw) }); toast('Password changed. Other sessions were signed out.'); [cur, pw, pw2].forEach(f => { f.querySelector('input').value = ''; }); onDone?.(); }
    catch (err) { fb.classList.remove('hidden'); fb.textContent = err.message; }
    busy(btn, false);
  } }, cur, pw, h('p', { class: 'small muted' }, policyHint(session.policy)), pw2, fb, h('div', { class: 'row' }, btn));
}

function newPasswordView(box) {
  box.append(h('h1', {}, 'Choose a new password'),
    h('p', { class: 'muted' }, 'Your password was set by an administrator or is too old. Choose your own before you go on.'),
    passwordForm({ forced: true, onDone: async () => { await session.load(); rerun(); } }),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn ghost', onclick: signOut }, 'Sign out')));
}

function recoveryCodes(codes) {
  return h('div', {},
    h('p', { class: 'small' }, 'Recovery codes: each one signs you in once when you do not have your phone. Keep them somewhere safe, apart from your phone. They are shown only now.'),
    h('div', { class: 'auth-codes' }, codes.map(c => h('code', {}, c))),
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', type: 'button', html: I.download + 'Download the codes', onclick: () => {
      const a = h('a', { href: URL.createObjectURL(new Blob([`${APP_NAME} recovery codes for ${session.user?.username}\n\n${codes.join('\n')}\n`], { type: 'text/plain' })), download: `${APP_NAME.toLowerCase().replace(/\s+/g, '-')}-recovery-codes.txt` });
      document.body.append(a); a.click(); a.remove();
    } })));
}

/** Setting up two-factor sign-in: QR code, the secret as text, confirming with a first code */
function totpSetupView(box, { forced = false, onDone } = {}) {
  const area = h('div', {});
  const start = async () => {
    area.innerHTML = '';
    let s;
    try { s = await api.post('/api/auth/totp/start'); } catch (e) { toast(e.message); return; }
    const code = field('The 6-digit code the app shows now', { class: 'input mono', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
    const fb = h('div', { class: 'feedback bad hidden', role: 'alert' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Turn on two-factor sign-in');
    area.append(h('div', { class: 'auth-totp' },
      h('div', { class: 'auth-qr', html: qrSvg(s.uri), title: 'Scan with an authenticator app' }),
      h('div', {},
        h('p', { class: 'small' }, '1. Scan the code with an authenticator app (for example FreeOTP, Aegis, Google or Microsoft Authenticator, 1Password).'),
        h('p', { class: 'small muted' }, 'No camera? Enter this key in the app:'),
        h('code', { class: 'auth-secret' }, s.secret.replace(/(.{4})/g, '$1 ').trim()),
        h('p', { class: 'small', style: { marginTop: '10px' } }, '2. Enter the code the app shows.'))),
    h('form', { class: 'auth-form', onsubmit: async e => {
      e.preventDefault(); busy(btn, true); fb.classList.add('hidden');
      try {
        const r = await api.post('/api/auth/totp/confirm', { code: code.querySelector('input').value });
        area.innerHTML = '';
        area.append(h('div', { class: 'feedback ok' }, 'Two-factor sign-in is on.'), recoveryCodes(r.recoveryCodes),
          h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onclick: async () => { await session.load(); if (onDone) onDone(); else rerun(); } }, forced ? 'Continue' : 'Done')));
      } catch (err) { fb.classList.remove('hidden'); fb.textContent = err.message; }
      busy(btn, false);
    } }, code, fb, h('div', { class: 'row' }, btn)));
    setTimeout(() => code.querySelector('input').focus(), 0);
  };
  if (forced) {
    box.append(h('h1', {}, 'Set up two-factor sign-in'),
      h('p', { class: 'muted' }, 'Your account needs a second factor: a code from an app on your phone, besides your password. It takes a minute.'),
      h('div', { class: 'subcard' }, area),
      h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn ghost', onclick: signOut }, 'Sign out')));
    start();
  } else {
    box.append(area);
    area.append(h('button', { class: 'btn', onclick: start, html: I.lock + 'Set up two-factor sign-in' }));
  }
}

/** Asks for a fresh two-factor code (or the password) before a sensitive action; resolves true when confirmed */
export function confirmFresh(reason = 'Confirm that it is you.') {
  return new Promise(resolve => {
    const totp = !!session.user?.totpEnabled;
    const input = h('input', { class: totp ? 'input mono' : 'input', type: totp ? 'text' : 'password', inputmode: totp ? 'numeric' : undefined, autocomplete: totp ? 'one-time-code' : 'current-password', placeholder: totp ? '123456' : '' });
    const fb = h('div', { class: 'feedback bad hidden', role: 'alert' });
    const dlg = h('dialog', { class: 'dlg' });
    const close = ok => { dlg.close(); dlg.remove(); resolve(ok); };
    dlg.append(h('h3', {}, reason),
      h('form', { onsubmit: async e => {
        e.preventDefault();
        try { await api.post('/api/auth/verify', totp ? { code: input.value } : { password: input.value }); close(true); }
        catch (err) { fb.classList.remove('hidden'); fb.textContent = err.message; }
      } },
      h('label', { class: 'field' }, totp ? 'Code from your authenticator app' : 'Your password', input), fb,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', type: 'submit' }, 'Confirm'), h('button', { class: 'btn ghost', type: 'button', onclick: () => close(false) }, 'Cancel'))));
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(false); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

const when = t => t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
function browserName(ua) {
  const b = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

/** The own account: password, two-factor sign-in, sessions */
export function accountView(container) {
  const u = session.user;
  container.append(h('h2', {}, 'Your account'),
    h('dl', { class: 'kv' }, h('dt', {}, 'User name'), h('dd', {}, u.username), h('dt', {}, 'Name'), h('dd', {}, u.name || '–'),
      h('dt', {}, 'Role'), h('dd', {}, u.isAdmin ? 'Administrator' : 'User'), h('dt', {}, 'Last sign-in'), h('dd', {}, when(u.lastLoginAt))));
  container.append(h('h2', { style: { marginTop: '28px' } }, 'Password'), passwordForm());
  const tf = h('div', {});
  const renderTf = () => {
    tf.innerHTML = '';
    tf.append(h('h2', { style: { marginTop: '28px' } }, 'Two-factor sign-in'));
    if (session.user.totpEnabled) {
      const required = session.policy.totp === 'all' || (session.policy.totp === 'admins' && session.user.isAdmin);
      tf.append(h('p', { class: 'muted' }, 'On: signing in needs your password and a code from your authenticator app.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => {
            if (!(await confirmFresh('Confirm with a code from your app'))) return;
            try { const r = await api.post('/api/auth/recovery-codes'); const d = h('div', { class: 'subcard', style: { marginTop: '10px' } }, recoveryCodes(r.recoveryCodes)); tf.append(d); } catch (e) { toast(e.message); }
          } }, 'New recovery codes'),
          required ? h('span', { class: 'small muted' }, 'Required for your account.') : h('button', { class: 'btn ghost danger', onclick: async () => {
            const pw = prompt('Turn off two-factor sign-in? Signing in will need only your password. Enter your password to confirm.');
            if (!pw) return;
            try { await api.post('/api/auth/totp/disable', { password: pw }); await session.load(); toast('Two-factor sign-in is off'); renderTf(); } catch (e) { toast(e.message); }
          } }, 'Turn off')));
    } else {
      tf.append(h('p', { class: 'muted' }, 'Off. With it on, a stolen password alone is not enough to sign in as you.'));
      totpSetupView(tf, { onDone: renderTf });
    }
  };
  renderTf();
  container.append(tf);
  const ses = h('div', {});
  const renderSessions = async () => {
    let list = [];
    try { list = await api.get('/api/auth/sessions'); } catch (e) { toast(e.message); }
    ses.innerHTML = '';
    ses.append(h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '28px' } }, h('h2', { style: { margin: 0 } }, 'Where you are signed in'),
      list.length > 1 ? h('button', { class: 'btn ghost', onclick: async () => { await api.post('/api/auth/logout-others'); toast('Signed out everywhere else'); renderSessions(); } }, 'Sign out everywhere else') : null),
    h('table', { class: 'tbl auth-sessions' }, h('thead', {}, h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Address'), h('th', {}, 'Last active'), h('th', {}))),
      h('tbody', {}, list.map(s => h('tr', {}, h('td', {}, browserName(s.user_agent), s.current ? h('span', { class: 'chip on', style: { marginLeft: '6px' } }, 'this one') : null), h('td', {}, s.ip || '–'), h('td', {}, when(s.last_seen_at)),
        h('td', {}, s.current ? null : h('button', { class: 'btn ghost', onclick: async () => { await api.del(`/api/auth/sessions/${s.id}`); renderSessions(); } }, 'Sign out')))))));
  };
  renderSessions();
  container.append(ses, h('div', { class: 'row', style: { marginTop: '22px' } }, h('button', { class: 'btn ghost', onclick: signOut }, 'Sign out')));
}

function secretDialog(title, text, value) {
  const dlg = h('dialog', { class: 'dlg' });
  dlg.append(h('h3', {}, title), h('p', { class: 'small' }, text), h('input', { class: 'input mono', readonly: true, value, style: { width: '100%' } }),
    h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: () => { navigator.clipboard?.writeText(value); toast('Copied'); } }, 'Copy'), h('button', { class: 'btn ghost', onclick: () => { dlg.close(); dlg.remove(); } }, 'Close')));
  document.body.append(dlg);
  dlg.showModal();
}

/**
 * Accounts for administrators: list, add, change, reset, delete.
 * extra(user) may return a node shown in the row (e.g. the app's roles), onChange() runs after changes.
 */
export function usersView(container, { extra, onChange } = {}) {
  const list = h('div', {});
  const render = async () => {
    let users = [];
    try { users = await api.get('/api/auth/users'); } catch (e) { toast(e.message); return; }
    list.innerHTML = '';
    list.append(h('table', { class: 'tbl auth-users' },
      h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'State'), h('th', {}, 'Last sign-in'), extra ? h('th', {}, 'Access') : null, h('th', {}))),
      h('tbody', {}, users.map(u => h('tr', { class: u.disabled ? 'auth-off' : '' },
        h('td', {}, h('b', {}, u.username), u.name ? h('div', { class: 'small muted' }, u.name) : null),
        h('td', {}, h('div', { class: 'row', style: { gap: '4px' } },
          u.isAdmin ? h('span', { class: 'chip' }, 'administrator') : null,
          u.disabled ? h('span', { class: 'chip' }, 'disabled') : null,
          u.locked ? h('span', { class: 'chip' }, 'locked') : null,
          u.totpEnabled ? h('span', { class: 'chip on' }, 'two-factor') : null,
          u.mustChangePassword ? h('span', { class: 'chip' }, 'new password due') : null)),
        h('td', { class: 'small' }, when(u.lastLoginAt)),
        extra ? h('td', {}, extra(u)) : null,
        h('td', {}, h('button', { class: 'btn ghost', title: `Change ${u.username}`, 'aria-label': `Change ${u.username}`, html: I.sliders, onclick: () => editUser(u) })))))));
  };
  const call = async (fn, done) => { try { const r = await fn(); if (done) done(r); await render(); onChange?.(); } catch (e) { toast(e.message); } };
  const editUser = u => {
    const dlg = h('dialog', { class: 'dlg' });
    const name = h('input', { class: 'input', value: u.name }), email = h('input', { class: 'input', value: u.email, type: 'email' });
    const admin = h('input', { type: 'checkbox', checked: u.isAdmin }), off = h('input', { type: 'checkbox', checked: u.disabled });
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.append(h('h3', {}, u.username),
      h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field', style: { marginTop: '8px' } }, 'E-mail', email),
      h('label', { class: 'row small', style: { marginTop: '10px' } }, admin, 'Administrator: may do everything, including accounts'),
      h('label', { class: 'row small' }, off, 'Disabled: cannot sign in'),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn primary', onclick: () => call(() => api.patch(`/api/auth/users/${u.id}`, { name: name.value, email: email.value, isAdmin: admin.checked, disabled: off.checked }), () => { close(); toast('Saved'); }) }, 'Save'),
        h('button', { class: 'btn', onclick: () => confirm(`Set a new password for ${u.username}? The current one stops working, and ${u.username} must choose an own one at the next sign-in.`) && call(() => api.post(`/api/auth/users/${u.id}/reset-password`), r => { close(); secretDialog('New password', `Give it to ${u.username} on a safe way. It works once: at the next sign-in a new password must be chosen.`, r.password); }) }, 'Set a new password'),
        u.totpEnabled ? h('button', { class: 'btn', onclick: () => confirm(`Turn off two-factor sign-in for ${u.username}? Use this when the phone was lost. They set it up again at the next sign-in if it is required.`) && call(() => api.post(`/api/auth/users/${u.id}/reset-totp`), () => { close(); toast('Two-factor sign-in reset'); }) }, 'Reset two-factor') : null,
        u.locked ? h('button', { class: 'btn', onclick: () => call(() => api.patch(`/api/auth/users/${u.id}`, { unlock: true }), () => { close(); toast('Unlocked'); }) }, 'Unlock') : null),
      h('div', { class: 'row', style: { marginTop: '12px', justifyContent: 'space-between' } },
        h('button', { class: 'btn ghost danger', onclick: () => confirm(`Delete the account ${u.username}? This cannot be undone.`) && call(() => api.del(`/api/auth/users/${u.id}`), () => { close(); toast(`${u.username} deleted`); }) }, 'Delete account'),
        h('button', { class: 'btn ghost', onclick: close }, 'Close')));
    document.body.append(dlg);
    dlg.showModal();
  };
  const add = () => {
    const dlg = h('dialog', { class: 'dlg' });
    const username = h('input', { class: 'input', spellcheck: 'false', autocapitalize: 'none', placeholder: 'jdoe' }), name = h('input', { class: 'input', placeholder: 'Jane Doe' }), email = h('input', { class: 'input', type: 'email' });
    const admin = h('input', { type: 'checkbox' });
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.append(h('h3', {}, 'Add an account'),
      h('label', { class: 'field' }, 'User name', username), h('label', { class: 'field', style: { marginTop: '8px' } }, 'Name', name), h('label', { class: 'field', style: { marginTop: '8px' } }, 'E-mail', email),
      h('label', { class: 'row small', style: { marginTop: '10px' } }, admin, 'Administrator'),
      h('p', { class: 'small muted' }, 'A first password is made for you. The new user chooses an own one at the first sign-in.'),
      h('div', { class: 'row', style: { marginTop: '10px' } },
        h('button', { class: 'btn primary', onclick: () => call(() => api.post('/api/auth/users', { username: username.value, name: name.value, email: email.value, isAdmin: admin.checked }), r => { close(); secretDialog(`Account ${r.username} added`, 'Its first password: give it on a safe way. It works once, then a new one must be chosen.', r.password); }) }, 'Add account'),
        h('button', { class: 'btn ghost', onclick: close }, 'Cancel')));
    document.body.append(dlg);
    dlg.showModal();
    username.focus();
  };
  container.append(h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', { style: { margin: 0 } }, 'Accounts'), h('button', { class: 'btn primary', html: I.plus + 'Add an account', onclick: add })), list);
  render();
  return { refresh: render };
}

/** The password and session rules, for administrators */
export async function policyView(container) {
  let p;
  try { p = await api.get('/api/auth/policy'); } catch (e) { toast(e.message); return; }
  const num = (k, label, unit) => h('label', { class: 'field' }, label, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('input', { class: 'input mono', type: 'number', name: k, value: p[k], style: { width: '96px' } }), h('span', { class: 'small muted' }, unit)));
  const chk = (k, label) => h('label', { class: 'row small' }, h('input', { type: 'checkbox', name: k, checked: p[k] }), label);
  const totp = h('select', { class: 'input', name: 'totp' }, [['none', 'Nobody (everyone may turn it on)'], ['admins', 'Administrators'], ['all', 'Everyone']].map(([v, t]) => h('option', { value: v, selected: p.totp === v }, t)));
  const form = h('form', { class: 'auth-policy', onsubmit: async e => {
    e.preventDefault();
    const out = {};
    for (const el of form.querySelectorAll('[name]')) out[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    try { await api.put('/api/auth/policy', out); toast('Rules saved'); await session.load(); } catch (err) { toast(err.message); }
  } },
  h('h2', {}, 'Passwords'),
  h('div', { class: 'auth-grid' }, num('minLength', 'Shortest password', 'characters'), num('history', 'Not again', 'last passwords'), num('maxAgeDays', 'Change after', 'days (0: never)')),
  h('div', { class: 'auth-checks' }, chk('blockCommon', 'Refuse well-known passwords and the own name'), chk('requireLower', 'Needs a lowercase letter'), chk('requireUpper', 'Needs an uppercase letter'), chk('requireDigit', 'Needs a digit'), chk('requireSymbol', 'Needs a character that is not a letter or digit')),
  h('p', { class: 'small muted' }, 'Length protects best: rules about character kinds make passwords harder to remember, not much harder to guess.'),
  h('h2', { style: { marginTop: '22px' } }, 'Two-factor sign-in'),
  h('label', { class: 'field', style: { maxWidth: '340px' } }, 'Required for', totp),
  h('h2', { style: { marginTop: '22px' } }, 'Sessions and lockout'),
  h('div', { class: 'auth-grid' }, num('sessionIdleMinutes', 'Sign out when idle for', 'minutes'), num('sessionMaxHours', 'Sign out after', 'hours in any case'),
    num('lockoutAttempts', 'Wrong passwords in a row', 'then the account waits'), num('lockoutMinutes', 'Waiting time', 'minutes')),
  h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { class: 'btn primary', type: 'submit' }, 'Save rules')));
  container.append(form);
}

// ---------------------------------------------------------------- QR code (byte mode, error correction M, versions 1 to 10)
const QR_TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const QR_EC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];        // per block, level M
const QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const QR_ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 255; };
function rsDivisor(n) {
  const r = new Array(n).fill(0); r[n - 1] = 1; let root = 1;
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { r[j] = gfMul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); }
  return r;
}

/** The modules of a QR code for text (true = dark) */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  const capacity = v => QR_TOTAL[v] - QR_EC[v] * QR_BLOCKS[v];
  while (ver <= 10 && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > capacity(ver) * 8) ver++;
  if (ver > 10) throw new Error('Too long for a QR code');
  const size = ver * 4 + 17, dataCap = capacity(ver);
  // Data bits
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);
  // Blocks, error correction, interleaving
  const nb = QR_BLOCKS[ver], ecLen = QR_EC[ver], short = nb - (QR_TOTAL[ver] % nb), shortLen = Math.floor(QR_TOTAL[ver] / nb) - ecLen;
  const div = rsDivisor(ecLen), dBlocks = [], eBlocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const len = shortLen + (i < short ? 0 : 1); const d = data.slice(k, k + len); k += len; dBlocks.push(d); eBlocks.push(rsRemainder(d, div)); }
  const words = [];
  for (let i = 0; i <= shortLen; i++) dBlocks.forEach(d => { if (i < d.length) words.push(d[i]); });
  for (let i = 0; i < ecLen; i++) eBlocks.forEach(e => words.push(e[i]));
  // Function patterns
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = QR_ALIGN[ver], last = al.length - 1;
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = mask => {
    const d = (0 << 3) | mask; let r = d;   // level M: 00
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
  }
  // Data in the zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < words.length * 8) { m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  // The mask with the lowest penalty
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const apply = k => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    const line = get => { let run = 1, s = ''; for (let k = 0; k < size; k++) { const v = get(k); s += v ? '1' : '0'; if (k && v === get(k - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
      p += 40 * ((s.match(/(?=10111010000)/g) || []).length + (s.match(/(?=00001011101)/g) || []).length); };
    for (let k = 0; k < size; k++) { line(x => m[k][x]); line(y => m[y][k]); }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const v = m[y][x]; if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3; }
    m.forEach(r => r.forEach(v => { if (v) dark++; }));
    return p + 10 * Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size));
  };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) { apply(k); format(k); const p = penalty(); if (p < bestP) { bestP = p; best = k; } apply(k); }
  apply(best); format(best);
  return m;
}

/** A QR code as SVG: dark modules on white with a quiet zone, readable in both themes */
export function qrSvg(text) {
  const m = qrMatrix(text), n = m.length, q = 4;
  let d = '';
  m.forEach((row, y) => row.forEach((v, x) => { if (v) d += `M${x + q} ${y + q}h1v1h-1z`; }));
  return `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" width="180" height="180" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
