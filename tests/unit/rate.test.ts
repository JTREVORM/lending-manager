import { describe, expect, it } from 'vitest';

import {
  BPS_PER_PERCENT,
  BPS_PER_UNIT,
  MAX_BPS,
  RateError,
  bpsToPercent,
  formatBps,
  fromDatabaseBps,
  isBasisPoints,
  parseRatePercent,
  percentToBps,
  toBps,
} from '@/lib/domain/rate';

describe('basis point representation', () => {
  it('uses the conventional scale', () => {
    expect(BPS_PER_UNIT).toBe(10_000);
    expect(BPS_PER_PERCENT).toBe(100);
  });

  it('represents the business rates as integers', () => {
    // 15% monthly interest and the 50% penalty, exactly.
    expect(percentToBps(15)).toBe(1_500);
    expect(percentToBps(50)).toBe(5_000);
  });
});

describe('toBps', () => {
  it('accepts whole basis points in range', () => {
    expect(toBps(0)).toBe(0);
    expect(toBps(1_500)).toBe(1_500);
    expect(toBps(MAX_BPS)).toBe(MAX_BPS);
  });

  it('rejects a decimal rate and names the mistake', () => {
    // Passing 0.15 where 1500 is meant would under-charge by a factor of
    // 10,000, so the error says so explicitly.
    expect(() => toBps(0.15)).toThrow(/15% is 1500, not 0\.15/);
  });

  it('rejects negatives and out-of-range values', () => {
    expect(() => toBps(-1)).toThrow(/cannot be negative/);
    expect(() => toBps(MAX_BPS + 1)).toThrow(/exceeds the maximum/);
    expect(() => toBps(Number.NaN)).toThrow(RateError);
  });
});

describe('isBasisPoints', () => {
  it('discriminates correctly', () => {
    expect(isBasisPoints(1_500)).toBe(true);
    expect(isBasisPoints(0)).toBe(true);
    expect(isBasisPoints(-1)).toBe(false);
    expect(isBasisPoints(15.5)).toBe(false);
    expect(isBasisPoints('1500')).toBe(false);
  });
});

describe('percentToBps', () => {
  it('converts whole and two-decimal percentages', () => {
    expect(percentToBps(1)).toBe(100);
    expect(percentToBps(15.5)).toBe(1_550);
    expect(percentToBps(15.25)).toBe(1_525);
    expect(percentToBps(0)).toBe(0);
  });

  it('survives binary floating point at the edges', () => {
    // 15.01 * 100 is 1500.9999999999998, so a naive Number.isInteger check
    // would wrongly reject a perfectly valid rate.
    expect(percentToBps(15.01)).toBe(1_501);
    expect(percentToBps(0.01)).toBe(1);
    expect(percentToBps(33.33)).toBe(3_333);
  });

  it('rejects a precision finer than basis points can hold', () => {
    expect(() => percentToBps(15.005)).toThrow(/finer than 0\.01%/);
  });
});

describe('bpsToPercent and formatBps', () => {
  it('round-trips', () => {
    expect(bpsToPercent(toBps(1_500))).toBe(15);
    expect(bpsToPercent(toBps(1_525))).toBe(15.25);
  });

  it('formats without trailing zeros', () => {
    expect(formatBps(toBps(1_500))).toBe('15%');
    expect(formatBps(toBps(1_550))).toBe('15.5%');
    expect(formatBps(toBps(5_000))).toBe('50%');
    expect(formatBps(toBps(0))).toBe('0%');
  });
});

describe('parseRatePercent', () => {
  it('reads what a user types as a percentage', () => {
    expect(parseRatePercent('15')).toBe(1_500);
    expect(parseRatePercent('15%')).toBe(1_500);
    expect(parseRatePercent(' 15.5 % ')).toBe(1_550);
    expect(parseRatePercent(50)).toBe(5_000);
  });

  it('rejects blanks and junk', () => {
    expect(() => parseRatePercent('')).toThrow(/required/);
    expect(() => parseRatePercent('abc')).toThrow(/not a valid percentage/);
    expect(() => parseRatePercent('-5')).toThrow(/not a valid percentage/);
  });
});

describe('fromDatabaseBps', () => {
  it('accepts both shapes an integer column arrives in', () => {
    expect(fromDatabaseBps(1_500)).toBe(1_500);
    expect(fromDatabaseBps('1500')).toBe(1_500);
    expect(fromDatabaseBps(null)).toBeNull();
  });

  it('rejects a malformed value', () => {
    expect(() => fromDatabaseBps('15.5')).toThrow(/non-negative integer/);
  });
});
