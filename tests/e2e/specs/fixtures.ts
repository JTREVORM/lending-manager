import { test as base, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What every spec shares: the seeded accounts, the seeded loans, and a way to
 * sign in as one of four people.
 *
 * The manifest is written by `tests/e2e/harness/seed.mjs`, so a spec names a
 * loan by what it *is* — "the loan in arrears" — rather than by a uuid pasted
 * into a test that stops meaning anything the next time the seed runs.
 */

export interface Fixtures {
  readonly staff: {
    readonly owner: string;
    readonly manager: string;
    readonly secretary: string;
    readonly temporaryPassword: string;
  };
  readonly borrower: string;
  readonly clients: { readonly arrears: string; readonly current: string };
  readonly loans: {
    readonly current: string;
    readonly arrears: string;
    readonly charged: string;
    readonly grace: string;
    readonly pending: string;
    readonly draft: string;
    readonly approvedNotDisbursed: string;
  };
}

export const fixtures: Fixtures = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/e2e/harness/fixtures.json'), 'utf8'),
) as Fixtures;

/** The one password every seeded account holds. Synthetic; local only. */
export const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';

export type Who = 'owner' | 'manager' | 'secretary' | 'borrower';

/** Where `auth.setup.ts` leaves each role's signed-in browser storage. */
export function stateFile(who: Who): string {
  return join(process.cwd(), '.e2e/state', `${who}.json`);
}

/**
 * Empty the rate-limit counters.
 *
 * Used by the setup project, and by the spec that deliberately exhausts the
 * sign-in budget. This is not a test weakening anything: the limiter's own
 * spec asserts that the limit trips, and clearing a counter between spec
 * files only stops one file's spending from throttling the next. It talks to
 * PostgreSQL directly because the table is correctly unreachable through the
 * API — RLS is on with no policies and every grant is revoked.
 */
export async function resetRateLimits(): Promise<void> {
  const url = process.env.E2E_DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'E2E_DATABASE_URL is not set; source tests/e2e/harness/stack.sh env.',
    );
  }

  const require = createRequire(join(process.cwd(), 'package.json'));
  const { Client } = require('pg') as {
    Client: new (c: { connectionString: string }) => {
      connect(): Promise<void>;
      query(sql: string): Promise<unknown>;
      end(): Promise<void>;
    };
  };

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('truncate table public.rate_limit_counters');
  } finally {
    await client.end();
  }
}

export async function signIn(page: Page, who: Who): Promise<void> {
  const phone = who === 'borrower' ? fixtures.borrower : fixtures.staff[who];

  await page.goto('/login');
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // The sign-in redirect is the staff shell for staff and the portal for a
  // borrower. Waiting on the URL rather than on a heading keeps this honest:
  // a page that renders an error boundary still has a heading.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 20_000,
  });
}

export async function signOut(page: Page): Promise<void> {
  // There is more than one sign-out control in the document at once — the
  // staff rail carries one under the signed-in person and the phone header
  // carries its own, because below `md` the rail is a closed drawer. Only one
  // of them is ever on screen, so this picks the visible one rather than
  // asserting which shell is rendered.
  const visible = page.getByRole('button', { name: /sign out/i }).filter({
    visible: true,
  });

  if ((await visible.count()) === 0) {
    // Nothing on screen: the control is inside the drawer. Open it.
    await page.getByRole('button', { name: /main menu/i }).click();
  }

  await visible.first().click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
}

/**
 * Asserts the page rendered rather than fell over.
 *
 * This is the assertion that would have caught the Phase 8 defect where every
 * authenticated page rendered an error boundary: each page still returned 200,
 * still had a `<title>`, and still had a heading — the heading just said
 * "Something went wrong".
 */
export async function expectNoErrorBoundary(page: Page): Promise<void> {
  await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  await expect(page.getByText(/application error/i)).toHaveCount(0);
  await expect(page.getByText(/unhandled runtime error/i)).toHaveCount(0);
}

/** Collects console errors and failed requests for a whole spec file. */
export function watchForBrowserErrors(page: Page): { readonly errors: string[] } {
  const errors: string[] = [];

  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      // A 401 on the auth endpoint is the deliberate subject of the
      // wrong-password test, and the browser logs it whatever we do.
      if (!/Failed to load resource.*40[13]/.test(text)) {
        errors.push(`console: ${text}`);
      }
    }
  });

  return { errors };
}

export const test = base;
export { expect };
