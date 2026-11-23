/**
 * Phase two of the demonstration: allocating the capital, and trading on it.
 *
 * Runs after `administrator-setup-walkthrough.mjs`, which leaves MTN, Airtel
 * and Stanbic configured and live at Mbarara with an agent account each and
 * UGX 20,000,000 of cash at hand. This script spends that cash the way a new
 * branch does, then puts real transactions through the counter, photographing
 * the before and after of each.
 *
 *   node docs/POLYTOS-Manuals/04-Demo-Data/operations-walkthrough.mjs
 *
 * The allocation, which the Administrator Manual's Chapter 5 quotes:
 *
 *   Cash at Hand — Mbarara        20,000,000   (the whole contribution)
 *     → Cash at Bank — Mbarara     5,000,000
 *     → MTN float — Mbarara        3,000,000
 *     → Airtel float — Mbarara     2,000,000
 *     → Stanbic agent float        2,000,000
 *     leaving Cash at Hand         8,000,000
 *
 * Nothing here is faked. A step the application refuses is recorded with the
 * refusal and the manual says so.
 */
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const SHOTS = join(ROOT, 'docs', 'POLYTOS-Manuals', '03-Screenshots');
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

const OWNER_A = '+256772100101';
const OWNER_B = '+256772900201';
const MANAGER = '+256772100102';
const SECRETARY = '+256772100103';

const db = new Client({
  connectionString:
    process.env.E2E_DATABASE_URL ?? 'postgresql://lending@127.0.0.1:5433/lending_e2e',
});
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0];

const steps = [];
const ledger = [];
const record = (id, what, status, detail) => {
  steps.push({ id, what, status, detail });
  const tag = { done: 'OK   ', 'done-without-screen': 'OK*  ', blocked: 'HALT ' }[status];
  process.stdout.write(`${tag}${id}  ${what}${detail ? ` — ${detail}` : ''}\n`);
};
const UGX = (n) => Number(n).toLocaleString('en-UG');

const CODES = {
  cash: '1010-BR2602',
  bank: '1040-BR2602',
  mtn: '1320.MTN_MOMO.BR2602.T1',
  airtel: '1320.AIRTEL_MONEY.BR2602.T1',
  stanbic: '1320.STANBIC.BR2602.T1',
  equity: '3000',
  commissionReceivable: '1310',
  momoCommission: '4510',
  bankCommission: '4520',
};

const balance = async (code) =>
  Number((await one(
    `select coalesce(balance, 0) as b from public.ledger_account_balances where code = $1`,
    [code]))?.b ?? 0);

async function snapshot(label) {
  const out = { label };
  for (const [k, code] of Object.entries(CODES)) out[k] = await balance(code);
  ledger.push(out);
  process.stdout.write(`     [${label}]  cash ${UGX(out.cash)} · bank ${UGX(out.bank)} · `
    + `mtn ${UGX(out.mtn)} · airtel ${UGX(out.airtel)} · stanbic ${UGX(out.stanbic)}\n`);
  return out;
}

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

async function pick(scope, labelPattern, textPattern) {
  const select = scope.getByLabel(labelPattern).first();
  const options = await select.locator('option').all();
  const seen = [];
  for (const option of options) {
    const text = (await option.textContent())?.trim() ?? '';
    const value = await option.getAttribute('value');
    seen.push(text);
    if (value && textPattern.test(text)) {
      await select.selectOption(value);
      return text;
    }
  }
  throw new Error(`no option matching ${textPattern} — saw: ${seen.join(' | ') || '(none)'}`);
}

async function pickByName(scope, name, textPattern) {
  const select = scope.locator(`select[name="${name}"]`).first();
  const options = await select.locator('option').all();
  const seen = [];
  for (const option of options) {
    const text = (await option.textContent())?.trim() ?? '';
    const value = await option.getAttribute('value');
    seen.push(text);
    if (value && textPattern.test(text)) {
      await select.selectOption(value);
      return text;
    }
  }
  throw new Error(`no [name=${name}] option matching ${textPattern} — saw: ${seen.join(' | ')}`);
}

