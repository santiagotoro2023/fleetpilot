// FleetPilot: settings. Your account; for administrators the accounts with their roles, the roles
// (rights per area, for which groups, with or without approval), the sign-in rules, FleetPilot's
// own settings and the audit log; the vault; FleetPilot's SSH keys and a certificate for yourself.
import { h, toast, iconBtn } from '../core/ui.js';
import { api } from '../core/api.js';
import { I } from '../icons.js';
import { session, accountView, usersView, policyView, confirmFresh } from '../lib/auth.js';
import { auditView } from '../lib/audit.js';
import { main, meta, get, call, can, pageHead, btn, tabs, dialog, field, input, select, table, empty, when, chips, groupOptions, forgetChoices } from '../common.js';
import { revealSecret } from './hosts.js';

const AUDIT_LABELS = {
  'host.added': 'Added hosts', 'host.changed': 'Changed a host', 'host.removed': 'Removed a host', 'host.bulk_move': 'Moved hosts', 'host.bulk_tag': 'Tagged hosts', 'host.bulk_untag': 'Removed tags from hosts', 'host.bulk_retire': 'Retired hosts', 'host.bulk_activate': 'Brought hosts back',
  'group.created': 'Added a group', 'group.changed': 'Changed a group', 'group.deleted': 'Deleted a group',
  'template.created': 'Created a template', 'template.saved': 'Saved a template version', 'template.changed': 'Changed a template', 'template.deleted': 'Deleted a template',
  'template.assigned': 'Applied a template', 'template.unassigned': 'Removed a template',
  'workflow.created': 'Created a workflow', 'workflow.changed': 'Changed a workflow', 'workflow.deleted': 'Deleted a workflow',
  'run.started': 'Started a run', 'run.approved': 'Approved a run', 'run.rejected': 'Rejected a run', 'run.cancelled': 'Cancelled a run',
  'secret.created': 'Added a secret', 'secret.changed': 'Changed a secret', 'secret.revealed': 'Showed a secret', 'secret.deleted': 'Deleted a secret',
  'ssh_certificate.issued': 'Got an SSH certificate', 'role.created': 'Added a role', 'role.changed': 'Changed a role', 'role.deleted': 'Deleted a role',
  'user.roles_changed': 'Changed the roles of an account', 'settings.changed': 'Changed the settings',
  'subnet.created': 'Added a subnet', 'subnet.changed': 'Changed a subnet', 'subnet.deleted': 'Deleted a subnet', 'subnet.scanned': 'Scanned a subnet',
  'vlan.created': 'Added a VLAN', 'vlan.changed': 'Changed a VLAN', 'vlan.deleted': 'Deleted a VLAN', 'pool.created': 'Added a pool', 'pool.deleted': 'Deleted a pool',
  'address.reserved': 'Reserved an address', 'address.assigned': 'Assigned an address', 'address.changed': 'Changed an address', 'address.released': 'Released an address',
  'source.created': 'Added a Proxmox cluster', 'source.changed': 'Changed a Proxmox cluster', 'source.deleted': 'Removed a Proxmox cluster', 'source.imported': 'Imported VMs'
};

export async function viewSettings(ctx, tab) {
  document.title = 'Settings';
  const admin = meta.access.admin;
  const list = [['account', 'Your account'], ...(can('vault', 'view') ? [['vault', 'Vault']] : []), ['ssh', 'SSH keys'],
    ...(admin ? [['accounts', 'Accounts'], ['roles', 'Roles'], ['rules', 'Sign-in rules'], ['fleetpilot', 'FleetPilot'], ['audit', 'Audit log']] : [])];
  tab = list.some(x => x[0] === tab) ? tab : 'account';
  const page = h('div', { class: 'page' });
  page.append(pageHead('Settings', `FleetPilot ${meta.version}${meta.ansible ? ` with Ansible ${meta.ansible}` : ''}. Signed in as ${session.user.username}${admin ? ', administrator' : meta.access.roles.length ? `, ${meta.access.roles.join(', ')}` : ''}.`));
  const body = h('div', {});
  page.append(tabs(list, tab, id => { history.replaceState(null, '', `#/settings/${id}`); draw(id); }), body);
  main.append(page);
  const draw = async id => {
    body.innerHTML = '';
    if (id === 'vault') await drawVault(body);
    else if (id === 'ssh') await drawSsh(body);
    else if (id === 'accounts') await drawAccounts(body);
    else if (id === 'roles') await drawRoles(body);
    else if (id === 'rules') await policyView(body);
    else if (id === 'fleetpilot') await drawFleetPilot(body);
    else if (id === 'audit') auditView(body, { label: a => AUDIT_LABELS[a] || null });
    else accountView(body);
  };
  await draw(tab);
}

