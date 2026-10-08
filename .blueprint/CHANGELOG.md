# Changelog of the blueprint

Every version lists what changed and, under "Projects must", what a project has to do when it
updates to it (`node .blueprint/tools/blueprint.mjs update` prints these sections).

## 1.1.0

Library elements for server apps with accounts, sensitive data and background work, and system
packages for the app server. Taken from FleetPilot.

- `APP_PACKAGES` (optional, server profile): system packages the app server needs; the installer
  installs them with apt, the image with apk, the installer test checks them.
- Library elements `auth` (accounts, sign-in, sessions, password policy, two-factor sign-in with
  TOTP and recovery codes, lockouts, the first administrator by setup code, the pages), `audit`
  (who did what, with a searchable table), `jobs` (a PostgreSQL job queue with retries, cancelling,
  progress and cron schedules) and `secrets` (AES-256-GCM encryption of stored secrets with a key
  that every deployment makes and keeps outside the database).
- Core: library elements bring their own tables (`server/migrations-lib/<element>/`); `app.use()`
  hooks before API routes, `ctx.clientIp`, async route modules, `start({ onStart, onStop })`;
  `@@IF lib:<name>@@` and `@@IF packages@@` blocks in core files (installer, image, Compose, Helm,
  Kubernetes manifest, test runner and helpers, DEPLOYMENT.md); a core file that renders empty is
  not written; Helm `networkPolicy.extraEgress`.
- Template: wires the elements into `server/main.mjs`, the sign-in into `app.js` and the API test.

Projects must: update with `node .blueprint/tools/blueprint.mjs update --to 1.1.0`, then run
`node .blueprint/tools/blueprint.mjs render` once: the tool of 1.0.0 cannot read the new markers
and stops after copying the new blueprint (from 1.1.0 on, `update` renders with the new tool).
Apps without the new settings and elements render as before, except for
two additions to every server app: `networkPolicy.extraEgress` in the Helm values and the hooks
and `ctx.clientIp` in the server core (both unused until an app needs them).

## 1.0.0

The first version, taken from PacketPilot 2.9.1 and proven by converting PacketPilot to it (3.0.0).

- Specification: contract, design, logo, repository, installer, deployment, data, backend,
  testing, documentation, composition, deviations, library, updating; reference screenshots.
- Profiles `static` (browser storage, nginx) and `server` (Node.js, PostgreSQL, backups).
- Core: design system and fonts, web core (ui, icons, storage, site, shell, pack, api), the
  installer (Let's Encrypt, move card, update, backup and restore), Dockerfile, Compose with HTTPS,
  Kubernetes manifest, Helm chart, release workflow, test runner and helpers, conformance tests,
  installer test with the update from the previous release.
- Library: `stats`.
- Tools: `new`, `render`, `check`, `update`, `verify`, `logo`.

Projects must: nothing, new projects start here.
