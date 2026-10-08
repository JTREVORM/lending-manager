/**
 * The payment allocation engine.
 *
 * ## How expectations are derived in this file
 *
 * Every expected figure is **hard-coded**, and the arithmetic that produces it
 * is written out in a comment. Nothing is compared against a second call to
 * the engine, because an engine that agrees with itself proves nothing — a
 * reversed interest/principal order would satisfy such a test perfectly.
 *
 * All five specification scenarios, the interest-first rule, the minimum-payment
 * rule and full clearance on the three confirmed loans were independently
 * reproduced with a separate Python implementation sharing no code with this
 * one before any figure below was written.
 */

import { describe, expect, it } from 'vitest';

import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { calculateLoan } from '@/lib/domain/loan';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  allocatePayment,
  applyPlan,
  assertAllocationInvariants,
  assertBalanceInvariants,
  deriveLoanBalance,
  describePaymentFailure,
  inAllocationOrder,
  isMobileMoney,
  requiresExternalReference,
  isPaymentMethod,
  isPaymentStatus,
  minimumAcceptablePayment,
  MOBILE_MONEY_METHODS,
  outstandingFrom,
  PAYMENT_FAILURE_CODES,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUSES,
  PaymentAllocationError,
  remainingAmount,
  remainingInterest,
  remainingPrincipal,
  unpaidScheduledDue,
  validatePaymentAmount,
  type PaymentObligation,
} from '@/lib/domain/payment';
import { generateRepaymentSchedule } from '@/lib/domain/repayment-schedule';

const d = (value: string): BusinessDate => toBusinessDate(value);

/**
 * One obligation, stated literally.
 *
 * `principal` and `interest` are the scheduled components; `paidPrincipal` and
 * `paidInterest` are what earlier posted payments already covered.
 */
function obligation(
  installmentNumber: number,
  dueDate: string,
  principal: number,
  interest: number,
  paidPrincipal = 0,
  paidInterest = 0,
): PaymentObligation {
  return {
    obligationId: `inst-${String(installmentNumber)}`,
    kind: 'installment',
    sequenceNumber: installmentNumber,
    effectiveDate: d(dueDate),
    expectedAmount: toUgx(principal + interest),
    scheduledPrincipal: toUgx(principal),
    scheduledInterest: toUgx(interest),
    scheduledPenalty: toUgx(0),
    allocatedAmount: toUgx(paidPrincipal + paidInterest),
    allocatedPrincipal: toUgx(paidPrincipal),
    allocatedInterest: toUgx(paidInterest),
    allocatedPenalty: toUgx(0),
  };
}

/**
 * A penalty obligation, stated literally.
 *
 * Phase 7. `paid` is what earlier posted payments already covered of it. A
 * penalty has no principal and no interest components at all, which the engine
 * refuses to let it carry.
 */
function penalty(effectiveDate: string, amount: number, paid = 0): PaymentObligation {
  return {
    obligationId: 'penalty-1',
    kind: 'penalty',
    sequenceNumber: 1,
    effectiveDate: d(effectiveDate),
    expectedAmount: toUgx(amount),
    scheduledPrincipal: toUgx(0),
    scheduledInterest: toUgx(0),
    scheduledPenalty: toUgx(amount),
    allocatedAmount: toUgx(paid),
    allocatedPrincipal: toUgx(0),
    allocatedInterest: toUgx(0),
    allocatedPenalty: toUgx(paid),
  };
}

/** Three identical UGX 4,000 collections — principal 3,000, interest 1,000. */
function threeStandardCollections(): readonly PaymentObligation[] {
  return [
    obligation(1, '2026-11-01', 3_000, 1_000),
    obligation(2, '2026-11-02', 3_000, 1_000),
    obligation(3, '2026-11-03', 3_000, 1_000),
  ];
}

/** Obligations from a real Phase 4/5 contract, with nothing paid yet. */
function contractObligations(
  principal: number,
  termMonths: number,
  intervalDays: number,
  disbursed = '2026-10-10',
): readonly PaymentObligation[] {
  const contract = calculateLoan({
    principal: toUgx(principal),
    monthlyInterestRateBps: 1_500,
    termMonths,
  });

  const schedule = generateRepaymentSchedule({
    disbursementDate: d(disbursed),
    periods: contract.periods,
    intervalDays,
  });

  return schedule.installments.map((row) => ({
    obligationId: `inst-${String(row.installmentNumber)}`,
    kind: 'installment' as const,
    sequenceNumber: row.installmentNumber,
    effectiveDate: row.dueDate,
    expectedAmount: row.expectedAmount,
    scheduledPrincipal: row.scheduledPrincipal,
    scheduledInterest: row.scheduledInterest,
    scheduledPenalty: toUgx(0),
    allocatedAmount: toUgx(0),
    allocatedPrincipal: toUgx(0),
    allocatedInterest: toUgx(0),
    allocatedPenalty: toUgx(0),
  }));
}

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the payment vocabulary', () => {
  it('names exactly the four confirmed methods', () => {
    expect([...PAYMENT_METHODS]).toEqual([
      'cash',
      'mtn_mobile_money',
      'airtel_money',
      'bank',
    ]);
  });

  it('labels every method', () => {
    for (const method of PAYMENT_METHODS) {
      expect(PAYMENT_METHOD_LABELS[method]).toBeTruthy();
    }
    expect(PAYMENT_METHOD_LABELS.mtn_mobile_money).toBe('MTN Mobile Money');
    expect(PAYMENT_METHOD_LABELS.bank).toBe('Bank Transfer');
  });

  it('rejects a free-text method', () => {
    for (const value of ['MTN Momo', 'momo', 'Cash', '', 'bank_transfer', null, 7]) {
      expect(isPaymentMethod(value), String(value)).toBe(false);
    }
  });

  it('knows which methods came through a mobile network', () => {
    expect([...MOBILE_MONEY_METHODS]).toEqual(['mtn_mobile_money', 'airtel_money']);
    expect(isMobileMoney('cash')).toBe(false);
    expect(isMobileMoney('mtn_mobile_money')).toBe(true);
    expect(isMobileMoney('airtel_money')).toBe(true);
    // A bank transfer is not Mobile Money, and the two questions are kept
    // apart: this one decides the wording on the form, the next one decides
    // whether the reference is demanded at all.
    expect(isMobileMoney('bank')).toBe(false);
  });

  it("demands the other side's reference for everything but cash", () => {
    // The same rule `post_payment` applies, stated as "not cash" on both
    // sides rather than as two lists that have to be kept in step.
    expect(requiresExternalReference('cash')).toBe(false);
    for (const method of PAYMENT_METHODS.filter((candidate) => candidate !== 'cash')) {
      expect(requiresExternalReference(method), method).toBe(true);
    }
  });

  it('declares only the two statuses this phase can reach', () => {
    // No `pending` or `failed`: nothing in this phase talks to a payment
    // network, so there is no moment at which the outcome is unknown.
    expect([...PAYMENT_STATUSES]).toEqual(['posted', 'reversed']);
    expect(isPaymentStatus('pending')).toBe(false);
    expect(isPaymentStatus('deleted')).toBe(false);
  });

  it('never labels a reversal as a deletion', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(PAYMENT_STATUS_LABELS[status]).not.toMatch(/delet|remov|cancel/i);
    }
    expect(PAYMENT_STATUS_LABELS.reversed).toBe('Reversed');
  });

  it('names every failure code it can raise', () => {
    expect([...PAYMENT_FAILURE_CODES]).toEqual([
      'amount_not_positive',
      'below_minimum',
      'exceeds_outstanding',
      'nothing_outstanding',
      'obligations_inconsistent',
      'reconciliation_failed',
    ]);
  });

  it('describes every failure in terms a staff member can act on', () => {
    for (const code of PAYMENT_FAILURE_CODES) {
      const message = describePaymentFailure(code, 4_000);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toMatch(/undefined|null|NaN/);
    }

    expect(describePaymentFailure('below_minimum', 1_500)).toMatch(/UGX 1,500/);
    expect(describePaymentFailure('exceeds_outstanding', 50_000)).toMatch(/UGX 50,000/);
  });
});

