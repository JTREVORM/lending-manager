/**
 * Capture every screen both POLYTOS manuals illustrate, at both widths, as
 * each role that can actually reach it.
 *
 * Points at the Docker-free documentation stack (PostgreSQL + the real
 * PostgREST binary + the auth shim + the production Next build) that
 * `tests/e2e/harness/stack.sh up` assembles, signs in as a real person
 * through the real sign-in form, and photographs the real screen.
 *
 *   node docs/POLYTOS-Manuals/04-Demo-Data/capture-manual-screens.mjs
 *
 * Options:
 *   --out <dir>     where to write (default docs/POLYTOS-Manuals/03-Screenshots)
 *   --only <regex>  capture only screens whose name matches
 *   --roles <list>  comma-separated subset of owner,manager,secretary,borrower
 *   --tag <suffix>  appended to every file name, for before/after pairs
 *
 * ## The trap this script is written around
 *
 * The auth shim mints a fresh signing key every time the stack restarts, so a
 * storage state captured before a restart authenticates nobody afterwards —
 * and `/login` answers 200. A previous generation of this kind of script
 * produced sixty photographs of a sign-in form and reported them as evidence
 * that sixty screens worked. So every capture asserts, after navigation, that
 * the browser is not at `/login` and that the page is not an error boundary;
 * anything that fails is recorded in the manifest as a failure and the script
 * exits non-zero.
 */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const BASE = arg('url', process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000');
const OUT = arg('out', join(ROOT, 'docs', 'POLYTOS-Manuals', '03-Screenshots'));
const ONLY = arg('only', null);
const TAG = arg('tag', '');
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

const fx = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'e2e', 'harness', 'fixtures.json'), 'utf8'),
);

/** The four people the manuals are written for. */
const PEOPLE = {
  owner: { phone: fx.staff.owner, label: 'Owner / Administrator' },
  manager: { phone: fx.staff.manager, label: 'Manager' },
  secretary: { phone: fx.staff.secretary, label: 'Secretary / Treasurer' },
  borrower: { phone: fx.borrower, label: 'Client' },
};

const VIEWPORTS = [
  { folder: 'Desktop', width: 1440, height: 900, scale: 2 },
  { folder: 'Mobile', width: 390, height: 844, scale: 2 },
];

/**
 * The screen catalogue.
 *
 * `roles` is who it is photographed as — the first entry is the role whose
 * folder the canonical copy lands in. A screen listed for two roles is one
 * whose *content* differs by role, which is the only reason to photograph it
 * twice.
 */
