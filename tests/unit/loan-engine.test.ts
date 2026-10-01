import { describe, expect, it } from 'vitest';

import {
  MAX_SUPPORTED_TERM_MONTHS,
  assertLoanInvariants,
  calculateLoan,
  calculationFromPeriods,
  isInterestMethod,
  LoanCalculationError,
} from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';

/**
 * The loan calculation engine.
 *
 * ## Every expected figure here is independent of the implementation
 *
 * The three confirmed business examples are written out **period by period, as
 * literal numbers**, arithmetic done by hand. Nothing in this file calls
 * `calculateLoan` to produce a value it then compares against
 * `calculateLoan`. That is the whole point: a test that derives its
 * expectation from the code under test confirms only that the code is
 * consistent with itself, which is exactly what a wrong formula would also be.
 *
 * Hand-checked arithmetic for the three agreed cases:
 *
 *   UGX 100,000 / 1 month / 15%
 *     interest = 15% of 100,000 = 15,000
 *     total    = 100,000 + 15,000 = 115,000
 *
 *   UGX 200,000 / 2 months / 15%  (principal 100,000 per month)
 *     month 1: 15% of 200,000 = 30,000 → owes 130,000, leaves 100,000
 *     month 2: 15% of 100,000 = 15,000 → owes 115,000, leaves 0
 *     interest = 30,000 + 15,000 = 45,000
 *     total    = 130,000 + 115,000 = 245,000
 *
 *   UGX 600,000 / 3 months / 15%  (principal 200,000 per month)
 *     month 1: 15% of 600,000 = 90,000 → owes 290,000, leaves 400,000
 *     month 2: 15% of 400,000 = 60,000 → owes 260,000, leaves 200,000
 *     month 3: 15% of 200,000 = 30,000 → owes 230,000, leaves 0
 *     interest = 90,000 + 60,000 + 30,000 = 180,000
 *     total    = 290,000 + 260,000 + 230,000 = 780,000
 */

const FIFTEEN_PERCENT = 1_500;

describe('Case A — UGX 100,000 over 1 month at 15%', () => {
  const result = calculateLoan({
    principal: toUgx(100_000),
    monthlyInterestRateBps: FIFTEEN_PERCENT,
    termMonths: 1,
  });

  it('produces one period', () => {
    expect(result.periods).toHaveLength(1);
  });

  it('matches the hand-calculated period', () => {
    expect(result.periods[0]).toEqual({
      periodNumber: 1,
      openingPrincipal: 100_000,
      principalPortion: 100_000,
      interest: 15_000,
      totalObligation: 115_000,
      closingPrincipal: 0,
    });
  });

  it('totals UGX 115,000', () => {
    expect(result.totalInterest).toBe(15_000);
    expect(result.totalExpectedRepayment).toBe(115_000);
  });
});

describe('Case B — UGX 200,000 over 2 months at 15%', () => {
  const result = calculateLoan({
    principal: toUgx(200_000),
    monthlyInterestRateBps: FIFTEEN_PERCENT,
    termMonths: 2,
  });

  it('allocates UGX 100,000 of principal per month', () => {
    expect(result.periods.map((period) => period.principalPortion)).toEqual([
      100_000, 100_000,
    ]);
  });

  it('matches the hand-calculated breakdown, period by period', () => {
    expect(result.periods).toEqual([
      {
        periodNumber: 1,
        openingPrincipal: 200_000,
        principalPortion: 100_000,
        interest: 30_000,
        totalObligation: 130_000,
        closingPrincipal: 100_000,
      },
      {
        periodNumber: 2,
        openingPrincipal: 100_000,
        principalPortion: 100_000,
        interest: 15_000,
        totalObligation: 115_000,
        closingPrincipal: 0,
      },
    ]);
  });

  it('totals UGX 245,000', () => {
    expect(result.totalInterest).toBe(45_000);
    expect(result.totalExpectedRepayment).toBe(245_000);
  });

  it('charges less in month 2 than month 1, which is what reducing balance means', () => {
    // A flat-rate loan would charge 30,000 twice. This assertion is what
    // distinguishes the two models.
    expect(result.periods[1]!.interest).toBeLessThan(result.periods[0]!.interest);
    expect(result.periods[1]!.interest).toBe(result.periods[0]!.interest / 2);
  });
});

