// Start of the app server (blueprint @@BLUEPRINT_VERSION@@): database, migrations, routes, HTTP,
// and a clean stop on SIGTERM (systemd, Docker and Kubernetes all send it).
//   start({ routes: [items, …] })   every route module is a function (app) => { app.get(…) }
//   start({ routes, onStart, onStop })   onStart() after migrations and listening (workers of the
//   library element jobs), onStop() first on SIGTERM
import http from 'node:http';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { connect, migrate, query, close } from './db.mjs';
import { createApp } from './http.mjs';

export async function start({ routes = [], onStart, onStop } = {}) {
  await connect();
  await migrate();
  const app = createApp({ health: async () => (await query('select 1 as ok'))[0].ok === 1 });
  for (const r of routes) await r(app);
  const server = http.createServer(app.handle);
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Without a host: IPv6 and IPv4 where the system has IPv6, otherwise IPv4 only
    server.listen(config.port, config.host || undefined, resolve);
  });
  log.info(`${config.appName} ${config.version} is running`, { port: config.port, host: config.host || 'all', canonical: config.canonical || undefined });
  if (onStart) await onStart();
  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    server.close();
    setTimeout(() => process.exit(0), 10_000).unref();
    if (onStop) await onStop().catch(e => log.error('stopping failed', { error: e.message }));
    await close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  return server;
}
