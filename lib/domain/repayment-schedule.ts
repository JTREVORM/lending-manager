/**
 * The repayment schedule engine.
 *
 * Pure. No React, no Supabase, no database, no clock, no browser state — it
 * takes explicit inputs and returns explicit outputs, exactly like
 * `lib/domain/loan.ts`, and for the same reason: the schedule is a contractual
 * collection plan, and a date error or a one-shilling mismatch is a financial
 * defect rather than a cosmetic one.
 *
 * ## The contract and the collection plan are different things
 *
 * This is the distinction the whole module turns on.
 *
 *   - **`loan_periods`** is the *contract*: a month-by-month reducing-balance
 *     agreement. Period 2 of a UGX 200,000 loan at 15% is "UGX 115,000 falls
 *     due in the second month". It is frozen at approval and never recomputed.
 *
 *   - **The schedule** is the *collection plan*: how that UGX 115,000 is
 *     actually gathered, at a daily, two-day or three-day rhythm.
 *
 * So this engine never recalculates interest. It cannot — interest is already
 * contractually fixed, and recomputing it daily would be a different loan. All
 * it does is *allocate* each period's known principal and known interest
 * across the collection dates that fall inside that period's window.
 *
 * ## Which implementation is authoritative
 *
 * There are two implementations, mirroring the Phase 4 arrangement:
 * this one, and `public.generate_loan_schedule` in migration
 * `20261005000400`.
 *
 * **The database is authoritative.** It writes the rows, inside the
 * disbursement transaction, from `loans.disbursed_at`. This module exists for
 * the browser preview shown before disbursement and for exhaustive testing of
 * the rules in isolation. `tests/db/schedule-parity.test.ts` drives several
 * hundred cases through both and asserts identical output, installment by
 * installment, so a divergence fails a test rather than quoting a borrower one
 * date and collecting on another.
 *
 * ## Why there is no floating point anywhere
 *
 * Every amount is a whole number of shillings. Allocation goes through
 * `divideEvenly`, which divides in `BigInt` and distributes the remainder one
 * shilling at a time, so the parts sum back to the whole exactly. There is no
 * decimal literal, no `parseFloat`, and no division by a non-integer in this
 * file — `npm run audit:money` enforces that mechanically.
 *
 * ## Why there is no elapsed-millisecond arithmetic
 *
 * Dates are `BusinessDate` strings (`YYYY-MM-DD`) and move through
 * `addBusinessDays` / `addBusinessMonths`, which are calendar operations. A
 * cadence built by adding 86,400,000 milliseconds would be correct in Kampala
 * today and wrong in any zone that observes daylight saving — and "due on the
 * 14th" is a calendar fact, not an instant.
 */

import {
  addBusinessDays,
  addBusinessMonths,
  compareBusinessDates,
  daysBetween,
  instantToBusinessDate,
  toBusinessDate,
  type BusinessDate,
} from '@/lib/domain/datetime';
import { divideEvenly, sumUgx, toUgx, type UgxAmount } from '@/lib/domain/money';

/**
 * The most installments this engine will generate for one loan.
 *
 * Not a commercial limit. A sanity bound, so a corrupted interval or term
 * cannot ask for millions of rows: 120 months daily is 3,653, and this leaves
 * generous headroom above it.
 */
export const MAX_SUPPORTED_INSTALLMENTS = 5000;

/** Largest collection interval the engine accepts, matching the database. */
export const MAX_SUPPORTED_INTERVAL_DAYS = 365;

export class ScheduleGenerationError extends Error {
  /**
   * A machine-readable code, so the interface and the tests can identify which
   * rule fired without matching on a sentence somebody may later reword.
   */
  readonly code: ScheduleFailureCode;

  constructor(code: ScheduleFailureCode, message: string) {
    super(message);
    this.name = 'ScheduleGenerationError';
    this.code = code;
  }
}

export const SCHEDULE_FAILURE_CODES = [
  'no_periods',
  'invalid_interval',
  'invalid_disbursement_date',
  'period_has_no_installments',
  'too_many_installments',
  'month_anchor_undecided',
  'dates_not_increasing',
  'period_inconsistent',
  'reconciliation_failed',
] as const;

export type ScheduleFailureCode = (typeof SCHEDULE_FAILURE_CODES)[number];

// ---------------------------------------------------------------------------
// The cadence, and its two kinds
//
// Polytos Phase 3. A cadence is either a fixed number of days apart or one
// calendar month apart, and the second cannot be expressed as the first: a
// month is 28, 29, 30 or 31 days, so an `intervalDays = 30` cadence on a loan
// disbursed on 31 January would collect on 2 March, 1 April, 1 May — dates
// nobody agreed to, drifting a little further every month.
//
// The three fields below mirror `repayment_frequencies.cadence_kind`,
// `.interval_days` and `.month_anchor` exactly, so a row read out of that
// table maps straight onto a generation input and the validation here mirrors
// the CHECK constraints there.
// ---------------------------------------------------------------------------

export const REPAYMENT_CADENCE_KINDS = ['fixed_days', 'calendar_month'] as const;
export type RepaymentCadenceKind = (typeof REPAYMENT_CADENCE_KINDS)[number];

