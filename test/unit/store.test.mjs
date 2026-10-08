// What FleetPilot keeps in the browser: preferences only, robust against broken data.
import assert from 'node:assert/strict';

// A localStorage for Node
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
mem.set('fleetpilot.v1', '{ broken json');
const { store } = await import('../../src/js/store.js');
let n = 0;

assert.deepEqual(store.data.prefs, {}, 'broken data starts empty'); n++;
store.setPref('theme', 'dark');
store.setPref('hosts.tab', 'table');
assert.equal(JSON.parse(mem.get('fleetpilot.v1')).prefs.theme, 'dark', 'saved under fleetpilot.v1'); n++;
const backup = JSON.parse(store.exportAll('1.2.3'));
assert.equal(backup.app, 'FleetPilot'); n++;
store.setPref('theme', 'light');
store.importAll(JSON.stringify(backup));
assert.equal(store.data.prefs.theme, 'light', 'this browser wins'); n++;
assert.throws(() => store.importAll('{"something": "else"}'), /Not a valid FleetPilot file/); n++;
console.log(`store: ${n} checks passed`);
