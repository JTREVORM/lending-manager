/**
 * Screenshots and timings for the member loan screens.
 *
 * ## What this is, and what it is not
 *
 * It is a delivery tool: it drives the running end-to-end stack with a real
 * browser and writes a PNG per screen per viewport, plus a timing table, so a
 * reviewer can see what was built rather than read a description of it.
 *
 * It is **not** a test. Nothing here asserts anything; the assertions live in
 * `tests/e2e/specs/member-loans.spec.ts` and `member-loans.write.spec.ts`,
 * which run in CI. A script that both captured evidence and judged it would be
 * a script nobody could trust in either role.
 *
 * ## It writes nothing to the database, unlike its Phase 1 predecessor
 *
 * `scripts/capture-membership-screens.mjs` had to enrol four synthetic members
 * before it could photograph anything, because the register was legitimately
 * empty. This one does not: `tests/e2e/harness/seed.mjs` now seeds the member
 * loan data the browser suite asserts against, so the screens already have
 * real figures on them and this script only reads.
 *
 * Which means it can run before the suite, after it, or twice, and the
 * screenshots are of the same data the tests were run against — rather than of
 * a state only this script ever produced.
 *
 *   bash tests/e2e/harness/stack.sh up
 *   source <(bash tests/e2e/harness/stack.sh env)
 *   npx playwright test
 *   node scripts/capture-member-loan-screens.mjs
 *   bash tests/e2e/harness/stack.sh down
 *
 * ## What the screens show, and what they truthfully do not
 *
 * The harness answers the three member-lending **policy** questions with
 * illustrative figures and leaves the monthly collection anchor open. So the
 * screenshots show a programme with weekly member lending open, one decision
 * still outstanding and named, and a three-month loan refused. That is a real
 * state of the system, not a mock-up of one, and the banner in every shot says
 * which decision is missing.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.SHOT_DIR ?? join(ROOT, '.e2e', 'shots', 'member-loans');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

mkdirSync(OUT, { recursive: true });

const fixtures = JSON.parse(
  readFileSync(join(ROOT, 'tests/e2e/harness/fixtures.json'), 'utf8'),
);

if (fixtures.memberLoans === undefined) {
  console.error(
    'error: the harness manifest carries no member loan fixtures.\n' +
      '       Bring the stack up again so seed.mjs rewrites it.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The screens §23E asks for, each named by what a reader is looking at
// ---------------------------------------------------------------------------

const SCREENS = [
  {
    name: 'member-loans-dashboard',
    path: '/member-loans?tab=loans',
    about: 'The member loan book, the pipeline, and the decision still open',
  },
  {
    name: 'who-can-borrow',
    path: '/member-loans',
    about: 'Every live membership, its qualifying months, and what its savings support',
  },
  {
    name: 'member-loan-application',
    path: `/member-loans/new?client=${fixtures.memberClients.applying}`,
    about: 'The application, with the eligibility it was assessed against',
    // Fill the amount so the repayment preview has something to price. Typed
    // rather than set, because the preview is driven by the field's own change
    // handler and a value assigned around it would photograph an empty table.
    fill: { amount: '200000', term: '2' },
  },
  {
    name: 'repayment-preview',
    path: `/member-loans/new?client=${fixtures.memberClients.applying}`,
    about: 'What the member would owe, month by month — the contract, not the dates',
    fill: { amount: '400000', term: '2' },
    scrollTo: 'What it would cost',
  },
  {
    name: 'application-refused-cadence',
    path: `/member-loans/new?client=${fixtures.memberClients.applying}`,
    about: 'A three-month term, refused because the monthly anchor is undecided',
    fill: { amount: '200000', term: '3' },
  },
  {
    name: 'loan-eligibility-panel',
    path: `/membership/${fixtures.memberships.applying}`,
    about: 'The assessment on the member’s own record — may borrow',
    scrollTo: 'Member loan eligibility',
  },
  {
    name: 'loan-eligibility-panel-refused',
    path: `/membership/${fixtures.memberships.borrowing}`,
    about: 'The same panel for a member who already holds a live loan',
    scrollTo: 'Member loan eligibility',
  },
  {
    name: 'member-loan-details',
    path: `/loans/${fixtures.memberLoans.active}`,
    about: 'The member loan, on the loan screen every loan opens on',
    scrollTo: 'Lent against a membership',
  },
  {
    name: 'member-loan-approval',
    path: `/loans/${fixtures.memberLoans.draft}`,
    about: 'An application awaiting a decision, with the membership panel on it',
  },
  {
    name: 'membership-policy-decisions',
    path: '/membership/policies',
    about: 'The rules that are settled, and the ones that are not',
  },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];

const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch({ executablePath });
const state = JSON.parse(readFileSync(join(ROOT, '.e2e', 'state', 'owner.json'), 'utf8'));

const timings = [];
let failures = 0;

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    storageState: state,
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
    // first request, and reporting that as the page's load time would be a
    // measurement of the build rather than of the page.
    await page.goto(`${BASE}${screen.path}`, { waitUntil: 'domcontentloaded' });

    const samples = [];
    let status = 0;

    for (let run = 0; run < 3; run += 1) {
      const started = Date.now();
      const response = await page.goto(`${BASE}${screen.path}`, {
        waitUntil: 'domcontentloaded',
      });
      samples.push(Date.now() - started);
      status = response?.status() ?? 0;
    }

    if (status !== 200) {
      failures += 1;
      console.error(`  ! ${screen.path} returned ${String(status)}`);
    }

    const median = samples.toSorted((a, b) => a - b)[1];

    if (screen.fill !== undefined) {
      await page.getByLabel('Amount applied for').fill(screen.fill.amount);
      await page.getByLabel('Loan term').selectOption(screen.fill.term);
      // The preview re-renders from the field's change handler; give it the
      // tick it needs rather than photographing a half-updated table.
      await page.waitForTimeout(400);
    }

    if (screen.scrollTo !== undefined) {
      await page
        .getByText(screen.scrollTo)
        .filter({ visible: true })
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
      await page.waitForTimeout(200);
    }

    // Asked of the document rather than judged from the picture: a page that
    // scrolls sideways hides the column the figure is in, and a counter uses
    // the phone one-handed.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    if (overflow > 1) {
      failures += 1;
      console.error(
        `  ! ${screen.path} at ${viewport.name} overflows by ${String(overflow)}px`,
      );
    }

    timings.push({
      screen: screen.name,
      viewport: viewport.name,
      medianMs: median,
      samples,
      documentOverflowPx: overflow,
      status,
    });

    const file = join(OUT, `${screen.name}-${viewport.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(
      `  ${file.replace(`${ROOT}/`, '')}  ${String(median)}ms  overflow ${String(overflow)}px`,
    );
  }

  await context.close();
}

await browser.close();

writeFileSync(
  join(OUT, 'timings.json'),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), timings }, null, 2)}\n`,
);

// A markdown table, because that is what goes into the delivery report.
const rows = timings
  .filter((entry) => entry.viewport === 'desktop' || entry.viewport === 'mobile')
  .map(
    (entry) =>
      `| ${entry.screen} | ${entry.viewport} | ${String(entry.medianMs)} ms | ` +
      `${String(entry.documentOverflowPx)} px |`,
  );

writeFileSync(
  join(OUT, 'timings.md'),
  [
    '| Screen | Viewport | Median load | Horizontal overflow |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'),
);

console.log(`\n${String(timings.length)} screenshots written to ${OUT}`);
console.log(`timings: ${join(OUT, 'timings.md')}`);

if (failures > 0) {
  console.error(`\n${String(failures)} screen(s) did not render cleanly.`);
  process.exit(1);
}
