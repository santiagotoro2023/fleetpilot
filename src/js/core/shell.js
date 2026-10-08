// The app shell of every blueprint project (blueprint 1.1.1): theme switch,
// the active menu entry, the move card and the start of the hash router.
import { toast } from './ui.js';
import { I } from './icons.js';
import { loadSite, moveCard, receiveMigration } from './site.js';

export function applyTheme(store) {
  const t = store.prefs.theme;
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const btn = document.querySelector('#theme');
  const dark = t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches);
  btn.innerHTML = `<span>${dark ? I.sun : I.moon}</span>${dark ? 'Light' : 'Dark'}`;
}

function initTheme(store) {
  document.querySelector('#theme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    store.setPref('theme', dark ? 'light' : 'dark');
    applyTheme(store);
  });
  applyTheme(store);
}

/** Mark the menu entry of the current page: active(entryNav) decides, exactly one should match */
export function markNav(active) {
  document.querySelectorAll('.rail a[data-nav]').forEach(a => a.classList.toggle('active', !!active(a.dataset.nav)));
}

/** The parts of the current hash route: #/lab/routed?x=1 → ['lab', 'routed'] */
export const routeParts = () => location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);

/**
 * Start the app: theme, site.json, the first route, the move card.
 * route() renders the view of the current hash; it runs again on every hash change.
 */
export async function startApp({ store, route }) {
  initTheme(store);
  const run = () => {
    const [first, code] = routeParts();
    if (first === 'migrate') return receiveMigration(code || '', store, route);
    route();
  };
  window.addEventListener('hashchange', run);
  // Arriving from the plain HTTP address after the data was handed over (migrate.html)
  if (/[?&]moved=1/.test(location.hash)) {
    history.replaceState(null, '', location.hash.replace(/[?&]moved=1/, ''));
    setTimeout(() => toast('FleetPilot now runs over HTTPS. Your data came along.'), 300);
  }
  await loadSite();
  run();
  moveCard(store);
}