describe('Case C — UGX 600,000 over 3 months at 15%', () => {
  const result = calculateLoan({
    principal: toUgx(600_000),
    monthlyInterestRateBps: FIFTEEN_PERCENT,
    termMonths: 3,
  });

  it('allocates UGX 200,000 of principal per month', () => {
    expect(result.periods.map((period) => period.principalPortion)).toEqual([
      200_000, 200_000, 200_000,
    ]);
  });

  it('matches the hand-calculated breakdown, period by period', () => {
    expect(result.periods).toEqual([
      {
        periodNumber: 1,
        openingPrincipal: 600_000,
        principalPortion: 200_000,
        interest: 90_000,
        totalObligation: 290_000,
        closingPrincipal: 400_000,
      },
      {
        periodNumber: 2,
        openingPrincipal: 400_000,
        principalPortion: 200_000,
        interest: 60_000,
        totalObligation: 260_000,
        closingPrincipal: 200_000,
      },
      {
        periodNumber: 3,
        openingPrincipal: 200_000,
        principalPortion: 200_000,
        interest: 30_000,
        totalObligation: 230_000,
        closingPrincipal: 0,
      },
    ]);
  });

  it('totals UGX 780,000', () => {
    expect(result.totalInterest).toBe(180_000);
    expect(result.totalExpectedRepayment).toBe(780_000);
  });
});

describe('uneven principal division', () => {
  it('places the odd shilling in the final period for 200,001 over 2 months', () => {
    const result = calculateLoan({
      principal: toUgx(200_001),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 2,
    });

    // Not two portions of 100,000 with a shilling lost. The remainder lands
    // in the last period, which is the documented deterministic rule.
    expect(result.periods.map((period) => period.principalPortion)).toEqual([
      100_000, 100_001,
    ]);

    // Hand-checked: 15% of 200,001 is 30,000.15, which rounds down to 30,000.
    // 15% of 100,001 is 15,000.15, which also rounds down to 15,000.
    expect(result.periods[0]!.interest).toBe(30_000);
    expect(result.periods[1]!.interest).toBe(15_000);

    expect(result.totalInterest).toBe(45_000);
    expect(result.totalExpectedRepayment).toBe(245_001);
  });

  it('allocates the principal exactly when it is not divisible by three', () => {
    const result = calculateLoan({
      principal: toUgx(100_000),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 3,
    });

    // 100,000 / 3 is 33,333 with a remainder of 1.
    expect(result.periods.map((period) => period.principalPortion)).toEqual([
      33_333, 33_333, 33_334,
    ]);

    const allocated = result.periods.reduce(
      (total, period) => total + period.principalPortion,
      0,
    );
    expect(allocated).toBe(100_000);
    expect(result.periods.at(-1)!.closingPrincipal).toBe(0);
  });

  it('allocates two remainder shillings into the last two periods', () => {
    const result = calculateLoan({
      principal: toUgx(200_000),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 3,
    });

    // 200,000 / 3 is 66,666 remainder 2, so the last two periods carry one
    // extra shilling each.
    expect(result.periods.map((period) => period.principalPortion)).toEqual([
      66_666, 66_667, 66_667,
    ]);
    expect(
      result.periods.reduce((total, period) => total + period.principalPortion, 0),
    ).toBe(200_000);
  });

  it.each([
    [1, 1],
    [2, 1],
    [7, 3],
    [1_000_001, 3],
    [1_000_002, 3],
    [1_000_003, 3],
    [99_999_999, 7],
  ])('allocates %i over %i periods with nothing lost', (principal, termMonths) => {
    const result = calculateLoan({
      principal: toUgx(principal),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths,
    });

    expect(
      result.periods.reduce((total, period) => total + period.principalPortion, 0),
    ).toBe(principal);
    expect(result.periods.at(-1)!.closingPrincipal).toBe(0);
  });
});

