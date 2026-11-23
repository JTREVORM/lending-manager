/**
 * Photograph the configuration panels the setup walk-through completed.
 *
 * The walk-through performs each step once and is idempotent, so a second run
 * finds the work already done and has nothing left to photograph mid-entry.
 * This script re-opens each panel and fills it with the values that were
 * actually used, so the manual can show a completed form. It **does not
 * submit anything** — the work was done by the walk-through, and these are
 * photographs of the form, not a second attempt at the action.
 *
 *   node docs/POLYTOS-Manuals/04-Demo-Data/config-panels-capture.mjs
 */
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const SHOTS = join(ROOT, 'docs', 'POLYTOS-Manuals', '03-Screenshots');
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

const exe = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(exe) ? exe : chromium.executablePath(),
});

async function signIn(phone) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, locale: 'en-UG', timezoneId: 'Africa/Kampala',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });
  return { context, page };
}

async function pickByName(scope, name, pattern) {
  const select = scope.locator(`select[name="${name}"]`).first();
  for (const option of await select.locator('option').all()) {
    const text = (await option.textContent())?.trim() ?? '';
    const value = await option.getAttribute('value');
    if (value && pattern.test(text)) {
      await select.selectOption(value);
      return text;
    }
  }
  return null;
}

async function shot(page, folder, name, { full = true, mobileFrom } = {}) {
  const file = join(SHOTS, 'Desktop', folder, `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: full });
  process.stdout.write(`  ${folder}/${name}.png\n`);
  if (mobileFrom) {
    const m = join(SHOTS, 'Mobile', folder, `${name}.png`);
    await mkdir(dirname(m), { recursive: true });
    const saved = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}${mobileFrom}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: m, fullPage: false });
    await page.setViewportSize(saved);
    process.stdout.write(`  Mobile/${folder}/${name}.png\n`);
  }
}

const owner = await signIn('+256772900201');   // the second Owner — the approver
const ownerA = await signIn('+256772100101');  // the first Owner — the registrar

// --- the terms-approval panel, completed ----------------------------------
await owner.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await owner.page.waitForTimeout(1500);
const termsForm = owner.page.locator('form')
  .filter({ has: owner.page.locator('[name=termsReference]') }).last();
await pickByName(termsForm, 'providerId', /./);
await termsForm.locator('[name=termsReference]').fill('STB-AGENT-2026-00077');
await termsForm.locator('[name=note]').fill(
  'Signed bank agency agreement, clause 9 commission schedule.');
await owner.page.waitForTimeout(300);
await shot(owner.page, '18-Walkthrough', '16-terms-approve-filled');

// --- the float facility panel, completed ----------------------------------
await owner.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await owner.page.waitForTimeout(1500);
const facForm = owner.page.locator('form').filter({ has: owner.page.locator('[name=limit]') }).first();
await pickByName(facForm, 'providerId', /./);
await facForm.locator('[name=limit]').fill('5000000');
await facForm.locator('[name=reference]').fill('STB-FAC-2026-0011');
await facForm.locator('[name=note]').fill('Facility letter held in the branch safe.');
await owner.page.waitForTimeout(300);
await shot(owner.page, '18-Walkthrough', '18-facility-filled');

// --- the bank agent account panel, completed ------------------------------
await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1500);
const acctForm = ownerA.page.locator('form')
  .filter({ has: ownerA.page.locator('[name=bankAccountNumber]') }).first();
await pickByName(acctForm, 'providerId', /^Stanbic/i);
await pickByName(acctForm, 'branchId', /Masaka/i);
await acctForm.locator('[name=tillName]').fill('masaka-stanbic-1');
await acctForm.locator('[name=label]').fill('Bank agency counter');
await acctForm.locator('[name=agentCode]').fill('STBAG-004418');
await acctForm.locator('[name=bankAccountNumber]').fill('9030000418');
await acctForm.locator('[name=lineMsisdn]').fill('+256772900103');
await acctForm.locator('[name=openedOn]').fill('2026-02-03');
await ownerA.page.waitForTimeout(300);
await shot(ownerA.page, '18-Walkthrough', '21-line-bank-filled');

// --- the service threshold panel, completed -------------------------------
await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1500);
const thrForm = ownerA.page.locator('form')
  .filter({ has: ownerA.page.locator('[name=requiresApprovalAbove]') }).first();
await pickByName(thrForm, 'transactionTypeId', /MTN Mobile Money · MoMo Withdrawal|MoMo Withdrawal/i);
await thrForm.locator('[name=requiresApprovalAbove]').fill('500000');
await thrForm.locator('[name=reason]').fill(
  'Branch policy: a withdrawal above half a million needs a second pair of eyes.');
await ownerA.page.waitForTimeout(300);
await shot(ownerA.page, '18-Walkthrough', '27-threshold-filled');

// --- the money-model correction panel, completed --------------------------
await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1500);
const modelForm = ownerA.page.locator('form')
  .filter({ has: ownerA.page.locator('[name=floatModel]') }).last();
await pickByName(modelForm, 'providerId', /./);
await pickByName(modelForm, 'floatModel', /Electronic float/i);
await modelForm.locator('[name=reason]').fill(
  'The partner advances electronic float to the agent, as MTN and Airtel do.');
await ownerA.page.waitForTimeout(300);
await shot(ownerA.page, '18-Walkthrough', '28-money-model-filled');

// --- the mobile views the manual needs ------------------------------------
for (const [name, url] of [
  ['25-providers-live', '/agency/providers'],
  ['22-lines-after', '/agency/lines'],
  ['12-capital-verified', '/finance/capital'],
]) {
  const file = join(SHOTS, 'Mobile', '18-Walkthrough', `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  const page = await ownerA.context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  process.stdout.write(`  Mobile/18-Walkthrough/${name}.png\n`);
}

await browser.close();
process.stdout.write('done\n');
