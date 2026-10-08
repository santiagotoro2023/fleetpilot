// Library element "jobs" (blueprint @@BLUEPRINT_VERSION@@): schedules, the queue, retries, cancelling,
// recovery after a stopped worker, with the test database of test/run.mjs.
import assert from 'node:assert/strict';
import { jobs, startJobs, stopJobs, nextRun, parseCron } from '../../server/lib/jobs.mjs';
import { connect, migrate, query, close } from '../../server/core/db.mjs';

let n = 0;
const at = s => new Date(s);
assert.equal(nextRun('*/15 * * * *', at('2026-10-07T10:07:30Z')).toISOString(), '2026-10-07T10:15:00.000Z'); n++;
assert.equal(nextRun('15 2 * * *', at('2026-10-07T10:07:00Z')).toISOString(), '2026-10-08T02:15:00.000Z'); n++;
assert.equal(nextRun('0 9 * * 1-5', at('2026-10-09T10:00:00Z')).toISOString(), '2026-10-12T09:00:00.000Z', 'Friday → Monday'); n++;
assert.equal(nextRun('0 0 1 1 *', at('2026-10-07T00:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z'); n++;
assert.equal(nextRun('30 4 * * 7', at('2026-10-07T00:00:00Z')).getUTCDay(), 0, 'weekday 7 is Sunday'); n++;
assert.throws(() => parseCron('* * *'), /5 fields/); n++;
assert.throws(() => parseCron('61 * * * *'), /outside/); n++;

await connect({ url: process.env.@@APP_ENV@@_TEST_DATABASE_URL, waitSeconds: 10 });
await migrate();
await query('delete from jobs'); await query('delete from job_schedules');
const seen = [];
let flaky = 0;
jobs.define('test.echo', async job => { seen.push(job.payload.v); await job.progress({ half: true }); return { echoed: job.payload.v }; });
jobs.define('test.flaky', async () => { if (++flaky < 2) throw new Error('not yet'); return 'ok'; });
jobs.define('test.slow', async job => { for (let i = 0; i < 100 && !job.signal.aborted; i++) await new Promise(r => setTimeout(r, 50)); return 'finished'; });
const wait = async (id, statuses = ['done', 'failed', 'cancelled'], ms = 15_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { const j = await jobs.get(id); if (statuses.includes(j.status)) return j; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`job ${id} did not reach ${statuses}`);
};

await startJobs({ concurrency: 2 });
const e = await jobs.enqueue('test.echo', { v: 7 });
const done = await wait(e);
assert.equal(done.status, 'done'); assert.deepEqual(done.result, { echoed: 7 }); assert.deepEqual(done.progress, { half: true }); n++;

// Retries with a back-off; run_at is moved into the past to skip the wait
const f = await jobs.enqueue('test.flaky', {}, { maxAttempts: 3 });
await wait(f, ['queued', 'done'], 5000).then(async j => { if (j.status === 'queued') await query('update jobs set run_at = now() where id = $1', [f]); });
const fj = await wait(f);
assert.equal(fj.status, 'done'); assert.equal(fj.attempts, 2); n++;

// Dedupe: the same key while queued or running gives the same job
const d1 = await jobs.enqueue('test.slow', {}, { dedupeKey: 'only-one' });
const d2 = await jobs.enqueue('test.slow', {}, { dedupeKey: 'only-one' });
assert.equal(d1, d2); n++;
await wait(d1, ['running']);
assert.equal(await jobs.cancel(d1), true);
const c = await wait(d1);
assert.equal(c.status, 'cancelled', 'a running job stops when cancelled'); n++;

// A queued job that is cancelled never runs
await stopJobs();
const q = await jobs.enqueue('test.echo', { v: 99 });
await jobs.cancel(q);
assert.equal((await jobs.get(q)).status, 'cancelled'); n++;

// A job whose worker died is taken again
const r = await jobs.enqueue('test.echo', { v: 5 }, { maxAttempts: 2 });
await query("update jobs set status = 'running', attempts = 1, locked_by = 'gone', heartbeat_at = now() - interval '5 minutes' where id = $1", [r]);
await startJobs({ concurrency: 1 });
await new Promise(res => setTimeout(res, 300));
const rj = await wait(r);
assert.equal(rj.status, 'done', 'recovered'); assert.ok(seen.includes(5)); n++;
assert.ok(!seen.includes(99)); n++;

// Schedules become jobs
await jobs.schedule('test-every-minute', '* * * * *', 'test.echo', { v: 'scheduled' });
await query("update job_schedules set next_at = now() - interval '1 second' where name = 'test-every-minute'");
for (let i = 0; i < 200 && !seen.includes('scheduled'); i++) await new Promise(res => setTimeout(res, 100));
assert.ok(seen.includes('scheduled'), 'a due schedule runs'); n++;
const [s] = await jobs.schedules();
assert.ok(new Date(s.next_at) > new Date(), 'and its next time is in the future'); n++;
await jobs.unschedule('test-every-minute');
await stopJobs();
assert.ok(await jobs.prune(0) >= 4); n++;
await close();
console.log(`lib-jobs: ${n} checks passed`);
