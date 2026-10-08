# 1. Design

The design language of every project of the family, taken from PacketPilot. It is **fixed**:
tokens, fonts, sizes, the shell, the components, the logo style and the voice are the same in
every app. What an app **composes** from them (its pages, sections, buttons, visuals and menu
entries) follows its purpose: see [10-composition.md](10-composition.md).

Where the files are in a project:

| What | Where | Who changes it |
|---|---|---|
| Tokens, base styles, shell, components | `src/css/base.css` | the blueprint only |
| Fonts | `src/fonts/` | the blueprint only |
| DOM helpers, icons, storage, shell, moving data | `src/js/core/` | the blueprint only |
| Library elements switched on in `LIBRARY` | `src/css/lib/`, `src/js/lib/` | the blueprint only |
| The app's own styles | `src/css/app.css` | the project, by the rules of section 7.26 |
| The app's own icons | `src/js/icons.js` | the project, in the style of section 6 |
| The page, the menu | `src/index.html` (head and logo are managed blocks) | the project |

---

## 2. The vibe

The design is a **technical drawing on cool paper**. It is calm, precise and quiet, and it
never shouts.

- **Cool paper.** The page background is a very light blue-grey (`--paper`). White panels lie
  on it, separated by thin blue-grey lines (`--line`). Work areas show a faint 24 px grid like
  engineering paper (`.canvas-wrap`).
- **Dark ink.** Text, the primary button, the active menu entry and the logo card are one dark
  navy (`--ink`). There is no pure black anywhere. In dark mode everything flips to a deep
  navy night with light ink, not to black.
- **Signal colors carry meaning, never decoration.** Saturated colors (blue, green, orange,
  violet, …) appear only where they *mean* something: a layer of a packet, a category, a
  state. In PacketPilot they are the colors of network cable pairs. Each project gives them its
  own meaning (section 3.3), and the same color always means the same thing within a project.
  Large colored areas never appear: color comes in stripes, bars, dots, thin left borders and
  10 to 14 % tints.
- **Flat, with one soft shadow.** Cards are flat, with a 1 px border. The single shadow
  (`--shadow`) is only for things that float: toast, menus, dialogs, floating toolbars, a
  hovered link tile.
- **Small, consistent radii.** 6 px for controls and inner boxes, 10 px for cards and panels,
  full pills (99px) for chips and captions, circles for step numbers. Nothing else.
- **Content first.** Big, bold, tight headings (weight 650, negative letter-spacing), comfortable
  15 px body text at line-height 1.5, and reading text limited to about 70 characters per line.
  Explanations are short and plain.
- **Progressive disclosure.** Optional things stay hidden until needed: collapsible sections,
  "Add a feature" buttons, hints behind a button, right-click menus. The first screen of
  anything is simple.
- **Live examples instead of pictures.** The hero of the home page shows the app actually
  working (PacketPilot: a ping running through a small network), not an illustration or a
  stock photo. There are no photos and no illustrations anywhere.

---

## 3. Tokens

All tokens are defined in `base.css`. These are their exact values. A project never defines
other values for them.

### 3.1 Light mode (default) and the shared tokens

```css
:root {
  --paper: #F3F6FA;        /* page background, work areas */
  --grid: #E0E7F0;         /* grid lines of work areas, row separators, progress bar track */
  --grid-strong: #CFD9E6;  /* border of small previews */
  --panel: #FFFFFF;        /* cards, rail, top and bottom bars, inputs, buttons */
  --panel-2: #F7F9FC;      /* hover background, table heads, list items, hint boxes */
  --ink: #17253A;          /* text, primary button, active menu entry, logo card */
  --ink-2: #4B5B71;        /* secondary text (.muted), labels, rail labels */
  --ink-3: #7A889B;        /* tertiary text: meta data, placeholders, open-state icons, hover borders */
  --line: #D3DCE7;         /* every border and divider */
  --focus: #2F6FDB;        /* links, focus ring, focused input border, tile icon, hover border of link tiles */
  --select: #EE7F1A;       /* the selected thing (selected item, switched-on toggle button) */
  --ok: #1F9D68;           /* done, right, success, progress */
  --err: #D33A3A;          /* wrong, error, delete */
  --warn: #C98400;         /* warning notes */
  --btn: #17253A;          /* primary button background */
  --btn-ink: #FFFFFF;      /* primary button text */

  /* Signal colors: the same in light and dark mode */
  --c-blue: #2F6FDB;
  --c-violet: #7A5AF8;
  --c-orange: #EE7F1A;
  --c-green: #1F9D68;
  --c-teal: #0E93A8;
  --c-brown: #8B5E3C;
  --c-pink: #D24C8D;
  --c-slate: #94A3B8;
  --c-mist: #B4BFCE;
  --c-steel: #5B6B82;
  --c-gold: #B8920A;
  --c-rust: #B4532A;
  --c-pine: #0F766E;

  --font: "Cantarell", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  --mono: "DejaVu Sans Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace;
  --r-s: 6px;              /* controls, inner boxes, list items, tables in panels */
  --r-m: 10px;             /* cards, panels, toolbars, toast, dialogs, rail entries */
  --shadow: 0 1px 2px rgba(23, 37, 58, .08), 0 4px 14px rgba(23, 37, 58, .06);
  color-scheme: light;
}
```

### 3.2 Dark mode

Dark mode follows the system (`prefers-color-scheme: dark`). The theme button in the rail can
force it either way: it sets `data-theme="dark"` or `data-theme="light"` on `<html>`, and the
choice is stored. Only these tokens change. The signal colors, `--focus`, `--select`, `--ok`,
`--err` and `--warn` stay the same.

