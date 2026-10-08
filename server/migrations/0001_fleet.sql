-- FleetPilot: the first tables. Accounts, sessions, the audit log, jobs and the key ids come from
-- the library elements (server/migrations-lib/). Migrations are never changed once released.

-- Settings of the installation (one row per key)
create table settings (
  key text primary key check (key ~ '^[a-z0-9_.-]{2,80}$'),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Sites and groups: a tree. Sites are the top (a datacenter, a room, a lab), groups sit inside.
create table groups (
  id bigint generated always as identity primary key,
  parent_id bigint references groups (id) on delete restrict,
  kind text not null default 'group' check (kind in ('site', 'group')),
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index groups_name on groups (coalesce(parent_id, 0), lower(name));
create index groups_parent_id on groups (parent_id);

-- Roles: what people may do, where
create table roles (
  id bigint generated always as identity primary key,
  name text not null unique check (length(name) between 1 and 60),
  description text not null default '',
  permissions jsonb not null default '{}',
  scope_group_ids bigint[] not null default '{}',
  builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table user_roles (
  user_id bigint not null references auth_users (id) on delete cascade,
  role_id bigint not null references roles (id) on delete cascade,
  primary key (user_id, role_id)
);
create index user_roles_role_id on user_roles (role_id);

-- The vault: passwords, keys, certificates, tokens; data is encrypted (library element secrets)
create table secrets (
  id bigint generated always as identity primary key,
  scope text not null default 'global' check (scope in ('global', 'group', 'host', 'system')),
  group_id bigint references groups (id) on delete cascade,
  host_id bigint,
  kind text not null check (kind in ('login', 'password', 'ssh_key', 'ssh_cert', 'token', 'tls', 'note')),
  name text not null check (length(name) between 1 and 120),
  username text not null default '',
  data text not null,
  public jsonb not null default '{}',
  version integer not null default 1,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz
);
create unique index secrets_name on secrets (scope, coalesce(group_id, 0), coalesce(host_id, 0), lower(name));
create index secrets_host_id on secrets (host_id);
create table secret_versions (
  id bigint generated always as identity primary key,
  secret_id bigint not null references secrets (id) on delete cascade,
  version integer not null,
  data text not null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  unique (secret_id, version)
);

-- Hypervisors that list their machines (Proxmox VE)
create table sources (
  id bigint generated always as identity primary key,
  kind text not null default 'proxmox' check (kind in ('proxmox')),
  name text not null unique check (length(name) between 1 and 80),
  url text not null,
  token_id text not null default '',
  secret_id bigint references secrets (id) on delete set null,
  verify_tls boolean not null default true,
  fingerprint text not null default '',
  group_id bigint references groups (id) on delete set null,
  last_sync_at timestamptz,
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The hosts
create table hosts (
  id bigint generated always as identity primary key,
  name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$'),
  address text not null check (length(address) between 1 and 253),
  port integer not null default 22 check (port between 1 and 65535),
  kind text not null default 'linux' check (kind in ('linux', 'network')),
  group_id bigint references groups (id) on delete set null,
  state text not null default 'new' check (state in ('new', 'taking_over', 'managed', 'unreachable', 'failed', 'retired')),
  os text not null default '',
  os_version text not null default '',
  facts jsonb not null default '{}',
  tags text[] not null default '{}',
  notes text not null default '' check (length(notes) <= 4000),
  connection jsonb not null default '{}',
  host_keys text not null default '',
  overrides jsonb not null default '{}',
  drift jsonb,
  source_id bigint references sources (id) on delete set null,
  external_id text not null default '',
  last_seen_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index hosts_name on hosts (lower(name));
create index hosts_group_id on hosts (group_id);
create index hosts_source_id on hosts (source_id);
create index hosts_tags on hosts using gin (tags);
alter table secrets add constraint secrets_host_id_fkey foreign key (host_id) references hosts (id) on delete cascade;

create table source_vms (
  id bigint generated always as identity primary key,
  source_id bigint not null references sources (id) on delete cascade,
  external_id text not null,
  node text not null default '',
  name text not null default '',
  type text not null default '',
  status text not null default '',
  ips text[] not null default '{}',
  tags text[] not null default '{}',
  os text not null default '',
  host_id bigint references hosts (id) on delete set null,
  seen_at timestamptz not null default now(),
  unique (source_id, external_id)
);
create index source_vms_host_id on source_vms (host_id);

-- IP address management
create table vlans (
  id bigint generated always as identity primary key,
  site_id bigint references groups (id) on delete set null,
  vid integer not null check (vid between 1 and 4094),
  name text not null default '' check (length(name) <= 80),
  description text not null default '',
  created_at timestamptz not null default now()
);
create unique index vlans_site_vid on vlans (coalesce(site_id, 0), vid);

create table subnets (
  id bigint generated always as identity primary key,
  cidr cidr not null unique,
  name text not null default '' check (length(name) <= 80),
  vlan_id bigint references vlans (id) on delete set null,
  site_id bigint references groups (id) on delete set null,
  gateway inet,
  dns inet[] not null default '{}',
  search_domains text[] not null default '{}',
  ntp text[] not null default '{}',
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subnets_vlan_id on subnets (vlan_id);
create index subnets_site_id on subnets (site_id);

create table pools (
  id bigint generated always as identity primary key,
  subnet_id bigint not null references subnets (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  first_ip inet not null,
  last_ip inet not null,
  purpose text not null default '',
  created_at timestamptz not null default now(),
  check (first_ip <= last_ip)
);
create index pools_subnet_id on pools (subnet_id);

create table addresses (
  id bigint generated always as identity primary key,
  subnet_id bigint not null references subnets (id) on delete cascade,
  ip inet not null unique,
  state text not null default 'assigned' check (state in ('assigned', 'reserved', 'discovered', 'conflict')),
  host_id bigint references hosts (id) on delete set null,
  hostname text not null default '',
  mac text not null default '',
  note text not null default '',
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index addresses_subnet_id on addresses (subnet_id);
create index addresses_host_id on addresses (host_id);

-- Templates: a desired configuration, built with forms, versioned
create table templates (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  current_version integer not null default 0,
  archived boolean not null default false,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index templates_name on templates (lower(name));
create table template_versions (
  id bigint generated always as identity primary key,
  template_id bigint not null references templates (id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  playbook text not null default '',
  note text not null default '',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

-- Which templates apply where: to a site or group (and everything inside) or to one host
create table assignments (
  id bigint generated always as identity primary key,
  template_id bigint not null references templates (id) on delete cascade,
  group_id bigint references groups (id) on delete cascade,
  host_id bigint references hosts (id) on delete cascade,
  pinned_version integer,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  check ((group_id is null) <> (host_id is null))
);
create unique index assignments_target on assignments (template_id, coalesce(group_id, 0), coalesce(host_id, 0));
create index assignments_group_id on assignments (group_id);
create index assignments_host_id on assignments (host_id);

-- What was applied where, last
create table host_templates (
  host_id bigint not null references hosts (id) on delete cascade,
  template_id bigint not null references templates (id) on delete cascade,
  applied_version integer not null,
  applied_at timestamptz not null default now(),
  primary key (host_id, template_id)
);
create index host_templates_template_id on host_templates (template_id);

-- Workflows: a trigger and steps
create table workflows (
  id bigint generated always as identity primary key,
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  kind text not null check (kind in ('takeover', 'maintain')),
  definition jsonb not null default '{}',
  version integer not null default 1,
  enabled boolean not null default true,
  builtin text,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index workflows_name on workflows (lower(name));
create unique index workflows_builtin on workflows (builtin) where builtin is not null;
create table workflow_versions (
  id bigint generated always as identity primary key,
  workflow_id bigint not null references workflows (id) on delete cascade,
  version integer not null,
  definition jsonb not null,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  unique (workflow_id, version)
);

-- Runs of workflows on hosts
create table runs (
  id bigint generated always as identity primary key,
  workflow_id bigint references workflows (id) on delete set null,
  name text not null,
  kind text not null check (kind in ('takeover', 'maintain')),
  definition jsonb not null,
  params jsonb not null default '{}',
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule', 'host_added', 'template_changed', 'api')),
  status text not null default 'queued' check (status in ('awaiting_approval', 'queued', 'running', 'waiting', 'succeeded', 'partial', 'failed', 'cancelled', 'rejected')),
  check_only boolean not null default false,
  state jsonb not null default '{}',
  summary jsonb not null default '{}',
  requested_by_id bigint,
  requested_by text not null default '',
  approved_by text not null default '',
  approved_at timestamptz,
  reason text not null default '',
  job_id bigint,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index runs_status on runs (status, created_at desc);
create index runs_created on runs (created_at desc);
create table run_hosts (
  run_id bigint not null references runs (id) on delete cascade,
  host_id bigint not null,
  host_name text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'ok', 'changed', 'failed', 'unreachable', 'skipped')),
  batch integer not null default 0,
  primary key (run_id, host_id)
);
create index run_hosts_host_id on run_hosts (host_id);
create table run_steps (
  run_id bigint not null references runs (id) on delete cascade,
  step integer not null,
  host_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'ok', 'changed', 'failed', 'unreachable', 'skipped')),
  changed integer not null default 0,
  message text not null default '',
  started_at timestamptz,
  finished_at timestamptz,
  primary key (run_id, step, host_id)
);
create table run_logs (
  id bigint generated always as identity primary key,
  run_id bigint not null references runs (id) on delete cascade,
  at timestamptz not null default now(),
  step integer,
  host text not null default '',
  level text not null default 'info' check (level in ('info', 'ok', 'changed', 'warn', 'error', 'skip')),
  line text not null
);
create index run_logs_run on run_logs (run_id, id);