async function shot(page, name, { full = false } = {}) {
  const file = join(SHOTS, 'Desktop', '19-Operations', `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: full });
}

async function mobileShot(context, url, name) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForTimeout(600);
  const file = join(SHOTS, 'Mobile', '19-Operations', `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
}

const ownerA = await signIn(OWNER_A);
const ownerB = await signIn(OWNER_B);
const manager = await signIn(MANAGER);
const secretary = await signIn(SECRETARY);

await snapshot('start');

// ===========================================================================
// 1. Authorise the counter staff on the three tills
// ===========================================================================
const TILLS = [
  { code: 'MTN_MOMO', till: 'mbarara-mtn-1', category: 'mobile_money' },
  { code: 'AIRTEL_MONEY', till: 'mbarara-airtel-1', category: 'mobile_money' },
  { code: 'STANBIC', till: 'mbarara-stanbic-1', category: 'agency_banking' },
];
const STAFF = ['Namirembe Grace Atim', 'Okello Daniel Omara'];

for (const t of TILLS) {
  const account = await one(
    `select a.id from public.agency_provider_float_accounts a
       join public.agency_service_providers p on p.id = a.provider_id
      where p.code = $1 and a.till_name = $2`, [t.code, t.till]);
  if (account === undefined) {
    record(`T-${t.code}`, 'Authorise staff on the till', 'blocked', 'till not found');
    continue;
  }
  for (const person of STAFF) {
    const profile = await one(`select id from public.profiles where full_name = $1`, [person]);
    const held = await one(
      `select id from public.agency_account_staff
        where float_account_id = $1 and profile_id = $2 and revoked_at is null`,
      [account.id, profile.id]);
    if (held !== undefined) continue;
    try {
      await db.query('begin');
      await db.query(
        `select set_config('request.jwt.claim.sub',
           (select auth_user_id::text from public.profiles where phone = $1), true)`, [OWNER_A]);
      await db.query('set local role authenticated');
      await db.query(`select public.assign_agency_account_staff($1, $2, $3)`,
        [account.id, profile.id, 'Branch mandate, Mbarara.']);
      await db.query('commit');
    } catch (error) {
      await db.query('rollback').catch(() => undefined);
      record(`T-${t.code}-${person}`, 'Authorise staff on the till', 'blocked',
        error.message.split('\n')[0]);
    }
  }
  const n = Number((await one(
    `select count(*) as n from public.agency_account_staff
      where float_account_id = $1 and revoked_at is null`, [account.id])).n);
  record(`T-${t.code}`, 'Authorise staff on the till', n > 0 ? 'done' : 'blocked',
    `${n} authorised on ${t.till}`);
}

await ownerA.page.goto(`${BASE}/agency/staffing?category=mobile_money`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1200);
await shot(ownerA.page, '01-staffing-mobile-money', { full: true });
await mobileShot(ownerA.context, '/agency/staffing?category=mobile_money', '01-staffing-mobile-money');

// ===========================================================================
// 2. Bank UGX 5,000,000 of the opening cash
// ===========================================================================
const before2 = await snapshot('before banking');
const bankedAlready = await one(`select id from public.bank_deposits limit 1`);
if (bankedAlready === undefined) {
  try {
    await manager.page.goto(`${BASE}/finance/deposits`, { waitUntil: 'domcontentloaded' });
    await manager.page.waitForTimeout(1200);
    await shot(manager.page, '02-bank-deposit-before', { full: true });
    const form = manager.page.locator('form').filter({ has: manager.page.locator('[name=bankAccountId]') }).first();
    await pickByName(form, 'fromAccountId', /Cash at Hand — Mbarara/i);
    await pickByName(form, 'bankAccountId', /Cash at Bank — Mbarara/i);
    await form.locator('[name=amount]').fill('5000000');
    await form.locator('[name=description]').fill('Opening allocation to the Centenary operating account.');
    await manager.page.waitForTimeout(300);
    await shot(manager.page, '03-bank-deposit-filled', { full: true });
    await form.getByRole('button', { name: /record deposit/i }).first().click();
    await manager.page.waitForTimeout(3000);
    await shot(manager.page, '04-bank-deposit-recorded', { full: true });

    const dep = await one(
      `select id, deposit_number, amount, status from public.bank_deposits order by created_at desc limit 1`);
    record('M1', 'Bank UGX 5,000,000 of the opening cash', dep ? 'done' : 'blocked',
      dep ? `${dep.deposit_number} · ${UGX(dep.amount)} · ${dep.status}` : 'no deposit was written');

    // A second person confirms the money reached the bank.
    if (dep !== undefined && dep.status !== 'cleared') {
      await ownerB.page.goto(`${BASE}/finance/deposits`, { waitUntil: 'domcontentloaded' });
      await ownerB.page.waitForTimeout(1200);
      await shot(ownerB.page, '05-bank-deposit-awaiting', { full: true });
      const vform = ownerB.page.locator('form').filter({ has: ownerB.page.locator('[name=bankReference]') }).first();
      if (await vform.count() > 0) {
        await vform.locator('[name=bankReference]').fill('CERU/DEP/2026/0099');
        const vdate = vform.locator('[name=bankValueDate]');
        const businessDate = (await one(`select public.business_date() as d`)).d
          .toISOString().slice(0, 10);
        if (await vdate.count() > 0) await vdate.fill(businessDate);
        await ownerB.page.waitForTimeout(250);
        await shot(ownerB.page, '06-bank-deposit-verify-filled', { full: true });
        await vform.getByRole('button').first().click();
        await ownerB.page.waitForTimeout(3000);
        await shot(ownerB.page, '07-bank-deposit-cleared', { full: true });
      }
      const after = await one(
        `select deposit_number, status from public.bank_deposits where id = $1`, [dep.id]);
      record('M2', 'A second person confirms the money reached the bank',
        after.status === 'cleared' ? 'done' : 'blocked',
        `${after.deposit_number} · ${after.status}`);
    }
  } catch (error) {
    record('M1', 'Bank UGX 5,000,000 of the opening cash', 'blocked', error.message.split('\n')[0]);
  }
} else {
  record('M1', 'Bank UGX 5,000,000 of the opening cash', 'done', 'already banked on an earlier run');
}
await snapshot('after banking');

// ===========================================================================
// 3. Fund the three floats out of the remaining cash
// ===========================================================================
const FLOATS = [
  { key: 'mtn', till: /MTN Mobile Money — mbarara-mtn-1/i, amount: 3_000_000, ref: 'MTN/FLT/2026/0101' },
  { key: 'airtel', till: /Airtel Money — mbarara-airtel-1/i, amount: 2_000_000, ref: 'AIR/FLT/2026/0102' },
  { key: 'stanbic', till: /Stanbic Bank Agency — mbarara-stanbic-1/i, amount: 2_000_000, ref: 'STB/FLT/2026/0103' },
];

for (const f of FLOATS) {
  if (await balance(CODES[f.key]) >= f.amount) {
    record(`M3-${f.key}`, 'Fund the float out of cash', 'done', 'already funded');
    continue;
  }
  try {
    await ownerA.page.goto(`${BASE}/agency/float/replenish`, { waitUntil: 'domcontentloaded' });
    await ownerA.page.waitForTimeout(1300);
    if (f.key === 'mtn') {
      await shot(ownerA.page, '08-float-replenish-before', { full: true });
      await mobileShot(ownerA.context, '/agency/float/replenish', '08-float-replenish-before');
    }
    const form = ownerA.page.locator('form').filter({ has: ownerA.page.locator('[name=floatAccountId]') }).first();
    await pickByName(form, 'floatAccountId', f.till);
    await form.locator('[name=amount]').fill(String(f.amount));
    await pickByName(form, 'fundingAccountId', /Cash at Hand — Mbarara/i);
    await form.locator('[name=reference]').fill(f.ref);
    await ownerA.page.waitForTimeout(300);
    if (f.key === 'mtn') await shot(ownerA.page, '09-float-replenish-filled', { full: true });
    await form.getByRole('button', { name: /record top-up/i }).first().click();
    await ownerA.page.waitForTimeout(3200);
    if (f.key === 'mtn') await shot(ownerA.page, '10-float-replenish-done', { full: true });
    const got = await balance(CODES[f.key]);
    record(`M3-${f.key}`, 'Fund the float out of cash', got >= f.amount ? 'done' : 'blocked',
      `${CODES[f.key]} holds ${UGX(got)}`);
  } catch (error) {
    record(`M3-${f.key}`, 'Fund the float out of cash', 'blocked', error.message.split('\n')[0]);
  }
}

const allocated = await snapshot('after allocation');

// ===========================================================================
// 4. Trade: a MoMo deposit, a MoMo withdrawal, a bank agency deposit
// ===========================================================================
const TRADES = [
  { id: 'D1', service: /^MTN Mobile Money — MoMo Deposit/i, amount: 200_000,
    customer: '+256772113344', name: 'Nakimuli Zainabu', ref: 'MP2602031001',
    note: 'Cash in to a customer wallet.', shots: true },
  { id: 'W1', service: /^MTN Mobile Money — MoMo Withdrawal/i, amount: 150_000,
    customer: '+256772114455', name: 'Tumusiime Fred Bagonza', ref: 'MP2602031002',
    note: 'Cash out of a customer wallet.', shots: false },
  { id: 'A1', service: /^Stanbic Bank Agency — Bank Agency Deposit/i, amount: 400_000,
    customer: '9030112233', name: 'Atuhaire Peace Kembabazi', ref: 'STB2602031003',
    note: 'Customer pays into their bank account at the counter.', shots: true },
];

for (const t of TRADES) {
  const existing = await one(
    `select id, status from public.agency_transactions where provider_reference = $1`, [t.ref]);
  if (existing !== undefined && existing.status === 'posted') {
    record(t.id, 'Record and verify a counter transaction', 'done', 'already posted');
    continue;
  }
  const beforeT = await snapshot(`before ${t.id}`);
  try {
    if (existing === undefined) {
    await secretary.page.goto(`${BASE}/agency/record`, { waitUntil: 'domcontentloaded' });
    await secretary.page.waitForTimeout(1300);
    if (t.shots) {
      await shot(secretary.page, `11-${t.id}-record-before`, { full: true });
      await mobileShot(secretary.context, '/agency/record', `11-${t.id}-record-before`);
    }
    const form = secretary.page.locator('form').filter({ has: secretary.page.locator('[name=transactionTypeId]') }).first();
    await pickByName(form, 'branchId', /Mbarara/i);
    await secretary.page.waitForTimeout(700);
    await pickByName(form, 'transactionTypeId', t.service);
    await form.locator('[name=principalAmount]').fill(String(t.amount));
    await form.locator('[name=customerIdentifier]').fill(t.customer);
    const nameBox = form.locator('[name=customerName]');
    if (await nameBox.count() > 0) await nameBox.fill(t.name);
    await form.locator('[name=providerReference]').fill(t.ref);
    await form.locator('[name=description]').fill(t.note);
    await secretary.page.waitForTimeout(300);
    if (t.shots) await shot(secretary.page, `12-${t.id}-record-filled`, { full: true });
    await form.getByRole('button', { name: /record transaction/i }).first().click();
    await secretary.page.waitForTimeout(3200);
    if (t.shots) await shot(secretary.page, `13-${t.id}-recorded`, { full: true });

    }
    let txn = await one(
      `select id, provider_reference, status from public.agency_transactions where provider_reference = $1`,
      [t.ref]);
    if (txn === undefined) {
      record(t.id, 'Record a counter transaction', 'blocked',
        (await secretary.page.locator('[role=alert]').allTextContents()).join(' | ').slice(0, 200));
      continue;
    }

    // Submit it for verification if it is still a draft.
    if (txn.status === 'draft') {
      await secretary.page.goto(`${BASE}/agency/history/${txn.id}`, { waitUntil: 'domcontentloaded' });
      await secretary.page.waitForTimeout(1200);
      if (t.shots) await shot(secretary.page, `14-${t.id}-draft`, { full: true });
      const submit = secretary.page.getByRole('button', { name: /send for verification/i }).first();
      if (await submit.count() > 0) { await submit.click(); await secretary.page.waitForTimeout(2800); }
      txn = await one(`select id, provider_reference, status from public.agency_transactions where id = $1`, [txn.id]);
    }

    // A Manager verifies it, and that is what posts it.
    if (txn.status === 'awaiting_verification') {
      await manager.page.goto(`${BASE}/agency/pending`, { waitUntil: 'domcontentloaded' });
      await manager.page.waitForTimeout(1300);
      if (t.shots) {
        await shot(manager.page, `15-${t.id}-pending`, { full: true });
        await mobileShot(manager.context, '/agency/pending', `15-${t.id}-pending`);
      }
      await manager.page.goto(`${BASE}/agency/history/${txn.id}`, { waitUntil: 'domcontentloaded' });
      await manager.page.waitForTimeout(1200);
      if (t.shots) await shot(manager.page, `16-${t.id}-awaiting`, { full: true });
      const verify = manager.page.getByRole('button', { name: /^verify/i }).first();
      if (await verify.count() > 0) { await verify.click(); await manager.page.waitForTimeout(3200); }
      if (t.shots) await shot(manager.page, `17-${t.id}-posted`, { full: true });
      txn = await one(
        `select provider_reference, status, principal_amount, commission_amount
           from public.agency_transactions where id = $1`, [txn.id]);
    }

    const afterT = await snapshot(`after ${t.id}`);
    record(t.id, 'Record and verify a counter transaction',
      txn.status === 'posted' ? 'done' : 'blocked',
      `${txn.provider_reference} · ${txn.status} · principal ${UGX(t.amount)}`
      + ` · cash ${UGX(beforeT.cash)} → ${UGX(afterT.cash)}`
      + ` · float ${UGX(beforeT[t.id.startsWith('A') ? 'stanbic' : 'mtn'])}`
      + ` → ${UGX(afterT[t.id.startsWith('A') ? 'stanbic' : 'mtn'])}`);
  } catch (error) {
    record(t.id, 'Record and verify a counter transaction', 'blocked', error.message.split('\n')[0]);
  }
}

const final = await snapshot('final');

// ===========================================================================
// 5. The screens that show the result
// ===========================================================================
for (const [name, url, who] of [
  ['18-float-balances', '/agency/float', ownerA],
  ['19-commission', '/agency/commission', ownerA],
  ['20-history', '/agency/history', manager],
  ['21-money-mtn', '/agency/money/MTN_MOMO', ownerA],
  ['22-money-airtel', '/agency/money/AIRTEL_MONEY', ownerA],
  ['23-banking-overview', '/agency/banking', ownerA],
  ['24-cash-position', '/finance', ownerA],
  ['25-trial-balance', '/finance/trial-balance', ownerA],
  ['26-ledger', '/finance/ledger', ownerA],
  ['27-agency-reports', '/agency/reports', ownerA],
  ['28-reconciliation-cash', '/agency/reconciliation/cash', manager],
  ['29-reconciliation-float', '/agency/reconciliation/float', manager],
  ['30-audit', '/audit', ownerA],
]) {
  try {
    await who.page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
    await who.page.waitForTimeout(1300);
    await shot(who.page, name, { full: true });
    await shot(who.page, `${name}-viewport`);
    await mobileShot(who.context, url, name);
  } catch (error) {
    record(name, `Photograph ${url}`, 'blocked', error.message.split('\n')[0]);
  }
}

// --- the trial balance, as proof --------------------------------------------
const tb = await one(
  `select sum(case when account_type in ('asset','expense') then balance else 0 end) as debits,
          sum(case when account_type in ('liability','equity','income') then balance else 0 end) as credits
     from public.ledger_account_balances`);
record('TB', 'Debits equal credits across the whole book',
  String(tb.debits) === String(tb.credits) ? 'done' : 'blocked',
  `debits ${UGX(tb.debits)} · credits ${UGX(tb.credits)}`);

await browser.close();
await db.end();

writeFileSync(join(HERE, 'operations-result.json'), JSON.stringify(
  { ranAt: new Date().toISOString(), ledger, steps, trialBalance: tb }, null, 2));

const bad = steps.filter((s) => s.status === 'blocked');
process.stdout.write(`\n${steps.length - bad.length}/${steps.length} steps completed.\n`);
for (const b of bad) process.stdout.write(`  BLOCKED ${b.id}: ${b.detail}\n`);
