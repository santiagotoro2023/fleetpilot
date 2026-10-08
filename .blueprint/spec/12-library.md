# 12. The library

The blueprint grows with its apps. When an app needs something the design system does not have
(a component, a server module, an installer feature) and other apps could need it too, it becomes
a **library element** of the blueprint: built once, in the same design language, documented and
tested, and from then on available to every app, which switches it on when it needs it.

## 12.1 Using elements

- The available elements are in `.blueprint/library/<name>/`, each with a `README.md` (when to
  use it, when not, markup or API, rules).
- Switch elements on in `project.conf`: `LIBRARY="stats,auth"`. Then `bash build.sh`.
- The blueprint writes the element's files into the app (`src/css/lib/<name>.css`,
  `src/js/lib/<name>.js`, `server/lib/<name>.mjs`, its tests), links its stylesheet in the managed
  `<head>` block, and `blueprint check` treats them like every blueprint file.
- An element can bring tables (`server/migrations-lib/<name>/`, run before the app's migrations)
  and parts of core files: core files have `@@IF lib:<name>@@ … @@END@@` blocks that are kept only
  when the element is on (the installer, the image, Compose, Helm, the test helpers).
- An app that does not list an element gets none of its files: nothing it does not use can
  affect it. Using an element's files without listing it fails the check.
- Switching an element off removes its files again (the check then finds any code that still uses
  it).

| Element | Kind | Profiles | Since | What |
|---|---|---|---|---|
| `stats` | component | both | 1.0.0 | big numbers with a label in tiles (from PacketPilot) |
| `auth` | feature | server | 1.1.0 | accounts, sign-in, sessions, password policy, two-factor sign-in, setup code, the pages (from FleetPilot) |
| `audit` | module | server | 1.1.0 | who did what, when and from where, with a searchable table (from FleetPilot) |
| `jobs` | module | server | 1.1.0 | background work in a PostgreSQL queue: replicas, retries, cancelling, schedules (from FleetPilot) |
| `secrets` | module | server | 1.1.0 | sensitive values encrypted at rest; the key made and kept by every deployment (from FleetPilot) |

## 12.2 When something becomes a library element

Build it as part of the app first (01-design.md, 7.25), then propose it for the library when:

- it solves a need that is not specific to this one app (another app could plausibly want it), and
- it fits the design language without new tokens, and
- it can be described in rules (when to use, when not, markup), not just as one app's look.

App-specific things stay in the app. When unsure, ask the owner.

## 12.3 Adding an element to the blueprint

Work in the blueprint repository (`santiagotoro2023/project-blueprint`), on a branch, with a pull
request:

1. **Create `library/<name>/`** (lowercase, dashes):
   - `element.json`: `title`, `kind` (`component`, `module`, `feature`), `profiles`
     (`["static", "server"]` or one), `description`, `since` (the blueprint version that adds it),
     `from` (the app it came from), `requires` (other elements).
   - `README.md` with the sections **When to use**, **When not to use**, **Markup** (or **API**),
     **Rules**, **Files**.
   - `files/…` exactly as they land in a project, with the usual placeholders
     (`@@APP_ID@@`, `@@APP_ENV@@`, …) and profile blocks. Paths:
     `src/css/lib/<name>.css`, `src/js/lib/<name>.js`, `server/lib/<name>.mjs`,
     `server/migrations-lib/<name>/…` (if it needs tables, numbered on their own),
     `test/unit/lib-<name>.test.mjs`, `test/browser/lib-<name>.test.mjs`.
2. **Design rules for the element** (checked by the blueprint's own tests):
   - every CSS selector starts with the element's class (`.stats`, `.stats > .stat-tile`), so it
     can never restyle anything else;
   - colors, radii, shadows and fonts only from the tokens of base.css; sizes from the type scale;
   - no `!important`, no `@import`, no `@font-face`, no global selectors (`body`, `*`, bare tags);
   - JavaScript builds DOM with `h()` from `src/js/core/ui.js` and uses no dependencies;
   - server modules use only `server/core/` and `pg`.
3. **Tests:** at least one test in the element's own files that proves it works inside an app
   (rendered with the tokens, the API answering, …).
4. **Document it:** add it to the table in 12.1, and a line in `CHANGELOG.md` under the next
   version (a new element is a **minor** version).
5. **The blueprint's CI** builds example apps of both profiles with **no** elements and with
   **all** elements switched on, and runs every check and test of them: an element that breaks
   another, or an app without it, cannot be merged.
6. After the release, the app that needed it updates to the new blueprint version, switches the
   element on in `LIBRARY`, and deletes its own copy.

## 12.4 Changing an element

- A fix that keeps markup, API and look: **patch** version.
- An addition (a new class, a new option): **minor** version.
- A change that breaks apps using it (renamed classes, changed API, different look): **major**
  version, with a "Projects must" section in the changelog that says exactly what to change. Better:
  add a new variant and leave the old one.
- Every app gets the change only when it updates the blueprint (13-updating.md); its own CI must pass
  before it is merged.

## 12.5 Core versus library

- **Core** (in every app): the shell, the design system, the installer, deployment, tests, the
  server core. Changing core affects every app on its next update and needs the same care as a
  major library change.
- **Library** (opt-in): everything that only some apps need. When in doubt, it goes into the
  library.
