-- Library element "secrets": the keys that encrypted something in this database (only their
-- ids, never the keys). A key that does not match stops the app instead of losing data.
create table secret_keys (
  id text primary key,
  created_at timestamptz not null default now()
);
