// The pages of FleetPilot in a browser, against the app server of test/run.mjs (an empty
// installation, signed in as the test administrator): add a site and hosts, a subnet, build a
// template with the editor, change a workflow, add a secret; every page without errors, also on a phone.
import assert from 'node:assert/strict';
import { open, BASE } from '../lib/browser.mjs';

let n = 0;
const o = await open({ path: '' });
const { page, errors, shot } = o;
const go = async hash => { await page.goto(BASE + hash); await page.waitForLoadState('networkidle'); await page.waitForTimeout(150); };
const dlg = () => page.locator('dialog.dlg[open]');

// ---------------------------------------------------------------- Overview of an empty installation
await go('#/');
assert.equal(await page.locator('.main h1').textContent(), 'Overview'); n++;
assert.equal(await page.locator('.fp-start h2').textContent(), 'Start with your hosts'); n++;
assert.equal(await page.locator('.rail a[data-nav]').count(), 6); n++;
await shot('overview');

// ---------------------------------------------------------------- A site, hosts in it, the map and the table
await go('#/hosts?tab=map');
await page.click('button:has-text("Add a site")');
await dlg().locator('input').first().fill('Datacenter 1');
await dlg().locator('button[type=submit]').click();
await page.waitForSelector('.fp-zone-name:has-text("Datacenter 1")'); n++;
await page.click('.fp-actions button:has-text("Add hosts")');
await dlg().locator('[role=tab]:has-text("A list")').click();
await dlg().locator('textarea').fill('web-01 10.20.0.11\nweb-02 10.20.0.12\ndb-01 10.20.0.21 2222');
await dlg().locator('select').first().selectOption({ label: 'Datacenter 1' });
await dlg().locator('button[type=submit]').click();
await page.waitForSelector('.fp-hostcard');
await page.waitForTimeout(300);
assert.equal(await page.locator('.fp-hostcard').count(), 3); n++;
await page.fill('.fp-find', 'db');
assert.equal(await page.locator('.fp-hostcard.fp-dim').count(), 2, 'the search dims the others'); n++;
await page.locator('.fp-hostcard').first().click({ button: 'right' });
assert.equal(await page.locator('.ctxmenu').count(), 1, 'right-click on a host'); n++;
await page.keyboard.press('Escape');
await shot('hosts-map');
await go('#/hosts?tab=table');
await page.locator('thead input[type=checkbox]').check();
assert.match(await page.locator('.fp-bulk').textContent(), /3 hosts chosen/); n++;
await page.click('a:has-text("web-01")');
await page.waitForSelector('.fp-subhead');
assert.match(await page.locator('.fp-subhead').textContent(), /New/); n++;
await page.click('[role=tab]:has-text("Desired state")');
await page.waitForSelector('text=No template applies to this host yet');
n++;

// ---------------------------------------------------------------- A subnet and its address map
await go('#/network');
await page.click('.fp-actions button:has-text("Add a subnet")');
const sub = dlg().locator('input');
await sub.nth(0).fill('10.20.0.0/24');
await sub.nth(1).fill('Servers');
await sub.nth(2).fill('10.20.0.1');
await dlg().locator('button[type=submit]').click();
await page.waitForSelector('.fp-ipmap');
assert.equal(await page.locator('.fp-ip:not(.fp-legend .fp-ip)').count(), 254); n++;
assert.equal(await page.locator('.fp-ipmap .ip-assigned').count(), 3, 'the hosts\' addresses are recorded'); n++;
assert.equal(await page.locator('.fp-ipmap .ip-gateway').count(), 1); n++;
await shot('subnet');

