/**
 * Screenshots and timings for the Phase 4D agency banking screens.
 *
 * ## What this is, and what it is not
 *
 * A delivery tool: it drives the running end-to-end stack with a real browser
 * and writes a PNG per screen per viewport, plus a timing table and a
 * measured overflow figure, so a reviewer can see what was built rather than
 * read a description of it.
 *
 * It is **not** a test. Nothing here asserts anything; the assertions live in
 * `tests/e2e/specs/agency.spec.ts`, which runs in CI on both the desktop and
 * the mobile project. A script that both captured evidence and judged it
 * would be a script nobody could trust in either role.
 *
 * ## It records no money
 *
 * The harness seed already builds everything these screens need - three
 * demonstration providers, a funded float, eight posted transactions, one
 * awaiting verification, one draft, one reversed, one with an authorised
 * commission exception, a commission settlement, a remittance, a certified
 * cash count and an open float statement - because the browser suite needs
 * the same data. So this reads `tests/e2e/harness/fixtures.json` and
 * photographs what is there.
 *
 * It makes exactly one kind of database change, at the end, and undoes it:
 * the Phase 4D-F section photographs what a screen shows when a financial
 * read *fails*, which it produces by revoking the signed-in role's SELECT on
 * one view for the length of one page load. Each revoke is paired with a
 * restore in a `finally`, and the section runs last so a crash between the
 * two cannot affect any other photograph. No row is written, read or
 * deleted.
 *
 * That means it is safe to run before the browser suite as well as after, and
 * it does not need the stack rebuilt afterwards.
 *
 *   bash tests/e2e/harness/stack.sh up
 *   source <(bash tests/e2e/harness/stack.sh env)
 *   node scripts/capture-agency-screens.mjs
 *   bash tests/e2e/harness/stack.sh down
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.SHOT_DIR ?? join(ROOT, '.e2e', 'shots', 'agency');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

mkdirSync(OUT, { recursive: true });

const fixtures = JSON.parse(
  readFileSync(join(ROOT, 'tests/e2e/harness/fixtures.json'), 'utf8'),
);

if (fixtures.agency === undefined) {
  console.error(
    'error: the harness manifest has no "agency". Re-seed the stack:\n' +
      '  bash tests/e2e/harness/stack.sh up',
  );
  process.exit(1);
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];

/**
 * Every screen the phase added, and the state of each worth photographing.
 *
 * Fifteen entries for fourteen feature items and fourteen routes, because one
 * route is photographed twice: a transaction carrying an authorised
 * commission exception and one still awaiting a second officer are the two
 * states the phase is actually about, and the second is the screen that has
 * to explain whose the next action is.
 */
const SCREENS = [
  { name: 'agency-dashboard', path: '/agency' },
  { name: 'agency-record', path: '/agency/record' },
  { name: 'agency-pending', path: '/agency/pending' },
  { name: 'agency-history', path: '/agency/history' },
  {
    name: 'agency-transaction-commission-exception',
    path: `/agency/history/${fixtures.agency.transactions.commissionException}`,
  },
  {
    name: 'agency-transaction-awaiting-verification',
    path: `/agency/history/${fixtures.agency.transactions.awaitingVerification}`,
  },
  { name: 'agency-float', path: '/agency/float' },
  { name: 'agency-float-replenish', path: '/agency/float/replenish' },
  { name: 'agency-commission', path: '/agency/commission' },
  { name: 'agency-payables', path: '/agency/payables' },
  { name: 'agency-reconciliation-cash', path: '/agency/reconciliation/cash' },
  { name: 'agency-reconciliation-float', path: '/agency/reconciliation/float' },
  { name: 'agency-reports', path: '/agency/reports' },
  { name: 'agency-exceptions', path: '/agency/exceptions' },
  { name: 'agency-providers', path: '/agency/providers' },
];

/**
 * Where Chromium is. The explicit override, then the pre-installed binary if
 * it is actually there, then Playwright's own resolution - passing a path that
 * does not exist fails with `ENOENT` and no hint.
 */
