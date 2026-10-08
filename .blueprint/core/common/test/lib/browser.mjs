// Browser helpers for the tests in test/browser/ (Playwright with Chromium).
import { chromium } from 'playwright';
@@IF lib:auth@@
import { signIn } from './auth.mjs';
@@END@@

export const BASE = process.env.BASE || 'http://127.0.0.1:8080/';
export const OUT = process.env.OUT || 'test/.output';

/** A page with error collection: errors[] gets every page error, console error and failed request */
@@IF lib:auth@@
// Signed in as the test administrator (test/lib/auth.mjs); open({ signedIn: false }) for the sign-in page
export async function open({ width = 1440, height = 900, colorScheme = 'light', path = '', signedIn = true } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  if (signedIn) await signIn(context, BASE);
@@ELSE@@
export async function open({ width = 1440, height = 900, colorScheme = 'light', path = '' } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
@@END@@
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  // Chromium reports bodiless answers (204) to fetch() as failed although they arrived: those are fine
  page.on('requestfailed', async r => { if (/favicon/.test(r.url()) || ((await r.response().catch(() => null))?.status() < 400)) return; errors.push(`request failed: ${r.method()} ${r.url()} (${r.failure()?.errorText})`); });
  page.on('request', r => requests.push(r.url()));
  if (path !== null) { await page.goto(BASE + path); await page.waitForLoadState('networkidle'); }
  return { browser, context, page, errors, requests, wait: ms => page.waitForTimeout(ms), shot: name => page.screenshot({ path: `${OUT}/${name}.png` }), close: () => browser.close() };
}

/** Box of the first element matching a selector, rounded to 0.5 px */
export async function box(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  return b && Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v * 2) / 2]));
}
