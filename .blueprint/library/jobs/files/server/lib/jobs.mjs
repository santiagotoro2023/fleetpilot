// Library element "jobs" (blueprint @@BLUEPRINT_VERSION@@): background work in a PostgreSQL queue.
// Every replica runs workers; a job is taken by exactly one of them (FOR UPDATE SKIP LOCKED),
// new jobs wake the workers at once (LISTEN/NOTIFY), a job whose worker died is taken again.
//
//   import { jobs, startJobs, stopJobs } from './lib/jobs.mjs'
//   jobs.define('report.build', async job => { … job.progress({ done: 3 }); if (job.signal.aborted) …; return result })
//   await start({ routes, onStart: () => startJobs({ concurrency: 4 }), onStop: stopJobs })
//   const id = await jobs.enqueue('report.build', { month: '2026-10' }, { maxAttempts: 3 })
//   await jobs.cancel(id)
//   await jobs.schedule('nightly-report', '15 2 * * *', 'report.build', { month: 'last' })
import crypto from 'node:crypto';
import os from 'node:os';
import { pool, query } from '../core/db.mjs';
import { log } from '../core/log.mjs';

const handlers = new Map();
const running = new Map();   // id → AbortController
const WORKER = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
const HEARTBEAT_MS = 10_000, STALE_S = 60, POLL_MS = 2_000;
let state = null;

// ---------------------------------------------------------------- Cron (5 fields, UTC)
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
/** Parses "m h dom mon dow" (*, lists, ranges, steps; Sunday is 0 or 7) into sets */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A schedule needs 5 fields: minute hour day month weekday');
  return parts.map((p, i) => {
    const [lo, hi] = FIELDS[i], set = new Set();
    for (const item of p.split(',')) {
      const m = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`Cannot read "${item}" in the schedule`);
      const [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(Number).concat(m[1].includes('-') ? [] : [m[2] ? hi : Number(m[1])]);
      const step = Number(m[2] || 1);
      if (a < lo || b > hi || a > b || step < 1) throw new Error(`"${item}" is outside ${lo}-${hi}`);
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return { set, any: p === '*' };
  });
}
/** The next time after `from` that matches the schedule (UTC) */
export function nextRun(expr, from = new Date()) {
  const [mi, ho, dom, mon, dow] = parseCron(expr);
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = dom.any && dow.any ? true : dom.any ? dow.set.has(t.getUTCDay()) : dow.any ? dom.set.has(t.getUTCDate()) : dom.set.has(t.getUTCDate()) || dow.set.has(t.getUTCDay());
    if (!mon.set.has(t.getUTCMonth() + 1) || !dayOk) { t.setUTCHours(24, 0, 0, 0); continue; }
    if (!ho.set.has(t.getUTCHours())) { t.setUTCMinutes(60, 0, 0); continue; }
    if (mi.set.has(t.getUTCMinutes())) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
  }
  throw new Error(`The schedule "${expr}" never runs`);
}

// ---------------------------------------------------------------- The queue
export const jobs = {
  /** A handler for a kind of job: async (job) => result. job: { id, kind, payload, attempt, signal, progress(obj) } */
  define(kind, handler) { handlers.set(kind, handler); },

  /** Adds a job; with a dedupe key, a job with the same key that is queued or running is returned instead */
  async enqueue(kind, payload = {}, { runAt = null, maxAttempts = 1, priority = 0, dedupeKey = null, client = null } = {}) {
    const q = client ? (s, a) => client.query(s, a).then(r => r.rows) : query;
    const rows = await q(`insert into jobs (kind, payload, run_at, max_attempts, priority, dedupe_key) values ($1, $2, coalesce($3, now()), $4, $5, $6)
      on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing returning id`,
    [kind, JSON.stringify(payload), runAt, maxAttempts, priority, dedupeKey]);
    if (!rows.length) { const [d] = await q("select id from jobs where dedupe_key = $1 and status in ('queued', 'running')", [dedupeKey]); return d ? String(d.id) : null; }
    await q("select pg_notify('jobs', $1)", [kind]);
    return String(rows[0].id);
  },

  async get(id) {
    const [j] = await query('select * from jobs where id = $1', [id]);
    return j ? { ...j, id: String(j.id) } : null;
  },

  /** Stops a queued job at once and asks a running one to stop (its signal aborts) */
  async cancel(id) {
    const [j] = await query(`update jobs set cancel_requested = true,
      status = case when status = 'queued' then 'cancelled' else status end,
      finished_at = case when status = 'queued' then now() else finished_at end
      where id = $1 and status in ('queued', 'running') returning status`, [id]);
    if (j?.status === 'running') await query("select pg_notify('jobs_cancel', $1)", [String(id)]);
    return !!j;
  },

  /** Creates or changes a schedule: a job of `kind` every time the cron expression (UTC) matches */
  async schedule(name, cron, kind, payload = {}, { enabled = true } = {}) {
    const next = nextRun(cron);
    await query(`insert into job_schedules (name, cron, kind, payload, enabled, next_at) values ($1, $2, $3, $4, $5, $6)
      on conflict (name) do update set cron = $2, kind = $3, payload = $4, enabled = $5,
        next_at = case when job_schedules.cron = $2 then job_schedules.next_at else $6 end, updated_at = now()`,
    [name, cron, kind, JSON.stringify(payload), enabled, next]);
  },
  async unschedule(name) { await query('delete from job_schedules where name = $1', [name]); },
  async schedules() { return query('select * from job_schedules order by name'); },

  /** Removes finished jobs older than the given days */
  async prune(days = 30) {
    return (await query("delete from jobs where status in ('done', 'failed', 'cancelled') and finished_at < now() - make_interval(days => $1) returning id", [days])).length;
  },
  worker: WORKER
};

