-- Library element "auth": accounts, sessions, sign-in attempts and the policy.
create table auth_users (
  id bigint generated always as identity primary key,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{1,62}$'),
  name text not null default '' check (length(name) <= 120),
  email text not null default '' check (length(email) <= 200),
  password_hash text not null,
  password_history jsonb not null default '[]',
  password_changed_at timestamptz not null default now(),
  must_change_password boolean not null default false,
  is_admin boolean not null default false,
  disabled boolean not null default false,
  totp_secret text,
  totp_enabled boolean not null default false,
  totp_last_counter bigint not null default 0,
  recovery_codes jsonb not null default '[]',
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table auth_sessions (
  id bigint generated always as identity primary key,
  token_hash text not null unique,
  user_id bigint not null references auth_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  verified_at timestamptz,
  expires_at timestamptz not null,
  ip text not null default '',
  user_agent text not null default ''
);
create index auth_sessions_user_id on auth_sessions (user_id);

create table auth_attempts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  ip text not null default '',
  username text not null default '',
  ok boolean not null
);
create index auth_attempts_ip on auth_attempts (ip, at);
create index auth_attempts_at on auth_attempts (at);

create table auth_settings (
  id integer primary key default 1 check (id = 1),
  policy jsonb not null default '{}',
  setup_code text
);
insert into auth_settings default values;
