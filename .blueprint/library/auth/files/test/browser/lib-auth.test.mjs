// Library element "auth" (blueprint @@BLUEPRINT_VERSION@@): the sign-in page and the account view in this app.
import assert from 'node:assert/strict';
import { open } from '../lib/browser.mjs';
import { TEST_USER } from '../lib/auth.mjs';

let n = 0;
// Signed in (test/lib/browser.mjs did it): the rail is complete
const a = await open();
assert.ok(await a.page.locator('.rail > a[data-nav]').first().isVisible()); n++;
const acc = await a.page.evaluate(async () => {
  const { accountView } = await import('/js/lib/auth.js');
  const main = document.querySelector('.main'); main.innerHTML = '';
  const div = document.createElement('div'); div.className = 'page'; main.append(div);
  accountView(div);
  await new Promise(r => setTimeout(r, 400));
  return { h2: [...div.querySelectorAll('h2')].map(x => x.textContent), sessions: div.querySelectorAll('.auth-sessions tbody tr').length };
});
assert.ok(acc.h2.includes('Password') && acc.h2.includes('Two-factor sign-in')); n++;
assert.ok(acc.sessions >= 1, 'the own sessions are listed'); n++;
assert.deepEqual(a.errors, []); n++;
await a.close();

// Signed out: the sign-in page, the rail without entries, a wrong password, then signing in
const o = await open({ signedIn: false });
const { page } = o;
await page.waitForSelector('.auth-page h1');
assert.equal(await page.locator('.auth-page h1').textContent(), 'Sign in'); n++;
assert.equal(await page.locator('.rail > a[data-nav]').first().isVisible(), false, 'no menu entries while signed out'); n++;
assert.equal(await page.locator('.rail > #theme').isVisible(), true, 'the theme button stays'); n++;
const btn = await page.locator('.auth-form .btn.primary').boundingBox();
assert.ok(Math.abs(btn.height - 33.5) <= 1, `button height ${btn.height}`); n++;
await page.fill('input[name=username]', TEST_USER.username);
await page.fill('input[name=password]', 'not the password at all');
await page.click('.auth-form .btn.primary');
await page.waitForSelector('.feedback.bad:not(.hidden)');
assert.match(await page.locator('.feedback.bad').textContent(), /wrong/); n++;
assert.deepEqual(o.errors.filter(e => !/401/.test(e)), []); n++;
await o.close();
console.log(`lib-auth: ${n} checks passed`);
