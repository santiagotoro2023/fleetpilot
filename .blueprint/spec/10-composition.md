# 10. Composing an app: same language, its own shape

Every app of the family **looks and feels the same** and **is shaped by what it does**. Both
at once. This chapter is the rule for the second half.

| Fixed, in every app (01-design.md) | Chosen per app, by its purpose (this chapter) |
|---|---|
| Tokens, colors, fonts, type scale, radii, shadow | Which pages exist and what is on each |
| The shell: rail, logo position, theme button, main area | The menu entries, their labels and icons |
| The components and their exact markup | Which components a page uses, and how many |
| Logo style (card with flat parts, no text) | The logo pattern and colors |
| Voice: plain, calm, sentence case | The words of the app's own domain |
| Behavior: dark mode, three widths, keyboard, data kept | The workflows, actions and data of the app |

The template app that `blueprint new` creates (Home, Work, Library, Parts) is **an example of
every page type, not a layout to keep**. Its hero, its numbered sections, its "Secondary action"
and its sample texts exist to show the parts. A new app removes everything it does not need and
builds its own pages from the same parts. Nothing in `blueprint check` or the blueprint's browser
test requires any page content: they check the shell, the design system and the rules, not the
composition.

## 10.1 The principles

1. **Purpose first.** Before a page gets built, write one sentence: who opens it and what they
   want to do there. Every element on the page must serve that sentence. Whatever does not, is
   left out, even when it would look nice.
2. **One main action per view.** The one thing someone most likely wants to do next is the
   `btn primary`. If a view has no such thing (a reference page, a log), it has no primary button.
3. **The most used thing is the first thing.** The home page of a tool used every day shows the
   work (the list, the dashboard, the editor). The home page of something visited now and then
   explains and invites (a hero). Do not put an introduction in front of daily work.
