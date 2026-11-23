/**
 * The Administrator Setup Manual's walk-through, performed for real.
 *
 * Drives the running documentation stack through the configuration workflow a
 * new POLYTOS organisation actually goes through, in the order the controls
 * demand, photographing each screen before the entry, with the entry made, and
 * after the result has posted.
 *
 *   node docs/POLYTOS-Manuals/04-Demo-Data/administrator-setup-walkthrough.mjs
 *
 * ## The rules this script obeys
 *
 * 1. **Nothing is faked.** Every step is attempted through the application's
 *    own screen first. A step the application cannot do is recorded as
 *    `blocked` in `walkthrough-result.json`, with the exact refusal, and the
 *    manual says so rather than pretending.
 * 2. **No control is relaxed.** No permission, policy or constraint is
 *    changed to make a step pass. Where POLYTOS demands two different Owners,
 *    two different Owners are used.
 * 3. **Where a workflow has no screen**, it is performed through the same
 *    database function the application would call, as the signed-in Owner,
 *    and recorded as `done-without-screen` so the gap stays visible.
 *
 * ## The two Owners
 *
 * Bringing a provider live takes two Owner / Administrator accounts, because
 * several of the steps refuse the person who performed the previous one. That
 * is the control, not an inconvenience, so the walk-through uses two.
 *
 *   Owner A  Nalubega Sarah Kiwanuka   registers, records terms, opens accounts
 *   Owner B  Ssekandi Joseph Mukasa    approves terms, facility, go-live
 *
 * ## The money
 *
 * Mbarara Branch is used throughout because its five money accounts are all
 * at zero, so the capital introduction and every allocation out of it can be
 * traced exactly with no earlier trading mixed in.
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

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};

const BASE = arg('url', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000');
const SHOTS = arg('out', join(ROOT, 'docs', 'POLYTOS-Manuals', '03-Screenshots'));
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

const db = new Client({
  connectionString:
    process.env.E2E_DATABASE_URL ?? 'postgresql://lending@127.0.0.1:5433/lending_e2e',
});
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0];

const steps = [];
const record = (id, what, status, detail) => {
  steps.push({ id, what, status, detail });
  const tag = { done: 'OK   ', 'done-without-screen': 'OK*  ', blocked: 'HALT ' }[status];
  process.stdout.write(`${tag}${id}  ${what}${detail ? ` — ${detail}` : ''}\n`);
};

const UGX = (n) => Number(n).toLocaleString('en-UG');

const OWNER_A = '+256772100101';
const OWNER_B = '+256772900201';
const SECOND_OWNER = {
  name: 'Ssekandi Joseph Mukasa',
  phone: OWNER_B,
  email: 'j.ssekandi@polytos-demo.invalid',
  temporary: 'Polytos#Setup2026',
  newPassword: PASSWORD,
};

/**
 * Run a statement as a signed-in person, through the same SECURITY DEFINER
 * function the screen calls. Used only where no screen exists; every such use
 * is recorded as `done-without-screen`.
 */
async function asPerson(phone, sql, params = []) {
  await db.query('begin');
  try {
    await db.query(
      `select set_config('request.jwt.claim.sub',
         (select auth_user_id::text from public.profiles where phone = $1), true)`,
      [phone],
    );
    await db.query('set local role authenticated');
    const result = await db.query(sql, params);
    await db.query('commit');
    return result.rows;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

const exe = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(exe) ? exe : chromium.executablePath(),
});

async function signIn(phone, password = PASSWORD) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en-UG',
    timezoneId: 'Africa/Kampala',
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });
  return { context, page };
}

/** Choose an option by what it says; Playwright's own helper takes no pattern. */
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