async function claim(kinds) {
  const [j] = await query(`update jobs set status = 'running', locked_by = $2, started_at = now(), heartbeat_at = now(), attempts = attempts + 1
    where id = (select id from jobs where status = 'queued' and run_at <= now() and kind = any($1) and not cancel_requested
      order by priority desc, run_at, id for update skip locked limit 1)
    returning *`, [kinds, WORKER]);
  return j;
}

async function runOne(j) {
  const ac = new AbortController();
  running.set(String(j.id), ac);
  const beat = setInterval(() => {
    query("update jobs set heartbeat_at = now() where id = $1 and status = 'running' returning cancel_requested", [j.id])
      .then(r => { if (r[0]?.cancel_requested) ac.abort(); }).catch(() => {});
  }, HEARTBEAT_MS);
  const job = {
    id: String(j.id), kind: j.kind, payload: j.payload, attempt: j.attempts, signal: ac.signal,
    progress: p => query('update jobs set progress = $2 where id = $1', [j.id, JSON.stringify(p)]).catch(() => {})
  };
  try {
    const result = await handlers.get(j.kind)(job);
    if (ac.signal.aborted) await query("update jobs set status = 'cancelled', finished_at = now(), locked_by = null where id = $1", [j.id]);
    else await query("update jobs set status = 'done', result = $2, finished_at = now(), locked_by = null where id = $1", [j.id, JSON.stringify(result ?? null)]);
  } catch (e) {
    const cancelled = ac.signal.aborted;
    const retry = !cancelled && j.attempts < j.max_attempts;
    if (!cancelled) log.warn('job failed', { id: String(j.id), kind: j.kind, attempt: j.attempts, error: e.message });
    await query(`update jobs set status = $2, error = $3, locked_by = null, finished_at = case when $2 = 'queued' then null else now() end,
      run_at = case when $2 = 'queued' then now() + make_interval(secs => $4) else run_at end where id = $1`,
    [j.id, cancelled ? 'cancelled' : retry ? 'queued' : 'failed', String(e.message || e).slice(0, 4000), Math.min(3600, 5 * 2 ** j.attempts)]);
  } finally {
    clearInterval(beat);
    running.delete(String(j.id));
  }
}

/** Jobs whose worker stopped answering go back to the queue (or fail after their last attempt) */
async function recover() {
  const rows = await query(`update jobs set status = case when attempts < max_attempts and not cancel_requested then 'queued' else 'failed' end,
    error = 'The worker stopped while running it.', locked_by = null,
    finished_at = case when attempts < max_attempts and not cancel_requested then null else now() end
    where status = 'running' and heartbeat_at < now() - make_interval(secs => $1) returning id`, [STALE_S]);
  if (rows.length) log.warn('jobs taken over from a stopped worker', { ids: rows.map(r => String(r.id)) });
}

/** Turns due schedules into jobs (one replica per schedule and time) */
async function schedules() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const due = (await c.query('select * from job_schedules where enabled and next_at <= now() for update skip locked')).rows;
    for (const s of due) {
      await jobs.enqueue(s.kind, { ...s.payload, schedule: s.name }, { client: c, dedupeKey: `schedule:${s.name}` });
      await c.query('update job_schedules set last_at = now(), next_at = $2 where name = $1', [s.name, nextRun(s.cron)]);
    }
    await c.query('commit');
  } catch (e) { await c.query('rollback').catch(() => {}); log.warn('schedules failed', { error: e.message }); }
  finally { c.release(); }
}

/** Starts the workers of this replica (after the database is migrated) */
export async function startJobs({ concurrency = 2 } = {}) {
  if (state) return;
  const kinds = [...handlers.keys()];
  state = { stop: false, slots: concurrency, wake: null, timers: [] };
  const listener = await pool.connect();
  state.listener = listener;
  await listener.query('listen jobs');
  await listener.query('listen jobs_cancel');
  listener.on('notification', msg => {
    if (msg.channel === 'jobs_cancel') running.get(msg.payload)?.abort();
    else state?.wake?.();
  });
  const loop = async () => {
    while (!state.stop) {
      if (state.slots > 0 && kinds.length) {
        let j = null;
        try { j = await claim(kinds); } catch (e) { log.warn('jobs: cannot read the queue', { error: e.message }); }
        if (j) { state.slots--; runOne(j).finally(() => { if (state) { state.slots++; state.wake?.(); } }); continue; }
      }
      await new Promise(r => { state.wake = r; setTimeout(r, POLL_MS); });
    }
  };
  state.loop = loop();
  state.timers.push(setInterval(() => recover().catch(() => {}), 20_000), setInterval(() => schedules(), 15_000));
  recover().catch(() => {});
  schedules();
  log.info('jobs: workers started', { worker: WORKER, concurrency, kinds });
}

/** Stops taking jobs; running ones get up to `waitMs` to finish, then are left for recovery */
export async function stopJobs({ waitMs = 8_000 } = {}) {
  if (!state) return;
  state.stop = true;
  state.wake?.();
  state.timers.forEach(clearInterval);
  const t0 = Date.now();
  while (running.size && Date.now() - t0 < waitMs) await new Promise(r => setTimeout(r, 100));
  await state.listener.query('unlisten *').catch(() => {});
  state.listener.release();
  state = null;
}