// ---------------------------------------------------------------- Accounts and their roles
async function drawAccounts(body) {
  let roles = await get('/api/access/roles');
  let users = await get('/api/access/users');
  body.append(h('p', { class: 'muted small' }, 'Administrators may do everything. Everyone else gets their rights from roles; give each account one or more.'));
  const v = usersView(body, {
    extra: u => {
      const a = users.find(x => x.username === u.username);
      if (u.isAdmin) return h('span', { class: 'small muted' }, 'Everything');
      return h('div', { class: 'row', style: { gap: '4px' } }, a?.roles.length ? chips(a.roles.map(r => r.name)) : h('span', { class: 'small muted' }, 'No role: sees nothing'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => editRoles(a) }, 'Roles'));
    },
    onChange: async () => { users = await get('/api/access/users'); }
  });
  async function editRoles(a) {
    if (!a) return;
    const boxes = roles.map(r => [r, h('input', { type: 'checkbox', checked: a.roles.some(x => x.id === r.id) })]);
    const ok = await dialog(`Roles of ${a.username}`, boxes.map(([r, c]) => h('label', { class: 'row small fp-check fp-rolepick' }, c, h('span', {}, h('b', {}, r.name), h('span', { class: 'muted' }, ` ${r.description}`)))), {
      onOk: () => call(() => api.put(`/api/access/users/${a.id}/roles`, { roleIds: boxes.filter(([, c]) => c.checked).map(([r]) => r.id) }))
    });
    if (ok) { users = await get('/api/access/users'); roles = await get('/api/access/roles'); v.refresh(); toast('Roles saved'); }
  }
}

async function drawRoles(body) {
  const roles = await get('/api/access/roles');
  const groups = await groupOptions();
  const groupName = new Map(groups);
  const areas = meta.access.areas, names = meta.access.levels;
  body.append(h('p', { class: 'muted small' }, 'A role gives rights per area, everywhere or only for some sites and groups. With "Runs wait for an approval", someone with the right to approve looks at every run first.'));
  body.append(h('div', { class: 'row', style: { marginBottom: '10px' } }, btn('Add a role', 'plus', () => roleDialog(null), 'primary')));
  body.append(table(['Role', ...Object.values(areas).map(a => a.title), 'Where', 'Accounts', ''], roles.map(r => h('tr', {},
    h('td', {}, h('b', {}, r.name), r.builtin ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, 'built in') : null, h('div', { class: 'small muted' }, r.description), r.permissions.needsApproval ? h('div', { style: { marginTop: '4px' } }, h('span', { class: 'fp-state wait' }, 'Runs wait for an approval')) : null),
    ...Object.keys(areas).map(k => h('td', { class: 'small' }, names[r.permissions[k]] || 'No access')),
    h('td', { class: 'small' }, r.scope_group_ids.length ? r.scope_group_ids.map(g => groupName.get(g) || '?').join(', ') : 'Everywhere'),
    h('td', {}, String(r.users)),
    h('td', { class: 'fp-actions-cell' }, btn('Change', '', () => roleDialog(r), 'ghost'), btn('Delete', '', async () => {
      if (await dialog(`Delete the role ${r.name}`, [h('p', {}, r.users ? `${r.users} accounts lose the rights of this role.` : 'No account has it.')], { ok: 'Delete the role', okClass: 'danger', onOk: () => call(() => api.del(`/api/access/roles/${r.id}`)) })) redraw();
    }, 'ghost'))))));
  const redraw = () => { body.innerHTML = ''; drawRoles(body); };
  async function roleDialog(r) {
    const name = input({ value: r?.name || '', placeholder: 'Web team' });
    const desc = input({ value: r?.description || '' });
    const sels = Object.fromEntries(Object.entries(areas).map(([k, a]) => [k, select(a.levels.map(l => [l, names[l]]), r?.permissions[k] || 'none')]));
    const approval = h('input', { type: 'checkbox', checked: !!r?.permissions.needsApproval });
    const scope = h('select', { class: 'input', multiple: true, size: Math.min(6, Math.max(3, groups.length)) }, groups.map(([v, n]) => h('option', { value: v, selected: (r?.scope_group_ids || []).includes(String(v)) }, n)));
    const ok = await dialog(r ? `Change ${r.name}` : 'Add a role', [
      h('div', { class: 'fp-grid2' }, field('Name', name), field('Description', desc)),
      h('div', { class: 'fp-grid3' }, Object.entries(areas).map(([k, a]) => field(a.title, sels[k], a.text))),
      h('label', { class: 'row small fp-check' }, approval, 'Runs wait for an approval by someone else'),
      groups.length ? field('Only for these sites and groups (and the groups inside)', scope, 'Nothing chosen: everywhere.') : null
    ], {
      wide: true, ok: r ? 'Save' : 'Add the role',
      onOk: () => call(() => {
        const b = { name: name.value, description: desc.value, permissions: { ...Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value])), needsApproval: approval.checked }, scope: [...scope.selectedOptions].map(o => o.value) };
        return r ? api.patch(`/api/access/roles/${r.id}`, b) : api.post('/api/access/roles', b);
      })
    });
    if (ok) redraw();
  }
}