| Token | Light | Dark |
|---|---|---|
| `--paper` | `#F3F6FA` | `#0E1624` |
| `--grid` | `#E0E7F0` | `#172234` |
| `--grid-strong` | `#CFD9E6` | `#1F2C41` |
| `--panel` | `#FFFFFF` | `#131D2E` |
| `--panel-2` | `#F7F9FC` | `#172336` |
| `--ink` | `#17253A` | `#E4EBF5` |
| `--ink-2` | `#4B5B71` | `#AAB7C9` |
| `--ink-3` | `#7A889B` | `#7D8BA0` |
| `--line` | `#D3DCE7` | `#26354B` |
| `--btn` | `#17253A` | `#E4EBF5` |
| `--btn-ink` | `#FFFFFF` | `#0E1624` |
| `--shadow` | `0 1px 2px rgba(23, 37, 58, .08), 0 4px 14px rgba(23, 37, 58, .06)` | `0 1px 2px rgba(0,0,0,.3), 0 6px 18px rgba(0,0,0,.25)` |

So in dark mode the primary button and the active menu entry become light (`#E4EBF5`) with
dark text, and the logo card becomes light with the same colored content.

Fixed colors that ignore the theme (use only these, only here):

| Value | Where |
|---|---|
| `#0F1A2A` background, `#D7E2F0` text | the terminal (`.console pre`), dark in both modes |
| `#fff` | text on a solid signal color or on `--ok` (done step dots, number badges) |
| `rgba(10, 18, 30, .45)` | the backdrop behind a dialog |

### 3.3 Signal colors: meaning per project

The 13 signal colors get a meaning in each project, written into `css/app.css` as
project tokens. PacketPilot uses them for network layers:

```css
:root {                         /* PacketPilot (src/css/app.css) */
  --l-eth: var(--c-blue);       /* Ethernet */
  --l-ip: var(--c-green);       /* IP */
  --l-arp: var(--c-orange);     /* ARP */
  --l-udp: var(--c-brown);      /* UDP */
  --l-vlan: var(--c-violet);    /* … */
}
```

A new project does the same with its own names (the template uses `--k-input`, `--k-process`,
`--k-store`, `--k-output`). Rules:

- One color = one meaning, throughout the project. Never reuse a color for a second meaning.
- Use the colors in this order of preference: blue, green, orange, violet, teal, brown, pink,
  rust, gold, pine. `--c-slate`, `--c-mist` and `--c-steel` are neutral: for "other", "data",
  "unknown".
- A signal color is shown as: a stripe (`.module .bands i`: 26 × 6 px, radius 3), a left
  border of 5 or 6 px (`.layer`, `.fb-blk`, `.stack-item`), a 7–20 px dot or badge, a 3 px
  left border of a note, or a tint with `color-mix(in srgb, <color> 7–14%, var(--panel))`.
  Text in a signal color is allowed for short state words only.
- `--ok`, `--err`, `--warn`, `--focus` and `--select` have fixed meanings (3.1) and are never
  used as category colors.

### 3.4 Color mixing recipes

Tints are always made with `color-mix(in srgb, …)` against `--panel` or `transparent`. Use
exactly these strengths:

| Use | Recipe |
|---|---|
| Area / zone fill | `color-mix(in srgb, <color> 7%, transparent)` |
| Light tint of an element in an error state | `color-mix(in srgb, var(--err) 7–8%, var(--panel))` |
| Right / chosen answer, highlighted cell, selected row | `color-mix(in srgb, <color> 9–12%, var(--panel))` |
| Success banner, colored glyph fill | `color-mix(in srgb, <color> 13–14%, var(--panel))` |
| Focus glow of inputs | `0 0 0 3px color-mix(in srgb, var(--focus) 20%, transparent)` |
| Soft colored border | `color-mix(in srgb, <color> 45%, var(--line))` or `… 45%, transparent)` |
| Floating caption background | `color-mix(in srgb, var(--panel) 85%, transparent)` |

---

## 4. Typography

### 4.1 Fonts

- **Text: Cantarell**, the variable font of the GNOME project (`fonts/cantarell.woff2`,
  weights 100 to 800). It is the font PacketPilot shows on Linux, now shipped so that every
  system shows the same letters.
- **Code, numbers that are typed, addresses, times, tables in panels: DejaVu Sans Mono**
  (`fonts/dejavu-sans-mono.woff2` and `-bold.woff2`).
- Both are declared in `base.css` with `font-display: block` and the text font is preloaded in
  `<head>`:

  ```html
  <link rel="preload" href="fonts/cantarell.woff2" as="font" type="font/woff2" crossorigin>
  ```

- Licenses: SIL OFL 1.1 (Cantarell) and the Bitstream Vera license (DejaVu), in
  `fonts/LICENSE-*.txt`. Keep them next to the fonts.
- `body` has `-webkit-font-smoothing: antialiased`.

### 4.2 The type scale

`1rem = 16px` (the browser default; never change `html { font-size }`). The body text is
`15px`. Only these sizes exist:

