// The browser storage of FleetPilot: backups, merging, broken data.
import assert from 'node:assert/strict';

// A localStorage for Node
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
mem.set('fleetpilot.v1', '{ broken json');
const { store } = await import('../../src/js/store.js');
let n = 0;

assert.deepEqual(store.data.done, {}, 'broken data starts empty'); n++;
store.update(d => { d.done['First item'] = true; });
store.setPref('theme', 'dark');
assert.equal(JSON.parse(mem.get('fleetpilot.v1')).done['First item'], true, 'saved under fleetpilot.v1'); n++;

const backup = JSON.parse(store.exportAll('1.2.3'));
assert.equal(backup.app, 'FleetPilot'); assert.equal(backup.kind, 'backup'); assert.equal(backup.version, '1.2.3'); n++;

// Restoring merges: nothing done here is lost, nothing is doubled
store.update(d => { d.done = { 'Second item': true }; });
store.importAll(JSON.stringify(backup));
assert.deepEqual(Object.keys(store.data.done).sort(), ['First item', 'Second item'], 'merge keeps both'); n++;
store.importAll(JSON.stringify(backup));
assert.equal(Object.keys(store.data.done).length, 2, 'restoring twice changes nothing'); n++;
assert.throws(() => store.importAll('{"something": "else"}'), /Not a valid FleetPilot file/); n++;

console.log(`store: ${n} checks passed`);
