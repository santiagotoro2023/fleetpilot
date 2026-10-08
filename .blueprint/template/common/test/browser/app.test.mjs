// The pages of @@APP_NAME@@ (replace these checks with the app's own as it grows).
import assert from 'node:assert/strict';
import { open } from '../lib/browser.mjs';

const { page, errors, shot, close } = await open();
let n = 0;
assert.equal(await page.locator('.hero h1').textContent(), '@@APP_NAME@@'); n++;
assert.ok(await page.locator('.module').count() >= 1, 'the home page lists sections'); n++;
await shot('home');

await page.click('.rail a[data-nav="parts"]'); await page.waitForTimeout(200);
assert.ok(await page.locator('.btn.primary').count() >= 1); n++;
await page.click('button:has-text("Show a toast")');
assert.match(await page.locator('.toast').textContent(), /toast/); n++;
await shot('parts');

await page.click('.rail a[data-nav="work"]'); await page.waitForTimeout(200);
await page.locator('.canvas-wrap').click({ button: 'right', position: { x: 200, y: 200 } });
assert.equal(await page.locator('.ctxmenu').count(), 1, 'right-click menu in the work area'); n++;
await page.keyboard.press('Escape');

assert.deepEqual(errors, []);
console.log(`app: ${n} checks passed`);
await close();
