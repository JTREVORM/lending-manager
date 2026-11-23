/**
 * Re-photograph the figures the manuals embed, at a size a page can carry.
 *
 * The walk-through scripts capture whole pages, which is right for an
 * evidence library — a providers screen is sixteen thousand pixels tall and
 * every one of them is real. It is wrong for a figure: reduced to the width of
 * an A4 column, a page that tall is a grey sliver.
 *
 * So this re-takes the same screens two ways:
 *
 *   * a **panel** photograph, scoped to the form the text is describing, for
 *     every figure that shows something being filled in;
 *   * a **viewport** photograph at 1440 x 900, for every figure that shows a
 *     screen as a whole.
 *
 * The whole-page originals are kept beside them as `<name>.fullpage.png`, so
 * nothing is lost and anything the frame cut off can still be checked.
 *
 *   node docs/POLYTOS-Manuals/04-Demo-Data/refine-figures.mjs
 */
import { chromium } from '@playwright/test';
import { existsSync, renameSync } from 'node:fs';
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
    if (value && pattern.test(text)) { await select.selectOption(value); return text; }
  }
  return null;
}

/** Keep the whole-page original, then write the new figure in its place. */
async function place(folder, name, take) {
  const file = join(SHOTS, 'Desktop', folder, `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  const keep = join(SHOTS, 'Desktop', folder, `${name}.fullpage.png`);
  if (existsSync(file) && !existsSync(keep)) renameSync(file, keep);
  await take(file);
  process.stdout.write(`  ${folder}/${name}.png\n`);
}

/** Photograph one form, with a little room around it. */
async function panel(page, url, locate, folder, name) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const form = await locate(page);
  await form.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await place(folder, name, (file) => form.screenshot({ path: file }));
}

/** Photograph a screen as it first appears, at laptop size. */
async function viewport(page, url, folder, name) {
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForTimeout(1200);
  await place(folder, name, (file) => page.screenshot({ path: file, fullPage: false }));
}

const A = await signIn('+256772100101');  // Owner A — registers
const B = await signIn('+256772900201');  // Owner B — approves
const M = await signIn('+256772100102');  // Manager
const S = await signIn('+256772100103');  // Secretary / Treasurer

const byField = (p, field) =>
  p.locator('form').filter({ has: p.locator(`[name=${field}]`) }).first();
const byFieldLast = (p, field) =>
  p.locator('form').filter({ has: p.locator(`[name=${field}]`) }).last();

// ---------------------------------------------------------------------------
// 1. Panels — the forms the text walks the reader through
// ---------------------------------------------------------------------------

// Capital, completed. Filling it is not submitting it; the contribution this
// manual documents was recorded earlier and is already verified.
await panel(A.page, '/finance/capital', async (p) => {
  const f = byField(p, 'funderName');
  await pickByName(f, 'fundingKind', /owner|equity|own money/i);
  await f.locator('[name=amount]').fill('20000000');
  await f.locator('[name=funderName]').fill('Nalubega Sarah Kiwanuka');
  await pickByName(f, 'destinationAccountId', /Cash at Hand.*Mbarara/i);
  await f.locator('[name=fundedOn]').fill('2026-02-02');
  await pickByName(f, 'evidenceKind', /bank transfer/i);
  await f.locator('[name=evidenceReference]').fill('CENT/TT/2026/000417');
  await f.locator('[name=description]').fill('Opening capital for the Mbarara branch.');
  return f;
}, '18-Walkthrough', '08-capital-filled');

// Provider registration, completed.
await panel(A.page, '/agency/providers', async (p) => {
  const f = byField(p, 'code');
  await f.locator('[name=code]').fill('CENTENARY');
  await f.locator('[name=name]').fill('Centenary Bank Agency');
  await pickByName(f, 'category', /bank/i);
  await pickByName(f, 'floatModel', /advances electronic float/i);
  await pickByName(f, 'commissionModel', /remits it/i);
  await pickByName(f, 'commissionSource', /terms recorded here/i);
  await f.locator('[name=commissionRateBps]').fill('0.90');
  await f.locator('[name=termsReference]').fill('CERU-AGENT-2026-00231');
  return f;
}, '18-Walkthrough', '14-provider-register-filled');

// Terms approval, completed.
await panel(B.page, '/agency/providers', async (p) => {
  const f = byField(p, 'termsReference');
  const g = p.locator('form').filter({ has: p.locator('[name=note]') })
    .filter({ has: p.locator('[name=termsReference]') }).first();
  const form = (await g.count()) > 0 ? g : f;
  await pickByName(form, 'providerId', /./);
  await form.locator('[name=termsReference]').fill('STB-AGENT-2026-00077');
  await form.locator('[name=note]').fill(
    'Signed bank agency agreement, clause 9 commission schedule.');
  return form;
}, '18-Walkthrough', '16-terms-approve-filled');

// Float facility, completed.
await panel(B.page, '/agency/providers', async (p) => {
  const f = byField(p, 'limit');
  await pickByName(f, 'providerId', /./);
  await f.locator('[name=limit]').fill('5000000');
  await f.locator('[name=reference]').fill('STB-FAC-2026-0011');
  await f.locator('[name=note]').fill('Facility letter held in the branch safe.');
  return f;
}, '18-Walkthrough', '18-facility-filled');

// An MTN agent line, completed.
await panel(A.page, '/agency/providers', async (p) => {
  const f = byField(p, 'tillName');
  await pickByName(f, 'providerId', /^MTN Mobile Money$/i);
  await pickByName(f, 'branchId', /Masaka/i);
  await f.locator('[name=tillName]').fill('masaka-mtn-1');
  await f.locator('[name=label]').fill('MTN counter');
  await f.locator('[name=agentCode]').fill('MTNAG-900121');
  await f.locator('[name=lineMsisdn]').fill('+256772900121');
  await f.locator('[name=openedOn]').fill('2026-04-14');
  return f;
}, '18-Walkthrough', '20-line-mtn-filled');

// A bank agent account, completed.
await panel(A.page, '/agency/providers', async (p) => {
  const f = byField(p, 'bankAccountNumber');
  await pickByName(f, 'providerId', /^Stanbic/i);
  await pickByName(f, 'branchId', /Masaka/i);
  await f.locator('[name=tillName]').fill('masaka-stanbic-1');
  await f.locator('[name=label]').fill('Bank agency counter');
  await f.locator('[name=agentCode]').fill('STBAG-004418');
  await f.locator('[name=bankAccountNumber]').fill('9030000418');
  await f.locator('[name=lineMsisdn]').fill('+256772900103');
  await f.locator('[name=openedOn]').fill('2026-04-14');
  return f;
}, '18-Walkthrough', '21-line-bank-filled');

// A service ceiling, completed.
await panel(A.page, '/agency/lines', async (p) => {
  const f = byField(p, 'maxSingleTransaction');
  await pickByName(f, 'transactionTypeId', /MoMo Deposit/i);
  await f.locator('[name=maxSingleTransaction]').fill('2000000');
  await f.locator('[name=reason]').fill('Agreed ceiling in the signed schedule.');
  return f;
}, '18-Walkthrough', '26-ceiling-filled');

// An approval threshold, completed.
await panel(A.page, '/agency/providers', async (p) => {
  const f = byField(p, 'requiresApprovalAbove');
  await pickByName(f, 'transactionTypeId', /MoMo Withdrawal/i);
  await f.locator('[name=requiresApprovalAbove]').fill('500000');
  await f.locator('[name=reason]').fill(
    'Branch policy: a withdrawal above half a million needs a second pair of eyes.');
  return f;
}, '18-Walkthrough', '27-threshold-filled');

// The money-model correction, completed.
await panel(A.page, '/agency/providers', async (p) => {
  const f = byFieldLast(p, 'floatModel');
  await pickByName(f, 'providerId', /./);
  await pickByName(f, 'floatModel', /Electronic float/i);
  await f.locator('[name=reason]').fill(
    'The partner advances electronic float to the agent, as MTN and Airtel do.');
  return f;
}, '18-Walkthrough', '28-money-model-filled');

// A new staff account, completed.
await panel(A.page, '/users/new', async (p) => {
  const f = byField(p, 'fullName');
  await f.locator('[name=fullName]').fill('Kabugho Janet Biira');
  await f.locator('[name=phone]').fill('+256772900205');
  await f.locator('[name=email]').fill('j.kabugho@polytos-demo.invalid');
  await pickByName(f, 'roleKey', /Manager/i);
  await f.locator('[name=temporaryPassword]').fill('Polytos#Setup2026');
  return f;
}, '18-Walkthrough', '02-users-new-filled');

// Banking cash, completed.
await panel(M.page, '/finance/deposits', async (p) => {
  const f = byField(p, 'bankAccountId');
  await pickByName(f, 'fromAccountId', /Cash at Hand — Mbarara/i);
  await pickByName(f, 'bankAccountId', /Cash at Bank — Mbarara/i);
  await f.locator('[name=amount]').fill('5000000');
  await f.locator('[name=description]').fill(
    'Opening allocation to the Centenary operating account.');
  return f;
}, '19-Operations', '03-bank-deposit-filled');

// A float top-up, completed.
await panel(A.page, '/agency/float/replenish', async (p) => {
  const f = byField(p, 'floatAccountId');
  await pickByName(f, 'floatAccountId', /MTN Mobile Money — mbarara-mtn-1/i);
  await f.locator('[name=amount]').fill('3000000');
  await pickByName(f, 'fundingAccountId', /Cash at Hand — Mbarara/i);
  await f.locator('[name=reference]').fill('MTN/FLT/2026/0101');
  return f;
}, '19-Operations', '09-float-replenish-filled');

// A counter transaction, completed.
await panel(S.page, '/agency/record', async (p) => {
  const f = byField(p, 'transactionTypeId');
  await pickByName(f, 'branchId', /Mbarara/i);
  await p.waitForTimeout(700);
  await pickByName(f, 'transactionTypeId', /^MTN Mobile Money — MoMo Deposit/i);
  await f.locator('[name=principalAmount]').fill('200000');
  await f.locator('[name=customerIdentifier]').fill('+256772113344');
  const nm = f.locator('[name=customerName]');
  if (await nm.count() > 0) await nm.fill('Nakimuli Zainabu');
  await f.locator('[name=providerReference]').fill('MP2602031004');
  await f.locator('[name=description]').fill('Cash in to a customer wallet.');
  return f;
}, '19-Operations', '12-D1-record-filled');

// A bank agency transaction, completed.
await panel(S.page, '/agency/record', async (p) => {
  const f = byField(p, 'transactionTypeId');
  await pickByName(f, 'branchId', /Mbarara/i);
  await p.waitForTimeout(700);
  await pickByName(f, 'transactionTypeId', /^Stanbic Bank Agency — Bank Agency Deposit/i);
  await f.locator('[name=principalAmount]').fill('400000');
  await f.locator('[name=customerIdentifier]').fill('9030112233');
  const nm = f.locator('[name=customerName]');
  if (await nm.count() > 0) await nm.fill('Atuhaire Peace Kembabazi');
  await f.locator('[name=providerReference]').fill('STB2602031005');
  await f.locator('[name=description]').fill(
    'Customer pays into their bank account at the counter.');
  return f;
}, '19-Operations', '12-A1-record-filled');

// ---------------------------------------------------------------------------
// 2. Viewports — the screens shown as a whole
// ---------------------------------------------------------------------------
const VIEWPORTS = [
  [A, '/users', '18-Walkthrough', '04-users-directory'],
  [A, '/finance/capital', '18-Walkthrough', '07-capital-empty'],
  [B, '/finance/capital', '18-Walkthrough', '10-capital-awaiting-check'],
  [A, '/finance/capital', '18-Walkthrough', '12-capital-verified'],
  [A, '/agency/providers', '18-Walkthrough', '13-providers-before'],
  [B, '/agency/providers', '18-Walkthrough', '17-providers-after-terms'],
  [A, '/agency/providers', '18-Walkthrough', '25-providers-live'],
  [A, '/agency/lines', '18-Walkthrough', '19-lines-before'],
  [A, '/agency/lines', '18-Walkthrough', '22-lines-after'],
  [A, '/agency/banking/accounts', '18-Walkthrough', '23-banking-accounts'],
  [A, '/agency/staffing?category=mobile_money', '19-Operations', '01-staffing-mobile-money'],
  [M, '/finance/deposits', '19-Operations', '02-bank-deposit-before'],
  [B, '/finance/deposits', '19-Operations', '05-bank-deposit-awaiting'],
  [B, '/finance/deposits', '19-Operations', '07-bank-deposit-cleared'],
  [A, '/agency/float/replenish', '19-Operations', '08-float-replenish-before'],
  [A, '/agency/float', '19-Operations', '10-float-replenish-done'],
  [S, '/agency/record', '19-Operations', '11-D1-record-before'],
  [S, '/agency/record', '19-Operations', '11-A1-record-before'],
  [M, '/agency/pending', '19-Operations', '15-D1-pending'],
  [A, '/agency/float', '19-Operations', '18-float-balances'],
  [A, '/agency/commission', '19-Operations', '19-commission'],
  [M, '/agency/history', '19-Operations', '20-history'],
  [A, '/agency/money/MTN_MOMO', '19-Operations', '21-money-mtn'],
  [A, '/agency/money/AIRTEL_MONEY', '19-Operations', '22-money-airtel'],
  [A, '/agency/banking', '19-Operations', '23-banking-overview'],
  [A, '/finance', '19-Operations', '24-cash-position'],
  [A, '/finance/trial-balance', '19-Operations', '25-trial-balance'],
  [A, '/finance/ledger', '19-Operations', '26-ledger'],
  [A, '/agency/reports', '19-Operations', '27-agency-reports'],
  [M, '/agency/reconciliation/cash', '19-Operations', '28-reconciliation-cash'],
  [M, '/agency/reconciliation/float', '19-Operations', '29-reconciliation-float'],
  [A, '/audit', '19-Operations', '30-audit'],
];
for (const [who, url, folder, name] of VIEWPORTS) {
  await viewport(who.page, url, folder, name);
}

// Deliberately NOT re-taken:
//
//   15-provider-rate-refused   shows a refusal that cannot be re-staged
//   13/14/16/17-*              show one transaction at one point in its life
//   06-bank-deposit-verify-*   shows a clearance that has since happened
//   03-users-new-result        shows an account being created
//   05/06-forced-password-*    show a first sign-in that happens once
//
// Each of those is evidence of a state the system passed through, and the
// whole-page original is what the manual embeds. None of them is taller than
// about one screen and a half, so they carry at A4 width without cropping.

await browser.close();
process.stdout.write('done\n');
