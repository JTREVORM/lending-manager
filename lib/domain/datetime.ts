/**
 * Date and time conventions.
 *
 * ## The rule
 *
 * **Instants are stored in UTC; business days are decided in Africa/Kampala.**
 *
 *   - Every `created_at` / `updated_at` / `occurred_at` column is
 *     `timestamptz`, which PostgreSQL stores as an absolute instant. Never
 *     `timestamp` (without time zone), which silently means "whatever zone the
 *     reader assumes".
 *   - Anything that is genuinely a calendar day — a loan start date, a
 *     repayment due date — is a `date` column, interpreted in the business
 *     timezone. A due date is "the 14th", not "the 14th at 00:00 UTC".
 *
 * ## Why this matters here
 *
 * Africa/Kampala is UTC+03:00 with no daylight saving, which makes the usual
 * DST traps absent but makes a different one easy to walk into: the three-hour
 * offset means `new Date().toISOString().slice(0, 10)` is the *previous* day
 * for the first three hours of every Kampala morning. A repayment recorded at
 * 08:00 Kampala would be filed against yesterday. Every "what day is it"
 * decision therefore goes through `businessToday()` or `toBusinessDate()`, and
 * never through the host's local timezone — servers run in UTC, staff do not.
 *
 * The offset is never hard-coded. `Intl.DateTimeFormat` resolves it from the
 * IANA database, so a future rule change is picked up by the platform.
 *
 * Repayment scheduling itself is Phase 3. This module provides the primitives
 * it will be built from.
 *
 * See docs/DECISIONS.md (ADR-004).
 */

import { BUSINESS_TIMEZONE, DEFAULT_LOCALE } from '@/config/app';

/**
 * A calendar date with no time component, as `YYYY-MM-DD`.
 *
 * Matches a PostgreSQL `date` column. Kept as a string rather than a `Date`
 * precisely because a `Date` always carries a time and a zone, which is how
 * off-by-one-day bugs get in.
 */
declare const businessDateBrand: unique symbol;
export type BusinessDate = string & { readonly [businessDateBrand]: 'date' };

export class DateTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateTimeError';
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Type guard for a well-formed, real calendar date in `YYYY-MM-DD` form. */
export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;

  // Reject impossible dates that still match the pattern, e.g. 2026-02-30.
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Construct a `BusinessDate` from a `YYYY-MM-DD` string.
 *
 * @throws DateTimeError if the string is not a real date in that format.
 */
export function toBusinessDate(value: string): BusinessDate {
  if (!isBusinessDate(value)) {
    throw new DateTimeError(
      `"${value}" is not a valid calendar date. Expected YYYY-MM-DD.`,
    );
  }
  return value;
}

/**
 * Cached formatter per timezone. `Intl.DateTimeFormat` construction is
 * comparatively expensive and these are called in loops when a schedule is
 * generated.
 */
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function getPartFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    partFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The calendar date an instant falls on **in the business timezone**.
 *
 * ```
 * // 2026-01-01T01:00:00Z is 04:00 on 1 January in Kampala, not 31 December.
 * instantToBusinessDate(new Date('2026-01-01T01:00:00Z')) // '2026-01-01'
 *
 * // 2025-12-31T20:00:00Z is 23:00 on 31 December in Kampala.
 * instantToBusinessDate(new Date('2025-12-31T20:00:00Z')) // '2025-12-31'
 *
 * // 2025-12-31T22:00:00Z has already rolled over to 01:00 on 1 January.
 * instantToBusinessDate(new Date('2025-12-31T22:00:00Z')) // '2026-01-01'
 * ```
 */
export function instantToBusinessDate(
  instant: Date,
  timeZone: string = BUSINESS_TIMEZONE,
): BusinessDate {
  if (Number.isNaN(instant.getTime())) {
    throw new DateTimeError('Cannot derive a business date from an invalid Date.');
  }

  // 'en-CA' yields YYYY-MM-DD, which is exactly the shape we want.
  return toBusinessDate(getPartFormatter(timeZone).format(instant));
}

/** Today's date in the business timezone. */
export function businessToday(
  now: Date = new Date(),
  timeZone: string = BUSINESS_TIMEZONE,
): BusinessDate {
  return instantToBusinessDate(now, timeZone);
}

/**
 * The two-digit year used in reference numbers, in the business timezone.
 *
 * `CL26001` — the `26` comes from here. The database function
 * `public.next_reference` derives the same value from `company_settings.timezone`
 * and remains the authority; this exists for client-side formatting and tests.
 */
export function businessReferenceYear(
  now: Date = new Date(),
  timeZone: string = BUSINESS_TIMEZONE,
): number {
  const date = instantToBusinessDate(now, timeZone);
  return Number(date.slice(2, 4));
}