// ---------------------------------------------------------------- FleetPilot's own settings
async function drawFleetPilot(body) {
  const s = await get('/api/settings');
  const conc = input({ mono: true, type: 'number', min: 1, max: 64, value: s['runs.concurrency'], style: { width: '96px' } });
  const keep = input({ mono: true, type: 'number', min: 7, max: 3650, value: s['runs.keep_days'], style: { width: '96px' } });
  const live = h('input', { type: 'checkbox', checked: s['network.live_check'] });
  const reveal = input({ mono: true, type: 'number', min: 1, max: 60, value: s['vault.reveal_minutes'], style: { width: '96px' } });
  body.append(h('form', { class: 'fp-form', onsubmit: async e => {
    e.preventDefault();
    await call(() => api.put('/api/settings', { 'runs.concurrency': Number(conc.value), 'runs.keep_days': Number(keep.value), 'network.live_check': live.checked, 'vault.reveal_minutes': Number(reveal.value) })).then(() => toast('Settings saved')).catch(() => {});
  } },
  h('h2', {}, 'Runs'),
  h('div', { class: 'fp-grid2' }, field('Runs at the same time', conc, 'Per FleetPilot server. Takes effect after a restart.'), field('Keep finished runs for', keep, 'Days, with their logs.')),
  h('h2', {}, 'Network'),
  h('label', { class: 'row small fp-check' }, live, 'Ask an address on the network before it is given out (SSH, Windows and printer ports, then ping)'),
  h('h2', {}, 'Vault'),
  field('A confirmation for showing secrets lasts', reveal, 'Minutes. After that, showing a value asks for the password or code again.'),
  h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { class: 'btn primary', type: 'submit' }, 'Save settings'))));
}

// ---------------------------------------------------------------- The vault
const SCOPES = { global: 'For everything', group: 'For a group', host: 'For one host', system: 'FleetPilot\'s own' };

async function drawVault(body) {
  const q = input({ type: 'search', class: 'input fp-find', placeholder: 'Find a secret: name, user or host', 'aria-label': 'Find a secret' });
  const scope = select([['', 'Every scope'], ...Object.entries(SCOPES)], '');
  const out = h('div', {});
  const load = async () => {
    const p = new URLSearchParams();
    if (q.value.trim()) p.set('q', q.value.trim());
    if (scope.value) p.set('scope', scope.value);
    const list = await get(`/api/vault?${p}`);
    out.innerHTML = '';
    if (!list.length) { out.append(empty(q.value || scope.value ? 'Nothing matches.' : 'The vault is empty. Add the login of your standard installation first: take-over workflows log in with it.')); return; }
    out.append(table(['Name', 'Kind', 'For', 'User', 'Version', 'Changed', ''], list.map(s => h('tr', {},
      h('td', {}, h('b', {}, s.name), s.public?.fingerprint ? h('div', { class: 'small muted mono' }, s.public.fingerprint) : null, s.public?.validTo ? h('div', { class: 'small muted' }, `Valid until ${new Date(s.public.validTo).toLocaleDateString()}`) : null),
      h('td', { class: 'fp-font' }, meta.vaultKinds[s.kind] || s.kind),
      h('td', {}, s.scope === 'host' ? h('a', { href: `#/hosts/${s.host_id}?tab=secrets` }, s.host_name || 'a host') : s.scope === 'group' ? `Group ${s.group_name || ''}` : SCOPES[s.scope]),
      h('td', {}, s.username || '–'), h('td', {}, String(s.version)), h('td', { class: 'muted' }, when(s.rotated_at || s.updated_at)),
      h('td', { class: 'fp-actions-cell' },
        can('vault', 'reveal') && (s.scope !== 'system' || meta.access.admin) ? btn('Show', 'eye', () => revealSecret(s), 'ghost') : null,
        btn('History', '', () => history(s), 'ghost'),
        can('vault', 'change') && s.scope !== 'system' ? btn('Change', '', async () => { if (await secretDialog({ secret: s })) load(); }, 'ghost') : null)))));
  };
  q.addEventListener('input', () => { clearTimeout(q._t); q._t = setTimeout(load, 250); });
  scope.addEventListener('change', load);
  body.append(h('p', { class: 'muted small' }, 'Every value is encrypted with the key of this installation. Showing one needs a fresh confirmation and is recorded in the audit log. Every change keeps the old version.'),
    h('div', { class: 'row fp-toolbar' }, q, scope, can('vault', 'change') ? btn('Add a secret', 'plus', async () => { if (await secretDialog({ scope: 'global' })) load(); }, 'primary') : null), out);
  await load();

  async function history(s) {
    const d = await get(`/api/vault/${s.id}`);
    await dialog(`History of ${s.name}`, [table(['Version', 'By', 'When', ''], d.versions.map(v => h('tr', {}, h('td', {}, String(v.version)), h('td', {}, v.created_by || ''), h('td', { class: 'muted' }, when(v.created_at)),
      h('td', {}, can('vault', 'reveal') && (s.scope !== 'system' || meta.access.admin) ? btn('Show', 'eye', () => revealSecret(s, v.version === s.version ? undefined : v.version), 'ghost') : null))))]);
  }
}

