#!/usr/bin/env node
// Logo generator for every project of the design system (docs/DESIGN.md, "Logo").
//
// In a project the logo is made from project.conf (LOGO_PATTERN, LOGO_COLORS) by
// `node .blueprint/tools/blueprint.mjs render` (SVG) and `… logo` (PNG). By hand:
//   node make-logo.mjs --name appname --pattern bars --colors blue,green,brown,orange --out assets/logo [--title Appname]
//
// Writes:
//   <name>-icon-light.svg, <name>-icon-dark.svg          the logo (card in ink, content in signal colors)
//   <name>-icon-{light,dark}[-background].png            1024 x 1024, transparent or on the page color
//   <name>-apple-touch-icon.png                          180 x 180 on white, for iOS home screens
//   <name>-snippets.html                                 favicon <link> and the inline SVG for the rail
// PNGs need Playwright (npm i -D playwright). Without it only the SVGs and snippets are written.
//
// Nothing about the card may change: size, position, corner radius and color are fixed.
// Only the content inside the card is chosen per project: one PATTERN and 1 to 4 COLORS.
import fs from 'node:fs';
import path from 'node:path';

// Signal colors of base.css (the same in light and dark mode)
export const COLORS = {
  blue: '#2F6FDB', violet: '#7A5AF8', orange: '#EE7F1A', green: '#1F9D68', teal: '#0E93A8', brown: '#8B5E3C',
  pink: '#D24C8D', gold: '#B8920A', rust: '#B4532A', pine: '#0F766E'
};
const INK = { light: '#17253A', dark: '#E4EBF5' };          // --ink of each theme: the card
const PAGE = { light: '#FFFFFF', dark: '#0E1624' };         // background of the "-background" PNGs

// The fixed frame: 32 x 32 grid, card 26 x 16 at (3, 8), radius 3.
// Content box: 18 x 8 at (7, 12), 4 units from every card edge. Content parts have radius 1.
const CARD = '<rect x="3" y="8" width="26" height="16" rx="3" fill="{ink}"/>';
const BOX = { x: 7, y: 12, w: 18, h: 8 };

// Patterns: each returns the content parts, one color per part (in the order given)
const r = (x, y, w, h) => ({ t: 'rect', x, y, w, h });
const c = (cx, cy, d) => ({ t: 'circle', cx, cy, d });
const across = (n, w, gap) => { const total = n * w + (n - 1) * gap; return [...Array(n)].map((_, i) => BOX.x + (BOX.w - total) / 2 + i * (w + gap)); };
export const PATTERNS = {
  // Vertical bars 3 x 8, gap 2 (PacketPilot: four layers of a packet). Sequences, layers, steps of a process.
  bars: { min: 1, max: 4, make: n => across(n, 3, 2).map(x => r(x, BOX.y, 3, BOX.h)) },
  // Rising bars, bottom-aligned, heights 2/4/6/8. Growth, levels, statistics, progress.
  steps: { min: 2, max: 4, make: n => across(n, 3, 2).map((x, i) => { const h = 8 - 2 * (n - 1 - i); return r(x, BOX.y + BOX.h - h, 3, h); }) },
  // Two full-width rows 18 x 3, gap 2. Lists, text, documents, records.
  rows: { min: 2, max: 2, make: () => [r(BOX.x, BOX.y, 18, 3), r(BOX.x, BOX.y + 5, 18, 3)] },
  // A square 8 x 8 and two rows 8 x 3 next to it. Media with text, cards, catalogs, profiles.
  split: { min: 3, max: 3, make: () => [r(BOX.x, BOX.y, 8, 8), r(BOX.x + 10, BOX.y, 8, 3), r(BOX.x + 10, BOX.y + 5, 8, 3)] },
  // Round dots of diameter 4 on the middle line, gap 2. Messages, people, events, signals.
  dots: { min: 2, max: 3, make: n => across(n, 4, 2).map(x => c(x + 2, BOX.y + BOX.h / 2, 4)) },
  // A short and a long row. A label and its value, keys, settings, forms.
  pair: { min: 2, max: 2, make: () => [r(BOX.x, BOX.y, 6, 8), r(BOX.x + 8, BOX.y, 10, 8)] }
};