export function isRepaymentCadenceKind(value: unknown): value is RepaymentCadenceKind {
  return (
    typeof value === 'string' &&
    (REPAYMENT_CADENCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * What a monthly collection does when the agreed day of the month does not
 * exist in a later month.
 *
 * Both are implemented and **neither is a default**. The business has not
 * decided, `repayment_frequencies.month_anchor` is NULL until it does,
 * `generate_loan_schedule` refuses a calendar cadence with no anchor, and
 * `validate_loan_for_approval` refuses the approval a day earlier. See
 * ADR-059.
 */
export const MONTH_ANCHORS = [
  'clamp_to_month_end',
  'roll_forward_to_next_month',
] as const;
export type MonthAnchor = (typeof MONTH_ANCHORS)[number];

export function isMonthAnchor(value: unknown): value is MonthAnchor {
  return (
    typeof value === 'string' && (MONTH_ANCHORS as readonly string[]).includes(value)
  );
}

export const MONTH_ANCHOR_LABELS: Readonly<Record<MonthAnchor, string>> = {
  clamp_to_month_end: 'The last day of the month',
  roll_forward_to_next_month: 'The first day of the following month',
};

export const MONTH_ANCHOR_DESCRIPTIONS: Readonly<Record<MonthAnchor, string>> = {
  clamp_to_month_end:
    'A loan disbursed on 31 January collects on 28 February (29 in a leap year), ' +
    'then 31 March, 30 April, 31 May. The collection never falls in the following month.',
  roll_forward_to_next_month:
    'A loan disbursed on 31 January collects on 1 March, then 31 March, 1 May, ' +
    '31 May. The collection never falls earlier in the month than the day agreed.',
};

/**
 * The calendar-monthly collection date `months` after an anchor date.
 *
 * Mirrors `public.monthly_collection_date`, and a database test asserts the
 * two agree across every awkward date: 31 January in a leap year and a common
 * year, 29 and 30 January, 31 March, 31 December across the year boundary, and
 * an ordinary mid-month date that neither convention moves.
 *
 * `clamp_to_month_end` is what `addBusinessMonths` already does — it clamps to
 * the target month's last day and anchors on the original date rather than
 * stepping, so a February clamp does not drag the rest of the loan earlier.
 * It is also what PostgreSQL's `date + interval 'n months'` does, which is why
 * the two implementations agree without either imitating the other.
 */
export function monthlyCollectionDate(
  anchorDate: BusinessDate,
  months: number,
  anchor: MonthAnchor,
): BusinessDate {
  if (!Number.isInteger(months) || months < 1) {
    throw new ScheduleGenerationError(
      'invalid_interval',
      `A monthly collection step must be at least one month; received ${String(months)}.`,
    );
  }

  const clamped = addBusinessMonths(anchorDate, months);

  if (anchor === 'clamp_to_month_end') return clamped;

  // The clamp fired exactly when the target month is shorter than the anchor's
  // day of the month, which is visible as the day having changed. Nothing else
  // can change it: the day is preserved whenever the target month has one.
  if (anchorDate.slice(8, 10) === clamped.slice(8, 10)) return clamped;

  // The first day of the month after the one the clamp landed in. Derived from
  // the clamped date rather than from the anchor, so a run of short months
  // cannot be got wrong by arithmetic on the original day.
  const year = Number(clamped.slice(0, 4));
  const month = Number(clamped.slice(5, 7));
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return toBusinessDate(`${String(nextYear)}-${String(nextMonth).padStart(2, '0')}-01`);
}

/**
 * One contractual month, as the schedule engine needs to see it.
 *
 * A structural subset of `LoanPeriod` from `lib/domain/loan.ts`, so rows read
 * straight out of `loan_periods` satisfy it. Deliberately not the full type:
 * this engine has no business with opening and closing balances, and taking
 * only what it uses makes that visible.
 */
export interface SchedulePeriodInput {
  /** 1-based, matching `loan_periods.period_number`. */
  readonly periodNumber: number;
  /** The principal falling due in this contractual month. */
  readonly principalPortion: UgxAmount;
  /** The interest contractually fixed for this month. Never recomputed here. */
  readonly interest: UgxAmount;
  /** `principalPortion + interest`. Checked, not trusted. */
  readonly totalObligation: UgxAmount;
}

export interface ScheduleGenerationInput {
  /**
   * The calendar date, **in the business timezone**, on which the money
   * actually reached the borrower.
   *
   * Derived from `loans.disbursed_at`, never from
   * `loans.proposed_disbursement_date`: one is a plan that may have slipped,
   * the other is when the borrower took possession of the money. See
   * `disbursementBusinessDate`.
   */
  readonly disbursementDate: BusinessDate;

  /** The contractual monthly breakdown, in period order. */
  readonly periods: readonly SchedulePeriodInput[];

  /**
   * Days between consecutive collections: 1 daily, 2 every two days, 7 weekly.
   *
   * Required for a `fixed_days` cadence and refused for a `calendar_month`
   * one, where the step is a month rather than a number of days — the same
   * rule `repayment_frequencies_interval_matches_kind` states in the database.
   */
  readonly intervalDays?: number | null;

  /**
   * Which kind of cadence. Defaults to `fixed_days`, which is what every
   * schedule generated before Polytos Phase 3 was, so a caller passing only
   * `intervalDays` is unchanged.
   */
  readonly cadenceKind?: RepaymentCadenceKind;

  /**
   * For a calendar cadence, what a collection does in a month that has no such
   * day. Required there and refused for a fixed-day cadence.
   *
   * `null` is the state the business is actually in and is **refused**, naming
   * the decision: a guessed collection date is worse than no schedule.
   */
  readonly monthAnchor?: MonthAnchor | null;
}

/** One scheduled collection. Every amount is whole shillings. */
export interface ScheduledInstallment {
  /** 1-based across the whole loan. */
  readonly installmentNumber: number;
  /** The contractual month this collection belongs to. */
  readonly loanPeriodNumber: number;
  /** 1-based within that contractual month. */
  readonly periodInstallmentNumber: number;
  /** The calendar date the collection is due, in the business timezone. */
  readonly dueDate: BusinessDate;
  readonly scheduledPrincipal: UgxAmount;
  readonly scheduledInterest: UgxAmount;
  /** `scheduledPrincipal + scheduledInterest`. */
  readonly expectedAmount: UgxAmount;
}

/** The window a contractual month occupies on the calendar. */
export interface SchedulePeriodWindow {
  readonly periodNumber: number;
  /** Inclusive. */
  readonly startDate: BusinessDate;
  /** **Exclusive** — the next period's start. See the note on boundaries. */
  readonly endDateExclusive: BusinessDate;
  /** How many collections fall inside this window. Always at least one. */
  readonly installmentCount: number;
}

export interface RepaymentSchedule {
  readonly installments: readonly ScheduledInstallment[];
  readonly windows: readonly SchedulePeriodWindow[];
  readonly disbursementDate: BusinessDate;
  readonly cadenceKind: RepaymentCadenceKind;
  /** Null for a calendar cadence, where the step is a month. */
  readonly intervalDays: number | null;
  /** Null for a fixed-day cadence. */
  readonly monthAnchor: MonthAnchor | null;
  /** The first collection date. One interval after disbursement. */
  readonly firstDueDate: BusinessDate;
  /**
   * The last collection date — the loan's scheduled completion date.
   *
   * Phase 7 builds loan expiry, grace periods and penalties on this, which is
   * why it is derived from the final installment rather than approximated as
   * "disbursement plus the term". Those differ: a three-month loan disbursed
   * on 10 October has its final collection on 7 January, not 10 January,
   * because 10 January is the exclusive boundary of the third month.
   */
  readonly finalDueDate: BusinessDate;
  readonly totalScheduledPrincipal: UgxAmount;
  readonly totalScheduledInterest: UgxAmount;
  /** Must equal the loan's `total_expected_repayment`. Asserted. */
  readonly totalScheduledAmount: UgxAmount;
}

/**
 * Generate a loan's collection schedule.
 *
 * ## The date rules, in one place
 *
 * **Period windows.** Contractual month *n* occupies
 * `[disbursement + (n-1) months, disbursement + n months)` — start inclusive,
 * end exclusive. Exclusive is what stops a single calendar date belonging to
 * two adjacent months, which would otherwise put two collections on one day
 * or, worse, make the same date mean different things in two places.
 *
 * Both boundaries are anchored on the disbursement date rather than stepped
 * from the previous boundary, so a February clamp does not drag every later
 * month earlier. See `addBusinessMonths`.
 *
 * **First collection.** One interval *after* disbursement, never on the
 * disbursement date itself — the borrower receives the money and the first
 * collection follows:
 *
 * | Frequency | Disbursed | First due |
 * | --- | --- | --- |
 * | Daily | 10 Oct | 11 Oct |
 * | Every 2 days | 10 Oct | 12 Oct |
 * | Every 3 days | 10 Oct | 13 Oct |
 *
 * **The cadence.** Collections fall on `disbursement + k × interval` for
 * k = 1, 2, 3, … Each is assigned to the one window that contains it, and the
 * cadence stops at the final period's exclusive boundary. Building one global
 * cadence and then *assigning* it — rather than restarting the rhythm inside
 * each month — is what guarantees the dates are strictly increasing, never
 * duplicated, and never spilled past the contract, without any of those having
 * to be arranged separately.
 *
 * It also means a month can receive a different number of collections than its
 * neighbours, which is correct: February is shorter than March. Nothing here
 * assumes 30 days, and nothing assumes daily means 30 installments.
 *
 * ## The money rules
 *
 * Each window's collections split that month's **own** principal and **own**
 * interest, via `divideEvenly`, with any remainder landing on the final
 * collection of that same month. A remainder never crosses into another month:
 * each contractual month reconciles independently to its own obligation, which
 * is what keeps the schedule an allocation of the contract rather than a
 * restatement of it.
 *
 * @throws ScheduleGenerationError if any period would receive no collection,
 *   if the inputs are inconsistent, or if the result fails to reconcile.
 */
export function generateRepaymentSchedule(
  input: ScheduleGenerationInput,
): RepaymentSchedule {
  const { disbursementDate, periods } = input;
  const cadenceKind = input.cadenceKind ?? 'fixed_days';

  // --- Input validation ----------------------------------------------------
  // Refused rather than coerced. Every one of these would otherwise produce a
  // schedule that looks plausible and is wrong.
  if (periods.length === 0) {
    throw new ScheduleGenerationError(
      'no_periods',
      'A repayment schedule needs the contractual monthly breakdown; none was supplied.',
    );
  }

  // --- The cadence, resolved once -----------------------------------------
  // The same pairing the database states as two CHECK constraints: an
  // interval is required where it means something and refused where it does
  // not, and likewise an anchor. Stated here too rather than trusted from the
  // row, because a caller reading from an untyped source can get either past
  // the compiler.
  let intervalDays: number | null = null;
  let monthAnchor: MonthAnchor | null = null;

  if (cadenceKind === 'fixed_days') {
    if (input.monthAnchor !== undefined && input.monthAnchor !== null) {
      throw new ScheduleGenerationError(
        'invalid_interval',
        'A fixed-day cadence has no monthly collection anchor: the step is a number of days.',
      );
    }

    const supplied = input.intervalDays;

    if (
      !Number.isInteger(supplied) ||
      supplied === null ||
      supplied === undefined ||
      supplied < 1
    ) {
      throw new ScheduleGenerationError(
        'invalid_interval',
        `A collection interval must be a positive whole number of days, received ${String(supplied)}.`,
      );
    }

    if (supplied > MAX_SUPPORTED_INTERVAL_DAYS) {
      throw new ScheduleGenerationError(
        'invalid_interval',
        `A collection interval of ${String(supplied)} days is beyond the supported range of ${String(MAX_SUPPORTED_INTERVAL_DAYS)}.`,
      );
    }

    intervalDays = supplied;
  } else {
    if (input.intervalDays !== undefined && input.intervalDays !== null) {
      throw new ScheduleGenerationError(
        'invalid_interval',
        'A calendar-monthly cadence has no collection interval in days: the step is a month.',
      );
    }

    // Fail shut, and name the decision. This is the state the business is in
    // today, so it is the branch that actually runs — and a guessed collection
    // date would put a day on a borrower's agreement that no person chose.
    if (input.monthAnchor === undefined || input.monthAnchor === null) {
      throw new ScheduleGenerationError(
        'month_anchor_undecided',
        'A calendar-monthly schedule needs the convention for a month that has no such ' +
          'day, and the business has not decided it. Set the monthly collection anchor ' +
          'on the calendar cadence first.',
      );
    }

    monthAnchor = input.monthAnchor;
  }

  // `toBusinessDate` already rejects a malformed or impossible date, but a
  // caller reading from an untyped source can still get a branded value past
  // the compiler, so the shape is checked here too.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(disbursementDate)) {
    throw new ScheduleGenerationError(
      'invalid_disbursement_date',
      `"${String(disbursementDate)}" is not a calendar date in YYYY-MM-DD form.`,
    );
  }

  periods.forEach((period, index) => {
    if (period.periodNumber !== index + 1) {
      throw new ScheduleGenerationError(
        'period_inconsistent',
        `Contractual periods must arrive in order starting at 1; found ${String(period.periodNumber)} at position ${String(index + 1)}.`,
      );
    }

    if (period.principalPortion < 0 || period.interest < 0) {
      throw new ScheduleGenerationError(
        'period_inconsistent',
        `Contractual period ${String(period.periodNumber)} carries a negative amount.`,
      );
    }

    // The contract's own identity, checked rather than trusted. These rows may
    // have come from the database, and a breakdown that fails this is not a
    // rounding disagreement — it is corruption.
    if (period.totalObligation !== period.principalPortion + period.interest) {
      throw new ScheduleGenerationError(
        'period_inconsistent',
        `Contractual period ${String(period.periodNumber)} has an obligation of ${String(period.totalObligation)}, which is not its principal plus its interest.`,
      );
    }
  });

  // --- The period windows --------------------------------------------------
  // Anchored on the disbursement date, every one of them.
  const bounds: BusinessDate[] = [disbursementDate];
  for (let month = 1; month <= periods.length; month += 1) {
    bounds.push(addBusinessMonths(disbursementDate, month));
  }

  const finalBoundary = bounds[periods.length];

  /* c8 ignore next 6 -- unreachable: bounds is built with periods.length + 1 entries. */
  if (finalBoundary === undefined) {
    throw new ScheduleGenerationError(
      'period_inconsistent',
      'The contractual period windows could not be determined.',
    );
  }

  // --- The cadence ---------------------------------------------------------
  const datesByPeriod: BusinessDate[][] = periods.map(() => []);

  if (cadenceKind === 'calendar_month') {
    // One collection per contractual month, due at that month's end, carrying
    // that month's whole obligation.
    //
    // Deliberately **not** run through the window assignment below, and the
    // reason is worth stating because the first attempt at this looked like it
    // could be. The natural monthly collection date for contractual month n is
    // `D + n months` — which is precisely the *exclusive end* of month n's
    // window and therefore inside month n+1's. Assigned through the windows,
    // month 1's collection would land in month 2, month 1 would get nothing,
    // and the zero-installment guard would fire on every monthly loan ever
    // written.
    //
    // One collection per contractual month is also what the business
    // described: a five-month member loan collecting monthly is five
    // collections.
    for (const [index] of periods.entries()) {
      const bucket = datesByPeriod[index];

      /* c8 ignore next 3 -- unreachable: datesByPeriod is built from periods. */
      if (bucket === undefined) continue;

      // Non-null in this branch by the resolution above; the local binding is
      // what tells the compiler so without a non-null assertion.
      const anchorRule: MonthAnchor = monthAnchor ?? 'clamp_to_month_end';

      bucket.push(monthlyCollectionDate(disbursementDate, index + 1, anchorRule));
    }

    // Strictly increasing, asserted rather than reasoned about. Both
    // conventions are monotonic — a roll-forward lands on the 1st of a month
    // the next collection falls later in — but a collection sheet that went
    // backwards would be a contractual defect, and the check costs one pass
    // over at most 120 dates.
    const flat = datesByPeriod.flat();

    for (let index = 1; index < flat.length; index += 1) {
      const previous = flat[index - 1];
      const current = flat[index];

      /* c8 ignore next 3 -- unreachable: index is bounded by flat.length. */
      if (previous === undefined || current === undefined) continue;

      if (compareBusinessDates(current, previous) <= 0) {
        throw new ScheduleGenerationError(
          'dates_not_increasing',
          `Collection ${String(index + 1)} falls on ${String(current)}, on or before ` +
            `collection ${String(index)} on ${String(previous)}, under the ` +
            `"${monthAnchor}" anchor.`,
        );
      }
    }
  } else {
    // One global rhythm from the disbursement date, stopping strictly before
    // the final contractual boundary.
    //
    // `intervalDays` is non-null in this branch by the resolution above; the
    // local binding is what tells the compiler so without a non-null
    // assertion.
    const step_days = intervalDays ?? 1;

    const totalDays = daysBetween(disbursementDate, finalBoundary);
    const upperBound = Math.floor(totalDays / step_days);

    if (upperBound > MAX_SUPPORTED_INSTALLMENTS) {
      throw new ScheduleGenerationError(
        'too_many_installments',
        `This loan would generate ${String(upperBound)} collections, beyond the supported maximum of ${String(MAX_SUPPORTED_INSTALLMENTS)}.`,
      );
    }

    const cadence: BusinessDate[] = [];
    for (let step = 1; step <= upperBound; step += 1) {
      const dueDate = addBusinessDays(disbursementDate, step * step_days);

      // `upperBound` is a floor, so the last candidate can land exactly on the
      // boundary when the term divides evenly by the interval. Excluded,
      // because the boundary belongs to the month that has not started.
      if (compareBusinessDates(dueDate, finalBoundary) >= 0) break;

      cadence.push(dueDate);
    }

    // --- Assign each collection to its contractual month -------------------
    let cursor = 0;

    for (const [index] of periods.entries()) {
      const windowEnd = bounds[index + 1];

      /* c8 ignore next 3 -- unreachable: bounds has an entry per period. */
      if (windowEnd === undefined) continue;

      const bucket = datesByPeriod[index];

      /* c8 ignore next 3 -- unreachable: datesByPeriod is built from periods. */
      if (bucket === undefined) continue;

      // The cadence is sorted, so a single forward pass places every date.
      while (cursor < cadence.length) {
        const candidate = cadence[cursor];

        /* c8 ignore next 3 -- unreachable: cursor is bounded by cadence.length. */
        if (candidate === undefined) break;

        if (compareBusinessDates(candidate, windowEnd) >= 0) break;

        bucket.push(candidate);
        cursor += 1;
      }
    }
  }

  // --- The zero-installment guard -----------------------------------------
  //
  // A contractual month with nowhere to collect is unreachable with the
  // frequencies the business offers — the shortest calendar month is 28 days
  // and the longest interval offered is three. But it is reachable if an
  // administrator configures a 40-day cadence, and the failure mode without
  // this guard is a division by zero or, worse, an active loan carrying a
  // month of obligation that no collection ever gathers.
  //
  // So it fails loudly, and because generation runs inside the disbursement
  // transaction the whole disbursement rolls back with it. A loan that cannot
  // be collected is not disbursed.
  for (const [index, dates] of datesByPeriod.entries()) {
    if (dates.length === 0) {
      const period = periods[index];
      const windowStart = bounds[index];
      const windowEnd = bounds[index + 1];

      throw new ScheduleGenerationError(
        'period_has_no_installments',
        `Contractual month ${String(period?.periodNumber ?? index + 1)} ` +
          `(${String(windowStart)} to ${String(windowEnd)}, exclusive) would receive no ` +
          `collection at ${
            cadenceKind === 'calendar_month'
              ? 'a calendar-monthly cadence'
              : `an interval of ${String(intervalDays)} days`
          }. The repayment frequency is too infrequent for this loan's contractual months.`,
      );
    }
  }

  // --- Allocate the money -------------------------------------------------
  const installments: ScheduledInstallment[] = [];
  const windows: SchedulePeriodWindow[] = [];
  let installmentNumber = 0;

  for (const [index, period] of periods.entries()) {
    const dates = datesByPeriod[index] ?? [];
    const windowStart = bounds[index];
    const windowEnd = bounds[index + 1];

    /* c8 ignore next 3 -- unreachable: bounds has an entry per period plus one. */
    if (windowStart === undefined || windowEnd === undefined) continue;

    // Each month's own figures, split across that month's own collections.
    // Remainder on the last collection of this month, so the remainder never
    // leaves the month that produced it.
    const principalParts = divideEvenly(period.principalPortion, dates.length, {
      remainder: 'last',
    });
    const interestParts = divideEvenly(period.interest, dates.length, {
      remainder: 'last',
    });

    for (const [position, dueDate] of dates.entries()) {
      const scheduledPrincipal = principalParts[position] ?? toUgx(0);
      const scheduledInterest = interestParts[position] ?? toUgx(0);

      installmentNumber += 1;

      installments.push({
        installmentNumber,
        loanPeriodNumber: period.periodNumber,
        periodInstallmentNumber: position + 1,
        dueDate,
        scheduledPrincipal,
        scheduledInterest,
        expectedAmount: toUgx(scheduledPrincipal + scheduledInterest),
      });
    }

    windows.push({
      periodNumber: period.periodNumber,
      startDate: windowStart,
      endDateExclusive: windowEnd,
      installmentCount: dates.length,
    });
  }

  const firstInstallment = installments[0];
  const lastInstallment = installments.at(-1);

  /* c8 ignore next 6 -- unreachable: the zero-installment guard above ran. */
  if (firstInstallment === undefined || lastInstallment === undefined) {
    throw new ScheduleGenerationError(
      'period_has_no_installments',
      'The schedule generated no collections.',
    );
  }

  const schedule: RepaymentSchedule = {
    installments,
    windows,
    disbursementDate,
    cadenceKind,
    intervalDays,
    monthAnchor,
    firstDueDate: firstInstallment.dueDate,
    finalDueDate: lastInstallment.dueDate,
    totalScheduledPrincipal: sumUgx(
      installments.map((installment) => installment.scheduledPrincipal),
    ),
    totalScheduledInterest: sumUgx(
      installments.map((installment) => installment.scheduledInterest),
    ),
    totalScheduledAmount: sumUgx(
      installments.map((installment) => installment.expectedAmount),
    ),
  };

  // Checked on every call rather than only in tests, for the Phase 4 reason:
  // the cost is a few additions, and the alternative is a wrong collection
  // amount reaching a borrower because some future change broke an invariant
  // nobody re-ran.
  assertScheduleInvariants(schedule, periods);

  return schedule;
}

/**
 * Every invariant a schedule must satisfy.
 *
 * Exported so the database parity test and the integration tests can apply
 * exactly these checks to installments that did **not** come from
 * `generateRepaymentSchedule` — including rows read back out of PostgreSQL. A
 * stored schedule that fails one of these is caught at the point it is read
 * rather than believed.
 *
 * @throws ScheduleGenerationError naming the first invariant that fails.
 */
export function assertScheduleInvariants(
  schedule: RepaymentSchedule,
  periods: readonly SchedulePeriodInput[],
): void {
  const { installments, disbursementDate } = schedule;

  const fail = (code: ScheduleFailureCode, message: string): never => {
    throw new ScheduleGenerationError(code, `Schedule invariant violated: ${message}`);
  };

  if (installments.length === 0) {
    fail('period_has_no_installments', 'the schedule has no collections.');
  }

  // --- Money conservation, checked first ----------------------------------
  //
  // Before the per-installment walk, following the Phase 4 lesson: the walk
  // implies much of the conservation arithmetic, so conservation checked
  // afterwards could never fire and would be protection in name only.
  // Checking it first also makes the error the useful one — "period 2
  // principal sums to 99,999, not 100,000" names a lost shilling directly.
  for (const period of periods) {
    const forPeriod = installments.filter(
      (installment) => installment.loanPeriodNumber === period.periodNumber,
    );

    if (forPeriod.length === 0) {
      fail(
        'period_has_no_installments',
        `contractual month ${String(period.periodNumber)} has no collections.`,
      );
    }

    const principal = forPeriod.reduce(
      (total, installment) => total + installment.scheduledPrincipal,
      0,
    );

    if (principal !== period.principalPortion) {
      fail(
        'reconciliation_failed',
        `contractual month ${String(period.periodNumber)} allocates principal of ${String(principal)}, not ${String(period.principalPortion)}.`,
      );
    }

    const interest = forPeriod.reduce(
      (total, installment) => total + installment.scheduledInterest,
      0,
    );

    if (interest !== period.interest) {
      fail(
        'reconciliation_failed',
        `contractual month ${String(period.periodNumber)} allocates interest of ${String(interest)}, not ${String(period.interest)}.`,
      );
    }

    const expected = forPeriod.reduce(
      (total, installment) => total + installment.expectedAmount,
      0,
    );

    if (expected !== period.totalObligation) {
      fail(
        'reconciliation_failed',
        `contractual month ${String(period.periodNumber)} collects ${String(expected)}, not its contractual obligation of ${String(period.totalObligation)}.`,
      );
    }
  }

  const contractTotal = periods.reduce(
    (total, period) => total + period.totalObligation,
    0,
  );

  if (schedule.totalScheduledAmount !== contractTotal) {
    fail(
      'reconciliation_failed',
      `the schedule collects ${String(schedule.totalScheduledAmount)} against a contractual total of ${String(contractTotal)}.`,
    );
  }

  const summedPrincipal = installments.reduce(
    (total, installment) => total + installment.scheduledPrincipal,
    0,
  );
  const summedInterest = installments.reduce(
    (total, installment) => total + installment.scheduledInterest,
    0,
  );

  if (summedPrincipal !== schedule.totalScheduledPrincipal) {
    fail(
      'reconciliation_failed',
      'the reported total principal is not the sum of parts.',
    );
  }

  if (summedInterest !== schedule.totalScheduledInterest) {
    fail('reconciliation_failed', 'the reported total interest is not the sum of parts.');
  }

  if (
    schedule.totalScheduledAmount !==
    schedule.totalScheduledPrincipal + schedule.totalScheduledInterest
  ) {
    fail(
      'reconciliation_failed',
      'the total scheduled amount is not principal plus interest.',
    );
  }

  // --- Then the installment-by-installment walk ---------------------------
  const periodCounters = new Map<number, number>();
  let previousDueDate: BusinessDate | null = null;

  for (const [index, installment] of installments.entries()) {
    const label = `installment ${String(installment.installmentNumber)}`;

    if (installment.installmentNumber !== index + 1) {
      fail('period_inconsistent', `${label} is out of sequence.`);
    }

    if (installment.expectedAmount < 0) {
      fail('reconciliation_failed', `${label} expects a negative amount.`);
    }

    if (installment.scheduledPrincipal < 0 || installment.scheduledInterest < 0) {
      fail('reconciliation_failed', `${label} carries a negative component.`);
    }

    if (
      installment.expectedAmount !==
      installment.scheduledPrincipal + installment.scheduledInterest
    ) {
      fail(
        'reconciliation_failed',
        `${label} expects ${String(installment.expectedAmount)}, which is not its principal plus its interest.`,
      );
    }

    // Nothing is collectable on or before the day the money changed hands.
    if (compareBusinessDates(installment.dueDate, disbursementDate) <= 0) {
      fail(
        'period_inconsistent',
        `${label} falls due on ${installment.dueDate}, which is not after disbursement on ${disbursementDate}.`,
      );
    }

    // Strictly increasing, which covers "no duplicates" in the same stroke.
    if (previousDueDate !== null) {
      if (compareBusinessDates(installment.dueDate, previousDueDate) <= 0) {
        fail(
          'period_inconsistent',
          `${label} falls due on ${installment.dueDate}, which does not follow ${previousDueDate}.`,
        );
      }
    }

    previousDueDate = installment.dueDate;

    const nextPosition = (periodCounters.get(installment.loanPeriodNumber) ?? 0) + 1;

    if (installment.periodInstallmentNumber !== nextPosition) {
      fail(
        'period_inconsistent',
        `${label} is numbered ${String(installment.periodInstallmentNumber)} within its contractual month, where ${String(nextPosition)} was expected.`,
      );
    }

    periodCounters.set(installment.loanPeriodNumber, nextPosition);

    // Inside the right window: at or after its own month's start, strictly
    // before the next month's.
    const windowStart = addBusinessMonths(
      disbursementDate,
      installment.loanPeriodNumber - 1,
    );
    const windowEnd = addBusinessMonths(disbursementDate, installment.loanPeriodNumber);

    if (compareBusinessDates(installment.dueDate, windowStart) < 0) {
      fail(
        'period_inconsistent',
        `${label} falls due on ${installment.dueDate}, before its contractual month opens on ${windowStart}.`,
      );
    }

    // Polytos Phase 3. A fixed-day collection falls strictly *inside* its
    // contractual month, which is what makes a date belong to exactly one
    // month. A calendar-monthly collection falls at that month's **close** —
    // `D + n months` is the window's exclusive end — or, under the
    // roll-forward convention, just after it. That is not a date landing in
    // the wrong month: it is a month's obligation being collected at the end
    // of the month, which is what "monthly collection" means. So the two
    // cadences are checked against different statements of the same intent,
    // and the calendar one is held to its own: exactly one collection, on or
    // after the month's close, and never later than the close of the month
    // after it.
    if (schedule.cadenceKind === 'fixed_days') {
      if (compareBusinessDates(installment.dueDate, windowEnd) >= 0) {
        fail(
          'period_inconsistent',
          `${label} falls due on ${installment.dueDate}, on or after its contractual month closes on ${windowEnd}.`,
        );
      }
    } else {
      if (installment.periodInstallmentNumber !== 1) {
        fail(
          'period_inconsistent',
          `${label} is collection ${String(installment.periodInstallmentNumber)} of its contractual month, and a calendar-monthly cadence collects each month exactly once.`,
        );
      }

      if (compareBusinessDates(installment.dueDate, windowEnd) < 0) {
        fail(
          'period_inconsistent',
          `${label} falls due on ${installment.dueDate}, before its contractual month closes on ${windowEnd}; a calendar-monthly collection gathers the month that has just ended.`,
        );
      }

      const nextWindowEnd = addBusinessMonths(
        disbursementDate,
        installment.loanPeriodNumber + 1,
      );

      if (compareBusinessDates(installment.dueDate, nextWindowEnd) >= 0) {
        fail(
          'period_inconsistent',
          `${label} falls due on ${installment.dueDate}, a whole month or more after its own month closed on ${windowEnd}.`,
        );
      }
    }
  }

  // The cadence itself: the first collection is exactly one step after
  // disbursement, which is the documented first-payment rule — one interval
  // for a fixed-day cadence, one month for a calendar one.
  const expectedFirst =
    schedule.cadenceKind === 'calendar_month'
      ? monthlyCollectionDate(
          disbursementDate,
          1,
          schedule.monthAnchor ?? 'clamp_to_month_end',
        )
      : addBusinessDays(disbursementDate, schedule.intervalDays ?? 1);

  if (schedule.firstDueDate !== expectedFirst) {
    fail(
      'period_inconsistent',
      `the first collection is ${schedule.firstDueDate}, where one step after disbursement is ${expectedFirst}.`,
    );
  }
}

/**
 * The collection window of a single contractual month.
 *
 * Exposed so the interface can explain which dates belong to which month
 * without re-deriving the boundary rule and risking a different answer.
 */
export function periodWindow(
  disbursementDate: BusinessDate,
  periodNumber: number,
): { readonly startDate: BusinessDate; readonly endDateExclusive: BusinessDate } {
  if (!Number.isInteger(periodNumber) || periodNumber < 1) {
    throw new ScheduleGenerationError(
      'period_inconsistent',
      `A contractual month is 1-based, received ${String(periodNumber)}.`,
    );
  }

  return {
    startDate: addBusinessMonths(disbursementDate, periodNumber - 1),
    endDateExclusive: addBusinessMonths(disbursementDate, periodNumber),
  };
}

// ---------------------------------------------------------------------------
// What can honestly be said about an installment before payments exist
// ---------------------------------------------------------------------------

/**
 * The state of a scheduled collection, **derived from the calendar alone**.
 *
 * ## Why there is no stored status column, and no `paid` or `missed`
 *
 * Phase 5 knows what is due and when. It knows nothing whatever about what has
 * been collected, because nothing posts payments yet. So the only states it
 * can describe truthfully are positions of a date relative to today:
 *
 *   - `upcoming` — the due date is in the future.
 *   - `due_today` — the due date is today, in the business timezone.
 *   - `elapsed` — the due date has passed.
 *
 * `elapsed` says **the date has passed and nothing more**. It is emphatically
 * not `missed` or `overdue`: either of those would assert that no payment
 * arrived, which is a claim about payment data this phase does not have. A
 * borrower who paid on time would be shown as delinquent by a label this
 * phase has no standing to apply.
 *
 * For the same reason the status is *derived* rather than stored. A stored
 * column would have exactly one possible value, `scheduled` — no information
 * that "the row exists" does not already carry — while inviting a later phase
 * to UPDATE it, which would breach the append-only guarantee that makes the
 * schedule evidence. Phase 6 introduces payment-derived state in its own
 * structures, leaving the original installment row untouched. See
 * docs/DECISIONS.md (ADR-026).
 */
export const INSTALLMENT_DATE_STATES = ['upcoming', 'due_today', 'elapsed'] as const;

export type InstallmentDateState = (typeof INSTALLMENT_DATE_STATES)[number];

export const INSTALLMENT_DATE_STATE_LABELS: Readonly<
  Record<InstallmentDateState, string>
> = {
  upcoming: 'Upcoming',
  due_today: 'Due today',
  // Deliberately not "Missed" or "Overdue". It states the calendar fact and
  // claims nothing about payment.
  elapsed: 'Date passed',
};

/** Where a due date sits relative to today. Nothing about payment. */
export function installmentDateState(
  dueDate: BusinessDate,
  today: BusinessDate,
): InstallmentDateState {
  const comparison = compareBusinessDates(dueDate, today);

  if (comparison > 0) return 'upcoming';
  if (comparison === 0) return 'due_today';
  return 'elapsed';
}

/**
 * The calendar date, in the business timezone, that a disbursement counts as.
 *
 * ## Why this is not `disbursedAt.toISOString().slice(0, 10)`
 *
 * Africa/Kampala is UTC+03:00. A disbursement stamped `2026-10-10T22:30:00Z`
 * happened at 01:30 on **11 October** in Kampala, and a schedule anchored on
 * 10 October would put every collection on the wrong side of the calendar by a
 * day. Conversely a disbursement at 02:00 UTC is still the previous evening
 * nowhere — Kampala is ahead, not behind — but the general rule has to be
 * applied rather than reasoned about per case, so the conversion always goes
 * through the business timezone.
 *
 * The database does the same conversion, from `company_settings.timezone`, so
 * the two generators anchor on the same day.
 */
export function disbursementBusinessDate(
  disbursedAt: Date | string,
  timeZone?: string,
): BusinessDate {
  const instant = typeof disbursedAt === 'string' ? new Date(disbursedAt) : disbursedAt;

  return timeZone === undefined
    ? instantToBusinessDate(instant)
    : instantToBusinessDate(instant, timeZone);
}
