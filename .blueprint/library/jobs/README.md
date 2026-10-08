# Background jobs (`jobs`)

Work that takes longer than a request, or must happen later or regularly: a queue in PostgreSQL
that every replica of the app works on. A job is taken by exactly one worker, retried with a
growing pause when it fails, can be cancelled while it runs, reports progress, and is taken over
when its replica stops. Schedules (cron) turn into jobs. No Redis, no second service. Built for
FleetPilot's runs.

## When to use

- Something runs longer than a few seconds: talking to other systems, builds, imports, reports.
- Something must run later, regularly (every night), or survive a restart of the app.
- Several replicas must share work without doing anything twice.

## When not to use

- Work that finishes within a request: do it in the request.
- Thousands of jobs per second: that is a message broker (and a deviation).
- Static apps.

## API

```js
import { jobs, startJobs, stopJobs } from './lib/jobs.mjs';
jobs.define('report.build', async job => {            // job: { id, kind, payload, attempt, signal, progress(obj) }
  await job.progress({ step: 'collect' });
  if (job.signal.aborted) return;                     // cancelled: stop soon
  return { rows: 12 };                                // stored as the result
});
await start({ routes, onStart: () => startJobs({ concurrency: 4 }), onStop: stopJobs });

const id = await jobs.enqueue('report.build', { month: '2026-10' }, { maxAttempts: 3, runAt, priority, dedupeKey });
await jobs.get(id);       // { status: queued|running|done|failed|cancelled, progress, result, error, attempts, … }
await jobs.cancel(id);
await jobs.schedule('nightly', '15 2 * * *', 'report.build', {});   // 5 cron fields, UTC
await jobs.prune(30);     // finished jobs older than 30 days
```

## Rules

- Handlers are safe to run twice (a replica can die after the work but before it was recorded).
- Payloads hold ids, not whole records, and never secrets (they are stored as they are).
- Long handlers check `job.signal.aborted` and pass the signal on (to `fetch`, child processes).
- A failed attempt waits 10 s, 20 s, 40 s, … (at most an hour) before the next one.
- The app shows jobs in its own words (a run, an import); the element has no page of its own.

## Files

`server/lib/jobs.mjs`, `server/migrations-lib/jobs/0001_jobs.sql`, `test/unit/lib-jobs.test.mjs`
