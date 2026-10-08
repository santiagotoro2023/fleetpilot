// Blueprint @@BLUEPRINT_VERSION@@: the shell of @@APP_NAME@@ looks and behaves exactly as the
// specification says (.blueprint/spec/01-design.md). The same test runs in every project.
import assert from 'node:assert/strict';
import { open, box, BASE } from '../lib/browser.mjs';

let n = 0;
const near = (a, b, what) => { assert.ok(Math.abs(a - b) <= 0.5, `${what}: ${a}, expected ${b}`); n++; };

// ---------------------------------------------------------------- Desktop, light
const d = await open({ width: 1440, height: 900, colorScheme: 'light' });
const { page } = d;
await page.evaluate(() => document.fonts.ready);
const facts = await page.evaluate(() => {
  const cs = getComputedStyle(document.body), root = getComputedStyle(document.documentElement);
  return {
    columns: getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ')[0],
    font: cs.fontFamily, size: cs.fontSize, bg: cs.backgroundColor, color: cs.color,
    ink: root.getPropertyValue('--ink').trim(), paper: root.getPropertyValue('--paper').trim(),
    cantarell: document.fonts.check('15px Cantarell'), mono: document.fonts.check('13px "DejaVu Sans Mono"'),
    entries: document.querySelectorAll('.rail > a[data-nav]').length,
    theme: !!document.querySelector('.rail > button#theme'),
    logo: !!document.querySelector('.rail > a.logo:first-child svg'),
    lang: document.documentElement.lang
  };
});
assert.equal(facts.columns, '76px', 'rail column is 76 px'); n++;
assert.match(facts.font, /^Cantarell/, 'text font is Cantarell'); n++;
assert.ok(facts.cantarell, 'the shipped Cantarell font is loaded'); n++;
assert.equal(facts.size, '15px', 'body text 15 px'); n++;
assert.equal(facts.bg, 'rgb(243, 246, 250)', 'paper background in light mode'); n++;
assert.equal(facts.color, 'rgb(23, 37, 58)', 'ink text in light mode'); n++;
assert.ok(facts.logo, 'the logo is the first element of the rail'); n++;
assert.ok(facts.theme, 'the theme button is in the rail'); n++;
assert.ok(facts.entries >= 2 && facts.entries <= 6, `2 to 6 menu entries, found ${facts.entries}`); n++;
assert.equal(facts.lang, 'en', '<html lang="en">'); n++;

const rail = await box(page, '.rail');
near(rail.x, 0, 'rail x'); near(rail.width, 76, 'rail width'); near(rail.height, 900, 'rail height');
const logo = await box(page, '.rail .logo svg');
near(logo.x, 19.5, 'logo x'); near(logo.y, 23, 'logo y'); near(logo.width, 36, 'logo width');
const entries = await page.locator('.rail > a[data-nav]').all();
for (const [i, e] of entries.entries()) {
  const b = await e.boundingBox();
  near(b.x, 6, `menu entry ${i + 1} x`); near(b.y, 82 + i * 64.5, `menu entry ${i + 1} y`); near(b.width, 63, `menu entry ${i + 1} width`);
  const label = (await e.textContent()).trim();
  assert.ok(label.length >= 2 && label.length <= 9, `menu label "${label}" has 2 to 9 characters`); n++;
  assert.equal(await e.locator('span[data-icon] svg').count(), 1, `menu entry "${label}" has one icon`); n++;
}
const theme = await box(page, '#theme');
near(theme.y, 900 - 70.5, 'theme button at the bottom');
assert.equal(await page.locator('.rail > a.active').count(), 1, 'exactly one active menu entry on the home page'); n++;

// Every menu entry opens its page and becomes the only active one
for (const e of entries) {
  const href = await e.getAttribute('href');
  await e.click(); await page.waitForTimeout(250);
  assert.equal(await page.locator('.rail > a.active').count(), 1, `one active entry on ${href}`); n++;
  assert.ok(await e.evaluate(el => el.classList.contains('active')), `${href} marks its own entry`); n++;
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll on ${href}`); n++;
}

// Theme switch: dark, remembered across a reload, back to light
await page.goto(BASE); await page.waitForLoadState('networkidle');
assert.match(await page.locator('#theme').textContent(), /Dark/); n++;
await page.click('#theme');
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark'); n++;
assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(14, 22, 36)', 'dark paper'); n++;
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('@@APP_ID@@.v1')).prefs.theme), 'dark', 'theme stored under @@APP_ID@@.v1'); n++;
await page.reload(); await page.waitForLoadState('networkidle');
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'dark after reload'); n++;
assert.match(await page.locator('#theme').textContent(), /Light/); n++;
await page.click('#theme');
assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(243, 246, 250)'); n++;

// site.json and the health check, as in every deployment
const site = await page.evaluate(async () => (await fetch('site.json', { cache: 'no-store' })).json());
assert.ok(typeof site.version === 'string', 'site.json has a version'); n++;
assert.ok((await page.evaluate(async () => (await fetch('/healthz')).ok)), '/healthz answers'); n++;

// Nothing is loaded from other servers
const foreign = d.requests.filter(u => !u.startsWith(BASE) && !u.startsWith('data:'));
assert.deepEqual(foreign, [], 'no requests to other servers'); n++;
assert.deepEqual(d.errors, [], 'no errors in the browser'); n++;
await d.close();

// ---------------------------------------------------------------- Tablet and phone
for (const [w, h] of [[1000, 800], [390, 844]]) {
  const m = await open({ width: w, height: h });
  assert.ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${w} px`); n++;
  if (w === 390) {
    const r = await box(m.page, '.rail');
    near(r.y, 844 - 60, 'bottom bar at the bottom'); near(r.height, 60, 'bottom bar height'); near(r.width, 390, 'bottom bar width');
    assert.equal(await m.page.locator('.rail .logo').isVisible(), false, 'no logo in the bottom bar'); n++;
    const items = await m.page.locator('.rail > a[data-nav], .rail > #theme').all();
    const widths = await Promise.all(items.map(i => i.boundingBox().then(b => Math.round(b.width))));
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `equal widths in the bottom bar: ${widths}`); n++;
  }
  assert.deepEqual(m.errors, []); n++;
  await m.close();
}

console.log(`blueprint: ${n} checks of the shell passed`);
