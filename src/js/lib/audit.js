// Library element "audit" (blueprint 1.1.1): the audit log as a searchable table.
//   import { auditView } from './lib/audit.js'
//   auditView(container, { label: action => 'Signed in' })   label() may name the app's own actions
import { h, toast } from '../core/ui.js';
import { api } from '../core/api.js';

const LABELS = {
  'auth.setup': 'Set up the first administrator', 'auth.login': 'Signed in', 'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out', 'auth.logout_others': 'Signed out everywhere else', 'auth.password_changed': 'Changed the password',
  'auth.totp_enabled': 'Turned on two-factor sign-in', 'auth.totp_disabled': 'Turned off two-factor sign-in',
  'auth.recovery_code_used': 'Used a recovery code', 'auth.recovery_codes_renewed': 'Made new recovery codes',
  'auth.user_created': 'Added an account', 'auth.user_changed': 'Changed an account', 'auth.user_deleted': 'Deleted an account',
  'auth.password_reset': 'Set a new password', 'auth.totp_reset': 'Reset two-factor sign-in', 'auth.policy_changed': 'Changed the sign-in rules'
};
const when = t => new Date(t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
function summary(d) {
  const parts = Object.entries(d || {}).filter(([k]) => k !== 'target').slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  const s = parts.join(' · ');
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

export function auditView(container, { label = () => null, query = {} } = {}) {
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search: a person, an action, a name', 'aria-label': 'Search the audit log' });
  const body = h('tbody', {});
  const more = h('button', { class: 'btn ghost hidden' }, 'Show older entries');
  const empty = h('p', { class: 'empty hidden' }, 'Nothing recorded yet.');
  let last = null, timer;
  const load = async (append = false) => {
    const params = new URLSearchParams({ limit: '100', ...query });
    if (search.value.trim()) params.set('q', search.value.trim());
    if (append && last) params.set('before', last);
    let rows = [];
    try { rows = await api.get(`/api/audit?${params}`); } catch (e) { toast(e.message); return; }
    if (!append) body.innerHTML = '';
    for (const r of rows) {
      body.append(h('tr', { class: r.action.endsWith('_failed') ? 'audit-bad' : '' },
        h('td', { class: 'audit-time' }, when(r.at)),
        h('td', {}, r.actor),
        h('td', {}, label(r.action) || LABELS[r.action] || r.action),
        h('td', {}, r.target_name || (r.target_type ? `${r.target_type} ${r.target_id}` : '')),
        h('td', { class: 'audit-details', title: JSON.stringify(r.details) }, summary(r.details)),
        h('td', {}, r.ip)));
    }
    last = rows.length ? rows.at(-1).id : last;
    more.classList.toggle('hidden', rows.length < 100);
    empty.classList.toggle('hidden', !!body.children.length);
  };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(), 250); });
  more.addEventListener('click', () => load(true));
  container.append(h('div', { class: 'audit' },
    h('div', { class: 'row' }, search),
    h('div', { class: 'audit-scroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'On'), h('th', {}, 'Details'), h('th', {}, 'From'))), body)),
    empty, more));
  load();
  return { refresh: () => load() };
}