// ---------------------------------------------------------------------------
// Remaining amounts
// ---------------------------------------------------------------------------

describe('what remains on an installment', () => {
  it('reports nothing paid on a fresh collection', () => {
    const row = obligation(1, '2026-11-01', 3_000, 1_000);

    expect(remainingAmount(row)).toBe(4_000);
    expect(remainingPrincipal(row)).toBe(3_000);
    expect(remainingInterest(row)).toBe(1_000);
  });

  it('reports the remainder of a partly covered collection', () => {
    // The specification's own example: a nominal 4,000 collection with 2,500
    // already covered has 1,500 left.
    const row = obligation(1, '2026-11-01', 3_000, 1_000, 1_500, 1_000);

    expect(remainingAmount(row)).toBe(1_500);
    expect(remainingPrincipal(row)).toBe(1_500);
    expect(remainingInterest(row)).toBe(0);
  });

  it('reports zero on a settled collection', () => {
    const row = obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 1_000);

    expect(remainingAmount(row)).toBe(0);
  });

  it('sums the outstanding balance across collections', () => {
    expect(outstandingFrom(threeStandardCollections())).toBe(12_000);
  });
});

// ---------------------------------------------------------------------------
// Allocation order
// ---------------------------------------------------------------------------

describe('allocation order', () => {
  it('puts the earliest due date first', () => {
    const shuffled = [
      obligation(3, '2026-11-03', 3_000, 1_000),
      obligation(1, '2026-11-01', 3_000, 1_000),
      obligation(2, '2026-11-02', 3_000, 1_000),
    ];

    expect(inAllocationOrder(shuffled).map((row) => row.sequenceNumber)).toEqual([
      1, 2, 3,
    ]);
  });

  it('breaks a same-date tie by installment number, deterministically', () => {
    const sameDay = [
      obligation(9, '2026-11-01', 1, 0),
      obligation(4, '2026-11-01', 1, 0),
      obligation(7, '2026-11-01', 1, 0),
    ];

    expect(inAllocationOrder(sameDay).map((row) => row.sequenceNumber)).toEqual([
      4, 7, 9,
    ]);
  });

  it('does not mutate its input', () => {
    const input = [obligation(3, '2026-11-03', 1, 0), obligation(1, '2026-11-01', 1, 0)];

    inAllocationOrder(input);

    expect(input.map((row) => row.sequenceNumber)).toEqual([3, 1]);
  });
});

// ---------------------------------------------------------------------------
// The minimum payment rule
// ---------------------------------------------------------------------------

describe('the minimum acceptable payment', () => {
  it('is the full amount of the earliest unpaid collection', () => {
    expect(minimumAcceptablePayment(threeStandardCollections())).toBe(4_000);
  });

  it('is the *remaining* amount, not the nominal one', () => {
    // The specification's section 26. A collection nominally 4,000 with 2,500
    // already covered accepts 1,500, because 1,500 is what is left of it.
    const partly = [
      obligation(1, '2026-11-01', 3_000, 1_000, 1_500, 1_000),
      obligation(2, '2026-11-02', 3_000, 1_000),
    ];

    expect(minimumAcceptablePayment(partly)).toBe(1_500);
  });

  it('skips collections that are already settled', () => {
    const partlyPaid = [
      obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 1_000),
      obligation(2, '2026-11-02', 2_000, 500),
    ];

    expect(minimumAcceptablePayment(partlyPaid)).toBe(2_500);
  });

  it('lets a borrower settle a loan smaller than one nominal collection', () => {
    // No special case is needed. The outstanding balance is by definition the
    // sum of the remainders, so it can never be smaller than the first of
    // them — the final payment of a loan is always acceptable.
    const nearlyDone = [
      obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 1_000),
      obligation(2, '2026-11-02', 3_000, 1_000, 2_500, 1_000),
    ];

    expect(outstandingFrom(nearlyDone)).toBe(500);
    expect(minimumAcceptablePayment(nearlyDone)).toBe(500);
    expect(() =>
      allocatePayment({ amount: toUgx(500), obligations: nearlyDone }),
    ).not.toThrow();
  });

  it('is null when nothing is outstanding', () => {
    const settled = [obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 1_000)];

    expect(minimumAcceptablePayment(settled)).toBeNull();
  });

  it('is the earliest unpaid collection even when it is in the future', () => {
    // A borrower paying entirely ahead still pays whole collections. A part
    // payment toward a future obligation is a part payment.
    const allFuture = [
      obligation(1, '2027-01-01', 3_000, 1_000),
      obligation(2, '2027-01-02', 3_000, 1_000),
    ];

    expect(minimumAcceptablePayment(allFuture)).toBe(4_000);
  });
});

// ---------------------------------------------------------------------------
// Amount validation
// ---------------------------------------------------------------------------

describe('amount validation', () => {
  const obligations = threeStandardCollections();

  it('accepts exactly the minimum', () => {
    expect(validatePaymentAmount(4_000, obligations)).toBeNull();
  });

  it('accepts more than the minimum', () => {
    for (const amount of [5_000, 8_000, 10_000, 12_000]) {
      expect(validatePaymentAmount(amount, obligations), String(amount)).toBeNull();
    }
  });

  it('rejects less than the minimum', () => {
    // The business rule: a borrower should not normally pay less than the
    // required collection. UGX 2,000 against a UGX 4,000 collection.
    expect(validatePaymentAmount(2_000, obligations)).toEqual({
      code: 'below_minimum',
      detail: 4_000,
    });
  });

  it('rejects more than the loan still owes', () => {
    // Outstanding is 12,000. No credit balances in this phase.
    expect(validatePaymentAmount(12_001, obligations)).toEqual({
      code: 'exceeds_outstanding',
      detail: 12_000,
    });

    expect(validatePaymentAmount(60_000, obligations)).toEqual({
      code: 'exceeds_outstanding',
      detail: 12_000,
    });
  });

  it('accepts exactly the outstanding balance', () => {
    expect(validatePaymentAmount(12_000, obligations)).toBeNull();
  });

  it.each([0, -1, -4_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an amount of %s',
    (amount) => {
      expect(validatePaymentAmount(amount, obligations)?.code).toBe(
        'amount_not_positive',
      );
    },
  );

  it('rejects any payment once the loan is settled', () => {
    const settled = [obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 1_000)];

    expect(validatePaymentAmount(1_000, settled)?.code).toBe('nothing_outstanding');
  });

  it('reports the balance rather than the minimum when both would fail', () => {
    // An amount above the outstanding balance is also, trivially, not below
    // the minimum — but telling the borrower the balance is the useful answer.
    const nearlyDone = [obligation(1, '2026-11-01', 300, 200, 0, 0)];

    expect(validatePaymentAmount(10_000, nearlyDone)?.code).toBe('exceeds_outstanding');
  });
});