// ---------------------------------------------------------------- The template editor
await go('#/automate/templates');
assert.ok(await page.locator('.cardgrid a.tile').count() >= 2, 'starter templates'); n++;
await go('#/automate/template/new');
await page.locator('.fp-tpl-names input').first().fill('Zurich');
await page.click('button.addfeat');
await page.fill('.fp-addmenu input', 'time zone');
await page.click('.fp-addmenu .featitem:has-text("Time zone")');
await page.waitForSelector('.fp-setting');
await page.locator('.fp-setting input').first().fill('Europe/Zurich');
await page.waitForFunction(() => document.querySelector('.fp-tpl-side pre')?.textContent.includes('Europe/Zurich'));
n++;
await shot('template');
await page.click('button:has-text("Create the template")');
await page.waitForURL(/#\/automate\/template\/\d+\?tab=usage/);
await page.waitForSelector('text=It applies nowhere yet');
n++;
await page.locator('.fp-assign select').first().selectOption({ label: 'Datacenter 1' });
await page.click('button:has-text("Apply it there")');
await page.waitForSelector('text=Site Datacenter 1');
assert.equal(await page.locator('table').last().locator('tbody tr').count(), 3, 'every host of the site uses it'); n++;

// ---------------------------------------------------------------- The workflow editor
await go('#/automate/workflows');
await page.click('a.tile:has-text("Update packages")');
await page.waitForSelector('.fp-stepcard');
const steps = await page.locator('.fp-stepcard').count();
assert.equal(steps, 2); n++;
await page.click('.fp-wf-steps button.addfeat');
await page.click('.fp-wf-steps .featitem:has-text("Check for drift")');
assert.equal(await page.locator('.fp-stepcard').count(), 3); n++;
assert.equal(await page.locator('.fp-wf-side .fp-side-title').textContent(), 'Check for drift'); n++;
await page.locator('.fp-wf-how select').first().selectOption('schedule');
assert.match(await page.locator('.fp-cron .fp-help').textContent(), /every day at 02:30 UTC/); n++;
await page.click('.fp-head button:has-text("Save")');
await page.waitForSelector('.toast:has-text("Workflow saved")');
await page.waitForSelector('.fp-wf-sentence:has-text("On a schedule")');
n++;
await shot('workflow');

// ---------------------------------------------------------------- The vault and the settings
await go('#/settings/vault');
await page.click('button:has-text("Add a secret")');
await dlg().locator('input').nth(0).fill('Debian install');
await dlg().locator('input.mono').first().fill('admin');
await dlg().locator('input[type=password]').first().fill('install-pw');
await dlg().locator('button[type=submit]').click();
await page.waitForSelector('td:has-text("Debian install")');
n++;
await go('#/settings/ssh');
assert.match(await page.locator('.fp-pubkey').first().textContent(), /^ssh-ed25519 /); n++;
await go('#/settings/roles');
assert.equal(await page.locator('tbody tr').count(), 4); n++;
await go('#/runs');
assert.match(await page.locator('.empty').textContent(), /No runs yet/); n++;

// ---------------------------------------------------------------- Every page, on a phone too
const pages = ['#/', '#/hosts?tab=map', '#/hosts?tab=table', '#/hosts?tab=sources', '#/hosts/1', '#/hosts/1?tab=state', '#/network', '#/network/1', '#/automate/workflows', '#/automate/catalog', '#/automate/template/3', '#/automate/workflow/1', '#/runs', '#/settings/account', '#/settings/vault', '#/settings/accounts', '#/settings/audit'];
for (const p of pages) { await go(p); assert.equal(await page.locator('.main h1').first().textContent() === 'This page could not be opened', false, p); n++; }
assert.deepEqual(errors, []); n++;
await o.close();

const phone = await open({ width: 390, height: 844, colorScheme: 'dark', path: '' });
for (const p of pages) {
  await phone.page.goto(BASE + p); await phone.page.waitForLoadState('networkidle'); await phone.page.waitForTimeout(150);
  const wide = await phone.page.evaluate(() => { const m = document.querySelector('.main'); return m.scrollWidth - m.clientWidth; });
  assert.ok(wide <= 1, `${p}: no sideways scrolling on a phone (${wide} px)`); n++;
}
await phone.shot('phone-workflow');
assert.deepEqual(phone.errors, []); n++;
await phone.close();
console.log(`app: ${n} checks passed`);
