/**
 * UGX money representation and arithmetic.
 *
 * ## The representation
 *
 * A monetary value in this system is **a whole number of Ugandan shillings**.
 * The business does not transact in fractions of a shilling, so there is no
 * minor unit to track: `100000` means UGX 100,000 exactly.
 *
 *   - In PostgreSQL: `bigint`, with a `CHECK (col >= 0)` where the column
 *     cannot be negative. Never `float`/`real`/`double precision`, and never
 *     `money` (which is locale-dependent).
 *   - In TypeScript: the branded type `UgxAmount`, which is a `number`
 *     constrained to safe, finite integers. The brand means a raw `number`
 *     cannot be passed where an amount is expected without going through
 *     `toUgx`, so an unvalidated or fractional value cannot leak into a
 *     calculation.
 *
 * ## Why not floats
 *
 * `0.1 + 0.2 !== 0.3`. Interest on a reducing balance is a long chain of
 * multiplications and subtractions, and float error accumulates into real
 * discrepancies between what the schedule says and what the books say. Every
 * operation here is integer-only. Where a product could exceed `2^53`
 * (`Number.MAX_SAFE_INTEGER`), the intermediate arithmetic is done in `BigInt`
 * and only the exact integer result is converted back.
 *
 * ## Rates
 *
 * Rates are **integer basis points** (`1 bp = 0.01%`), never decimals. 15% is
 * `1500`, 50% is `5000`. This keeps percentages exact and keeps the database
 * column an integer. See `lib/domain/rate.ts`.
 *
 * ## Rounding
 *
 * Every operation that cannot produce an exact integer takes an explicit
 * rounding mode. There is no hidden default inside a calculation: a caller
 * either accepts the documented `half-up` default at the call site or states
 * otherwise. `divideEvenly` exists so that splitting an amount across
 * installments loses nothing — the parts always sum back to the whole.
 *
 * See docs/DECISIONS.md (ADR-002).
 */

declare const ugxBrand: unique symbol;

/**
 * A validated whole number of Ugandan shillings.
 *
 * Construct with `toUgx` / `parseUgx`. The brand is erased at runtime; it
 * exists so the compiler refuses a bare `number`.
 */
export type UgxAmount = number & { readonly [ugxBrand]: 'UGX' };

/**
 * Largest amount accepted, UGX 1 quadrillion.
 *
 * Far above any plausible loan, far below `Number.MAX_SAFE_INTEGER`
 * (~9.007e15), which leaves headroom for sums and intermediate results to stay
 * exact in `number` form.
 */
export const MAX_UGX_AMOUNT = 1_000_000_000_000_000;

export const UGX_ZERO = 0 as UgxAmount;

/** How to resolve a value that falls between two whole shillings. */
export type RoundingMode =
  /** Nearest shilling; exact halves go away from zero. The conventional default. */
  | 'half-up'
  /** Nearest shilling; exact halves go to the even shilling (banker's rounding). */
  | 'half-even'
  /** Toward zero. Favours the payer. */
  | 'down'
  /** Away from zero. Favours the receiver. */
  | 'up';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Type guard: is this a safe, finite, whole shilling amount in range? */
export function isUgxAmount(value: unknown): value is UgxAmount {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Math.abs(value) <= MAX_UGX_AMOUNT
  );
}

/**
 * Construct a `UgxAmount` from a number.
 *
 * @throws MoneyError if the value is not a finite whole number within range.
 *   Fractional input is rejected rather than rounded: silently rounding an
 *   input is how money goes missing.
 */
