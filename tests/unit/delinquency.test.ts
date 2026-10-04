import { describe, expect, it } from 'vitest';

import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  assertDelinquencyInvariants,
  currentDue,
  DELINQUENCY_STATE_DESCRIPTIONS,
  DELINQUENCY_STATE_LABELS,
  DELINQUENCY_STATE_SEVERITY,
  DELINQUENCY_STATES,
  daysPastDue,
  delinquencyStateFor,
  deriveDelinquency,
  dueTodayAmount,
  graceEndDate,
  isDelinquencyState,
  isPastFinalDueDate,
  isPenaltyDateReached,
  isWithinGracePeriod,
  missedInstallmentCount,
  oldestPastDueDate,
  oldestUnpaidDueDate,
  pastDueArrears,
  penaltyAmountFor,
  penaltyEffectiveDate,
  scheduledCompletionDate,
} from '@/lib/domain/delinquency';
import type { PaymentObligation } from '@/lib/domain/payment';

/**
 * The delinquency engine.
 *
 * ## How expectations are derived in this file
 *
 * Every expected figure is **hard-coded**, with the arithmetic written out in
 * a comment beside it. Nothing is compared against a second call to the
 * engine: an engine that agrees with itself would pass a test suite built that
 * way while counting grace days from the wrong end.
 *
 * The specification's worked examples — one missed UGX 4,000 collection, two
 * missed, the UGX 100,000 penalty, the UGX 40,000 grace payment, the payment
 * after a penalty — appear here with the specification's own numbers.
 *
 * ## Why every test fixes the date
 *
 * Not one assertion depends on the real today. A delinquency figure is a
 * comparison against a date, so a suite that used the system clock would mean
 * something different every morning and would pass or fail by the calendar.
 */

const d = (value: string): BusinessDate => toBusinessDate(value);

/** One UGX 4,000 collection — principal 3,000, interest 1,000. */
function collection(
  number: number,
  dueDate: string,
  paid = 0,
  amount = 4_000,
): PaymentObligation {
  const principal = Math.round((amount * 3) / 4);
  const interest = amount - principal;

  // Interest first, as the allocation engine applies it, so a part-paid
  // fixture is the state a real part-payment would actually leave.
  const paidInterest = Math.min(interest, paid);
  const paidPrincipal = paid - paidInterest;

  return {
    obligationId: `inst-${String(number)}`,
    kind: 'installment',
    sequenceNumber: number,
    effectiveDate: d(dueDate),
    expectedAmount: toUgx(amount),
    scheduledPrincipal: toUgx(principal),
    scheduledInterest: toUgx(interest),
    scheduledPenalty: toUgx(0),
    allocatedAmount: toUgx(paid),
    allocatedPrincipal: toUgx(paidPrincipal),
    allocatedInterest: toUgx(paidInterest),
    allocatedPenalty: toUgx(0),
  };
}

