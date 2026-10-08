-- FleetPilot: the first tables (example: replace before the first release).
-- Migrations are never changed or removed once released: add a new numbered file instead.
create table items (
  id bigint generated always as identity primary key,
  title text not null check (length(title) between 1 and 200),
  created_at timestamptz not null default now()
);
