/**
 * Delinquency: what should have been paid by now and has not been.
 *
 * ## The four concepts, kept apart on purpose
 *
 * The specification is emphatic that these are different figures, and
 * conflating any two of them produces a number nobody can act on:
 *
 *   * **the schedule** says what the borrower agreed to pay and when
 *     (Phase 5, immutable);
 *   * **the payments** say what money actually arrived (Phase 6);
 *   * **the allocations** say which obligations that money satisfied (Phase 6);
 *   * **delinquency** — this module — says what should have been satisfied by
 *     now and has not been.
 *
 * Nothing here writes anything. Every function takes the obligations and a
 * business date and returns a number. That is what makes a loan appear in
 * arrears because the calendar and the ledger say so, rather than because a
 * nightly job ran and set a column.
 *
 * ## Why the carried-forward amount is not a schedule change
 *
 * The business rule is that a missed UGX 4,000 Monday makes Tuesday's
 * operational demand UGX 8,000. It is tempting to implement that by rewriting
 * Tuesday's row, and that would destroy the only record of what was actually
 * agreed for each day — in precisely the dispute the record exists for.
 *
 * So Monday stays UGX 4,000, Tuesday stays UGX 4,000, and the UGX 8,000 is
 * `currentDue`: a derived sum of what is uncovered on or before today. Miss
 * Tuesday as well and Wednesday's figure is UGX 12,000 by the same arithmetic,
 * with three untouched rows behind it.
 *
 * ## No extra interest, ever
 *
 * Nothing in this module multiplies anything by a rate except the one-time
 * expiry penalty. Missed collections do not accrue interest, do not compound,
 * and do not change the contractual interest Phase 4 computed. The only charge
 * Phase 7 can add is the penalty, once.
 */

import {
  compareBusinessDates,
  daysBetween,
  type BusinessDate,
} from '@/lib/domain/datetime';
import { applyRateBps, sumUgx, toUgx, type UgxAmount } from '@/lib/domain/money';
import { remainingAmount, type PaymentObligation } from '@/lib/domain/payment';

// ---------------------------------------------------------------------------
// Operational state
// ---------------------------------------------------------------------------

/**
 * A loan's operational state, derived from the calendar and the ledger.
 *
 * Deliberately **not** `loans.status`. The core lifecycle — draft, approved,
 * active, cleared, cancelled — records decisions people made, and a state
 * machine should not churn because midnight passed. These seven values are a
 * reading of the same loan against today's date, computed on every read and
 * stored nowhere.
 */
export const DELINQUENCY_STATES = [
  'current',
  'due_today',
  'in_arrears',
  'grace_period',
  'expired_unpaid',
  'penalty_due',
  'cleared',
] as const;

export type DelinquencyState = (typeof DELINQUENCY_STATES)[number];

export function isDelinquencyState(value: unknown): value is DelinquencyState {
  return (
    typeof value === 'string' && (DELINQUENCY_STATES as readonly string[]).includes(value)
  );
}

export const DELINQUENCY_STATE_LABELS: Readonly<Record<DelinquencyState, string>> = {
  current: 'Current',
  due_today: 'Due today',
  in_arrears: 'In arrears',
  grace_period: 'Grace period',
  expired_unpaid: 'Expired, unpaid',
  penalty_due: 'Penalty due',
  cleared: 'Settled',
};

/**
 * The exact predicate behind each state, in words.
 *
 * Shown in the interface next to the label, because an operational status a
 * collection officer cannot define is a status they will interpret differently
 * from the person who wrote it.
 */
export const DELINQUENCY_STATE_DESCRIPTIONS: Readonly<Record<DelinquencyState, string>> =
  {
    current: 'Nothing is due today or earlier.',
    due_today: "Today's collection is uncovered; nothing earlier is.",
    in_arrears: 'A collection due before today is still uncovered.',
    grace_period:
      'Past the final collection date, still inside the grace period, and still owing.',
    expired_unpaid:
      'Past the end of the grace period and still owing. A penalty applies and will be charged on the next transaction.',
    penalty_due: 'A penalty has been charged and is not yet fully paid.',
    cleared: 'Nothing is owed: every collection and any penalty are covered.',
  };

/** Ordering for a list: the most pressing first. */
export const DELINQUENCY_STATE_SEVERITY: Readonly<Record<DelinquencyState, number>> = {
  penalty_due: 0,
  expired_unpaid: 1,
  grace_period: 2,
  in_arrears: 3,
  due_today: 4,
  current: 5,
  cleared: 6,
};

// ---------------------------------------------------------------------------
// The schedule against the calendar
// ---------------------------------------------------------------------------