export function toUgx(value: number): UgxAmount {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MoneyError(`Amount must be a finite number, received ${String(value)}.`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Amount must be a whole number of shillings, received ${String(value)}. Round explicitly with roundToShilling() if that is intended.`,
    );
  }
  if (Math.abs(value) > MAX_UGX_AMOUNT) {
    throw new MoneyError(
      `Amount ${String(value)} exceeds the maximum supported magnitude of ${String(MAX_UGX_AMOUNT)}.`,
    );
  }
  return value as UgxAmount;
}

/**
 * Parse user input into a `UgxAmount`.
 *
 * Accepts the shapes staff actually type: `100000`, `100,000`, `100 000`,
 * `UGX 100,000`, `100000.00`. A fractional part is permitted only when it is
 * zero, so `100000.00` parses and `100000.50` is rejected — there is no
 * half-shilling for it to become.
 *
 * @throws MoneyError on anything unparseable.
 */
export function parseUgx(input: string | number): UgxAmount {
  if (typeof input === 'number') return toUgx(input);

  const cleaned = input
    .trim()
    .replace(/^UGX\s*/i, '')
    .replace(/[,\s  ]/g, '');

  if (cleaned === '') {
    throw new MoneyError('Amount is required.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new MoneyError(`"${input}" is not a valid shilling amount.`);
  }

  const [whole = '0', fraction] = cleaned.split('.');

  if (fraction !== undefined && /[1-9]/.test(fraction)) {
    throw new MoneyError(
      `"${input}" includes a fraction of a shilling. Amounts must be whole shillings.`,
    );
  }

  const parsed = Number(whole);
  if (!Number.isSafeInteger(parsed)) {
    throw new MoneyError(`"${input}" is too large to represent exactly.`);
  }

  return toUgx(parsed);
}

/** Round an arbitrary number to a whole shilling using an explicit mode. */
export function roundToShilling(
  value: number,
  mode: RoundingMode = 'half-up',
): UgxAmount {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Cannot round non-finite value ${String(value)}.`);
  }

  let rounded: number;
  switch (mode) {
    case 'down':
      rounded = Math.trunc(value);
      break;
    case 'up':
      rounded = value < 0 ? Math.floor(value) : Math.ceil(value);
      break;
    case 'half-even': {
      const floor = Math.floor(value);
      const diff = value - floor;
      if (diff > 0.5) rounded = floor + 1;
      else if (diff < 0.5) rounded = floor;
      else rounded = floor % 2 === 0 ? floor : floor + 1;
      break;
    }
    case 'half-up':
      // Math.round sends -0.5 to -0 ("half up" toward +inf), which is not
      // symmetric. Round the magnitude and restore the sign.
      rounded = Math.sign(value) * Math.round(Math.abs(value));
      break;
  }

  return toUgx(rounded === 0 ? 0 : rounded);
}

export function addUgx(...amounts: readonly UgxAmount[]): UgxAmount {
  let total = 0;
  for (const amount of amounts) total += amount;
  return toUgx(total);
}

/** `minuend - subtrahend`. May be negative; the caller decides if that is valid. */
export function subtractUgx(minuend: UgxAmount, subtrahend: UgxAmount): UgxAmount {
  return toUgx(minuend - subtrahend);
}

export function sumUgx(amounts: readonly UgxAmount[]): UgxAmount {
  return addUgx(...amounts);
}

/**
 * Multiply an amount by a whole number — e.g. an installment by its count.
 *
 * Exact for any inputs this system accepts: the product is computed in
 * `BigInt` so it cannot silently lose precision.
 *
 * @throws MoneyError if `factor` is not an integer or the product is out of range.
 */
export function multiplyUgx(amount: UgxAmount, factor: number): UgxAmount {
  if (!Number.isInteger(factor)) {
    throw new MoneyError(
      `Factor must be a whole number, received ${String(factor)}. Use applyRateBps for percentages.`,
    );
  }
  const product = BigInt(amount) * BigInt(factor);
  return bigIntToUgx(product);
}

/**
 * Split an amount into `parts` whole-shilling pieces that sum **exactly** back
 * to the original.
 *
 * Integer division leaves a remainder of up to `parts - 1` shillings. Dropping
 * it would mean an installment schedule that does not add up to the loan, so
 * the remainder is distributed one shilling at a time, either onto the first
 * or the last installments.
 *
 * ```
 * divideEvenly(toUgx(100), 3)                     // [33, 33, 34]
 * divideEvenly(toUgx(100), 3, { remainder: 'first' }) // [34, 33, 33]
 * ```
 *
 * @throws MoneyError if `parts` is not a positive integer, or the amount is negative.
 */
export function divideEvenly(
  amount: UgxAmount,
  parts: number,
  options: { readonly remainder?: 'first' | 'last' } = {},
): readonly UgxAmount[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(
      `Parts must be a positive whole number, received ${String(parts)}.`,
    );
  }
  if (amount < 0) {
    throw new MoneyError('Cannot split a negative amount.');
  }

  const remainderPlacement = options.remainder ?? 'last';

  const total = BigInt(amount);
  const count = BigInt(parts);
  const base = Number(total / count);
  const remainder = Number(total % count);

  const result: UgxAmount[] = Array.from({ length: parts }, () => toUgx(base));

  for (let i = 0; i < remainder; i += 1) {
    const index = remainderPlacement === 'first' ? i : parts - 1 - i;
    // `index` is always within bounds: remainder < parts.
    result[index] = toUgx((result[index] ?? toUgx(base)) + 1);
  }

  return result;
}

/**
 * Apply a rate expressed in basis points: `amount × bps / 10_000`.
 *
 * The multiplication happens in `BigInt`, so `amount × bps` is exact even at
 * the top of the supported range. Only the final division is rounded, using
 * the mode the caller chooses.
 *
 * ```
 * applyRateBps(toUgx(100_000), 1_500)  // 15% → 15_000
 * applyRateBps(toUgx(333), 5_000)      // 50% of 333 → 167 (half-up)
 * ```
 *
 * @throws MoneyError if `bps` is not a non-negative integer.
 */
