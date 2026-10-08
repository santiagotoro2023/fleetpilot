# FleetPilot

Run every Linux host in your datacenter from one place. Inventory, IP address management and intent-based automation with Ansible: take over new hosts, describe their desired state and apply it to the whole fleet.

<!-- blueprint:rules -->
## The blueprint (binding, read first)

This project follows the **project blueprint 1.1.1** (`.blueprint/`): the gold standard for every
project of this family. Design, logo, installer, deployment, repository layout, tests and docs are the
same in all of them; only the purpose differs. Before any work, read `.blueprint/spec/README.md` and the
spec chapters for what you are about to touch. The spec wins over your own taste and habits.

Absolute rules:

1. **Never edit a file the blueprint writes.** `node .blueprint/tools/blueprint.mjs check` lists them: the
   installer core, build.sh, Dockerfile, deploy/, the workflow, docs/DEPLOYMENT.md, src/css/base.css,
   src/fonts/, src/js/core/, test/run.mjs, test/lib/, the logo SVGs and the marked blocks in README.md
   and here.
   On top of that: server/core/.
   Change them only through `project.conf` and `bash build.sh`, or by updating the blueprint.
   Never touch `.blueprint/`.
2. **The frontend is PacketPilot's design, exactly.** Build every page from the components in
   `.blueprint/spec/01-design.md` with the same markup and class names. Own CSS goes into `src/css/app.css`
   and uses only the tokens of base.css. No other UI framework, no CDN, no web fonts from elsewhere, no emoji.
3. **The menu** (`.rail` in `src/index.html`): 2 to 6 entries, one-word labels of at most 9 characters,
   icons in the style of `src/js/core/icons.js`. The logo comes from `LOGO_PATTERN`/`LOGO_COLORS` only.
4. **The backend follows `.blueprint/spec/07-backend.md`**: Node.js with `server/core/`, PostgreSQL, the
   only runtime dependency is `pg`, migrations are numbered SQL files that only ever add. Configuration
   comes from `FLEETPILOT_*` environment variables, all data lives in PostgreSQL.
5. **Deviations need the owner's approval first.** If a requirement cannot be met within the blueprint
   (another database, a new dependency, a changed blueprint file, another page layout, …), stop and explain
   to the owner: what, why the blueprint's way does not work here, and the consequences. Only after an
   explicit yes, record it in `DEVIATIONS.md` (format in `.blueprint/spec/11-deviations.md`). An unrecorded
   deviation fails the check and CI.
6. **Words follow `.blueprint/spec/01-design.md`, "Writing"**: plain, calm, sentence case, no exclamation
   marks, buttons say what they do.
7. **Before you say something is done:** `bash build.sh`, `node .blueprint/tools/blueprint.mjs check`,
   `node test/run.mjs`, `node test/run.mjs --browser`, and for installer changes
   `bash test/installer/run.sh debian:12`. All of them green; compare the pages with the reference
   screenshots in `.blueprint/spec/screens/` at 1440 × 900, 1000 × 800 and 390 × 844 in light and dark mode.
8. **Versions:** bump `VERSION` (semantic versioning) with every user-visible change, commit the output of
   `build.sh` (installer, rendered files) together with the change.
<!-- /blueprint:rules -->

## This project

FleetPilot manages Linux hosts with Ansible (ansible-core, `ansible.builtin` modules only, installed as
an APP_PACKAGE). Server profile with the library elements auth, audit, jobs, secrets and stats.

- **Where things live.** `server/api/*.mjs`: one module per area (hosts, groups, sources, network,
  templates, workflows, runs, vault, access, settings, overview, meta). `server/lib/`: the catalog of
  settings (`catalog.mjs` field rules and task helpers, `catalog-settings.mjs`, `catalog-services.mjs`,
  `network.mjs`), the compiler (`compile.mjs`: definitions → merged desired state → plays), workflow
  steps (`steps.mjs`), the run engine (`runner.mjs`, jobs `run.execute`, `run.scheduled`, `runs.prune`),
  Ansible (`ansible.mjs` and the callback plugin `server/ansible/fleetpilot.py`, which prints FPJSON
  lines), SSH and certificates (`ssh.mjs`), the vault (`vault.mjs` on the secrets element), IPAM
  (`ipam.mjs`), rights (`access.mjs`), the per-host context (`hostctx.mjs`), first data (`seed.mjs`).
  Web app: `src/js/views/*.js` per page, `src/js/common.js` (API calls, chips, dialogs, the form
  renderer that draws every setting and step from the server's field definitions).
- **Adding a setting or service:** one object in `catalog-settings.mjs` or `catalog-services.mjs`
  (fields, `tasks(values)`, `summary`, optional `needs`/`ports`). `test/unit/catalog.test.mjs` checks
  every type with the sample values of `test/unit/samples.mjs` and runs `ansible-playbook --syntax-check`.
- **Security decisions.** User text never reaches Jinja except FleetPilot's own `{{ fp_* }}` variables
  (`safeText`); file contents are written as `!unsafe`. Secrets go to Ansible only through the
  inventory, marked `!unsafe`, and tasks that touch them use `no_log`. Logins after the take-over use a
  user certificate valid for minutes, signed per run; host keys are pinned with a host CA. Passwords
  are hashed with SHA-512 crypt and a salt derived from host and user, so an unchanged password causes
  no change.
- **Desired state:** templates of the site, then groups from the top down, then the host; `single`
  types: the most specific wins, `collect` types: rows merged by their key.
- **Migrations:** `0001_items.sql` is the template's example table, kept because a migration is never
  removed once the blueprint recorded it; FleetPilot's tables start with `0002_fleet.sql`.
- **Tests:** `test/unit/fleet.test.mjs` covers the API; `test/unit/takeover.test.mjs` takes over a real
  Debian 12 container (`test/e2e/debian12.Dockerfile`) and runs only with `FLEETPILOT_E2E=1` (Docker
  and ansible-core needed). Run it before changing steps, the runner or Ansible handling.
- **Planned:** network devices (Zyxel, FortiGate, Cisco) with VLANs and intent-based networking, more
  hypervisors, RHEL-family hosts (see README, "Planned").
