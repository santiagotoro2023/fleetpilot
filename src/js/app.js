// FleetPilot: the router. Every view renders into <main class="main"> (src/js/views/), the
// shell (theme, menu, site.json) is src/js/core/shell.js, signing in the library element auth.
import { h } from './core/ui.js';
import { startApp, markNav, routeParts } from './core/shell.js';
import { store } from './store.js';
import { session, guard } from './lib/auth.js';
import { main, loadMeta, meta } from './common.js';
import { viewOverview } from './views/overview.js';
import { viewHosts, viewHost, viewGroup } from './views/hosts.js';
import { viewNetwork, viewSubnet } from './views/network.js';
import { viewAutomate } from './views/automate.js';
import { viewTemplate } from './views/template.js';
import { viewWorkflow } from './views/workflow.js';
import { viewRuns, viewRun } from './views/runs.js';
import { viewSettings } from './views/settings.js';

let cleanup = [];
let routeNo = 0;
/** Things a view must stop when the page changes (timers, listeners) */
export const onLeave = fn => cleanup.push(fn);
function clear() { cleanup.forEach(f => { try { f(); } catch { /* ignore */ } }); cleanup = []; main.innerHTML = ''; main.scrollTop = 0; }

async function route() {
  clear();
  const no = ++routeNo;
  if (guard(main)) { meta.catalog = null; return; }
  if (!meta.catalog) {
    main.append(h('div', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
    try { await loadMeta(); } catch { return; }
    if (no !== routeNo) return;
    main.innerHTML = '';
  }
  const [nav = '', a, b] = routeParts();
  markNav(n => n === (nav || 'overview'));
  const q = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  const ctx = { onLeave, query: q, store, rerender: () => window.dispatchEvent(new HashChangeEvent('hashchange')) };
  try {
    if (nav === 'hosts' && a === 'group' && b) await viewGroup(ctx, b);
    else if (nav === 'hosts' && a) await viewHost(ctx, a);
    else if (nav === 'hosts') await viewHosts(ctx);
    else if (nav === 'network' && a) await viewSubnet(ctx, a);
    else if (nav === 'network') await viewNetwork(ctx);
    else if (nav === 'automate' && a === 'template' && b) await viewTemplate(ctx, b);
    else if (nav === 'automate' && a === 'workflow' && b) await viewWorkflow(ctx, b);
    else if (nav === 'automate') await viewAutomate(ctx, a);
    else if (nav === 'runs' && a) await viewRun(ctx, a);
    else if (nav === 'runs') await viewRuns(ctx);
    else if (nav === 'settings') await viewSettings(ctx, a);
    else await viewOverview(ctx);
  } catch (e) {
    if (no !== routeNo) return;
    if (!main.children.length) main.append(h('div', { class: 'page' }, h('h1', {}, 'This page could not be opened'), h('p', { class: 'muted' }, e.message || String(e)), h('a', { class: 'btn', href: '#/' }, 'To the overview')));
  }
  if (no === routeNo && !document.title.startsWith('FleetPilot')) document.title = `${document.title} · FleetPilot`;
}

await session.load().catch(() => {});
startApp({ store, route });
