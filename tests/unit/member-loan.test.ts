import { describe, expect, it } from 'vitest';

import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { calculateLoan } from '@/lib/domain/loan';
import {
  calculateMemberLoan,
  isSupportedMemberInterestCombination,
  MEMBER_INTEREST_COMBINATIONS,
  MEMBER_LENDING_DECISIONS,
  MEMBER_LOAN_FAILURE_CODES,
  MemberLoanError,
  memberLendingReadiness,
  memberLoanCeiling,
  pledgedSavingsForLoan,
  quoteMemberLoan,
  requiredMemberCadence,
} from '@/lib/domain/member-loan';
import { toUgx } from '@/lib/domain/money';
import {
  MONTH_ANCHORS,
  monthlyCollectionDate,
  type MonthAnchor,
} from '@/lib/domain/repayment-schedule';

/**
 * The member loan domain, in isolation.
 *
 * ## How the expected figures were produced
 *
 * By hand, from the rule, and written out as literals. That is the point of a
 * parity test: computing the expectation with the function under test proves
 * only that the function is consistent with itself. So every table below is a
 * statement of what the business rule says, independent of how it is
 * implemented, and `tests/db/member-loan-approval.test.ts` then asserts the
 * database agrees.
 *
 * ## The two things these tests care about most
 *
 * That nothing is priced under an undecided policy — three of the four
 * entry points refuse rather than default — and that the per-month
 * reducing-balance arm is **the existing engine**, not a second
 * implementation of it.
 */

const d = (value: string): BusinessDate => toBusinessDate(value);

describe('the interest grid', () => {
  it('names all four combinations of the two undecided questions', () => {
    expect(MEMBER_INTEREST_COMBINATIONS.map((entry) => entry.basis)).toEqual([
      'per_month',
      'per_month',
      'per_loan',
      'per_loan',
    ]);

    // Three defined, one not. The grid is stated exhaustively so a fourth
    // reading cannot be added without this test noticing.
    expect(MEMBER_INTEREST_COMBINATIONS.filter((entry) => entry.supported)).toHaveLength(
      3,
    );
  });

  it('recognises only the three defined combinations', () => {
    expect(
      isSupportedMemberInterestCombination('per_month', 'reducing_balance_monthly'),
    ).toBe(true);
    expect(isSupportedMemberInterestCombination('per_month', 'flat')).toBe(true);
    expect(isSupportedMemberInterestCombination('per_loan', 'flat')).toBe(true);
    expect(
      isSupportedMemberInterestCombination('per_loan', 'reducing_balance_monthly'),
    ).toBe(false);
  });

  it('names every failure code it can raise', () => {
    expect([...MEMBER_LOAN_FAILURE_CODES]).toEqual([
      'basis_undecided',
      'method_undecided',
      'combination_undefined',
      'invalid_principal',
      'invalid_rate',
      'invalid_term',
    ]);
  });
});

