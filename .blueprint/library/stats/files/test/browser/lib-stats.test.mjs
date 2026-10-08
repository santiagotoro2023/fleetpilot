// Library element "stats" (blueprint @@BLUEPRINT_VERSION@@): renders with the design tokens in this app.
import assert from 'node:assert/strict';
import { open } from '../lib/browser.mjs';

const { page, errors, close } = await open();
let n = 0;
const s = await page.evaluate(async () => {
  const { statTiles } = await import('/js/lib/stats.js');
  const el = statTiles([{ value: 12, label: 'done' }, { value: '1:24', label: 'best time', state: 'ok' }]);
  document.querySelector('.main').prepend(el);
  const tile = el.querySelector('.stat-tile'), num = tile.querySelector('b');
  const cs = x => getComputedStyle(x);
  return { tiles: el.children.length, radius: cs(tile).borderTopLeftRadius, border: cs(tile).borderTopColor, mono: cs(num).fontFamily, size: cs(num).fontSize, ok: cs(el.children[1].querySelector('b')).color };
});
assert.equal(s.tiles, 2); n++;
assert.equal(s.radius, '6px', 'radius --r-s'); n++;
assert.equal(s.border, 'rgb(211, 220, 231)', 'border --line'); n++;
assert.match(s.mono, /^"?DejaVu Sans Mono/, 'numbers in the mono font'); n++;
assert.equal(s.size, '20.8px', '1.3rem'); n++;
assert.equal(s.ok, 'rgb(31, 157, 104)', 'state ok in --ok'); n++;
assert.deepEqual(errors, []);
console.log(`lib-stats: ${n} checks passed`);
await close();
