/**
 * Interest and penalty rates, as integer basis points.
 *
 * A rate is stored and passed around as a whole number of basis points:
 *
 *   1 bp = 0.01%        100 bp = 1%        1 500 bp = 15%        5 000 bp = 50%
 *
 * ## Why basis points
 *
 * `0.15` cannot be represented exactly in binary floating point, so a decimal
 * rate introduces error before any money is even touched. An integer cannot.
 * Basis points also give one hundredth of a percent of resolution, which is
 * finer than any rate the business is likely to quote, and they store cleanly
 * in an `integer` column with a `CHECK` range.
 *
 * Rates live in `business_settings` and are snapshotted onto each loan at
 * origination, so changing the configured rate never rewrites history. The
 * calculation engine itself is Phase 3 — this module only defines the
 * representation and the conversions.
 *
 * See docs/DECISIONS.md (ADR-003).
 */

declare const bpsBrand: unique symbol;

/** A validated rate in integer basis points. */
export type BasisPoints = number & { readonly [bpsBrand]: 'bps' };

/** 100% expressed in basis points. */
export const BPS_PER_UNIT = 10_000;

/** One percent, in basis points. */
export const BPS_PER_PERCENT = 100;

/**
 * Upper bound on any configurable rate: 10 000% (1 000 000 bp).
 *
 * Deliberately generous — it is a sanity rail against a data-entry slip such
 * as typing basis points into a percent field, not a business policy. The
 * business's own limits live in `business_settings`.
 */
export const MAX_BPS = 1_000_000;

export class RateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateError';
  }
}

export function isBasisPoints(value: unknown): value is BasisPoints {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_BPS
  );
}

/**
 * Construct a `BasisPoints` from a whole number of basis points.
 *
 * @throws RateError if the value is not a whole number in `[0, MAX_BPS]`.
 */
export function toBps(value: number): BasisPoints {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RateError(`Rate must be a finite number, received ${String(value)}.`);
  }
  if (!Number.isInteger(value)) {
    throw new RateError(
      `Rate must be a whole number of basis points, received ${String(value)}. 15% is 1500, not 0.15.`,
    );
  }
  if (value < 0) {
    throw new RateError('Rate cannot be negative.');
  }
  if (value > MAX_BPS) {
    throw new RateError(
      `Rate ${String(value)} bp exceeds the maximum of ${String(MAX_BPS)} bp (${String(MAX_BPS / BPS_PER_PERCENT)}%).`,
    );
  }
  return value as BasisPoints;
}

/**
 * Convert a percentage to basis points: `15` → `1500`.
 *
 * Accepts up to two decimal places, since that is exactly the resolution basis
 * points provide. `15.005%` is rejected rather than rounded.
 *
 * @throws RateError on a value finer than 0.01%.
 */
export function percentToBps(percent: number): BasisPoints {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new RateError(
      `Percentage must be a finite number, received ${String(percent)}.`,
    );
  }

  const scaled = percent * BPS_PER_PERCENT;
  // Compare against a rounded value rather than testing Number.isInteger
  // directly: 15.01 * 100 is 1500.9999999999998 in binary floating point.
  const rounded = Math.round(scaled);

  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new RateError(
      `Percentage ${String(percent)}% is finer than 0.01% and cannot be represented in basis points.`,
    );
  }

  return toBps(rounded);
}

/** Convert basis points to a percentage for display: `1500` → `15`. */
export function bpsToPercent(bps: BasisPoints): number {
  return bps / BPS_PER_PERCENT;
}

/**
 * Format a rate for display, e.g. `15%` or `15.5%`.
 *
 * Trailing zeros are dropped, so `1500` renders as `15%` rather than `15.00%`.
 */
export function formatBps(
  bps: BasisPoints,
  options: { readonly locale?: string } = {},
): string {
  const { locale = 'en-UG' } = options;

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(bpsToPercent(bps))}%`;
}

/**
 * Parse a rate typed by a user: `15`, `15%`, `15.5 %`.
 *
 * The input is read as a **percentage**, because that is what staff type and
 * what the UI labels. Basis points are an internal representation.
 *
 * @throws RateError on anything unparseable.
 */
export function parseRatePercent(input: string | number): BasisPoints {
  if (typeof input === 'number') return percentToBps(input);

  const cleaned = input.trim().replace(/%$/, '').trim();

  if (cleaned === '') throw new RateError('Rate is required.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new RateError(`"${input}" is not a valid percentage.`);
  }

  return percentToBps(Number(cleaned));
}

/** Read a rate from an `integer` database column. */
export function fromDatabaseBps(value: number | string | null): BasisPoints | null {
  if (value === null) return null;

  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) {
      throw new RateError(`Database rate "${value}" is not a non-negative integer.`);
    }
    return toBps(Number(value.trim()));
  }

  return toBps(value);
}