export function applyRateBps(
  amount: UgxAmount,
  bps: number,
  mode: RoundingMode = 'half-up',
): UgxAmount {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new MoneyError(
      `Basis points must be a non-negative whole number, received ${String(bps)}.`,
    );
  }

  const numerator = BigInt(amount) * BigInt(bps);
  return divideBigIntRounded(numerator, 10_000n, mode);
}

/** Compare two amounts. Returns -1, 0 or 1, suitable for `Array.prototype.sort`. */
export function compareUgx(a: UgxAmount, b: UgxAmount): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function minUgx(...amounts: readonly UgxAmount[]): UgxAmount {
  if (amounts.length === 0) throw new MoneyError('minUgx requires at least one amount.');
  return amounts.reduce((lowest, current) => (current < lowest ? current : lowest));
}

export function maxUgx(...amounts: readonly UgxAmount[]): UgxAmount {
  if (amounts.length === 0) throw new MoneyError('maxUgx requires at least one amount.');
  return amounts.reduce((highest, current) => (current > highest ? current : highest));
}

/** Constrain an amount to `[lower, upper]`. */
export function clampUgx(
  amount: UgxAmount,
  lower: UgxAmount,
  upper: UgxAmount,
): UgxAmount {
  if (lower > upper) {
    throw new MoneyError('Lower bound cannot exceed upper bound.');
  }
  return minUgx(maxUgx(amount, lower), upper);
}

export function isZeroUgx(amount: UgxAmount): boolean {
  return amount === 0;
}

export function isPositiveUgx(amount: UgxAmount): boolean {
  return amount > 0;
}

/**
 * Format an amount for display, e.g. `UGX 1,500,000`.
 *
 * No decimal places are shown, because there are none to show.
 */
export function formatUgx(
  amount: UgxAmount,
  options: {
    readonly locale?: string;
    readonly currencyCode?: string;
    /** `false` renders just the grouped number, for table cells. */
    readonly withCurrency?: boolean;
  } = {},
): string {
  const { locale = 'en-UG', currencyCode = 'UGX', withCurrency = true } = options;

  if (!withCurrency) {
    return new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(amount);
  }

  return (
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'code',
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    })
      .format(amount)
      // Intl inserts a non-breaking space after the code; normalise it so the
      // output is predictable in tests and in copied text.
      .replace(/ /g, ' ')
      .trim()
  );
}

/**
 * Convert a value read from a `bigint` database column.
 *
 * PostgREST serialises `bigint` as a JSON number, and the `pg` driver returns
 * it as a string. Both shapes are accepted, and both are validated: a value
 * that cannot be represented exactly is rejected rather than quietly truncated.
 */
export function fromDatabaseAmount(
  value: number | string | bigint | null,
): UgxAmount | null {
  if (value === null) return null;

  if (typeof value === 'bigint') return bigIntToUgx(value);

  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value.trim())) {
      throw new MoneyError(`Database amount "${value}" is not an integer.`);
    }
    return bigIntToUgx(BigInt(value.trim()));
  }

  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(
      `Database amount ${String(value)} cannot be represented exactly as a JavaScript integer.`,
    );
  }

  return toUgx(value);
}

/** Serialise an amount for a `bigint` column. */
export function toDatabaseAmount(amount: UgxAmount): number {
  return amount;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bigIntToUgx(value: bigint): UgxAmount {
  const limit = BigInt(MAX_UGX_AMOUNT);
  if (value > limit || value < -limit) {
    throw new MoneyError(
      `Amount ${value.toString()} exceeds the maximum supported magnitude of ${String(MAX_UGX_AMOUNT)}.`,
    );
  }
  return toUgx(Number(value));
}

/** Exact `BigInt` division with an explicit rounding mode. */
function divideBigIntRounded(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode,
): UgxAmount {
  if (denominator === 0n) throw new MoneyError('Division by zero.');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  let magnitude: bigint;
  if (remainder === 0n) {
    magnitude = quotient;
  } else {
    switch (mode) {
      case 'down':
        magnitude = quotient;
        break;
      case 'up':
        magnitude = quotient + 1n;
        break;
      case 'half-up':
        magnitude = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
        break;
      case 'half-even': {
        const twiceRemainder = remainder * 2n;
        if (twiceRemainder > absDenominator) magnitude = quotient + 1n;
        else if (twiceRemainder < absDenominator) magnitude = quotient;
        else magnitude = quotient % 2n === 0n ? quotient : quotient + 1n;
        break;
      }
    }
  }

  return bigIntToUgx(negative ? -magnitude : magnitude);
}
