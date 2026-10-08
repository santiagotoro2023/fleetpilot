// FleetPilot: the app server. The blueprint's core (server/core/) does configuration, database,
// migrations and HTTP; the library elements sign people in (auth), record what they do (audit),
// encrypt the vault (secrets) and run the work in the background (jobs). This file wires them up
// with FleetPilot's API (server/api/).
import { start } from './core/server.mjs';
import { secrets, setupSecrets } from './lib/secrets.mjs';
import { auth } from './lib/auth.mjs';
import { audit, record } from './lib/audit.mjs';
import { jobs, startJobs, stopJobs } from './lib/jobs.mjs';
import { seed } from './lib/seed.mjs';
import { defineRunJobs } from './lib/runner.mjs';
import { resolveTargets, scheduleWorkflows } from './api/workflows.mjs';
import { getSetting } from './api/settings.mjs';
import meta from './api/meta.mjs';
import overview from './api/overview.mjs';
import groups from './api/groups.mjs';
import hosts from './api/hosts.mjs';
import sources from './api/sources.mjs';
import network from './api/network.mjs';
import templates from './api/templates.mjs';
import workflows from './api/workflows.mjs';
import runs from './api/runs.mjs';
import vault from './api/vault.mjs';
import access from './api/access.mjs';
import settings from './api/settings.mjs';

await start({
  routes: [
    setupSecrets,
    auth({ onEvent: record, encrypt: secrets.encrypt, decrypt: secrets.decrypt, policy: { totp: 'admins' } }),
    audit(),
    async () => { await seed(); },
    meta, overview, groups, hosts, sources, network, templates, workflows, runs, vault, access, settings
  ],
  onStart: async () => {
    defineRunJobs({ resolveTargets });
    await scheduleWorkflows();
    await jobs.schedule('prune-runs', '17 3 * * *', 'runs.prune', {});
    await startJobs({ concurrency: Number(await getSetting('runs.concurrency')) || 4 });
  },
  onStop: stopJobs
});