| Role | CSS | px | Weight | Line height | Letter spacing | Color |
|---|---|---|---|---|---|---|
| Hero title (home only) | `.hero h1` 3rem | 48 (phone: 35.2) | 650 | 1.2 | -.03em | `--ink` |
| Page title | `h1` 2.1rem | 33.6 | 650 | 1.2 | -.01em | `--ink` |
| Section title, card title | `h2` 1.45rem | 23.2 | 650 | 1.2 | -.01em | `--ink` |
| Large question | `.subq` 1.35rem | 21.6 | 650 | 1.5 | 0 | `--ink` |
| Title in a top bar | `.lesson-top h1` 1.15rem | 18.4 | 650 | 1.2 | -.01em | `--ink` |
| Title in a task column | `.goalcol h2` 1.15rem | 18.4 | 650 | 1.2 | -.01em | `--ink` |
| Tile title | `h3` 1.1rem | 17.6 | 650 | 1.2 | -.01em | `--ink` |
| Hero lead text | `.hero p` 1.08rem | 17.3 | 400 | 1.5 | 0 | `--ink-2` |
| Body | `body` | 15 | 400 | 1.5 | 0 | `--ink` |
| Reading table, goals | .92rem | 14.7 | 400 | 1.5 | 0 | `--ink` |
| Toast, dialog text, toolbar text | .9rem | 14.4 | 400 | 1.5 | 0 | |
| Small text, captions | `.small` .85rem | 13.6 | 400 | 1.5 | 0 | usually `--ink-2` |
| Field label | `.field` .82rem | 13.1 | 400 | 1.5 | 0 | `--ink-2` |
| Panel heading | `.side-body h4` .8rem | 12.8 | 650 | 1.5 | 0 | `--ink-2` |
| Meta (durations, counts) | `.meta` .8rem | 12.8 | 400 | 1.5 | 0 | `--ink-3` |
| Chip, caption | .78rem | 12.5 | 400 | 1.5 | 0 | |
| Group label (uppercase, rare) | `.fb-grp` .74rem | 11.8 | 650 | 1.5 | .04em | `--ink-3` |
| Rail label | `.rail a` .72rem | 11.5 | 400 | 1.5 | 0 | `--ink-2` |
| Code in text | `code` .9em mono | relative | 400 | | | |
| Mono in panels | .78–.85rem mono | 12.5–13.6 | 400 | 1.45 | 0 | |

Rules:

- Weights: 400 for text, **650** for every heading and every emphasized label, 600 for
  table heads, tab labels, the active tab and feedback lines, 700 only for numbers in badges
  and step dots. Never 300, 500 or 800.
- Never uppercase, except the rare group label (`.fb-grp`). Never italic for emphasis: use
  `<b>`.
- Reading text: paragraphs at most `70ch` wide (`.theory p`), intros of overview pages
  `max-width: 68ch`, the hero lead `46ch`, the data box `80ch`.
- Headings are sentence case ("Your progress and networks", not "Your Progress And Networks").
- Paragraph spacing: `p { margin: 0 0 .8em }`, headings `margin: 0 0 .5em`, an `h2` inside
  reading text gets `margin-top: 1.3em`.

---

## 5. Layout

### 5.1 The skeleton

```
┌──────┬──────────────────────────────────────────────────────────┐
│ logo │                                                          │
│      │   .main  (scrolls; everything else stays still)          │
│ ▣    │                                                          │
│ Home │        .page  max-width 1080px, centered                 │
│ ▣    │        padding 32px 28px 64px                            │
│ Work │                                                          │
│ ▣    │                                                          │
│ …    │                                                          │
│      │                                                          │
│ ☾    │                                                          │
│ Dark │                                                          │
└──────┴──────────────────────────────────────────────────────────┘
 76px
```

```html
<body>
<div class="app">
  <nav class="rail" aria-label="Main navigation">
    <a class="logo" href="#/" title="Appname" aria-label="Appname home"><svg …36×36…></svg></a>
    <a href="#/" data-nav="home"><span data-icon="course"></span>Home</a>
    <a href="#/work" data-nav="work"><span data-icon="lab"></span>Work</a>
    …
    <span class="spacer"></span>
    <button id="theme" type="button" title="Light or dark"></button>
  </nav>
  <main class="main"></main>
</div>
</body>
```

- `.app`: `display: grid; grid-template-columns: 76px 1fr; height: 100vh`.
- `.main`: the only scroll container (`overflow: auto`). Views render into it.
- Full-height views (step page, task page, workspace) fill `.main` with `height: 100vh` and
  scroll inside their own body. Normal pages (`.page`) scroll with `.main`.

### 5.2 The rail: exact measurements (desktop)

| Element | Position and size |
|---|---|
| `.rail` | x 0, width 76 px, full height, `--panel` background, 1 px `--line` on the right, padding `10px 6px`, gap 4 px |
| Logo link `.rail .logo` | x 6, y 14, 63 × 52 px (margin `4px 0 12px`), centered content |
| Logo SVG | 36 × 36 px, at x 19.5, y 23 |
| First menu entry | x 6, y 82, 63 × 60.5 px |
| Each further entry | +64.5 px (60.5 entry + 4 gap): y 82, 146.5, 211, 275.5, … |
| Entry icon | 20 × 20 px, centered, 9 px from the top of the entry |
| Entry label | .72rem (11.5 px), centered, 3 px below the icon, 7 px bottom padding |
| Entry radius | `--r-m` (10 px) |
| Theme button | pinned to the bottom: y = viewport height − 70.5 (829.5 at 900 px) |
| Active entry | background `--ink`, text and icon `--panel` |
| Hover | background `--panel-2`, text `--ink` |
| Normal | text and icon `--ink-2`, no background |

The theme button shows a moon and **Dark** in light mode, a sun and **Light** in dark mode.
Its icon is wrapped in a `<span>` like the menu icons (`btn.innerHTML = <span>icon</span>Label`).

### 5.3 Menu entries: how to add or change them

- **Order:** the logo (links home), then the main entries in the order of use (the most
  important first), then the spacer, then the theme button. Nothing else goes into the rail.
- **Count:** 2 to 6 main entries. The phone bar shows them all plus the theme button in one
  row, so **never more than 6**. More areas go into tabs or tiles on a page.
- **Labels:** one word, at most 9 characters, or two very short words ("Fix it"). Sentence
  case. Nouns for places ("Course", "Lab", "Networks", "Library") or a short verb phrase for an
  activity ("Fix it").