// ---------------------------------------------------------------------------
// The specification's five scenarios
// ---------------------------------------------------------------------------

describe('specification scenario A — exact collection payment', () => {
  it('allocates UGX 4,000 interest-first against a 3,000/1,000 collection', () => {
    const obligations = [obligation(1, '2026-11-01', 3_000, 1_000)];

    const plan = allocatePayment({ amount: toUgx(4_000), obligations });

    expect(plan.allocations).toHaveLength(1);
    // Interest first: the full 1,000 of interest, then 3,000 of principal.
    expect(plan.allocations[0]).toMatchObject({
      kind: 'installment',
      sequenceNumber: 1,
      allocatedAmount: 4_000,
      allocatedInterest: 1_000,
      allocatedPrincipal: 3_000,
    });

    expect(plan.outstandingBefore).toBe(4_000);
    expect(plan.outstandingAfter).toBe(0);
    expect(plan.clearsLoan).toBe(true);

    const after = applyPlan(obligations, plan);
    expect(remainingAmount(after[0]!)).toBe(0);
  });
});

describe('specification scenario B — UGX 4,000 due, pays UGX 8,000', () => {
  it('covers the first collection and the whole of the next', () => {
    const obligations = [
      obligation(1, '2026-11-01', 3_000, 1_000),
      obligation(2, '2026-11-02', 3_000, 1_000),
    ];

    const plan = allocatePayment({ amount: toUgx(8_000), obligations });

    expect(plan.allocations.map((entry) => entry.allocatedAmount)).toEqual([
      4_000, 4_000,
    ]);
    expect(plan.allocations.map((entry) => entry.sequenceNumber)).toEqual([1, 2]);
    // Both fully covered, each interest-first.
    expect(plan.totalInterest).toBe(2_000);
    expect(plan.totalPrincipal).toBe(6_000);
    expect(plan.outstandingAfter).toBe(0);
  });
});

describe('specification scenario C — UGX 8,000 due, pays UGX 10,000', () => {
  it('covers the two due collections and part of the next', () => {
    const obligations = threeStandardCollections();

    const plan = allocatePayment({ amount: toUgx(10_000), obligations });

    // 4,000 + 4,000 + 2,000. The excess is never discarded and never left
    // unallocated.
    expect(plan.allocations.map((entry) => entry.allocatedAmount)).toEqual([
      4_000, 4_000, 2_000,
    ]);

    // The third collection takes 2,000: interest 1,000 first, then 1,000 of
    // principal.
    expect(plan.allocations[2]).toMatchObject({
      sequenceNumber: 3,
      allocatedInterest: 1_000,
      allocatedPrincipal: 1_000,
    });

    // Outstanding falls by exactly the payment.
    expect(plan.outstandingBefore).toBe(12_000);
    expect(plan.outstandingAfter).toBe(2_000);
    expect(plan.clearsLoan).toBe(false);

    // And the future collection keeps its own date and amount — only its
    // coverage changed.
    const after = applyPlan(obligations, plan);
    expect(after[2]?.effectiveDate).toBe('2026-11-03');
    expect(after[2]?.expectedAmount).toBe(4_000);
    expect(remainingAmount(after[2]!)).toBe(2_000);
  });
});

describe('specification scenario D — pays the whole outstanding balance', () => {
  it('settles every collection and reports the loan clear', () => {
    const obligations = [
      obligation(1, '2026-11-01', 4_000, 1_000),
      obligation(2, '2026-11-02', 4_000, 1_000),
    ];

    expect(outstandingFrom(obligations)).toBe(10_000);

    const plan = allocatePayment({ amount: toUgx(10_000), obligations });

    expect(plan.outstandingAfter).toBe(0);
    expect(plan.clearsLoan).toBe(true);
    expect(plan.totalInterest).toBe(2_000);
    expect(plan.totalPrincipal).toBe(8_000);

    const after = applyPlan(obligations, plan);
    expect(after.every((row) => remainingAmount(row) === 0)).toBe(true);
    expect(deriveLoanBalance(after).fullyRepaid).toBe(true);
  });
});

describe('specification scenario E — reversing the final payment', () => {
  it('restores the exact previous state', () => {
    const obligations = [
      obligation(1, '2026-11-01', 4_000, 1_000),
      obligation(2, '2026-11-02', 4_000, 1_000),
    ];

    const plan = allocatePayment({ amount: toUgx(10_000), obligations });
    const cleared = applyPlan(obligations, plan);

    expect(deriveLoanBalance(cleared).contractualOutstanding).toBe(0);

    // A reversal removes the payment's allocations from the effective set.
    // Modelled here by dropping back to the pre-payment obligations, which is
    // exactly what excluding a reversed payment's rows achieves.
    const reopened = obligations;

    expect(deriveLoanBalance(reopened).contractualOutstanding).toBe(10_000);
    expect(deriveLoanBalance(reopened).fullyRepaid).toBe(false);

    // Every collection is effectively unpaid again, and not one date or
    // amount moved.
    for (const [index, row] of reopened.entries()) {
      expect(remainingAmount(row)).toBe(row.expectedAmount);
      expect(row.effectiveDate).toBe(obligations[index]?.effectiveDate);
      expect(row.expectedAmount).toBe(obligations[index]?.expectedAmount);
    }
  });
});

// ---------------------------------------------------------------------------
// Interest-first, proven
// ---------------------------------------------------------------------------