/**
 * Adds a secret (scope global, group or host) or changes one ({ secret }). Values per kind;
 * passwords can be made by FleetPilot. Resolves true when saved.
 */
export async function secretDialog({ scope = 'global', hostId = null, groupId = null, secret = null } = {}) {
  const kinds = Object.entries(meta.vaultKinds).filter(([k]) => k !== 'ssh_cert' || secret);
  const kind = select(kinds, secret?.kind || 'login', { disabled: !!secret });
  const name = input({ value: secret?.name || '', placeholder: 'Debian installation' });
  const user = input({ value: secret?.username || '', placeholder: 'admin', mono: true });
  const groups = !secret && scope !== 'host' && !groupId ? await groupOptions() : null;
  const groupSel = groups?.length ? select(groups, '') : null;
  const gen = h('input', { type: 'checkbox' });
  const genLen = input({ mono: true, type: 'number', min: 12, max: 128, value: 24, style: { width: '80px' } });
  const ta = (ph, rows = 5) => h('textarea', { class: 'input mono fp-area', rows, spellcheck: 'false', placeholder: ph });
  const f = {
    password: input({ type: 'password', mono: true, autocomplete: 'new-password', placeholder: secret ? 'Leave empty to keep it' : '' }),
    becomePassword: input({ type: 'password', mono: true, autocomplete: 'new-password', placeholder: secret ? 'Leave empty to keep it' : 'Only for su' }),
    token: ta(secret ? 'Leave empty to keep it' : '', 3), text: ta(secret ? 'Leave empty to keep it' : ''),
    privateKey: ta('-----BEGIN OPENSSH PRIVATE KEY-----'), publicKey: ta('ssh-ed25519 AAAA… (optional)', 2),
    certificate: ta('-----BEGIN CERTIFICATE-----'), key: ta('-----BEGIN PRIVATE KEY-----')
  };
  const forKind = h('div', { class: 'fp-form' });
  const scopeSel = select([['global', 'For everything'], ...(groupSel ? [['group', 'For a group']] : [])], scope === 'host' ? 'global' : scope);
  const groupBox = groupSel ? h('div', {}, field('Group', groupSel)) : null;
  const showGroup = () => groupBox?.classList.toggle('hidden', scopeSel.value !== 'group');
  scopeSel.addEventListener('change', showGroup);
  showGroup();
  const drawKind = () => {
    forKind.innerHTML = '';
    const k = kind.value;
    const genRow = h('div', { class: 'row small' }, h('label', { class: 'row fp-check' }, gen, 'Let FleetPilot make a random password of'), genLen, 'characters');
    if (k === 'login') forKind.append(field('User', user), genRow, field('Password', f.password), field('Root password', f.becomePassword, 'When the user becomes root with su. Empty: the same as the password, or sudo.'));
    if (k === 'password') forKind.append(genRow, field('Password', f.password));
    if (k === 'token') forKind.append(field('User or token id', user), field('Token', f.token));
    if (k === 'note') forKind.append(field('Text', f.text));
    if (k === 'ssh_key') forKind.append(field('User', user), field('Private key', f.privateKey), field('Public key', f.publicKey));
    if (k === 'ssh_cert') forKind.append(field('Certificate', f.certificate));
    if (k === 'tls') forKind.append(field('Certificate (with the chain)', f.certificate), field('Private key', f.key));
  };
  kind.addEventListener('change', drawKind);
  drawKind();
  const r = await dialog(secret ? `Change ${secret.name}` : scope === 'host' ? 'Add a secret for this host' : 'Add a secret', [
    h('div', { class: 'fp-grid2' }, field('Kind', kind), field('Name', name)),
    !secret && scope !== 'host' && !groupId ? field('For', scopeSel) : null,
    groupBox,
    forKind,
    secret ? h('p', { class: 'small muted' }, 'Saving makes a new version; the old one stays in the history.') : null
  ], {
    ok: secret ? 'Save a new version' : 'Add the secret', wide: true,
    onOk: () => call(() => {
      const k = kind.value, data = {};
      for (const key of ['password', 'becomePassword', 'token', 'text', 'privateKey', 'publicKey', 'certificate', 'key']) if (f[key].value) data[key] = f[key].value;
      const b = { name: name.value, username: user.value, data, generate: gen.checked && ['login', 'password'].includes(k) ? { length: Number(genLen.value) || 24 } : undefined };
      if (secret) return api.put(`/api/vault/${secret.id}`, b);
      const sc = scope === 'host' ? 'host' : groupId ? 'group' : scopeSel.value;
      return api.post('/api/vault', { ...b, kind: k, scope: sc, hostId, groupId: groupId || (sc === 'group' ? groupSel?.value : null) || null });
    })
  });
  if (r) { forgetChoices(); toast(secret ? 'Saved' : 'Secret added'); }
  return !!r;
}