const SCREENS = [
  // --- Sign-in and the shell ------------------------------------------------
  { m: '01-Access', n: 'login', p: '/login', roles: ['anon'] },
  { m: '01-Access', n: 'dashboard', p: '/', roles: ['owner', 'manager', 'secretary'] },
  { m: '01-Access', n: 'account', p: '/account', roles: ['owner'] },
  { m: '01-Access', n: 'account-password', p: '/account/password', roles: ['owner'] },
  { m: '01-Access', n: 'notifications', p: '/notifications', roles: ['owner', 'manager'] },
  { m: '01-Access', n: 'offline', p: '/offline', roles: ['anon'] },

  // --- Clients -------------------------------------------------------------
  { m: '02-Clients', n: 'clients-register', p: '/clients', roles: ['secretary', 'owner'] },
  { m: '02-Clients', n: 'clients-active', p: '/clients?status=active', roles: ['secretary'] },
  { m: '02-Clients', n: 'clients-new', p: '/clients/new', roles: ['secretary'] },
  { m: '02-Clients', n: 'client-detail', p: `/clients/${fx.clients.current}`, roles: ['secretary', 'owner'] },
  { m: '02-Clients', n: 'client-edit', p: `/clients/${fx.clients.current}/edit`, roles: ['secretary'] },
  { m: '02-Clients', n: 'guarantors-register', p: '/guarantors/register', roles: ['secretary'] },
  { m: '02-Clients', n: 'guarantors-list', p: '/guarantors', roles: ['secretary'] },
  { m: '02-Clients', n: 'guarantors-new', p: '/guarantors/new', roles: ['secretary'] },

  // --- Membership ----------------------------------------------------------
  { m: '03-Membership', n: 'membership-register', p: '/membership', roles: ['secretary', 'owner'] },
  { m: '03-Membership', n: 'membership-enrol', p: '/membership/enrol', roles: ['secretary'] },
  { m: '03-Membership', n: 'membership-detail', p: `/membership/${fx.memberships.qualified}`, roles: ['secretary'] },
  { m: '03-Membership', n: 'membership-policies', p: '/membership/policies', roles: ['owner'] },
  { m: '03-Membership', n: 'membership-policy-transitions', p: '/membership/policies/transitions', roles: ['owner'] },

  // --- Member savings ------------------------------------------------------
  { m: '04-Savings', n: 'savings-register', p: '/savings', roles: ['secretary', 'owner'] },
  { m: '04-Savings', n: 'savings-detail', p: `/savings/${fx.savings.qualified}`, roles: ['secretary'] },
  { m: '04-Savings', n: 'savings-deposit', p: `/savings/${fx.savings.qualified}/deposit`, roles: ['secretary'] },
  { m: '04-Savings', n: 'savings-withdraw', p: `/savings/${fx.savings.qualified}/withdraw`, roles: ['secretary'] },
  { m: '04-Savings', n: 'savings-statement', p: `/savings/${fx.savings.qualified}/statement`, roles: ['secretary'] },
  { m: '04-Savings', n: 'savings-withdrawals-queue', p: '/savings/withdrawals', roles: ['manager', 'owner'] },
  { m: '04-Savings', n: 'savings-withdrawal-detail', p: `/savings/withdrawals/${fx.withdrawals.pending}`, roles: ['manager'] },

  // --- Member lending ------------------------------------------------------
  { m: '05-MemberLending', n: 'member-loans-eligibility', p: '/member-loans?tab=members', roles: ['secretary', 'manager'] },
  { m: '05-MemberLending', n: 'member-loans-register', p: '/member-loans?tab=loans', roles: ['manager'] },
  { m: '05-MemberLending', n: 'member-loans-new', p: '/member-loans/new', roles: ['manager'] },

  // --- Member benefits -----------------------------------------------------
  { m: '06-Benefits', n: 'benefits-overview', p: '/benefits', roles: ['secretary', 'owner'] },
  { m: '06-Benefits', n: 'benefits-claims', p: '/benefits/claims', roles: ['secretary'] },
  { m: '06-Benefits', n: 'benefits-claim-new', p: '/benefits/claims/new', roles: ['secretary'] },
  { m: '06-Benefits', n: 'benefits-claim-detail', p: `/benefits/claims/${fx.benefitClaims.toApprove}`, roles: ['manager'] },
  { m: '06-Benefits', n: 'benefits-approvals', p: '/benefits/approvals', roles: ['manager', 'owner'] },
  { m: '06-Benefits', n: 'benefits-payments', p: '/benefits/payments', roles: ['owner'] },
  { m: '06-Benefits', n: 'benefits-reports', p: '/benefits/reports', roles: ['owner'] },
  { m: '06-Benefits', n: 'beneficiaries', p: '/beneficiaries', roles: ['secretary'] },
  { m: '06-Benefits', n: 'beneficiaries-new', p: '/beneficiaries/new', roles: ['secretary'] },
  { m: '06-Benefits', n: 'beneficiary-detail', p: `/beneficiaries/${fx.beneficiaries.pending}`, roles: ['secretary'] },

  // --- Meetings ------------------------------------------------------------
  { m: '07-Meetings', n: 'meetings', p: '/meetings', roles: ['secretary', 'owner'] },
  { m: '07-Meetings', n: 'meetings-new', p: '/meetings/new', roles: ['secretary'] },
  { m: '07-Meetings', n: 'meeting-detail', p: `/meetings/${fx.meetings.held}`, roles: ['secretary'] },
  { m: '07-Meetings', n: 'meeting-fines', p: '/meetings/fines', roles: ['secretary', 'manager'] },
  { m: '07-Meetings', n: 'meeting-fine-detail', p: `/meetings/fines/${fx.fines.unpaid}`, roles: ['manager'] },

  // --- Loan management -----------------------------------------------------
  { m: '08-Loans', n: 'loans-register', p: '/loans', roles: ['manager', 'secretary', 'owner'] },
  { m: '08-Loans', n: 'loans-pending-approval', p: '/loans?stage=pending_approval', roles: ['manager'] },
  { m: '08-Loans', n: 'loans-arrears', p: '/loans?stage=arrears', roles: ['manager'] },
  { m: '08-Loans', n: 'loans-new', p: '/loans/new', roles: ['secretary'] },
  { m: '08-Loans', n: 'loan-detail-active', p: `/loans/${fx.loans.current}`, roles: ['manager', 'secretary'] },
  { m: '08-Loans', n: 'loan-detail-pending', p: `/loans/${fx.loans.pending}`, roles: ['manager'] },
  { m: '08-Loans', n: 'loan-detail-arrears', p: `/loans/${fx.loans.arrears}`, roles: ['manager'] },
  { m: '08-Loans', n: 'loan-application', p: `/loans/${fx.loans.pending}/application`, roles: ['manager'] },
  { m: '08-Loans', n: 'loan-edit-draft', p: `/loans/${fx.loans.draft}/edit`, roles: ['secretary'] },
  { m: '08-Loans', n: 'loan-statement', p: `/loans/${fx.loans.current}/statement`, roles: ['manager'] },
  { m: '08-Loans', n: 'loans-by-product', p: '/loans/by-product', roles: ['manager'] },

  // --- Collections ---------------------------------------------------------
  { m: '09-Collections', n: 'payments-register', p: '/payments', roles: ['secretary', 'manager'] },
  { m: '09-Collections', n: 'payments-new', p: '/payments/new', roles: ['secretary'] },
  { m: '09-Collections', n: 'payment-detail', p: `/payments/${fx.payments?.recorded ?? ''}`, roles: ['secretary'], skipIf: !fx.payments?.recorded },
  { m: '09-Collections', n: 'payments-summary', p: '/payments/summary', roles: ['manager', 'owner'] },
  { m: '09-Collections', n: 'overdue', p: '/overdue', roles: ['manager', 'secretary'] },

  // --- Debt and security ---------------------------------------------------
  { m: '10-DebtSecurity', n: 'recovery', p: '/recovery', roles: ['manager'] },
  { m: '10-DebtSecurity', n: 'recovery-promises', p: '/recovery?view=promises', roles: ['manager'] },

  // --- Finance -------------------------------------------------------------
  { m: '11-Finance', n: 'finance-cash-position', p: '/finance', roles: ['owner', 'manager'] },
  { m: '11-Finance', n: 'finance-capital', p: '/finance/capital', roles: ['owner'] },
  { m: '11-Finance', n: 'finance-transfers', p: '/finance/transfers', roles: ['owner', 'manager'] },
  { m: '11-Finance', n: 'finance-transfers-new', p: '/finance/transfers/new', roles: ['manager'] },
  { m: '11-Finance', n: 'finance-expenses', p: '/finance/expenses', roles: ['owner', 'manager'] },
  { m: '11-Finance', n: 'finance-expenses-new', p: '/finance/expenses/new', roles: ['manager'] },
  { m: '11-Finance', n: 'finance-income', p: '/finance/income', roles: ['owner'] },
  { m: '11-Finance', n: 'finance-income-new', p: '/finance/income/new', roles: ['owner'] },
  { m: '11-Finance', n: 'finance-receipts', p: '/finance/receipts', roles: ['manager', 'owner'] },
  { m: '11-Finance', n: 'finance-deposits', p: '/finance/deposits', roles: ['owner', 'manager'] },
  { m: '11-Finance', n: 'finance-reconciliation', p: '/finance/reconciliation', roles: ['owner', 'manager'] },
  { m: '11-Finance', n: 'finance-reconciliation-new', p: '/finance/reconciliation/new', roles: ['manager'] },
  { m: '11-Finance', n: 'finance-ledger', p: '/finance/ledger', roles: ['owner'] },
  { m: '11-Finance', n: 'finance-trial-balance', p: '/finance/trial-balance', roles: ['owner'] },

  // --- Agency: hub, mobile money, agent banking ----------------------------
  { m: '12-Agency', n: 'agency-overview', p: '/agency', roles: ['owner', 'manager', 'secretary'] },
  { m: '12-Agency', n: 'agency-record', p: '/agency/record', roles: ['secretary', 'manager'] },
  { m: '12-Agency', n: 'agency-pending', p: '/agency/pending', roles: ['manager', 'owner'] },
  { m: '12-Agency', n: 'agency-history', p: '/agency/history', roles: ['manager', 'owner'] },
  { m: '12-Agency', n: 'agency-transaction-awaiting', p: `/agency/history/${fx.agency.transactions.awaitingVerification}`, roles: ['manager'] },
  { m: '12-Agency', n: 'agency-transaction-reversed', p: `/agency/history/${fx.agency.transactions.reversed}`, roles: ['owner'] },
  { m: '12-Agency', n: 'agency-float', p: '/agency/float', roles: ['owner', 'manager'] },
  { m: '12-Agency', n: 'agency-float-replenish', p: '/agency/float/replenish', roles: ['owner'] },
  { m: '12-Agency', n: 'agency-transfers', p: '/agency/transfers', roles: ['owner'] },
  { m: '12-Agency', n: 'agency-cash-banking', p: '/agency/cash-banking', roles: ['secretary', 'manager'] },
  { m: '12-Agency', n: 'agency-commission', p: '/agency/commission', roles: ['owner', 'manager'] },
  { m: '12-Agency', n: 'agency-payables', p: '/agency/payables', roles: ['owner'] },
  { m: '12-Agency', n: 'agency-reconciliation-cash', p: '/agency/reconciliation/cash', roles: ['manager', 'owner'] },
  { m: '12-Agency', n: 'agency-reconciliation-float', p: '/agency/reconciliation/float', roles: ['manager', 'owner'] },
  { m: '12-Agency', n: 'agency-exceptions', p: '/agency/exceptions', roles: ['owner'] },
  { m: '12-Agency', n: 'agency-reports', p: '/agency/reports', roles: ['owner', 'manager'] },

  // --- Agency: mobile money per provider -----------------------------------
  { m: '13-MobileMoney', n: 'money-overview', p: '/agency/money', roles: ['owner', 'manager', 'secretary'] },
  { m: '13-MobileMoney', n: 'money-mtn', p: '/agency/money/MTN_MOMO', roles: ['owner', 'secretary'] },
  { m: '13-MobileMoney', n: 'money-mtn-commission', p: '/agency/money/MTN_MOMO/commission', roles: ['owner'] },
  { m: '13-MobileMoney', n: 'money-mtn-statements', p: '/agency/money/MTN_MOMO/statements', roles: ['owner'] },
  { m: '13-MobileMoney', n: 'money-airtel', p: '/agency/money/AIRTEL_MONEY', roles: ['owner', 'secretary'] },
  { m: '13-MobileMoney', n: 'money-airtel-commission', p: '/agency/money/AIRTEL_MONEY/commission', roles: ['owner'] },
  { m: '13-MobileMoney', n: 'money-airtel-statements', p: '/agency/money/AIRTEL_MONEY/statements', roles: ['owner'] },

  // --- Agency: configuration (administrator manual) ------------------------
  { m: '14-AgencySetup', n: 'agency-providers', p: '/agency/providers', roles: ['owner'] },
  { m: '14-AgencySetup', n: 'agency-lines', p: '/agency/lines', roles: ['owner'] },
  { m: '14-AgencySetup', n: 'agency-banking-overview', p: '/agency/banking', roles: ['owner', 'manager'] },
  { m: '14-AgencySetup', n: 'agency-banking-accounts', p: '/agency/banking/accounts', roles: ['owner'] },
  { m: '14-AgencySetup', n: 'agency-staffing-banking', p: '/agency/staffing?category=agency_banking', roles: ['owner'] },
  { m: '14-AgencySetup', n: 'agency-staffing-money', p: '/agency/staffing?category=mobile_money', roles: ['owner'] },

  // --- Reports -------------------------------------------------------------
  { m: '15-Reports', n: 'reports-centre', p: '/reports', roles: ['owner', 'manager'] },
  { m: '15-Reports', n: 'reports-collections', p: '/reports/collections', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-arrears', p: '/reports/arrears', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-aging', p: '/reports/aging', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-loans', p: '/reports/loans', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-clients', p: '/reports/clients', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-penalties', p: '/reports/penalties', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-grace', p: '/reports/grace', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-recovery', p: '/reports/recovery', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-collateral', p: '/reports/collateral', roles: ['manager'] },
  { m: '15-Reports', n: 'reports-guarantors', p: '/reports/guarantors', roles: ['manager'] },

  // --- Administration ------------------------------------------------------
  { m: '16-Administration', n: 'users', p: '/users', roles: ['owner'] },
  { m: '16-Administration', n: 'users-new', p: '/users/new', roles: ['owner'] },
  { m: '16-Administration', n: 'settings', p: '/settings', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-branches', p: '/settings?section=branches', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-lending', p: '/settings?section=lending', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-finance', p: '/settings?section=finance', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-guarantors', p: '/settings?section=guarantors', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-references', p: '/settings?section=references', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-products', p: '/settings/products', roles: ['owner'] },
  { m: '16-Administration', n: 'settings-products-new', p: '/settings/products/new', roles: ['owner'] },
  { m: '16-Administration', n: 'audit', p: '/audit', roles: ['owner'] },
  { m: '16-Administration', n: 'audit-agency', p: '/audit?entity=agency_transaction', roles: ['owner'] },

  // --- Client portal -------------------------------------------------------
  { m: '17-Portal', n: 'portal-home', p: '/portal', roles: ['borrower'] },
];

