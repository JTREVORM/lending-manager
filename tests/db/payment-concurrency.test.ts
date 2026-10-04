import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { deleteTestPayments, postPayment, readLedger } from '../helpers/payment-fixtures';
import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

/**
 * The payment ledger under genuine concurrency.
 *
 * Every test here opens real parallel connections holding real transactions.
 * Nothing is simulated: a race cannot be tested by calling a function twice in
 * sequence, and the failure modes are the expensive kind — a borrower charged
 * twice for one Mobile Money transaction, an installment allocated beyond what
 * it is owed, a loan cleared twice, or a balance driven negative.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('payment concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Outcome {
  readonly ok: boolean;
  readonly paymentId: string | null;
  readonly message: string;
}

/** Post a payment on its own connection, as a real signed-in user. */
async function racePost(
  authUserId: string,
  loanId: string,
  amount: number,
  options: {
    readonly method?: string;
    readonly reference?: string | null;
    readonly key?: string;
  } = {},
): Promise<Outcome> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');

    const result = await client.query(
      `select public.post_payment($1, $2, $3, $4, $5, null) as id`,
      [
        loanId,
        amount,
        options.method ?? 'cash',
        options.reference ?? null,
        options.key ?? randomUUID(),
      ],
    );

    await client.query('reset role');
    await client.query('commit');

    return {
      ok: true,
      paymentId: String((result.rows[0] as { id: string }).id),
      message: '',
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      ok: false,
      paymentId: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
  }
}

/** Reverse a payment on its own connection. */
async function raceReverse(
  authUserId: string,
  paymentId: string,
  reason = 'reversed in the concurrency suite',
): Promise<Outcome> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');
    await client.query(`select public.reverse_payment($1, $2)`, [paymentId, reason]);
    await client.query('reset role');
    await client.query('commit');
    return { ok: true, paymentId, message: '' };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return {
      ok: false,
      paymentId: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.release();
  }
}

/** An active loan of ten UGX 11,500 collections. */
async function tenCollectionLoan(): Promise<{
  readonly scenario: LoanScenario;
  readonly loanId: string;
}> {
  const scenario = await createLoanScenario();
  const loanId = await createDraftLoan(scenario.clientId, {
    principal: 100_000,
    termMonths: 1,
    frequency: 'every_3_days',
  });
  await disburseLoan(loanId, scenario);
  return { scenario, loanId };
}

