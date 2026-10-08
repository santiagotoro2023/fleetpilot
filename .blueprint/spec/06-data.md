# 6. Data

Nothing a user does may ever get lost: not by an update, not by moving the app to another
server or address, not by a mistake that a backup can undo. How that is achieved depends on the
profile.

## 6.1 Static profile: data in the browser

- **One key:** everything of the app lives in `localStorage` under `<id>.v1`, as one JSON object,
  managed by `src/js/core/storage.js` (`createStore`). The app describes its shape in
  `src/js/store.js`: `empty()`, `normalize()`, `merge()`, `valid()`, `isEmpty()`.
- **The shape only ever grows.** New fields get defaults in `normalize()`; nothing is renamed,
  moved or removed. Every version reads what every older version saved. If a shape really must
  change, add a new field and keep reading the old one; never bump the key.
- **Robust:** broken or blocked storage starts empty instead of failing; writes that fail (full,
  private mode) are ignored.
- **Preferences** (`prefs`) are part of the same object: theme, panel sizes, last tab, …
- **Backups:** the home page has the data box (`.databox`, 10-composition.md) with "Download
  backup" and "Restore backup". The file is
  `{ "app": "<APP_NAME>", "kind": "backup", "version", "exported", "data" }`; files without the
  header (older exports) are accepted too.
- **Restoring merges:** `merge(current, added)` never loses anything; on a conflict the current
  browser wins; restoring twice changes nothing. Each app defines what "the best of both" means for
  its data (PacketPilot: a lesson done on either side stays done, the better time wins, two
  different networks with the same name are both kept).
- **Moving between addresses** (browsers keep data per address):
  - `http://` → `https://`: `migrate.html` on the old address hands the data over once.
  - IP address or old name → main address (`site.json` → `canonical`): a card offers
    "Move my data there"; the data travels compressed after the `#` of the link
    (`#/migrate/<code>`), merged on arrival.
  - The installer's `--moved-to` and the container's `<ID>_CANONICAL` set the main address.
- **Tests:** `test/unit/store.test.mjs` covers backup, old exports, merging; the browser tests
  cover persistence across reloads.

## 6.2 Server profile: data in PostgreSQL

- **All server-side data is in PostgreSQL**, nothing on the file system of the app server: the
  containers stay disposable and any number of replicas can run. Files that users upload go into the
  database as well (`bytea`) unless an approved deviation names an object store.
- **The schema only ever grows.** Migrations are numbered SQL files that are never changed or
  removed once released (`blueprint check` records their checksums in `blueprint.lock`). A change
  that removes or renames something is done in steps over releases: add the new, write both, move
  reads to the new, and only much later stop writing the old (never drop data in the same release).
- **A database newer than the app** stops the app with a clear message instead of guessing (no
  downgrade over a migrated database).
- **Backups:** the installer backs up daily and before every update, keeps 14, and restores with
  `--restore` after backing up the current state; Compose and Kubernetes back up with `pg_dump`
  (docs/DEPLOYMENT.md). Backups are `pg_dump -Fc` files that restore into any deployment, which is
  also how an app moves from one deployment to another.
- **The browser** keeps only preferences (`prefs` in `<id>.v1`), never data that belongs to the
  server.

## 6.3 Privacy

- Data never leaves the deployment: no analytics, no trackers, no third-party requests at all
  (the Content Security Policy is `default-src 'self'`).
- Data that travels in links (share links, moves) goes after the `#`, which browsers never send
  to a server.
- Server logs contain no personal data beyond what is needed to find an error (no request bodies).
