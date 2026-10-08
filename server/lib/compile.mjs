// FleetPilot: from templates to playbooks. A template is a list of settings ({ id, type, values });
// a host's desired state is the templates of its site, its groups and the host itself, merged
// from the least to the most specific; the merged state becomes one Ansible play.
import crypto from 'node:crypto';
import { httpError } from '../core/http.mjs';
import { AREAS, VARIABLES, normalizeValues } from './catalog.mjs';
import { SETTINGS } from './catalog-settings.mjs';
import { SERVICES, EXTRA_HANDLERS } from './catalog-services.mjs';
import { networkTasks } from './network.mjs';
import { toYaml } from './yaml.mjs';

export const TYPES = new Map([...SETTINGS, ...SERVICES].map(t => [t.id, t]));
const AREA_ORDER = AREAS.map(a => a.id);
const NETWORK = new Set(['interface', 'vlans', 'bonds', 'bridges', 'routes', 'dns']);

/** What the web app needs to draw the forms */
export function catalogForClient() {
  const strip = f => ({ ...f, ...(f.columns ? { columns: f.columns.map(strip) } : {}) });
  return {
    areas: AREAS,
    variables: VARIABLES,
    types: [...TYPES.values()].map(t => ({ id: t.id, area: t.area, group: t.group || null, title: t.title, text: t.text, single: !!t.single, collect: t.collect || null, fields: t.fields.map(strip) }))
  };
}

/** A template definition, checked: { settings: [{ id, type, values, off }] } */
export function normalizeDefinition(def) {
  const list = Array.isArray(def?.settings) ? def.settings : [];
  if (list.length > 300) throw httpError(400, 'too_many', 'A template can have at most 300 settings.');
  const seen = new Set();
  return {
    settings: list.map(s => {
      const type = TYPES.get(s?.type);
      if (!type) throw httpError(400, 'bad_setting', `There is no setting "${s?.type}".`);
      if (type.single && seen.has(type.id)) throw httpError(400, 'duplicate_setting', `${type.title} can be in a template only once.`);
      seen.add(type.id);
      const id = /^[a-z0-9-]{4,40}$/.test(s.id || '') ? s.id : crypto.randomBytes(6).toString('hex');
      return { id, type: type.id, values: normalizeValues(type, s.values || {}), ...(s.off ? { off: true } : {}) };
    })
  };
}

/**
 * Merges definitions from the least to the most specific: one value per single type (the last
 * wins), the rows of collecting types put together (a later row with the same key wins).
 * Returns Map(type id → values).
 */
export function mergeDefinitions(defs) {
  const merged = new Map();
  for (const def of defs) {
    for (const s of def?.settings || []) {
      if (s.off) continue;
      const type = TYPES.get(s.type);
      if (!type) continue;
      if (type.collect) {
        const { field, key } = type.collect;
        const prev = merged.get(type.id);
        const rows = new Map((prev?.[field] || []).map(r => [String(r[key]), r]));
        for (const r of s.values[field] || []) rows.set(String(r[key]), r);
        merged.set(type.id, { ...(prev || {}), ...s.values, [field]: [...rows.values()] });
      } else merged.set(type.id, s.values);
    }
  }
  return merged;
}

/** The secrets a desired state needs (passwords, keys, shared secrets, vault entries) */
export function needsOf(merged) {
  const out = [];
  for (const [id, v] of merged) for (const n of TYPES.get(id).needs?.(v) || []) out.push(n);
  return out;
}

/** The ports a desired state opens, and the SSH port */
export function portsOf(merged) {
  const ports = [];
  for (const [id, v] of merged) for (const p of TYPES.get(id).ports?.(v) || []) ports.push(p);
  return { ports, sshPort: merged.get('sshd')?.port || 22 };
}

/** Tasks and handlers of a merged desired state, in the order of the areas */
export function tasksOf(merged) {
  const { ports, sshPort } = portsOf(merged);
  const ctx = { ports, sshPort };
  const tasks = [], handlers = new Map();
  const addHandlers = hs => { for (const [k, h] of Object.entries(hs || {})) if (!handlers.has(k)) handlers.set(k, h); };
  const ids = [...merged.keys()].sort((a, b) => {
    const ta = TYPES.get(a), tb = TYPES.get(b);
    return AREA_ORDER.indexOf(ta.area) - AREA_ORDER.indexOf(tb.area) || [...TYPES.keys()].indexOf(a) - [...TYPES.keys()].indexOf(b);
  });
  let networkDone = false;
  for (const id of ids) {
    if (NETWORK.has(id)) {
      if (networkDone) continue;
      networkDone = true;
      const n = networkTasks(Object.fromEntries([...merged].filter(([k]) => NETWORK.has(k))));
      tasks.push(...n.tasks);
      addHandlers(n.handlers);
      continue;
    }
    const r = TYPES.get(id).tasks?.(merged.get(id), ctx);
    if (!r) continue;
    tasks.push(...r.tasks);
    addHandlers(r.handlers);
  }
  addHandlers(EXTRA_HANDLERS);
  // Handlers: every one listens to its name; a list becomes several tasks in order.
  // Applying network settings goes last, so the connection stays until everything else is done.
  const order = [...handlers.keys()].sort((a, b) => (a === 'Apply the network settings') - (b === 'Apply the network settings'));
  const hs = order.flatMap(k => [].concat(handlers.get(k)).map(h => ({ ...h, listen: k })));
  // Only handlers that something notifies
  const notified = new Set(tasks.flatMap(t => t.notify || []));
  return { tasks, handlers: hs.filter(h => notified.has(h.listen)) };
}

/** One play for a desired state */
export function playOf(merged, { name = 'Desired state', hosts = 'all', check = false } = {}) {
  const { tasks, handlers } = tasksOf(merged);
  return {
    name, hosts, become: true, gather_facts: true,
    ...(check ? { check_mode: true, diff: true } : {}),
    tasks: tasks.length ? tasks : [{ name: 'Nothing to do yet', 'ansible.builtin.debug': { msg: 'This desired state has no settings.' } }],
    ...(handlers.length ? { handlers } : {})
  };
}

/** The playbook of one template, as YAML, to show in the editor */
export function previewPlaybook(def, name = 'Template') {
  const merged = mergeDefinitions([def]);
  return `# ${name}: generated by FleetPilot from the template. Do not edit: change the template.\n` + toYaml([playOf(merged, { name })]);
}

/** A stable hash of a merged desired state (hosts with the same state share one play) */
export function stateHash(merged) {
  return crypto.createHash('sha256').update(JSON.stringify([...merged].sort((a, b) => a[0].localeCompare(b[0])))).digest('hex').slice(0, 16);
}
