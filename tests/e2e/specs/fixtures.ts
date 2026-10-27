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
  /**
   * Polytos Phase 2. Each member is named by what they *are*, so a savings
   * spec says "the member who has served the qualifying period" rather than
   * pasting a uuid that stops meaning anything the next time the seed runs.
   *
   *   qualified      six unbroken qualifying months. Also the portal
   *                  borrower, and also holds a loan in arrears — so this is
   *                  the member who exercises the live-loan rule.
   *   gapped         six qualifying months with a gap; longest run of three.
   *   saving         on track, with a month met by two deposits, and a
   *                  withdrawal waiting for a decision.
   *   withdrawn      saved, withdrew, and had a duplicate deposit reversed.
   *   pendingConsent fee paid, consent not verified, so still `pending`.
   */
  readonly memberships: {
    readonly qualified: string;
    readonly gapped: string;
    readonly saving: string;
    readonly withdrawn: string;
    readonly pendingConsent: string;
    /**
     * Polytos Phase 3. Two members whose only loan is a member loan.
     *
     *   borrowing  six unbroken months, and a running member loan with two of
     *              its eight weekly collections made.
     *   applying   six unbroken months, and an application awaiting approval.
     *
     * Separate people from the five above, and that is not tidiness: every one
     * of those five already holds a live loan, and `active_loan_exists` refuses
     * a second live loan to anybody. A member loan could not be written against
     * any of them.
     */
    readonly borrowing: string;
    readonly applying: string;
    /**
     * Six unbroken months, and a draft the browser suite submits and
     * approves. Separate from `applying` because approving takes a pledge and
     * makes them hold a live loan, which would change what `applying`'s
     * eligibility panel says — and the read-only spec asserts that it says
     * "may borrow".
     */
    readonly approving: string;
  };
  readonly membershipNumbers: {
    readonly qualified: string;
    readonly pendingConsent: string;
    readonly borrowing: string;
  };
  readonly savings: {
    readonly qualified: string;
    readonly gapped: string;
    readonly saving: string;
    readonly withdrawn: string;
    readonly borrowing: string;
  };
  readonly savingsAccountNumbers: {
    readonly qualified: string;
    readonly withdrawn: string;
  };
  readonly withdrawals: {
    readonly paid: string;
    readonly pending: string;
  };
  /**
   * What the policy in force decides, read back from the database by the
   * seeder.
   *
   * The policy screen's two counts — how many of the nine open questions are
   * still open, and how many of the five activities are open — come from
   * generated columns. Asserting them from here means a spec checks that the
   * *screen* agrees with the database, rather than against a number somebody
   * typed into a test and then had to remember to change.
   */
  readonly policy: {
    readonly version: string;
    readonly undecidedRules: number;
    readonly activitiesOpen: number;
    readonly activitiesClosed: number;
  };
  /** Polytos Phase 3. The two clients the member loans belong to. */
  readonly memberClients: {
    readonly borrowing: string;
    readonly applying: string;
    readonly approving: string;
  };
  readonly memberLoans: {
    readonly active: string;
    readonly activeNumber: string;
    readonly draft: string;
    readonly draftNumber: string;
    readonly toApprove: string;
    readonly toApproveNumber: string;
    readonly toApprovePrincipal: number;
    readonly principal: number;
    readonly pledged: number;
    readonly installments: number;
  };
  /**
   * What the harness decided about member lending, and what it left open.
   *
   * `monthAnchor` is null on purpose: the harness answers the three policy
   * questions so the member loan screens have data, and leaves the fourth —
   * what a monthly collection does in a month that has no such day — open, so
   * the screen that names outstanding decisions still has one to name and the
   * refusal of a three-month loan can be seen. See the long note above the
   * policy INSERT in `tests/e2e/harness/seed.mjs`.
   */
  /**
   * Polytos Phase 4. Named by what each record *is*, like everything else in
   * this manifest.
   *
   *   beneficiaries.verified  checked against a document by somebody other
   *                           than the person who recorded it
   *   beneficiaries.pending   recorded and unchecked — the state the register
   *                           exists to find, because it is a bereavement
   *                           benefit that cannot be paid
   *   benefitClaims.paid      a medical claim taken the whole way: evidence
   *                           checked, assessed, approved by a second person,
   *                           paid, with a journal entry behind it
   *   benefitClaims.toApprove assessed and waiting for an approver, so the
   *                           queue is not empty and the browser suite has a
   *                           claim to approve without first building one
   *   benefitClaims.held      complete, checked, in good standing — and held,
   *                           because nobody has defined which relatives a
   *                           condolence benefit covers
   *   meetings.held           last month's, with a register, a correction,
   *                           finalised minutes and two action items
   *   meetings.upcoming       next month's, so "when is the next one" has an
   *                           answer
   */
  readonly beneficiaries: {
    readonly verified: string;
    readonly pending: string;
  };
  readonly benefitClaims: {
    readonly paid: string;
    readonly paidNumber: string;
    readonly paidAmount: number;
    readonly toApprove: string;
    readonly toApproveNumber: string;
    readonly toApproveAmount: number;
    /**
     * A second assessed claim, never written to. The browser suite approves
     * and pays `toApprove`, and Playwright runs files in parallel — so an
     * assertion that the approval queue is not empty needs a claim no spec
     * consumes.
     */
    readonly awaiting: string;
    readonly awaitingNumber: string;
    readonly held: string;
    readonly heldNumber: string;
  };
  readonly meetings: {
    readonly held: string;
    readonly heldNumber: string;
    readonly upcoming: string;
    readonly upcomingNumber: string;
    /**
     * A special meeting for the write spec to mark, write up and add an item
     * to — separate for the same reason `awaiting` is: marking the upcoming
     * monthly meeting would move it to `held` and the read spec asserting
     * "when is the next one" would depend on worker order.
     */
    readonly toWorkOn: string;
    readonly toWorkOnNumber: string;
  };
  /**
   * What the harness decided about benefits, and what it left open.
   *
   * Four illustrative answers, because `is_benefits_enabled` waits on three of
   * them and nothing could be assessed without them. They are the harness's
   * own and **not** decisions of the business — the same status the member
   * lending figures above have.
   */
  readonly benefitPolicy: {
    readonly annualCap: number;
    readonly claimsPerYear: number;
    readonly waitingDays: number;
    readonly yearBasis: string;
  };
  readonly memberLending: {
    readonly multiplierBps: number;
    readonly interestBasis: string;
    readonly interestMethod: string;
    readonly monthAnchor: string | null;
    readonly weeklyCadenceMaxMonths: number;
    readonly maxTermMonths: number;
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
