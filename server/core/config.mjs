// Configuration of the app server (blueprint 1.1.1): only environment variables,
// all named FLEETPILOT_*, the same in every deployment (installer, Docker, Kubernetes).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => (process.env[`FLEETPILOT_${k}`] ?? '').trim() || d;

function canonical() {
  const v = env('CANONICAL', '').replace(/\/$/, '');
  if (v && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(v)) {
    console.error(`fleetpilot: ignoring FLEETPILOT_CANONICAL='${v}' (expected e.g. https://fleetpilot.example.com, without a path)`);
    return '';
  }
  return v;
}

export const config = {
  appId: 'fleetpilot',
  appName: 'FleetPilot',
  databaseUrl: env('DATABASE_URL', ''),
  host: env('HOST', ''),                 // empty: every address (IPv6 and IPv4 where available)
  port: Number(env('PORT', '8080')),
  webDir: path.resolve(env('WEB_DIR', path.join(HERE, '..', '..', 'src'))),
  version: env('VERSION', 'dev'),
  canonical: canonical(),
  logLevel: env('LOG_LEVEL', 'info'),
  bodyLimit: 1024 * 1024                 // JSON request bodies: at most 1 MB
};
