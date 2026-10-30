/**
 * Screenshots and timings for the Polytos Phase 4 screens.
 *
 * ## What this is, and what it is not
 *
 * A delivery tool: it drives the running end-to-end stack with a real browser
 * and writes a PNG per screen per viewport, plus a timing table, so a reviewer
 * can see what was built rather than read a description of it.
 *
 * It is **not** a test. Nothing here asserts anything; the assertions live in
 * `tests/e2e/specs/benefits.spec.ts` and `tests/e2e/specs/meetings.spec.ts`,
 * which run in CI. A script that both captured evidence and judged it would be
 * a script nobody could trust in either role.
 *
 * ## It writes nothing
 *
 * Unlike `capture-membership-screens.mjs` and
 * `capture-member-loan-screens.mjs`, this one creates no data at all. The
 * harness seed already builds everything these screens need — four claims, two
 * beneficiaries, three meetings — because the browser suite needs the same
 * data. So this reads `tests/e2e/harness/fixtures.json` and photographs what
 * is there.
 *
 * That means it is safe to run **before** the browser suite as well as after,
 * and it does not need the stack rebuilt afterwards.
 *
 *   bash tests/e2e/harness/stack.sh up
 *   source <(bash tests/e2e/harness/stack.sh env)
 *   node scripts/capture-benefit-screens.mjs
 *   bash tests/e2e/harness/stack.sh down
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.SHOT_DIR ?? join(ROOT, '.e2e', 'shots', 'benefits');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

mkdirSync(OUT, { recursive: true });

const fixtures = JSON.parse(
  readFileSync(join(ROOT, 'tests/e2e/harness/fixtures.json'), 'utf8'),
);

for (const key of ['benefitClaims', 'beneficiaries', 'meetings']) {
  if (fixtures[key] === undefined) {
    console.error(
      `error: the harness manifest has no "${key}". Re-seed the stack:\n` +
        '  bash tests/e2e/harness/stack.sh up',
    );
    process.exit(1);
  }
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];

/**
 * Every screen the phase added, and the one state of each worth photographing.
 *
 * The claim shown twice is deliberate: a paid claim and a held one are the two
 * outcomes the phase is about, and the held one is the screen that has to
 * explain a decision nobody has made.
 */
const SCREENS = [
  { name: 'policy-transitions', path: '/membership/policies/transitions' },
  { name: 'policy-fines-register', path: '/meetings/fines' },
  { name: 'policy-fine-receipts', path: `/meetings/fines/${fixtures.fines.unpaid}` },
  { name: 'policy-loan-collections', path: `/loans/${fixtures.memberLoans.active}` },
  { name: 'benefits-dashboard', path: '/benefits' },
  { name: 'benefit-claim-register', path: '/benefits/claims' },
  { name: 'benefit-claim-register-assessed', path: '/benefits/claims?status=assessed' },
  { name: 'benefit-claim-paid', path: `/benefits/claims/${fixtures.benefitClaims.paid}` },
  {
    name: 'benefit-claim-awaiting-approval',
    path: `/benefits/claims/${fixtures.benefitClaims.awaiting}`,
  },
  {
    name: 'benefit-claim-held-undecided',
    path: `/benefits/claims/${fixtures.benefitClaims.held}`,
  },
  { name: 'benefit-claim-new', path: '/benefits/claims/new' },
  { name: 'benefit-approval-queue', path: '/benefits/approvals' },
  { name: 'benefit-payment-register', path: '/benefits/payments' },
  { name: 'benefits-report', path: '/benefits/reports' },
  { name: 'beneficiary-register', path: '/beneficiaries' },
  {
    name: 'beneficiary-verified',
    path: `/beneficiaries/${fixtures.beneficiaries.verified}`,
  },
  {
    name: 'beneficiary-unchecked',
    path: `/beneficiaries/${fixtures.beneficiaries.pending}`,
  },
  { name: 'beneficiary-new', path: '/beneficiaries/new' },
  { name: 'meetings-section', path: '/meetings' },
  { name: 'meeting-held', path: `/meetings/${fixtures.meetings.held}` },
  { name: 'meeting-upcoming', path: `/meetings/${fixtures.meetings.upcoming}` },
  { name: 'meeting-new', path: '/meetings/new' },
  // The member's own view, and the one screen on this list a borrower sees.
  {
    name: 'membership-profile-benefits',
    path: `/membership/${fixtures.memberships.qualified}`,
  },
];

/**
 * Where Chromium is.
 *
 * Two environments run this, and they put the browser in different places.
 * The container these screens were authored in has it pre-installed at
 * `/opt/pw-browsers/chromium`; a CI runner has whatever
 * `npx playwright install` downloaded, under `~/.cache/ms-playwright`, which
 * only Playwright itself knows the path to. So: the explicit override, then
 * the pre-installed binary **if it is actually there**, then Playwright's own
 * resolution. Passing a path that does not exist fails with `ENOENT` and no
 * hint, which is how this script quietly became local-only.
 */
const preinstalled = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(preinstalled)
  ? preinstalled
  : chromium.executablePath();

const browser = await chromium.launch({ executablePath });

const owner = JSON.parse(readFileSync(join(ROOT, '.e2e', 'state', 'owner.json'), 'utf8'));

const timings = [];

/**
 * Screens that did not answer 200.
 *
 * It used to be enough to print these, because a person was watching the
 * output. Now that CI runs this step and uploads the PNGs as the delivery's
 * evidence, a silent failure would publish a photograph of an error page as
 * proof the screen works. So they are counted, and the script exits non-zero
 * at the end if any were seen — after capturing everything, because the
 * screenshot of the broken screen is the useful part of the report.
 */
const badResponses = [];

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

    const median = samples.toSorted((a, b) => a - b)[1];

    // The measurement, not an eyeball: a table at 390px either scrolls the
    // page sideways or crushes a member's name.
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
// The two screens that need somebody other than the Owner
// ---------------------------------------------------------------------------
//
// A Secretary/Treasurer on a beneficiary record, where the name is withheld,
// and the borrower's own portal. Both are states the Owner cannot photograph,
// and both are claims this phase makes about who may read what.

const RESTRICTED = [
  {
    name: 'beneficiary-restricted-secretary',
    state: 'secretary',
    path: `/beneficiaries/${fixtures.beneficiaries.verified}`,
  },
  { name: 'portal-my-claims', state: 'borrower', path: '/portal' },
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

  const file = join(OUT, `${screen.name}-desktop.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${file.replace(`${ROOT}/`, '')}  as the ${screen.state}`);

  await context.close();
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
