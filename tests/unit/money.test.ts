import { describe, expect, it } from 'vitest';

import {
  MAX_UGX_AMOUNT,
  MoneyError,
  addUgx,
  applyRateBps,
  clampUgx,
  compareUgx,
  divideEvenly,
  formatUgx,
  fromDatabaseAmount,
  isUgxAmount,
  maxUgx,
  minUgx,
  multiplyUgx,
  parseUgx,
  roundToShilling,
  subtractUgx,
  sumUgx,
  toUgx,
} from '@/lib/domain/money';

describe('toUgx', () => {
  it('accepts whole shillings', () => {
    expect(toUgx(100_000)).toBe(100_000);
    expect(toUgx(0)).toBe(0);
  });

  it('rejects a fractional amount rather than rounding it', () => {
    // Silently rounding an input is how money goes missing.
    expect(() => toUgx(100.5)).toThrow(MoneyError);
    expect(() => toUgx(0.01)).toThrow(/whole number of shillings/);
  });

  it('rejects non-finite values', () => {
    expect(() => toUgx(Number.NaN)).toThrow(MoneyError);
    expect(() => toUgx(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it('rejects amounts beyond the supported magnitude', () => {
    expect(() => toUgx(MAX_UGX_AMOUNT + 1)).toThrow(/exceeds the maximum/);
  });

  it('keeps the limit well inside the exact-integer range', () => {
    // Headroom matters: sums of several amounts must also stay exact.
    expect(MAX_UGX_AMOUNT).toBeLessThan(Number.MAX_SAFE_INTEGER / 8);
  });
});

describe('isUgxAmount', () => {
  it('distinguishes valid amounts from everything else', () => {
    expect(isUgxAmount(5_000)).toBe(true);
    expect(isUgxAmount(5_000.5)).toBe(false);
    expect(isUgxAmount('5000')).toBe(false);
    expect(isUgxAmount(null)).toBe(false);
    expect(isUgxAmount(Number.NaN)).toBe(false);
  });
});

describe('parseUgx', () => {
  it('accepts the shapes staff actually type', () => {
    expect(parseUgx('100000')).toBe(100_000);
    expect(parseUgx('100,000')).toBe(100_000);
    expect(parseUgx('100 000')).toBe(100_000);
    expect(parseUgx('UGX 100,000')).toBe(100_000);
    expect(parseUgx('ugx 2,500,000')).toBe(2_500_000);
  });

  it('accepts a zero fractional part but not a real one', () => {
    expect(parseUgx('100000.00')).toBe(100_000);
    expect(() => parseUgx('100000.50')).toThrow(/fraction of a shilling/);
  });

  it('rejects junk and blanks', () => {
    expect(() => parseUgx('')).toThrow(/required/);
    expect(() => parseUgx('   ')).toThrow(/required/);
    expect(() => parseUgx('abc')).toThrow(/not a valid shilling amount/);
    expect(() => parseUgx('1e5')).toThrow(/not a valid shilling amount/);
  });

  it('handles non-breaking and narrow spaces produced by copy-paste', () => {
    expect(parseUgx('100 000')).toBe(100_000);
    expect(parseUgx('100 000')).toBe(100_000);
  });
});

describe('roundToShilling', () => {
  it('rounds half away from zero in half-up mode, symmetrically', () => {
    expect(roundToShilling(10.5, 'half-up')).toBe(11);
    // Math.round(-0.5) is -0, which is not symmetric; the implementation
    // rounds the magnitude and restores the sign.
    expect(roundToShilling(-10.5, 'half-up')).toBe(-11);
  });

  it('rounds half to even in half-even mode', () => {
    expect(roundToShilling(10.5, 'half-even')).toBe(10);
    expect(roundToShilling(11.5, 'half-even')).toBe(12);
  });

  it('truncates toward zero in down mode', () => {
    expect(roundToShilling(10.9, 'down')).toBe(10);
    expect(roundToShilling(-10.9, 'down')).toBe(-10);
  });

  it('moves away from zero in up mode', () => {
    expect(roundToShilling(10.1, 'up')).toBe(11);
    expect(roundToShilling(-10.1, 'up')).toBe(-11);
  });

  it('never produces negative zero', () => {
    expect(Object.is(roundToShilling(-0.4, 'half-up'), -0)).toBe(false);
    expect(roundToShilling(-0.4, 'half-up')).toBe(0);
  });
});

describe('addition and subtraction', () => {
  it('adds and sums', () => {
    expect(addUgx(toUgx(1_000), toUgx(2_500))).toBe(3_500);
    expect(sumUgx([toUgx(100), toUgx(200), toUgx(300)])).toBe(600);
    expect(sumUgx([])).toBe(0);
  });

  it('allows a negative result, leaving validity to the caller', () => {
    // An outstanding balance can legitimately go negative after an
    // overpayment; the domain rule belongs to the loan, not to arithmetic.
    expect(subtractUgx(toUgx(1_000), toUgx(1_500))).toBe(-500);
  });

  it('stays exact where floating point would not', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In integer shillings the
    // equivalent sum is exact, which is the whole reason for this
    // representation.
    const total = sumUgx(Array.from({ length: 10 }, () => toUgx(1)));
    expect(total).toBe(10);
  });
});

describe('multiplyUgx', () => {
  it('multiplies by a whole number', () => {
    expect(multiplyUgx(toUgx(1_500), 30)).toBe(45_000);
  });

  it('rejects a fractional factor and points at applyRateBps', () => {
    expect(() => multiplyUgx(toUgx(1_000), 1.15)).toThrow(/applyRateBps/);
  });

  it('detects overflow rather than silently losing precision', () => {
    expect(() => multiplyUgx(toUgx(MAX_UGX_AMOUNT), 2)).toThrow(/exceeds the maximum/);
  });
});

describe('applyRateBps', () => {
  it('applies the business rates exactly', () => {
    // 15% per month on UGX 100,000.
    expect(applyRateBps(toUgx(100_000), 1_500)).toBe(15_000);
    // 50% penalty on a remaining balance.
    expect(applyRateBps(toUgx(240_000), 5_000)).toBe(120_000);
  });

  it('rounds the inexact case according to the mode given', () => {
    // 50% of 333 is 166.5.
    expect(applyRateBps(toUgx(333), 5_000, 'half-up')).toBe(167);
    expect(applyRateBps(toUgx(333), 5_000, 'down')).toBe(166);
    expect(applyRateBps(toUgx(333), 5_000, 'up')).toBe(167);
    expect(applyRateBps(toUgx(333), 5_000, 'half-even')).toBe(166);
  });

  it('handles a zero rate and a zero amount', () => {
    expect(applyRateBps(toUgx(100_000), 0)).toBe(0);
    expect(applyRateBps(toUgx(0), 1_500)).toBe(0);
  });

  it('stays exact at the top of the supported range', () => {
    // amount * bps would be 1e19 here, far beyond 2^53. The intermediate
    // product is computed in BigInt, so the result is exact rather than
    // approximate.
    expect(applyRateBps(toUgx(MAX_UGX_AMOUNT), 10_000)).toBe(MAX_UGX_AMOUNT);
    expect(applyRateBps(toUgx(MAX_UGX_AMOUNT), 1_500)).toBe(150_000_000_000_000);
  });

  it('rejects a decimal rate, which is the classic 0.15-versus-1500 mistake', () => {
    expect(() => applyRateBps(toUgx(100_000), 0.15)).toThrow(/non-negative whole number/);
  });

  it('rejects a negative rate', () => {
    expect(() => applyRateBps(toUgx(100_000), -100)).toThrow(MoneyError);
  });
});

describe('divideEvenly', () => {
  it('distributes the remainder so the parts sum to the whole', () => {
    // An installment schedule that does not add up to the loan is a bug the
    // books will eventually surface.
    expect(divideEvenly(toUgx(100), 3)).toEqual([33, 33, 34]);
    expect(divideEvenly(toUgx(100), 3, { remainder: 'first' })).toEqual([34, 33, 33]);
  });

  it('always sums back exactly, across many shapes', () => {
    for (const amount of [1, 7, 100, 115_000, 999_999, 1_234_567]) {
      for (const parts of [1, 2, 3, 7, 30, 31, 90]) {
        const pieces = divideEvenly(toUgx(amount), parts);
        expect(pieces).toHaveLength(parts);
        expect(pieces.reduce<number>((total, piece) => total + piece, 0)).toBe(amount);
      }
    }
  });

  it('divides exactly when there is no remainder', () => {
    expect(divideEvenly(toUgx(90_000), 3)).toEqual([30_000, 30_000, 30_000]);
  });

  it('handles a single part and a zero amount', () => {
    expect(divideEvenly(toUgx(5_000), 1)).toEqual([5_000]);
    expect(divideEvenly(toUgx(0), 4)).toEqual([0, 0, 0, 0]);
  });

  it('rejects an invalid part count and a negative amount', () => {
    expect(() => divideEvenly(toUgx(100), 0)).toThrow(/positive whole number/);
    expect(() => divideEvenly(toUgx(100), -1)).toThrow(MoneyError);
    expect(() => divideEvenly(toUgx(100), 2.5)).toThrow(MoneyError);
    expect(() => divideEvenly(toUgx(-100), 2)).toThrow(/negative amount/);
  });
});

describe('comparison helpers', () => {
  it('compares, bounds and clamps', () => {
    expect(compareUgx(toUgx(1), toUgx(2))).toBe(-1);
    expect(compareUgx(toUgx(2), toUgx(2))).toBe(0);
    expect(compareUgx(toUgx(3), toUgx(2))).toBe(1);

    expect(minUgx(toUgx(5), toUgx(2), toUgx(9))).toBe(2);
    expect(maxUgx(toUgx(5), toUgx(2), toUgx(9))).toBe(9);

    expect(clampUgx(toUgx(50_000), toUgx(100_000), toUgx(500_000))).toBe(100_000);
    expect(clampUgx(toUgx(900_000), toUgx(100_000), toUgx(500_000))).toBe(500_000);
    expect(clampUgx(toUgx(250_000), toUgx(100_000), toUgx(500_000))).toBe(250_000);
  });

  it('rejects inverted bounds and empty inputs', () => {
    expect(() => clampUgx(toUgx(1), toUgx(10), toUgx(5))).toThrow(/Lower bound/);
    expect(() => minUgx()).toThrow(MoneyError);
    expect(() => maxUgx()).toThrow(MoneyError);
  });
});

describe('formatUgx', () => {
  it('formats with the currency code and no decimals', () => {
    // There is no fraction of a shilling to display.
    expect(formatUgx(toUgx(1_500_000))).toBe('UGX 1,500,000');
    expect(formatUgx(toUgx(0))).toBe('UGX 0');
  });

  it('omits the currency when asked, for table cells', () => {
    expect(formatUgx(toUgx(1_500_000), { withCurrency: false })).toBe('1,500,000');
  });

  it('normalises the non-breaking space Intl inserts', () => {
    expect(formatUgx(toUgx(100))).not.toMatch(/ /);
  });
});

describe('database conversion', () => {
  it('accepts both shapes a bigint column arrives in', () => {
    // PostgREST sends a JSON number; the `pg` driver sends a string.
    expect(fromDatabaseAmount(100_000)).toBe(100_000);
    expect(fromDatabaseAmount('100000')).toBe(100_000);
    expect(fromDatabaseAmount(100_000n)).toBe(100_000);
    expect(fromDatabaseAmount(null)).toBeNull();
  });

  it('rejects a value it cannot represent exactly instead of truncating', () => {
    expect(() => fromDatabaseAmount('99999999999999999999')).toThrow(
      /exceeds the maximum/,
    );
    expect(() => fromDatabaseAmount('not-a-number')).toThrow(/not an integer/);
    expect(() => fromDatabaseAmount(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      /cannot be represented exactly/,
    );
  });
});