- **Icons:** one per entry, from `src/js/core/icons.js` or newly drawn in the same style (section 6).
  Wrapped as `<span data-icon="name"></span>` before the label.
- **Active state:** `markNav()` marks the entry whose `data-nav` matches the first part of the
  route. Sub-pages mark their parent (a lesson marks "Course", a task marks its area). Exactly
  one entry is active, except on pages that belong to no entry.
- Routes are hash routes: `#/`, `#/area`, `#/area/id`, `#/area/id/step`.

### 5.4 Content widths and paddings

| Container | Max width | Padding | Use |
|---|---|---|---|
| `.page` | 1080 px, centered | `32px 28px 64px` (phone `20px 16px 48px`) | every normal page |
| `.theory` | 760 px, centered | `30px 28px 48px` | reading text of a step |
| `.widget` | 860 px, centered | `30px 28px 48px` | an exercise as a step |
| `.subcard` | 760 px | `16px 18px` | one question or one form on a page |
| `.goalcol` | 340 px (290 px below 1100) | `18px 18px 24px` | the task column of a task page |

At 1440 px width, the `.page` content runs from x 246 to x 1270 (1024 px).

### 5.5 Breakpoints

Exactly three, all `max-width`:

| Width | What changes |
|---|---|
| ≤ 1100 px (tablet) | the hero becomes one column (text above the live visual), the task column shrinks to 290 px, PacketPilot's side panel to 320 px |
| ≤ 760 px (phone) | the rail becomes a **bottom bar** 60 px high: entries in one row, equal width (`flex: 1 1 0`), logo and spacer hidden, theme button last; `.page` padding `20px 16px 48px`; hero title 2.2rem; task pages stack (task column on top, work area below, 80vh high); resize handles disappear; step pages grow with their content |
| ≤ 720 px | only for side-by-side builders inside a page (PacketPilot frame builder): the palette goes above |

Never add other breakpoints. Grids of tiles adapt by themselves
(`repeat(auto-fill, minmax(290px, 1fr))`).

---

## 6. Icons

All interface icons are line icons, drawn by `s()` in `src/js/core/icons.js`:

```js
const s = (body, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
```

- 24 × 24 grid, shown at **20 × 20 px**, stroke **1.8**, round caps and joins, `currentColor`
  (they take the text color of their button or link). Keep 2 units of space at the edges.
- Fills only for tiny details (a dot of `r="1"`) and for the media symbols (play, pause).
- Available: `course lab nets frame fix calc print share timer play pause step reset cable trash
  plus minus sun moon check circle lock right left down up terminal table sliders target bulb
  download upload full unfull fit eye route x save info warn flag spark ffwd area grip`.
- A new icon is drawn in the same style, added to the project's own `src/js/icons.js` (the core icons in
  `src/js/core/icons.js` stay unchanged), and stays simple: 2 to 6 strokes.
- Icons in buttons sit **before** the label with a 6 px gap (`.btn` handles it). Status icons
  in lists: `check` in `--ok` for done, `circle` in `--ink-3` for open.