describeDb('payments under concurrency', () => {
  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  it('records both of two genuine concurrent cash payments', async () => {
    // These are not duplicates. Two borrowers can hand over UGX 11,500 at two
    // counters at the same moment, and a system that refused one of them would
    // lose real money. The guard is the idempotency key, not the amount.
    const { scenario, loanId } = await tenCollectionLoan();

    const [first, second] = await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 11_500),
      racePost(scenario.manager.authUserId, loanId, 11_500),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.paymentId).not.toBe(first.paymentId);

    const ledger = await readLedger(loanId);
    expect(ledger.postedPaymentCount).toBe(2);
    expect(ledger.totalPaid).toBe(23_000);
    expect(ledger.outstanding).toBe(92_000);
  });

  // =========================================================================
  it('records one payment when a submission is retried concurrently', async () => {
    // The double tap, raced: two deliveries of one submission arrive at once,
    // carrying the same key.
    const { scenario, loanId } = await tenCollectionLoan();
    const key = randomUUID();

    const outcomes = await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 11_500, { key }),
      racePost(scenario.secretary.authUserId, loanId, 11_500, { key }),
      racePost(scenario.secretary.authUserId, loanId, 11_500, { key }),
      racePost(scenario.secretary.authUserId, loanId, 11_500, { key }),
    ]);

    // Every one succeeds, because a replay is idempotent — and every one
    // returns the same payment.
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);

    const ids = new Set(outcomes.map((outcome) => outcome.paymentId));
    expect(ids.size).toBe(1);

    const ledger = await readLedger(loanId);
    expect(ledger.postedPaymentCount).toBe(1);
    expect(ledger.totalPaid).toBe(11_500);
  });

  // =========================================================================
  it('records one payment when a Mobile Money reference is submitted twice at once', async () => {
    const { scenario, loanId } = await tenCollectionLoan();
    const reference = `RACE-${randomUUID().slice(0, 8).toUpperCase()}`;

    const outcomes = await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 11_500, {
        method: 'mtn_mobile_money',
        reference,
      }),
      racePost(scenario.manager.authUserId, loanId, 11_500, {
        method: 'mtn_mobile_money',
        reference,
      }),
    ]);

    // Exactly one. Different idempotency keys, so the key cannot save this —
    // the unique index on (method, reference) is what holds.
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const ledger = await readLedger(loanId);
    expect(ledger.postedPaymentCount).toBe(1);
    expect(ledger.totalPaid).toBe(11_500);

    const stored = await query<{ n: string }>(
      `select count(*)::text as n from public.loan_payments
        where payment_method = 'mtn_mobile_money' and external_reference = $1`,
      [reference],
    );

    expect(Number(stored[0]?.n)).toBe(1);
  });

  // =========================================================================
  it('never over-allocates a collection when two payments race', async () => {
    // The classic check-then-insert race, on money. Both transactions read the
    // same coverage, both compute an allocation against the same collections,
    // and without the loan lock both would write.
    const { scenario, loanId } = await tenCollectionLoan();

    await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 28_000),
      racePost(scenario.manager.authUserId, loanId, 28_000),
    ]);

    const over = await query<{ installment_number: number }>(
      `select installment_number from public.loan_installment_coverage
        where loan_id = $1
          and (remaining_amount < 0 or remaining_principal < 0
            or remaining_interest < 0)`,
      [loanId],
    );

    expect(over).toEqual([]);

    // And the arithmetic still closes.
    const ledger = await readLedger(loanId);
    expect(ledger.totalPaid + ledger.outstanding).toBe(ledger.scheduledTotal);
    expect(ledger.postedPaymentTotal).toBe(ledger.totalPaid);
  });

  // =========================================================================
  it('accepts at most the outstanding balance when two payments race to clear', async () => {
    // Both offer the full balance. One must win and one must be refused;
    // accepting both would take twice what the borrower owes.
    const { scenario, loanId } = await tenCollectionLoan();

    const outcomes = await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 115_000),
      racePost(scenario.manager.authUserId, loanId, 115_000),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const ledger = await readLedger(loanId);

    expect(ledger.totalPaid).toBe(115_000);
    expect(ledger.outstanding).toBe(0);
    expect(ledger.status).toBe('cleared');
  });

  // =========================================================================
  it('clears a loan exactly once when the final payment is raced', async () => {
    const { scenario, loanId } = await tenCollectionLoan();

    // Leave exactly one collection outstanding, then race the last payment.
    await postPayment(loanId, scenario.secretary, { amount: 103_500 });
    expect((await readLedger(loanId)).outstanding).toBe(11_500);

    const outcomes = await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 11_500),
      racePost(scenario.manager.authUserId, loanId, 11_500),
      racePost(scenario.owner.authUserId, loanId, 11_500),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const ledger = await readLedger(loanId);
    expect(ledger.status).toBe('cleared');
    expect(ledger.outstanding).toBe(0);

    // One clearance event, not three.
    const events = await query<{ action: string }>(
      `select action from public.audit_log
        where entity_type = 'loan' and entity_id = $1 and action = 'loan.cleared'`,
      [loanId],
    );

    expect(events).toHaveLength(1);
  });

  // =========================================================================
  it('never drives a balance negative under four-way contention', async () => {
    const { scenario, loanId } = await tenCollectionLoan();

    const actors = [
      scenario.secretary.authUserId,
      scenario.manager.authUserId,
      scenario.owner.authUserId,
      scenario.secretary.authUserId,
    ];

    // Four attempts at a third of the balance each: at most three can fit.
    const outcomes = await Promise.all(
      actors.map((actor) => racePost(actor, loanId, 38_000)),
    );

    const accepted = outcomes.filter((outcome) => outcome.ok).length;

    expect(accepted).toBeGreaterThanOrEqual(1);
    expect(accepted).toBeLessThanOrEqual(3);

    const ledger = await readLedger(loanId);

    expect(ledger.outstanding).toBeGreaterThanOrEqual(0);
    expect(ledger.totalPaid).toBe(38_000 * accepted);
    expect(ledger.totalPaid + ledger.outstanding).toBe(115_000);
  });

  // =========================================================================
  it('reverses a payment exactly once when two reversals race', async () => {
    const { scenario, loanId } = await tenCollectionLoan();

    const paymentId = await postPayment(loanId, scenario.secretary, {
      amount: 23_000,
    });

    const outcomes = await Promise.all([
      raceReverse(scenario.owner.authUserId, paymentId),
      raceReverse(scenario.owner.authUserId, paymentId),
      raceReverse(scenario.owner.authUserId, paymentId),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);

    const ledger = await readLedger(loanId);

    // Restored once, not three times over.
    expect(ledger.outstanding).toBe(115_000);
    expect(ledger.totalPaid).toBe(0);
    expect(ledger.reversedPaymentCount).toBe(1);

    const events = await query<{ action: string }>(
      `select action from public.audit_log
        where entity_type = 'payment' and entity_id = $1
          and action = 'payment.reversed'`,
      [paymentId],
    );

    expect(events).toHaveLength(1);
  });

  // =========================================================================
  it('keeps the ledger consistent when a payment and a reversal race', async () => {
    // The nastiest interleaving: one transaction posting while another
    // reverses, both touching the same loan's balance and its status.
    const { scenario, loanId } = await tenCollectionLoan();

    const existing = await postPayment(loanId, scenario.secretary, {
      amount: 103_500,
    });

    const [posted, reversed] = await Promise.all([
      racePost(scenario.secretary.authUserId, loanId, 11_500),
      raceReverse(scenario.owner.authUserId, existing),
    ]);

    const ledger = await readLedger(loanId);

    // Whichever order they landed in, the arithmetic closes and the status
    // agrees with the balance.
    expect(ledger.totalPaid + ledger.outstanding).toBe(115_000);
    expect(ledger.outstanding).toBeGreaterThanOrEqual(0);
    expect(ledger.postedPaymentTotal).toBe(ledger.totalPaid);
    expect(ledger.status).toBe(ledger.outstanding === 0 ? 'cleared' : 'active');

    // And at least one of them did something.
    expect(posted.ok || reversed.ok).toBe(true);
  });

  // =========================================================================
  it('mints unique, correctly formatted receipt numbers under contention', async () => {
    // 20 payments across 20 loans, all at once. Receipt numbers come from the
    // Phase 1 atomic generator; two borrowers holding the same receipt number
    // would be unresolvable.
    const scenarios = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const scenario = await createLoanScenario();
        const loanId = await createDraftLoan(scenario.clientId, {
          principal: 100_000,
          termMonths: 1,
          frequency: 'every_3_days',
        });
        await disburseLoan(loanId, scenario);
        return { scenario, loanId };
      }),
    );

    const outcomes = await Promise.all(
      scenarios.map((entry) =>
        racePost(entry.scenario.secretary.authUserId, entry.loanId, 11_500),
      ),
    );

    const ids = outcomes
      .filter((outcome) => outcome.ok)
      .map((outcome) => outcome.paymentId);

    expect(ids).toHaveLength(20);

    const numbers = await query<{ payment_number: string }>(
      `select payment_number from public.loan_payments where id = any($1::uuid[])`,
      [ids],
    );

    const unique = new Set(numbers.map((row) => row.payment_number));

    expect(unique.size).toBe(20);
    for (const row of numbers) {
      expect(row.payment_number).toMatch(/^PAY\d{6,}$/);
    }
  });

  // =========================================================================
  it('leaves the whole ledger reconciled after every race above', async () => {
    // The invariants stated over the entire database rather than per loan, so
    // a path that half-committed would show here whichever test created it.
    const unallocated = await query<{ payment_number: string }>(
      `select lp.payment_number
         from public.loan_payments lp
         left join (
           select payment_id, sum(allocated_amount) as allocated
             from public.payment_allocations group by payment_id
         ) a on a.payment_id = lp.id
        where coalesce(a.allocated, 0) <> lp.amount`,
    );

    const negative = await query<{ loan_id: string }>(
      `select loan_id from public.loan_balances
        where contractual_outstanding < 0 or total_outstanding < 0
           or penalty_remaining < 0`,
    );

    const overAllocated = await query<{ installment_id: string }>(
      `select installment_id from public.loan_installment_coverage
        where remaining_amount < 0 or remaining_principal < 0
           or remaining_interest < 0`,
    );

    const mismatched = await query<{ loan_number: string }>(
      `select loan_number from public.loan_balances
        where scheduled_total > 0
          and (total_paid + contractual_outstanding <> scheduled_total
            or contractual_outstanding + penalty_remaining <> total_outstanding
            or posted_payment_total <> total_collected)`,
    );

    const wrongStatus = await query<{ loan_number: string; status: string }>(
      `select loan_number, status from public.loan_balances
        where scheduled_total > 0
          and ((status = 'cleared' and total_outstanding <> 0)
            or (status = 'active' and total_outstanding = 0))`,
    );

    expect(unallocated).toEqual([]);
    expect(negative).toEqual([]);
    expect(overAllocated).toEqual([]);
    expect(mismatched).toEqual([]);
    expect(wrongStatus).toEqual([]);
  });

  // =========================================================================
  it('leaves no duplicate clearance event anywhere', async () => {
    const duplicates = await query<{ entity_id: string; n: string }>(
      `select entity_id, count(*)::text as n from public.audit_log
        where entity_type = 'loan' and action = 'loan.cleared'
        group by entity_id having count(*) > 1`,
    );

    expect(duplicates).toEqual([]);
  });

  // =========================================================================
  it('leaves no payment with two reversal events', async () => {
    const duplicates = await query<{ entity_id: string; n: string }>(
      `select entity_id, count(*)::text as n from public.audit_log
        where entity_type = 'payment' and action = 'payment.reversed'
        group by entity_id having count(*) > 1`,
    );

    expect(duplicates).toEqual([]);
  });

  // =========================================================================
  it('leaves every idempotency key on exactly one payment', async () => {
    const duplicates = await queryOne<{ n: string }>(
      `select count(*)::text as n from (
         select idempotency_key from public.loan_payments
         group by idempotency_key having count(*) > 1
       ) x`,
    );

    expect(Number(duplicates.n)).toBe(0);
  });
});
