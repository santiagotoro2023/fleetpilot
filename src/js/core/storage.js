// Storage in the browser for FleetPilot (blueprint 1.1.0).
// One key, fleetpilot.v1, holds everything. Its shape only ever grows: new fields get
// defaults, nothing is renamed, so an update never loses what a user did.
// The project describes its data (src/js/store.js): createStore() does the rest.
export const STORAGE_KEY = 'fleetpilot.v1';
export const APP_NAME = 'FleetPilot';

/**
 * shape: {
 *   empty(): a fresh state (must contain prefs: {})
 *   normalize(d): d with every missing field filled in
 *   merge(current, added): both together, nothing done is lost, the current browser wins conflicts
 *   valid(d): looks like data of this app (for imports)
 *   isEmpty(d): nothing worth moving
 * }
 */
export function createStore(shape) {
  const normalize = d => { const n = shape.normalize(d && typeof d === 'object' ? d : shape.empty()); n.prefs ??= {}; return n; };
  let data = shape.empty();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) data = normalize(JSON.parse(raw));
  } catch { /* private window, blocked storage or broken data: start empty */ }
  const persist = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* full or blocked */ } };
  return {
    get data() { return data; },
    persist,
    get prefs() { return data.prefs; },
    setPref(k, v) { data.prefs[k] = v; persist(); },
    /** A backup file: everything in this browser, with a small header so it is recognized later */
    exportAll(version = '') { return JSON.stringify({ app: APP_NAME, kind: 'backup', version, exported: new Date().toISOString(), data }, null, 2); },
    /** Import a backup file or transferred data. merge keeps everything already in this browser. */
    importAll(json, { merge = true } = {}) {
      let d = typeof json === 'string' ? JSON.parse(json) : json;
      if (d && d.app === APP_NAME && d.kind === 'backup' && d.data) d = d.data;
      if (!d || typeof d !== 'object' || !shape.valid(d)) throw new Error(`Not a valid ${APP_NAME} file`);
      data = merge ? normalize(shape.merge(normalize(JSON.parse(JSON.stringify(data))), normalize(d))) : normalize(d);
      persist();
    },
    snapshot() { return JSON.stringify(data); },
    isEmpty() { return shape.isEmpty(data); },
    /** Replace the data with the result of fn(data) and save */
    update(fn) { data = normalize(fn(data) ?? data); persist(); }
  };
}