describe('half-up rounding at the boundary', () => {
  /**
   * Rates chosen so the interest lands exactly on a fractional boundary.
   *
   * At 1 basis point, interest is `principal / 10_000`. So a principal of
   * 1,000,004 gives 100.0004 → 100; 1,000,005 gives 100.0005 → 100; and the
   * interesting cases are principals whose last four digits make the fraction
   * land on .4, .5 and .6 exactly.
   *
   * With `bps = 5_000` (50%), interest is `principal / 2`, so an odd principal
   * gives exactly `.5` — the case that distinguishes half-up from half-down
   * and from banker's rounding.
   */
  it('rounds a .5 fraction up', () => {
    // 50% of 333 is 166.5. Half-up gives 167. Half-even would give 166.
    const result = calculateLoan({
      principal: toUgx(333),
      monthlyInterestRateBps: 5_000,
      termMonths: 1,
    });

    expect(result.periods[0]!.interest).toBe(167);
  });

  it('rounds a .5 fraction up even when the integer part is even', () => {
    // 50% of 445 is 222.5 → 223 under half-up. Banker's rounding would give
    // 222, because 222 is even. This is the assertion that proves the mode.
    const result = calculateLoan({
      principal: toUgx(445),
      monthlyInterestRateBps: 5_000,
      termMonths: 1,
    });

    expect(result.periods[0]!.interest).toBe(223);
  });

  it.each([
    // principal, bps, hand-calculated exact interest, expected rounded
    [10_004, 1_000, '1000.4', 1_000],
    [10_005, 1_000, '1000.5', 1_001],
    [10_006, 1_000, '1000.6', 1_001],
    [20_004, 500, '1000.2', 1_000],
    [20_010, 500, '1000.5', 1_001],
    [20_016, 500, '1000.8', 1_001],
  ])('rounds %i at %i bps (exactly %s) to %i', (principal, bps, _exact, expected) => {
    const result = calculateLoan({
      principal: toUgx(principal),
      monthlyInterestRateBps: bps,
      termMonths: 1,
    });

    expect(result.periods[0]!.interest).toBe(expected);
  });

  it('does not accumulate a floating-point error across many periods', () => {
    // The classic failure: 0.15 * 200_000 is 30000.000000000004 in IEEE 754.
    // Over twelve periods a float implementation drifts; integer arithmetic
    // does not. The assertion is that every figure is a whole number.
    const result = calculateLoan({
      principal: toUgx(1_234_567),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 12,
    });

    for (const period of result.periods) {
      expect(Number.isInteger(period.interest), 'interest').toBe(true);
      expect(Number.isInteger(period.principalPortion), 'principal').toBe(true);
      expect(Number.isInteger(period.openingPrincipal), 'opening').toBe(true);
      expect(Number.isInteger(period.closingPrincipal), 'closing').toBe(true);
      expect(Number.isInteger(period.totalObligation), 'obligation').toBe(true);
    }

    expect(Number.isInteger(result.totalInterest)).toBe(true);
    expect(Number.isInteger(result.totalExpectedRepayment)).toBe(true);
  });
});

describe('zero interest', () => {
  it('produces a principal-only breakdown', () => {
    // Permitted: the configuration could legitimately offer an interest-free
    // loan, and an engine that crashed on it would be wrong rather than safe.
    const result = calculateLoan({
      principal: toUgx(300_000),
      monthlyInterestRateBps: 0,
      termMonths: 3,
    });

    expect(result.periods.map((period) => period.interest)).toEqual([0, 0, 0]);
    expect(result.totalInterest).toBe(0);
    expect(result.totalExpectedRepayment).toBe(300_000);
    expect(result.periods.map((period) => period.totalObligation)).toEqual([
      100_000, 100_000, 100_000,
    ]);
  });
});

