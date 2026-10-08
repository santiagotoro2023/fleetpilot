# 8. Testing

Every app is tested the same way, with the same runner, the same kinds of tests and the same
pipeline. A change is done when all of them pass.

## 8.1 Kinds of tests

| Folder | What | Runs with |
|---|---|---|
| `test/unit/*.test.mjs` | logic without a browser: the app's engine, data, store, API (server profile: against a real PostgreSQL) | `node test/run.mjs` |
| `test/browser/*.test.mjs` | the app in Chromium: pages, interactions, persistence, no errors | `node test/run.mjs --browser` |
| `test/unit/blueprint.test.mjs` | `blueprint check` (blueprint) | unit run |
| `test/browser/blueprint.test.mjs` | the shell measured in the browser (blueprint, 01-design.md section 12) | browser run |
| `test/browser/lib-<name>.test.mjs` | each library element in this app (blueprint) | browser run |
| `test/installer/run.sh` | the installer on Debian 12/13 with systemd, including the update from the previous release (blueprint) | `bash test/installer/run.sh debian:12 [previous.sh]` |

## 8.2 Writing a test

- A test file is a plain script with `node:assert/strict`: it exits with 0 when all passed and
  prints **one last line** that says what it checked: `engine: 37 tests passed`,
  `api: 9 checks passed`. The runner shows that line.
- Unit tests import the app's modules directly (`../../src/js/…`, `../../server/…`). Static apps
  get a small `localStorage` stand-in where needed (see the template's `store.test.mjs`).
- Browser tests use `test/lib/browser.mjs`: `open({ width, height, colorScheme, path })` gives
  `page`, `errors` (every page error, console error and failed request), `shot(name)` (screenshots
  into `test/.output/`), `close()`. Every browser test ends with `assert.deepEqual(errors, [])`.
- With the library element `auth`, `open()` signs in as the test administrator (`open({ signedIn: false })`
  for the sign-in page) and unit tests get a signed-in API with `apiSession(base)` from `test/lib/auth.mjs`.
- The base address comes from `BASE`, set by the runner, which serves the app itself: the static
  profile with `test/lib/serve.mjs` (the same headers as nginx), the server profile with the real
  app server against the test database.
- Server profile: the runner empties the test database (`<ID>_TEST_DATABASE_URL`, or a temporary
  `postgres:17-alpine` container if Docker is there) before every run.

## 8.3 What every app tests

- Its core logic, with real inputs (PacketPilot plays every lesson through with its reference
  solution and breaks and fixes every challenge variant).
- Its stored data: backup and restore, old formats still load, merging (static); the API with
  valid, invalid and foreign-origin requests (server).
- Every page opens without errors; the main workflow of each page works; data survives a reload.
- Every bug that was fixed gets a test that would have caught it.

## 8.4 Before saying "done"

```bash
bash build.sh                              # nothing left to commit afterwards
node .blueprint/tools/blueprint.mjs check
node test/run.mjs
node test/run.mjs --browser
bash test/installer/run.sh debian:12       # when the installer, server or deployment changed
```

and a look at the changed pages at 1440 × 900, 1000 × 800 and 390 × 844, light and dark,
compared with the reference screenshots (01-design.md section 13). CI runs all of it again, plus
Debian 13, Compose, Helm and the manifest (05-deployment.md, 5.5).