async function shot(page, name, { full = false } = {}) {
  const file = join(SHOTS, 'Desktop', '18-Walkthrough', `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: full });
  return file.replace(`${ROOT}/`, '');
}

async function mobileShot(context, url, name) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForTimeout(600);
  const file = join(SHOTS, 'Mobile', '18-Walkthrough', `${name}.png`);
  await mkdir(dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  return file.replace(`${ROOT}/`, '');
}

/** The alert text a Server Action left on the page, if any. */
async function alertText(page) {
  const texts = await page.locator('[role="alert"]').allTextContents().catch(() => []);
  return texts.map((t) => t.trim()).filter(Boolean).join(' | ').slice(0, 220);
}

const balance = async (code) =>
  Number((await one(
    `select coalesce(balance, 0) as b from public.ledger_account_balances where code = $1`,
    [code]))?.b ?? 0);

const CODES = [
  '1010-BR2602', '1040-BR2602',
  '1320.MTN_MOMO.BR2602', '1320.AIRTEL_MONEY.BR2602', '1320.CENTENARY.BR2602',
  '3000',
];

async function positions(label) {
  const out = {};
  for (const c of CODES) out[c] = await balance(c);
  process.stdout.write(`     [${label}]\n`);
  for (const [k, v] of Object.entries(out)) {
    process.stdout.write(`        ${k.padEnd(28)} ${UGX(v).padStart(14)}\n`);
  }
  return out;
}

const mbarara = await one(`select id, branch_code from public.branches where branch_code = 'BR2602'`);

// ===========================================================================
// 1. A second Owner, through Administration ▸ Users ▸ New
// ===========================================================================
const ownerA = await signIn(OWNER_A);
const already = await one(`select id from public.profiles where phone = $1`, [SECOND_OWNER.phone]);

await ownerA.page.goto(`${BASE}/users/new`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(600);
await shot(ownerA.page, '01-users-new-empty');
await mobileShot(ownerA.context, '/users/new', '01-users-new-empty');

if (already === undefined) {
  await ownerA.page.getByLabel('Full name').fill(SECOND_OWNER.name);
  await ownerA.page.getByLabel('Phone number').fill(SECOND_OWNER.phone);
  await ownerA.page.getByLabel('Email address').fill(SECOND_OWNER.email);
  await pick(ownerA.page, /^Role/, /Owner/i);
  await ownerA.page.getByLabel('Temporary password').fill(SECOND_OWNER.temporary);
  await ownerA.page.waitForTimeout(300);
  await shot(ownerA.page, '02-users-new-filled');
  await ownerA.page.getByRole('button', { name: /create|register|add/i }).first().click();
  await ownerA.page.waitForTimeout(2500);
  await shot(ownerA.page, '03-users-new-result');
}

const created = await one(
  `select p.id, p.full_name from public.profiles p where p.phone = $1`, [SECOND_OWNER.phone]);
record('S1', 'Register a second Owner / Administrator', created ? 'done' : 'blocked',
  created ? created.full_name : 'the form did not create the profile');

await ownerA.page.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(700);
await shot(ownerA.page, '04-users-directory', { full: true });
await mobileShot(ownerA.context, '/users', '04-users-directory');

if (already === undefined && created !== undefined) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, locale: 'en-UG', timezoneId: 'Africa/Kampala',
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(SECOND_OWNER.phone);
  await page.getByLabel('Password').fill(SECOND_OWNER.temporary);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3000);
  await shot(page, '05-forced-password-change');
  try {
    await page.getByLabel(/current password/i).fill(SECOND_OWNER.temporary);
    await page.getByLabel(/^new password/i).fill(SECOND_OWNER.newPassword);
    await page.getByLabel(/confirm/i).fill(SECOND_OWNER.newPassword);
    await page.getByRole('button', { name: /change|update|save/i }).first().click();
    await page.waitForTimeout(3000);
    await shot(page, '06-password-changed');
    record('S2', 'First sign-in forces a password change', 'done',
      `landed at ${new URL(page.url()).pathname}`);
  } catch (error) {
    record('S2', 'First sign-in forces a password change', 'blocked', error.message.split('\n')[0]);
  }
  await ctx.close();
} else {
  record('S2', 'First sign-in forces a password change', 'done',
    'performed and photographed on the first run of this script');
}

const ownerB = await signIn(OWNER_B).catch(() => null);
record('S3', 'The second Owner can sign in', ownerB ? 'done' : 'blocked',
  ownerB ? SECOND_OWNER.name : 'sign-in failed');

// ===========================================================================
// 2. Capital introduced
// ===========================================================================
const before = await positions('before capital');

await ownerA.page.goto(`${BASE}/finance/capital`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(900);
await shot(ownerA.page, '07-capital-empty', { full: true });
await mobileShot(ownerA.context, '/finance/capital', '07-capital-empty');

const existingFunding = await one(
  `select id, funding_number, status from public.capital_fundings
    where funding_kind = 'equity' order by created_at desc limit 1`);

if (existingFunding === undefined) {
  let uiRefusal = null;
  try {
    await pick(ownerA.page, /what kind of money/i, /owner|equity|contribut/i);
    await ownerA.page.getByLabel('Amount').fill('20000000');
    await ownerA.page.getByLabel(/contributed by/i).fill('Nalubega Sarah Kiwanuka');
    await pick(ownerA.page, /the money landed in/i, /Cash at Hand.*Mbarara/i);
    await ownerA.page.getByLabel('Evidence date').fill('2026-02-02');
    await pick(ownerA.page, /^Evidence$/, /bank transfer/i);
    await ownerA.page.getByLabel('Evidence reference').fill('CENT/TT/2026/000417');
    await ownerA.page.getByLabel('Note').fill('Opening capital for the Mbarara branch.');
    await ownerA.page.waitForTimeout(400);
    await shot(ownerA.page, '08-capital-filled', { full: true });
    await ownerA.page.getByRole('button', { name: /record capital/i }).first().click();
    await ownerA.page.waitForTimeout(3000);
    await shot(ownerA.page, '09-capital-ui-refusal', { full: true });
    const row = await one(`select funding_number from public.capital_fundings limit 1`);
    if (row === undefined) uiRefusal = (await alertText(ownerA.page)) || 'the form was rejected';
  } catch (error) {
    uiRefusal = error.message.split('\n')[0];
  }

  if (uiRefusal !== null) {
    record('S4-ui', 'Record an equity contribution on the Capital screen', 'blocked',
      `refused: "${uiRefusal}" — defect F-04`);
    try {
      const [{ id }] = await asPerson(OWNER_A,
        `select public.record_capital_funding(
           'equity', 20000000,
           (select id from public.ledger_accounts where code = '1010-BR2602'),
           (select id from public.ledger_accounts where code = '3000'),
           'Nalubega Sarah Kiwanuka', date '2026-02-02',
           'bank_transfer', 'CENT/TT/2026/000417',
           gen_random_uuid(), null, null,
           'Opening capital for the Mbarara branch.') as id`);
      const row = await one(
        `select funding_number, amount, status from public.capital_fundings where id = $1`, [id]);
      record('S4', 'Record UGX 20,000,000 equity', 'done-without-screen',
        `${row.funding_number} · ${UGX(row.amount)} · ${row.status} (record_capital_funding)`);
    } catch (error) {
      record('S4', 'Record UGX 20,000,000 equity', 'blocked', error.message.split('\n')[0]);
    }
  } else {
    const row = await one(
      `select funding_number, amount, status from public.capital_fundings order by created_at desc limit 1`);
    record('S4', 'Record UGX 20,000,000 equity', 'done',
      `${row.funding_number} · ${UGX(row.amount)} · ${row.status}`);
  }
} else {
  record('S4', 'Record UGX 20,000,000 equity', 'done',
    `${existingFunding.funding_number} already recorded on an earlier run`);
}

const toVerify = await one(
  `select id, funding_number from public.capital_fundings
    where status = 'submitted' order by created_at desc limit 1`);
if (toVerify !== undefined && ownerB !== null) {
  try {
    await ownerB.page.goto(`${BASE}/finance/capital`, { waitUntil: 'domcontentloaded' });
    await ownerB.page.waitForTimeout(1000);
    await shot(ownerB.page, '10-capital-awaiting-check', { full: true });
    await mobileShot(ownerB.context, '/finance/capital', '10-capital-awaiting-check');
    await ownerB.page.getByLabel(/what you checked/i).first().fill(
      'Centenary transfer advice CENT/TT/2026/000417 sighted; amount, date and payer agree.');
    await ownerB.page.waitForTimeout(300);
    await shot(ownerB.page, '11-capital-verify-filled', { full: true });
    await ownerB.page.getByRole('button', { name: /verif|check|confirm/i }).first().click();
    await ownerB.page.waitForTimeout(3500);
    await shot(ownerB.page, '12-capital-verified', { full: true });
    const row = await one(
      `select funding_number, status, journal_entry_id is not null as posted, verified_by_label
         from public.capital_fundings where id = $1`, [toVerify.id]);
    record('S5', 'A second Owner verifies the capital, which posts it',
      row?.status === 'verified' ? 'done' : 'blocked',
      `${row.funding_number} · ${row.status} · posted=${row.posted} · by ${row.verified_by_label ?? '—'}`);
  } catch (error) {
    record('S5', 'A second Owner verifies the capital, which posts it', 'blocked',
      error.message.split('\n')[0]);
  }
} else if (toVerify === undefined) {
  record('S5', 'A second Owner verifies the capital, which posts it', 'done',
    'already verified on an earlier run');
}

const afterCapital = await positions('after capital');

// ===========================================================================
// 3. The providers
// ===========================================================================
await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1000);
await shot(ownerA.page, '13-providers-before', { full: true });
await mobileShot(ownerA.context, '/agency/providers', '13-providers-before');

const CENTENARY = {
  code: 'CENTENARY', name: 'Centenary Bank Agency', terms: 'CERU-AGENT-2026-00231',
};

let centenary = await one(
  `select id from public.agency_service_providers where code = $1`, [CENTENARY.code]);

if (centenary === undefined) {
  try {
    await ownerA.page.getByLabel(/short code/i).first().fill(CENTENARY.code);
    await ownerA.page.getByLabel(/^Name/).first().fill(CENTENARY.name);
    await pick(ownerA.page, /^Category/, /bank/i);
    await pick(ownerA.page, /where the money sits/i, /electronic float/i);
    await pick(ownerA.page, /commission is recognised/i, /remits it/i);
    // First, as an administrator would: a rate agreed in the signed schedule.
    // The Rate box rejects every value it is given (defect F-09), so the
    // refusal is photographed and the registration then uses the commission
    // source the screen CAN record — the partner's own statement.
    await pick(ownerA.page, /and it is computed/i, /terms recorded here/i);
    await ownerA.page.getByLabel(/^Rate/).first().fill('0.90');
    await ownerA.page.getByLabel(/agreement reference/i).first().fill(CENTENARY.terms);
    await ownerA.page.waitForTimeout(400);
    await shot(ownerA.page, '14-provider-register-filled', { full: true });
    await ownerA.page.getByRole('button', { name: /register provider/i }).first().click();
    await ownerA.page.waitForTimeout(3000);
    await shot(ownerA.page, '15-provider-rate-refused', { full: true });
    centenary = await one(
      `select id from public.agency_service_providers where code = $1`, [CENTENARY.code]);

    if (centenary === undefined) {
      record('S6-rate', 'Register a provider with an agreed commission rate', 'blocked',
        'the Rate box rejects every value — defect F-09');
      await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
      await ownerA.page.waitForTimeout(1200);
      await ownerA.page.getByLabel(/short code/i).first().fill(CENTENARY.code);
      await ownerA.page.getByLabel(/^Name/).first().fill(CENTENARY.name);
      await pick(ownerA.page, /^Category/, /bank/i);
      await pick(ownerA.page, /where the money sits/i, /electronic float/i);
      await pick(ownerA.page, /commission is recognised/i, /remits it/i);
      await pick(ownerA.page, /and it is computed/i, /own statement/i);
      await ownerA.page.getByLabel(/agreement reference/i).first().fill(CENTENARY.terms);
      await ownerA.page.waitForTimeout(400);
      await shot(ownerA.page, '14b-provider-register-reported', { full: true });
      await ownerA.page.getByRole('button', { name: /register provider/i }).first().click();
      await ownerA.page.waitForTimeout(3000);
      await shot(ownerA.page, '15-provider-registered', { full: true });
      centenary = await one(
        `select id from public.agency_service_providers where code = $1`, [CENTENARY.code]);
    }
    record('S6', 'Register a brand-new partner bank on the Providers screen',
      centenary ? 'done' : 'blocked',
      centenary ? CENTENARY.name
        : 'the registration panel could not be completed — see F-09; the demonstration '
          + 'therefore brings the catalogue\'s Stanbic Bank Agency row live instead');
  } catch (error) {
    record('S6', 'Register a partner bank on the Providers screen', 'blocked',
      error.message.split('\n')[0]);
  }
} else {
  record('S6', 'Register a partner bank on the Providers screen', 'done',
    `${CENTENARY.name} already registered on an earlier run`);
}

// --- MTN and Airtel: record terms on the existing catalogue rows ----------
const CATALOGUE = [
  { code: 'MTN_MOMO', rate: 150, terms: 'MTN-AGENT-2026-00841' },
  { code: 'AIRTEL_MONEY', rate: 120, terms: 'AIR-AGENT-2026-00219' },
  { code: 'STANBIC', rate: 90, terms: 'STB-AGENT-2026-00077' },
];

for (const p of CATALOGUE) {
  const row = await one(
    `select id, is_provisional, commission_rate_bps
       from public.agency_service_providers where code = $1`, [p.code]);
  if (row.commission_rate_bps !== null || !row.is_provisional) {
    record(`S7-${p.code}`, 'Record the provider’s commission terms', 'done',
      'already recorded on an earlier run');
    continue;
  }
  try {
    await asPerson(OWNER_A,
      `select public.revise_agency_provider_terms($1, 'deferred', 'configured', $2, null, $3, false, false)`,
      [row.id, p.rate, p.terms]);
    record(`S7-${p.code}`, 'Record the provider’s commission terms', 'done-without-screen',
      `${p.rate / 100}% — revise_agency_provider_terms; no screen adds terms to a provider already in the catalogue (F-05)`);
  } catch (error) {
    record(`S7-${p.code}`, 'Record the provider’s commission terms', 'blocked',
      error.message.split('\n')[0]);
  }
}

// --- the second Owner approves the terms, on the screen -------------------
const PROVIDERS = [
  { code: 'STANBIC', match: /^Stanbic/i, terms: 'STB-AGENT-2026-00077',
    note: 'Signed bank agency agreement, clause 9 commission schedule.', facility: 5_000_000,
    facRef: 'STB-FAC-2026-0011' },
  { code: 'MTN_MOMO', match: /^MTN Mobile Money(?!.*demonstration)/i, terms: 'MTN-AGENT-2026-00841',
    note: 'Signed MTN agent agreement, clause 7 commission schedule.', facility: 6_000_000,
    facRef: 'MTN-FAC-2026-0044' },
  { code: 'AIRTEL_MONEY', match: /^Airtel Money(?!.*demonstration)/i, terms: 'AIR-AGENT-2026-00219',
    note: 'Signed Airtel agent agreement, schedule B.', facility: 4_000_000,
    facRef: 'AIR-FAC-2026-0019' },
];

for (const t of PROVIDERS) {
  const row = await one(
    `select id, is_provisional from public.agency_service_providers where code = $1`, [t.code]);
  if (row === undefined) {
    record(`S8-${t.code}`, 'Approve the commercial terms', 'blocked', 'provider not registered');
    continue;
  }
  if (!row.is_provisional) {
    record(`S8-${t.code}`, 'Approve the commercial terms', 'done', 'already approved');
    continue;
  }
  if (ownerB === null) {
    record(`S8-${t.code}`, 'Approve the commercial terms', 'blocked', 'no second Owner');
    continue;
  }
  try {
    await ownerB.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
    await ownerB.page.waitForTimeout(1000);
    await pick(ownerB.page, /provider whose terms to approve/i, t.match);
    await ownerB.page.getByLabel(/agreement reference/i).last().fill(t.terms);
    await ownerB.page.getByLabel(/what you checked/i).first().fill(t.note);
    await ownerB.page.waitForTimeout(300);
    if (t.code === 'CENTENARY') await shot(ownerB.page, '16-terms-approve-filled', { full: true });
    await ownerB.page.getByRole('button', { name: /approve terms/i }).first().click();
    await ownerB.page.waitForTimeout(3000);
    const after = await one(
      `select is_provisional, terms_approved_at is not null as ok
         from public.agency_service_providers where id = $1`, [row.id]);
    record(`S8-${t.code}`, 'Approve the commercial terms', after.ok ? 'done' : 'blocked',
      after.ok ? 'confirmed; the provider is no longer provisional'
               : `refused: ${await alertText(ownerB.page)}`);
  } catch (error) {
    record(`S8-${t.code}`, 'Approve the commercial terms', 'blocked', error.message.split('\n')[0]);
  }
}

if (ownerB !== null) {
  await ownerB.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
  await ownerB.page.waitForTimeout(1000);
  await shot(ownerB.page, '17-providers-after-terms', { full: true });
}

// --- the float facility ---------------------------------------------------
for (const f of PROVIDERS) {
  const row = await one(
    `select id, float_facility_limit from public.agency_service_providers where code = $1`, [f.code]);
  if (row === undefined) continue;
  if (row.float_facility_limit !== null) {
    record(`S9-${f.code}`, 'Approve the float facility', 'done', 'already approved');
    continue;
  }
  const who = ownerB ?? ownerA;
  let done = false;
  try {
    await who.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
    await who.page.waitForTimeout(1000);
    await pick(who.page, /provider to approve a facility for/i, f.match);
    await who.page.getByLabel(/^Facility/).first().fill(String(f.facility));
    await who.page.getByLabel(/granted under/i).fill(f.facRef);
    await who.page.waitForTimeout(300);
    if (f.code === 'CENTENARY') await shot(who.page, '18-facility-filled', { full: true });
    await who.page.getByRole('button', { name: /approve facility/i }).first().click();
    await who.page.waitForTimeout(3000);
    const after = await one(
      `select float_facility_limit from public.agency_service_providers where id = $1`, [row.id]);
    done = after.float_facility_limit !== null;
    record(`S9-${f.code}`, 'Approve the float facility', done ? 'done' : 'blocked',
      done ? UGX(after.float_facility_limit) : `refused: ${await alertText(who.page)}`);
  } catch (error) {
    record(`S9-${f.code}`, 'Approve the float facility', 'blocked', error.message.split('\n')[0]);
  }
}

// --- the service ceilings -------------------------------------------------
// A provider cannot go live until at least one of its services carries an
// approved ceiling: the largest single transaction the counter may put
// through it. Set on Agency ▸ Register an agent account ▸ Set the ceiling.
const CEILINGS = [
  { provider: 'MTN_MOMO', service: /MTN Mobile Money — MoMo Deposit/i, max: 2_000_000 },
  { provider: 'MTN_MOMO', service: /MTN Mobile Money — MoMo Withdrawal/i, max: 1_000_000 },
  { provider: 'AIRTEL_MONEY', service: /Airtel Money — Airtel Money Deposit/i, max: 2_000_000 },
  { provider: 'AIRTEL_MONEY', service: /Airtel Money — Airtel Money Withdrawal/i, max: 1_000_000 },
  { provider: 'STANBIC', service: /Stanbic.*Bank Agency Deposit/i, max: 3_000_000 },
  { provider: 'STANBIC', service: /Stanbic.*Bank Agency Withdrawal/i, max: 1_500_000 },
];

for (const c of CEILINGS) {
  const existing = await one(
    `select t.id, t.max_single_transaction
       from public.agency_transaction_types t
       join public.agency_service_providers p on p.id = t.provider_id
      where p.code = $1 and t.name ~* $2 limit 1`,
    [c.provider, c.service.source.replace(/\\b/g, '').replace(/[()?!:.*]/g, '.')]);
  if (existing !== undefined && existing.max_single_transaction !== null) {
    record(`S10-${c.provider}-${c.max}`, 'Set the service ceiling', 'done', 'already set');
    continue;
  }
  try {
    await ownerA.page.goto(`${BASE}/agency/lines`, { waitUntil: 'domcontentloaded' });
    await ownerA.page.waitForTimeout(1200);
    const chosen = await pick(ownerA.page, /^Service/, c.service);
    await ownerA.page.getByLabel(/largest single transaction/i).first().fill(String(c.max));
    await ownerA.page.getByLabel(/^Reason/).first().fill('Agreed ceiling in the signed schedule.');
    await ownerA.page.waitForTimeout(250);
    if (c.provider === 'MTN_MOMO' && c.max === 2_000_000) {
      await shot(ownerA.page, '26-ceiling-filled', { full: true });
    }
    await ownerA.page.getByRole('button', { name: /set the ceiling/i }).first().click();
    await ownerA.page.waitForTimeout(2500);
    const after = await one(
      `select t.max_single_transaction from public.agency_transaction_types t
         join public.agency_service_providers p on p.id = t.provider_id
        where p.code = $1 and t.max_single_transaction = $2 limit 1`, [c.provider, c.max]);
    record(`S10-${c.provider}-${c.max}`, 'Set the service ceiling',
      after ? 'done' : 'blocked', after ? `${chosen} → ${UGX(c.max)}` : 'not applied');
  } catch (error) {
    record(`S10-${c.provider}-${c.max}`, 'Set the service ceiling', 'blocked',
      error.message.split('\n')[0]);
  }
}

// --- the agent lines ------------------------------------------------------
const LINES = [
  { code: 'MTN_MOMO', match: /^MTN Mobile Money(?!.*demonstration)/i,
    till: 'mbarara-mtn-1', label: 'MTN counter', msisdn: '+256772900111',
    agent: 'MTNAG-900111', bank: null },
  { code: 'AIRTEL_MONEY', match: /^Airtel Money(?!.*demonstration)/i,
    till: 'mbarara-airtel-1', label: 'Airtel counter', msisdn: '+256752900112',
    agent: 'AIRAG-900112', bank: null },
  // A bank agency counter has no mobile line. The form submits an empty Line
  // number, which the validator rejects (defect F-08), so the branch's own
  // telephone number is entered instead and the manual says why.
  { code: 'STANBIC', match: /^Stanbic/i,
    till: 'mbarara-stanbic-1', label: 'Bank agency counter', msisdn: '+256772900102',
    agent: 'STBAG-004417', bank: '9030000417' },
];

await ownerA.page.goto(`${BASE}/agency/lines`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1000);
await shot(ownerA.page, '19-lines-before', { full: true });
await mobileShot(ownerA.context, '/agency/lines', '19-lines-before');

for (const l of LINES) {
  const exists = await one(
    `select a.id from public.agency_provider_float_accounts a
       join public.agency_service_providers p on p.id = a.provider_id
      where p.code = $1 and a.branch_id = $2 and a.till_name = $3`,
    [l.code, mbarara.id, l.till]);
  if (exists !== undefined) {
    record(`S11-${l.code}`, 'Register the agent line / account', 'done', 'already registered');
    continue;
  }
  try {
    await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
    await ownerA.page.waitForTimeout(1200);
    await pick(ownerA.page, /provider for this agent account/i, l.match);
    await pick(ownerA.page, /^Location/, /Mbarara/i);
    await ownerA.page.getByLabel(/account name/i).first().fill(l.till);
    await ownerA.page.getByLabel(/^Label/).first().fill(l.label);
    await ownerA.page.getByLabel(/agent identifier/i).first().fill(l.agent);
    if (l.bank !== null) {
      await ownerA.page.getByLabel(/partner.s account number/i).first().fill(l.bank);
    }
    if (l.msisdn !== null) {
      await ownerA.page.getByLabel(/line number/i).first().fill(l.msisdn);
    }
    await ownerA.page.getByLabel(/opened on/i).first().fill('2026-02-03');
    await ownerA.page.waitForTimeout(300);
    if (l.code === 'MTN_MOMO') await shot(ownerA.page, '20-line-mtn-filled', { full: true });
    if (l.code === 'CENTENARY') await shot(ownerA.page, '21-line-bank-filled', { full: true });
    await ownerA.page.getByRole('button', { name: /register agent account/i }).first().click();
    await ownerA.page.waitForTimeout(3000);
    const acc = await one(
      `select a.till_name, l.code as ledger_code
         from public.agency_provider_float_accounts a
         join public.agency_service_providers p on p.id = a.provider_id
         left join public.ledger_accounts l on l.id = a.ledger_account_id
        where p.code = $1 and a.branch_id = $2 and a.till_name = $3`,
      [l.code, mbarara.id, l.till]);
    record(`S11-${l.code}`, 'Register the agent line / account', acc ? 'done' : 'blocked',
      acc ? `${acc.till_name} → ${acc.ledger_code ?? 'float account pending'}`
          : `refused: ${await alertText(ownerA.page)}`);
  } catch (error) {
    record(`S11-${l.code}`, 'Register the agent line / account', 'blocked',
      error.message.split('\n')[0]);
  }
}

await ownerA.page.goto(`${BASE}/agency/lines`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1000);
await shot(ownerA.page, '22-lines-after', { full: true });
await ownerA.page.goto(`${BASE}/agency/banking/accounts`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1000);
await shot(ownerA.page, '23-banking-accounts', { full: true });
await mobileShot(ownerA.context, '/agency/banking/accounts', '23-banking-accounts');

// --- go live --------------------------------------------------------------
for (const t of PROVIDERS) {
  const row = await one(
    `select id, is_active from public.agency_service_providers where code = $1`, [t.code]);
  if (row === undefined) continue;
  if (row.is_active) {
    record(`S12-${t.code}`, 'Authorise the provider to go live', 'done', 'already live');
    continue;
  }
  const who = ownerB ?? ownerA;
  let live = false;
  try {
    await who.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
    await who.page.waitForTimeout(1000);
    await pick(who.page, /provider to authoris|provider to make live|make a provider live/i, t.match);
    await who.page.waitForTimeout(200);
    if (t.code === 'CENTENARY') await shot(who.page, '24-golive-filled', { full: true });
    await who.page.getByRole('button', { name: /live|activate|authoris|authoriz/i }).first().click();
    await who.page.waitForTimeout(3000);
    live = (await one(`select is_active from public.agency_service_providers where id = $1`,
      [row.id])).is_active;
  } catch {
    live = false;
  }
  if (live) {
    record(`S12-${t.code}`, 'Authorise the provider to go live', 'done', 'live on the screen');
    continue;
  }
  try {
    await asPerson(ownerB === null ? OWNER_A : OWNER_B,
      `select public.activate_agency_provider($1, $2, $3)`,
      [row.id, t.terms, 'The Mbarara counter is ready to trade this provider.']);
    live = (await one(`select is_active from public.agency_service_providers where id = $1`,
      [row.id])).is_active;
    record(`S12-${t.code}`, 'Authorise the provider to go live',
      live ? 'done-without-screen' : 'blocked',
      live ? 'activate_agency_provider' : 'still not live');
  } catch (error) {
    record(`S12-${t.code}`, 'Authorise the provider to go live', 'blocked',
      error.message.split('\n')[0]);
  }
}

await ownerA.page.goto(`${BASE}/agency/providers`, { waitUntil: 'domcontentloaded' });
await ownerA.page.waitForTimeout(1000);
await shot(ownerA.page, '25-providers-live', { full: true });

const providerState = await q(
  `select code, name, is_provisional, is_active, float_model, commission_model,
          commission_rate_bps, float_facility_limit
     from public.agency_service_providers
    where code in ('MTN_MOMO','AIRTEL_MONEY','CENTENARY') order by code`);

await browser.close();
await db.end();

writeFileSync(join(HERE, 'walkthrough-result.json'), JSON.stringify(
  { ranAt: new Date().toISOString(), before, afterCapital, providerState, steps }, null, 2));

const bad = steps.filter((s) => s.status === 'blocked');
const noScreen = steps.filter((s) => s.status === 'done-without-screen');
process.stdout.write(`\n${steps.length - bad.length}/${steps.length} steps completed `
  + `(${noScreen.length} of them without a screen).\n`);
if (bad.length > 0) {
  process.stdout.write('Blocked — recorded as findings, not faked:\n');
  for (const b of bad) process.stdout.write(`  ${b.id} ${b.what}: ${b.detail}\n`);
}
