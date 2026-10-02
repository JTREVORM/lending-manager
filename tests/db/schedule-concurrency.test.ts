import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
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
 * Schedule generation under genuine concurrency.
 *
 * Every test here opens real parallel connections holding real transactions.
 * Nothing is simulated: a race cannot be tested by calling a function twice in
 * sequence, and the failure modes are the expensive kind — a loan with two
 * overlapping schedules, a borrower collected twice on the same day, or an
 * active loan whose schedule half-committed.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('schedule concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Outcome {
  readonly ok: boolean;
  readonly message: string;
}

/** Run one statement as a signed-in user, on its own connection, committed. */
async function raceAs(
  authUserId: string,
  sql: string,
  params: readonly unknown[],
): Promise<Outcome> {
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
    return { ok: true, message: '' };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

/** Run one statement as the table owner, on its own connection, committed. */
async function raceAsOwnerRole(
  sql: string,
  params: readonly unknown[],
): Promise<Outcome> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(sql, [...params]);
    await client.query('commit');
    return { ok: true, message: '' };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

describeDb('repayment schedules under concurrency', () => {
  beforeAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  it('produces exactly one schedule when two disbursements race', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 600_000,
      termMonths: 3,
    });

    await approveLoan(loanId, scenario);

    const [first, second] = await Promise.all([
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
    ]);

    // Exactly one wins. The loser is refused because the loan is no longer
    // `approved`, or because it blocked on the row lock and then found it so.
    const winners = [first, second].filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);

    const state = await queryOne<{
      status: string;
      headers: string;
      installments: string;
      events: string;
    }>(
      `select l.status,
              (select count(*)::text from public.loan_schedules where loan_id = l.id)
                as headers,
              (select count(*)::text from public.loan_installments where loan_id = l.id)
                as installments,
              (select count(*)::text from public.audit_log
                where entity_type = 'loan' and entity_id = l.id::text
                  and action = 'loan.schedule_generated') as events
         from public.loans l where l.id = $1`,
      [loanId],
    );

    expect(state.status).toBe('active');
    // One schedule, one set of installments, one audit event.
    expect(Number(state.headers)).toBe(1);
    expect(Number(state.events)).toBe(1);
    expect(Number(state.installments)).toBeGreaterThan(85);

    // And the winner's schedule is complete and reconciled, not half-written.
    const total = await queryOne<{ scheduled: string; contractual: string }>(
      `select (select sum(expected_amount)::text from public.loan_installments
                where loan_id = l.id) as scheduled,
              l.total_expected_repayment::text as contractual
         from public.loans l where l.id = $1`,
      [loanId],
    );

    expect(total.scheduled).toBe(total.contractual);
    expect(Number(total.contractual)).toBe(780_000);
  });

  // =========================================================================
  it('produces one schedule when four disbursements race', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 200_000,
      termMonths: 2,
    });

    await approveLoan(loanId, scenario);

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const headers = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.loan_schedules where loan_id = $1`,
      [loanId],
    );

    expect(Number(headers.n)).toBe(1);
  });

  // =========================================================================
  it('the loser of a disbursement race leaves no installment behind', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 300_000,
      termMonths: 1,
    });

    await approveLoan(loanId, scenario);

    await Promise.all([
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [loanId]),
    ]);

    // Partial rows from a rolled-back attempt would show up as a count that
    // is not exactly one period's worth, or as a duplicate position.
    const rows = await query<{ installment_number: number }>(
      `select installment_number from public.loan_installments
        where loan_id = $1 order by installment_number`,
      [loanId],
    );

    expect(rows.map((row) => row.installment_number)).toEqual(
      rows.map((_, index) => index + 1),
    );

    const duplicates = await query<{ due_date: string }>(
      `select due_date::text as due_date from public.loan_installments
        where loan_id = $1 group by due_date having count(*) > 1`,
      [loanId],
    );

    expect(duplicates).toEqual([]);
  });

  // =========================================================================
  it('produces one schedule when the generator itself is called in parallel', async () => {
    // Direct parallel calls to `generate_loan_schedule`, bypassing
    // `disburse_loan` entirely — the advisory lock and the primary key are
    // what have to hold here, not the `status <> 'approved'` check.
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 200_000,
      termMonths: 2,
    });

    await disburseLoan(loanId, scenario);

    const before = await query<{ id: string }>(
      `select id from public.loan_installments where loan_id = $1
        order by installment_number`,
      [loanId],
    );

    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () =>
        raceAsOwnerRole(`select public.generate_loan_schedule($1)`, [loanId]),
      ),
    );

    // Every one succeeds, because generation is idempotent: a second caller
    // finds the schedule already there and returns it. What must not happen
    // is a second schedule.
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);

    const after = await query<{ id: string }>(
      `select id from public.loan_installments where loan_id = $1
        order by installment_number`,
      [loanId],
    );

    // Not one extra row, and the same rows — not regenerated ones.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));

    const headers = await queryOne<{ n: string; events: string }>(
      // `audit_log.entity_id` is text and `loan_schedules.loan_id` is uuid, so
      // the shared placeholder is cast explicitly at each use.
      `select (select count(*)::text from public.loan_schedules
                where loan_id = $1::uuid) as n,
              (select count(*)::text from public.audit_log
                where entity_type = 'loan' and entity_id = $1::text
                  and action = 'loan.schedule_generated') as events`,
      [loanId],
    );

    expect(Number(headers.n)).toBe(1);
    expect(Number(headers.events)).toBe(1);
  });

  // =========================================================================
  it('still enforces one active loan per client, now that disbursement does more', async () => {
    // The Phase 4 invariant, re-run because `disburse_loan` now does
    // substantially more work inside the same transaction. A longer
    // transaction is a wider window for the race it guards against.
    const scenario = await createLoanScenario();

    const first = await createDraftLoan(scenario.clientId, {
      principal: 200_000,
      termMonths: 1,
    });
    const second = await createDraftLoan(scenario.clientId, {
      principal: 300_000,
      termMonths: 1,
    });

    await approveLoan(first, scenario);
    await approveLoan(second, scenario);

    const outcomes = await Promise.all([
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [first]),
      raceAs(scenario.owner.authUserId, `select public.disburse_loan($1)`, [second]),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const active = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.loans
        where client_id = $1 and status = 'active'`,
      [scenario.clientId],
    );

    expect(Number(active.n)).toBe(1);

    // And the one that lost has no schedule, because its whole transaction
    // rolled back.
    const orphaned = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.loan_schedules ls
         join public.loans l on l.id = ls.loan_id
        where l.client_id = $1 and l.status <> 'active'`,
      [scenario.clientId],
    );

    expect(Number(orphaned.n)).toBe(0);
  });

  // =========================================================================
  it('leaves every active loan in the database with exactly one schedule', async () => {
    // The invariant stated over the whole table after all the racing above,
    // rather than per loan. Any path that half-committed would show here.
    const wrong = await query<{ id: string; headers: string }>(
      `select l.id,
              (select count(*)::text from public.loan_schedules where loan_id = l.id)
                as headers
         from public.loans l
        where l.status = 'active'
          and (select count(*) from public.loan_schedules where loan_id = l.id) <> 1`,
    );

    expect(wrong).toEqual([]);
  });

  // =========================================================================
  it('leaves no schedule whose installments disagree with its contract', async () => {
    const mismatched = await query<{ id: string }>(
      `select l.id
         from public.loans l
         join public.loan_schedules ls on ls.loan_id = l.id
        where (select coalesce(sum(li.expected_amount), 0)
                 from public.loan_installments li where li.loan_id = l.id)
              <> l.total_expected_repayment`,
    );

    expect(mismatched).toEqual([]);
  });

  // =========================================================================
  it('leaves no contractual month without a collection, anywhere', async () => {
    const orphans = await query<{ period_number: number }>(
      `select lp.period_number
         from public.loan_periods lp
         join public.loan_schedules ls on ls.loan_id = lp.loan_id
        where not exists (
          select 1 from public.loan_installments li where li.loan_period_id = lp.id
        )`,
    );

    expect(orphans).toEqual([]);
  });
});