function penaltyObligation(
  effectiveDate: string,
  amount: number,
  paid = 0,
): PaymentObligation {
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

/** Monday, Tuesday, Wednesday — the specification's example schedule. */
function threeDays(paid: readonly number[] = [0, 0, 0]): readonly PaymentObligation[] {
  return [
    collection(1, '2026-11-02', paid[0] ?? 0),
    collection(2, '2026-11-03', paid[1] ?? 0),
    collection(3, '2026-11-04', paid[2] ?? 0),
  ];
}

// ---------------------------------------------------------------------------
// The three figures
// ---------------------------------------------------------------------------

describe('arrears, due today and current due', () => {
  it('reports nothing when no collection has fallen due', () => {
    // The day before the first collection.
    const obligations = threeDays();
    const today = d('2026-11-01');

    expect(pastDueArrears(obligations, today)).toBe(0);
    expect(dueTodayAmount(obligations, today)).toBe(0);
    expect(currentDue(obligations, today)).toBe(0);
    expect(missedInstallmentCount(obligations, today)).toBe(0);
    expect(daysPastDue(obligations, today)).toBe(0);
  });

  it('reports only today on the first due date', () => {
    const obligations = threeDays();
    const today = d('2026-11-02');

    expect(pastDueArrears(obligations, today)).toBe(0);
    expect(dueTodayAmount(obligations, today)).toBe(4_000);
    expect(currentDue(obligations, today)).toBe(4_000);
    // Nothing is *past* due on its own due date: a payment today is on time.
    expect(missedInstallmentCount(obligations, today)).toBe(0);
    expect(daysPastDue(obligations, today)).toBe(0);
  });

  // =========================================================================
  it('specification scenario A — one missed collection doubles the demand', () => {
    // Monday UGX 4,000 unpaid; Tuesday UGX 4,000 falls due.
    const obligations = threeDays();
    const tuesday = d('2026-11-03');

    expect(pastDueArrears(obligations, tuesday)).toBe(4_000);
    expect(dueTodayAmount(obligations, tuesday)).toBe(4_000);
    // 4,000 + 4,000. The specification's UGX 8,000.
    expect(currentDue(obligations, tuesday)).toBe(8_000);

    expect(missedInstallmentCount(obligations, tuesday)).toBe(1);
    expect(daysPastDue(obligations, tuesday)).toBe(1);
    expect(oldestPastDueDate(obligations, tuesday)).toBe('2026-11-02');
  });

  it('leaves both scheduled rows untouched while doing it', () => {
    // The whole point: Monday stays 4,000 and Tuesday stays 4,000. The 8,000
    // exists only as a derived sum.
    const obligations = threeDays();

    expect(obligations.map((row) => row.expectedAmount)).toEqual([4_000, 4_000, 4_000]);
    expect(obligations.map((row) => row.effectiveDate)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  // =========================================================================
  it('specification scenario C — two missed collections make UGX 12,000', () => {
    // Monday missed, Tuesday missed, Wednesday due.
    const obligations = threeDays();
    const wednesday = d('2026-11-04');

    // 4,000 + 4,000.
    expect(pastDueArrears(obligations, wednesday)).toBe(8_000);
    expect(dueTodayAmount(obligations, wednesday)).toBe(4_000);
    // The specification's UGX 12,000.
    expect(currentDue(obligations, wednesday)).toBe(12_000);

    expect(missedInstallmentCount(obligations, wednesday)).toBe(2);
    // Monday to Wednesday.
    expect(daysPastDue(obligations, wednesday)).toBe(2);
  });

  it('keeps accumulating without adding any interest', () => {
    const obligations = threeDays();

    // A week after the last collection: all three are overdue and the total
    // is exactly their sum. Nothing has grown.
    expect(currentDue(obligations, d('2026-11-11'))).toBe(12_000);
    expect(missedInstallmentCount(obligations, d('2026-11-11'))).toBe(3);
    expect(daysPastDue(obligations, d('2026-11-11'))).toBe(9);
  });

  // =========================================================================
  it('specification scenario B — catching up clears the demand', () => {
    // Monday missed, then UGX 8,000 paid on Tuesday: oldest-first covers
    // Monday in full and then Tuesday in full.
    const obligations = threeDays([4_000, 4_000, 0]);
    const tuesday = d('2026-11-03');

    expect(pastDueArrears(obligations, tuesday)).toBe(0);
    expect(dueTodayAmount(obligations, tuesday)).toBe(0);
    expect(currentDue(obligations, tuesday)).toBe(0);
    expect(missedInstallmentCount(obligations, tuesday)).toBe(0);
    expect(daysPastDue(obligations, tuesday)).toBe(0);
    expect(oldestPastDueDate(obligations, tuesday)).toBeNull();
    // Wednesday is still ahead and still uncovered.
    expect(oldestUnpaidDueDate(obligations)).toBe('2026-11-04');
  });

  it('specification scenario — paying more than the arrears', () => {
    // UGX 10,000 against a missed Monday and a due Tuesday covers both and
    // puts 2,000 onto Wednesday.
    const obligations = threeDays([4_000, 4_000, 2_000]);
    const tuesday = d('2026-11-03');

    expect(currentDue(obligations, tuesday)).toBe(0);
    // And Wednesday now needs only 2,000.
    expect(dueTodayAmount(obligations, d('2026-11-04'))).toBe(2_000);
  });

  // =========================================================================
  it('specification §48 — partial historical coverage contributes only what is left', () => {
    // Monday 4,000 scheduled, 1,500 effectively covered; Tuesday 4,000 due.
    const obligations = [
      collection(1, '2026-11-02', 1_500),
      collection(2, '2026-11-03', 0),
    ];
    const tuesday = d('2026-11-03');

    // 4,000 − 1,500.
    expect(pastDueArrears(obligations, tuesday)).toBe(2_500);
    expect(dueTodayAmount(obligations, tuesday)).toBe(4_000);
    // The specification's UGX 6,500 — not 8,000.
    expect(currentDue(obligations, tuesday)).toBe(6_500);
    // Still one missed collection, partly covered.
    expect(missedInstallmentCount(obligations, tuesday)).toBe(1);
  });

  it('counts a fully covered past collection as not missed', () => {
    const obligations = [
      collection(1, '2026-11-02', 4_000),
      collection(2, '2026-11-03', 0),
    ];

    expect(missedInstallmentCount(obligations, d('2026-11-04'))).toBe(1);
    expect(oldestPastDueDate(obligations, d('2026-11-04'))).toBe('2026-11-03');
  });

  it('excludes a penalty from every scheduled figure', () => {
    // A penalty is a charge with its own date and its own line. Folding it
    // into "due today" would make that figure jump by tens of thousands on
    // one morning and hide which part of the demand is contractual.
    const obligations = [
      collection(1, '2026-11-02', 0),
      penaltyObligation('2026-11-08', 50_000),
    ];
    const today = d('2026-11-09');

    expect(pastDueArrears(obligations, today)).toBe(4_000);
    expect(dueTodayAmount(obligations, today)).toBe(0);
    expect(currentDue(obligations, today)).toBe(4_000);
    expect(missedInstallmentCount(obligations, today)).toBe(1);
    expect(scheduledCompletionDate(obligations)).toBe('2026-11-02');
  });
});

// ---------------------------------------------------------------------------
// Lateness, for cadences that are not daily
// ---------------------------------------------------------------------------

describe('lateness on non-daily schedules', () => {
  it('counts three missed every-3-days collections as nine days, not three', () => {
    // The distinction the specification insists on. Reporting the count as
    // days would overstate this borrower's lateness threefold.
    const obligations = [
      collection(1, '2026-11-02'),
      collection(2, '2026-11-05'),
      collection(3, '2026-11-08'),
    ];
    const today = d('2026-11-11');

    expect(missedInstallmentCount(obligations, today)).toBe(3);
    // 2 November to 11 November.
    expect(daysPastDue(obligations, today)).toBe(9);
    expect(currentDue(obligations, today)).toBe(12_000);
  });

  it('counts two missed every-2-days collections as four days', () => {
    const obligations = [collection(1, '2026-11-02'), collection(2, '2026-11-04')];
    const today = d('2026-11-06');

    expect(missedInstallmentCount(obligations, today)).toBe(2);
    expect(daysPastDue(obligations, today)).toBe(4);
  });

  it('measures lateness from the oldest uncovered collection, not the newest', () => {
    const obligations = [
      collection(1, '2026-11-02'),
      collection(2, '2026-11-05', 4_000),
      collection(3, '2026-11-08'),
    ];
    const today = d('2026-11-10');

    // The middle one is covered; lateness still runs from the 2nd.
    expect(oldestPastDueDate(obligations, today)).toBe('2026-11-02');
    expect(daysPastDue(obligations, today)).toBe(8);
    expect(missedInstallmentCount(obligations, today)).toBe(2);
  });

  it('counts days across a month end', () => {
    const obligations = [collection(1, '2026-10-30')];
    expect(daysPastDue(obligations, d('2026-11-02'))).toBe(3);
  });

  it('counts days across a year end', () => {
    const obligations = [collection(1, '2026-12-30')];
    expect(daysPastDue(obligations, d('2027-01-02'))).toBe(3);
  });

  it('counts days across a leap day', () => {
    // 2028 is a leap year: 27 Feb to 2 Mar is 4 days through the 29th.
    const obligations = [collection(1, '2028-02-27')];
    expect(daysPastDue(obligations, d('2028-03-02'))).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Expiry and grace
// ---------------------------------------------------------------------------

describe('the grace period boundary', () => {
  // The specification's worked example: final due 10 October, grace 3 days.
  const FINAL = d('2026-10-10');
  const GRACE = 3;

  it('ends on the third day after the final due date', () => {
    // 11, 12, 13 October are grace days one, two and three.
    expect(graceEndDate(FINAL, GRACE)).toBe('2026-10-13');
  });

  it('makes the penalty effective on the fourth day', () => {
    expect(penaltyEffectiveDate(FINAL, GRACE)).toBe('2026-10-14');
  });

  it('treats a payment on the final due date as on time', () => {
    expect(isPastFinalDueDate(FINAL, d('2026-10-10'))).toBe(false);
    expect(isWithinGracePeriod(FINAL, GRACE, d('2026-10-10'))).toBe(false);
    expect(isPenaltyDateReached(FINAL, GRACE, d('2026-10-10'))).toBe(false);
  });

  it('walks the boundary day by day', () => {
    const states = [
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ].map((date) => ({
      date,
      past: isPastFinalDueDate(FINAL, d(date)),
      grace: isWithinGracePeriod(FINAL, GRACE, d(date)),
      penalty: isPenaltyDateReached(FINAL, GRACE, d(date)),
    }));

    expect(states).toEqual([
      // Before the end: not past due, no grace, no penalty.
      { date: '2026-10-09', past: false, grace: false, penalty: false },
      // The due date itself: still on time.
      { date: '2026-10-10', past: false, grace: false, penalty: false },
      { date: '2026-10-11', past: true, grace: true, penalty: false },
      { date: '2026-10-12', past: true, grace: true, penalty: false },
      // Grace day three, the last day to pay without a charge.
      { date: '2026-10-13', past: true, grace: true, penalty: false },
      // The charge applies from the start of this day.
      { date: '2026-10-14', past: true, grace: false, penalty: true },
      { date: '2026-10-15', past: true, grace: false, penalty: true },
    ]);
  });

  it('handles a zero-day grace period without an off-by-one', () => {
    // Grace ends on the due date itself, so the charge applies the next day.
    expect(graceEndDate(FINAL, 0)).toBe('2026-10-10');
    expect(penaltyEffectiveDate(FINAL, 0)).toBe('2026-10-11');
    expect(isWithinGracePeriod(FINAL, 0, d('2026-10-11'))).toBe(false);
    expect(isPenaltyDateReached(FINAL, 0, d('2026-10-11'))).toBe(true);
  });

  it('crosses a month end correctly', () => {
    // Final due 30 October, grace 3: 31 Oct, 1 Nov, 2 Nov; charge on 3 Nov.
    expect(graceEndDate(d('2026-10-30'), 3)).toBe('2026-11-02');
    expect(penaltyEffectiveDate(d('2026-10-30'), 3)).toBe('2026-11-03');
  });

  it('crosses a year end correctly', () => {
    expect(graceEndDate(d('2026-12-30'), 3)).toBe('2027-01-02');
    expect(penaltyEffectiveDate(d('2026-12-30'), 3)).toBe('2027-01-03');
  });

  it('crosses a leap day correctly', () => {
    // 2028-02-27 + 3 = 2028-03-01, through the 29th.
    expect(graceEndDate(d('2028-02-27'), 3)).toBe('2028-03-01');
    expect(penaltyEffectiveDate(d('2028-02-27'), 3)).toBe('2028-03-02');
  });

  it('refuses a fractional or negative grace period', () => {
    expect(() => graceEndDate(FINAL, 1.5)).toThrow(/whole number of days/);
    expect(() => graceEndDate(FINAL, -1)).toThrow(/whole number of days/);
  });
});

// ---------------------------------------------------------------------------
// The penalty
// ---------------------------------------------------------------------------

describe('the penalty amount', () => {
  it('specification §124 — UGX 100,000 at 50% is UGX 50,000', () => {
    expect(penaltyAmountFor(toUgx(100_000), 5_000)).toBe(50_000);
  });

  it('specification §125 — UGX 60,000 at 50% is UGX 30,000', () => {
    expect(penaltyAmountFor(toUgx(60_000), 5_000)).toBe(30_000);
  });

  it('rounds half up to the whole shilling', () => {
    // 4,001 × 50% = 2,000.5, which rounds to 2,001 — the project's half-up
    // rule, and the same answer the database's CHECK computes as
    // (4001 * 5000 + 5000) / 10000.
    expect(penaltyAmountFor(toUgx(4_001), 5_000)).toBe(2_001);
    expect(penaltyAmountFor(toUgx(4_003), 5_000)).toBe(2_002);
    // 1 × 50% = 0.5 → 1.
    expect(penaltyAmountFor(toUgx(1), 5_000)).toBe(1);
  });

  it('agrees with the database"s integer expression on awkward bases', () => {
    // Stated as the arithmetic the CHECK constraint performs, computed here
    // by hand rather than by calling the engine twice.
    for (const [basis, expected] of [
      [1, 1],
      [3, 2],
      [7, 4],
      [99, 50],
      [12_345, 6_173],
      [112_000, 56_000],
      [613_333, 306_667],
    ] as const) {
      expect(penaltyAmountFor(toUgx(basis), 5_000), `basis ${String(basis)}`).toBe(
        expected,
      );
    }
  });

  it('uses the rate it is given, not a hard-coded half', () => {
    expect(penaltyAmountFor(toUgx(100_000), 2_500)).toBe(25_000);
    expect(penaltyAmountFor(toUgx(100_000), 10_000)).toBe(100_000);
    expect(penaltyAmountFor(toUgx(100_000), 1)).toBe(10);
  });

  it('charges nothing at a rate of zero', () => {
    expect(penaltyAmountFor(toUgx(100_000), 0)).toBe(0);
  });

  it('refuses a fractional or negative rate', () => {
    expect(() => penaltyAmountFor(toUgx(100_000), 2_500.5)).toThrow();
    expect(() => penaltyAmountFor(toUgx(100_000), -5_000)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The whole position
// ---------------------------------------------------------------------------

describe('deriveDelinquency', () => {
  it('reports a current loan as current', () => {
    const position = deriveDelinquency({
      obligations: threeDays([4_000, 0, 0]),
      today: d('2026-11-02'),
      graceDays: 3,
      penaltyRateBps: 5_000,
    });

    expect(position.state).toBe('current');
    expect(position.currentDue).toBe(0);
    expect(position.contractualOutstanding).toBe(8_000);
    expect(position.totalOutstanding).toBe(8_000);
    expect(position.penaltyApplied).toBe(false);
    expect(position.penaltyEligible).toBe(false);
    expect(() => assertDelinquencyInvariants(position)).not.toThrow();
  });

  it('reports today"s uncovered collection as due_today', () => {
    const position = deriveDelinquency({
      obligations: threeDays(),
      today: d('2026-11-02'),
      graceDays: 3,
      penaltyRateBps: 5_000,
    });

    expect(position.state).toBe('due_today');
    expect(position.dueToday).toBe(4_000);
    expect(position.arrearsAmount).toBe(0);
  });

  it('reports an uncovered past collection as in_arrears', () => {
    const position = deriveDelinquency({
      obligations: threeDays(),
      today: d('2026-11-03'),
      graceDays: 3,
      penaltyRateBps: 5_000,
    });

    expect(position.state).toBe('in_arrears');
    expect(position.currentDue).toBe(8_000);
    expect(position.daysPastDue).toBe(1);
    expect(() => assertDelinquencyInvariants(position)).not.toThrow();
  });

  it('reports the grace period, with its dates', () => {
    const position = deriveDelinquency({
      obligations: threeDays(),
      today: d('2026-11-06'),
      graceDays: 3,
      penaltyRateBps: 5_000,
      basisAsOfGraceEnd: toUgx(12_000),
    });

    // Final collection 4 November; grace to the 7th; charge on the 8th.
    expect(position.scheduledCompletionDate).toBe('2026-11-04');
    expect(position.graceEndDate).toBe('2026-11-07');
    expect(position.penaltyEffectiveDate).toBe('2026-11-08');
    expect(position.withinGracePeriod).toBe(true);
    expect(position.state).toBe('grace_period');
    // Inside grace, so not yet eligible however much is owed.
    expect(position.penaltyEligible).toBe(false);
    expect(position.penaltyProjectedAmount).toBe(0);
  });

  it('reports eligibility and the projected charge once grace has passed', () => {
    const position = deriveDelinquency({
      obligations: threeDays(),
      today: d('2026-11-08'),
      graceDays: 3,
      penaltyRateBps: 5_000,
      basisAsOfGraceEnd: toUgx(12_000),
    });

    expect(position.state).toBe('expired_unpaid');
    expect(position.penaltyEligible).toBe(true);
    // 12,000 × 50%.
    expect(position.penaltyProjectedAmount).toBe(6_000);
    // And it is not in the balance: the charge does not exist yet.
    expect(position.totalOutstanding).toBe(12_000);
    expect(() => assertDelinquencyInvariants(position)).not.toThrow();
  });

  it('projects nothing when the ledger says nothing was owed at the deadline', () => {
    // A borrower who settled inside grace. A later reversal is what would
    // make the basis positive again, and the ledger decides that.
    const position = deriveDelinquency({
      obligations: threeDays([4_000, 4_000, 4_000]),
      today: d('2026-11-08'),
      graceDays: 3,
      penaltyRateBps: 5_000,
      basisAsOfGraceEnd: toUgx(0),
    });

    expect(position.penaltyEligible).toBe(false);
    expect(position.penaltyProjectedAmount).toBe(0);
    expect(position.state).toBe('current');
  });

  it('projects nothing when the basis is unknown', () => {
    // No basis supplied means "this caller cannot answer that", and the
    // engine says so rather than guessing from today's balance — which is the
    // specific mistake that would let a late payer shrink their own charge.
    const position = deriveDelinquency({
      obligations: threeDays(),
      today: d('2026-11-08'),
      graceDays: 3,
      penaltyRateBps: 5_000,
    });

    expect(position.penaltyEligible).toBe(false);
    expect(position.penaltyProjectedAmount).toBe(0);
  });

  it('reports a recorded penalty as penalty_due and adds it to the total', () => {
    const position = deriveDelinquency({
      obligations: [...threeDays(), penaltyObligation('2026-11-08', 6_000)],
      today: d('2026-11-09'),
      graceDays: 3,
      penaltyRateBps: 5_000,
      basisAsOfGraceEnd: toUgx(12_000),
    });

    expect(position.state).toBe('penalty_due');
    expect(position.penaltyApplied).toBe(true);
    expect(position.penaltyAmount).toBe(6_000);
    expect(position.penaltyRemaining).toBe(6_000);
    expect(position.contractualOutstanding).toBe(12_000);
    expect(position.totalOutstanding).toBe(18_000);
    // Eligibility is spent: the charge exists.
    expect(position.penaltyEligible).toBe(false);
    expect(() => assertDelinquencyInvariants(position)).not.toThrow();
  });

  it('specification §126 — a payment after the penalty leaves UGX 110,000', () => {
    // Outstanding at expiry 100,000, penalty 50,000, then 40,000 paid. The
    // payment covers contractual obligations first, so 40,000 comes off the
    // 100,000 and the charge stands.
    const obligations = [
      collection(1, '2026-11-02', 40_000, 100_000),
      penaltyObligation('2026-11-08', 50_000),
    ];

    const position = deriveDelinquency({
      obligations,
      today: d('2026-11-09'),
      graceDays: 3,
      penaltyRateBps: 5_000,
      basisAsOfGraceEnd: toUgx(100_000),
    });

    expect(position.contractualOutstanding).toBe(60_000);
    expect(position.penaltyRemaining).toBe(50_000);
    // The specification's UGX 110,000.
    expect(position.totalOutstanding).toBe(110_000);
  });

  it('reports a settled loan as cleared and never as overdue', () => {
    const position = deriveDelinquency({
      obligations: [
        ...threeDays([4_000, 4_000, 4_000]),
        penaltyObligation('2026-11-08', 6_000, 6_000),
      ],
      today: d('2026-12-01'),
      graceDays: 3,
      penaltyRateBps: 5_000,
      loanCleared: true,
    });

    expect(position.state).toBe('cleared');
    expect(position.totalOutstanding).toBe(0);
    expect(() => assertDelinquencyInvariants(position)).not.toThrow();
  });

  it('keeps the penalty out of the contractual figures entirely', () => {
    const position = deriveDelinquency({
      obligations: [...threeDays(), penaltyObligation('2026-11-08', 6_000)],
      today: d('2026-11-09'),
      graceDays: 3,
      penaltyRateBps: 5_000,
    });

    // Scheduled totals, arrears and the completion date all ignore it.
    expect(position.arrearsAmount).toBe(12_000);
    expect(position.currentDue).toBe(12_000);
    expect(position.scheduledCompletionDate).toBe('2026-11-04');
    expect(position.contractualOutstanding).toBe(12_000);
  });

  it('uses the grace period it is given, not a business default', () => {
    const ten = deriveDelinquency({
      obligations: threeDays(),
      today: d('2026-11-08'),
      graceDays: 10,
      penaltyRateBps: 5_000,
      basisAsOfGraceEnd: toUgx(12_000),
    });

    // Grace to 14 November, so the 8th is still inside it.
    expect(ten.graceEndDate).toBe('2026-11-14');
    expect(ten.state).toBe('grace_period');
    expect(ten.penaltyEligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('delinquency state precedence', () => {
  const base = {
    loanCleared: false,
    penaltyApplied: false,
    penaltyRemaining: toUgx(0),
    penaltyEligible: false,
    pastFinalDueDate: false,
    totalOutstanding: toUgx(0),
    arrearsAmount: toUgx(0),
    dueToday: toUgx(0),
  };

  it('puts cleared above everything', () => {
    expect(
      delinquencyStateFor({
        ...base,
        loanCleared: true,
        penaltyApplied: true,
        penaltyRemaining: toUgx(50_000),
        penaltyEligible: true,
        pastFinalDueDate: true,
        totalOutstanding: toUgx(50_000),
        arrearsAmount: toUgx(4_000),
        dueToday: toUgx(4_000),
      }),
    ).toBe('cleared');
  });

  it('puts a recorded penalty above eligibility, grace and arrears', () => {
    expect(
      delinquencyStateFor({
        ...base,
        penaltyApplied: true,
        penaltyRemaining: toUgx(50_000),
        pastFinalDueDate: true,
        totalOutstanding: toUgx(150_000),
        arrearsAmount: toUgx(100_000),
      }),
    ).toBe('penalty_due');
  });

  it('puts eligibility above grace and arrears', () => {
    expect(
      delinquencyStateFor({
        ...base,
        penaltyEligible: true,
        pastFinalDueDate: true,
        totalOutstanding: toUgx(100_000),
        arrearsAmount: toUgx(100_000),
      }),
    ).toBe('expired_unpaid');
  });

  it('puts grace above arrears', () => {
    expect(
      delinquencyStateFor({
        ...base,
        pastFinalDueDate: true,
        totalOutstanding: toUgx(100_000),
        arrearsAmount: toUgx(100_000),
      }),
    ).toBe('grace_period');
  });

  it('puts arrears above due today', () => {
    expect(
      delinquencyStateFor({
        ...base,
        totalOutstanding: toUgx(8_000),
        arrearsAmount: toUgx(4_000),
        dueToday: toUgx(4_000),
      }),
    ).toBe('in_arrears');
  });

  it('falls back to due today, then current', () => {
    expect(
      delinquencyStateFor({
        ...base,
        totalOutstanding: toUgx(4_000),
        dueToday: toUgx(4_000),
      }),
    ).toBe('due_today');
    expect(delinquencyStateFor({ ...base, totalOutstanding: toUgx(4_000) })).toBe(
      'current',
    );
  });

  it('does not call a settled penalty penalty_due', () => {
    expect(
      delinquencyStateFor({
        ...base,
        penaltyApplied: true,
        penaltyRemaining: toUgx(0),
        pastFinalDueDate: true,
        totalOutstanding: toUgx(4_000),
        arrearsAmount: toUgx(4_000),
      }),
    ).toBe('grace_period');
  });

  it('does not call a loan past its due date overdue when it owes nothing', () => {
    // Past the final date with nothing outstanding and not yet marked
    // cleared: the states that assert an unpaid balance must not fire.
    expect(
      delinquencyStateFor({
        ...base,
        pastFinalDueDate: true,
        totalOutstanding: toUgx(0),
      }),
    ).toBe('current');
  });
});

describe('the delinquency vocabulary', () => {
  it('labels and describes every state', () => {
    for (const state of DELINQUENCY_STATES) {
      expect(DELINQUENCY_STATE_LABELS[state], state).toBeTruthy();
      expect(DELINQUENCY_STATE_DESCRIPTIONS[state], state).toBeTruthy();
      expect(DELINQUENCY_STATE_SEVERITY[state], state).toBeGreaterThanOrEqual(0);
    }
  });

  it('orders severity with the most pressing first and settled last', () => {
    const ordered = [...DELINQUENCY_STATES].sort(
      (left, right) =>
        DELINQUENCY_STATE_SEVERITY[left] - DELINQUENCY_STATE_SEVERITY[right],
    );

    expect(ordered).toEqual([
      'penalty_due',
      'expired_unpaid',
      'grace_period',
      'in_arrears',
      'due_today',
      'current',
      'cleared',
    ]);
  });

  it('recognises its own states and nothing else', () => {
    for (const state of DELINQUENCY_STATES) expect(isDelinquencyState(state)).toBe(true);

    for (const value of ['overdue', 'missed', 'late', '', null, undefined, 7]) {
      expect(isDelinquencyState(value)).toBe(false);
    }
  });

  it('never uses a label that asserts a payment was missed on purpose', () => {
    // "Defaulted", "delinquent" and "bad" are judgements about a person.
    // These labels describe the state of an account.
    const labels = Object.values(DELINQUENCY_STATE_LABELS).join(' ').toLowerCase();

    expect(labels).not.toMatch(/default|delinquen|bad|deadbeat/);
  });
});

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

describe('assertDelinquencyInvariants', () => {
  const sound = deriveDelinquency({
    obligations: threeDays(),
    today: d('2026-11-03'),
    graceDays: 3,
    penaltyRateBps: 5_000,
  });

  it('accepts a sound position', () => {
    expect(() => assertDelinquencyInvariants(sound)).not.toThrow();
  });

  it('catches negative arrears', () => {
    expect(() =>
      assertDelinquencyInvariants({ ...sound, arrearsAmount: -1 as UgxAmount }),
    ).toThrow(/arrears are negative/);
  });

  it('catches current due that is not its parts', () => {
    expect(() =>
      assertDelinquencyInvariants({ ...sound, currentDue: toUgx(9_999) }),
    ).toThrow(/not arrears plus due today/);
  });

  it('catches more being due now than the loan owes', () => {
    expect(() =>
      assertDelinquencyInvariants({
        ...sound,
        arrearsAmount: toUgx(20_000),
        currentDue: toUgx(24_000),
      }),
    ).toThrow(/more is due now than the loan owes/);
  });

  it('catches a penalty split that does not reconcile', () => {
    expect(() =>
      assertDelinquencyInvariants({
        ...sound,
        penaltyAmount: toUgx(50_000),
        penaltyPaid: toUgx(10_000),
        penaltyRemaining: toUgx(10_000),
      }),
    ).toThrow(/penalty paid plus remaining/);
  });

  it('catches a total that is not the contract plus the penalty', () => {
    expect(() =>
      assertDelinquencyInvariants({ ...sound, totalOutstanding: toUgx(1) }),
    ).toThrow(/not contractual outstanding plus penalty remaining/);
  });

  it('catches a penalty that is recorded and eligible at once', () => {
    expect(() =>
      assertDelinquencyInvariants({
        ...sound,
        penaltyApplied: true,
        penaltyAmount: toUgx(6_000),
        penaltyRemaining: toUgx(6_000),
        totalOutstanding: toUgx(18_000),
        penaltyEligible: true,
      }),
    ).toThrow(/recorded and also reported as eligible/);
  });

  it('catches a projected charge with no eligibility', () => {
    expect(() =>
      assertDelinquencyInvariants({ ...sound, penaltyProjectedAmount: toUgx(6_000) }),
    ).toThrow(/projected without being eligible/);
  });

  it('catches days past due with nothing overdue', () => {
    expect(() =>
      assertDelinquencyInvariants({
        ...sound,
        oldestPastDueDate: null,
        arrearsAmount: toUgx(0),
        currentDue: toUgx(4_000),
        dueToday: toUgx(4_000),
        missedInstallmentCount: 0,
        daysPastDue: 3,
      }),
    ).toThrow(/days past due is set with no overdue collection/);
  });

  it('catches a missed count with nothing uncovered', () => {
    expect(() =>
      assertDelinquencyInvariants({
        ...sound,
        arrearsAmount: toUgx(0),
        currentDue: toUgx(4_000),
        dueToday: toUgx(4_000),
        oldestPastDueDate: null,
        daysPastDue: 0,
        missedInstallmentCount: 2,
      }),
    ).toThrow(/counted as missed with nothing uncovered/);
  });

  it('catches a cleared state that still owes money', () => {
    expect(() => assertDelinquencyInvariants({ ...sound, state: 'cleared' })).toThrow(
      /reads as settled while owing money/,
    );
  });

  it('catches grace before the final due date', () => {
    expect(() =>
      assertDelinquencyInvariants({
        ...sound,
        withinGracePeriod: true,
        pastFinalDueDate: false,
      }),
    ).toThrow(/inside its grace period before its final due date/);
  });
});
