# Stat tiles (`stats`)

Big numbers with a short label, in a grid of small tiles. Taken from PacketPilot's frame
builder, where it shows the sizes of a frame.

## When to use

- A page that summarizes: a dashboard, the head of a report, the result of a run.
- Three to eight numbers that a user compares at a glance (counts, totals, sizes, times).

## When not to use

- One or two numbers: write them in a sentence or in a `.databox` stat line.
- Numbers that need a unit explained, a trend or a chart: that is a different element.
- Inside tables or lists: use the cells there.

## Markup

```html
<div class="stats">
  <div class="stat-tile"><b>12</b><span>lessons done</span></div>
  <div class="stat-tile ok"><b>1:24</b><span>best time</span></div>
  <div class="stat-tile bad"><b>3</b><span>errors</span></div>
</div>
```

or in JavaScript: `statTiles([{ value: 12, label: 'lessons done' }, { value: '1:24', label: 'best time', state: 'ok' }])`
from `src/js/lib/stats.js`.

## Rules

- Labels are lowercase phrases without a period ("lessons done", "best time").
- Values are short: a number, a time `m:ss`, a size with its unit ("1.2 MB").
- `ok` and `bad` only when the number itself is good or bad news, never for decoration.
- The grid adapts by itself (tiles of at least 150 px); never set widths.

## Files

`src/css/lib/stats.css`, `src/js/lib/stats.js`, `test/browser/lib-stats.test.mjs`
