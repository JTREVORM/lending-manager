/**
 * The repayment schedule engine.
 *
 * ## How expectations are derived in this file
 *
 * Every expected figure and every expected date is either **hard-coded** or
 * derived from the calendar by hand in a comment. Nothing is compared against
 * a second call to the engine, because an engine that agrees with itself proves
 * nothing: a sign error in the allocation would satisfy such a test perfectly.
 *
 * Where a count is asserted, the arithmetic that produces it is written out —
 * "10 Oct to 10 Nov is 31 days, so a daily cadence starting 11 Oct fits 30
 * collections before the 10 Nov boundary" — so a reader can check the claim
 * without running anything.
 *
 * The figures for the three confirmed loans were independently reproduced with
 * an exact-`Fraction` implementation sharing no code with this one before they
 * were written here.
 */

import { describe, expect, it } from 'vitest';

import {
  addBusinessDays,
  addBusinessMonths,
  daysInMonth,
  toBusinessDate,
  type BusinessDate,
} from '@/lib/domain/datetime';
import { calculateLoan } from '@/lib/domain/loan';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  assertScheduleInvariants,
  disbursementBusinessDate,
  generateRepaymentSchedule,
  INSTALLMENT_DATE_STATE_LABELS,
  INSTALLMENT_DATE_STATES,
  installmentDateState,
  MAX_SUPPORTED_INTERVAL_DAYS,
  periodWindow,
  SCHEDULE_FAILURE_CODES,
  ScheduleGenerationError,
  type SchedulePeriodInput,
} from '@/lib/domain/repayment-schedule';

const d = (value: string): BusinessDate => toBusinessDate(value);

/** A contractual month stated literally, so no engine supplies the figures. */
function period(
  periodNumber: number,
  principalPortion: number,
  interest: number,
): SchedulePeriodInput {
  return {
    periodNumber,
    principalPortion: toUgx(principalPortion),
    interest: toUgx(interest),
    totalObligation: toUgx(principalPortion + interest),
  };
}

/** The Phase 4 contract for a loan, used where the contract is not the subject. */
function contractFor(principal: number, termMonths: number, bps = 1500) {
  return calculateLoan({
    principal: toUgx(principal),
    monthlyInterestRateBps: bps,
    termMonths,
  }).periods;
}

/** Sum one numeric field across rows, so the reconciliation reads plainly. */
function sumBy<T, K extends keyof T>(rows: readonly T[], key: K): number {
  return rows.reduce((total, row) => total + Number(row[key]), 0);
}

// ---------------------------------------------------------------------------
// Calendar arithmetic — the foundation everything else stands on
// ---------------------------------------------------------------------------

