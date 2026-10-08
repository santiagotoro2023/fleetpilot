# 7. Backend

## 7.1 Choosing the profile

| Choose | When |
|---|---|
| **static** | Every user works with their own data, and keeping it in their browser is fine: learning apps, calculators, converters, personal tools, editors that export files. Nothing to run but nginx; any number of replicas. |
| **server** | Data is shared between users or devices, must survive a browser being wiped, needs a login, or comes from the server (sensors, other systems). Node.js app server and PostgreSQL. |

When in doubt, ask the owner; it is decided once (`APP_PROFILE` never changes after the first
release).

## 7.2 The standard stack (server profile)

| Part | Standard | Why |
|---|---|---|
| Runtime | **Node.js**, ES modules, no build step; code runs on Node 18 (Debian 12) and newer, the image uses Node 22 | same language as the web app, in Debian, small |
| HTTP | `server/core/http.mjs` (blueprint): routes, JSON, errors, headers, static files | no framework to learn or update |
| Database | **PostgreSQL 15 or newer**, driver `pg` | one database for everything: relational, JSON, full text, queues (`SKIP LOCKED`), notifications (`LISTEN`) |
| Runtime dependencies | **only `pg`** | every dependency is a risk and an update to follow |
| Dev dependencies | **only `playwright`** | the browser tests |
| Configuration | environment variables `<ID>_…` (05-deployment.md, 5.2) | the same in every deployment |
| Logs | one JSON object per line on stdout (`server/core/log.mjs`) | journalctl, docker and kubectl read it |
| State | only in PostgreSQL | disposable containers, replicas |

Anything else (another database, another runtime library, a framework, a second service) is a
**deviation**: proposed to the owner with its reason and consequences, done only after an explicit
yes, recorded in `DEVIATIONS.md` (11-deviations.md). `blueprint check` fails on dependencies and
imports outside the standard that are not recorded.

## 7.3 Other databases: when a deviation can be justified

PostgreSQL is the default and covers almost everything. A different store can be proposed when:

| Store | Can be justified when | Consequences to state in the proposal |
|---|---|---|
| **SQLite** | the app must run on very small devices without PostgreSQL, single instance only, and never in Kubernetes with more than one replica | no replicas, backups by file copy, the Helm chart needs a volume and `replicaCount: 1`, the installer's backup functions change |
| **MariaDB / MySQL** | the app must work on an existing MariaDB/MySQL database that the owner cannot replace (existing data, another system writes to it) | another driver, other migration syntax, backups with `mariadb-dump`, the bundled database in Compose/Helm changes |
| **Redis / Valkey** | as an addition, never as the place of record: many short-lived values shared by replicas at a rate PostgreSQL should not carry (rate limits, live presence), after `UNLOGGED` tables and `LISTEN/NOTIFY` were considered | one more service in every deployment, its own health check |
| **Object storage (S3, MinIO)** | many files or single files over about 10 MB, so that the database and its backups would grow too large | credentials, a second backup, another service in Compose/Helm |

If more than one app needs the same alternative, it becomes a library element (12-library.md) so
that all of them do it the same way.

## 7.4 Layout

```
server/main.mjs          await start({ routes: [setupSecrets, auth(…), items, …], onStart, onStop })
server/core/             blueprint: config, log, db, http, server
server/api/<area>.mjs    export default function (app) { app.get(…); app.post(…) }
server/lib/<element>.mjs blueprint: library elements (auth, audit, jobs, secrets)
server/migrations/       0001_init.sql, 0002_add_note.sql, …
server/migrations-lib/   blueprint: the tables of library elements, numbered per element, run first
```

- Route modules may be `async` (they run once the database is migrated, before the server listens).
- `app.use(async ctx => …)` runs before every API route: the element `auth` finds the user there.
- `ctx.clientIp` is the browser's address (behind the installer's nginx the last `X-Forwarded-For`).
- `onStart()` runs once the server listens (workers of the element `jobs`), `onStop()` first on SIGTERM.
- System packages the server needs (a command-line tool it runs) go into `APP_PACKAGES` in
  `project.conf`: the installer and the image install them. They are the only other runtime
  dependency allowed besides `pg`.

