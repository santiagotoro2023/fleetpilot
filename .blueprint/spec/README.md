# The blueprint specification

This is the **gold standard** for every app of the family. Every app looks, feels, installs,
deploys, stores data, is tested, structured and documented the same way; only its purpose and
therefore its composition differ. PacketPilot is the app the blueprint was taken from and the
reference for every page.

## The contract

1. **The blueprint wins.** Over taste, habits, other frameworks' conventions and "how it is
   usually done". If this specification and anything else disagree, this specification applies.
2. **The design language is fixed, the composition follows the purpose.** Tokens, fonts, shell,
   components, logo style, voice and behavior are the same everywhere (01, 02). What an app shows
   on which page is decided by what it is for (10).
3. **Blueprint files are never edited by hand.** They are rendered from `project.conf` by
   `bash build.sh`; `blueprint check` fails on any difference (03).
4. **One stack per profile.** Static: everything in the browser. Server: Node.js with
   `server/core/`, PostgreSQL, only `pg` (07).
5. **Nothing a user did may get lost**: not by updates, moves, or the installer (06, 04).
6. **Every deviation needs the owner's approval first** and is recorded in `DEVIATIONS.md` (11).
7. **What other apps could use goes into the library**, built by the same rules (12).
8. **Done means green**: build, check, unit, browser and installer tests, three widths, two themes (08).

## Chapters

| Chapter | About |
|---|---|
| [01-design.md](01-design.md) | tokens, fonts, layout, the rail, icons, every component, motion, writing, accessibility |
| [02-logo.md](02-logo.md) | the logo: a card with flat parts in signal colors, patterns, files |
| [03-repository.md](03-repository.md) | layout, `project.conf`, who owns which file, building, versions, git |
| [04-installer.md](04-installer.md) | the Debian installer: options, files, behavior, compatibility |
| [05-deployment.md](05-deployment.md) | image, environment, Compose, Kubernetes, Helm, the pipeline, releasing |
| [06-data.md](06-data.md) | browser data, backups, moving; PostgreSQL, migrations; privacy |
| [07-backend.md](07-backend.md) | the server profile: stack, API and database conventions, other databases, security |
| [08-testing.md](08-testing.md) | unit, browser and installer tests, the runner, what to test |
| [09-documentation.md](09-documentation.md) | README structure, other documents, comments |
| [10-composition.md](10-composition.md) | shaping an app by its purpose: home patterns, sections, actions, menus, examples |
| [11-deviations.md](11-deviations.md) | when and how an app may differ |
| [12-library.md](12-library.md) | opt-in elements; adding new ones to the blueprint |
| [13-updating.md](13-updating.md) | blueprint versions, updating apps, changing the blueprint |
| [screens/](screens) | reference screenshots of PacketPilot and the template app |
| [logo/](logo) | the logo template and every pattern |

## How an agent works on an app of the family

1. **Read** this file, then the chapters for the task (always 01 and 10 for anything visible).
2. **Understand the app** from its README, CLAUDE.md and code. If the purpose, the users or the
   requirements of what you are asked to build are unclear, **ask the owner** before building:
   a few precise questions with your proposed answer for each. Never guess at a requirement that
   changes the structure (profile, data, pages, login).
3. **Compose from the parts** (01 section 7, library elements). Something new: build it by the
   recipe (01, 7.25) and propose it for the library if others could use it (12).
4. **Never deviate silently.** If the blueprint's way cannot meet a requirement, stop, explain
   what, why, consequences and alternatives to the owner, and wait for a yes (11).
5. **Prove it**: `bash build.sh`, `blueprint check`, unit and browser tests, the installer test when
   the installer, server or deployment changed, and a look at three widths in both themes.
6. **Commit everything that belongs together** (code, rendered files, installer, version), with a
   plain message (03, 3.6).
