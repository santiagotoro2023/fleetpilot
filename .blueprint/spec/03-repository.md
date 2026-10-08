# 3. The repository

Every project of the family is its own GitHub repository with the same layout, the same files
in the same places, the same settings file and the same way of building and releasing.

## 3.1 Layout

```
project.conf          the blueprint settings of this app (3.2)
VERSION               the version of the app: MAJOR.MINOR.PATCH (3.5)
README.md             what the app is, how to install and run it (09-documentation.md)
CLAUDE.md             instructions for coding agents: the blueprint rules (managed) + this app
DEVIATIONS.md         approved deviations from the blueprint, or "None." (11-deviations.md)
package.json          scripts and dependencies (only those the blueprint allows, 7.2)
package-lock.json     the exact dependency versions (CI installs exactly these)
blueprint.lock        what the blueprint wrote, and the recorded migrations (written by the tool)
<id>-install.sh       the one-file installer, built by build.sh and committed
build.sh              renders the blueprint files and builds the installer
Dockerfile, .dockerignore, docker-compose.yml
.github/workflows/release.yml
.gitignore
.blueprint/           the blueprint at the version this app uses: never edited
src/                  the web app (no build step: ES modules, HTML, CSS)
  index.html          the page and the menu; <head> and logo are managed blocks
  css/base.css        the design system                          (blueprint)
  css/lib/            library elements switched on in LIBRARY     (blueprint)
  css/app.css         this app's own styles
  fonts/              Cantarell, DejaVu Sans Mono and licenses   (blueprint)
  js/core/            ui, icons, storage, site, shell, pack, api (blueprint)
  js/lib/             library elements                           (blueprint)
  js/app.js           the router and the views of this app
  js/store.js         what the browser keeps (static: everything; server: settings)
  js/icons.js         the core icons plus this app's own
  js/…                the rest of this app, as many modules as it needs
  migrate.html        the bridge from http:// to https://        (blueprint)
server/               server profile only
  main.mjs            starts the core with this app's routes
  core/               config, log, db, http, server             (blueprint)
  api/                this app's API, one module per area
  lib/                library elements (blueprint) and the app's own shared modules
  migrations/         0001_name.sql, 0002_… (only ever added)
  migrations-lib/     the tables of library elements, per element  (blueprint)
installer/
  core/head.sh, core/tail.sh                                     (blueprint)
  app.sh              this app's additions to the installer (usually empty)
deploy/
  docker/             container config (static profile)          (blueprint)
  compose/https/      Compose with Caddy and Let's Encrypt       (blueprint)
  kubernetes/<id>.yaml                                           (blueprint)
  helm/<id>/          the Helm chart                             (blueprint)
docs/
  DEPLOYMENT.md       every way to run the app                   (blueprint)
  DESIGN.md           points to the design spec                  (blueprint)
  …                   further documents of this app, if needed
assets/logo/          <id>-icon-{light,dark}.svg (blueprint), the PNGs (blueprint tool)
test/
  run.mjs, lib/       the test runner and helpers                (blueprint)
  unit/               this app's unit tests, plus blueprint.test.mjs (blueprint)
  browser/            this app's browser tests, plus blueprint.test.mjs (blueprint)
  installer/run.sh    the installer test on Debian               (blueprint)
```

"(blueprint)" marks files the blueprint writes: `bash build.sh` renders them from
`project.conf` and `VERSION`; `blueprint check` fails if one of them differs. They are never
edited by hand. The rest belongs to the app.

## 3.2 `project.conf`

Shell syntax, `KEY="value"`, one per line. Every blueprint file is made from it.

