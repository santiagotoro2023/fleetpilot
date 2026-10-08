# 9. Documentation

Every app is documented the same way, in the voice of 01-design.md section 9: plain, calm,
concrete, sentence case, for people who want to use or run the app.

## 9.1 README.md

In this order (`blueprint check` verifies the headings and the managed blocks):

1. `# <APP_NAME>`, an empty line, the tagline (from `project.conf`).
2. Two or three paragraphs: what the app is, who it is for, what one can do with it.
3. The managed block **install** (`<!-- blueprint:install -->`): `## Installation`,
   `### Debian installer` with the options table, `### Let's Encrypt`, `### Your data is safe`.
4. `## What's inside`: the app in detail, one paragraph or short list per area of the menu,
   plus anything users should know (subsections allowed).
5. The managed block **logo** (`## Logo`), optionally followed by notes about extra logo files.
6. The managed block **development** (`## Development`: commands and layout), optionally followed by
   `### <App>'s code`: the app's own modules and how to extend them.
7. `## Planned`: ideas for later, short.

## 9.2 Other documents

| File | Content | Owner |
|---|---|---|
| `docs/DEPLOYMENT.md` | every way to run the app, settings, moving, backups, troubleshooting, security | blueprint |
| `docs/DESIGN.md` | points to the design spec and lists the app's logo and own styles | blueprint |
| `CLAUDE.md` | the blueprint rules (managed block **rules**) and "This project": domain, modules, decisions | both |
| `DEVIATIONS.md` | approved deviations (11-deviations.md) | project |
| `docs/<topic>.md` | further documents the app needs (an API reference, a guide for admins) | project |

## 9.3 In the code

- Every file starts with one or two comment lines: what it is for.
- Comments explain why, not what; a function gets a short JSDoc line when its use is not obvious.
- No commented-out code, no TODOs without a reason.

## 9.4 Writing rules for documents

- Headings in sentence case. Short paragraphs, one idea each. Tables to compare, code blocks for
  everything one types.
- Commands are complete and can be pasted (`sudo bash myapp-install.sh --port 443`).
- Examples use `example.com` domains and the app's own id (`myapp.example.com`).
- English, unless the owner decides otherwise for an app.