4. **Show, don't decorate.** Pictures are allowed only when they are the app itself: a live,
   working piece of it (PacketPilot's network with a moving packet), or real data (a chart of the
   user's numbers). No illustrations, stock photos, mascots or empty "hero images".
5. **Progressive disclosure.** Rare and advanced things stay one step away: in a collapsible
   section, behind "Add a feature", in a right-click menu that also has a visible way, on a
   second tab. The first view of anything is calm.
6. **Every part has a job in this app.** A print button exists only where printed output is
   genuinely useful. A backup box exists only where data lives in the browser. A timer only where
   time matters. Copying a part from another app "because PacketPilot has it" is not a reason.
7. **The same thing looks the same everywhere.** Within one app and across the family: a list
   of records is always a `.cardgrid` of `.tile`s or a table, a step-by-step process is always the
   step page, a task with a work area is always the task page. Do not invent a second look for
   something the design system already has.
8. **New needs get new parts in the same language.** If no component fits, build one by the
   recipe (01-design.md, 7.25), and if other apps could use it, add it to the library
   (12-library.md). Never bend an existing component into something it is not.

## 10.2 The home page

Choose the pattern by how people use the app. Each pattern is built from existing parts.

| Pattern | Use it when | Parts | Example |
|---|---|---|---|
| **Hero with live visual** | People come to learn or try something, and the app can *show* what it does in motion | `.hero` with `h1`, two sentences, primary + secondary button, progress line; `.hero-visual` with the real thing running | PacketPilot: a ping travels through a small network |
| **Hero without visual** | The app needs one paragraph of explanation, but has nothing visual that works on its own | `.hero` with a single column (no `.hero-visual`): `h1`, text, buttons | A converter, a calculator, a form-based service |
| **Straight to the work** | The app is a daily tool: people come to do, not to read | No hero. `h1` with the area's name, an intro line only if needed, then the work itself (list, table, editor) | An inventory, a task list, a log viewer, an admin tool |
| **Dashboard** | People come to see the state of things | `h1`, `stats` tiles (library), then tiles or tables with the details that need attention first | Monitoring, a budget overview, a home server panel |
| **Course / sequence** | Content is worked through in order | Hero (live visual or not), then numbered sections (`.modules`) with progress | PacketPilot's course, an onboarding, a training |
| **Catalog** | People pick one of many things to open | `h1`, intro, `.cardgrid` of `.tile`s with chips, one primary button per tile | PacketPilot's example networks, a recipe collection |

A live visual is right when all of these hold: it shows the real app working (not a picture of
it), it runs without the user doing anything, it explains in seconds what words would take a
paragraph for, and it stays calm (slow, small, no sound). It is wrong when the app's value is in
data the visitor does not have yet (an empty dashboard is not a demo), when the "visual" would be
a static screenshot or an illustration, or when people open the app many times a day (it slows
them down).

## 10.3 Sections, tiles and lists

- **Numbered sections** (`.module`) only for an order that matters: lessons, steps of a process,
  chapters. Not for categories without an order: those are tiles or tabs.
- **Tiles** (`.cardgrid` + `.tile`) for things to open or choose, each with a title, at most two
  lines of text, chips for topics and one action. Six to thirty of them; more needs a filter or
  search, then a table.
- **Tables** (`.rtable`, `.tbl` in panels) for records that are compared column by column.
- **Tabs** (`.tabs` / `.subtabs`) for two to six views of the same thing; not for navigation
  between unrelated pages (that is the rail).
- **Collapsible sections** (`.sect`) for optional or advanced parts of a configuration.
- **A data box** (`.databox`) only in static apps (data in the browser): it is where users back up
  and restore. Server apps do not have it: their data is backed up on the server.

## 10.4 Buttons and actions

| Action | Where | Look |
|---|---|---|
| The main next step of the view | where the eye goes after reading: the hero, the end of a form, the bottom bar of a step page | `btn primary`, exactly one |
| Other actions people need often | next to the primary one, or in the top bar of a work area | `btn` with icon and label |
| Rare, secondary or reversible-destructive | at the end of the section it belongs to | `btn ghost`, or `btn ghost danger` |
| Many actions on one object | right-click menu (`contextMenu`) **plus** a visible way (a menu button, a toolbar) | `.ctxmenu` |
| An action that only makes sense in this app | wherever it is used | the same button classes, the app's own words |

A secondary action in a heading row (PacketPilot's "Print theory") exists only when the action
is useful for that content in that app. The template's "Secondary action" button shows the
placement, not something every app needs.

## 10.5 The menu

- **The entries are the app's main places**, in the order of use, 2 to 6 of them. They are nouns
  for places ("Library", "Reports", "Settings") or a short verb phrase for an activity ("Fix it").
- **Icons fit the entry**, drawn in the style of 01-design.md section 6: take one from the core
  set if it fits, otherwise draw one for the app (`src/js/icons.js`). An icon that only roughly
  fits is worse than a new one in the same style.
- **Settings** get an entry only if there are real settings; theme switching is already in the
  rail. **Help** gets an entry only if there is a help page worth its own place.
- Sub-pages (a lesson, a record, a challenge) mark their parent entry as active.

## 10.6 Examples

These illustrate the principles; they are not a list to choose from.

**A learning app (PacketPilot).** Visited now and then, to learn. Home: hero with a live
network, then the numbered course. Menu: Course, Lab, Networks, Frames, Fix it, Subnets. Logo:
`bars` (the layers of a packet). Print button on lessons, because people print theory.

**A home inventory (server profile).** Used briefly, often, from the phone. Home: straight to
the work, a search field and the list of items as tiles, "Add item" as the primary button. No
hero, no sections, no print. Menu: Items, Places, Labels, Settings. Logo: `split` (an object and
its details). `stats` tiles on a small overview page, if counts matter.

**A monitoring panel (server profile).** Looked at to see if all is well. Home: dashboard, `stats`
tiles with the states (`ok` and `bad` colored), below them only what needs attention. Menu:
Overview, Hosts, Alerts, Settings. Logo: `steps`. No primary button on the overview (nothing to
do when all is well); "Acknowledge" is the primary button on an alert.

**A converter or calculator (static profile).** One job, done in seconds. Home: hero without
visual, the tool right below it in a `.subcard`. Menu: maybe only two entries (Convert,
History). Logo: `pair` (input and output). A data box, because the history lives in the browser.

**A reading app or documentation (static profile).** Reading text first: the step page with
`.theory` for the content, tiles for the chapters. Print button: yes, people print documentation.

## 10.7 Checklist for a new page

- One sentence: who comes here and what for. Everything on the page serves it.
- One primary action, or none if there is nothing to do.
- Built only from components of 01-design.md and library elements; anything new by the recipe.
- No part copied from another app without a job here.
- Light and dark, 1440 / 1000 / 390 px, keyboard only: all work.
- The words follow 01-design.md section 9.