| Setting | Meaning | Rules |
|---|---|---|
| `APP_ID` | technical name: repository, paths (`/opt/<id>`), service, image, chart, storage key `<id>.v1`, env prefix (`<ID>_…`) | lowercase letters, digits, dashes; 3–32 characters; **never changes** after the first release |
| `APP_NAME` | the name people see | at most 40 characters |
| `APP_TAGLINE` | one sentence: what the app is for | 10–90 characters, ends with a period, no exclamation mark |
| `APP_DESCRIPTION` | one or two sentences for the image, the chart and the page description | 20–200 characters |
| `APP_REPO` | `owner/repository` on GitHub | the installer updates from there |
| `APP_PROFILE` | `static` (everything in the browser) or `server` (Node.js and PostgreSQL) | see 7.1 for choosing |
| `APP_PORT` | default port of the installer | 1024–65535, usually 8080 |
| `APP_KEYWORDS` | keywords of the Helm chart | lowercase, separated by `, ` |
| `APP_DATA_NOTE` | one sentence the installer prints about where users' data lives | ends with a period |
| `LOGO_PATTERN`, `LOGO_COLORS` | the logo (02-logo.md) | a pattern and 1–4 signal colors |
| `LIBRARY` (optional) | library elements this app uses (12-library.md) | comma-separated names |
| `APP_PACKAGES` (optional) | system packages the app server needs (server profile): the installer installs them with apt, the image with apk | names separated by spaces, the same in Debian and Alpine (`ansible-core openssh-client`) |

Changing a setting: edit `project.conf`, run `bash build.sh`, run the tests, commit everything
that changed. `APP_ID` and `APP_PROFILE` are not changed after the first release; doing so is a
new app.

## 3.3 Starting a project

From a checkout of the blueprint (the README of the blueprint has the full prompt for an agent):

```bash
node tools/blueprint.mjs new ../myapp --id myapp --name "My App" --repo owner/myapp \
  --profile static|server --tagline "…" --description "…" --pattern bars --colors blue,green
cd ../myapp && npm install && bash build.sh && node test/run.mjs && node test/run.mjs --browser
git init -b main && git add -A && git commit -m "Start My App from the blueprint"
```

`new` writes the template app, vendors the blueprint into `.blueprint/`, renders every blueprint
file, makes the logo and the lockfile. The template app is an example: replace its pages
following 10-composition.md.

## 3.4 Building

`bash build.sh` (or `npm run build`):

1. renders all blueprint files from `project.conf`, `VERSION` and `.blueprint/` (3.1);
2. builds `<id>-install.sh`: the installer core, `installer/app.sh`, all files of `src/` and,
   in the server profile, `server/` with its production dependencies;
3. checks the installer's shell syntax.

Everything `build.sh` produces is committed. CI runs it again and fails if anything changed
(`git diff --exit-code`): the repository always contains exactly what it builds.

## 3.5 Versions

- `VERSION` is the version of the app, semantic: **MAJOR** for changes that need something from
  the people running it (a new requirement, a removed option), **MINOR** for new features,
  **PATCH** for fixes. Raise it with every change users or admins can notice.
- The version reaches the installer, the image tag, the Helm chart and the manifest through
  `build.sh`. Installed servers update to the newest version with `--update`; the installer never
  goes back to an older version.
- The blueprint has its own version (`.blueprint/BLUEPRINT_VERSION`); updating it is a change of
  the app like any other (13-updating.md).

## 3.6 Git

- Default branch `main`; every push to `main` releases (image `:latest` and `:<version>`, chart).
- Commit messages: a short summary line in plain English (imperative or descriptive, no period),
  an empty line, then what changed and why in a few lines. No ticket noise, no emoji.
- Never commit secrets, `.env` files, `node_modules/` or test output (`test/.output/`).
- Pull requests run the same pipeline without publishing.

## 3.7 Naming

- Files and folders: lowercase, dashes (`make-logo.mjs`, `lib-stats.test.mjs`).
- JavaScript: ES modules (`.js` in `src/`, `.mjs` in `server/`, `test/` and tools), camelCase for
  functions and variables, no classes unless the thing has state and behavior.
- CSS classes: lowercase with dashes; the app's own components get a prefix of their own words.
- Database: snake_case, plural table names (07-backend.md).
- Environment variables: `<ID>_…` in capitals (`MYAPP_DATABASE_URL`).
