// FleetPilot API: what the web app needs to know once: the catalog of settings and steps, the
// areas of rights and the rights of the signed-in user, the kinds of secrets, versions.
//   GET /api/meta
import { config } from '../core/config.mjs';
import { catalogForClient } from '../lib/compile.mjs';
import { stepsForClient } from '../lib/steps.mjs';
import { AREAS, LEVEL_NAMES, accessOf } from '../lib/access.mjs';
import { KINDS } from '../lib/vault.mjs';
import { ansibleVersion } from '../lib/ansible.mjs';

let ansible;
export default function meta(app) {
  app.get('/api/meta', async ctx => {
    const a = await accessOf(ctx);
    if (ansible === undefined) ansible = await ansibleVersion();
    const rights = Object.fromEntries(Object.entries(AREAS).map(([k, v]) => [k, [...v.levels].reverse().find(l => a.can(k, l)) || 'none']));
    return {
      version: config.version, ansible,
      catalog: catalogForClient(), steps: stepsForClient(),
      access: { areas: AREAS, levels: LEVEL_NAMES, admin: a.admin, rights, needsApproval: a.needsApproval(), roles: a.roles.map(r => r.name) },
      vaultKinds: KINDS
    };
  });
}