function scheduledOnly(
  obligations: readonly PaymentObligation[],
): readonly PaymentObligation[] {
  return obligations.filter((obligation) => obligation.kind === 'installment');
}

/**
 * Past-due arrears: the **uncovered** amount of every collection due strictly
 * before today.
 *
 * The uncovered amount, not the scheduled amount. A collection of UGX 4,000
 * that an earlier overpayment covered UGX 1,500 of contributes UGX 2,500 —
 * the figure the specification calls out, and the one a reversal can
 * reintroduce on a collection that was previously settled.
 */
export function pastDueArrears(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): UgxAmount {
  return sumUgx(
    scheduledOnly(obligations)
      .filter((obligation) => compareBusinessDates(obligation.effectiveDate, today) < 0)
      .map(remainingAmount),
  );
}

/** The uncovered amount of collections due **today**. */
export function dueTodayAmount(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): UgxAmount {
  return sumUgx(
    scheduledOnly(obligations)
      .filter((obligation) => compareBusinessDates(obligation.effectiveDate, today) === 0)
      .map(remainingAmount),
  );
}

/**
 * The current amount due: past-due arrears plus today's uncovered collection.
 *
 * This is the figure a collection officer asks for, and the one that turns a
 * missed UGX 4,000 Monday into UGX 8,000 on Tuesday without either scheduled
 * row changing.
 *
 * It excludes the penalty. A penalty is a charge with its own date and its own
 * line on every screen; adding it in here would make "what is due today"
 * jump by tens of thousands on one particular morning and would hide which
 * part of the demand is contractual.
 */
export function currentDue(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): UgxAmount {
  return toUgx(pastDueArrears(obligations, today) + dueTodayAmount(obligations, today));
}

/**
 * How many past collections are still uncovered.
 *
 * Deliberately **not** called days. On an every-3-days schedule three missed
 * collections are nine days late, and reporting the count as days would
 * overstate a borrower's lateness threefold. `daysPastDue` is the other
 * measure, and both are reported.
 */
export function missedInstallmentCount(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): number {
  return scheduledOnly(obligations).filter(
    (obligation) =>
      compareBusinessDates(obligation.effectiveDate, today) < 0 &&
      remainingAmount(obligation) > 0,
  ).length;
}

/**
 * The earliest collection with anything left on it, past due or not.
 *
 * Also the obligation the minimum-payment rule points at, which is why it is
 * reported: a staff member asking "why is the smallest payment UGX 2,500"
 * should be able to see which collection it belongs to.
 */
export function oldestUnpaidDueDate(
  obligations: readonly PaymentObligation[],
): BusinessDate | null {
  const unpaid = scheduledOnly(obligations)
    .filter((obligation) => remainingAmount(obligation) > 0)
    .map((obligation) => obligation.effectiveDate)
    .sort(compareBusinessDates);

  return unpaid[0] ?? null;
}

/** The earliest **overdue** uncovered collection: what lateness is measured from. */
export function oldestPastDueDate(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): BusinessDate | null {
  const overdue = scheduledOnly(obligations)
    .filter(
      (obligation) =>
        compareBusinessDates(obligation.effectiveDate, today) < 0 &&
        remainingAmount(obligation) > 0,
    )
    .map((obligation) => obligation.effectiveDate)
    .sort(compareBusinessDates);

  return overdue[0] ?? null;
}

/**
 * Calendar days since the oldest uncovered past-due collection, or zero.
 *
 * Calendar days, not working days and not collection intervals: "11 days late"
 * means eleven days have passed, whatever the loan's cadence.
 */
export function daysPastDue(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): number {
  const oldest = oldestPastDueDate(obligations, today);
  return oldest === null ? 0 : daysBetween(oldest, today);
}

/**
 * The contractual completion date: the **final collection's due date**.
 *
 * Read from the schedule, never recomputed as "disbursement plus the term".
 * Phase 5 resolved every month-end and leap-year question when it generated
 * the collections, and a second calculation here would eventually disagree
 * with the dates the borrower was actually given.
 */
