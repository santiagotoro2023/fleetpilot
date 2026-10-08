// FleetPilot API: settings of the installation (administrators).
//   GET /api/settings    PUT /api/settings
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';
import { requireAdmin } from '../lib/auth.mjs';
import { record } from '../lib/audit.mjs';

export const DEFAULTS = {
  'runs.concurrency': 4,          // runs at the same time per FleetPilot server
  'runs.keepDays': 180,           // finished runs are removed after so many days
  'hosts.autoTakeover': false,    // reserved: take-over workflows with the trigger "host added" decide
  'network.liveCheck': true,      // probe an address before it is handed out
  'vault.revealMinutes': 5        // how long a confirmation lasts for showing secrets
};
const RULES = {
  'runs.concurrency': v => Number.isInteger(v) && v >= 1 && v <= 64,
  'runs.keepDays': v => Number.isInteger(v) && v >= 7 && v <= 3650,
  'hosts.autoTakeover': v => typeof v === 'boolean',
  'network.liveCheck': v => typeof v === 'boolean',
  'vault.revealMinutes': v => Number.isInteger(v) && v >= 1 && v <= 60
};

export async function getSetting(key) {
  const [r] = await query('select value from settings where key = $1', [key]);
  return r ? r.value : DEFAULTS[key];
}
export async function allSettings() {
  const rows = await query('select key, value from settings where key = any($1)', [Object.keys(DEFAULTS)]);
  return { ...DEFAULTS, ...Object.fromEntries(rows.map(r => [r.key, r.value])) };
}

export default function settings(app) {
  app.get('/api/settings', async ctx => { requireAdmin(ctx); return allSettings(); });
  app.put('/api/settings', async ctx => {
    requireAdmin(ctx);
    const b = ctx.body || {};
    for (const [k, v] of Object.entries(b)) {
      if (!(k in DEFAULTS)) continue;
      if (!RULES[k](v)) throw httpError(400, 'bad_value', `The value for ${k} is not possible.`);
      await query('insert into settings (key, value) values ($1, $2) on conflict (key) do update set value = $2, updated_at = now()', [k, JSON.stringify(v)]);
    }
    await record(ctx, 'settings.changed', { changes: b });
    return allSettings();
  });
}