// ---------------------------------------------------------------------------

const preinstalled = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalled) ? preinstalled : chromium.executablePath();
const browser = await chromium.launch({ executablePath });

/** Sign in through the real form and keep the storage state. */
async function signIn(person) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Phone number').fill(person.phone);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
  const state = await context.storageState();
  await context.close();
  return state;
}

const wanted = (arg('roles', null) ?? '').split(',').filter(Boolean);
const roleFilter = (r) => wanted.length === 0 || wanted.includes(r);
const nameFilter = ONLY === null ? () => true : (n) => new RegExp(ONLY).test(n);

const states = {};
for (const key of Object.keys(PEOPLE)) {
  if (!roleFilter(key)) continue;
  try {
    states[key] = await signIn(PEOPLE[key]);
    process.stdout.write(`signed in: ${key}\n`);
  } catch (error) {
    process.stderr.write(`COULD NOT SIGN IN as ${key}: ${error.message}\n`);
  }
}

const manifest = [];
const failures = [];

for (const vp of VIEWPORTS) {
  for (const roleKey of ['anon', ...Object.keys(PEOPLE)]) {
    if (roleKey !== 'anon' && !roleFilter(roleKey)) continue;
    if (roleKey !== 'anon' && states[roleKey] === undefined) continue;

    const screens = SCREENS.filter(
      (s) => s.skipIf !== true && s.roles.includes(roleKey) && nameFilter(s.n),
    );
    if (screens.length === 0) continue;

    const context = await browser.newContext({
      ...(roleKey === 'anon' ? {} : { storageState: states[roleKey] }),
      ignoreHTTPSErrors: true,
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.scale,
      locale: 'en-UG',
      timezoneId: 'Africa/Kampala',
    });
    const page = await context.newPage();

    for (const s of screens) {
      // Two photographs of the same screen. The viewport-framed one is what a
      // manual page can actually carry at a readable size; the full-page one
      // is the original, kept whole so a reader can check anything the frame
      // cut off. A dashboard is 6,800 pixels tall — reduced to the width of an
      // A4 column it is unreadable, which is why the frame exists.
      const file = join(OUT, vp.folder, s.m, `${s.n}--${roleKey}${TAG}.png`);
      const fullFile = join(OUT, vp.folder, s.m, `${s.n}--${roleKey}${TAG}.full.png`);
      await mkdir(dirname(file), { recursive: true });

      let status = 0;
      try {
        const response = await page.goto(`${BASE}${s.p}`, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        status = response?.status() ?? 0;
        await page.waitForLoadState('load').catch(() => undefined);
        await page.waitForTimeout(700);
      } catch (error) {
        failures.push({ screen: s.n, role: roleKey, viewport: vp.folder, why: error.message });
      }

      const landed = new URL(page.url()).pathname;
      const bouncedToLogin = roleKey !== 'anon' && landed.startsWith('/login');
      const body = await page.locator('body').innerText().catch(() => '');
      const errored = /Something went wrong|Application error|Unhandled Runtime/i.test(body);

      await page.screenshot({ path: file, fullPage: false });
      await page.screenshot({ path: fullFile, fullPage: true });

      const row = {
        module: s.m,
        screen: s.n,
        role: roleKey,
        viewport: vp.folder,
        requested: s.p,
        landed,
        httpStatus: status,
        file: file.replace(`${ROOT}/`, ''),
        fullFile: fullFile.replace(`${ROOT}/`, ''),
        ok: status === 200 && !bouncedToLogin && !errored,
      };
      if (bouncedToLogin) row.note = 'redirected to sign-in';
      if (errored) row.note = 'error boundary rendered';
      if (status !== 0 && status !== 200) row.note = `HTTP ${status}`;
      manifest.push(row);
      if (!row.ok) failures.push(row);

      process.stdout.write(`${row.ok ? 'ok  ' : 'BAD '} ${vp.folder} ${roleKey} ${s.n}\n`);
    }

    await context.close();
  }
}

await browser.close();

await mkdir(OUT, { recursive: true });
writeFileSync(join(OUT, `manifest${TAG}.json`), JSON.stringify(manifest, null, 2));

const ok = manifest.filter((r) => r.ok).length;
process.stdout.write(`\n${ok}/${manifest.length} captures verified.\n`);
if (failures.length > 0) {
  process.stdout.write(`${failures.length} problem captures:\n`);
  for (const f of failures) {
    process.stdout.write(`  ${f.viewport ?? '?'} ${f.role} ${f.screen}: ${f.note ?? f.why}\n`);
  }
  process.exit(1);
}