Modules in `server/api/` are small and named by area (`items.mjs`, `reports.mjs`). Shared logic of
the app goes into `server/lib/` (the app's own, not the blueprint's).

## 7.5 API conventions

- Everything under `/api/`, nouns in the plural, the area first: `GET /api/items`,
  `POST /api/items`, `GET /api/items/:id`, `PATCH /api/items/:id`, `DELETE /api/items/:id`.
  Actions that are not plain changes: `POST /api/items/:id/archive`.
- **JSON** in both directions; the server refuses other content types for changes (415) and
  requests from other origins (403): this is the CSRF protection, do not weaken it.
- **Status codes:** 200 with data, 201 with the created object, 204 for nothing, 400 for invalid
  input, 401 not logged in, 403 not allowed, 404 not there, 409 conflict, 413 too large, 500 bug.
- **Errors:** `{ "error": { "code": "title_missing", "message": "Give the item a title." } }`:
  `code` stable and in snake_case, `message` one sentence for people, in the voice of 01-design.md
  section 9 (the web app shows it in a toast). Throw `httpError(status, code, message)`.
- **Validation** of every input on the server, also when the web app validates too. Limits on
  lengths and counts.
- **Ids** are numbers in the database (`bigint generated always as identity`) and strings in JSON
  (`pg` returns `bigint` as text: keep it that way). Times are ISO 8601 strings in UTC.
- **Lists** return arrays; long lists page with `?limit=50&before=<id>` (newest first) and never
  return more than 500 at once.
- **Compatibility:** the web app and the server are deployed together, but during a rolling
  update old and new run side by side: change the API by adding (new fields, new endpoints), never
  by changing the meaning of an existing field in the same release.

## 7.6 Database conventions

- snake_case, tables in the plural (`items`, `item_labels`), primary key `id bigint generated
  always as identity`, foreign keys `<thing>_id` with an index, `created_at timestamptz not null
  default now()`, `updated_at` where things change.
- Constraints in the database (`not null`, `check`, `unique`, foreign keys), not only in code.
- Queries with parameters only (`$1`, `$2`): never build SQL from input.
- Transactions (`tx()`) for everything that writes more than one row.
- Migrations: one file per change, `NNNN_lowercase_name.sql`, running numbers without gaps,
  plain SQL, each in its own transaction (the core does that). Released migrations never change
  (`blueprint check` compares checksums) and never get removed. Destructive changes follow the
  expand-and-contract steps of 06-data.md.

## 7.7 Security

- The core sends the same security headers as nginx (CSP `default-src 'self'`, `nosniff`,
  `X-Frame-Options`, no referrer) on every response.
- Request bodies are limited to 1 MB (raise only per route with a reason).
- Errors never reveal internals: the client gets `internal`, the log gets the stack.
- **Login**: the library element `auth` (12-library.md): sessions in a PostgreSQL table, a random
  session id in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` behind HTTPS), passwords hashed with
  scrypt from `node:crypto`, no user enumeration in messages, lockouts and rate limits, two-factor
  sign-in. Every app with accounts uses it, so all of them sign in the same way.
- **Sensitive values** (passwords and keys of other systems, tokens): encrypted with the element
  `secrets`; the key lives outside the database.
- **Who did what**: the element `audit`. **Background work**: the element `jobs`.
- Secrets only from the environment (`<ID>_…`), never in the repository or image.

## 7.8 Operation

- `/healthz` answers 200 only when the database answers (used by the installer, Docker and
  Kubernetes).
- At start the server waits up to a minute for the database, then migrates (advisory lock: many
  replicas may start at once), then listens. SIGTERM stops it cleanly within 10 seconds.
- Logs: `info` for start, stop, migrations and things an admin should know; `warn` for recovered
  problems; `error` for failures with the stack; `debug` for each request.