- Diagram symbols (PacketPilot's devices) are a domain thing: 40 × 40, stroke 1.6, filled
  with `color-mix(in srgb, var(--ink) 8%, var(--panel))` and outlined in `--ink`. Pictograms
  of a project's own objects follow that recipe.

---

## 7. Components

Every component below exists in `base.css` and is shown on the **Parts** page of the template app (`blueprint new` creates it; screenshots in `screens/tpl-parts*.png`). The
markup is exact: same elements, same classes. `h()` from `src/js/core/ui.js` builds it in JS
(`h('button', { class: 'btn primary' }, 'Save')`).

### 7.1 Buttons

```html
<button class="btn primary">Start with lesson 1</button>   <!-- one per view: the main action -->
<button class="btn">Open the free lab</button>             <!-- normal actions -->
<button class="btn ghost">Reset progress</button>          <!-- quiet: secondary, rare or destructive-with-confirm -->
<button class="btn"><svg…/>Download backup</button>        <!-- icon + label -->
<button class="btn icon ghost" title="Share" aria-label="Share"><svg…/></button>  <!-- icon only: always a title -->
<button class="btn on">Loss</button>                       <!-- a switched-on toggle -->
<button class="btn danger-soft">Delete</button>            <!-- destructive -->
<button class="linkbtn">More options</button>              <!-- text link that acts -->
<a class="btn primary" href="#/lab">Open in the lab</a>    <!-- navigation looks like a button when it is an action -->
```

- `.btn`: inline-flex, gap 6 px, padding `6px 12px` (icon-only `6px`), 1 px `--line` border,
  `--panel` background, radius `--r-s`, line-height 1.3, no wrapping. Height: 33.5 px.
  Hover: border `--ink-3`.
- `.primary`: `--btn` background, `--btn-ink` text; hover opacity .9. At most one primary
  button per area (hero, card, dialog, bottom bar).
- `.ghost`: no border, no background (hover shows the border).
- `[disabled]`: opacity .45, `not-allowed`.
- A row of buttons: `<div class="row">`. The primary one comes first on the left; in a
  bottom bar the forward action is on the right (Back left, status middle, Next right).
- Icon-only buttons are `btn icon ghost` (`iconBtn()` in `ui.js` makes them).

### 7.2 Fields and inputs

```html
<label class="field">Name<input class="input" value="…"></label>
<label class="field">Address<input class="input mono" value="192.168.1.10" spellcheck="false"></label>
<input class="input bad">                                  <!-- invalid value -->
<select class="input"><option>Medium</option></select>
<label class="row small"><input type="checkbox"> A checkbox</label>
<div class="feedback ok">Right. …</div><div class="feedback bad">Not yet, …</div>
```

- `.input`: 1 px `--line`, `--panel`, radius `--r-s`, padding `5px 8px`. Focus: border
  `--focus` plus a 3 px glow (3.4). Heights: 33.6 px in a `.field` (like the 33.5 px buttons),
  32.4 px for `.input.mono`, 31 px for a `select.input`.
- `.field`: label text above the input, gap 3 px, label .82rem `--ink-2`, input text .9rem `--ink`.
- `.input.mono` for anything a person types like code: addresses, commands, keys, answers to
  technical questions. Placeholders show a realistic example (`10.0.0.10`).
- Inputs and buttons in one line: `<div class="row">` (flex, gap 8 px, wraps).

### 7.3 Layout helpers

- `.row`: flex, `gap: 8px`, centered, wrapping. `style="flex-wrap:nowrap"` where it must stay
  on one line.
- `.grow`: `flex: 1` (pushes the rest to the right).
- `.muted` (`--ink-2`), `.small` (.85rem), `.hidden`, `.mono`, `.ok-text`.
- Vertical rhythm on pages: page `h1` → intro `p.muted` → content. Section `h2` gets
  `margin-top: 22px` (inside a list of levels) or `28px` (new section); a heading row with a
  button on the right is `.row` with `justify-content: space-between; margin-top: 18px` and an
  `h2` with `margin: 0`.

### 7.4 Chips

```html
<span class="chip">Topic</span>   <span class="chip on">on</span>
```

Pill, padding `1px 8px`, .78rem, `--panel-2` background, 1 px `--line`. Topics and tags in
a `.row`. `.on` turns text and border green.

### 7.5 Tiles and the tile grid

```html
<div class="cardgrid">
  <article class="tile">
    <svg …preview…/>                     <!-- optional preview, 120 px high, on --paper -->
    <h3>Two subnets and a router</h3>
    <div class="row"><span class="chip">Routing</span><span class="chip">ARP</span></div>
    <p class="muted small">Two sentences at most.</p>
    <div><a class="btn primary" href="#/lab/routed">Open in the lab</a></div>
  </article>
  <a class="tile" href="#/troubleshoot">  <!-- the whole tile is a link -->
    <div class="row" style="flex-wrap:nowrap"><span class="pico"><svg…/></span><h3 style="margin:0">Troubleshooting</h3></div>
    <p class="muted small">Broken networks with a symptom and a hidden cause.</p>
    <div class="small muted">3 of 24 solved</div>
  </a>
</div>
```

- `.cardgrid`: `repeat(auto-fill, minmax(290px, 1fr))`, gap 16 px, `margin-top: 16px`.
- `.tile`: `--panel`, 1 px `--line`, radius `--r-m`, padding 16 px, grid gap 8 px.
- `a.tile` hover: border `--focus` and `--shadow` (transition .12s). `.tile.done`: green-tinted
  border, with a green check where the level dots were.
- `.pico`: the icon of a link tile, in `--focus`.
- `.lvl`: difficulty dots, three 7 px circles, `on` in `--c-orange`.

### 7.6 Numbered sections (the course list)

```html
<div class="modules">
  <article class="module done">
    <div class="num" aria-hidden="true">1</div>
    <div>
      <h2>Ethernet, MAC and ARP</h2>
      <div class="bands" aria-hidden="true"><i class="bg-eth"></i><i class="bg-arp"></i></div>
      <p class="muted">What it is about, in one sentence.</p>
      <div class="progressbar" title="40 % done"><i style="width:40%"></i></div>
      <ol class="lessons">
        <li><a href="#/lesson/m1-l1"><span class="st ok"><svg check/></span><span>Encapsulation</span><span class="meta">done</span></a></li>
        <li><a href="#/lesson/m1-l2"><span class="st"><svg circle/></span><span>The frame</span><span class="meta">12 min</span></a></li>
      </ol>
    </div>
  </article>
</div>
```

- `.module`: 56 px number column + content, padding `20px 22px`, gap 16 px, radius `--r-m`.
- `.num`: 44 px circle, 2 px `--ink` border, weight 700, 1.1rem. `.module.done .num` is filled
  with ink.
- `.bands`: colored stripes 26 × 6 px, gap 3, showing which categories (signal colors) the
  section touches.
- `.progressbar`: 6 px, `--grid` track, `--ok` fill, radius 3.
- `.lessons a`: grid `22px 1fr auto`, padding `7px 10px`, hover `--panel-2`. Meta on the
  right: "done", "2 of 4 steps" or the duration "12 min".

### 7.7 Hero (home page only)

```html
<section class="hero">
  <div>
    <h1>PacketPilot</h1>
    <p>What the app does, in two sentences.</p>
    <div class="row" style="margin-top:18px"><a class="btn primary" href="…">Start with lesson 1</a><a class="btn" href="…">Open the free lab</a></div>
    <div class="small muted" style="margin-top:12px">0 of 75 lessons completed</div>
  </div>
  <div class="hero-visual"> …a live, working example… <span class="caption">Live: pc1 pings srv1.</span></div>
</section>
```

Two columns `1fr : 1.15fr`, gap 32, centered vertically, padding `8px 0 28px`. The visual is
280 px high, radius `--r-m`, 1 px border, `--paper` background, with a pill caption at the
bottom left. Below 1100 px the visual goes under the text.

### 7.8 Data box (your data, backup)

`<section class="databox">` at the end of the home page: `h2`, one or two `p.muted`, a row of
`<span class="stat"><b>12</b> lessons done</span>`, and a row of buttons (primary "Download
backup", normal "Restore backup", ghost "Reset progress"). Every project that stores data in
the browser has this box.

### 7.9 Step page (top bar, body, bottom bar)

```html
<div class="lesson">
  <div class="lesson-top">
    <a class="btn icon ghost" href="#/" title="Back to the course overview"><svg left/></a>
    <div><div class="crumb">Module 1: Ethernet, MAC and ARP</div><h1>The Ethernet frame</h1></div>
    <div class="steps" aria-label="Steps"><button class="ok">✓</button><button class="cur">2</button><button>3</button></div>
  </div>
  <div class="lesson-body"> <article class="theory">…</article> </div>
  <div class="lesson-nav"><button class="btn"><svg left/>Back</button><span class="small muted">Status</span><button class="btn primary">Next<svg right/></button></div>
</div>
```

- Top bar: padding `12px 20px`, `--panel`, bottom border; 67.5 px high. Crumb .85rem `--ink-2`
  above the title (1.15rem). Back button first. Step dots on the right: 26 px circles, 2 px
  border; current: ink border, bold; done: green fill, white check.
- Bottom bar: padding `10px 20px`, top border, 55 px high. Back on the left, status text in the
  middle, the primary forward action on the right with a right arrow after the label.
- A timer or a print button can sit on the right of the top bar (`.chtimer`: mono .9rem with
  the timer icon; hidden on phones).

### 7.10 Reading text

Inside `<article class="theory">`: `p`, `ul/ol`, `h2`, `table`, `pre`, and notes:

```html
<div class="note">An aside: one useful extra.</div>
<div class="note warn">What goes wrong and how to avoid it.</div>
```

Notes: 3 px left border (`--c-blue`, or `--warn`), `--panel` background, padding `10px 14px`,
radius `0 6px 6px 0`. Tables: full width, 1 px `--line` cells, padding `6px 10px`, head on
`--panel-2` weight 600, .92rem. `pre`: `--panel`, 1 px border, radius 6, mono .82rem/1.45.

### 7.11 Task page (task column + work area)

```html
<div class="lesson">
  <div class="lesson-top">…back, crumb, title, timer…</div>
  <div class="lesson-body is-lab">            <!-- grid: var(--goal-w, 340px) | work area -->
    <div class="goalcol">
      <h2>The task</h2>
      <div class="theory" style="padding:0"><p>What to do.</p></div>
      <ol class="goals">
        <li class="ok"><span class="st"><svg check/></span><div class="txt"><span>A goal that is reached.</span></div></li>
        <li><span class="st"><svg circle/></span><div class="txt"><span>A goal with a question.</span>
          <div class="ask"><div class="row" style="flex-wrap:nowrap"><input class="input mono" placeholder="Answer"><button class="btn">Check</button></div></div></div></li>
      </ol>
      <button class="btn ghost"><svg bulb/>Show a hint</button>
      <div class="hint">One hint at a time.</div>
      <div class="done-banner">All goals reached.</div>
    </div>
    <div class="canvas-wrap">…the work area…</div>
    <!-- resizer('col', …) from ui.js: drag the column border, double-click resets; the width is remembered -->
  </div>
</div>
```

Goals tick themselves off (check in `--ok`, text turns `--ink-2`). Hints: dashed border,
`--panel-2`. The done banner: green tint, weight 600.

### 7.12 Work area

`.canvas-wrap` is the paper with the 24 px grid (`--grid` lines on `--paper`). Things that float
on it: a toolbar (`.player .bar` in PacketPilot: `--panel`, 1 px border, radius `--r-m`,
padding 4, `--shadow`), a pill hint at the bottom center (`.hint-overlay`), and cards of the
objects (white `--panel` cards with a 1.5 px `--line` stroke, radius 10; selected: 2.5 px
`--select`).

### 7.13 Tabs

```html
<div class="tabs subtabs" role="tablist"><button class="cur" role="tab" aria-selected="true">Range</button><button role="tab">Mask</button></div>
```

Text tabs on a 1 px bottom line; the current tab is ink, weight 600, with a 2 px ink underline.
Padding `7px 8px`, .86rem. Inside panels use `.tabs` alone; on pages add `.subtabs` (wraps).

### 7.14 Side panel

The right panel of a workspace (PacketPilot's device panel): `--panel`, 1 px left border, a
head (`.side-head`: glyph 34 px + editable name 1.02rem/650 + subtitle), `.tabs`, and a scrolling
`.side-body` (padding `12px 14px 20px`) with `h4` headings (.8rem, 650, `--ink-2`).

### 7.15 Collapsible sections and optional features

```html
<details class="sect" open><summary>VLANs <span class="sect-status on">on</span></summary><div class="sect-body">…</div></details>
<div class="features"><button class="btn addfeat"><svg plus/>Add a feature <span class="small muted">BFD, OSPF, …</span></button>
  <div class="featmenu"><button class="featitem"><b>BFD</b><span>Detects a dead neighbor in milliseconds</span></button></div></div>
```

Chevron `›` turns 90° when open; the status on the right is `--ink-3` or green `.on`.
Optional features are hidden until added: a full-width dashed button opens a small menu of
`featitem`s (bold name + one-line explanation). Every added feature is also removable, in
two ways: a quiet `btn ghost danger` "Remove …" at the end of its section, and a right-click
on the section header with the same action. Removing resets the feature to its defaults and can
be undone.

### 7.16 Tables and data

| Class | Look | Use |
|---|---|---|
| `.rtable` | mono .85rem, every cell bordered, head in text font on `--panel-2` | small reference tables in exercises |
| `.tbl` | full width, mono .78rem, rows separated by `--grid`, head .76rem `--ink-2` | dense tables in panels (MAC table, routes) |
| `.kv` (`dl`) | two columns, keys `--ink-2`, values mono | properties of one thing |
| `.list > .item` | boxes with `--panel-2`, 1 px border, radius 6, padding 8 | editable entries in panels |
| `.empty` | `--ink-3` .85rem | "Nothing here yet." text instead of an empty table |

### 7.17 Terminal

`.console`: a `pre` on `#0F1A2A` with `#D7E2F0` text (dark in both modes), mono .78rem/1.45,
radius 6, padding 10. Below: an input row (mono input + primary "Run") and a row of small
preset buttons (`.quick button`: .74rem, padding `2px 8px`).

### 7.18 Exercise (quiz)

`.quiz-q`: card, radius `--r-m`, padding `16px 18px`. Options are bordered labels (radius 6,
padding `7px 10px`); after checking, the right one is green-tinted (`.right`), a wrong pick red
(`.wrong`), then `.explain` in `--ink-2`.

### 7.19 Toast

`toast('Network imported')` from `src/js/core/ui.js`: a dark pill-ish box (`--ink` background, `--panel`
text, radius `--r-m`, padding `9px 16px`, .9rem) at the bottom center, 22 px above the edge,
for 2.6 seconds. One sentence, no period needed for short ones. It confirms what happened
or says why not. It never asks a question.

### 7.20 Dialog

```html
<dialog class="dlg"><h3>Share this network</h3><input class="input mono" readonly><div class="row" style="margin-top:10px"><button class="btn primary">Copy link</button><button class="btn ghost">Close</button></div></dialog>
```

`width: min(560px, 92vw)`, radius `--r-m`, padding `18px 20px`, `--shadow`, backdrop
`rgba(10, 18, 30, .45)`. Only for things that must be read or copied. Simple confirmations
use `confirm()` with a full sentence that says the consequence: "Start an empty network?
Unsaved changes will be lost."

### 7.21 Context menu (right-click)

`contextMenu(event, items, title)` from `src/js/core/ui.js`. Items: `{ label, icon, onClick, hint, danger,
disabled }` or `'-'` for a separator. Look: `--panel`, 1 px border, radius 6, `--shadow`,
padding 4; items `.87rem`, 16 px icon, keyboard hint in mono `--ink-3` on the right; delete
items in `--err` at the end after a separator. Arrow keys and Escape work. Everything in a
context menu is also reachable another way (a button or a key).

### 7.22 Glossary tooltip

`<abbr class="gl">` gets a dotted underline (`--ink-3`) and one shared tooltip (`.gl-tip`:
`--panel`, border, `--shadow`, max 320 px, .84rem) on hover and focus.

### 7.23 Resize handles

`resizer('col' | 'row', { onMove, onEnd, onReset })`: a 9 px invisible strip on a panel border
that shows a 3 px `--c-blue` line on hover. Double-click restores the default. The chosen size
is remembered in the preferences. Hidden on phones.

### 7.24 Floating notice

A quiet card at the bottom right (`.movecard` in PacketPilot: max 340 px, `--panel`, border,
radius `--r-m`, `--shadow`, padding `12px 14px`, .9rem) for information that is not urgent.
Never a modal, never a banner across the page.

### 7.25 A new component: the recipe

When a project needs something that is not in this list:

1. Background `--panel` (lying on `--paper`) or `--panel-2` (inside a panel).
2. Border `1px solid var(--line)`. Separators inside: `1px solid var(--grid)` or `--line`.
3. Radius `--r-m` for a card or panel, `--r-s` for anything inside one, `99px` for pills.
4. Padding from the scale: 4, 6, 8, 10, 12, 14, 16, 18, 20, 22 px. Gaps: 2, 3, 4, 6, 8, 10,
   12, 14, 16, 18, 22, 32 px.
5. Text sizes and weights only from 4.2. Colors only from section 3.
6. Shadow only if it floats above other content.
7. States: hover `--panel-2` background or `--ink-3` border; selected `--select`; focus via
   `:focus-visible` (2 px `--focus` outline, offset 2); done `--ok`; error `--err`.
8. Write it into `src/css/app.css` with a comment, check both themes and three widths, and add
   an example of it to the project's own parts page if it has one.
9. If other apps could use it too, propose it for the library (12-library.md).

### 7.26 Project CSS (`src/css/app.css`)

What a project writes itself, after base.css and the library styles:

- **Signal colors get a meaning** as project tokens, e.g. `--k-input: var(--c-blue);` and
  classes like `.bg-input` for stripes and dots (PacketPilot: `--l-eth`, `.bg-eth`, `.lc-eth`).
- **The app's own components**, built by the recipe of 7.25, with class names that do not
  collide with base.css (prefix them with the app's own words: `.lab-…`, `.fb-…`).
- **Never**: hex colors (except `#fff` text on a solid signal color), other fonts,
  `@import`, `@font-face`, other radii than the tokens / `99px` / `50%`, shadows other than
  `var(--shadow)` or a 1–3 px ring, `!important` against base classes, overriding a base
  class itself. `blueprint check` refuses most of these; review catches the rest.


---

## 8. Interaction and motion

- Transitions: only `.12s` on `border-color`, `box-shadow`, `opacity` and `transform` of small
  things (chevrons). No page transitions, no slide-ins, no bouncing, no skeleton shimmer.
- Animation exists only where it *explains* something (PacketPilot: packets moving along
  cables, slowed down). `prefers-reduced-motion` turns transitions and animations off.
- Hover never moves things. It changes a background or a border.
- Focus: every interactive element shows `outline: 2px solid var(--focus); outline-offset: 2px`
  on `:focus-visible`. Inputs use the glow instead.
- Cursors: `pointer` for clickable, `grab` for draggable, `col-resize`/`row-resize` for
  handles, `help` for glossary terms, `not-allowed` for disabled buttons.
- Keyboard: Escape closes menus and dialogs, Enter submits the field it is in, shortcuts are
  shown as hints in context menus and in the help text of a work area.
- Everything a person does is kept (`localStorage` under `<app>.v1`), including panel sizes,
  the theme, the last tab, answers in progress. Nothing is lost on reload.
- Something destructive that **can be undone** (Ctrl+Z) happens at once, and the toast says
  how to get it back: "BGP removed from r1. Ctrl+Z brings it back." Something destructive that
  **cannot** be undone first asks with a `confirm()` that names the consequence, then confirms
  with a toast.

---

## 9. Writing

The words are as much a part of the design as the colors.

- **Plain and calm.** Short sentences. Concrete verbs. No marketing ("powerful", "seamless",
  "amazing"), no exclamation marks, no emoji, no "Oops".
- **Talk to the person** ("you", "your progress"), in the present tense.
- **Sentence case everywhere:** titles, buttons, menu entries, tabs ("Open the free lab",
  "Print theory", "Your progress and networks").
- **Buttons say what happens:** a verb and an object ("Download backup", "Open in the lab",
  "Show a hint", "Copy link"), never "OK", "Submit" or "Click here". Navigation forward is
  "Next", backward "Back", at the end "To the overview".
- **Counts are written out:** "0 of 75 lessons completed", "3 of 24 solved", "2 of 4 steps",
  "Best time 1:24 · 2 of 6 variants found". Durations: "12 min". Separator inside a line: ` · `.
- **Feedback:** right is "Right." or a short statement; wrong is "Not yet, take another close
  look" (encouraging, never blaming). Errors say what happened and what to do: "This file is not
  a PacketPilot network", "Name empty or already taken".
- **Empty states explain the next step:** "Nothing has happened yet. Open the console of a
  device and send a ping."
- **Explanations:** one idea per paragraph, the term in **bold** where it is introduced,
  examples with real values (`192.168.10.10`, `www.firma.lab`), tables to compare.
- **Captions and hints** start with what it is: "Live: pc1 pings srv1. Every stripe on the
  envelope is a layer."
- Language: English unless the project says otherwise. No mix of languages in one interface.

---

## 10. Accessibility

- Every icon-only button has `title` and `aria-label`. Decorative SVGs have `aria-hidden="true"`.
- The rail is `<nav aria-label="Main navigation">`; tabs use `role="tablist"`/`"tab"` and
  `aria-selected`; step dots use `aria-current="step"`; toasts are `role="status"`; menus
  `role="menu"`/`"menuitem"`.
- Contrast: body text `--ink` on `--paper`/`--panel` and `--ink-2` for secondary text only; never
  put text in `--ink-3` below .8rem except meta data.
- `<html lang="en">`, a `<noscript>` line, real `<button>`s for actions and `<a href>` for
  navigation.

---

## 11. Print

`@media print` in `base.css` hides the rail, toasts and `.no-print` elements, forces light
colors on white, removes paddings and keeps tables, notes and code blocks unbroken. A printable
view (PacketPilot's "Print theory") renders the reading text with `.theory` and starts each
part on a new page.

---

---

## 12. Checking a project against this chapter

The blueprint checks most of it automatically:

- `node .blueprint/tools/blueprint.mjs check`: base.css, fonts, core JS and library files are
  exactly the blueprint's; the head and the logo of `src/index.html` are the managed blocks; the
  rail has 2 to 6 entries with labels of at most 9 characters; no CDN; the project CSS uses no
  foreign colors, fonts or shadows.
- `node test/run.mjs --browser` runs `test/browser/blueprint.test.mjs` in a real browser: rail
  width 76 px, logo at x 19.5 / y 23, menu entries at y 82 + n × 64.5, the theme button at the
  bottom, Cantarell loaded, 15 px body text, the paper and ink colors in light and dark mode, the
  theme stored under `<app>.v1`, every menu entry marks itself active, the bottom bar on phones
  with equal widths, no horizontal scrolling at 1440, 1000 and 390 px, no request to another
  server, no error in the browser.

What only people (and agents) can check:

1. Compare every page with the reference screenshots in [screens/](screens) at **1440 × 900**,
   **1000 × 800** and **390 × 844**, in **light and dark**: same page type, same positions.
   Buttons are 33.5 px high, inputs in fields 33.6 px, the top bar of a step page 67.5 px, page
   content starts at x 246 at 1440 px.
2. Every text follows section 9. Every page works without a mouse (Tab, Enter, Escape).
3. The composition follows [10-composition.md](10-composition.md): nothing on a page that has
   no purpose in this app.

## 13. Reference screenshots

| File | Shows |
|---|---|
| `pp-home.png`, `pp-home-dark.png` | PacketPilot home: rail, hero with live visual, numbered sections |
| `pp-home-tablet.png`, `pp-home-phone.png` | the same at 1000 and 390 px: one-column hero, bottom bar |
| `pp-lesson-theory.png` | step page with reading text |
| `pp-lesson-lab.png` | task page: goal column and work area |
| `pp-lab.png`, `pp-lab-dark.png` | workspace: toolbar, palette, work area, side panel, log and inspector |
| `pp-networks.png` | tile grid with previews and chips |
| `pp-fixit.png`, `pp-subnets.png`, `pp-frames.png` | overview with levels, tabs with a subcard, builder |
| `tpl-home.png`, `tpl-home-dark.png`, `tpl-home-phone.png` | the template app made by `blueprint new` |
| `tpl-step.png`, `tpl-work.png`, `tpl-library.png` | its step page, task page, tile grid |
| `tpl-parts.png`, `tpl-parts-dark.png` | every component of section 7, light and dark |
