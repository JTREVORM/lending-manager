import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  postPayment,
  readAllocations,
  readCoverage,
  readLedger,
  readMinimum,
  tryPostPayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import {
  allocatePayment,
  applyPlan,
  deriveLoanBalance,
  minimumAcceptablePayment,
  outstandingFrom,
  type InstallmentObligation,
} from '@/lib/domain/payment';

/**
 * The two allocation engines, reconciled.
 *
 * `public.post_payment` is authoritative — it writes the ledger.
 * `lib/domain/payment.ts` drives the preview a staff member confirms against.
 * Two implementations of one rule is a standing risk, so it is tested as one
 * question: given the same loan and the same payment, do they allocate
 * identically, collection by collection and shilling by shilling?
 *
 * ## Why these are real loans and real payments
 *
 * Unlike the Phase 5 schedule parity suite, this cannot be done by evaluating
 * an expression: allocation depends on the ledger's accumulated state, so the
 * only honest comparison is to post a real sequence of payments against a real
 * loan and check the TypeScript engine predicted each one. That is slower, and
 * it is the comparison that means something.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('payment parity suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** The TypeScript view of a loan's obligations, read from the database. */
async function obligationsFor(loanId: string): Promise<readonly InstallmentObligation[]> {
  const coverage = await readCoverage(loanId);

  return coverage.map((row) => ({
    installmentId: `inst-${String(row.installmentNumber)}`,
    installmentNumber: row.installmentNumber,
    dueDate: toBusinessDate(row.dueDate),
    expectedAmount: toUgx(row.expectedAmount),
    scheduledPrincipal: toUgx(row.scheduledPrincipal),
    scheduledInterest: toUgx(row.scheduledInterest),
    allocatedAmount: toUgx(row.allocatedAmount),
    allocatedPrincipal: toUgx(row.allocatedPrincipal),
    allocatedInterest: toUgx(row.allocatedInterest),
  }));
}