export function logoSvg({ pattern = 'bars', colors = ['blue', 'green', 'brown', 'orange'], theme = 'light', ink, size } = {}) {
  const p = PATTERNS[pattern];
  if (!p) throw new Error(`Unknown pattern "${pattern}". Patterns: ${Object.keys(PATTERNS).join(', ')}`);
  const n = colors.length;
  if (n < p.min || n > p.max) throw new Error(`Pattern "${pattern}" takes ${p.min === p.max ? p.min : `${p.min} to ${p.max}`} colors, got ${n}`);
  if (new Set(colors).size !== n) throw new Error('Every part of the content needs its own color');
  const fill = col => col.startsWith('var(') ? col : (COLORS[col] || (() => { throw new Error(`Unknown color "${col}". Colors: ${Object.keys(COLORS).join(', ')}`); })());
  const fmt = v => String(Math.round(v * 100) / 100);
  const parts = p.make(n).map((s, i) => s.t === 'rect'
    ? `<rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.w)}" height="${fmt(s.h)}" rx="1" fill="${fill(colors[i])}"/>`
    : `<circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.d / 2)}" fill="${fill(colors[i])}"/>`);
  const dim = size ? ` width="${size}" height="${size}"` : '';
  return `<svg viewBox="0 0 32 32"${dim} xmlns="http://www.w3.org/2000/svg">${CARD.replace('{ink}', ink || INK[theme])}${parts.join('')}</svg>`;
}

// Inline SVG for the rail: card and parts follow the theme through CSS variables
export function railSvg(opts) {
  const vars = { blue: '--c-blue', violet: '--c-violet', orange: '--c-orange', green: '--c-green', teal: '--c-teal', brown: '--c-brown', pink: '--c-pink', gold: '--c-gold', rust: '--c-rust', pine: '--c-pine' };
  return logoSvg({ ...opts, ink: 'var(--ink)', colors: opts.colors.map(c => `var(${vars[c]})`) })
    .replace(' xmlns="http://www.w3.org/2000/svg"', '').replace('<svg viewBox="0 0 32 32"', '<svg viewBox="0 0 32 32" width="36" height="36" aria-hidden="true"');
}
export const faviconHref = opts => 'data:image/svg+xml,' + logoSvg({ ...opts, theme: 'light' }).replace(/"/g, "'").replace(/[<>#]/g, ch => encodeURIComponent(ch));

/** PNG files of the logo (Playwright with Chromium needed) */
export async function makePngs({ name, pattern, colors, out }) {
  const opts = { pattern, colors };
  logoSvg(opts);   // validates pattern and colors before anything is written
  fs.mkdirSync(out, { recursive: true });
  const file = f => path.join(out, `${name}-${f}`);
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { throw new Error('The PNG logos need Playwright: npm install, then run this again.'); }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shot = async (svg, px, bg, to) => {
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><div id=c style="width:${px}px;height:${px}px;background:${bg || 'transparent'}">${svg.replace('<svg ', `<svg width="${px}" height="${px}" `)}</div>`);
    await page.locator('#c').screenshot({ path: to, omitBackground: !bg });
  };
  for (const theme of ['light', 'dark']) {
    const svg = logoSvg({ ...opts, theme });
    await shot(svg, 1024, null, file(`icon-${theme}.png`));
    await shot(svg, 1024, PAGE[theme], file(`icon-${theme}-background.png`));
  }
  await shot(logoSvg({ ...opts, theme: 'light' }), 180, PAGE.light, file('apple-touch-icon.png'));
  await browser.close();
  console.log(`PNG logos written to ${out}`);
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(a => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(' ')]; }));
  if (!args.name) {
    console.log('Usage: node make-logo.mjs --name appname --pattern bars --colors blue,green,brown,orange [--out dir] [--title Appname]\n');
    console.log('Patterns:', Object.entries(PATTERNS).map(([k, p]) => `${k} (${p.min === p.max ? p.min : `${p.min}-${p.max}`} colors)`).join(', '));
    console.log('Colors:  ', Object.keys(COLORS).join(', '));
    process.exit(1);
  }
  const opts = { pattern: args.pattern || 'bars', colors: (args.colors || 'blue,green,brown,orange').split(',').map(s => s.trim()) };
  const out = args.out || '.';
  logoSvg(opts);
  fs.mkdirSync(out, { recursive: true });
  const title = args.title || args.name[0].toUpperCase() + args.name.slice(1);
  for (const theme of ['light', 'dark']) fs.writeFileSync(path.join(out, `${args.name}-icon-${theme}.svg`), logoSvg({ ...opts, theme }) + '\n');
  fs.writeFileSync(path.join(out, `${args.name}-snippets.html`), `<!-- In <head>: -->\n<link rel="icon" href="${faviconHref(opts)}">\n<link rel="apple-touch-icon" href="${args.name}-apple-touch-icon.png">\n\n<!-- First child of <nav class="rail">: -->\n<a class="logo" href="#/" title="${title}" aria-label="${title} home">\n  ${railSvg(opts)}\n</a>\n`);
  try { await makePngs({ name: args.name, ...opts, out }); } catch (e) { console.log(`SVGs and snippets written to ${out}. ${e.message}`); }
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  try { await main(); } catch (e) { console.error(e.message); process.exit(1); }
}
