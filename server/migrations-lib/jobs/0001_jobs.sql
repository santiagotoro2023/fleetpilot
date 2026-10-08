-- Library element "jobs": the queue and the schedules.
create table jobs (
  id bigint generated always as identity primary key,
  kind text not null check (kind ~ '^[a-z0-9_.-]{2,80}$'),
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  priority integer not null default 0,
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 1 check (max_attempts between 1 and 100),
  dedupe_key text,
  cancel_requested boolean not null default false,
  locked_by text,
  heartbeat_at timestamptz,
  progress jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_ready on jobs (priority desc, run_at, id) where status = 'queued';
create index jobs_running on jobs (heartbeat_at) where status = 'running';
create unique index jobs_dedupe on jobs (dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
create index jobs_finished on jobs (finished_at) where status in ('done', 'failed', 'cancelled');

create table job_schedules (
  name text primary key check (name ~ '^[a-z0-9_.-]{2,80}$'),
  cron text not null,
  kind text not null,
  payload jsonb not null default '{}',
  enabled boolean not null default true,
  next_at timestamptz not null,
  last_at timestamptz,
  updated_at timestamptz not null default now()
);
