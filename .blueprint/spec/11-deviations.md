# 11. Deviations

The blueprint is the gold standard. An app may deviate from it only when a real requirement
cannot be met within it, and only after the owner said yes.

## 11.1 The process

1. **Look for the blueprint's way first.** Most needs are met by composition (10-composition.md),
   the recipe for new components (01-design.md, 7.25), an existing library element, or a new one
   (12-library.md). A new library element is not a deviation: it extends the blueprint for everyone.
2. **Stop and ask the owner** before deviating. Explain in a few plain sentences:
   - **what** would differ (the file, dependency, option or rule),
   - **why** the blueprint's way does not work for this app (the concrete requirement),
   - **the consequences** (for deployments, backups, updates, other apps, maintenance),
   - **the alternatives** you considered and why they fall short.
3. **Only after an explicit yes**, make the change and record it in `DEVIATIONS.md` in the same
   commit.
4. **Revisit** deviations when the blueprint is updated: often a new blueprint version or library
   element makes one unnecessary; then remove it.

## 11.2 The format of `DEVIATIONS.md`

```markdown
# Deviations from the blueprint

…the fixed introduction…

## Dependency: sharp
Reason: Photos uploaded by users must be resized to three sizes on the server; doing that without
a library would mean writing an image codec.
Approved: Santiago, 2026-11-02
Consequences: one native dependency; the container image is built for amd64 and arm64 with
prebuilt binaries; the installer needs libvips from Debian.

## File: deploy/helm/myapp/values.yaml
Reason: The cluster of the customer needs a fixed node selector for every pod of this app.
Approved: Santiago, 2026-11-05
Consequences: the file is no longer updated by the blueprint; after each blueprint update compare
it with the blueprint's version by hand.

## Page layout: full-screen map
Reason: The map must use the whole window; the rail stays, the page has no padding.
Approved: Santiago, 2026-11-07
```

- **`## Dependency: <name>`** allows a package in `package.json` (and its imports).
- **`## File: <path>`** allows a blueprint file to differ; `build.sh` then leaves it alone and
  `blueprint check` skips it. Use rarely: the file no longer gets the blueprint's improvements.
- **Any other heading** documents a deviation the tools cannot see (a page layout, a rule of the
  spec, a choice of database: see 07-backend.md, 7.3).
- Every entry needs `Reason:` (at least one full sentence) and `Approved: <who>, <YYYY-MM-DD>`.
  `blueprint check` fails on entries without them, and on dependencies or blueprint files that
  differ without an entry.
- Without deviations the file says `None.`

## 11.3 What is never a deviation

- Different pages, menus, texts and data: that is composition, expected in every app.
- A component built by the recipe in `src/css/app.css`.
- Additional documents, tests and modules of the app.
