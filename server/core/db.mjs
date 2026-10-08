// PostgreSQL for the app server (blueprint 1.1.1).
//   query(sql, params)   one statement, returns the rows
//   tx(async c => …)     several statements in one transaction (c.query(…))
// Migrations: server/migrations/NNNN_name.sql, applied in order at start, each in its own
// transaction, with an advisory lock so that replicas starting together never collide.
// Library elements bring their own (server/migrations-lib/<element>/NNNN_name.sql): they run
// first, numbered per element, recorded in schema_migrations_lib.
// A migration is never changed or removed once released; the database only ever grows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.mjs';
import { log } from './log.mjs';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LIB_MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations-lib');
const LOCK = 7_244_018_301;   // advisory lock id for migrations
export let pool = null;

export async function connect({ url = config.databaseUrl, waitSeconds = 60 } = {}) {
  if (!url) throw new Error('FLEETPILOT_DATABASE_URL is not set (postgres://user:password@host:5432/fleetpilot)');
  pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
  pool.on('error', e => log.error('database connection lost', { error: e.message }));
  // The database may still be starting (Compose, Kubernetes): try for a while
  for (let i = 0; ; i++) {
    try { await pool.query('select 1'); break; }
    catch (e) {
      if (i >= waitSeconds) throw new Error(`Cannot reach the database: ${e.message}`);
      if (i % 10 === 0) log.warn('waiting for the database', { error: e.message });
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return pool;
}

export const query = async (sql, params = []) => (await pool.query(sql, params)).rows;

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}

export function migrationFiles(dir = MIGRATIONS) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()
    .map(f => ({ version: Number(f.slice(0, 4)), name: f.slice(5, -4), file: path.join(dir, f) }));
}

/** The migrations of the library elements: { element: [files] } */
export function libraryMigrationFiles(dir = LIB_MIGRATIONS) {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().filter(e => fs.statSync(path.join(dir, e)).isDirectory()).map(e => [e, migrationFiles(path.join(dir, e))]));
}

async function migrateLibrary(c, dir) {
  const lib = libraryMigrationFiles(dir);
  if (!Object.keys(lib).length) return;
  await c.query('create table if not exists schema_migrations_lib (element text not null, version integer not null, name text not null, applied_at timestamptz not null default now(), primary key (element, version))');
  for (const [element, files] of Object.entries(lib)) {
    const done = new Set((await c.query('select version from schema_migrations_lib where element = $1', [element])).rows.map(r => r.version));
    const newest = Math.max(0, ...done), known = Math.max(0, ...files.map(f => f.version));
    if (newest > known) throw new Error(`The database is newer than this version of FleetPilot (library element ${element}: migration ${newest}, this version knows ${known}). Run the newer version again.`);
    for (const m of files.filter(f => !done.has(f.version))) {
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(m.file, 'utf8'));
        await c.query('insert into schema_migrations_lib (element, version, name) values ($1, $2, $3)', [element, m.version, m.name]);
        await c.query('commit');
        log.info('migration applied', { element, version: m.version, name: m.name });
      } catch (e) { await c.query('rollback'); throw new Error(`Migration ${m.version} (${m.name}) of ${element} failed: ${e.message}`); }
    }
  }
}

export async function migrate(dir = MIGRATIONS, libDir = LIB_MIGRATIONS) {
  const files = migrationFiles(dir);
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK]);
    await migrateLibrary(c, libDir);
    await c.query('create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select version from schema_migrations')).rows.map(r => r.version));
    const newest = Math.max(0, ...done), known = Math.max(0, ...files.map(f => f.version));
    if (newest > known) throw new Error(`The database is newer than this version of FleetPilot (migration ${newest}, this version knows ${known}). Run the newer version again; never go back over a migrated database.`);
    for (const m of files.filter(f => !done.has(f.version))) {
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(m.file, 'utf8'));
        await c.query('insert into schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
        await c.query('commit');
        log.info('migration applied', { version: m.version, name: m.name });
      } catch (e) { await c.query('rollback'); throw new Error(`Migration ${m.version} (${m.name}) failed: ${e.message}`); }
    }
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    c.release();
  }
}

export async function close() { await pool?.end(); pool = null; }
