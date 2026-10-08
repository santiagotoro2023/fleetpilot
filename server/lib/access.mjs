// FleetPilot: who may do what, where. Administrators (from the library element auth) may do
// everything; everybody else gets the rights of their roles. A role gives each area a level and
// can be limited to sites and groups (with everything inside them).
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';

// The levels of each area, from nothing to everything
export const AREAS = {
  hosts: { title: 'Hosts', levels: ['none', 'view', 'change', 'manage'], text: 'View hosts; change them (groups, tags, desired state); manage them (add, remove, sources).' },
  network: { title: 'Network', levels: ['none', 'view', 'change'], text: 'View or change subnets, VLANs and addresses.' },
  automation: { title: 'Templates and workflows', levels: ['none', 'view', 'change'], text: 'View or change templates and workflows.' },
  runs: { title: 'Runs', levels: ['none', 'view', 'run', 'approve'], text: 'View runs; start workflows; approve the runs of others.' },
  vault: { title: 'Vault', levels: ['none', 'view', 'reveal', 'change'], text: 'See which secrets exist; show their values; add and change them.' }
};
export const LEVEL_NAMES = { none: 'No access', view: 'View', change: 'Change', manage: 'Manage', run: 'Run', approve: 'Approve', reveal: 'Show values' };

export const BUILTIN_ROLES = [
  { name: 'Engineer', description: 'Builds and runs: hosts, network, templates and workflows, without approvals.', permissions: { hosts: 'manage', network: 'change', automation: 'change', runs: 'approve', vault: 'change', needsApproval: false } },
  { name: 'Operator', description: 'Runs the existing workflows on hosts and looks at everything.', permissions: { hosts: 'change', network: 'view', automation: 'view', runs: 'run', vault: 'view', needsApproval: false } },
  { name: 'Trainee', description: 'Learns on the job: may start workflows, but every run waits for an approval.', permissions: { hosts: 'view', network: 'view', automation: 'view', runs: 'run', vault: 'none', needsApproval: true } },
  { name: 'Viewer', description: 'Looks, changes nothing.', permissions: { hosts: 'view', network: 'view', automation: 'view', runs: 'view', vault: 'none', needsApproval: false } }
];

export function normalizePermissions(p = {}) {
  const out = {};
  for (const [area, a] of Object.entries(AREAS)) out[area] = a.levels.includes(p[area]) ? p[area] : 'none';
  out.needsApproval = !!p.needsApproval;
  return out;
}

const rank = (area, level) => AREAS[area].levels.indexOf(level);

/** The groups and all their descendants, from ids */
async function groupTree() {
  const rows = await query('select id, parent_id from groups');
  const kids = new Map();
  for (const r of rows) { const p = String(r.parent_id ?? ''); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(String(r.id)); }
  return ids => {
    const out = new Set(), todo = [...ids].map(String);
    while (todo.length) { const g = todo.pop(); if (out.has(g)) continue; out.add(g); todo.push(...(kids.get(g) || [])); }
    return out;
  };
}

/**
 * The rights of the signed-in user: { admin, roles, can(area, level, groupId?), needsApproval(groupId?),
 * scope(area, level) → null (everywhere) or a Set of group ids }. Cached on the request.
 */
export async function accessOf(ctx) {
  if (ctx.access) return ctx.access;
  const u = ctx.user;
  if (!u) throw httpError(401, 'signed_out', 'Sign in first.');
  if (u.isAdmin) {
    ctx.access = { admin: true, roles: [], can: () => true, needsApproval: () => false, scope: () => null };
    return ctx.access;
  }
  const roles = (await query('select r.* from roles r join user_roles ur on ur.role_id = r.id where ur.user_id = $1', [u.id]))
    .map(r => ({ ...r, permissions: normalizePermissions(r.permissions), scope: (r.scope_group_ids || []).map(String) }));
  const expand = roles.some(r => r.scope.length) ? await groupTree() : null;
  for (const r of roles) r.within = r.scope.length ? expand(r.scope) : null;
  const inside = (r, groupId) => !r.within || (groupId !== undefined && groupId !== null && r.within.has(String(groupId)));
  ctx.access = {
    admin: false, roles,
    can(area, level, groupId) {
      return roles.some(r => rank(area, r.permissions[area]) >= rank(area, level) && (groupId === undefined || inside(r, groupId)));
    },
    needsApproval(groupId) {
      const able = roles.filter(r => rank('runs', r.permissions.runs) >= rank('runs', 'run') && (groupId === undefined || inside(r, groupId)));
      return !able.length || able.every(r => r.permissions.needsApproval);
    },
    scope(area, level) {
      const able = roles.filter(r => rank(area, r.permissions[area]) >= rank(area, level));
      if (able.some(r => !r.within)) return null;
      return new Set(able.flatMap(r => [...r.within]));
    }
  };
  return ctx.access;
}

/** Stops the request unless the user may (somewhere, or for this group) */
export async function need(ctx, area, level, groupId) {
  const a = await accessOf(ctx);
  if (!a.can(area, level, groupId)) {
    throw httpError(403, 'not_allowed', `Your roles do not allow this (${AREAS[area].title}: ${LEVEL_NAMES[level].toLowerCase()}${groupId !== undefined ? ' for this group' : ''}).`);
  }
  return a;
}

/** SQL to limit hosts to the groups the user may see: [whereSql, params] (hosts aliased as h) */
export async function hostFilter(ctx, level = 'view', area = 'hosts', start = 1) {
  const a = await accessOf(ctx);
  const s = a.scope(area, level);
  if (s === null) return ['true', []];
  if (!s.size) return ['false', []];
  return [`h.group_id = any($${start}::bigint[])`, [[...s]]];
}