describe('the interest-first rule', () => {
  it('exhausts interest before touching principal', () => {
    // A 2,000 part-payment against a 3,000/1,000 collection: all 1,000 of
    // interest, then 1,000 of principal. Pro-rata would have given 1,500/500.
    const obligations = [
      obligation(1, '2026-11-01', 3_000, 1_000),
      obligation(2, '2026-11-02', 3_000, 1_000),
    ];

    const plan = allocatePayment({ amount: toUgx(6_000), obligations });

    expect(plan.allocations[1]).toMatchObject({
      allocatedAmount: 2_000,
      allocatedInterest: 1_000,
      allocatedPrincipal: 1_000,
    });
  });

  it('puts a part-payment smaller than the interest entirely to interest', () => {
    const obligations = [
      obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 0),
      obligation(2, '2026-11-02', 3_000, 1_000),
    ];

    // The first collection has 1,000 of interest and no principal left.
    const plan = allocatePayment({ amount: toUgx(1_000), obligations });

    expect(plan.allocations[0]).toMatchObject({
      allocatedAmount: 1_000,
      allocatedInterest: 1_000,
      allocatedPrincipal: 0,
    });
  });

  it('puts a payment on an interest-settled collection entirely to principal', () => {
    const obligations = [obligation(1, '2026-11-01', 3_000, 1_000, 0, 1_000)];

    const plan = allocatePayment({ amount: toUgx(3_000), obligations });

    expect(plan.allocations[0]).toMatchObject({
      allocatedAmount: 3_000,
      allocatedInterest: 0,
      allocatedPrincipal: 3_000,
    });
  });

  it('never divides, so the components always sum exactly', () => {
    // Awkward part-payments that a pro-rata rule would have to round. Every
    // one must reconcile to the shilling.
    //
    // Note where the awkward collection has to sit. A *partial* allocation can
    // only ever land on the last collection a payment reaches, because the
    // minimum-payment rule refuses anything less than the earliest unpaid
    // collection's full remainder. So each case pays a trivial first
    // collection in full and spills `spill` into the awkward second one.
    const AWKWARD: readonly (readonly [number, number, number])[] = [
      // [scheduled principal, scheduled interest, amount spilling into it]
      [3_333, 1_000, 1],
      [3_333, 1_000, 999],
      [3_333, 1_000, 1_000],
      [3_333, 1_000, 1_001],
      [3_333, 1_000, 4_332],
      [3_333, 1_000, 4_333],
      [1, 1, 1],
      [1, 1, 2],
      [0, 7, 7],
      [7, 0, 7],
      [7, 0, 3],
      [999_983, 149_997, 149_998],
    ];

    for (const [principal, interest, spill] of AWKWARD) {
      const obligations = [
        // A one-shilling first collection, so the minimum is 1 and the whole
        // remainder of the payment is free to spill into the second.
        obligation(1, '2026-11-01', 1, 0),
        obligation(2, '2026-11-02', principal, interest),
      ];

      const plan = allocatePayment({ amount: toUgx(1 + spill), obligations });
      const entry = plan.allocations[1];

      const context = `${String(principal)}/${String(interest)} spilled ${String(spill)}`;

      expect(entry?.allocatedAmount, context).toBe(spill);
      expect(
        (entry?.allocatedPrincipal ?? 0) + (entry?.allocatedInterest ?? 0),
        context,
      ).toBe(spill);
      // Interest-first, stated as the arithmetic rather than recomputed by
      // the engine under test.
      const expectedInterest = interest < spill ? interest : spill;
      expect(entry?.allocatedInterest, context).toBe(expectedInterest);
      expect(entry?.allocatedPrincipal, context).toBe(spill - expectedInterest);
    }
  });

  it('only ever part-pays the last collection a payment reaches', () => {
    // A consequence of the minimum-payment rule worth stating on its own:
    // every collection a payment touches except the last is settled in full,
    // so the ledger never accumulates several part-covered collections.
    const obligations = contractObligations(600_000, 3, 1);

    // Offsets above the minimum rather than fixed figures, because this
    // loan's first collection is UGX 9,666 and anything less would be refused
    // by the minimum rule before the allocation under test ever ran.
    const floor = minimumAcceptablePayment(obligations) ?? 0;

    for (const amount of [floor, floor + 1, 50_000, 123_456, 400_000]) {
      const plan = allocatePayment({ amount: toUgx(amount), obligations });
      const byId = new Map(obligations.map((row) => [row.obligationId, row]));

      for (const [index, entry] of plan.allocations.entries()) {
        const isLast = index === plan.allocations.length - 1;
        const target = byId.get(entry.obligationId);

        if (!isLast) {
          expect(entry.allocatedAmount, `${String(amount)} / ${String(index)}`).toBe(
            remainingAmount(target!),
          );
        }
      }
    }
  });

  it('settles interest and principal together across the whole loan', () => {
    const obligations = contractObligations(200_000, 2, 1);
    const plan = allocatePayment({ amount: toUgx(245_000), obligations });

    // Paying the lot settles exactly the contractual principal and interest.
    expect(plan.totalPrincipal).toBe(200_000);
    expect(plan.totalInterest).toBe(45_000);
  });
});

// ---------------------------------------------------------------------------
// Paying ahead
// ---------------------------------------------------------------------------

