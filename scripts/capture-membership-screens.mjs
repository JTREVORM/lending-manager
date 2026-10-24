/**
 * Screenshots and timings for the membership screens.
 *
 * ## What this is, and what it is not
 *
 * It is a delivery tool: it drives the running end-to-end stack with a real
 * browser and writes a PNG per screen per viewport, plus a timing table, so a
 * reviewer can see what was built rather than read a description of it.
 *
 * It is **not** a test. Nothing here asserts anything; the assertions live in
 * `tests/e2e/specs/membership.spec.ts`, which runs in CI. A script that both
 * captured evidence and judged it would be a script nobody could trust in
 * either role.
 *
 * ## The test data it writes, and why that is legitimate
 *
 * An empty register is the honest state of the programme today, and the
 * suite asserts that honesty. But an empty register is also a poor
 * screenshot: it shows nothing about the table, the long-name handling or the
 * status presentation.
 *
 * So this enrols four **synthetic** members into the end-to-end harness
 * database — the same throwaway database `seed.mjs` fills with invented
 * clients, loans and payments — using the existing clients the seed created.
 * It is harness data in a harness database, not a sample production
 * membership record, and it never reaches a hosted project.
 *
 * It modifies that database irreversibly, so it must run **after** the
 * browser suite, and the stack must be brought down and up again before any
 * further suite run.
 *
 *   bash tests/e2e/harness/stack.sh up
 *   source <(bash tests/e2e/harness/stack.sh env)
 *   npx playwright test            # the suite, on a clean seed
 *   node scripts/capture-membership-screens.mjs
 *   bash tests/e2e/harness/stack.sh down
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client } = require('pg');
const { chromium } = require('@playwright/test');

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.env.SHOT_DIR ?? join(ROOT, '.e2e', 'shots', 'membership');
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const DB =
  process.env.E2E_DATABASE_URL ?? 'postgresql://lending@127.0.0.1:5433/lending_e2e';

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Harness membership data
// ---------------------------------------------------------------------------

const db = new Client({ connectionString: DB });
await db.connect();

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

/**
 * Put the seeded policy version in force.
 *
 * It ships as a draft because nine of its rules are undecided, so nothing can
 * be enrolled against it as shipped. Approving it here is what lets a
 * membership exist for the screenshot; `is_financially_enabled` stays false,
 * which the policy screenshot then shows truthfully.
 */
await q(`update public.membership_policy_versions
            set approved_at = pg_catalog.now(), status = 'active',
                effective_from = public.business_date() - 1
          where version = '1.0' and status = 'draft'`);

const clients = await q(
  `select id, full_name from public.clients
     where id not in (select client_id from public.memberships)
     order by client_number limit 4`,
);

if (clients.length < 4) {
  console.error('error: the harness database has fewer than four unenrolled clients.');
  process.exit(1);
}

/** Four memberships, one in each of the states a reader needs to recognise. */
const PLAN = [
  { status: 'active', reason: null },
  { status: 'active', reason: null },
  { status: 'suspended', reason: 'Monthly savings in arrears for two months.' },
  { status: 'pending', reason: null },
];

const created = [];

for (const [index, client] of clients.entries()) {
  const plan = PLAN[index];

  const [membership] = await q(
    `insert into public.memberships (client_id, applied_on)
     values ($1, current_date - $2::int)
     returning id, membership_number`,
    [client.id, 120 - index * 20],
  );

  if (plan.status !== 'pending') {
    await q(`update public.memberships set status = 'active' where id = $1`, [
      membership.id,
    ]);
  }

  if (plan.status === 'suspended') {
    await q(
      `update public.memberships set status = 'suspended', status_reason = $2
        where id = $1`,
      [membership.id, plan.reason],
    );
  }

  created.push({ ...membership, name: client.full_name, status: plan.status });
  console.log(
    `  enrolled ${membership.membership_number} — ${client.full_name} (${plan.status})`,
  );
}

await db.end();

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];

const SCREENS = [
  { name: 'membership-register', path: '/membership' },
  { name: 'membership-register-active', path: '/membership?status=active' },
  { name: 'membership-policy', path: '/membership/policies' },
  { name: 'membership-profile', path: `/membership/${created[0].id}` },
  { name: 'membership-profile-suspended', path: `/membership/${created[2].id}` },
];

const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';

const browser = await chromium.launch({ executablePath });

const state = JSON.parse(readFileSync(join(ROOT, '.e2e', 'state', 'owner.json'), 'utf8'));

const timings = [];

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
    for (let run = 0; run < 3; run += 1) {
      const started = Date.now();
      const response = await page.goto(`${BASE}${screen.path}`, {
        waitUntil: 'domcontentloaded',
      });
      samples.push(Date.now() - started);
      if (response?.status() !== 200) {
        console.error(`  ! ${screen.path} returned ${String(response?.status())}`);
      }
    }

    const median = samples.toSorted((a, b) => a - b)[1];

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
// Existing screens, for the before/after comparison the brief asks for
// ---------------------------------------------------------------------------

const EXISTING = [
  { name: 'dashboard', path: '/' },
  { name: 'client-register', path: '/clients' },
  { name: 'loan-register', path: '/loans' },
  { name: 'client-profile', path: null },
];

const context = await browser.newContext({
  storageState: state,
  viewport: { width: 1440, height: 900 },
  timezoneId: 'Africa/Kampala',
  locale: 'en-UG',
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

EXISTING[3].path = `/clients/${clients[0].id}`;

for (const screen of EXISTING) {
  await page.goto(`${BASE}${screen.path}`, { waitUntil: 'domcontentloaded' });

  const samples = [];
  for (let run = 0; run < 3; run += 1) {
    const started = Date.now();
    await page.goto(`${BASE}${screen.path}`, { waitUntil: 'domcontentloaded' });
    samples.push(Date.now() - started);
  }

  const median = samples.toSorted((a, b) => a - b)[1];
  timings.push({
    screen: screen.name,
    viewport: 'desktop',
    medianMs: median,
    samples,
    documentOverflowPx: 0,
  });

  await page.screenshot({
    path: join(OUT, `${screen.name}-desktop.png`),
    fullPage: true,
  });
  console.log(`  ${screen.name}  ${String(median)}ms`);
}

await context.close();
await browser.close();

writeFileSync(
  join(OUT, 'timings.json'),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), timings }, null, 2)}\n`,
);

console.log(`\n${String(timings.length)} measurements written to ${OUT}/timings.json`);
