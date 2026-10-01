import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  submitLoan,
} from '../helpers/loan-fixtures';
import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

/**
 * The loan engine under genuine concurrency.
 *
 * Every test here opens real parallel connections holding real transactions.
 * Nothing is simulated: there is no way to test a race by calling a function
 * twice in sequence, and the failure modes are the expensive kind — a client
 * with two active loans, a loan approved twice with two sets of snapshots, or
 * two loans sharing a number.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * Run one statement as a signed-in user, on its own connection, committed.
 *
 * A race needs two connections holding transactions open at the same time,
 * which the shared autocommitting pool cannot provide.
 */
async function raceAs(
  authUserId: string,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');
    await client.query(sql, [...params]);
    await client.query('reset role');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

describeDb('loans under concurrency', () => {
  beforeAll(async () => {
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('loan numbering', () => {
    it('issues 40 unique, correctly formatted numbers to 40 parallel drafts', async () => {
      const own = await createLoanScenario();
      const COUNT = 40;

      const results = await Promise.all(
        Array.from({ length: COUNT }, () =>
          queryOne<{ loan_number: string }>(
            `insert into public.loans (client_id, principal_amount, interest_rate_bps,
                interest_method, loan_term_months, repayment_frequency,
                min_loan_amount_applied, grace_period_days_applied,
                penalty_rate_bps_applied, proposed_disbursement_date)
              values ($1, 300000, 1500, 'reducing_balance_monthly', 1, 'daily',
                      100000, 3, 5000, current_date)
              returning loan_number`,
            [own.clientId],
          ),
        ),
      );

      const numbers = results.map((row) => row.loan_number);

      // Unique is the financially essential property: two loans sharing a
      // number would mean two agreements indistinguishable on paper.
      expect(new Set(numbers).size).toBe(COUNT);

      for (const number of numbers) {
        expect(number).toMatch(/^LN\d{6}$/);
      }
    });

    it('uses the configured prefix, padding and the current year', async () => {
      const own = await createLoanScenario();

      const row = await queryOne<{ loan_number: string }>(
        `insert into public.loans (client_id, principal_amount, interest_rate_bps,
            interest_method, loan_term_months, repayment_frequency,
            min_loan_amount_applied, grace_period_days_applied,
            penalty_rate_bps_applied, proposed_disbursement_date)
          values ($1, 300000, 1500, 'reducing_balance_monthly', 1, 'daily',
                  100000, 3, 5000, current_date)
          returning loan_number`,
        [own.clientId],
      );

      const format = await queryOne<{ prefix: string; padding: number }>(
        `select prefix, padding from public.reference_formats where scope = 'loan'`,
      );

      const year = await queryOne<{ yy: string }>(
        `select to_char((now() at time zone 'Africa/Kampala'), 'YY') as yy`,
      );

      expect(row.loan_number.startsWith(format.prefix)).toBe(true);
      expect(row.loan_number.slice(2, 4)).toBe(year.yy);
      expect(row.loan_number).toHaveLength(2 + 2 + format.padding);
    });
  });

  // =========================================================================
  describe('the one-active-loan rule', () => {
    /**
     * The mandatory test.
     *
     * Two valid approved loans for one client, disbursed from two connections
     * at the same moment. Without the advisory lock in
     * `loans_enforce_active_limit`, both would count zero active loans and
     * both would proceed — and the client would end up with two active loans,
     * which is the invariant the business cares most about.
     */
    it('lets exactly one of two parallel disbursements succeed', async () => {
      const own = await createLoanScenario();

      const first = await createDraftLoan(own.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await approveLoan(first, own);

      const second = await createDraftLoan(own.clientId, {
        principal: 400_000,
        termMonths: 1,
      });
      await approveLoan(second, own);

      const outcomes = await Promise.allSettled([
        raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [first]),
        raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [second]),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The refusal names the rule rather than surfacing a constraint name.
      const failure = rejected[0]!;
      expect(String((failure.reason as Error).message)).toMatch(
        /already has 1 active loan\(s\); the limit is 1/,
      );

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.loans
          where client_id = $1 and status = 'active'`,
        [own.clientId],
      );

      expect(row.count).toBe('1');
    });

    it('holds for four simultaneous attempts, not just two', async () => {
      const own = await createLoanScenario();

      const loanIds: string[] = [];

      for (let index = 0; index < 4; index += 1) {
        const loanId = await createDraftLoan(own.clientId, {
          principal: 300_000 + index,
          termMonths: 1,
        });
        await approveLoan(loanId, own);
        loanIds.push(loanId);
      }

      const outcomes = await Promise.allSettled(
        loanIds.map((loanId) =>
          raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
        1,
      );

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.loans
          where client_id = $1 and status = 'active'`,
        [own.clientId],
      );
      expect(row.count).toBe('1');
    });

    it('enforces the configured limit rather than a hard-coded one', async () => {
      // The setting is honoured at whatever value it holds. This is why the
      // rule is a trigger with an advisory lock and not a partial unique
      // index: an index would enforce exactly one and make the setting a lie
      // the moment anybody raised it.
      const own = await createLoanScenario();

      await query(
        `update public.business_settings set max_active_loans_per_client = 2 where id = 1`,
      );

      try {
        const loanIds: string[] = [];

        for (let index = 0; index < 3; index += 1) {
          const loanId = await createDraftLoan(own.clientId, {
            principal: 300_000 + index,
            termMonths: 1,
          });
          await approveLoan(loanId, own);
          loanIds.push(loanId);
        }

        const outcomes = await Promise.allSettled(
          loanIds.map((loanId) =>
            raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
          ),
        );

        // Two, because the setting says two.
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
          2,
        );

        const row = await queryOne<{ count: string }>(
          `select count(*)::text as count from public.loans
            where client_id = $1 and status = 'active'`,
          [own.clientId],
        );
        expect(row.count).toBe('2');
      } finally {
        await query(
          `update public.business_settings set max_active_loans_per_client = 1 where id = 1`,
        );
      }
    });

    it('fires on a direct UPDATE, not only through the function', async () => {
      const own = await createLoanScenario();

      // Both approved *before* either is disbursed. The rule is also checked
      // at approval, so approving the second after the first went active
      // would be refused there — which is correct, and would stop this test
      // reaching the thing it is about.
      const first = await createDraftLoan(own.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await approveLoan(first, own);

      const second = await createDraftLoan(own.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await approveLoan(second, own);

      await raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [first]);

      // Bypassing `disburse_loan` gains nothing: the trigger is on the table,
      // so any path to `status = 'active'` takes the lock and counts.
      await expect(
        raceAs(
          own.owner.authUserId,
          `update public.loans set status = 'active' where id = $1`,
          [second],
        ),
      ).rejects.toThrow(/already has 1 active loan/);
    });

    it('is also checked at approval, not only at disbursement', async () => {
      const own = await createLoanScenario();

      const first = await createDraftLoan(own.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await approveLoan(first, own);
      await raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [first]);

      const second = await createDraftLoan(own.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await submitLoan(second, own);

      // Catching it here means a reviewer is told why rather than approving a
      // loan that can never be disbursed.
      await expect(
        raceAs(own.owner.authUserId, `select public.approve_loan($1)`, [second]),
      ).rejects.toThrow(/active_loan_exists/);
    });

    it('does not make loans for different clients contend', async () => {
      // The lock is keyed on the client, so two counters serving two
      // different borrowers do not block each other.
      const first = await createLoanScenario();
      const second = await createLoanScenario();

      const firstLoan = await createDraftLoan(first.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await approveLoan(firstLoan, first);

      const secondLoan = await createDraftLoan(second.clientId, {
        principal: 300_000,
        termMonths: 1,
      });
      await approveLoan(secondLoan, second);

      const outcomes = await Promise.allSettled([
        raceAs(first.owner.authUserId, `select public.disburse_loan($1)`, [firstLoan]),
        raceAs(second.owner.authUserId, `select public.disburse_loan($1)`, [secondLoan]),
      ]);

      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    });
  });

  // =========================================================================
  describe('racing approvals', () => {
    it('lets exactly one of two parallel approvals succeed', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      const outcomes = await Promise.allSettled([
        raceAs(own.manager.authUserId, `select public.approve_loan($1)`, [loanId]),
        raceAs(own.owner.authUserId, `select public.approve_loan($1)`, [loanId]),
      ]);

      // The row lock inside `approve_loan` serialises them: the second blocks,
      // then finds the loan is no longer awaiting approval.
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
        1,
      );

      // And exactly one set of snapshots. A double approval would otherwise
      // produce two client snapshots for one loan, which the unique primary
      // key on `loan_client_snapshots` also refuses.
      const counts = await queryOne<{ periods: string; snaps: string }>(
        `select
           (select count(*) from public.loan_periods where loan_id = $1)::text as periods,
           (select count(*) from public.loan_client_snapshots where loan_id = $1)::text as snaps`,
        [loanId],
      );

      expect(counts.periods).toBe('3');
      expect(counts.snaps).toBe('1');
    });

    it('records one approval audit event, not two', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      await Promise.allSettled([
        raceAs(own.manager.authUserId, `select public.approve_loan($1)`, [loanId]),
        raceAs(own.owner.authUserId, `select public.approve_loan($1)`, [loanId]),
      ]);

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.approved'`,
        [loanId],
      );

      expect(row.count).toBe('1');
    });
  });

  // =========================================================================
  describe('racing disbursements of one loan', () => {
    it('lets exactly one succeed', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const outcomes = await Promise.allSettled([
        raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
        raceAs(own.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(
        1,
      );

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.disbursed'`,
        [loanId],
      );
      expect(row.count).toBe('1');
    });
  });

  // =========================================================================
  describe('a settings change during approval', () => {
    it('uses one coherent set of settings, not a mixture', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 600_000,
        termMonths: 3,
      });
      await submitLoan(loanId, own);

      // Approve while the rate is being changed. Whichever rate the approval
      // reads, the stored rate and the stored totals must agree with each
      // other — a loan priced at 15% with totals computed at 12% would be a
      // contradiction nobody could reconcile later.
      await Promise.allSettled([
        raceAs(own.owner.authUserId, `select public.approve_loan($1)`, [loanId]),
        query(
          `update public.business_settings
              set default_monthly_interest_rate_bps = 1200 where id = 1`,
        ),
      ]);

      try {
        const row = await queryOne<{
          status: string;
          rate: number;
          total_interest: string;
          recomputed: string;
        }>(
          `select l.status,
                  l.interest_rate_bps as rate,
                  l.total_interest::text as total_interest,
                  (select pg_catalog.sum(b.interest)::text
                     from public.calculate_loan_breakdown(
                       l.principal_amount, l.interest_rate_bps, l.loan_term_months
                     ) b) as recomputed
             from public.loans l where l.id = $1`,
          [loanId],
        );

        if (row.status === 'approved') {
          // The stored totals follow from the stored rate. That is the
          // invariant; which rate won the race does not matter.
          expect(row.total_interest).toBe(row.recomputed);
          expect([1_200, 1_500]).toContain(row.rate);
        }
      } finally {
        await query(
          `update public.business_settings
              set default_monthly_interest_rate_bps = 1500 where id = 1`,
        );
      }
    });
  });

  // =========================================================================
  describe('two staff drafting for the same client', () => {
    it('permits both drafts, because a draft is not a commitment', async () => {
      const own = await createLoanScenario();

      // Deliberate: the one-active-loan rule is about *active* loans. Two
      // staff may both start a draft, and the rule bites when the second is
      // disbursed. Blocking at draft time would make the register unusable
      // whenever two people worked at once.
      const outcomes = await Promise.allSettled([
        createDraftLoan(own.clientId, { principal: 300_000, termMonths: 1 }),
        createDraftLoan(own.clientId, { principal: 400_000, termMonths: 1 }),
      ]);

      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    });
  });
});