/**
 * Add (or subtract, with a negative value) whole days to a business date.
 *
 * Pure calendar arithmetic via UTC, so it is unaffected by any host timezone
 * and cannot drift across a DST boundary in a zone that has one.
 */
export function addBusinessDays(date: BusinessDate, days: number): BusinessDate {
  if (!Number.isInteger(days)) {
    throw new DateTimeError(
      `Day offset must be a whole number, received ${String(days)}.`,
    );
  }

  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return toBusinessDate(shifted.toISOString().slice(0, 10));
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round(
    (businessDateToUtcMidnight(to).getTime() -
      businessDateToUtcMidnight(from).getTime()) /
      MS_PER_DAY,
  );
}

export function compareBusinessDates(a: BusinessDate, b: BusinessDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The UTC instant at midnight on a business date, for interval arithmetic.
 *
 * This is **not** the start of that day in Kampala — use `startOfBusinessDay`
 * for that. It is a canonical anchor for counting days.
 */
export function businessDateToUtcMidnight(date: BusinessDate): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

/** Cached offset formatter per timezone. */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The UTC offset of a timezone at a given instant, in minutes.
 *
 * Resolved from the IANA database rather than assumed, so the +03:00 that
 * Africa/Kampala happens to use today is never baked into the code.
 */
export function timezoneOffsetMinutes(
  instant: Date = new Date(),
  timeZone: string = BUSINESS_TIMEZONE,
): number {
  let formatter = offsetFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    });
    offsetFormatters.set(timeZone, formatter);
  }

  const part = formatter
    .formatToParts(instant)
    .find((candidate) => candidate.type === 'timeZoneName')?.value;

  if (part === undefined) {
    throw new DateTimeError(`Could not resolve the UTC offset for ${timeZone}.`);
  }

  // 'GMT+03:00', or plain 'GMT' at a zero offset.
  const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(part);
  if (match === null) {
    throw new DateTimeError(`Unexpected offset format "${part}" for ${timeZone}.`);
  }

  const [, sign, hours, minutes] = match;
  if (sign === undefined || hours === undefined || minutes === undefined) return 0;

  const magnitude = Number(hours) * 60 + Number(minutes);
  return sign === '-' ? -magnitude : magnitude;
}

/** The instant at which a business date begins in the business timezone. */
export function startOfBusinessDay(
  date: BusinessDate,
  timeZone: string = BUSINESS_TIMEZONE,
): Date {
  const utcMidnight = businessDateToUtcMidnight(date);

  // Two passes: the offset must be sampled near the target instant, because in
  // a zone with DST the offset at UTC midnight can differ from the offset at
  // local midnight.
  const firstPass = new Date(
    utcMidnight.getTime() - timezoneOffsetMinutes(utcMidnight, timeZone) * 60_000,
  );

  return new Date(
    utcMidnight.getTime() - timezoneOffsetMinutes(firstPass, timeZone) * 60_000,
  );
}

/** The instant immediately after a business date ends (exclusive upper bound). */
export function endOfBusinessDayExclusive(
  date: BusinessDate,
  timeZone: string = BUSINESS_TIMEZONE,
): Date {
  return startOfBusinessDay(addBusinessDays(date, 1), timeZone);
}

// ---------------------------------------------------------------------------
// Display formatting — always explicit about the timezone
// ---------------------------------------------------------------------------

/** `14 Jan 2026` */
export function formatBusinessDate(
  date: BusinessDate,
  options: { readonly locale?: string } = {},
): string {
  const { locale = DEFAULT_LOCALE } = options;

  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', // the date is already a calendar date; do not shift it
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(businessDateToUtcMidnight(date));
}

/**
 * Render a stored instant in the business timezone, e.g. `14 Jan 2026, 09:30`.
 *
 * The timezone is always passed explicitly. Omitting it would format in the
 * *server's* zone during SSR and the *viewer's* zone in the browser, so the
 * same record would show two different times.
 */
export function formatInstant(
  instant: Date | string,
  options: {
    readonly locale?: string;
    readonly timeZone?: string;
    readonly withTime?: boolean;
  } = {},
): string {
  const {
    locale = DEFAULT_LOCALE,
    timeZone = BUSINESS_TIMEZONE,
    withTime = true,
  } = options;

  const value = typeof instant === 'string' ? new Date(instant) : instant;

  if (Number.isNaN(value.getTime())) {
    throw new DateTimeError(`Cannot format invalid instant "${String(instant)}".`);
  }

  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(value);
}

/** Serialise an instant for a `timestamptz` column — always UTC ISO 8601. */
export function toDatabaseTimestamp(instant: Date = new Date()): string {
  if (Number.isNaN(instant.getTime())) {
    throw new DateTimeError('Cannot serialise an invalid Date.');
  }
  return instant.toISOString();
}
