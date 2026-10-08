// What FleetPilot keeps in the browser, on top of src/js/core/storage.js (key fleetpilot.v1):
// only preferences (theme, panel sizes, last tabs, filters). Everything else lives on the server.
// The shape only ever grows: add fields with defaults, never rename or remove one.
import { createStore } from './core/storage.js';

const empty = () => ({ prefs: {} });

export const store = createStore({
  empty,
  normalize: d => ({ ...empty(), ...d, prefs: d && typeof d.prefs === 'object' && d.prefs ? d.prefs : {} }),
  // Restoring merges: this browser's preferences win
  merge: (cur, add) => { for (const [k, v] of Object.entries(add.prefs || {})) if (!(k in cur.prefs)) cur.prefs[k] = v; return cur; },
  valid: d => 'prefs' in d,
  isEmpty: d => !Object.keys(d.prefs).length
});
