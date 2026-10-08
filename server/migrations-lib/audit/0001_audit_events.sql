-- Library element "audit": who did what, when and from where. Rows are only ever added.
create table audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id bigint,
  actor text not null default '',
  action text not null check (action ~ '^[a-z0-9_.-]{2,80}$'),
  target_type text not null default '',
  target_id text not null default '',
  target_name text not null default '',
  details jsonb not null default '{}',
  ip text not null default ''
);
create index audit_events_at on audit_events (at desc);
create index audit_events_action on audit_events (action, at desc);
create index audit_events_target on audit_events (target_type, target_id, at desc);
create index audit_events_actor on audit_events (actor_id, at desc);