export function scheduledCompletionDate(
  obligations: readonly PaymentObligation[],
): BusinessDate | null {
  const dates = scheduledOnly(obligations)
    .map((obligation) => obligation.effectiveDate)
    .sort(compareBusinessDates);

  return dates[dates.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Expiry, grace and the penalty date
// ---------------------------------------------------------------------------

/**
 * The last day of the grace period.
 *
 * ## The boundary, stated once so it cannot drift
 *
 * With a final due date of 10 October and a three-day grace period:
 *
 *   * 10 Oct — the final collection is due. A payment today is **on time**;
 *     there is no grace and no penalty in question.
 *   * 11 Oct — grace day 1
 *   * 12 Oct — grace day 2
 *   * 13 Oct — grace day 3, and `graceEndDate`
 *   * 14 Oct — `penaltyEffectiveDate`. The charge applies from the **start**
 *     of this day, so a payment made on the 14th is made after the penalty.
 *
 * Grace days are the days **after** the due date, which is the only reading
 * under which "three days of grace" gives a borrower three further days to
 * pay. Counting the due date itself as day 1 would give them two.
 */
export function graceEndDate(
  finalDueDate: BusinessDate,
  graceDays: number,
): BusinessDate {
  assertWholeDays(graceDays, 'A grace period');
  return addDays(finalDueDate, graceDays);
}

/** The business date on which the penalty takes effect: the day after grace. */
export function penaltyEffectiveDate(
  finalDueDate: BusinessDate,
  graceDays: number,
): BusinessDate {
  return addDays(graceEndDate(finalDueDate, graceDays), 1);
}

export function isPastFinalDueDate(
  finalDueDate: BusinessDate,
  today: BusinessDate,
): boolean {
  return compareBusinessDates(today, finalDueDate) > 0;
}

/** Past the final due date, and not yet past the end of grace. */
export function isWithinGracePeriod(
  finalDueDate: BusinessDate,
  graceDays: number,
  today: BusinessDate,
): boolean {
  return (
    isPastFinalDueDate(finalDueDate, today) &&
    compareBusinessDates(today, graceEndDate(finalDueDate, graceDays)) <= 0
  );
}

/** Is the penalty date reached? True on the effective date itself. */
export function isPenaltyDateReached(
  finalDueDate: BusinessDate,
  graceDays: number,
  today: BusinessDate,
): boolean {
  return compareBusinessDates(today, penaltyEffectiveDate(finalDueDate, graceDays)) >= 0;
}

/**
 * The penalty on a given basis.
 *
 * Half-up to the whole shilling, from an integer basis and an integer rate in
 * basis points — `applyRateBps` does the arithmetic in `BigInt`, and the
 * database's CHECK re-derives the same figure as `(basis * bps + 5000) /
 * 10000`. 50% is 5,000 bps; the rate is never written as `0.5` and never
 * multiplied as a float.
 */
export function penaltyAmountFor(basis: UgxAmount, rateBps: number): UgxAmount {
  return applyRateBps(basis, rateBps, 'half-up');
}

// ---------------------------------------------------------------------------
// The whole position
// ---------------------------------------------------------------------------

export interface DelinquencyPosition {
  readonly businessDate: BusinessDate;

  // The schedule against the calendar.
  readonly scheduledCompletionDate: BusinessDate | null;
  readonly arrearsAmount: UgxAmount;
  readonly dueToday: UgxAmount;
  readonly currentDue: UgxAmount;
  readonly missedInstallmentCount: number;
  readonly oldestUnpaidDueDate: BusinessDate | null;
  readonly oldestPastDueDate: BusinessDate | null;
  readonly daysPastDue: number;

  // Expiry and grace.
  readonly graceDays: number;
  readonly graceEndDate: BusinessDate | null;
  readonly penaltyEffectiveDate: BusinessDate | null;
  readonly pastFinalDueDate: boolean;
  readonly withinGracePeriod: boolean;

  // The money.
  readonly contractualOutstanding: UgxAmount;
  readonly penaltyAmount: UgxAmount;
  readonly penaltyPaid: UgxAmount;
  readonly penaltyRemaining: UgxAmount;
  readonly totalOutstanding: UgxAmount;

  // The penalty.
  readonly penaltyApplied: boolean;
  readonly penaltyEligible: boolean;
  readonly penaltyProjectedAmount: UgxAmount;

  readonly state: DelinquencyState;
}

/**
 * Derive a loan's whole delinquency position.
 *
 * Mirrors the database's `loan_delinquency` view, which is the authoritative
 * one: this exists so a screen can compute the same figures from obligations
 * it already has, and so a test can state them without a database. A parity
 * test compares the two.
 */
export function deriveDelinquency(input: {
  readonly obligations: readonly PaymentObligation[];
  readonly today: BusinessDate;
  /** The loan's **own snapshotted** grace period, never the current setting. */
  readonly graceDays: number;
  /** The loan's own snapshotted penalty rate in basis points. */
  readonly penaltyRateBps: number;
  /** Is the loan cleared? Core lifecycle state, which this does not derive. */
  readonly loanCleared?: boolean;
  /**
   * The contractual balance as it stood at the end of the grace period, which
   * only the ledger's payment dates can answer. Omitted when the loan has not
   * reached its grace deadline, where it has no meaning.
   */
  readonly basisAsOfGraceEnd?: UgxAmount;
}): DelinquencyPosition {
  const {
    obligations,
    today,
    graceDays,
    penaltyRateBps,
    loanCleared = false,
    basisAsOfGraceEnd,
  } = input;

  const finalDue = scheduledCompletionDate(obligations);
  const scheduled = scheduledOnly(obligations);
  const penalties = obligations.filter((obligation) => obligation.kind === 'penalty');

  const contractualOutstanding = sumUgx(scheduled.map(remainingAmount));
  const penaltyAmount = sumUgx(penalties.map((penalty) => penalty.scheduledPenalty));
  const penaltyPaid = sumUgx(penalties.map((penalty) => penalty.allocatedPenalty));
  const penaltyRemaining = toUgx(penaltyAmount - penaltyPaid);

  const arrearsAmount = pastDueArrears(obligations, today);
  const dueToday = dueTodayAmount(obligations, today);

  const penaltyApplied = penalties.length > 0;
  const penaltyDateReached =
    finalDue !== null && isPenaltyDateReached(finalDue, graceDays, today);

  // The charge, computed first, because eligibility is defined in terms of
  // it: a rate of zero means the business has decided not to charge, and
  // reporting "a penalty applies" while nothing would be recorded is the kind
  // of contradiction a derived state must not produce.
  const projected =
    basisAsOfGraceEnd === undefined || basisAsOfGraceEnd <= 0
      ? toUgx(0)
      : penaltyAmountFor(basisAsOfGraceEnd, penaltyRateBps);

  // Eligible means: the date has passed, no charge exists yet, the loan is
  // live, something was actually owed at the deadline, and the charge is more
  // than nothing. The basis is the ledger's answer, so an absent basis means
  // "not known here" and the projection stays at zero rather than guessing
  // from today's balance.
  const penaltyEligible =
    !loanCleared && !penaltyApplied && penaltyDateReached && projected > 0;

  const penaltyProjectedAmount = penaltyEligible ? projected : toUgx(0);

  return {
    businessDate: today,
    scheduledCompletionDate: finalDue,
    arrearsAmount,
    dueToday,
    currentDue: toUgx(arrearsAmount + dueToday),
    missedInstallmentCount: missedInstallmentCount(obligations, today),
    oldestUnpaidDueDate: oldestUnpaidDueDate(obligations),
    oldestPastDueDate: oldestPastDueDate(obligations, today),
    daysPastDue: daysPastDue(obligations, today),
    graceDays,
    graceEndDate: finalDue === null ? null : graceEndDate(finalDue, graceDays),
    penaltyEffectiveDate:
      finalDue === null ? null : penaltyEffectiveDate(finalDue, graceDays),
    pastFinalDueDate: finalDue !== null && isPastFinalDueDate(finalDue, today),
    withinGracePeriod:
      finalDue !== null && isWithinGracePeriod(finalDue, graceDays, today),
    contractualOutstanding,
    penaltyAmount,
    penaltyPaid,
    penaltyRemaining,
    totalOutstanding: toUgx(contractualOutstanding + penaltyRemaining),
    penaltyApplied,
    penaltyEligible,
    penaltyProjectedAmount,
    state: delinquencyStateFor({
      loanCleared,
      penaltyApplied,
      penaltyRemaining,
      penaltyEligible,
      pastFinalDueDate: finalDue !== null && isPastFinalDueDate(finalDue, today),
      totalOutstanding: toUgx(contractualOutstanding + penaltyRemaining),
      arrearsAmount,
      dueToday,
    }),
  };
}

/**
 * One operational state, by a fixed precedence.
 *
 * The precedence is what stops a loan presenting two contradictory states: a
 * loan can be past its final due date *and* in arrears *and* penalised, and
 * only the most consequential of those is worth putting on a list.
 *
 *   1. `cleared`        — nothing is owed at all. Checked first because a
 *                         settled loan must never appear on an overdue list.
 *   2. `penalty_due`    — a charge exists and is not fully paid.
 *   3. `expired_unpaid` — past the penalty date and eligible, not yet charged.
 *   4. `grace_period`   — past the final due date, inside grace, still owing.
 *   5. `in_arrears`     — a collection before today is uncovered.
 *   6. `due_today`      — nothing overdue, but today's collection is uncovered.
 *   7. `current`        — nothing is owed today or earlier.
 */
export function delinquencyStateFor(input: {
  readonly loanCleared: boolean;
  readonly penaltyApplied: boolean;
  readonly penaltyRemaining: UgxAmount;
  readonly penaltyEligible: boolean;
  readonly pastFinalDueDate: boolean;
  readonly totalOutstanding: UgxAmount;
  readonly arrearsAmount: UgxAmount;
  readonly dueToday: UgxAmount;
}): DelinquencyState {
  if (input.loanCleared) return 'cleared';
  if (input.penaltyApplied && input.penaltyRemaining > 0) return 'penalty_due';
  if (input.penaltyEligible) return 'expired_unpaid';
  if (input.pastFinalDueDate && input.totalOutstanding > 0) return 'grace_period';
  if (input.arrearsAmount > 0) return 'in_arrears';
  if (input.dueToday > 0) return 'due_today';
  return 'current';
}

/**
 * Every invariant a delinquency position must satisfy.
 *
 * Applied to figures read back from the database as well as to computed ones,
 * so a position that cannot be true is caught where it is read rather than
 * shown to somebody chasing a borrower for it.
 */
export function assertDelinquencyInvariants(position: DelinquencyPosition): void {
  const fail = (message: string): never => {
    throw new Error(`Delinquency invariant violated: ${message}`);
  };

  if (position.arrearsAmount < 0) fail('arrears are negative.');
  if (position.dueToday < 0) fail('the amount due today is negative.');
  if (position.currentDue !== position.arrearsAmount + position.dueToday) {
    fail('current due is not arrears plus due today.');
  }
  if (position.currentDue > position.contractualOutstanding) {
    fail('more is due now than the loan owes on its contract.');
  }
  if (position.contractualOutstanding < 0) fail('contractual outstanding is negative.');
  if (position.penaltyRemaining < 0) fail('the penalty remaining is negative.');
  if (position.penaltyPaid + position.penaltyRemaining !== position.penaltyAmount) {
    fail('penalty paid plus remaining is not the penalty amount.');
  }
  if (
    position.totalOutstanding !==
    position.contractualOutstanding + position.penaltyRemaining
  ) {
    fail('total outstanding is not contractual outstanding plus penalty remaining.');
  }
  if (position.missedInstallmentCount < 0) fail('the missed count is negative.');
  if (position.daysPastDue < 0) fail('days past due is negative.');

  if (position.oldestPastDueDate === null && position.daysPastDue !== 0) {
    fail('days past due is set with no overdue collection.');
  }

  if (position.arrearsAmount > 0 && position.oldestPastDueDate === null) {
    fail('there are arrears but no overdue collection.');
  }

  if (position.missedInstallmentCount > 0 && position.arrearsAmount === 0) {
    fail('a collection is counted as missed with nothing uncovered.');
  }

  // A penalty cannot be both charged and pending.
  if (position.penaltyApplied && position.penaltyEligible) {
    fail('the penalty is recorded and also reported as eligible.');
  }

  if (!position.penaltyEligible && position.penaltyProjectedAmount !== 0) {
    fail('a penalty is projected without being eligible.');
  }

  // And the converse: eligibility means a charge will be made.
  if (position.penaltyEligible && position.penaltyProjectedAmount <= 0) {
    fail('a penalty is eligible with nothing to charge.');
  }

  if (position.penaltyApplied && position.penaltyAmount <= 0) {
    fail('a penalty is recorded with no amount.');
  }

  // The states, against the figures behind them.
  if (position.state === 'cleared' && position.totalOutstanding !== 0) {
    fail('the loan reads as settled while owing money.');
  }

  if (position.state === 'current' && position.currentDue !== 0) {
    fail('the loan reads as current with money due.');
  }

  if (position.state === 'in_arrears' && position.arrearsAmount === 0) {
    fail('the loan reads as in arrears with no arrears.');
  }

  if (position.state === 'penalty_due' && position.penaltyRemaining === 0) {
    fail('the loan reads as penalised with the penalty settled.');
  }

  if (position.withinGracePeriod && !position.pastFinalDueDate) {
    fail('the loan is inside its grace period before its final due date.');
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function assertWholeDays(days: number, what: string): void {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`${what} must be a whole number of days, received ${String(days)}.`);
  }
}

/**
 * Calendar-day arithmetic on a business date.
 *
 * Deliberately not `addBusinessDays` from `datetime.ts`, which is the same
 * thing under a name that invites a reader to think working days are meant.
 * A grace period is calendar days: three days of grace over a weekend is
 * still three days.
 */
function addDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number);

  /* c8 ignore next 3 -- a BusinessDate is validated on construction. */
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Malformed business date ${date}.`);
  }

  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const iso = shifted.toISOString().slice(0, 10);

  return iso as BusinessDate;
}
