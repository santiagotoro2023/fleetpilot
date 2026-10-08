// The example page of @@APP_NAME@@ that uses the API (replace with the app's own checks).
import assert from 'node:assert/strict';
import { open } from '../lib/browser.mjs';

const { page, errors, close } = await open({ path: '#/library' });
let n = 0;
await page.fill('input[aria-label="Title"]', 'From the browser test');
await page.click('button:has-text("Add")');
await page.waitForSelector('.tile h3:text("From the browser test")');
n++;
await page.reload(); await page.waitForSelector('.tile h3:text("From the browser test")');
n++;   // stored on the server, not in the browser
await page.locator('.tile', { hasText: 'From the browser test' }).locator('button:has-text("Delete")').click();
await page.waitForSelector('.tile h3:text("From the browser test")', { state: 'detached' });
n++;
assert.deepEqual(errors, []);
console.log(`items: ${n} checks passed`);
await close();