describe('addBusinessMonths', () => {
  it('adds a plain month', () => {
    expect(addBusinessMonths(d('2026-10-10'), 1)).toBe('2026-11-10');
  });

  it('clamps 31 January to 28 February in a common year', () => {
    expect(addBusinessMonths(d('2027-01-31'), 1)).toBe('2027-02-28');
  });

  it('clamps 31 January to 29 February in a leap year', () => {
    expect(addBusinessMonths(d('2028-01-31'), 1)).toBe('2028-02-29');
  });

  it.each([
    // Each of the month-end dates the specification calls out.
    ['2027-01-28', 1, '2027-02-28'],
    ['2027-01-29', 1, '2027-02-28'],
    ['2027-01-30', 1, '2027-02-28'],
    ['2027-01-31', 1, '2027-02-28'],
    ['2028-01-28', 1, '2028-02-28'],
    ['2028-01-29', 1, '2028-02-29'],
    ['2028-01-30', 1, '2028-02-29'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-28'],
    ['2028-02-29', 1, '2028-03-29'],
    ['2026-04-30', 1, '2026-05-30'],
    ['2026-08-31', 1, '2026-09-30'],
    ['2026-08-31', 2, '2026-10-31'],
    ['2026-12-31', 1, '2027-01-31'],
    ['2026-11-30', 3, '2027-02-28'],
  ])('maps %s + %i month(s) to %s', (from, months, expected) => {
    expect(addBusinessMonths(d(from), months)).toBe(expected);
  });

  it('anchors on the original date rather than stepping month by month', () => {
    // The point of anchoring: February clamps to the 28th, and the 31st
    // returns in March. Stepping would give 28 March and never recover.
    expect(addBusinessMonths(d('2027-01-31'), 1)).toBe('2027-02-28');
    expect(addBusinessMonths(d('2027-01-31'), 2)).toBe('2027-03-31');
    expect(addBusinessMonths(d('2027-01-31'), 3)).toBe('2027-04-30');
    expect(addBusinessMonths(d('2027-01-31'), 4)).toBe('2027-05-31');
  });

  it('carries across a year boundary', () => {
    expect(addBusinessMonths(d('2026-11-15'), 3)).toBe('2027-02-15');
    expect(addBusinessMonths(d('2026-12-01'), 12)).toBe('2027-12-01');
  });

  it('subtracts with a negative offset', () => {
    expect(addBusinessMonths(d('2027-03-31'), -1)).toBe('2027-02-28');
    expect(addBusinessMonths(d('2027-01-15'), -1)).toBe('2026-12-15');
  });

  it('returns the same date for an offset of zero', () => {
    expect(addBusinessMonths(d('2027-01-31'), 0)).toBe('2027-01-31');
  });

  it('refuses a fractional offset', () => {
    expect(() => addBusinessMonths(d('2026-10-10'), 1.5)).toThrow(/whole number/i);
  });

  it('never rolls forward past the end of the target month', () => {
    // The clamp, asserted as a property across three years of month ends:
    // 31 January + 1 month must never be in March.
    for (let year = 2026; year <= 2032; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const last = daysInMonth(year, month);
        const from = d(
          `${String(year)}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
        );
        const next = addBusinessMonths(from, 1);
        const expectedMonth = month === 12 ? 1 : month + 1;

        expect(Number(next.slice(5, 7))).toBe(expectedMonth);
      }
    }
  });
});

describe('daysInMonth', () => {
  it.each([
    [2026, 2, 28],
    [2027, 2, 28],
    [2028, 2, 29], // leap
    [2000, 2, 29], // divisible by 400
    [1900, 2, 28], // divisible by 100 but not 400
    [2026, 1, 31],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('reports %i-%i as %i days', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });

  it('refuses a month outside 1..12', () => {
    expect(() => daysInMonth(2026, 0)).toThrow(/1-based month/);
    expect(() => daysInMonth(2026, 13)).toThrow(/1-based month/);
  });
});

// ---------------------------------------------------------------------------
// The confirmed loans, across every frequency
// ---------------------------------------------------------------------------

describe('the three confirmed loans', () => {
  const DISBURSED = d('2026-10-10');

  // Hard-coded from the approved Phase 4 contracts.
  const CONFIRMED = [
    {
      label: '100,000 over 1 month',
      periods: [period(1, 100_000, 15_000)],
      contractTotal: 115_000,
    },
    {
      label: '200,000 over 2 months',
      periods: [period(1, 100_000, 30_000), period(2, 100_000, 15_000)],
      contractTotal: 245_000,
    },
    {
      label: '600,000 over 3 months',
      periods: [
        period(1, 200_000, 90_000),
        period(2, 200_000, 60_000),
        period(3, 200_000, 30_000),
      ],
      contractTotal: 780_000,
    },
  ] as const;

  describe.each(CONFIRMED)('$label', ({ periods, contractTotal }) => {
    it.each([1, 2, 3])(
      'collects exactly the contractual total at an interval of %i day(s)',
      (intervalDays) => {
        const schedule = generateRepaymentSchedule({
          disbursementDate: DISBURSED,
          periods,
          intervalDays,
        });

        // The single most important assertion in Phase 5: whichever rhythm the
        // borrower collects on, the loan is worth the same.
        expect(schedule.totalScheduledAmount).toBe(contractTotal);
      },
    );

    it.each([1, 2, 3])(
      'reconciles every contractual month independently at an interval of %i day(s)',
      (intervalDays) => {
        const schedule = generateRepaymentSchedule({
          disbursementDate: DISBURSED,
          periods,
          intervalDays,
        });

        for (const contractual of periods) {
          const rows = schedule.installments.filter(
            (installment) => installment.loanPeriodNumber === contractual.periodNumber,
          );

          expect(sumBy(rows, 'scheduledPrincipal')).toBe(contractual.principalPortion);
          expect(sumBy(rows, 'scheduledInterest')).toBe(contractual.interest);
          expect(sumBy(rows, 'expectedAmount')).toBe(contractual.totalObligation);
        }
      },
    );
  });

  it('matches the hand-computed daily schedule for 200,000 over 2 months', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: DISBURSED,
      periods: [period(1, 100_000, 30_000), period(2, 100_000, 15_000)],
      intervalDays: 1,
    });

    // Month 1 window: 10 Oct inclusive to 10 Nov exclusive = 31 days, so a
    // daily cadence starting 11 Oct fits 30 collections (11 Oct .. 9 Nov).
    // Month 2 window: 10 Nov to 10 Dec = 30 days, cadence 10 Nov .. 9 Dec = 30.
    expect(schedule.installments).toHaveLength(60);
    expect(schedule.windows.map((window) => window.installmentCount)).toEqual([30, 30]);

    expect(schedule.firstDueDate).toBe('2026-10-11');
    expect(schedule.finalDueDate).toBe('2026-12-09');

    // Month 1: 130,000 over 30 collections. Principal 100,000 / 30 = 3,333
    // remainder 10, so the last ten collections carry 3,334. Interest
    // 30,000 / 30 = 1,000 exactly.
    const first = schedule.installments[0];
    expect(first?.scheduledPrincipal).toBe(3_333);
    expect(first?.scheduledInterest).toBe(1_000);
    expect(first?.expectedAmount).toBe(4_333);
    expect(first?.dueDate).toBe('2026-10-11');
    expect(first?.loanPeriodNumber).toBe(1);
    expect(first?.periodInstallmentNumber).toBe(1);

    // The twentieth collection of month 1 is still on the base portion:
    // 20 > 30 - 10 is false.
    expect(schedule.installments[19]?.scheduledPrincipal).toBe(3_333);
    // The twenty-first is the first to carry a remainder shilling.
    expect(schedule.installments[20]?.scheduledPrincipal).toBe(3_334);
    expect(schedule.installments[20]?.expectedAmount).toBe(4_334);

    // The last collection of month 1 is 9 November, the day before the
    // boundary.
    const lastOfMonthOne = schedule.installments[29];
    expect(lastOfMonthOne?.dueDate).toBe('2026-11-09');
    expect(lastOfMonthOne?.periodInstallmentNumber).toBe(30);
    expect(lastOfMonthOne?.scheduledPrincipal).toBe(3_334);

    // Month 2 opens on its own boundary date, 10 November: the window is
    // start-inclusive, so the boundary date belongs to the month that starts.
    const firstOfMonthTwo = schedule.installments[30];
    expect(firstOfMonthTwo?.dueDate).toBe('2026-11-10');
    expect(firstOfMonthTwo?.loanPeriodNumber).toBe(2);
    expect(firstOfMonthTwo?.periodInstallmentNumber).toBe(1);
    // 115,000 over 30: principal 3,333 r10, interest 15,000/30 = 500 exactly.
    expect(firstOfMonthTwo?.scheduledPrincipal).toBe(3_333);
    expect(firstOfMonthTwo?.scheduledInterest).toBe(500);
    expect(firstOfMonthTwo?.expectedAmount).toBe(3_833);

    // 30 × 3,333 + 10 = 100,000 in each month.
    expect(sumBy(schedule.installments, 'expectedAmount')).toBe(245_000);
  });

  it('gives the third month 31 collections for 600,000 daily, not 30', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: DISBURSED,
      periods: contractFor(600_000, 3),
      intervalDays: 1,
    });

    // 10 Oct–10 Nov = 31 days, 10 Nov–10 Dec = 30, 10 Dec–10 Jan = 31.
    // The cadence starts a day after disbursement, so the counts are
    // 30, 30, 31 — totalling 91, not the 90 that "daily = 30 a month" implies.
    expect(schedule.windows.map((window) => window.installmentCount)).toEqual([
      30, 30, 31,
    ]);
    expect(schedule.installments).toHaveLength(91);
    expect(schedule.totalScheduledAmount).toBe(780_000);
  });

  it('ends on a different day for each frequency, because the cadence does', () => {
    const periods = contractFor(600_000, 3);

    // 10 Oct 2026 to 10 Jan 2027 is 92 days. Daily fits 91 collections, so the
    // last is day 91 = 9 Jan. Every 2 days fits 45 (day 90 = 8 Jan) and every
    // 3 days fits 30 (day 90 = 8 Jan). The final date is therefore a property
    // of the cadence, not of the term — which is why Phase 7 must read it from
    // the schedule rather than approximate it.
    const finals = [1, 2, 3].map(
      (intervalDays) =>
        generateRepaymentSchedule({
          disbursementDate: DISBURSED,
          periods,
          intervalDays,
        }).finalDueDate,
    );

    expect(finals).toEqual(['2027-01-09', '2027-01-08', '2027-01-08']);
  });
});

// ---------------------------------------------------------------------------
// The first payment date
// ---------------------------------------------------------------------------

describe('the first collection date', () => {
  it.each([
    [1, '2026-10-11'],
    [2, '2026-10-12'],
    [3, '2026-10-13'],
  ])(
    'falls one interval of %i day(s) after disbursement, on %s',
    (intervalDays, expected) => {
      const schedule = generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(100_000, 1),
        intervalDays,
      });

      expect(schedule.firstDueDate).toBe(expected);
      expect(schedule.installments[0]?.dueDate).toBe(expected);
    },
  );

  it('is never the disbursement date itself', () => {
    for (const intervalDays of [1, 2, 3]) {
      const schedule = generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(100_000, 1),
        intervalDays,
      });

      expect(schedule.firstDueDate).not.toBe('2026-10-10');
      expect(schedule.firstDueDate > '2026-10-10').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Period boundaries
// ---------------------------------------------------------------------------

describe('period boundaries', () => {
  it('treats the boundary date as the start of the later month', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      periods: contractFor(200_000, 2),
      intervalDays: 1,
    });

    const onBoundary = schedule.installments.filter(
      (installment) => installment.dueDate === '2026-11-10',
    );

    // Exactly one installment, and it belongs to month 2. If the window were
    // inclusive at both ends there would be two collections on 10 November —
    // the duplicate the exclusive upper bound exists to prevent.
    expect(onBoundary).toHaveLength(1);
    expect(onBoundary[0]?.loanPeriodNumber).toBe(2);
  });

  it('never places a collection on or after the final contractual boundary', () => {
    for (const intervalDays of [1, 2, 3]) {
      const schedule = generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(600_000, 3),
        intervalDays,
      });

      // The contract ends at 10 January 2027, exclusive.
      expect(schedule.finalDueDate < '2027-01-10').toBe(true);
    }
  });

  it('reports each window with its boundaries', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2027-01-31'),
      periods: contractFor(600_000, 3),
      intervalDays: 1,
    });

    expect(
      schedule.windows.map((window) => [window.startDate, window.endDateExclusive]),
    ).toEqual([
      // Anchored, so the 31st returns in March.
      ['2027-01-31', '2027-02-28'],
      ['2027-02-28', '2027-03-31'],
      ['2027-03-31', '2027-04-30'],
    ]);
  });

  it('exposes a single window through periodWindow', () => {
    expect(periodWindow(d('2027-01-31'), 2)).toEqual({
      startDate: '2027-02-28',
      endDateExclusive: '2027-03-31',
    });
  });

  it('refuses a period number below one', () => {
    expect(() => periodWindow(d('2026-10-10'), 0)).toThrow(ScheduleGenerationError);
  });

  it('leaves adjacent windows touching with no gap and no overlap', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-12-31'),
      periods: contractFor(600_000, 3),
      intervalDays: 1,
    });

    for (let index = 1; index < schedule.windows.length; index += 1) {
      expect(schedule.windows[index]?.startDate).toBe(
        schedule.windows[index - 1]?.endDateExclusive,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Month-end and leap-year disbursements
// ---------------------------------------------------------------------------

describe('month-end and leap-year disbursements', () => {
  // Every date the specification calls out, at every frequency, over one, two
  // and three months. Each must reconcile exactly and give every contractual
  // month at least one collection.
  const DATES = [
    '2027-01-28',
    '2027-01-29',
    '2027-01-30',
    '2027-01-31',
    '2027-02-28',
    '2028-01-29',
    '2028-01-30',
    '2028-01-31',
    '2028-02-28',
    '2028-02-29',
    '2026-04-30',
    '2026-08-31',
    '2026-12-31',
  ] as const;

  it.each(DATES)('handles a disbursement on %s at every frequency', (disbursed) => {
    for (const termMonths of [1, 2, 3]) {
      const periods = contractFor(600_000, termMonths);
      const contractTotal = sumBy(periods, 'totalObligation');

      for (const intervalDays of [1, 2, 3]) {
        const schedule = generateRepaymentSchedule({
          disbursementDate: d(disbursed),
          periods,
          intervalDays,
        });

        expect(schedule.totalScheduledAmount).toBe(contractTotal);
        expect(schedule.installments.length).toBeGreaterThan(0);

        // Not one contractual month left without a collection.
        for (const window of schedule.windows) {
          expect(window.installmentCount).toBeGreaterThan(0);
        }

        // Dates strictly increasing, which also rules out duplicates.
        for (let index = 1; index < schedule.installments.length; index += 1) {
          const previous = schedule.installments[index - 1]?.dueDate ?? '';
          const current = schedule.installments[index]?.dueDate ?? '';
          expect(current > previous).toBe(true);
        }
      }
    }
  });

  it('gives a 28-day February month fewer daily collections than a 31-day January', () => {
    const periods = contractFor(600_000, 2);

    // Disbursed 31 January 2027: month 1 is 31 Jan–28 Feb = 28 days, so a
    // daily cadence (1 Feb .. 27 Feb) fits 27. Month 2 is 28 Feb–31 Mar = 31
    // days, cadence 28 Feb .. 30 Mar = 31.
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2027-01-31'),
      periods,
      intervalDays: 1,
    });

    expect(schedule.windows.map((window) => window.installmentCount)).toEqual([27, 31]);
    expect(schedule.installments).toHaveLength(58);
  });

  it('uses 29 February when the leap day exists', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2028-01-31'),
      periods: contractFor(600_000, 1),
      intervalDays: 1,
    });

    // 31 Jan 2028 + 1 month clamps to 29 Feb 2028, so the window is 29 days
    // and the cadence 1 Feb .. 28 Feb is 28 collections. One more than the
    // common-year case above, which is the leap day doing its work.
    expect(schedule.windows[0]?.endDateExclusive).toBe('2028-02-29');
    expect(schedule.installments).toHaveLength(28);
    expect(schedule.finalDueDate).toBe('2028-02-28');
  });

  it('spans the leap day when disbursed in February of a leap year', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2028-02-28'),
      periods: contractFor(300_000, 1),
      intervalDays: 1,
    });

    // 28 Feb to 28 Mar 2028 = 29 days, because 2028 has a 29 February.
    expect(schedule.installments).toHaveLength(28);
    expect(
      schedule.installments.some((installment) => installment.dueDate === '2028-02-29'),
    ).toBe(true);
  });

  it('produces a shorter window when the month-end clamp shortens it', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-08-31'),
      periods: contractFor(400_000, 2),
      intervalDays: 1,
    });

    // Month 1: 31 Aug inclusive to 30 Sep exclusive — the clamp, because
    // September has no 31st. That is 30 days, and a daily cadence starting
    // 1 Sep fits 29 collections (1 Sep .. 29 Sep); 30 Sep is the boundary and
    // belongs to month 2.
    //
    // Month 2: 30 Sep to 31 Oct = 31 days, so 30 Sep .. 30 Oct = 31
    // collections. The clamp cost month 1 a collection and month 2 kept its
    // full length — which is exactly why a fixed installment count per month
    // would be wrong.
    expect(schedule.windows.map((window) => window.installmentCount)).toEqual([29, 31]);
    expect(schedule.installments).toHaveLength(60);
    expect(schedule.windows[0]?.endDateExclusive).toBe('2026-09-30');
    expect(schedule.installments[28]?.dueDate).toBe('2026-09-29');
    expect(schedule.installments[29]?.dueDate).toBe('2026-09-30');
    expect(schedule.installments[29]?.loanPeriodNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Remainder handling
// ---------------------------------------------------------------------------

describe('remainder handling', () => {
  it('places a principal remainder on the final collections of its own month', () => {
    // 100,001 over 3 collections: base 33,333, remainder 2, so the last two
    // carry one extra shilling each. 33,333 + 33,334 + 33,334 = 100,001.
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      // An interval of 10 days over a 31-day window gives exactly three
      // collections: 20 Oct, 30 Oct, 9 Nov.
      periods: [period(1, 100_001, 0)],
      intervalDays: 10,
    });

    expect(schedule.installments).toHaveLength(3);
    expect(schedule.installments.map((row) => row.scheduledPrincipal)).toEqual([
      33_333, 33_334, 33_334,
    ]);
    expect(sumBy(schedule.installments, 'scheduledPrincipal')).toBe(100_001);
  });

  it('places an interest remainder the same way', () => {
    // 1,000 over 3: base 333, remainder 1, so only the last carries 334.
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      periods: [period(1, 0, 1_000)],
      intervalDays: 10,
    });

    expect(schedule.installments.map((row) => row.scheduledInterest)).toEqual([
      333, 333, 334,
    ]);
  });

  it('never carries a remainder from one contractual month into the next', () => {
    // Both months end in a remainder. If month 1's remainder leaked forward,
    // month 1 would collect 99,999 and month 2 would collect 100,003 — each
    // month would stop matching its own contractual obligation even though the
    // loan total still balanced, which is the subtle failure this rules out.
    const periods = [period(1, 100_001, 7), period(2, 100_001, 7)];

    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      periods,
      intervalDays: 10,
    });

    for (const contractual of periods) {
      const rows = schedule.installments.filter(
        (row) => row.loanPeriodNumber === contractual.periodNumber,
      );
      expect(sumBy(rows, 'scheduledPrincipal')).toBe(100_001);
      expect(sumBy(rows, 'scheduledInterest')).toBe(7);
    }
  });

  it('loses nothing on an uneven contract', () => {
    // 200,001 over 2 months at 15%: portions 100,000 and 100,001; interest
    // 30,000 (on 200,001 → 30,000.15 → 30,000) and 15,000 (on 100,001 →
    // 15,000.15 → 15,000). Contract total 245,001.
    const periods = contractFor(200_001, 2);

    expect(periods.map((p) => [p.principalPortion, p.interest])).toEqual([
      [100_000, 30_000],
      [100_001, 15_000],
    ]);

    for (const intervalDays of [1, 2, 3]) {
      const schedule = generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods,
        intervalDays,
      });

      expect(schedule.totalScheduledAmount).toBe(245_001);
    }
  });

  it('allocates an amount smaller than the collection count', () => {
    // 7 shillings of interest over 30 collections: 23 collections get nothing
    // and the last 7 get one shilling each. Nothing is lost and nothing is
    // invented.
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      periods: [period(1, 30_000, 7)],
      intervalDays: 1,
    });

    expect(schedule.installments).toHaveLength(30);
    expect(sumBy(schedule.installments, 'scheduledInterest')).toBe(7);
    expect(schedule.installments[0]?.scheduledInterest).toBe(0);
    expect(schedule.installments[29]?.scheduledInterest).toBe(1);
    expect(
      schedule.installments.filter((row) => row.scheduledInterest === 1),
    ).toHaveLength(7);
  });

  it('keeps expected equal to principal plus interest on every row', () => {
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      periods: contractFor(777_777, 3),
      intervalDays: 2,
    });

    for (const installment of schedule.installments) {
      expect(installment.expectedAmount).toBe(
        installment.scheduledPrincipal + installment.scheduledInterest,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Generated combinations — the exact-sum property
// ---------------------------------------------------------------------------

describe('exact-sum property across generated loans', () => {
  /** Deterministic generator, so a failure is reproducible. */
  function makeRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  it('reconciles 400 generated loan and frequency combinations', () => {
    const random = makeRandom(20_261_005);
    let checked = 0;

    for (let iteration = 0; iteration < 400; iteration += 1) {
      // Awkward principals on purpose: prime-ish amounts that do not divide
      // cleanly by any plausible collection count.
      const principal = toUgx(50_001 + Math.floor(random() * 4_949_999));
      const termMonths = 1 + Math.floor(random() * 3);
      const bps = Math.floor(random() * 3_001); // 0% to 30%
      const intervalDays = 1 + Math.floor(random() * 3);

      // A disbursement date anywhere across four years, so month lengths,
      // month-end clamps and two leap years are all swept.
      const dayOffset = Math.floor(random() * 1_461);
      const disbursementDate = addBusinessDays(d('2026-01-01'), dayOffset);

      const contract = calculateLoan({
        principal,
        monthlyInterestRateBps: bps,
        termMonths,
      });

      const schedule = generateRepaymentSchedule({
        disbursementDate,
        periods: contract.periods,
        intervalDays,
      });

      const context = `principal ${String(principal)}, term ${String(termMonths)}, bps ${String(bps)}, interval ${String(intervalDays)}, disbursed ${disbursementDate}`;

      // The loan total.
      expect(schedule.totalScheduledAmount, context).toBe(
        contract.totalExpectedRepayment,
      );
      expect(schedule.totalScheduledPrincipal, context).toBe(contract.principal);
      expect(schedule.totalScheduledInterest, context).toBe(contract.totalInterest);

      // And every contractual month, independently.
      for (const contractual of contract.periods) {
        const rows = schedule.installments.filter(
          (row) => row.loanPeriodNumber === contractual.periodNumber,
        );

        expect(rows.length, context).toBeGreaterThan(0);
        expect(sumBy(rows, 'scheduledPrincipal'), context).toBe(
          contractual.principalPortion,
        );
        expect(sumBy(rows, 'scheduledInterest'), context).toBe(contractual.interest);
        expect(sumBy(rows, 'expectedAmount'), context).toBe(contractual.totalObligation);
      }

      checked += 1;
    }

    expect(checked).toBe(400);
  });

  it('produces strictly ordered, unique, post-disbursement dates throughout', () => {
    const random = makeRandom(555_333);

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const termMonths = 1 + Math.floor(random() * 3);
      const intervalDays = 1 + Math.floor(random() * 3);
      const disbursementDate = addBusinessDays(
        d('2026-01-01'),
        Math.floor(random() * 1_461),
      );

      const schedule = generateRepaymentSchedule({
        disbursementDate,
        periods: contractFor(900_000, termMonths),
        intervalDays,
      });

      const dates = schedule.installments.map((row) => row.dueDate);

      expect(new Set(dates).size).toBe(dates.length);
      expect([...dates].sort()).toEqual(dates);
      expect(dates.every((date) => date > disbursementDate)).toBe(true);

      // Sequential numbering, loan-wide and within each month.
      expect(schedule.installments.map((row) => row.installmentNumber)).toEqual(
        schedule.installments.map((_, index) => index + 1),
      );
    }
  });

  it('is deterministic — the same inputs give the same schedule', () => {
    const inputs = {
      disbursementDate: d('2027-01-31'),
      periods: contractFor(1_234_567, 3),
      intervalDays: 2,
    } as const;

    const first = generateRepaymentSchedule(inputs);
    const second = generateRepaymentSchedule(inputs);

    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// The zero-installment guard and other refusals
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('fails rather than leaving a contractual month uncollected', () => {
    // A 40-day cadence cannot fit inside a calendar month. Generating anyway
    // would create an active loan with a month of obligation that nothing ever
    // collects; dividing by the count would be a division by zero.
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(600_000, 2),
        intervalDays: 40,
      }),
    ).toThrow(ScheduleGenerationError);

    try {
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(600_000, 2),
        intervalDays: 40,
      });
      expect.unreachable('generation should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduleGenerationError);
      expect((error as ScheduleGenerationError).code).toBe('period_has_no_installments');
      // The message names the month and the interval, so the administrator can
      // see what to change.
      expect((error as ScheduleGenerationError).message).toMatch(/40 days/);
      expect((error as ScheduleGenerationError).message).toMatch(/frequency/i);
    }
  });

  it('fails when a later month would be uncollected even though the first is not', () => {
    // 29 days fits inside a 31-day window but not inside a 28-day February.
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2027-01-31'),
        periods: contractFor(600_000, 2),
        intervalDays: 29,
      }),
    ).toThrow(/no\s+collection/i);
  });

  it('accepts an interval that exactly fits the shortest window', () => {
    // 10 Oct to 10 Nov is 31 days, so a 30-day cadence fits exactly one
    // collection on 9 November — the boundary case on the permitted side.
    const schedule = generateRepaymentSchedule({
      disbursementDate: d('2026-10-10'),
      periods: contractFor(100_000, 1),
      intervalDays: 30,
    });

    expect(schedule.installments).toHaveLength(1);
    expect(schedule.installments[0]?.dueDate).toBe('2026-11-09');
    expect(schedule.installments[0]?.expectedAmount).toBe(115_000);
  });

  it('refuses an interval of 31 days against a 31-day window', () => {
    // Day 31 is exactly the boundary, which belongs to the next month — and
    // there is no next month. So the window gets nothing and generation fails
    // rather than quietly producing an empty schedule.
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(100_000, 1),
        intervalDays: 31,
      }),
    ).toThrow(/no\s+collection/i);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses an interval of %s', (intervalDays) => {
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(100_000, 1),
        intervalDays,
      }),
    ).toThrow(/collection interval/i);
  });

  it('refuses an interval beyond the supported maximum', () => {
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: contractFor(100_000, 1),
        intervalDays: MAX_SUPPORTED_INTERVAL_DAYS + 1,
      }),
    ).toThrow(/supported range/);
  });

  it('refuses an empty contract', () => {
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: [],
        intervalDays: 1,
      }),
    ).toThrow(/contractual monthly breakdown/);
  });

  it('refuses contractual months out of order', () => {
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: [period(2, 100_000, 15_000), period(1, 100_000, 30_000)],
        intervalDays: 1,
      }),
    ).toThrow(/in order starting at 1/);
  });

  it('refuses a contractual month whose obligation does not add up', () => {
    // A corrupted stored row: 100,000 + 15,000 is not 200,000. Checked rather
    // than trusted, because these rows may have come from the database.
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: [
          {
            periodNumber: 1,
            principalPortion: toUgx(100_000),
            interest: toUgx(15_000),
            totalObligation: toUgx(200_000),
          },
        ],
        intervalDays: 1,
      }),
    ).toThrow(/not its principal plus its interest/);
  });

  it('refuses a negative contractual amount', () => {
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: d('2026-10-10'),
        periods: [
          {
            periodNumber: 1,
            principalPortion: -1 as UgxAmount,
            interest: toUgx(0),
            totalObligation: -1 as UgxAmount,
          },
        ],
        intervalDays: 1,
      }),
    ).toThrow(/negative amount/);
  });

  it('refuses a malformed disbursement date that evaded the brand', () => {
    expect(() =>
      generateRepaymentSchedule({
        disbursementDate: '10/10/2026' as BusinessDate,
        periods: contractFor(100_000, 1),
        intervalDays: 1,
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('names every failure code it can raise', () => {
    expect([...SCHEDULE_FAILURE_CODES]).toEqual([
      'no_periods',
      'invalid_interval',
      'invalid_disbursement_date',
      'period_has_no_installments',
      'too_many_installments',
      'period_inconsistent',
      'reconciliation_failed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The invariant checker, applied to figures the engine did not produce
// ---------------------------------------------------------------------------

describe('assertScheduleInvariants', () => {
  const periods = [period(1, 100_000, 30_000), period(2, 100_000, 15_000)];

  const sound = generateRepaymentSchedule({
    disbursementDate: d('2026-10-10'),
    periods,
    intervalDays: 1,
  });

  it('accepts a sound schedule', () => {
    expect(() => assertScheduleInvariants(sound, periods)).not.toThrow();
  });

  it('catches a lost shilling', () => {
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 0
          ? {
              ...row,
              scheduledPrincipal: toUgx(row.scheduledPrincipal - 1),
              expectedAmount: toUgx(row.expectedAmount - 1),
            }
          : row,
      ),
      totalScheduledPrincipal: toUgx(sound.totalScheduledPrincipal - 1),
      totalScheduledAmount: toUgx(sound.totalScheduledAmount - 1),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /allocates principal of 99999, not 100000/,
    );
  });

  it('catches an invented shilling', () => {
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 0
          ? {
              ...row,
              scheduledInterest: toUgx(row.scheduledInterest + 1),
              expectedAmount: toUgx(row.expectedAmount + 1),
            }
          : row,
      ),
      totalScheduledInterest: toUgx(sound.totalScheduledInterest + 1),
      totalScheduledAmount: toUgx(sound.totalScheduledAmount + 1),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /allocates interest of 30001, not 30000/,
    );
  });

  it('catches a duplicate due date', () => {
    const second = sound.installments[1];
    const first = sound.installments[0];
    if (second === undefined || first === undefined) throw new Error('fixture');

    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 1 ? { ...row, dueDate: first.dueDate } : row,
      ),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(/does not follow/);
  });

  it('catches a collection dated before disbursement', () => {
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 0 ? { ...row, dueDate: d('2026-10-01') } : row,
      ),
      firstDueDate: d('2026-10-01'),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /not after disbursement/,
    );
  });

  it('catches a collection that escaped its contractual month', () => {
    // Moved from month 1 to a date inside month 2's window while keeping its
    // month-1 label. Ordering and totals still hold; only the window check
    // catches it.
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 29 ? { ...row, dueDate: d('2026-11-20') } : row,
      ),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /on or after its contractual month closes/,
    );
  });

  it('catches a row whose expected amount is not its two components', () => {
    // Two rows moved in opposite directions, so every total still
    // reconciles — the lie is confined to the individual rows. Only the
    // per-installment identity check can see it, which is the point of
    // checking it at all rather than relying on the sums.
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) => {
        if (index === 0)
          return { ...row, expectedAmount: toUgx(row.expectedAmount + 1_000) };
        if (index === 1)
          return { ...row, expectedAmount: toUgx(row.expectedAmount - 1_000) };
        return row;
      }),
    };

    // The totals genuinely still agree, so this is not caught by conservation.
    expect(
      tampered.installments.reduce((total, row) => total + row.expectedAmount, 0),
    ).toBe(sound.totalScheduledAmount);

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /not its principal plus its interest/,
    );
  });

  it('catches an out-of-sequence installment number', () => {
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 5 ? { ...row, installmentNumber: 99 } : row,
      ),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(/out of sequence/);
  });

  it('catches an out-of-sequence position within a contractual month', () => {
    const tampered = {
      ...sound,
      installments: sound.installments.map((row, index) =>
        index === 5 ? { ...row, periodInstallmentNumber: 99 } : row,
      ),
    };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /within its contractual month/,
    );
  });

  it('catches a reported first collection date that disagrees with the rule', () => {
    // The rows are untouched and reconcile perfectly; only the summary field
    // the interface displays is wrong. Worth catching on its own, because a
    // borrower is told this date.
    const tampered = { ...sound, firstDueDate: d('2026-10-20') };

    expect(() => assertScheduleInvariants(tampered, periods)).toThrow(
      /one interval after disbursement/,
    );
  });

  it('catches a cadence that starts later than one interval after disbursement', () => {
    // Every date pushed forward a day, keeping the money and the ordering
    // intact. The last collection of month 1 lands on month 2's boundary, so
    // the window check catches it — a late cadence cannot pass unnoticed even
    // when nothing about the amounts is wrong.
    const shifted = {
      ...sound,
      installments: sound.installments.map((row) => ({
        ...row,
        dueDate: addBusinessDays(row.dueDate, 1),
      })),
      firstDueDate: addBusinessDays(sound.firstDueDate, 1),
      finalDueDate: addBusinessDays(sound.finalDueDate, 1),
    };

    expect(() => assertScheduleInvariants(shifted, periods)).toThrow(
      ScheduleGenerationError,
    );
  });

  it('catches an empty schedule', () => {
    expect(() =>
      assertScheduleInvariants({ ...sound, installments: [] }, periods),
    ).toThrow(/no collections/);
  });

  it('catches a reported total that disagrees with the rows', () => {
    expect(() =>
      assertScheduleInvariants({ ...sound, totalScheduledPrincipal: toUgx(1) }, periods),
    ).toThrow(/not the sum of parts/);
  });
});

// ---------------------------------------------------------------------------
// What can honestly be said before payments exist
// ---------------------------------------------------------------------------

describe('date-derived installment state', () => {
  const today = d('2026-10-15');

  it.each([
    ['2026-10-16', 'upcoming'],
    ['2026-11-01', 'upcoming'],
    ['2026-10-15', 'due_today'],
    ['2026-10-14', 'elapsed'],
    ['2026-01-01', 'elapsed'],
  ])('reads %s as %s', (dueDate, expected) => {
    expect(installmentDateState(d(dueDate), today)).toBe(expected);
  });

  it('declares only states the calendar can support', () => {
    expect([...INSTALLMENT_DATE_STATES]).toEqual(['upcoming', 'due_today', 'elapsed']);
  });

  it('never claims an installment was paid, missed or in arrears', () => {
    // The whole point of the derived-state decision: Phase 5 has no payment
    // data, so no label may imply any. A label saying "Missed" here would be a
    // claim about a borrower that the system cannot support.
    const forbidden = /paid|missed|overdue|arrears|partial|default/i;

    for (const state of INSTALLMENT_DATE_STATES) {
      expect(state).not.toMatch(forbidden);
      expect(INSTALLMENT_DATE_STATE_LABELS[state]).not.toMatch(forbidden);
    }
  });

  it('labels an elapsed date as a calendar fact, not a judgement', () => {
    expect(INSTALLMENT_DATE_STATE_LABELS.elapsed).toBe('Date passed');
  });
});

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

describe('disbursementBusinessDate', () => {
  it('uses the Kampala calendar date, not the UTC one', () => {
    // 22:30 UTC is 01:30 the next morning in Kampala. Anchoring the schedule
    // on the UTC date would put every collection a day early.
    expect(disbursementBusinessDate('2026-10-10T22:30:00Z')).toBe('2026-10-11');
  });

  it('handles the specification"s 23:59 UTC case', () => {
    expect(disbursementBusinessDate('2026-10-10T23:59:00Z')).toBe('2026-10-11');
  });

  it('keeps an early-morning UTC instant on the same Kampala day', () => {
    // 02:00 UTC is 05:00 Kampala — the same calendar day, because Kampala is
    // ahead of UTC rather than behind it.
    expect(disbursementBusinessDate('2026-10-10T02:00:00Z')).toBe('2026-10-10');
  });

  it('rolls over at exactly 21:00 UTC', () => {
    expect(disbursementBusinessDate('2026-10-10T20:59:59Z')).toBe('2026-10-10');
    expect(disbursementBusinessDate('2026-10-10T21:00:00Z')).toBe('2026-10-11');
  });

  it('accepts a Date as readily as a string', () => {
    expect(disbursementBusinessDate(new Date('2026-10-10T22:30:00Z'))).toBe('2026-10-11');
  });

  it('shifts the whole schedule by a day when the instant rolls over', () => {
    const before = generateRepaymentSchedule({
      disbursementDate: disbursementBusinessDate('2026-10-10T20:00:00Z'),
      periods: contractFor(100_000, 1),
      intervalDays: 1,
    });

    const after = generateRepaymentSchedule({
      disbursementDate: disbursementBusinessDate('2026-10-10T21:00:00Z'),
      periods: contractFor(100_000, 1),
      intervalDays: 1,
    });

    expect(before.firstDueDate).toBe('2026-10-11');
    expect(after.firstDueDate).toBe('2026-10-12');
  });

  it('honours an explicit timezone', () => {
    // Pacific/Kiritimati is UTC+14, so the same instant is already the 11th.
    expect(disbursementBusinessDate('2026-10-10T12:00:00Z', 'Pacific/Kiritimati')).toBe(
      '2026-10-11',
    );
  });
});