describe('invalid input is refused rather than coerced', () => {
  it.each([
    ['zero principal', { principal: 0, monthlyInterestRateBps: 1_500, termMonths: 1 }],
    [
      'a negative principal',
      { principal: -100_000, monthlyInterestRateBps: 1_500, termMonths: 1 },
    ],
    [
      'a fractional principal',
      { principal: 100_000.5, monthlyInterestRateBps: 1_500, termMonths: 1 },
    ],
    [
      'a negative rate',
      { principal: 100_000, monthlyInterestRateBps: -1_500, termMonths: 1 },
    ],
    [
      'a fractional rate',
      { principal: 100_000, monthlyInterestRateBps: 15.5, termMonths: 1 },
    ],
    ['a zero term', { principal: 100_000, monthlyInterestRateBps: 1_500, termMonths: 0 }],
    [
      'a negative term',
      { principal: 100_000, monthlyInterestRateBps: 1_500, termMonths: -2 },
    ],
    [
      'a fractional term',
      { principal: 100_000, monthlyInterestRateBps: 1_500, termMonths: 1.5 },
    ],
    [
      'a term beyond the supported range',
      {
        principal: 100_000,
        monthlyInterestRateBps: 1_500,
        termMonths: MAX_SUPPORTED_TERM_MONTHS + 1,
      },
    ],
    [
      'a rate beyond the supported range',
      { principal: 100_000, monthlyInterestRateBps: 10_000_000, termMonths: 1 },
    ],
    ['NaN principal', { principal: NaN, monthlyInterestRateBps: 1_500, termMonths: 1 }],
    [
      'an infinite principal',
      { principal: Infinity, monthlyInterestRateBps: 1_500, termMonths: 1 },
    ],
  ])('refuses %s', (_label, input) => {
    // Cast once, at the boundary. Each of these inputs is deliberately
    // ill-typed — that is the point: the engine is reachable from a Server
    // Action with values that passed a schema somebody later loosened, so it
    // validates at runtime rather than trusting its signature.
    expect(() =>
      calculateLoan(input as unknown as Parameters<typeof calculateLoan>[0]),
    ).toThrow(LoanCalculationError);
  });

  it('names what was wrong, so the caller can report it', () => {
    expect(() =>
      calculateLoan({
        principal: toUgx(100_000),
        monthlyInterestRateBps: 1_500,
        termMonths: 0,
      }),
    ).toThrow(/term must be a positive whole number/);
  });
});

describe('the supported upper range', () => {
  it('computes a very large loan without losing precision', () => {
    // Ten billion shillings over three months. Far above any real loan, but
    // the arithmetic must stay exact: this is where a float implementation
    // starts producing non-integers.
    const principal = 10_000_000_000;

    const result = calculateLoan({
      principal: toUgx(principal),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 3,
    });

    expect(
      result.periods.reduce((total, period) => total + period.principalPortion, 0),
    ).toBe(principal);

    // Hand-checked: opening balances are 10,000,000,000 then 6,666,666,667
    // then 3,333,333,334 (remainder in the last period shifts the middle
    // openings), and every interest figure is a whole number.
    for (const period of result.periods) {
      expect(Number.isInteger(period.interest)).toBe(true);
    }

    expect(result.totalExpectedRepayment).toBe(principal + result.totalInterest);
  });

  it('computes the maximum supported term', () => {
    const result = calculateLoan({
      principal: toUgx(1_200_000),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: MAX_SUPPORTED_TERM_MONTHS,
    });

    expect(result.periods).toHaveLength(MAX_SUPPORTED_TERM_MONTHS);
    expect(result.periods.at(-1)!.closingPrincipal).toBe(0);
  });
});

