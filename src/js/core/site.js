// Facts about this installation (site.json, written by the installer, the container or
// the app server) and moving a user's data between addresses (blueprint 1.1.0).
// Browser data lives per address, so when a server gets a new main address, users take
// their data along with one click.
import { h, toast } from './ui.js';
import { pack, unpack } from './pack.js';

let site = {};
export const siteInfo = () => site;
export async function loadSite() {
  try {
    const r = await Promise.race([fetch('site.json', { cache: 'no-store' }), new Promise((_, no) => setTimeout(no, 1500))]);
    if (r.ok) site = await r.json();
  } catch { /* opened as a file, without the installer, or slow */ }
  return site;
}

/** The main address of this server, if it differs from the one in the address bar */
export function otherHome() {
  try {
    const u = site.canonical && new URL(site.canonical);
    return u && /^https?:$/.test(u.protocol) && u.origin !== location.origin ? u.origin : null;
  } catch { return null; }
}
/** Base for links that others open: the main address when there is one */
export const siteBase = () => (otherHome() || location.origin) + location.pathname;

async function moveUrl(home, store) {
  const to = encodeURIComponent(location.hash || '#/');
  if (store.isEmpty()) return `${home}/${location.hash || ''}`;
  return `${home}/#/migrate/${await pack(store.snapshot())}?to=${to}`;
}

/** Small card in the corner when the server has a new main address */
export function moveCard(store) {
  const home = otherHome();
  if (!home || store.prefs.moveHidden === home) return;
  const name = new URL(home).host;
  const empty = store.isEmpty();
  const card = h('aside', { class: 'movecard no-print', role: 'status' },
    h('b', {}, 'FleetPilot has a new address'),
    h('p', {}, 'This server is now reachable at ', h('b', {}, name), empty ? '.' : '. Your data is saved in this browser per address, so take it along.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => { location.href = await moveUrl(home, store); } }, empty ? 'Go there' : 'Move my data there'),
      h('button', { class: 'btn ghost', onclick: () => { store.setPref('moveHidden', home); card.remove(); } }, 'Not now')));
  document.body.append(card);
}

/**
 * #/migrate/<code>?from=…&to=…: data handed over from an older address of this server
 * (the move card above, or migrate.html for http:// → https://). Merging never
 * overwrites anything done here, so a second transfer is harmless.
 */
export async function receiveMigration(code, store, route) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const from = q.get('from') || '';
  const to = /^#\/[\w\-/.]*$/.test(q.get('to') || '') ? q.get('to') : '#/';
  let ok = false;
  try { store.importAll(await unpack(code), { merge: true }); ok = true; }
  catch { toast('The data could not be transferred. Download a backup at the old address and restore it here.'); }
  // The bridge on plain HTTP waits for this confirmation, so it hands the data over only once
  if (ok && from === `http://${location.host}`) { location.replace(`${from}/#/moved/${encodeURIComponent(to)}`); return; }
  history.replaceState(null, '', to);
  route();
  if (ok) toast('Your data from the old address is here now.');
}
