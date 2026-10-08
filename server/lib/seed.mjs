// FleetPilot: what a new installation starts with. Built-in roles, the built-in workflows (which
// people may change; they are only made when missing) and two starter templates. Runs at every
// start and never changes what is there.
import { query, tx } from '../core/db.mjs';
import { log } from '../core/log.mjs';
import { BUILTIN_ROLES } from './access.mjs';
import { normalizeDefinition, previewPlaybook } from './compile.mjs';
import { normalizeWorkflow } from './runner.mjs';

export const BUILTIN_WORKFLOWS = [
  {
    builtin: 'takeover', kind: 'takeover', name: 'Take over a Debian host',
    description: 'For a fresh install with an SSH server: logs in with the login of the installation, makes FleetPilot the manager with certificates, sets new passwords and keys, turns off password logins and applies the desired state.',
    definition: { trigger: { type: 'manual' }, approval: 'role', steps: [
      { type: 'connect', values: { become: 'su' } },
      { type: 'enroll', values: { hostCert: true, removeBootstrap: true } },
      { type: 'facts', values: {} },
      { type: 'hostname', values: {} },
      { type: 'passwords', values: { users: ['root'], length: 24, symbols: true } },
      { type: 'keys', values: { users: ['root'], cert: true, days: 30 } },
      { type: 'nopasswords', values: { root: false } },
      { type: 'apply', values: {} }
    ] }
  },
  {
    builtin: 'apply', kind: 'maintain', name: 'Apply desired state',
    description: 'Brings the hosts in line with the templates of their site, groups and themselves.',
    definition: { trigger: { type: 'manual' }, approval: 'role', steps: [{ type: 'apply', values: {} }] }
  },
  {
    builtin: 'check', kind: 'maintain', name: 'Check drift',
    description: 'Every night: compares every managed host with its desired state, without changing anything.',
    definition: { trigger: { type: 'schedule', cron: '30 2 * * *' }, approval: 'role', steps: [{ type: 'check', values: {} }] }
  },
  {
    builtin: 'push', kind: 'maintain', name: 'Apply templates',
    description: 'Used by "Push to hosts" of a template: applies chosen templates only.',
    definition: { trigger: { type: 'manual' }, approval: 'role', steps: [{ type: 'templates', values: { templates: [] } }] }
  },
  {
    builtin: 'rotate', kind: 'maintain', name: 'Rotate passwords',
    description: 'New random passwords for root on every host, kept in the vault with their history.',
    definition: { trigger: { type: 'manual' }, approval: 'role', steps: [{ type: 'passwords', values: { users: ['root'], length: 24, symbols: true } }] }
  },
  {
    builtin: 'update', kind: 'maintain', name: 'Update packages',
    description: 'Installs all updates, then reboots the hosts that need it, ten percent at a time.',
    definition: { trigger: { type: 'manual' }, approval: 'role', batch: { size: 10, unit: 'percent' }, steps: [{ type: 'update', values: { mode: 'dist', autoremove: true } }, { type: 'reboot', values: { onlyNeeded: true, timeout: 600 } }] }
  },
  {
    builtin: 'reboot', kind: 'maintain', name: 'Reboot in batches',
    description: 'Reboots the hosts, one batch after the other, waiting for each.',
    definition: { trigger: { type: 'manual' }, approval: 'role', batch: { size: 1, unit: 'hosts' }, steps: [{ type: 'reboot', values: { onlyNeeded: false, timeout: 600 } }] }
  }
];

const STARTER_TEMPLATES = [
  {
    name: 'Debian base', description: 'What every Debian server needs: name, time, language, updates, SSH without passwords, a firewall and basic hardening.',
    settings: [
      { type: 'hostname', values: { hostsLine: true } },
      { type: 'timezone', values: { zone: 'Etc/UTC' } },
      { type: 'ntp', values: { servers: [], only: false } },
      { type: 'journald', values: {} },
      { type: 'sshd', values: { port: 22, passwords: false, root: 'prohibit-password', modern: true } },
      { type: 'packages', values: { packages: [{ name: 'htop', state: 'present' }, { name: 'curl', state: 'present' }, { name: 'vim', state: 'present' }, { name: 'tmux', state: 'present' }] } },
      { type: 'unattended', values: { scope: 'security', reboot: false } },
      { type: 'firewall', values: { incoming: 'drop', ping: true, forward: true } },
      { type: 'hardening', values: {} },
      { type: 'qemuagent', values: {} }
    ]
  },
  {
    name: 'Web server', description: 'nginx with one site, its port open in the firewall.',
    settings: [{ type: 'nginx', values: { sites: [{ name: 'default', names: '{{ fp_fqdn }}', port: 80, root: '/var/www/html' }], removeDefault: true } }]
  }
];

export async function seed() {
  // Roles: only when there are none at all
  if (!(await query('select 1 from roles limit 1')).length) {
    for (const r of BUILTIN_ROLES) await query('insert into roles (name, description, permissions, builtin) values ($1, $2, $3, true) on conflict do nothing', [r.name, r.description, JSON.stringify(r.permissions)]);
    log.info('roles created', { roles: BUILTIN_ROLES.map(r => r.name) });
  }
  for (const w of BUILTIN_WORKFLOWS) {
    if ((await query('select 1 from workflows where builtin = $1', [w.builtin])).length) continue;
    const def = normalizeWorkflow(w.kind, w.definition);
    await tx(async c => {
      const exists = (await c.query('select 1 from workflows where lower(name) = lower($1)', [w.name])).rows.length;
      const [row] = (await c.query('insert into workflows (name, description, kind, definition, builtin, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
        [exists ? `${w.name} (built in)` : w.name, w.description, w.kind, JSON.stringify(def), w.builtin, 'FleetPilot'])).rows;
      await c.query('insert into workflow_versions (workflow_id, version, definition, created_by) values ($1, 1, $2, $3)', [row.id, JSON.stringify(def), 'FleetPilot']);
    });
  }
  // Starter templates: once, on an empty installation
  const [s] = await query("select value from settings where key = 'seeded.templates'");
  if (!s) {
    for (const t of STARTER_TEMPLATES) {
      if ((await query('select 1 from templates where lower(name) = lower($1)', [t.name])).length) continue;
      const def = normalizeDefinition({ settings: t.settings });
      await tx(async c => {
        const [row] = (await c.query('insert into templates (name, description, current_version, created_by) values ($1, $2, 1, $3) returning id', [t.name, t.description, 'FleetPilot'])).rows;
        await c.query('insert into template_versions (template_id, version, definition, playbook, note, created_by) values ($1, 1, $2, $3, $4, $5)', [row.id, JSON.stringify(def), previewPlaybook(def, t.name), 'Starter template', 'FleetPilot']);
      });
    }
    await query("insert into settings (key, value) values ('seeded.templates', 'true') on conflict do nothing");
  }
}