/** Deterministic generator, so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describeDb('payment engine parity', () => {
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
  it('allocates identically across 30 loans paid off in random instalments', async () => {
    const random = makeRandom(20_261_006);
    let loansChecked = 0;
    let paymentsChecked = 0;

    // Awkward principals and every frequency, so no collection amount divides
    // cleanly and the remainder cases are swept.
    const SHAPES: readonly (readonly [number, number, string])[] = [
      [100_001, 1, 'daily'],
      [237_777, 2, 'every_2_days'],
      [613_333, 3, 'every_3_days'],
      [150_000, 1, 'every_2_days'],
      [499_999, 2, 'every_3_days'],
      [900_001, 3, 'daily'],
    ];

    for (let iteration = 0; iteration < 30; iteration += 1) {
      const shape = SHAPES[iteration % SHAPES.length];

      /* c8 ignore next */
      if (shape === undefined) continue;

      const [principal, termMonths, frequency] = shape;

      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal,
        termMonths,
        frequency,
      });
      await disburseLoan(loanId, scenario);

      let obligations = await obligationsFor(loanId);
      const contractTotal = outstandingFrom(obligations);

      let guard = 0;

      while (outstandingFrom(obligations) > 0) {
        guard += 1;
        if (guard > 400) throw new Error('payment loop did not terminate');

        const outstanding = outstandingFrom(obligations);
        const minimum = minimumAcceptablePayment(obligations) ?? outstanding;

        // Somewhere between the minimum and the whole balance.
        const span = outstanding - minimum;
        const amount = minimum + Math.floor(random() * (span + 1));

        const context = `${String(principal)}/${String(termMonths)}m/${frequency} paying ${String(amount)} of ${String(outstanding)}`;

        // What the preview would have told the staff member.
        const predicted = allocatePayment({
          amount: toUgx(amount),
          obligations,
        });

        // What the database actually did.
        const paymentId = await postPayment(loanId, scenario.secretary, { amount });
        const actual = await readAllocations(paymentId);

        expect(
          actual.map((entry) => ({
            n: entry.installmentNumber,
            amount: entry.allocatedAmount,
            principal: entry.allocatedPrincipal,
            interest: entry.allocatedInterest,
          })),
          context,
        ).toEqual(
          predicted.allocations.map((entry) => ({
            n: entry.installmentNumber,
            amount: entry.allocatedAmount,
            principal: entry.allocatedPrincipal,
            interest: entry.allocatedInterest,
          })),
        );

        // And the balance the preview promised is the balance the loan has.
        const ledger = await readLedger(loanId);
        expect(ledger.outstanding, context).toBe(predicted.outstandingAfter);
        expect(ledger.status, context).toBe(predicted.clearsLoan ? 'cleared' : 'active');

        // The database's own minimum agrees with the engine's.
        obligations = [...applyPlan(obligations, predicted)];

        const expectedMinimum = minimumAcceptablePayment(obligations);
        expect(await readMinimum(loanId), context).toBe(expectedMinimum);

        // And so does the whole derived balance.
        const derived = deriveLoanBalance(obligations);
        expect(ledger.totalPaid, context).toBe(derived.totalPaid);
        expect(ledger.principalPaid, context).toBe(derived.principalPaid);
        expect(ledger.interestPaid, context).toBe(derived.interestPaid);
        expect(ledger.principalRemaining, context).toBe(derived.principalRemaining);
        expect(ledger.interestRemaining, context).toBe(derived.interestRemaining);

        paymentsChecked += 1;
      }

      expect(outstandingFrom(obligations)).toBe(0);
      expect((await readLedger(loanId)).totalPaid).toBe(contractTotal);

      loansChecked += 1;
    }

    expect(loansChecked).toBe(30);
    // A guard against the loop degenerating into one payment per loan.
    expect(paymentsChecked).toBeGreaterThan(60);
  });

  // =========================================================================
  it('agrees on which amounts are refused, and why', async () => {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 100_000,
      termMonths: 1,
      frequency: 'every_3_days',
    });
    await disburseLoan(loanId, scenario);

    const obligations = await obligationsFor(loanId);
    const outstanding = outstandingFrom(obligations);
    const minimum = minimumAcceptablePayment(obligations) ?? 0;

    const CASES: readonly (readonly [number, RegExp])[] = [
      [minimum - 1, /smallest payment accepted/i],
      [1, /smallest payment accepted/i],
      [outstanding + 1, /outstanding balance/i],
      [outstanding * 2, /outstanding balance/i],
      [0, /more than zero/i],
      [-1, /more than zero/i],
    ];

    for (const [amount, pattern] of CASES) {
      const context = `amount ${String(amount)}`;

      // The engine refuses it.
      expect(() =>
        allocatePayment({ amount: toUgx(Math.max(amount, 1)), obligations }),
      ).toThrow();

      // And so does the database, for a reason the staff member can act on.
      const attempt = await tryPostPayment(loanId, scenario.secretary, { amount });

      expect(attempt.ok, context).toBe(false);
      expect(attempt.message, context).toMatch(pattern);
    }

    // Nothing was recorded by any of them.
    const ledger = await readLedger(loanId);
    expect(ledger.postedPaymentCount).toBe(0);
    expect(ledger.outstanding).toBe(outstanding);
  });

  // =========================================================================
  it('agrees that interest is covered before principal, over many part-payments', async () => {
    // The interest-first rule is the one place the two engines could plausibly
    // diverge: the SQL does it with `least` in a window expression and the
    // TypeScript with `Math.min` in a loop. Checked on every allocation of
    // every payment rather than on totals.
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      principal: 613_333,
      termMonths: 3,
      frequency: 'every_2_days',
    });
    await disburseLoan(loanId, scenario);

    let obligations = await obligationsFor(loanId);
    const random = makeRandom(4_242);
    let checked = 0;

    while (outstandingFrom(obligations) > 0 && checked < 40) {
      const outstanding = outstandingFrom(obligations);
      const minimum = minimumAcceptablePayment(obligations) ?? outstanding;
      const span = Math.min(outstanding - minimum, minimum * 3);
      const amount = minimum + Math.floor(random() * (span + 1));

      const predicted = allocatePayment({ amount: toUgx(amount), obligations });
      const paymentId = await postPayment(loanId, scenario.secretary, { amount });
      const actual = await readAllocations(paymentId);

      for (const [index, entry] of actual.entries()) {
        const expected = predicted.allocations[index];
        const target = obligations.find(
          (row) => row.installmentNumber === entry.installmentNumber,
        );

        expect(expected, `allocation ${String(index)}`).toBeDefined();
        expect(target).toBeDefined();

        if (expected === undefined || target === undefined) continue;

        // Identical to the engine.
        expect(entry.allocatedPrincipal).toBe(expected.allocatedPrincipal);
        expect(entry.allocatedInterest).toBe(expected.allocatedInterest);

        // And interest-first, stated independently of either engine: if any
        // principal was taken, this collection's interest must now be fully
        // covered.
        if (entry.allocatedPrincipal > 0) {
          expect(
            target.allocatedInterest + entry.allocatedInterest,
            `collection ${String(entry.installmentNumber)}`,
          ).toBe(target.scheduledInterest);
        }
      }

      obligations = [...applyPlan(obligations, predicted)];
      checked += 1;
    }

    expect(checked).toBeGreaterThan(5);
  });

  // =========================================================================
  it('leaves the whole ledger reconciled after the parity runs', async () => {
    const broken = await query<{ loan_number: string }>(
      `select loan_number from public.loan_balances
        where scheduled_total > 0
          and (total_paid + outstanding <> scheduled_total
            or posted_payment_total <> total_paid
            or outstanding < 0
            or principal_paid + principal_remaining <> contractual_principal
            or interest_paid + interest_remaining <> contractual_interest)`,
    );

    expect(broken).toEqual([]);
  });
});
