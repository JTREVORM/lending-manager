import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createLoanScenario,
  deleteTestLoans,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { deleteTestPayments, postPayment, readLedger } from '../helpers/payment-fixtures';
import {
  businessInstant,
  createFourThousandLoan,
  deleteTestPenalties,
  readPenalty,
  restoreSeededLendingTerms,
  shiftDate,
  type FourThousandLoan,
} from '../helpers/delinquency-fixtures';
import { closePool, getClient, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * The penalty under genuine concurrency.
 *
 * Every test here opens real parallel connections holding real transactions.
 * A race cannot be tested by calling a function twice in sequence, and the
 * failure modes are expensive in both directions: a borrower charged twice for
 * one expiry, or a borrower settling the old balance in the moment the charge
 * became due and escaping it.
 *
 * ## One lock, taken in one order
 *
 * Every path that touches a loan's money — `post_payment`, `reverse_payment`
 * and `ensure_penalty_applied` — locks the **loan row** first and takes no
 * second lock. That is what makes these races deterministic rather than
 * deadlock-prone, and it is the specific reason the materialiser does not use
 * an advisory lock of its own: that would be a second lock acquired in the
 * opposite order from the posting path's.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('penalty concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Outcome {
  readonly ok: boolean;
  readonly value: string | null;
  readonly message: string;
}

/** Materialise a penalty on its own connection, at a chosen instant. */
async function raceEnsure(loanId: string, businessNow: string): Promise<Outcome> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('app.business_now', $1, true)`, [businessNow]);

    const result = await client.query<{ id: string | null }>(
      `select public.ensure_penalty_applied($1) as id`,
      [loanId],
    );

    await client.query('commit');

    const id = result.rows[0]?.id ?? null;

    return {
      ok: true,
      value: id,
      message: '',
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      ok: false,
      value: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
  }
}

/** Post a payment on its own connection, as a real signed-in user. */
async function racePost(
  authUserId: string,
  loanId: string,
  amount: number,
  businessNow: string,
): Promise<Outcome> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('app.business_now', $1, true)`, [businessNow]);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');

    const result = await client.query<{ id: string }>(
      `select public.post_payment($1, $2, 'cash', null, $3, null) as id`,
      [loanId, amount, randomUUID()],
    );

    await client.query('reset role');
    await client.query('commit');

    return { ok: true, value: result.rows[0]?.id ?? null, message: '' };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      ok: false,
      value: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
  }
}