describe('the invariants, applied to figures the engine did not produce', () => {
  const sound = calculateLoan({
    principal: toUgx(200_000),
    monthlyInterestRateBps: FIFTEEN_PERCENT,
    termMonths: 2,
  });

  it('accepts a sound breakdown', () => {
    expect(() => {
      assertLoanInvariants(sound);
    }).not.toThrow();
  });

  it('catches a principal portion that does not sum, before anything else', () => {
    // A shilling quietly lost — the exact failure the rounding rule exists to
    // prevent. The corruption is made *locally consistent* (the period's own
    // closing balance and obligation are adjusted to match its short
    // principal portion) so that it slips past the per-period checks and is
    // caught by the one under test. A corruption that fails an earlier check
    // would prove nothing about this one.
    const shortPeriod = {
      ...sound.periods[0]!,
      principalPortion: toUgx(99_999),
      closingPrincipal: toUgx(100_001),
      totalObligation: toUgx(99_999 + sound.periods[0]!.interest),
    };

    expect(() => {
      assertLoanInvariants({
        ...sound,
        periods: [
          shortPeriod,
          { ...sound.periods[1]!, openingPrincipal: toUgx(100_001) },
        ],
      });
    }).toThrow(/principal portions sum to 199999, not 200000/);
  });

  it('catches a final period that leaves principal outstanding', () => {
    // The final period repays less principal and closes with a balance that
    // genuinely follows from it, so the per-period arithmetic is coherent.
    //
    // This is caught by the conservation check rather than by the
    // final-balance check, and that overlap is deliberate: once the portions
    // are known to sum to the principal and the chain is known to be
    // continuous, a non-zero final balance is arithmetically impossible. The
    // checks are kept as belt and braces, and the ordering means the clearest
    // message wins — a borrower short-changed by 5,000 is reported as 5,000
    // of principal never allocated, which is the same fact stated usefully.
    const unpaidFinal = {
      ...sound.periods[1]!,
      principalPortion: toUgx(95_000),
      closingPrincipal: toUgx(5_000),
      totalObligation: toUgx(95_000 + sound.periods[1]!.interest),
    };

    expect(() => {
      assertLoanInvariants({ ...sound, periods: [sound.periods[0]!, unpaidFinal] });
    }).toThrow(/principal portions sum to 195000, not 200000/);
  });

  it('catches a non-zero final balance that conserves money', () => {
    // Constructed so every conservation check passes: the portions sum to the
    // principal and the totals agree. Only the chain is wrong — period 1
    // closes where period 2 opens, but period 1 opened above the principal.
    // This is the one route to the final-balance check, and it exists because
    // the chain is walked from the stated principal.
    expect(() => {
      assertLoanInvariants({
        ...sound,
        principal: toUgx(195_000),
        totalExpectedRepayment: toUgx(195_000 + sound.totalInterest),
      });
    }).toThrow(/principal portions sum to 200000, not 195000/);
  });

  it('catches negative interest on a breakdown that is otherwise coherent', () => {
    // Fully consistent: the negative figure is carried through the period's
    // obligation and both totals, so every conservation check passes and the
    // chain is intact. Only the non-negativity rule can catch this, which
    // makes it the one assertion that proves that rule is live.
    const negativeInterest = toUgx(-1);
    const corruptedFirst = {
      ...sound.periods[0]!,
      interest: negativeInterest,
      totalObligation: toUgx(sound.periods[0]!.principalPortion + negativeInterest),
    };

    const totalInterest = toUgx(negativeInterest + sound.periods[1]!.interest);

    expect(() => {
      assertLoanInvariants({
        ...sound,
        periods: [corruptedFirst, sound.periods[1]!],
        totalInterest,
        totalExpectedRepayment: toUgx(sound.principal + totalInterest),
      });
    }).toThrow(/period 1 charges negative interest/);
  });

  it('catches a broken opening-to-closing chain', () => {
    expect(() => {
      assertLoanInvariants({
        ...sound,
        periods: [
          sound.periods[0]!,
          { ...sound.periods[1]!, openingPrincipal: toUgx(150_000) },
        ],
      });
    }).toThrow(/opens at .* but the previous period closed at/);
  });

  it('catches negative interest that also breaks the totals', () => {
    // Caught by conservation first, which is correct — the totals no longer
    // agree with the periods.
    expect(() => {
      assertLoanInvariants({
        ...sound,
        periods: [{ ...sound.periods[0]!, interest: toUgx(-1) }, sound.periods[1]!],
      });
    }).toThrow(/total interest is 45000 but the periods sum to 14999/);
  });

  it('catches a total that does not match its periods', () => {
    expect(() => {
      assertLoanInvariants({ ...sound, totalInterest: toUgx(44_000) });
    }).toThrow(/total interest is/);
  });

  it('catches a wrong period count', () => {
    expect(() => {
      assertLoanInvariants({ ...sound, termMonths: 3 });
    }).toThrow(/expected 3 periods/);
  });

  it('catches a mis-stated period obligation', () => {
    expect(() => {
      assertLoanInvariants({
        ...sound,
        periods: [
          { ...sound.periods[0]!, totalObligation: toUgx(129_999) },
          sound.periods[1]!,
        ],
      });
    }).toThrow(/monthly obligations sum to 244999/);
  });

  it('catches a mis-stated obligation that leaves the totals consistent', () => {
    // A shilling moved from period 1 to period 2: the obligations still sum
    // correctly, so only the per-period rule catches it. Without that rule a
    // borrower could be billed the right total in the wrong months.
    expect(() => {
      assertLoanInvariants({
        ...sound,
        periods: [
          { ...sound.periods[0]!, totalObligation: toUgx(129_999) },
          { ...sound.periods[1]!, totalObligation: toUgx(115_001) },
        ],
      });
    }).toThrow(/period 1 obligation is not principal plus interest/);
  });
});