const preinstalled = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalled)
  ? preinstalled
  : chromium.executablePath();

const browser = await chromium.launch({ executablePath });

const owner = JSON.parse(readFileSync(join(ROOT, '.e2e', 'state', 'owner.json'), 'utf8'));

const timings = [];

/**
 * Screens that did not answer 200, or answered with the sign-in page.
 *
 * Counted, and the script exits non-zero at the end if any were seen - after
 * capturing everything, because the screenshot of the broken screen is the
 * useful part of the report.
 *
 * The sign-in check is not paranoia. The harness shim generates a fresh
 * signing key every time the stack comes up, so a storage state written
 * before a restart authenticates nobody afterwards - and the sign-in page
 * answers 200. This script once produced sixty photographs of a login form
 * and reported them as evidence that fifteen screens worked.
 */
const badResponses = [];

/** Whether the browser ended up at the sign-in page instead of the screen. */
const signedOut = (page) => new URL(page.url()).pathname.startsWith('/login');

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    storageState: owner,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    timezoneId: 'Africa/Kampala',
    locale: 'en-UG',
    ignoreHTTPSErrors: true,
    ...(viewport.name === 'mobile' ? { isMobile: true, hasTouch: true } : {}),
  });

  const page = await context.newPage();

  for (const screen of SCREENS) {
    // Warm, then measure: a cold Next route compiles its server component on
    // the first request, and reporting that as the page's load time would be
    // a measurement of the build rather than of the page.
    await page.goto(`${BASE}${screen.path}`, { waitUntil: 'domcontentloaded' });

    const samples = [];
    for (let run = 0; run < 3; run += 1) {
      const started = Date.now();
      const response = await page.goto(`${BASE}${screen.path}`, {
        waitUntil: 'domcontentloaded',
      });
      samples.push(Date.now() - started);
      if (response?.status() !== 200) {
        console.error(`  ! ${screen.path} returned ${String(response?.status())}`);
        badResponses.push(
          `${screen.path} (${viewport.name}) → ${String(response?.status())}`,
        );
      }
    }

    if (signedOut(page)) {
      badResponses.push(
        `${screen.path} (${viewport.name}) → redirected to the sign-in page. ` +
          'Re-run the browser suite so `auth.setup.ts` writes fresh storage states.',
      );
    }

    const median = samples.toSorted((a, b) => a - b)[1];

    // The measurement, not an eyeball: the transaction register is nine
    // columns and the reconciliation registers put a form inside a cell. At
    // 390px either scrolls the page sideways or crushes a figure.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    timings.push({
      screen: screen.name,
      viewport: viewport.name,
      medianMs: median,
      samples,
      documentOverflowPx: overflow,
    });

    const file = join(OUT, `${screen.name}-${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(
      `  ${file.replace(`${ROOT}/`, '')}  ${String(median)}ms  overflow ${String(overflow)}px`,
    );
  }

  await context.close();
}

// ---------------------------------------------------------------------------
// The states the Owner cannot photograph
// ---------------------------------------------------------------------------
//
// Three claims this phase makes about who may do what, and none of them can
// be shown from an Owner's session:
//
//   - a Secretary on a transaction awaiting verification, where the Verify
//     button is replaced by a sentence saying whose it is;
//   - a Manager on the float reconciliation, where the write-off checkbox is
//     replaced by one saying the difference is the Owner's to write off;
//   - a Secretary on the pending queue, which they may read and not act on.

const RESTRICTED = [
  {
    name: 'agency-transaction-secretary-cannot-verify',
    state: 'secretary',
    path: `/agency/history/${fixtures.agency.transactions.awaitingVerification}`,
  },
  {
    name: 'agency-pending-secretary',
    state: 'secretary',
    path: '/agency/pending',
  },
  {
    name: 'agency-reconciliation-float-manager',
    state: 'manager',
    path: '/agency/reconciliation/float',
  },
];

for (const screen of RESTRICTED) {
  const state = JSON.parse(
    readFileSync(join(ROOT, '.e2e', 'state', `${screen.state}.json`), 'utf8'),
  );

  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Africa/Kampala',
    locale: 'en-UG',
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  const response = await page.goto(`${BASE}${screen.path}`, {
    waitUntil: 'domcontentloaded',
  });

  if (response?.status() !== 200) {
    console.error(`  ! ${screen.path} returned ${String(response?.status())}`);
    badResponses.push(
      `${screen.path} (as the ${screen.state}) → ${String(response?.status())}`,
    );
  }

  if (signedOut(page)) {
    badResponses.push(
      `${screen.path} (as the ${screen.state}) → redirected to the sign-in page.`,
    );
  }

  const file = join(OUT, `${screen.name}-desktop.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${file.replace(`${ROOT}/`, '')}  as the ${screen.state}`);

  await context.close();
}

// ---------------------------------------------------------------------------
// What a failed financial read looks like
// ---------------------------------------------------------------------------
//
// The Phase 4D-F deliverable, photographed. Before it, each of these screens
// answered a failed query with "UGX 0", "No float till is registered" or
// "Nothing outstanding" - three statements about money produced by a query
// that never ran.
//
// The failure is real: the signed-in role's SELECT on the view is revoked for
// the length of one page load and restored immediately. Last in the script,
// and each revoke paired with its restore, so nothing else is photographed
// through a database that is missing a grant.

const FAILURE_SHOTS = [
  {
    name: 'agency-commission-unreadable',
    path: '/agency/commission',
    view: 'agency_commission_summary',
  },
  {
    name: 'agency-exceptions-unreadable',
    path: '/agency/exceptions',
    view: 'agency_end_of_day_exceptions',
  },
  {
    name: 'agency-float-unreadable',
    path: '/agency/float',
    view: 'agency_float_balances',
  },
];

const { Client } = require('pg');

async function withRevokedGrant(view, run) {
  if (!/^agency_[a-z_]+$/.test(view)) throw new Error(`Not an agency view: ${view}`);
  const url = process.env.E2E_DATABASE_URL;
  if (url === undefined || url === '') {
    console.error('  ! E2E_DATABASE_URL is not set; skipping the failure shots.');
    return;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`revoke select on table public.${view} from authenticated`);
    await run();
  } finally {
    await client.query(`grant select on table public.${view} to authenticated`);
    await client.end();
  }
}

for (const shot of FAILURE_SHOTS) {
  await withRevokedGrant(shot.view, async () => {
    const context = await browser.newContext({
      storageState: owner,
      viewport: { width: 1440, height: 900 },
      timezoneId: 'Africa/Kampala',
      locale: 'en-UG',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const response = await page.goto(`${BASE}${shot.path}`, {
      waitUntil: 'domcontentloaded',
    });

    // A refused read is still a rendered page: the screen's job is to say so,
    // not to fall over.
    if (response?.status() !== 200) {
      badResponses.push(`${shot.path} (read failure) → ${String(response?.status())}`);
    }

    const file = join(OUT, `${shot.name}-desktop.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  ${file.replace(`${ROOT}/`, '')}  with ${shot.view} unreadable`);

    await context.close();
  });
}

await browser.close();

writeFileSync(
  join(OUT, 'timings.json'),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), timings }, null, 2)}\n`,
);

const slowest = timings.toSorted((a, b) => b.medianMs - a.medianMs)[0];
const overflowing = timings.filter((row) => row.documentOverflowPx > 1);

console.log('');
console.log(`  ${String(timings.length)} screen/viewport pairs captured`);
console.log(
  `  slowest: ${slowest.screen} on ${slowest.viewport}, ${String(slowest.medianMs)}ms median`,
);
console.log(
  overflowing.length === 0
    ? '  no screen overflows its viewport'
    : `  ${String(overflowing.length)} screen(s) overflow: ${overflowing
        .map((row) => `${row.screen}/${row.viewport}`)
        .join(', ')}`,
);

if (badResponses.length > 0) {
  console.error('');
  console.error(`  ${String(badResponses.length)} screen(s) did not answer 200:`);
  for (const row of badResponses) console.error(`    ${row}`);
  process.exit(1);
}
