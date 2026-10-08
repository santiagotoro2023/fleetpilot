# 13. Versions and updates of the blueprint

## 13.1 Versions

The blueprint has its own semantic version (`BLUEPRINT_VERSION`), released as git tags `vX.Y.Z`
in `santiagotoro2023/project-blueprint`, with every change described in `CHANGELOG.md`:

- **patch**: fixes that change nothing an app has to know about;
- **minor**: additions (a library element, an installer option, a new helper); apps keep working
  unchanged;
- **major**: changes that need something from apps; the changelog says exactly what under
  "Projects must".

Every app carries one version in `.blueprint/` (with a `MANIFEST` of checksums) and is never
changed by a blueprint release until it updates on purpose.

## 13.2 Updating an app

```bash
node .blueprint/tools/blueprint.mjs update            # the newest version
node .blueprint/tools/blueprint.mjs update --to 1.4.0 # a specific version
```

1. The tool downloads the tagged version, replaces `.blueprint/`, renders every blueprint file
   again and removes files the new version no longer has.
2. It prints the changelog between the two versions. Do every "Projects must" step.
3. `bash build.sh`, `blueprint check`, all tests (unit, browser, installer) must pass; look at the
   pages in both themes and three widths.
4. Commit as "Blueprint X.Y.Z" with the changes the update caused. CI runs everything again.

If something breaks: fix the app if the changelog asked for it; otherwise it is a bug in the
blueprint, report or fix it there (13.4), and keep the app on its old version until then.

## 13.3 Safeguards

- `blueprint check` verifies that `.blueprint/` matches its `MANIFEST` (nothing edited by hand)
  and that every blueprint file is exactly what that version renders.
- `node .blueprint/tools/blueprint.mjs verify` compares `.blueprint/` with the published version on
  GitHub.
- Updates never happen by themselves: each app moves when its owner decides and its CI is green.
- The installer test updates from the app's previous release on every CI run, so an update of
  the blueprint can never strand installed servers.

## 13.4 Changing the blueprint itself

In the blueprint repository, with a pull request:

1. Change `core/`, `template/`, `library/`, `tools/` or `spec/`.
2. Keep every existing app working: no removed options, no renamed paths or classes, no changed
   storage keys (04-installer.md 4.6, 06-data.md). If that is impossible, it is a major version with
   precise "Projects must" steps.
3. Add a `CHANGELOG.md` entry under the next version.
4. The blueprint's CI generates example apps (both profiles, with no and with all library elements)
   and runs their whole pipeline: check, unit and browser tests, Helm and manifest validation,
   Compose, the installer on Debian 12 and 13.
5. Merge, raise `BLUEPRINT_VERSION`, tag `vX.Y.Z`.
6. Update PacketPilot first (the reference app), then the other apps as their owners decide.