// ---------------------------------------------------------------- SSH: FleetPilot's keys, a certificate for yourself
async function drawSsh(body) {
  const k = await get('/api/vault/fleetpilot');
  const keyRow = (label, value, help) => h('div', { class: 'fp-keyrow' }, h('div', { class: 'row' }, h('b', {}, label), iconBtn(I.copy, `Copy ${label}`, () => { navigator.clipboard?.writeText(value); toast('Copied'); })),
    h('pre', { class: 'fp-pubkey' }, value), h('p', { class: 'small muted' }, help));
  body.append(h('h2', { class: 'fp-sec' }, 'How FleetPilot logs in'),
    h('p', { class: 'muted small' }, 'The take-over logs in once with a password and leaves FleetPilot\'s key. Then it creates the user fleetpilot, trusts FleetPilot\'s user certificate authority and gives the host a host certificate. From then on every run logs in with a certificate that is valid for a few minutes only.'),
    keyRow('FleetPilot\'s public key', k.fleetKey, 'Left on a host by the first login, removed after the take-over when the workflow says so.'),
    keyRow('User certificate authority', k.userCa, 'Hosts trust it for logins (TrustedUserCAKeys). Put it on hosts you set up yourself to let FleetPilot in.'),
    keyRow('Host certificate authority', k.hostCa, 'Signs the host keys of managed hosts. Add it to your known_hosts with "@cert-authority * " in front, and SSH never asks about host keys again.'));
  if (!can('hosts', 'change')) return;
  const pub = h('textarea', { class: 'input mono fp-area', rows: 2, spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA… you@laptop' });
  const hours = select([[1, '1 hour'], [4, '4 hours'], [8, '8 hours'], [24, '24 hours']], 8);
  const out = h('div', {});
  body.append(h('h2', { class: 'fp-sec' }, 'A certificate for yourself'),
    h('p', { class: 'muted small' }, `Log in to managed hosts with your own key: FleetPilot signs it for a few hours. You log in as the user of your host with the principal fp-${session.user.username}, when a template lets that principal in (Access, "Logins with SSH certificates").`),
    field('Your public key', pub), h('div', { class: 'row fp-assign' }, field('Valid for', hours), btn('Sign my key', 'key', async () => {
      const send = () => api.post('/api/vault/certificate', { publicKey: pub.value.trim(), hours: Number(hours.value) });
      let r;
      try { r = await send(); }
      catch (e) {
        if (e.code !== 'verify_needed') { toast(e.message); return; }
        if (!(await confirmFresh('Confirm that it is you'))) return;
        r = await call(send).catch(() => null);
      }
      if (!r) return;
      out.innerHTML = '';
      out.append(keyRow(`Your certificate (${r.hours} h, principal ${r.principal})`, r.certificate, 'Save it next to your key as id_ed25519-cert.pub (the name of the key with -cert.pub); SSH uses it on its own.'));
    }, 'primary')), out);
}