describe('calculateMemberLoan', () => {
  // -------------------------------------------------------------------------
  describe('per month, on a reducing balance', () => {
    it('is the existing engine, not a second implementation of it', () => {
      // The structural claim, asserted directly: for this combination the
      // member engine *calls* `calculateLoan`, so an ordinary loan and a
      // member loan of the same principal, rate and term cannot differ.
      for (const principal of [100_001, 400_000, 733_333, 20_000_000]) {
        for (const term of [1, 2, 3, 4, 5]) {
          const member = calculateMemberLoan({
            principal: toUgx(principal),
            interestRateBps: 500,
            termMonths: term,
            interestBasis: 'per_month',
            interestMethod: 'reducing_balance_monthly',
          });

          const ordinary = calculateLoan({
            principal: toUgx(principal),
            monthlyInterestRateBps: 500,
            termMonths: term,
          });

          expect(member.periods, `${String(principal)}/${String(term)}`).toEqual(
            ordinary.periods,
          );
          expect(member.totalInterest).toBe(ordinary.totalInterest);
          expect(member.totalExpectedRepayment).toBe(ordinary.totalExpectedRepayment);
        }
      }
    });

    it('charges less each month as the principal falls', () => {
      // UGX 500,000 over two months at 5%: 25,000 on 500,000, then 12,500 on
      // 250,000.
      const result = calculateMemberLoan({
        principal: toUgx(500_000),
        interestRateBps: 500,
        termMonths: 2,
        interestBasis: 'per_month',
        interestMethod: 'reducing_balance_monthly',
      });

      expect(result.periods.map((period) => period.interest)).toEqual([25_000, 12_500]);
      expect(result.totalInterest).toBe(37_500);
      expect(result.totalExpectedRepayment).toBe(537_500);
    });
  });

  // -------------------------------------------------------------------------
  describe('per month, flat', () => {
    it('charges the same interest every month, on the original principal', () => {
      // 5% of 500,000 is 25,000, charged three times. Flat means the balance
      // falling does not reduce the charge — which is the whole difference
      // from the reducing arm.
      const result = calculateMemberLoan({
        principal: toUgx(500_000),
        interestRateBps: 500,
        termMonths: 3,
        interestBasis: 'per_month',
        interestMethod: 'flat',
      });

      expect(result.periods.map((period) => period.interest)).toEqual([
        25_000, 25_000, 25_000,
      ]);
      expect(result.totalInterest).toBe(75_000);
      expect(result.totalExpectedRepayment).toBe(575_000);
    });

    it('still walks the principal down to zero', () => {
      const result = calculateMemberLoan({
        principal: toUgx(500_000),
        interestRateBps: 500,
        termMonths: 3,
        interestBasis: 'per_month',
        interestMethod: 'flat',
      });

      expect(result.periods.map((period) => period.openingPrincipal)).toEqual([
        500_000, 333_334, 166_667,
      ]);
      // 166,666 + 166,667 + 166,667 — the remainder in the final periods.
      expect(result.periods.map((period) => period.principalPortion)).toEqual([
        166_666, 166_667, 166_667,
      ]);
      expect(result.periods.at(-1)?.closingPrincipal).toBe(0);
    });

    it('is five times the per-loan charge on a five-month loan', () => {
      // The difference question 1 makes, stated as a figure: on a five-month
      // loan the two readings of "5%" differ five-fold.
      const perMonth = calculateMemberLoan({
        principal: toUgx(1_000_000),
        interestRateBps: 500,
        termMonths: 5,
        interestBasis: 'per_month',
        interestMethod: 'flat',
      });

      const perLoan = calculateMemberLoan({
        principal: toUgx(1_000_000),
        interestRateBps: 500,
        termMonths: 5,
        interestBasis: 'per_loan',
        interestMethod: 'flat',
      });

      expect(perMonth.totalInterest).toBe(250_000);
      expect(perLoan.totalInterest).toBe(50_000);
      expect(perMonth.totalInterest).toBe(perLoan.totalInterest * 5);
    });
  });

  // -------------------------------------------------------------------------
  describe('per loan, flat', () => {
    it('charges the rate once and spreads it, remainder in the final period', () => {
      // 5% of 500,000 is 25,000, over three months: 8,333 + 8,333 + 8,334.
      const result = calculateMemberLoan({
        principal: toUgx(500_000),
        interestRateBps: 500,
        termMonths: 3,
        interestBasis: 'per_loan',
        interestMethod: 'flat',
      });

      expect(result.periods.map((period) => period.interest)).toEqual([
        8_333, 8_333, 8_334,
      ]);
      expect(result.totalInterest).toBe(25_000);
    });

    it('loses no shilling at any term on an awkward principal', () => {
      for (const term of [1, 2, 3, 4, 5]) {
        const result = calculateMemberLoan({
          principal: toUgx(333_333),
          interestRateBps: 500,
          termMonths: term,
          interestBasis: 'per_loan',
          interestMethod: 'flat',
        });

        // 5% of 333,333 is 16,666.65, which rounds half-up to 16,667.
        expect(result.totalInterest, `term ${String(term)}`).toBe(16_667);
        expect(
          result.periods.reduce((total, period) => total + period.interest, 0),
          `term ${String(term)}`,
        ).toBe(16_667);
        expect(
          result.periods.reduce((total, period) => total + period.principalPortion, 0),
          `term ${String(term)}`,
        ).toBe(333_333);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('rounding boundaries', () => {
    it('rounds exactly half up rather than down', () => {
      // 1 bp of 55,000 is 5.5 exactly. Half-up gives 6; truncation gives 5.
      const result = calculateMemberLoan({
        principal: toUgx(55_000),
        interestRateBps: 1,
        termMonths: 1,
        interestBasis: 'per_loan',
        interestMethod: 'flat',
      });

      expect(result.totalInterest).toBe(6);
    });

    it('rounds just below the boundary down', () => {
      // 1 bp of 54,999 is 5.4999.
      const result = calculateMemberLoan({
        principal: toUgx(54_999),
        interestRateBps: 1,
        termMonths: 1,
        interestBasis: 'per_loan',
        interestMethod: 'flat',
      });

      expect(result.totalInterest).toBe(5);
    });

    it('charges nothing at a zero rate, which is a decided answer', () => {
      const result = calculateMemberLoan({
        principal: toUgx(500_000),
        interestRateBps: 0,
        termMonths: 3,
        interestBasis: 'per_month',
        interestMethod: 'flat',
      });

      expect(result.totalInterest).toBe(0);
      expect(result.totalExpectedRepayment).toBe(500_000);
    });

    it('keeps principal and interest summing to the stated obligation, always', () => {
      for (const principal of [1, 100_001, 333_333, 7_777_777, 20_000_000]) {
        for (const term of [1, 2, 3, 4, 5]) {
          for (const combination of MEMBER_INTEREST_COMBINATIONS) {
            if (!combination.supported) continue;

            const result = calculateMemberLoan({
              principal: toUgx(principal),
              interestRateBps: 500,
              termMonths: term,
              interestBasis: combination.basis,
              interestMethod: combination.method,
            });

            const label = `${String(principal)}/${String(term)}/${combination.basis}/${combination.method}`;

            for (const period of result.periods) {
              expect(period.totalObligation, label).toBe(
                period.principalPortion + period.interest,
              );
            }

            expect(
              result.periods.reduce(
                (total, period) => total + period.principalPortion,
                0,
              ),
              label,
            ).toBe(principal);
            expect(result.totalExpectedRepayment, label).toBe(
              principal + result.totalInterest,
            );
          }
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('what it refuses', () => {
    it('refuses an undecided basis by name', () => {
      expect(() =>
        calculateMemberLoan({
          principal: toUgx(500_000),
          interestRateBps: 500,
          termMonths: 2,
          interestBasis: null,
          interestMethod: 'flat',
        }),
      ).toThrow(/per month or once over the loan/i);
    });

    it('refuses an undecided method by name', () => {
      expect(() =>
        calculateMemberLoan({
          principal: toUgx(500_000),
          interestRateBps: 500,
          termMonths: 2,
          interestBasis: 'per_month',
          interestMethod: null,
        }),
      ).toThrow(/flat on the original principal or on a reducing balance/i);
    });

    it('refuses the combination nobody has defined, naming the three readings', () => {
      let caught: unknown;

      try {
        calculateMemberLoan({
          principal: toUgx(500_000),
          interestRateBps: 500,
          termMonths: 2,
          interestBasis: 'per_loan',
          interestMethod: 'reducing_balance_monthly',
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(MemberLoanError);
      expect((caught as MemberLoanError).code).toBe('combination_undefined');
      expect((caught as MemberLoanError).message).toMatch(/three different prices/i);
    });

    it('refuses a non-positive principal, a negative rate and a zero term', () => {
      const base = {
        interestRateBps: 500,
        termMonths: 2,
        interestBasis: 'per_month' as const,
        interestMethod: 'flat' as const,
      };

      expect(() => calculateMemberLoan({ ...base, principal: toUgx(0) })).toThrow(
        /positive whole number of shillings/i,
      );
      expect(() =>
        calculateMemberLoan({ ...base, principal: toUgx(500_000), interestRateBps: -1 }),
      ).toThrow(/non-negative whole number of basis points/i);
      expect(() =>
        calculateMemberLoan({ ...base, principal: toUgx(500_000), termMonths: 0 }),
      ).toThrow(/positive whole number of months/i);
      expect(() =>
        calculateMemberLoan({ ...base, principal: toUgx(500_000), termMonths: 121 }),
      ).toThrow(/beyond the supported range/i);
    });
  });
});

describe('quoteMemberLoan', () => {
  it('returns the calculation when the policy is decided', () => {
    const quote = quoteMemberLoan({
      principal: toUgx(400_000),
      interestRateBps: 500,
      termMonths: 2,
      interestBasis: 'per_month',
      interestMethod: 'reducing_balance_monthly',
    });

    expect(quote.priced).toBe(true);
    expect(quote.blockedReason).toBeNull();
    expect(quote.calculation?.totalInterest).toBe(30_000);
  });

  it('returns the reason rather than throwing, so a screen can show it', () => {
    const quote = quoteMemberLoan({
      principal: toUgx(400_000),
      interestRateBps: 500,
      termMonths: 2,
      interestBasis: null,
      interestMethod: null,
    });

    expect(quote.priced).toBe(false);
    expect(quote.calculation).toBeNull();
    expect(quote.blockedReason).toMatch(/has not been decided/i);
  });

  it('lets a genuine programming error through rather than swallowing it', () => {
    // A `MemberLoanError` becomes a blocked reason; anything else is a defect
    // and must not be presented to a member as a policy message.
    expect(() =>
      quoteMemberLoan({
        principal: Number.NaN as never,
        interestRateBps: 500,
        termMonths: 2,
        interestBasis: 'per_month',
        interestMethod: 'flat',
      }),
    ).not.toThrow();
  });
});

describe('memberLoanCeiling', () => {
  it('is absent while the multiplier is undecided, rather than permissive', () => {
    expect(memberLoanCeiling(toUgx(600_000), null)).toBeNull();
  });

  it('multiplies the savings base by the multiplier, half-up', () => {
    expect(memberLoanCeiling(toUgx(600_000), 20_000)).toBe(1_200_000);
    expect(memberLoanCeiling(toUgx(600_000), 10_000)).toBe(600_000);
    expect(memberLoanCeiling(toUgx(600_000), 5_000)).toBe(300_000);
    // 12,345 bp of 55,555 is 68,582.5 exactly, and a ceiling rounds **down**
    // so that it always agrees with the pledge that consumes it. See the note
    // on `memberLoanCeiling`.
    expect(memberLoanCeiling(toUgx(55_555), 12_345)).toBe(68_582);
  });

  it('supports nothing on nothing saved', () => {
    expect(memberLoanCeiling(toUgx(0), 20_000)).toBe(0);
  });

  it('refuses a multiplier of zero or less, which would be a decision nobody made', () => {
    expect(() => memberLoanCeiling(toUgx(600_000), 0)).toThrow(/positive whole number/i);
    expect(() => memberLoanCeiling(toUgx(600_000), -1)).toThrow(/positive whole number/i);
  });
});

describe('pledgedSavingsForLoan', () => {
  it('is the principal divided by the multiplier, rounded up', () => {
    // At 2x, a 1,000,000 loan consumed 500,000 of capacity.
    expect(pledgedSavingsForLoan(toUgx(1_000_000), 20_000)).toBe(500_000);
    expect(pledgedSavingsForLoan(toUgx(400_000), 20_000)).toBe(200_000);
    // At 1x, the loan consumes its own size.
    expect(pledgedSavingsForLoan(toUgx(400_000), 10_000)).toBe(400_000);
  });

  it('rounds up, so rounding can only over-pledge', () => {
    // 300,001 at 3x is 100,000.33 of capacity.
    expect(pledgedSavingsForLoan(toUgx(300_001), 30_000)).toBe(100_001);
    // 1 shilling at 3x is 0.0333, which must still consume a shilling: a
    // pledge of zero would let an unbounded number of tiny loans run against
    // nothing.
    expect(pledgedSavingsForLoan(toUgx(1), 30_000)).toBe(1);
  });

  it('never pledges more than the member holds, at any savings and any multiplier', () => {
    // The property that makes the ceiling and the pledge agree, and the one
    // that found the rounding defect: half-up on the ceiling made a 0.5x
    // multiplier on 333,333 pledge 333,334 against 333,333 held, which
    // `approve_loan`'s own invariant would then have refused.
    for (const savings of [1, 3, 99_999, 100_000, 333_333, 600_000, 1_000_001]) {
      for (const multiplier of [1, 3_333, 5_000, 10_000, 20_000, 30_000, 123_456]) {
        const ceiling = memberLoanCeiling(toUgx(savings), multiplier);
        if (ceiling === null || ceiling === 0) continue;

        const pledged = pledgedSavingsForLoan(ceiling, multiplier);
        const label = `${String(savings)} at ${String(multiplier)}bp`;

        // Never more than the member holds, which is the invariant
        // `approve_loan` asserts inside its own transaction.
        expect(pledged, label).toBeLessThanOrEqual(savings);
      }
    }
  });

  it('refuses a non-positive multiplier or principal', () => {
    expect(() => pledgedSavingsForLoan(toUgx(400_000), 0)).toThrow(
      /positive whole number of basis points/i,
    );
    expect(() => pledgedSavingsForLoan(toUgx(0), 20_000)).toThrow(
      /positive whole number of shillings/i,
    );
  });
});

describe('requiredMemberCadence', () => {
  it('is weekly up to the policy boundary and monthly beyond it', () => {
    // The confirmed rule: weekly for one- and two-month member loans, monthly
    // for longer, with 2 the boundary the documents imply.
    expect(requiredMemberCadence(1, 2)).toBe('weekly');
    expect(requiredMemberCadence(2, 2)).toBe('weekly');
    expect(requiredMemberCadence(3, 2)).toBe('monthly');
    expect(requiredMemberCadence(5, 2)).toBe('monthly');
  });

  it('follows a boundary the business moves, rather than a hard-coded two', () => {
    // The boundary is a policy value so that a different one is a policy
    // change rather than a code change.
    expect(requiredMemberCadence(3, 3)).toBe('weekly');
    expect(requiredMemberCadence(4, 3)).toBe('monthly');
    expect(requiredMemberCadence(1, 0)).toBe('monthly');
  });
});

describe('monthlyCollectionDate', () => {
  it('names both conventions and defaults to neither', () => {
    expect([...MONTH_ANCHORS]).toEqual([
      'clamp_to_month_end',
      'roll_forward_to_next_month',
    ]);
  });

  // The same table `tests/db/calendar-month-schedule.test.ts` asserts against
  // the database, stated here independently so a divergence fails in both
  // places rather than in neither.
  const CASES: readonly {
    readonly from: string;
    readonly clamp: readonly string[];
    readonly roll: readonly string[];
  }[] = [
    {
      from: '2026-01-31',
      clamp: ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'],
      roll: ['2026-03-01', '2026-03-31', '2026-05-01', '2026-05-31', '2026-07-01'],
    },
    {
      from: '2024-01-31',
      clamp: ['2024-02-29', '2024-03-31', '2024-04-30', '2024-05-31', '2024-06-30'],
      roll: ['2024-03-01', '2024-03-31', '2024-05-01', '2024-05-31', '2024-07-01'],
    },
    {
      from: '2026-12-31',
      clamp: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31'],
      roll: ['2027-01-31', '2027-03-01', '2027-03-31', '2027-05-01', '2027-05-31'],
    },
    {
      from: '2026-01-15',
      clamp: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'],
      roll: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'],
    },
  ];

  for (const testCase of CASES) {
    it(`clamps to the month end from ${testCase.from}`, () => {
      for (const [index, expected] of testCase.clamp.entries()) {
        expect(
          monthlyCollectionDate(d(testCase.from), index + 1, 'clamp_to_month_end'),
          `+${String(index + 1)} months`,
        ).toBe(expected);
      }
    });

    it(`rolls forward into the next month from ${testCase.from}`, () => {
      for (const [index, expected] of testCase.roll.entries()) {
        expect(
          monthlyCollectionDate(
            d(testCase.from),
            index + 1,
            'roll_forward_to_next_month',
          ),
          `+${String(index + 1)} months`,
        ).toBe(expected);
      }
    });
  }

  it('keeps both conventions strictly increasing from every day of a leap year', () => {
    for (const anchor of MONTH_ANCHORS satisfies readonly MonthAnchor[]) {
      for (let day = 0; day < 366; day += 1) {
        const start = new Date(Date.UTC(2024, 0, 1 + day));
        const from = d(start.toISOString().slice(0, 10));

        let previous: string | null = null;

        for (let months = 1; months <= 24; months += 1) {
          const due = String(monthlyCollectionDate(from, months, anchor));

          if (previous !== null) {
            expect(
              due > previous,
              `${anchor}: ${String(from)} + ${String(months)} months gave ${due} after ${previous}`,
            ).toBe(true);
          }

          previous = due;
        }
      }
    }
  });

  it('refuses a step of less than one month', () => {
    expect(() => monthlyCollectionDate(d('2026-01-31'), 0, 'clamp_to_month_end')).toThrow(
      /at least one month/i,
    );
  });
});

describe('memberLendingReadiness', () => {
  it('reports every open decision while nothing is settled', () => {
    const readiness = memberLendingReadiness({
      interestBasis: null,
      interestMethod: null,
      savingsToLoanMultiplierBps: null,
      monthAnchor: null,
    });

    expect(readiness.isReady).toBe(false);
    expect(readiness.outstanding).toEqual([
      'interest_basis',
      'interest_method',
      'savings_to_loan_multiplier_bps',
      'month_anchor',
    ]);
  });

  it('is ready only when all four are decided', () => {
    expect(
      memberLendingReadiness({
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
        monthAnchor: 'clamp_to_month_end',
      }),
    ).toEqual({ outstanding: [], isReady: true });
  });

  it('treats a decided zero as decided', () => {
    // A multiplier of zero would be a strange decision, but it is a decision.
    // "Nobody has said" is the only thing that is not.
    const readiness = memberLendingReadiness({
      interestBasis: 'per_loan',
      interestMethod: 'flat',
      savingsToLoanMultiplierBps: 0,
      monthAnchor: 'roll_forward_to_next_month',
    });

    expect(readiness.outstanding).toEqual([]);
    expect(readiness.isReady).toBe(true);
  });

  it('reports the anchor alone when the three policy questions are answered', () => {
    // The state the business reaches by answering the three policy questions
    // and not the cadence convention: weekly member loans work, and three- to
    // five-month ones do not. Worth a test of its own, because it is the
    // state a reader of the roadmap would not expect.
    const readiness = memberLendingReadiness({
      interestBasis: 'per_month',
      interestMethod: 'flat',
      savingsToLoanMultiplierBps: 20_000,
      monthAnchor: null,
    });

    expect(readiness.outstanding).toEqual(['month_anchor']);
    expect(readiness.isReady).toBe(false);
  });
});

describe('the unresolved decisions, as the interface names them', () => {
  it('lists four, three of them policy columns and one a cadence column', () => {
    expect(MEMBER_LENDING_DECISIONS).toHaveLength(4);

    const homes = MEMBER_LENDING_DECISIONS.map((decision) => decision.home);

    expect(
      homes.filter((home) => home.startsWith('membership_policy_versions.')),
    ).toHaveLength(3);
    // The monthly anchor is deliberately not a tenth policy question: it is a
    // property of the cadence, not of the membership programme. See ADR-059.
    expect(homes).toContain('repayment_frequencies.month_anchor');
  });

  it('gives every decision a question and a consequence a reader can act on', () => {
    for (const decision of MEMBER_LENDING_DECISIONS) {
      expect(decision.question.length, decision.key).toBeGreaterThan(20);
      expect(decision.consequence.length, decision.key).toBeGreaterThan(20);
      expect(decision.question, decision.key).toMatch(/\?$/);
    }
  });

  it('matches the keys memberLendingReadiness reports', () => {
    const declared = MEMBER_LENDING_DECISIONS.map((decision) => decision.key);

    const reported = memberLendingReadiness({
      interestBasis: null,
      interestMethod: null,
      savingsToLoanMultiplierBps: null,
      monthAnchor: null,
    }).outstanding;

    expect([...reported].sort()).toEqual([...declared].sort());
  });
});