/** Reverse a payment on its own connection, as a real signed-in user. */
async function raceReverse(
  authUserId: string,
  paymentId: string,
  businessNow: string,
): Promise<Outcome> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('app.business_now', $1, true)`, [businessNow]);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');

    await client.query(`select public.reverse_payment($1, $2)`, [
      paymentId,
      'reversed under concurrency',
    ]);

    await client.query('reset role');
    await client.query('commit');

    return { ok: true, value: paymentId, message: '' };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      ok: false,
      value: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
  }
}

async function penaltyCount(loanId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `select pg_catalog.count(*)::text as n from public.loan_penalties
      where loan_id = $1`,
    [loanId],
  );

  return Number(rows[0]?.n ?? 0);
}

async function penaltyEventCount(loanId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `select pg_catalog.count(*)::text as n from public.audit_log
      where action = 'loan.penalty_applied' and entity_id = $1`,
    [loanId],
  );

  return Number(rows[0]?.n ?? 0);
}

describeDb('penalties under concurrency', () => {
  let scenario: LoanScenario;

  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    scenario = await createLoanScenario();
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    await restoreSeededLendingTerms();
    await closePool();
  });

  /** A loan owing exactly UGX 100,000 when its grace period ends. */
  async function loanOwing100k(): Promise<FourThousandLoan> {
    const borrower = await createLoanScenario();
    const loan = await createFourThousandLoan(borrower);

    await postPayment(loan.loanId, borrower.secretary, {
      amount: loan.scheduledTotal - 100_000,
      businessNow: businessInstant(loan.firstDue),
    });

    return loan;
  }

  // =========================================================================
  it('specification §35 — two materialisations produce exactly one penalty', async () => {
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    const [first, second] = await Promise.all([
      raceEnsure(loan.loanId, at),
      raceEnsure(loan.loanId, at),
    ]);

    // Both succeed: the loser is not an error, it is a no-op that returns the
    // penalty that now exists. A caller invoking this before every payment
    // must not have to handle a failure for the normal case.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.value).toBe(second.value);

    expect(await penaltyCount(loan.loanId)).toBe(1);
    expect(await penaltyEventCount(loan.loanId)).toBe(1);
    expect((await readPenalty(loan.loanId))?.penaltyAmount).toBe(50_000);
  });

  it('produces exactly one penalty under four simultaneous attempts', async () => {
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    const results = await Promise.all([
      raceEnsure(loan.loanId, at),
      raceEnsure(loan.loanId, at),
      raceEnsure(loan.loanId, at),
      raceEnsure(loan.loanId, at),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(4);
    expect(new Set(results.map((result) => result.value)).size).toBe(1);

    expect(await penaltyCount(loan.loanId)).toBe(1);
    expect(await penaltyEventCount(loan.loanId)).toBe(1);
  });

  it('produces one penalty when two reads trigger it at different instants', async () => {
    // The lazy path: two processes notice the same overdue loan a day apart,
    // in overlapping transactions. The basis is as at the grace deadline in
    // both cases, so the charge is the same figure either way.
    const loan = await loanOwing100k();

    const [first, second] = await Promise.all([
      raceEnsure(loan.loanId, businessInstant(loan.penaltyEffective)),
      raceEnsure(loan.loanId, businessInstant(await shiftDate(loan.penaltyEffective, 1))),
    ]);

    expect(first.ok && second.ok).toBe(true);
    expect(await penaltyCount(loan.loanId)).toBe(1);
    expect((await readPenalty(loan.loanId))?.basisAmount).toBe(100_000);
  });

  // =========================================================================
  it('specification §82 — a payment racing the charge cannot escape it', async () => {
    // The borrower offers the old contractual balance in the same moment the
    // charge becomes due. Either ordering must leave the charge standing.
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    const [posted, ensured] = await Promise.all([
      racePost(scenario.secretary.authUserId, loan.loanId, 100_000, at),
      raceEnsure(loan.loanId, at),
    ]);

    expect(posted.ok).toBe(true);
    expect(ensured.ok).toBe(true);

    const ledger = await readLedger(loan.loanId);

    // The contract is settled and the charge is not, whichever transaction
    // won the loan's lock.
    expect(ledger.outstanding).toBe(0);
    expect(ledger.penaltyRemaining).toBe(50_000);
    expect(ledger.totalOutstanding).toBe(50_000);
    // And the loan is emphatically not cleared.
    expect(ledger.status).toBe('active');

    expect(await penaltyCount(loan.loanId)).toBe(1);
  });

  it('serialises two staff posting at the moment the charge becomes due', async () => {
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    // Two counters, each offering half the contractual balance.
    const [first, second] = await Promise.all([
      racePost(scenario.secretary.authUserId, loan.loanId, 50_000, at),
      racePost(scenario.manager.authUserId, loan.loanId, 50_000, at),
    ]);

    expect(first.ok && second.ok).toBe(true);

    const ledger = await readLedger(loan.loanId);

    // Both payments landed, the contract is settled, one charge exists.
    expect(ledger.postedPaymentCount).toBeGreaterThanOrEqual(2);
    expect(ledger.outstanding).toBe(0);
    expect(await penaltyCount(loan.loanId)).toBe(1);
    expect(ledger.penaltyRemaining).toBe(50_000);
    // 100,000 contract + 50,000 penalty, of which 100,000 was paid.
    expect(ledger.totalCollected).toBe(ledger.postedPaymentTotal);
  });

  it('never lets a concurrent pair clear a loan with a charge outstanding', async () => {
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    // One offers the contractual balance; the other materialises the charge.
    await Promise.all([
      racePost(scenario.secretary.authUserId, loan.loanId, 100_000, at),
      raceEnsure(loan.loanId, at),
      raceEnsure(loan.loanId, at),
    ]);

    const rows = await query<{ status: string; total: string }>(
      `select status, total_outstanding::text as total from public.loan_balances
        where loan_id = $1`,
      [loan.loanId],
    );

    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.total).toBe('50000');
  });

  // =========================================================================
  it('specification §83 — a reversal racing the charge stays deterministic', async () => {
    // A loan settled inside grace, whose settling payment is withdrawn at the
    // same moment something materialises the charge.
    const borrower = await createLoanScenario();
    const loan = await createFourThousandLoan(borrower);

    await postPayment(loan.loanId, borrower.secretary, {
      amount: loan.scheduledTotal - 100_000,
      businessNow: businessInstant(loan.firstDue),
    });

    const settling = await postPayment(loan.loanId, borrower.secretary, {
      amount: 100_000,
      businessNow: businessInstant(await shiftDate(loan.finalDue, 1)),
    });

    expect((await readLedger(loan.loanId)).status).toBe('cleared');

    const at = businessInstant(await shiftDate(loan.penaltyEffective, 1));

    const [reversed, ensured] = await Promise.all([
      raceReverse(borrower.owner.authUserId, settling, at),
      raceEnsure(loan.loanId, at),
    ]);

    expect(reversed.ok).toBe(true);
    expect(ensured.ok).toBe(true);

    const ledger = await readLedger(loan.loanId);

    // Reopened, and charged — whichever ran first. If the materialiser won,
    // it found a cleared loan and charged nothing, and the reversal then
    // charged on its way out; if the reversal won, the materialiser found an
    // active loan owing money at the deadline.
    expect(ledger.status).toBe('active');
    expect(ledger.outstanding).toBe(100_000);
    expect(await penaltyCount(loan.loanId)).toBe(1);
    expect((await readPenalty(loan.loanId))?.basisAmount).toBe(100_000);
    expect(ledger.totalOutstanding).toBe(150_000);
  });

  it('keeps the charge when a payment and a reversal race after it', async () => {
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    await raceEnsure(loan.loanId, at);

    const paid = await postPayment(loan.loanId, scenario.secretary, {
      amount: 150_000,
      businessNow: at,
    });

    expect((await readLedger(loan.loanId)).status).toBe('cleared');

    const later = businessInstant(await shiftDate(loan.penaltyEffective, 2));

    const [reversed, ensured] = await Promise.all([
      raceReverse(scenario.owner.authUserId, paid, later),
      raceEnsure(loan.loanId, later),
    ]);

    expect(reversed.ok).toBe(true);
    expect(ensured.ok).toBe(true);

    const ledger = await readLedger(loan.loanId);

    // The charge was not recreated and not recalculated.
    expect(await penaltyCount(loan.loanId)).toBe(1);
    expect(ledger.penaltyRemaining).toBe(50_000);
    expect(ledger.outstanding).toBe(100_000);
    expect(ledger.totalOutstanding).toBe(150_000);
  });

  it('refuses a second reversal of one payment under a race', async () => {
    const loan = await loanOwing100k();
    const at = businessInstant(loan.penaltyEffective);

    const paid = await postPayment(loan.loanId, scenario.secretary, {
      amount: 100_000,
      businessNow: at,
    });

    const [first, second] = await Promise.all([
      raceReverse(scenario.owner.authUserId, paid, at),
      raceReverse(scenario.owner.authUserId, paid, at),
    ]);

    // Exactly one succeeds; the loser is told it was already reversed.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);

    const loser = first.ok ? second : first;
    expect(loser.message).toMatch(/already reversed/i);
  });

  // =========================================================================
  it('leaves the whole ledger reconciled after every race', async () => {
    const broken = await query<{ loan_number: string }>(
      `select loan_number from public.loan_balances
        where scheduled_total > 0
          and (total_paid + contractual_outstanding <> scheduled_total
            or contractual_outstanding + penalty_remaining <> total_outstanding
            or posted_payment_total <> total_collected
            or contractual_outstanding < 0
            or penalty_remaining < 0
            or total_outstanding < 0
            or penalty_paid + penalty_remaining <> penalty_assessed
            or (status = 'cleared' and total_outstanding <> 0)
            or (status = 'active' and total_outstanding = 0))`,
    );

    expect(broken).toEqual([]);
  });

  it('leaves no loan with two penalties, and no penalty without its event', async () => {
    const duplicated = await query<{ loan_id: string }>(
      `select loan_id from public.loan_penalties
        group by loan_id, penalty_type having pg_catalog.count(*) > 1`,
    );

    expect(duplicated).toEqual([]);

    const unaudited = await query<{ loan_id: string }>(
      `select p.loan_id from public.loan_penalties p
        where not exists (
          select 1 from public.audit_log a
           where a.action = 'loan.penalty_applied'
             and a.entity_id = p.loan_id::text
        )`,
    );

    expect(unaudited).toEqual([]);

    const overAudited = await query<{ entity_id: string }>(
      `select entity_id from public.audit_log
        where action = 'loan.penalty_applied'
        group by entity_id having pg_catalog.count(*) > 1`,
    );

    expect(overAudited).toEqual([]);
  });

  it('leaves every penalty"s amount following from its own basis and rate', async () => {
    const wrong = await query<{ loan_id: string }>(
      `select loan_id from public.loan_penalties
        where penalty_amount <> (basis_amount * penalty_rate_bps + 5000) / 10000
           or grace_end_date <> final_due_date + grace_period_days
           or effective_date <> grace_end_date + 1`,
    );

    expect(wrong).toEqual([]);
  });
});