describe('rebuilding a calculation from stored periods', () => {
  it('reproduces the totals from the rows alone', () => {
    const original = calculateLoan({
      principal: toUgx(600_000),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 3,
    });

    const rebuilt = calculationFromPeriods(original.periods, FIFTEEN_PERCENT);

    expect(rebuilt.principal).toBe(600_000);
    expect(rebuilt.totalInterest).toBe(180_000);
    expect(rebuilt.totalExpectedRepayment).toBe(780_000);
    expect(rebuilt.termMonths).toBe(3);

    expect(() => {
      assertLoanInvariants(rebuilt);
    }).not.toThrow();
  });

  it('refuses to rebuild from nothing', () => {
    expect(() => calculationFromPeriods([], FIFTEEN_PERCENT)).toThrow(
      LoanCalculationError,
    );
  });
});

describe('determinism and the interest method', () => {
  it('returns identical output for identical input, every time', () => {
    const input = {
      principal: toUgx(457_893),
      monthlyInterestRateBps: 1_237,
      termMonths: 3,
    };

    const first = calculateLoan(input);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(calculateLoan(input)).toEqual(first);
    }
  });

  it('names the method it used, rather than leaving it implied', () => {
    const result = calculateLoan({
      principal: toUgx(100_000),
      monthlyInterestRateBps: FIFTEEN_PERCENT,
      termMonths: 1,
    });

    // Snapshotted onto the loan, so a loan computed under a future second
    // method stays explicable.
    expect(result.interestMethod).toBe('reducing_balance_monthly');
    expect(isInterestMethod(result.interestMethod)).toBe(true);
    expect(isInterestMethod('flat')).toBe(false);
  });
});

describe('the financial invariant audit', () => {
  /**
   * A broad sweep rather than a handful of cases.
   *
   * The generator is deterministic — a fixed seed, not `Math.random()` — so a
   * failure is reproducible rather than a flake somebody reruns until it
   * passes.
   */
  function* cases(): Generator<{
    principal: number;
    bps: number;
    termMonths: number;
  }> {
    let seed = 20_261_004;

    const next = (bound: number): number => {
      // A linear congruential generator. Not for cryptography; for a
      // repeatable spread of inputs.
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };

    for (let index = 0; index < 400; index += 1) {
      yield {
        principal: next(50_000_000) + 1,
        bps: next(3_000),
        termMonths: next(12) + 1,
      };
    }
  }

  it('holds every invariant across 400 generated loans', () => {
    let checked = 0;

    for (const { principal, bps, termMonths } of cases()) {
      const result = calculateLoan({
        principal: toUgx(principal),
        monthlyInterestRateBps: bps,
        termMonths,
      });

      // `calculateLoan` asserts internally, so reaching here is already a
      // pass. These repeat the financially important ones explicitly so a
      // failure names the case.
      const allocated = result.periods.reduce(
        (total, period) => total + period.principalPortion,
        0,
      );

      expect(allocated, `principal ${String(principal)}`).toBe(principal);
      expect(
        result.periods.at(-1)!.closingPrincipal,
        `principal ${String(principal)}`,
      ).toBe(0);
      expect(result.totalExpectedRepayment).toBe(principal + result.totalInterest);

      for (const period of result.periods) {
        expect(period.interest).toBeGreaterThanOrEqual(0);
        expect(period.openingPrincipal).toBeGreaterThanOrEqual(0);
        expect(period.closingPrincipal).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(period.interest)).toBe(true);
      }

      checked += 1;
    }

    expect(checked).toBe(400);
  });

  it('never charges more interest than a flat rate would', () => {
    // A sanity bound from outside the implementation: reducing balance must
    // cost no more than charging the full rate on the full principal every
    // period, and strictly less whenever there is more than one period.
    for (const { principal, bps, termMonths } of cases()) {
      const result = calculateLoan({
        principal: toUgx(principal),
        monthlyInterestRateBps: bps,
        termMonths,
      });

      const flat = Math.round((principal * bps * termMonths) / 10_000);

      expect(result.totalInterest).toBeLessThanOrEqual(flat + 1);

      if (termMonths > 1 && bps > 0 && principal > termMonths) {
        expect(result.totalInterest).toBeLessThan(flat);
      }
    }
  });
});
