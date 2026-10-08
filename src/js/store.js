// What FleetPilot keeps in the browser, on top of src/js/core/storage.js (key fleetpilot.v1).
// The shape only ever grows: add fields with defaults, never rename or remove one,
// so every update reads what older versions saved (spec/06-data.md).
import { createStore } from './core/storage.js';

const empty = () => ({ prefs: {}, done: {} });

export const store = createStore({
  empty,
  normalize: d => {
    const e = empty(), m = { ...e, ...d };
    for (const k of Object.keys(e)) if (!m[k] || typeof m[k] !== 'object') m[k] = e[k];
    return m;
  },
  // Restoring a backup or moving data merges: nothing done is lost, this browser wins conflicts
  merge: (cur, add) => {
    for (const [k, v] of Object.entries(add.done)) if (v) cur.done[k] = true;
    for (const [k, v] of Object.entries(add.prefs)) if (!(k in cur.prefs)) cur.prefs[k] = v;
    return cur;
  },
  valid: d => 'done' in d || 'prefs' in d,
  isEmpty: d => !Object.keys(d.done).length
});
