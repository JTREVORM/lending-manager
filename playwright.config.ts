import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * The browser tests.
 *
 * ## Why these exist
 *
 * Phases 1–8 shipped 2,584 passing tests, a clean typecheck and a clean lint,
 * and three defects that every one of them missed: every authenticated page
 * rendered an error boundary, `/users` returned a 500, and no payment could be
 * recorded at all. None of the three is visible from a unit test, because none
 * of them is a unit: the first was a Tailwind token that emitted no CSS, the
 * second a PostgREST relationship ambiguity, the third a multi-step form that
 * unmounted its own inputs. Each needed a browser, a real HTTP server and a
 * real database to show itself.
 *
 * So these tests drive the production build against a real PostgreSQL with
 * every migration applied, the real PostgREST binary, and synthetic data —
 * `tests/e2e/harness/stack.sh`. They are slow and few, and they cover the
 * paths where a failure means the business cannot operate: signing in,
 * registering a client, taking a loan to disbursement, recording a payment,
 * reversing it, and reading the reports.
 *
 * ## Running them
 *
 *   tests/e2e/harness/stack.sh up
 *   source <(tests/e2e/harness/stack.sh env)
 *   npx playwright test
 *   tests/e2e/harness/stack.sh down
 *
 * They are deliberately not in `npm test`: that must stay runnable without a
 * database, and these need one. `npm run test:e2e` runs them against a stack
 * that is already up.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * The browser binary.
 *
 * This sandbox ships a Chromium under `PLAYWRIGHT_BROWSERS_PATH` whose build
 * number need not match the one the installed `@playwright/test` would fetch,
 * and it has no network to fetch another. Pointing at the provided binary is
 * what makes these tests runnable here; where a matching download exists,
 * `E2E_CHROMIUM` is unset and Playwright resolves its own.
 */
const executablePath = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = existsSync(executablePath) ? { launchOptions: { executablePath } } : {};

export default defineConfig({
  testDir: './tests/e2e/specs',
  outputDir: './.e2e/playwright',

  // Each spec signs in, writes to the database and reads it back. Parallel
  // workers would race over the same seeded loans — the money is shared
  // state, so the tests are serial.
  fullyParallel: false,
  workers: 1,

  // A flake here is a defect: everything these tests talk to is local and
  // deterministic. Retrying would hide the defect rather than report it.
  retries: 0,
  forbidOnly: !!process.env.CI,

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL,
    // The harness serves the application over plain HTTP on loopback; its
    // own certificate is only used for the auth shim, which Node trusts via
    // NODE_EXTRA_CA_CERTS. The browser never speaks to the shim directly.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Uganda. The dates on every screen are the business timezone's dates,
    // and a test running in UTC would read yesterday's.
    timezoneId: 'Africa/Kampala',
    locale: 'en-UG',
  },

  projects: [
    {
      // Signs each role in once and saves its storage state. Everything else
      // depends on this, because the sign-in limiter is deliberately tight
      // and a suite that signed in per test would exhaust it.
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'], ...browser },
    },
    {
      // 1440×900 — the counter laptop.
      name: 'desktop',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        ...browser,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      // 390×844 — the phone the field officer actually carries. §5 of Phase 9
      // exists because this viewport was never tested.
      name: 'mobile',
      dependencies: ['setup'],
      use: {
        ...devices['Pixel 7'],
        ...browser,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
      // The write flows are asserted once, on the desktop project; the mobile
      // project covers layout, navigation and reachability. Running every
      // write twice would double the money in the seeded database.
      testIgnore: [/\.write\.spec\.ts$/, /auth\.setup\.ts$/],
    },
  ],
});