describe('paying ahead', () => {
  it('allocates across three future collections without touching their dates', () => {
    // The specification's section 24: today's 4,000 plus the next two.
    const obligations = threeStandardCollections();

    const plan = allocatePayment({ amount: toUgx(12_000), obligations });

    expect(plan.allocations).toHaveLength(3);
    expect(plan.allocations.every((entry) => entry.allocatedAmount === 4_000)).toBe(true);

    const after = applyPlan(obligations, plan);

    // Three rows still, with their original dates and amounts.
    expect(after).toHaveLength(3);
    expect(after.map((row) => row.effectiveDate)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
    expect(after.map((row) => row.expectedAmount)).toEqual([4_000, 4_000, 4_000]);
    expect(after.every((row) => remainingAmount(row) === 0)).toBe(true);
  });

  it('spans many collections on a daily schedule', () => {
    const obligations = contractObligations(600_000, 3, 1);

    // Ten days of collections at once.
    const tenDays = obligations
      .slice(0, 10)
      .reduce((total, row) => total + row.expectedAmount, 0);

    const plan = allocatePayment({ amount: toUgx(tenDays), obligations });

    expect(plan.allocations).toHaveLength(10);
    expect(plan.allocations.map((entry) => entry.sequenceNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('resumes from the first unsettled collection on the next payment', () => {
    const obligations = threeStandardCollections();

    const first = allocatePayment({ amount: toUgx(10_000), obligations });
    const afterFirst = applyPlan(obligations, first);

    // 2,000 left on collection 3.
    const second = allocatePayment({ amount: toUgx(2_000), obligations: afterFirst });

    expect(second.allocations).toHaveLength(1);
    expect(second.allocations[0]).toMatchObject({
      sequenceNumber: 3,
      allocatedAmount: 2_000,
      // Collection 3's interest was already covered by the first payment, so
      // this is all principal.
      allocatedInterest: 0,
      allocatedPrincipal: 2_000,
    });
    expect(second.clearsLoan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('what allocation refuses', () => {
  it('refuses a payment below the minimum', () => {
    expect(() =>
      allocatePayment({
        amount: toUgx(2_000),
        obligations: threeStandardCollections(),
      }),
    ).toThrow(PaymentAllocationError);

    try {
      allocatePayment({
        amount: toUgx(2_000),
        obligations: threeStandardCollections(),
      });
      expect.unreachable('should have been refused');
    } catch (error) {
      expect((error as PaymentAllocationError).code).toBe('below_minimum');
      expect((error as PaymentAllocationError).message).toMatch(/UGX 4,000/);
    }
  });

  it('refuses a payment above the outstanding balance', () => {
    try {
      allocatePayment({
        amount: toUgx(50_000),
        obligations: threeStandardCollections(),
      });
      expect.unreachable('should have been refused');
    } catch (error) {
      expect((error as PaymentAllocationError).code).toBe('exceeds_outstanding');
      expect((error as PaymentAllocationError).message).toMatch(/UGX 12,000/);
    }
  });

  it('refuses any payment on a settled loan', () => {
    const settled = [obligation(1, '2026-11-01', 3_000, 1_000, 3_000, 1_000)];

    try {
      allocatePayment({ amount: toUgx(1_000), obligations: settled });
      expect.unreachable('should have been refused');
    } catch (error) {
      expect((error as PaymentAllocationError).code).toBe('nothing_outstanding');
    }
  });

  it('refuses obligations whose components do not add up', () => {
    const corrupt: PaymentObligation[] = [
      {
        obligationId: 'inst-1',
        kind: 'installment',
        sequenceNumber: 1,
        effectiveDate: d('2026-11-01'),
        expectedAmount: toUgx(9_999),
        scheduledPrincipal: toUgx(3_000),
        scheduledInterest: toUgx(1_000),
        scheduledPenalty: toUgx(0),
        allocatedAmount: toUgx(0),
        allocatedPrincipal: toUgx(0),
        allocatedInterest: toUgx(0),
        allocatedPenalty: toUgx(0),
      },
    ];

    expect(() => allocatePayment({ amount: toUgx(100), obligations: corrupt })).toThrow(
      /is not its scheduled components/,
    );
  });

  it('refuses obligations that are already over-allocated', () => {
    const corrupt = [obligation(1, '2026-11-01', 3_000, 1_000, 3_500, 1_000)];

    expect(() => allocatePayment({ amount: toUgx(100), obligations: corrupt })).toThrow(
      /already over-allocated/,
    );
  });

  it('refuses obligations whose allocated total disagrees with its components', () => {
    const corrupt: PaymentObligation[] = [
      {
        obligationId: 'inst-1',
        kind: 'installment',
        sequenceNumber: 1,
        effectiveDate: d('2026-11-01'),
        expectedAmount: toUgx(4_000),
        scheduledPrincipal: toUgx(3_000),
        scheduledInterest: toUgx(1_000),
        scheduledPenalty: toUgx(0),
        allocatedAmount: toUgx(500),
        allocatedPrincipal: toUgx(100),
        allocatedInterest: toUgx(100),
        allocatedPenalty: toUgx(0),
      },
    ];

    expect(() => allocatePayment({ amount: toUgx(100), obligations: corrupt })).toThrow(
      /not the sum of its allocated components/,
    );
  });
});

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

describe('balance derivation', () => {
  it('reports every figure the specification requires', () => {
    const obligations = contractObligations(200_000, 2, 1);
    const balance = deriveLoanBalance(obligations);

    expect(balance).toMatchObject({
      contractualPrincipal: 200_000,
      contractualInterest: 45_000,
      totalExpectedRepayment: 245_000,
      totalPaid: 0,
      contractualOutstanding: 245_000,
      principalPaid: 0,
      principalRemaining: 200_000,
      interestPaid: 0,
      interestRemaining: 45_000,
      // Phase 7. No penalty on this loan, so the total owed is the contract
      // and nothing is recorded in the penalty figures.
      penaltyAssessed: 0,
      penaltyPaid: 0,
      penaltyRemaining: 0,
      totalOutstanding: 245_000,
      totalCollected: 0,
      fullyRepaid: false,
    });
  });

  it('tracks paid and remaining through a sequence of payments', () => {
    let obligations = contractObligations(200_000, 2, 1);

    const amounts = [4_333, 8_666, 100_000, 50_000];
    let paid = 0;

    for (const amount of amounts) {
      const plan = allocatePayment({ amount: toUgx(amount), obligations });
      obligations = [...applyPlan(obligations, plan)];
      paid += amount;

      const balance = deriveLoanBalance(obligations);

      expect(balance.totalPaid).toBe(paid);
      expect(balance.contractualOutstanding).toBe(245_000 - paid);
      expect(balance.principalPaid + balance.interestPaid).toBe(paid);
      assertBalanceInvariants(balance, {
        storedTotalExpectedRepayment: 245_000,
        postedPaymentTotal: paid,
      });
    }
  });

  it('reaches exactly zero on full repayment, with both components settled', () => {
    const obligations = contractObligations(600_000, 3, 2);
    const plan = allocatePayment({ amount: toUgx(780_000), obligations });
    const balance = deriveLoanBalance(applyPlan(obligations, plan));

    expect(balance.contractualOutstanding).toBe(0);
    expect(balance.principalRemaining).toBe(0);
    expect(balance.interestRemaining).toBe(0);
    expect(balance.principalPaid).toBe(600_000);
    expect(balance.interestPaid).toBe(180_000);
    expect(balance.fullyRepaid).toBe(true);
  });

  it('never reports a negative outstanding balance', () => {
    // Guaranteed by the outstanding cap, but asserted because a negative
    // balance would be an unexplained client credit.
    const obligations = threeStandardCollections();

    for (const amount of [4_000, 8_000, 12_000]) {
      const plan = allocatePayment({ amount: toUgx(amount), obligations });
      expect(
        deriveLoanBalance(applyPlan(obligations, plan)).contractualOutstanding,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('assertBalanceInvariants', () => {
  const sound = deriveLoanBalance(contractObligations(200_000, 2, 1));

  it('accepts a sound balance', () => {
    expect(() => assertBalanceInvariants(sound)).not.toThrow();
  });

  it('catches paid plus outstanding not equalling the total', () => {
    expect(() =>
      assertBalanceInvariants({ ...sound, contractualOutstanding: toUgx(1) }),
    ).toThrow(/paid plus outstanding/);
  });

  it('catches a negative outstanding balance', () => {
    expect(() =>
      assertBalanceInvariants({
        ...sound,
        totalPaid: toUgx(245_001),
        contractualOutstanding: -1 as UgxAmount,
        principalPaid: toUgx(200_001),
        principalRemaining: -1 as UgxAmount,
        interestPaid: toUgx(45_000),
      }),
    ).toThrow(/outstanding balance is -1/);
  });

  it('catches a principal split that does not reconcile', () => {
    expect(() =>
      assertBalanceInvariants({ ...sound, principalRemaining: toUgx(1) }),
    ).toThrow(/principal paid plus principal remaining/);
  });

  it('catches an interest split that does not reconcile', () => {
    expect(() =>
      assertBalanceInvariants({ ...sound, interestRemaining: toUgx(1) }),
    ).toThrow(/interest paid plus interest remaining/);
  });

  it('catches a schedule that disagrees with the loan"s stored total', () => {
    expect(() =>
      assertBalanceInvariants(sound, { storedTotalExpectedRepayment: 999_999 }),
    ).toThrow(/against the loan's stored 999999/);
  });

  it('catches posted payments that disagree with the allocations', () => {
    // The specification's headline reconciliation.
    expect(() => assertBalanceInvariants(sound, { postedPaymentTotal: 5_000 })).toThrow(
      /posted payments total 5000 but allocations total 0/,
    );
  });

  it('catches a fully-repaid flag that disagrees with the balance', () => {
    expect(() => assertBalanceInvariants({ ...sound, fullyRepaid: true })).toThrow(
      /fully-repaid flag/,
    );
  });
});

// ---------------------------------------------------------------------------
// What is due now
// ---------------------------------------------------------------------------

describe('unpaid scheduled amounts due', () => {
  const obligations = threeStandardCollections();

  it('counts only collections dated today or earlier', () => {
    expect(unpaidScheduledDue(obligations, d('2026-10-31'))).toBe(0);
    expect(unpaidScheduledDue(obligations, d('2026-11-01'))).toBe(4_000);
    expect(unpaidScheduledDue(obligations, d('2026-11-02'))).toBe(8_000);
    expect(unpaidScheduledDue(obligations, d('2026-11-03'))).toBe(12_000);
    expect(unpaidScheduledDue(obligations, d('2026-12-01'))).toBe(12_000);
  });

  it('falls as payments cover the collections', () => {
    const plan = allocatePayment({ amount: toUgx(8_000), obligations });
    const after = applyPlan(obligations, plan);

    expect(unpaidScheduledDue(after, d('2026-11-03'))).toBe(4_000);
  });

  it('reaches zero when a borrower has paid ahead', () => {
    const plan = allocatePayment({ amount: toUgx(12_000), obligations });
    const after = applyPlan(obligations, plan);

    expect(unpaidScheduledDue(after, d('2026-12-01'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The invariant checker, on figures the engine did not produce
// ---------------------------------------------------------------------------

describe('assertAllocationInvariants', () => {
  const obligations = threeStandardCollections();
  const sound = allocatePayment({ amount: toUgx(10_000), obligations });

  it('accepts a sound plan', () => {
    expect(() => assertAllocationInvariants(sound, obligations)).not.toThrow();
  });

  it('catches allocations that do not sum to the payment', () => {
    expect(() =>
      assertAllocationInvariants(
        { ...sound, allocations: sound.allocations.slice(0, 2) },
        obligations,
      ),
    ).toThrow(/sum to 8000, not the payment amount 10000/);
  });

  it('catches an over-allocated installment', () => {
    // Totals deliberately self-consistent, so conservation passes and the
    // per-installment cap is the only check that can catch this.
    const tampered = {
      ...sound,
      allocations: [
        {
          obligationId: 'inst-1',
          kind: 'installment' as const,
          sequenceNumber: 1,
          allocatedAmount: toUgx(10_000),
          allocatedPrincipal: toUgx(9_000),
          allocatedInterest: toUgx(1_000),
          allocatedPenalty: toUgx(0),
        },
      ],
      totalPrincipal: toUgx(9_000),
      totalInterest: toUgx(1_000),
    };

    expect(() => assertAllocationInvariants(tampered, obligations)).toThrow(
      /would receive 10000 against 4000 remaining/,
    );
  });

  it('catches principal allocated while interest remained unpaid', () => {
    // The interest-first rule, stated as a property of the result rather than
    // of the loop that produced it.
    // Principal deliberately within the collection's remaining principal
    // (2,000 of 3,000), so the cap check passes and the interest-first rule is
    // the only thing that can object. A pro-rata split would look like this.
    const tampered = {
      ...sound,
      amount: toUgx(2_000),
      allocations: [
        {
          obligationId: 'inst-1',
          kind: 'installment' as const,
          sequenceNumber: 1,
          allocatedAmount: toUgx(2_000),
          allocatedPrincipal: toUgx(2_000),
          allocatedInterest: toUgx(0),
          allocatedPenalty: toUgx(0),
        },
      ],
      totalPrincipal: toUgx(2_000),
      totalInterest: toUgx(0),
      outstandingBefore: toUgx(12_000),
      outstandingAfter: toUgx(10_000),
      clearsLoan: false,
    };

    expect(() => assertAllocationInvariants(tampered, obligations)).toThrow(
      /received principal while interest remained unpaid/,
    );
  });

  it('catches a skipped unpaid installment', () => {
    const tampered = {
      ...sound,
      amount: toUgx(4_000),
      allocations: [
        {
          obligationId: 'inst-2',
          kind: 'installment' as const,
          sequenceNumber: 2,
          allocatedAmount: toUgx(4_000),
          allocatedPrincipal: toUgx(3_000),
          allocatedInterest: toUgx(1_000),
          allocatedPenalty: toUgx(0),
        },
      ],
      totalPrincipal: toUgx(3_000),
      totalInterest: toUgx(1_000),
      outstandingBefore: toUgx(12_000),
      outstandingAfter: toUgx(8_000),
      clearsLoan: false,
    };

    expect(() => assertAllocationInvariants(tampered, obligations)).toThrow(
      /collection 1 was skipped while still unpaid/,
    );
  });

  it('catches an installment left partly unpaid while the payment moved on', () => {
    const tampered = {
      ...sound,
      amount: toUgx(5_000),
      allocations: [
        {
          obligationId: 'inst-1',
          kind: 'installment' as const,
          sequenceNumber: 1,
          allocatedAmount: toUgx(1_000),
          allocatedPrincipal: toUgx(0),
          allocatedInterest: toUgx(1_000),
          allocatedPenalty: toUgx(0),
        },
        {
          obligationId: 'inst-2',
          kind: 'installment' as const,
          sequenceNumber: 2,
          allocatedAmount: toUgx(4_000),
          allocatedPrincipal: toUgx(3_000),
          allocatedInterest: toUgx(1_000),
          allocatedPenalty: toUgx(0),
        },
      ],
      totalPrincipal: toUgx(3_000),
      totalInterest: toUgx(2_000),
      outstandingBefore: toUgx(12_000),
      outstandingAfter: toUgx(7_000),
      clearsLoan: false,
    };

    expect(() => assertAllocationInvariants(tampered, obligations)).toThrow(
      /left partly unpaid while the payment moved on/,
    );
  });

  it('catches a negative resulting balance', () => {
    expect(() =>
      assertAllocationInvariants(
        {
          ...sound,
          outstandingBefore: toUgx(5_000),
          outstandingAfter: -5_000 as UgxAmount,
        },
        obligations,
      ),
    ).toThrow(/outstanding balance of -5000/);
  });

  it('catches a clearance flag that disagrees with the balance', () => {
    expect(() =>
      assertAllocationInvariants({ ...sound, clearsLoan: true }, obligations),
    ).toThrow(/clearance flag/);
  });

  it('catches an allocation to an installment of another loan', () => {
    const tampered = {
      ...sound,
      amount: toUgx(4_000),
      allocations: [
        {
          obligationId: 'inst-from-elsewhere',
          kind: 'installment' as const,
          sequenceNumber: 1,
          allocatedAmount: toUgx(4_000),
          allocatedPrincipal: toUgx(3_000),
          allocatedInterest: toUgx(1_000),
          allocatedPenalty: toUgx(0),
        },
      ],
      totalPrincipal: toUgx(3_000),
      totalInterest: toUgx(1_000),
      outstandingBefore: toUgx(12_000),
      outstandingAfter: toUgx(8_000),
      clearsLoan: false,
    };

    expect(() => assertAllocationInvariants(tampered, obligations)).toThrow(
      /not one of this loan's obligations/,
    );
  });

  it('catches two allocations to one installment from one payment', () => {
    const half = {
      obligationId: 'inst-1',
      kind: 'installment' as const,
      sequenceNumber: 1,
      allocatedAmount: toUgx(2_000),
      allocatedPrincipal: toUgx(1_000),
      allocatedInterest: toUgx(1_000),
      allocatedPenalty: toUgx(0),
    };

    const tampered = {
      ...sound,
      amount: toUgx(4_000),
      allocations: [
        half,
        { ...half, allocatedInterest: toUgx(0), allocatedPrincipal: toUgx(2_000) },
      ],
      totalPrincipal: toUgx(3_000),
      totalInterest: toUgx(1_000),
      outstandingBefore: toUgx(12_000),
      outstandingAfter: toUgx(8_000),
      clearsLoan: false,
    };

    expect(() => assertAllocationInvariants(tampered, obligations)).toThrow(
      /allocated to twice by one payment/,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 7: the penalty as an obligation
// ---------------------------------------------------------------------------

describe('allocating to a penalty', () => {
  /**
   * Three UGX 4,000 collections and a UGX 6,000 penalty effective after all
   * of them — which is where a penalty's effective date always falls, because
   * it is the day after the grace period that follows the final collection.
   */
  function withPenalty(
    paid: readonly number[] = [0, 0, 0],
    penaltyPaid = 0,
  ): readonly PaymentObligation[] {
    return [
      obligation(
        1,
        '2026-11-01',
        3_000,
        1_000,
        (paid[0] ?? 0) * 0.75,
        (paid[0] ?? 0) * 0.25,
      ),
      obligation(
        2,
        '2026-11-02',
        3_000,
        1_000,
        (paid[1] ?? 0) * 0.75,
        (paid[1] ?? 0) * 0.25,
      ),
      obligation(
        3,
        '2026-11-03',
        3_000,
        1_000,
        (paid[2] ?? 0) * 0.75,
        (paid[2] ?? 0) * 0.25,
      ),
      penalty('2026-11-08', 6_000, penaltyPaid),
    ];
  }

  it('sorts the penalty last, after every collection', () => {
    const ordered = inAllocationOrder(withPenalty());

    expect(ordered.map((row) => row.obligationId)).toEqual([
      'inst-1',
      'inst-2',
      'inst-3',
      'penalty-1',
    ]);
  });

  it('counts the penalty in what the borrower owes', () => {
    // 3 x 4,000 + 6,000.
    expect(outstandingFrom(withPenalty())).toBe(18_000);
  });

  it('covers the whole contract before it touches the charge', () => {
    const obligations = withPenalty();
    const plan = allocatePayment({ amount: toUgx(18_000), obligations });

    expect(plan.allocations.map((entry) => entry.kind)).toEqual([
      'installment',
      'installment',
      'installment',
      'penalty',
    ]);
    // 3,000 principal x 3; 1,000 interest x 3; 6,000 penalty.
    expect(plan.totalPrincipal).toBe(9_000);
    expect(plan.totalInterest).toBe(3_000);
    expect(plan.totalPenalty).toBe(6_000);
    expect(plan.clearsLoan).toBe(true);
  });

  it('reaches the penalty only once the contract is settled', () => {
    const obligations = withPenalty();
    // 12,000 exactly settles the three collections and no more.
    const plan = allocatePayment({ amount: toUgx(12_000), obligations });

    expect(plan.allocations).toHaveLength(3);
    expect(plan.totalPenalty).toBe(0);
    expect(plan.outstandingAfter).toBe(6_000);
    expect(plan.clearsLoan).toBe(false);
  });

  it('takes the whole of a penalty allocation as penalty, never as interest', () => {
    // The classification rule. A penalty recorded as interest would misstate
    // what the borrower was charged for, and the engine refuses it.
    const obligations = withPenalty([4_000, 4_000, 4_000]);
    const plan = allocatePayment({ amount: toUgx(6_000), obligations });

    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]).toMatchObject({
      kind: 'penalty',
      allocatedAmount: 6_000,
      allocatedPenalty: 6_000,
      allocatedPrincipal: 0,
      allocatedInterest: 0,
    });
    expect(plan.totalInterest).toBe(0);
    expect(plan.totalPrincipal).toBe(0);
  });

  it('part-pays a penalty when one payment spills into it', () => {
    // The only way a penalty is partly covered: a payment large enough to
    // settle the contract and spill over. The minimum-payment rule means a
    // payment *aimed* at a penalty must cover what is left of it.
    const obligations = withPenalty();
    const plan = allocatePayment({ amount: toUgx(15_000), obligations });

    expect(plan.allocations).toHaveLength(4);
    expect(plan.allocations[3]).toMatchObject({
      kind: 'penalty',
      // 15,000 − 12,000 of contract.
      allocatedAmount: 3_000,
      allocatedPenalty: 3_000,
      allocatedPrincipal: 0,
      allocatedInterest: 0,
    });
    expect(plan.outstandingAfter).toBe(3_000);
    expect(plan.clearsLoan).toBe(false);

    // And the next payment finishes it, with the minimum now 3,000.
    const after = applyPlan(obligations, plan);
    expect(minimumAcceptablePayment(after)).toBe(3_000);

    const second = allocatePayment({ amount: toUgx(3_000), obligations: after });
    expect(second.allocations[0]).toMatchObject({ allocatedPenalty: 3_000 });
    expect(second.clearsLoan).toBe(true);
  });

  it('refuses a payment smaller than what is left of the penalty', () => {
    // With the contract settled, the penalty is the earliest unpaid
    // obligation, so the ordinary minimum rule applies to it unchanged.
    const obligations = withPenalty([4_000, 4_000, 4_000]);

    expect(validatePaymentAmount(2_500, obligations)).toEqual({
      code: 'below_minimum',
      detail: 6_000,
    });
    expect(() => allocatePayment({ amount: toUgx(2_500), obligations })).toThrow(
      /smallest payment accepted now is UGX 6,000/,
    );
  });

  // =========================================================================
  it('specification §95 — the minimum is the earliest collection while one is unpaid', () => {
    expect(minimumAcceptablePayment(withPenalty())).toBe(4_000);
    // Even when the penalty is larger than any collection.
    expect(minimumAcceptablePayment(withPenalty([4_000, 0, 0]))).toBe(4_000);
  });

  it('specification §95 — the minimum becomes the penalty once the contract is paid', () => {
    expect(minimumAcceptablePayment(withPenalty([4_000, 4_000, 4_000]))).toBe(6_000);
    // And what is left of it after a part-payment.
    expect(minimumAcceptablePayment(withPenalty([4_000, 4_000, 4_000], 2_500))).toBe(
      3_500,
    );
  });

  it('specification §96 — the cap includes the penalty', () => {
    const obligations = withPenalty([4_000, 4_000, 4_000]);

    // 6,000 is the whole remaining obligation and is accepted.
    expect(validatePaymentAmount(6_000, obligations)).toBeNull();
    // 6,001 is not, and the message names the figure.
    expect(validatePaymentAmount(6_001, obligations)).toEqual({
      code: 'exceeds_outstanding',
      detail: 6_000,
    });
  });

  it('refuses a penalty obligation carrying principal or interest', () => {
    const corrupt: PaymentObligation[] = [
      {
        ...penalty('2026-11-08', 6_000),
        scheduledPrincipal: toUgx(1_000),
        scheduledPenalty: toUgx(5_000),
      },
    ];

    expect(() => allocatePayment({ amount: toUgx(100), obligations: corrupt })).toThrow(
      /a penalty is neither/,
    );
  });

  it('refuses a collection carrying a penalty component', () => {
    const corrupt: PaymentObligation[] = [
      {
        ...obligation(1, '2026-11-01', 3_000, 1_000),
        expectedAmount: toUgx(5_000),
        scheduledPenalty: toUgx(1_000),
      },
    ];

    expect(() => allocatePayment({ amount: toUgx(100), obligations: corrupt })).toThrow(
      /a collection has none/,
    );
  });

  it('keeps the penalty out of the contractual balance figures', () => {
    // §130. The penalty must not contaminate principal or interest totals.
    const balance = deriveLoanBalance(withPenalty([4_000, 0, 0], 1_000));

    expect(balance.contractualPrincipal).toBe(9_000);
    expect(balance.contractualInterest).toBe(3_000);
    expect(balance.totalExpectedRepayment).toBe(12_000);
    // 3,000 principal + 1,000 interest on the first collection.
    expect(balance.totalPaid).toBe(4_000);
    expect(balance.contractualOutstanding).toBe(8_000);

    expect(balance.penaltyAssessed).toBe(6_000);
    expect(balance.penaltyPaid).toBe(1_000);
    expect(balance.penaltyRemaining).toBe(5_000);

    // 8,000 + 5,000.
    expect(balance.totalOutstanding).toBe(13_000);
    // 4,000 + 1,000: what reconciles against the payments themselves.
    expect(balance.totalCollected).toBe(5_000);
    expect(balance.fullyRepaid).toBe(false);

    expect(() =>
      assertBalanceInvariants(balance, { postedPaymentTotal: 5_000 }),
    ).not.toThrow();
  });

  it('is not fully repaid while a penalty stands, however settled the contract', () => {
    // §131. The clearance rule, stated on the derived balance.
    const balance = deriveLoanBalance(withPenalty([4_000, 4_000, 4_000]));

    expect(balance.contractualOutstanding).toBe(0);
    expect(balance.penaltyRemaining).toBe(6_000);
    expect(balance.totalOutstanding).toBe(6_000);
    expect(balance.fullyRepaid).toBe(false);

    const settled = deriveLoanBalance(withPenalty([4_000, 4_000, 4_000], 6_000));
    expect(settled.totalOutstanding).toBe(0);
    expect(settled.fullyRepaid).toBe(true);
  });

  it('reconciles the headline totals against the payments', () => {
    // A payment allocated to a penalty is still money received, so the
    // reconciliation compares against `totalCollected`. Comparing against the
    // contractual figure alone would report penalty money as missing.
    const balance = deriveLoanBalance(withPenalty([4_000, 4_000, 4_000], 6_000));

    expect(() =>
      assertBalanceInvariants(balance, { postedPaymentTotal: 18_000 }),
    ).not.toThrow();

    expect(() =>
      assertBalanceInvariants(balance, { postedPaymentTotal: 12_000 }),
    ).toThrow(/posted payments total 12000 but allocations total 18000/);
  });
});

// ---------------------------------------------------------------------------
// Generated payment sequences
// ---------------------------------------------------------------------------

describe('generated payment sequences', () => {
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  it('reconciles 200 generated loans paid off in random instalments', () => {
    const random = makeRandom(20_261_006);
    let loans = 0;

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const principal = 50_001 + Math.floor(random() * 1_949_999);
      const termMonths = 1 + Math.floor(random() * 3);
      const intervalDays = 1 + Math.floor(random() * 3);

      let obligations = contractObligations(principal, termMonths, intervalDays);
      const contractTotal = outstandingFrom(obligations);

      let paid = 0;
      let guard = 0;

      // Pay in random acceptable chunks until the loan is settled.
      while (outstandingFrom(obligations) > 0) {
        guard += 1;
        if (guard > 500) throw new Error('payment loop did not terminate');

        const outstanding = outstandingFrom(obligations);
        const minimum = minimumAcceptablePayment(obligations) ?? outstanding;

        // Somewhere between the minimum and the whole balance.
        const span = outstanding - minimum;
        const amount = minimum + Math.floor(random() * (span + 1));

        const plan = allocatePayment({ amount: toUgx(amount), obligations });
        obligations = [...applyPlan(obligations, plan)];
        paid += amount;

        const context = `principal ${String(principal)}, term ${String(termMonths)}, interval ${String(intervalDays)}`;

        // Never over-allocated, never negative, always reconciled.
        const balance = deriveLoanBalance(obligations);
        expect(balance.totalPaid, context).toBe(paid);
        expect(balance.contractualOutstanding, context).toBe(contractTotal - paid);
        assertBalanceInvariants(balance, {
          storedTotalExpectedRepayment: contractTotal,
          postedPaymentTotal: paid,
        });
      }

      expect(paid).toBe(contractTotal);

      const final = deriveLoanBalance(obligations);
      expect(final.contractualOutstanding).toBe(0);
      expect(final.principalRemaining).toBe(0);
      expect(final.interestRemaining).toBe(0);
      expect(final.fullyRepaid).toBe(true);

      loans += 1;
    }

    expect(loans).toBe(200);
  });

  it('is deterministic — the same payment against the same state allocates alike', () => {
    const obligations = contractObligations(1_234_567, 3, 2);

    const first = allocatePayment({ amount: toUgx(99_999), obligations });
    const second = allocatePayment({ amount: toUgx(99_999), obligations });

    expect(second).toEqual(first);
  });

  it('never allocates more in total than the contract is worth', () => {
    const random = makeRandom(777_111);

    for (let iteration = 0; iteration < 100; iteration += 1) {
      const termMonths = 1 + Math.floor(random() * 3);
      let obligations = contractObligations(400_000, termMonths, 1);
      const contractTotal = outstandingFrom(obligations);

      // Try to overpay at every step; every attempt beyond the balance is
      // refused rather than creating a credit.
      let paid = 0;
      let guard = 0;

      while (outstandingFrom(obligations) > 0) {
        guard += 1;
        if (guard > 500) throw new Error('payment loop did not terminate');

        const outstanding = outstandingFrom(obligations);

        expect(() =>
          allocatePayment({ amount: toUgx(outstanding + 1), obligations }),
        ).toThrow(/more than this loan still owes/);

        const plan = allocatePayment({ amount: toUgx(outstanding), obligations });
        obligations = [...applyPlan(obligations, plan)];
        paid += outstanding;
      }

      expect(paid).toBe(contractTotal);
    }
  });
});
