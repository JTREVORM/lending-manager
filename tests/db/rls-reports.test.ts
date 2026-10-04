import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asServiceRole,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  createLoanScenario,
  deleteTestLoans,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { deleteTestPayments, postPayment } from '../helpers/payment-fixtures';
import {
  businessInstant,
  createFourThousandLoan,
  deleteTestPenalties,
  ensurePenalty,
  restoreSeededLendingTerms,
  type FourThousandLoan,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * Row Level Security on the reporting views.
 *
 * ## The attack this suite is written against
 *
 * A reporting view is the most valuable object in this schema to anybody who
 * should not have it: one SELECT that returns every borrower's position,
 * every payment taken, and the whole book's outstanding balance. If any of
 * the five ran as its owner, that is exactly what it would return — to a
 * borrower, to a signed-in staff member with no capability, to anyone holding
 * a token.
 *
 * So every assertion here is about *what comes back*, under a real role, from
 * a view with real rows behind it. A test against an empty table proves
 * nothing, so the fixtures build two borrowers with real loans, real payments
 * and a real charge before a single attack is attempted.
 *
 * ## Why a borrower can read these views at all
 *
 * They are `security_invoker`, so a borrower reading `payment_register` sees
 * their own payments through the ownership clause in the policy on
 * `loan_payments` — the same arrangement every phase since Phase 4 has used.
 * The aggregate views are the interesting case: a borrower reading
 * `dashboard_portfolio_summary` gets an aggregate over their own rows, not
 * over the business. That is checked here rather than assumed.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('reporting row level security suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const REPORTING_VIEWS = [
  'payment_register',
  'collections_today',
  'loan_portfolio_report',
  'dashboard_portfolio_summary',
  'dashboard_collection_summary',
] as const;

/** The views with one row per loan or payment, where row isolation is testable. */
const ROW_VIEWS = ['payment_register', 'loan_portfolio_report'] as const;

describeDb('reporting row level security', () => {
  let scenario: LoanScenario;
  let otherScenario: LoanScenario;
  let borrower: TestUser;
  let otherBorrower: TestUser;
  let unprivileged: TestUser;

  let ownLoan: FourThousandLoan;
  let otherLoan: FourThousandLoan;
  let ownPaymentId: string;
  let otherPaymentId: string;

  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();

    scenario = await createLoanScenario();
    otherScenario = await createLoanScenario();

    borrower = await createTestUser('client');
    otherBorrower = await createTestUser('client');
    // A signed-in person holding a login and no capability at all.
    unprivileged = await createTestUser('client');

    await query(`select public.link_client_profile($1, $2)`, [
      scenario.clientId,
      borrower.profileId,
    ]);
    await query(`select public.link_client_profile($1, $2)`, [
      otherScenario.clientId,
      otherBorrower.profileId,
    ]);

    ownLoan = await createFourThousandLoan(scenario);
    otherLoan = await createFourThousandLoan(otherScenario);

    ownPaymentId = await postPayment(ownLoan.loanId, scenario.secretary, {
      amount: 4_000,
      businessNow: businessInstant(ownLoan.firstDue),
    });
    otherPaymentId = await postPayment(otherLoan.loanId, otherScenario.secretary, {
      amount: 4_000,
      businessNow: businessInstant(otherLoan.firstDue),
    });

    // A real charge on the other borrower's loan, so there is something worth
    // stealing rather than an empty penalty table.
    await ensurePenalty(otherLoan.loanId, businessInstant(otherLoan.penaltyEffective));
  }, 180_000);

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    await restoreSeededLendingTerms();
    await closePool();
  });

  // =========================================================================
  describe('an anonymous visitor', () => {
    it.each([...REPORTING_VIEWS])('reads nothing from %s', async (view) => {
      const result = await asAnon(`select * from public.${view}`);

      // Either refused outright or filtered to nothing. Both are closed; what
      // must never happen is a row coming back.
      expect(result.rows, view).toEqual([]);
    });

    it('cannot count what it cannot read', async () => {
      // A count leaks the size of the book even when no row comes back, so it
      // is checked separately from the SELECT.
      for (const view of ROW_VIEWS) {
        const result = await asAnon(`select count(*)::text as n from public.${view}`);
        expect(result.ok ? Number(result.rows[0]?.n ?? 0) : 0, view).toBe(0);
      }
    });

    it('cannot reach a payment by naming it', async () => {
      const result = await asAnon(
        `select * from public.payment_register where payment_id = $1`,
        [ownPaymentId],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot read the business-wide totals', async () => {
      // The single most attractive single row in the schema: the whole book's
      // outstanding balance in one SELECT.
      const result = await asAnon(
        `select total_outstanding, total_collected, principal_disbursed
           from public.dashboard_portfolio_summary`,
      );

      expect(result.rows).toEqual([]);
    });
  });

  // =========================================================================
  describe('a borrower', () => {
    it('reads their own payments and nothing else', async () => {
      const result = await asUser(
        borrower,
        `select payment_id::text, loan_id::text from public.payment_register`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows.map((row) => row.payment_id)).toEqual([ownPaymentId]);
    });

    it('cannot read another borrower"s payment by naming it', async () => {
      const result = await asUser(
        borrower,
        `select * from public.payment_register where payment_id = $1`,
        [otherPaymentId],
      );

      expect(result.rows).toEqual([]);
    });

    it('cannot widen the result by dropping the filter', async () => {
      // The attack that catches a policy written as a convenience rather than
      // as a boundary: ask for everything and see what the database admits.
      const result = await asUser(
        borrower,
        `select loan_id::text from public.loan_portfolio_report`,
      );

      expect(result.rows.map((row) => row.loan_id)).toEqual([ownLoan.loanId]);
    });

    it('cannot read another borrower"s loan position by naming it', async () => {
      const result = await asUser(
        borrower,
        `select * from public.loan_portfolio_report where loan_id = $1`,
        [otherLoan.loanId],
      );

      expect(result.rows).toEqual([]);
    });

    it('sees only their own loan on the collection sheet', async () => {
      const result = await asUser(
        borrower,
        `select loan_id::text from public.collections_today`,
      );

      for (const row of result.rows) {
        expect(row.loan_id).toBe(ownLoan.loanId);
      }
    });

    it('summarises only their own rows, never the business', async () => {
      // This is the aggregate case, and the one a reader might assume is safe
      // because "it is only a total". A view that ran as its owner would hand
      // a borrower the whole portfolio in a single number.
      const mine = await asUser(
        borrower,
        `select total_clients::text, loans_total::text, total_outstanding::text,
                principal_disbursed::text
           from public.dashboard_portfolio_summary`,
      );

      expect(mine.ok).toBe(true);
      const row = mine.rows[0] as Record<string, string>;

      // One client (themselves) and one loan (theirs) — not the two borrowers
      // and two loans this suite created.
      expect(row.total_clients).toBe('1');
      expect(row.loans_total).toBe('1');

      const whole = await query<{ total: string; disbursed: string }>(
        `select total_outstanding::text as total, principal_disbursed::text as disbursed
           from public.dashboard_portfolio_summary`,
      );

      expect(Number(row.total_outstanding)).toBeLessThan(Number(whole[0]?.total ?? '0'));
      expect(Number(row.principal_disbursed)).toBeLessThan(
        Number(whole[0]?.disbursed ?? '0'),
      );
    });

    it('sees no charge belonging to another borrower', async () => {
      const result = await asUser(
        borrower,
        `select penalty_assessed::text from public.dashboard_portfolio_summary`,
      );

      // The only charge in the fixture is on the other borrower's loan.
      expect((result.rows[0] as Record<string, string>).penalty_assessed).toBe('0');
    });

    it('cannot write to a reporting view', async () => {
      for (const view of ROW_VIEWS) {
        const insert = await asUser(
          borrower,
          `insert into public.${view} default values`,
        );
        expect(insert.ok, `${view} insert`).toBe(false);

        const update = await asUser(borrower, `update public.${view} set loan_id = null`);
        expect(update.ok, `${view} update`).toBe(false);

        const remove = await asUser(borrower, `delete from public.${view}`);
        expect(remove.ok, `${view} delete`).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('a signed-in user with no capabilities', () => {
    it.each([...ROW_VIEWS])('reads no row from %s', async (view) => {
      // Not linked to any client and holding no capability: there is nothing
      // this account is entitled to, so the view returns nothing rather than
      // erroring. An empty result is the correct shape — the existence of the
      // rows is not theirs to know either.
      const result = await asUser(unprivileged, `select * from public.${view}`);

      expect(result.rows, view).toEqual([]);
    });

    it('summarises nothing at all', async () => {
      const result = await asUser(
        unprivileged,
        `select total_clients::text, loans_total::text, total_outstanding::text,
                total_collected::text, arrears_total::text
           from public.dashboard_portfolio_summary`,
      );

      const row = result.rows[0] as Record<string, string>;

      // Zeroes, from an aggregate over no visible rows. Not the business's
      // figures, and not an error that would tell them the rows exist.
      expect(row.total_clients).toBe('0');
      expect(row.loans_total).toBe('0');
      expect(row.total_outstanding).toBe('0');
      expect(row.total_collected).toBe('0');
      expect(row.arrears_total).toBe('0');
    });

    it('sees nothing due today', async () => {
      const result = await asUser(
        unprivileged,
        `select expected_today::text, collected_today::text, loans_due_today::text
           from public.dashboard_collection_summary`,
      );

      const row = result.rows[0] as Record<string, string>;
      expect(row.expected_today).toBe('0');
      expect(row.collected_today).toBe('0');
      expect(row.loans_due_today).toBe('0');
    });
  });

  // =========================================================================
  describe('staff', () => {
    it('reads the whole book, which is what the capability is for', async () => {
      const result = await asUser(
        scenario.secretary,
        `select loan_id::text from public.loan_portfolio_report order by loan_id`,
      );

      const ids = result.rows.map((row) => row.loan_id);
      expect(ids).toContain(ownLoan.loanId);
      expect(ids).toContain(otherLoan.loanId);
    });

    it('reads every payment in the register', async () => {
      const result = await asUser(
        scenario.manager,
        `select payment_id::text from public.payment_register`,
      );

      const ids = result.rows.map((row) => row.payment_id);
      expect(ids).toContain(ownPaymentId);
      expect(ids).toContain(otherPaymentId);
    });

    it('cannot write to a reporting view either', async () => {
      // There is no write grant on a view for any session role, so the Owner
      // is refused in exactly the same way a borrower is. A report is a
      // reading surface, and §102 asks for that to be structural.
      for (const view of REPORTING_VIEWS) {
        const update = await asUser(
          scenario.owner,
          `update public.${view} set business_date = current_date`,
        );
        expect(update.ok, `${view} update`).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('the privileged client', () => {
    it('can read the reporting views, which is why nothing reaches it from a browser', async () => {
      // `service_role` bypasses Row Level Security by design. The protection
      // is that the secret key never leaves the server — asserted by the
      // client-bundle scan — not that the role is restricted. Stated here so
      // the posture is explicit rather than assumed.
      const result = await asServiceRole(
        `select count(*)::text as n from public.payment_register`,
      );

      expect(result.ok).toBe(true);
      expect(Number((result.rows[0] as Record<string, string>).n)).toBeGreaterThan(0);
    });

    it('still cannot write to a view', async () => {
      const result = await asServiceRole(
        `update public.loan_portfolio_report set total_outstanding = 0`,
      );

      expect(result.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('the reporting capabilities', () => {
    it('grants each one to exactly the intended roles', async () => {
      // The same matrix `tests/unit/permissions.test.ts` asserts in
      // TypeScript, checked here where it is actually enforced. The two
      // representations cannot drift apart.
      const rows = await query<{ permission_key: string; roles: string }>(
        `select rp.permission_key, string_agg(rp.role_key, ',' order by rp.role_key) as roles
           from public.role_permissions rp
          where rp.permission_key like 'reports:%'
          group by rp.permission_key
          order by rp.permission_key`,
      );

      expect(rows).toEqual([
        {
          permission_key: 'reports:view_financial',
          roles: 'manager,owner_admin',
        },
        {
          permission_key: 'reports:view_operational',
          roles: 'manager,owner_admin,secretary_treasurer',
        },
        { permission_key: 'reports:view_sensitive', roles: 'owner_admin' },
      ]);
    });

    it('declares a description for each, so an administrator knows what it opens', async () => {
      const rows = await query<{ key: string; description: string }>(
        `select key, description from public.permissions
          where key like 'reports:%' order by key`,
      );

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.description.length, row.key).toBeGreaterThan(20);
      }
    });

    it('creates no capability that would let anybody change a report', async () => {
      // §102 and §139: Phase 8 is a reading phase. A capability that does not
      // exist cannot be granted by mistake, which is the argument Phases 5, 6
      // and 7 each made about their own write verbs.
      const rows = await query<{ key: string }>(
        `select key from public.permissions
          where key like 'reports:%'
            and key not like '%view%'`,
      );

      expect(rows).toEqual([]);
    });
  });
});
