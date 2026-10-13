/**
 * The loan calculation engine.
 *
 * Pure. No React, no Supabase, no database, no clock, no browser state — it
 * takes explicit inputs and returns explicit outputs, so every figure it
 * produces can be driven directly by a test. That matters more here than
 * anywhere else in the system: a wrong balance is not a cosmetic bug, it is a
 * false claim about what a borrower owes.
 *
 * ## Which implementation is authoritative
 *
 * There are two implementations of this arithmetic: this one, and
 * `public.calculate_loan_breakdown` in migration `20261004000500`.
 *
 * **The database is authoritative.** This module computes the *preview* shown
 * while staff enter a loan, and the database computes the figures that are
 * actually stored when a loan is approved. That split exists because the
 * approval function must not accept numbers from its caller: an approver who
 * could supply the breakdown could approve a loan at zero interest.
 *
 * Two implementations that must agree is a risk, so it is tested as one:
 * `tests/db/loan-engine-parity.test.ts` runs several hundred cases through both
 * and asserts identical output, period by period. If they ever diverge, that
 * test fails rather than a borrower being quoted one figure and charged
 * another.
 *
 * ## Why there is no floating point anywhere
 *
 * `0.15 * 200_000` is 30000.000000000004 in IEEE 754. Across a three-period
 * loan that is invisible; across a year of posted payments it is a ledger that
 * does not balance. So:
 *
 *   - interest is `amount × basisPoints / 10_000`, multiplied in `BigInt` and
 *     divided once with explicit half-up rounding (`applyRateBps`);
 *   - principal is split with `divideEvenly`, which is `BigInt` division plus
 *     an exact remainder distribution;
 *   - nothing in this file contains a decimal literal, `parseFloat`, or a
 *     division by a non-integer.
 *
 * ## The interest model
 *
 * Reducing balance on the **opening principal of each period**, which is the
 * business's confirmed rule:
 *
 *     interest(n) = round_half_up(openingPrincipal(n) × rateBps / 10_000)
 *
 * Note what this is *not*. It is not a flat rate on the original principal
 * (which would charge the same interest every month), and it is not an
 * amortising annuity (which would hold the monthly payment constant and solve
 * for the principal split). The monthly obligation here declines, because the
 * principal portion is level and the interest shrinks with the balance.
 */

import {
  applyRateBps,
  divideEvenly,
  sumUgx,
  toUgx,
  type UgxAmount,
} from '@/lib/domain/money';
import { MAX_BPS } from '@/lib/domain/rate';

/** Interest methods this engine knows. One, for now, and it is named. */
export const INTEREST_METHODS = ['reducing_balance_monthly'] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

export function isInterestMethod(value: unknown): value is InterestMethod {
  return (
    typeof value === 'string' && (INTEREST_METHODS as readonly string[]).includes(value)
  );
}

/**
 * The upper bound on a term this engine will compute.
 *
 * Not a commercial limit — that lives in business settings, which currently
 * allows three months. This is a sanity bound so that a corrupted input cannot
 * ask for a million periods and exhaust memory.
 */
export const MAX_SUPPORTED_TERM_MONTHS = 120;

export class LoanCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoanCalculationError';
  }
}

export interface LoanCalculationInput {
  /** Whole shillings. Must be positive. */
  readonly principal: UgxAmount;
  /** Monthly rate in basis points. 15% is 1500. Zero is permitted. */
  readonly monthlyInterestRateBps: number;
  /** Number of monthly periods. Must be a positive integer. */
  readonly termMonths: number;
}

/** One contractual month. Every figure is whole shillings. */
export interface LoanPeriod {
  /** 1-based. */
  readonly periodNumber: number;
  /** Principal outstanding at the start of the period. */
  readonly openingPrincipal: UgxAmount;
  /** Principal repaid in this period. */
  readonly principalPortion: UgxAmount;
  /** Interest charged on the opening principal. */
  readonly interest: UgxAmount;
  /** What the borrower owes for the period: principal + interest. */
  readonly totalObligation: UgxAmount;
  /** Principal outstanding after this period. Zero in the final period. */
  readonly closingPrincipal: UgxAmount;
}

export interface LoanCalculation {
  readonly periods: readonly LoanPeriod[];
  readonly principal: UgxAmount;
  readonly totalInterest: UgxAmount;
  /** `principal + totalInterest`. What the loan is contractually worth. */
  readonly totalExpectedRepayment: UgxAmount;
  readonly interestMethod: InterestMethod;
  readonly monthlyInterestRateBps: number;
  readonly termMonths: number;
}

/**
 * Compute a loan's contractual monthly breakdown.
 *
 * The principal is divided into level portions with any remainder placed in
 * the **final** period, so the portions sum to the principal exactly. Interest
 * is then charged on each period's opening balance.
 *
 * Worked example — UGX 200,000 over two months at 15%:
 *
 * | Period | Opening | Principal | Interest | Obligation | Closing |
 * | --- | --- | --- | --- | --- | --- |
 * | 1 | 200,000 | 100,000 | 30,000 | 130,000 | 100,000 |
 * | 2 | 100,000 | 100,000 | 15,000 | 115,000 | 0 |
 *
 * Total interest 45,000; total expected 245,000.
 *
 * @throws LoanCalculationError on a non-positive principal, a negative or
 *   non-integer rate, or a term outside `1..MAX_SUPPORTED_TERM_MONTHS`.
 */
export function calculateLoan(input: LoanCalculationInput): LoanCalculation {
  const { principal, monthlyInterestRateBps, termMonths } = input;

  // --- Input validation ----------------------------------------------------
  // Refused rather than coerced. A loan of zero, or over a term of zero, is a
  // caller that has gone wrong, and quietly returning an empty breakdown would
  // hide it until somebody read the figures.
  if (!Number.isInteger(principal) || principal <= 0) {
    throw new LoanCalculationError(
      `A loan principal must be a positive whole number of shillings, received ${String(principal)}.`,
    );
  }

  if (!Number.isInteger(monthlyInterestRateBps) || monthlyInterestRateBps < 0) {
    throw new LoanCalculationError(
      `An interest rate must be a non-negative whole number of basis points, received ${String(monthlyInterestRateBps)}.`,
    );
  }

  if (monthlyInterestRateBps > MAX_BPS) {
    throw new LoanCalculationError(
      `An interest rate of ${String(monthlyInterestRateBps)} basis points is beyond the supported range.`,
    );
  }

  if (!Number.isInteger(termMonths) || termMonths < 1) {
    throw new LoanCalculationError(
      `A loan term must be a positive whole number of months, received ${String(termMonths)}.`,
    );
  }

  if (termMonths > MAX_SUPPORTED_TERM_MONTHS) {
    throw new LoanCalculationError(
      `A term of ${String(termMonths)} months is beyond the supported range of ${String(MAX_SUPPORTED_TERM_MONTHS)}.`,
    );
  }

  // --- The breakdown -------------------------------------------------------
  // `divideEvenly` splits in BigInt and places the remainder in the last
  // period, so `UGX 200,001` over two months is 100,000 then 100,001 — never
  // two portions of 100,000 with a shilling lost.
  const principalPortions = divideEvenly(principal, termMonths, {
    remainder: 'last',
  });

  const periods: LoanPeriod[] = [];
  let openingPrincipal = principal;

  for (let index = 0; index < termMonths; index += 1) {
    const principalPortion = principalPortions[index] ?? toUgx(0);

    // Charged on what is outstanding at the start of the period. This single
    // line is the reducing-balance rule.
    const interest = applyRateBps(openingPrincipal, monthlyInterestRateBps, 'half-up');

    const closingPrincipal = toUgx(openingPrincipal - principalPortion);

    periods.push({
      periodNumber: index + 1,
      openingPrincipal,
      principalPortion,
      interest,
      totalObligation: toUgx(principalPortion + interest),
      closingPrincipal,
    });

    openingPrincipal = closingPrincipal;
  }

  const totalInterest = sumUgx(periods.map((period) => period.interest));

  const calculation: LoanCalculation = {
    periods,
    principal,
    totalInterest,
    totalExpectedRepayment: toUgx(principal + totalInterest),
    interestMethod: 'reducing_balance_monthly',
    monthlyInterestRateBps,
    termMonths,
  };

  // Checked on every call rather than only in tests. The cost is a few
  // additions; the alternative is a corrupt contractual figure reaching a
  // borrower because some future change broke an invariant nobody re-ran.
  assertLoanInvariants(calculation);

  return calculation;
}

/**
 * The invariants every breakdown must satisfy.
 *
 * Exported so the database parity test and the property-based audit can apply
 * exactly the same checks to figures that did not come from `calculateLoan` —
 * including rows read back out of PostgreSQL.
 *
 * @throws LoanCalculationError naming the first invariant that fails.
 */
export function assertLoanInvariants(calculation: LoanCalculation): void {
  const { periods, principal, totalInterest, totalExpectedRepayment, termMonths } =
    calculation;

  const fail = (message: string): never => {
    throw new LoanCalculationError(`Loan invariant violated: ${message}`);
  };

  if (periods.length !== termMonths) {
    fail(`expected ${String(termMonths)} periods, found ${String(periods.length)}.`);
  }

  if (principal <= 0) fail('principal is not positive.');

  // --- Money conservation, checked first -----------------------------------
  //
  // These come before the per-period walk deliberately. Walking the chain
  // (each period opening where the last closed, and the final period closing
  // at zero) mathematically implies that the portions sum to the principal —
  // so if the walk ran first, the conservation checks below could never fire
  // and would be protection in name only.
  //
  // Checking them first makes them reachable, and makes the error the useful
  // one: "the portions sum to 199,999, not 200,000" names a lost shilling
  // directly, where "period 2 closes at 1" leaves the reader to work out why.
  const allocatedPrincipal = periods.reduce(
    (total, period) => total + period.principalPortion,
    0,
  );

  if (allocatedPrincipal !== principal) {
    fail(
      `principal portions sum to ${String(allocatedPrincipal)}, not ${String(principal)}.`,
    );
  }

  const summedInterest = periods.reduce((total, period) => total + period.interest, 0);

  if (summedInterest !== totalInterest) {
    fail(
      `total interest is ${String(totalInterest)} but the periods sum to ${String(summedInterest)}.`,
    );
  }

  if (totalExpectedRepayment !== principal + totalInterest) {
    fail('total expected repayment is not principal plus total interest.');
  }

  const summedObligations = periods.reduce(
    (total, period) => total + period.totalObligation,
    0,
  );

  if (summedObligations !== totalExpectedRepayment) {
    fail(
      `monthly obligations sum to ${String(summedObligations)}, not the total expected ${String(totalExpectedRepayment)}.`,
    );
  }

  // --- Then the period-by-period chain -------------------------------------
  // Every period, in order, with its arithmetic internally consistent.
  let expectedOpening = principal;

  for (const [index, period] of periods.entries()) {
    const label = `period ${String(period.periodNumber)}`;

    if (period.periodNumber !== index + 1) {
      fail(`${label} is out of sequence.`);
    }

    if (period.openingPrincipal !== expectedOpening) {
      fail(
        `${label} opens at ${String(period.openingPrincipal)} but the previous period closed at ${String(expectedOpening)}.`,
      );
    }

    if (period.openingPrincipal < 0) fail(`${label} opens negative.`);
    if (period.closingPrincipal < 0) fail(`${label} closes negative.`);
    if (period.interest < 0) fail(`${label} charges negative interest.`);
    if (period.principalPortion < 0) fail(`${label} repays negative principal.`);

    if (period.closingPrincipal !== period.openingPrincipal - period.principalPortion) {
      fail(`${label} closing balance does not follow from its principal portion.`);
    }

    if (period.totalObligation !== period.principalPortion + period.interest) {
      fail(`${label} obligation is not principal plus interest.`);
    }

    expectedOpening = period.closingPrincipal;
  }

  // The loan is fully repaid by the end. Without this, a remainder could be
  // left outstanding with nothing to collect it.
  const finalPeriod = periods.at(-1);

  if (finalPeriod === undefined) fail('the breakdown has no periods.');
  else if (finalPeriod.closingPrincipal !== 0) {
    fail(`the final period leaves ${String(finalPeriod.closingPrincipal)} outstanding.`);
  }
}

/**
 * A breakdown rebuilt from stored rows, for invariant checking.
 *
 * Phase 5 and the loan detail screen both read periods from the database
 * rather than recomputing them. This lets either hand those rows back through
 * `assertLoanInvariants`, so a corrupted stored breakdown is caught at the
 * point it is read rather than believed.
 */
export function calculationFromPeriods(
  periods: readonly LoanPeriod[],
  monthlyInterestRateBps: number,
  interestMethod: InterestMethod = 'reducing_balance_monthly',
): LoanCalculation {
  const first = periods[0];

  if (first === undefined) {
    throw new LoanCalculationError('Cannot rebuild a calculation from no periods.');
  }

  const principal = first.openingPrincipal;
  const totalInterest = sumUgx(periods.map((period) => period.interest));

  return {
    periods,
    principal,
    totalInterest,
    totalExpectedRepayment: toUgx(principal + totalInterest),
    interestMethod,
    monthlyInterestRateBps,
    termMonths: periods.length,
  };
}

// ---------------------------------------------------------------------------
// The loan lifecycle
// ---------------------------------------------------------------------------

/**
 * A loan's status.
 *
 *   - `draft` — being entered. A working document, freely editable by whoever
 *     holds `loans:update_draft`. Nothing is agreed and no figures exist yet.
 *   - `pending_approval` — submitted, awaiting a decision. The shape of the
 *     loan is now fixed; only the decision is outstanding.
 *   - `approved` — a decision has been made, the terms are computed and
 *     frozen, and every snapshot is captured. The money has not moved.
 *   - `active` — disbursed. The borrower has the money and owes the
 *     contractual total.
 *   - `cleared` — fully repaid. **Reserved for a later phase**: nothing in
 *     Phase 4 performs this transition, because it becomes possible only once
 *     payments can be posted and a loan can be shown to be settled.
 *   - `cancelled` — abandoned before the money moved. Terminal, and retained:
 *     a cancelled loan stays in the register as history.
 *
 * Statuses a later phase will need and which are deliberately **absent** —
 * `in_arrears`, `grace_period`, `overdue` — are not declared here. A status
 * nothing can set and nothing can read is a false promise about what the
 * system knows.
 */
export const LOAN_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'active',
  'cleared',
  'cancelled',
] as const;

export type LoanStatus = (typeof LOAN_STATUSES)[number];

export function isLoanStatus(value: unknown): value is LoanStatus {
  return (
    typeof value === 'string' && (LOAN_STATUSES as readonly string[]).includes(value)
  );
}

export const LOAN_STATUS_LABELS: Readonly<Record<LoanStatus, string>> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  active: 'Active',
  cleared: 'Cleared',
  cancelled: 'Cancelled',
};

export const LOAN_STATUS_DESCRIPTIONS: Readonly<Record<LoanStatus, string>> = {
  draft: 'Being entered. Not yet submitted for a decision.',
  pending_approval: 'Submitted and waiting for a decision.',
  approved: 'Approved. The money has not been released yet.',
  active: 'Disbursed. The borrower owes the contractual total.',
  cleared: 'Fully repaid.',
  cancelled: 'Abandoned before any money was released.',
};

/**
 * The permitted transitions, mirroring `loans_guard_transition` in migration
 * `20261004000300`.
 *
 * The database is the enforcement; this exists so the interface can offer only
 * the moves that will actually succeed, and so the machine can be read in one
 * place. A test compares the two representations.
 *
 * `cancelled` and `cleared` have no outgoing edges. Both are terminal: a
 * cancelled loan was never agreed, and reviving one would make a loan nobody
 * approved become active.
 */
export const LOAN_TRANSITIONS: Readonly<Record<LoanStatus, readonly LoanStatus[]>> = {
  draft: ['pending_approval', 'cancelled'],
  // Back to draft is a return for correction, which is the approver's act.
  pending_approval: ['draft', 'approved', 'cancelled'],
  approved: ['active', 'cancelled'],
  // Reserved for a later phase; nothing in Phase 4 performs it.
  active: ['cleared'],
  cleared: [],
  cancelled: [],
};

export function canTransition(from: LoanStatus, to: LoanStatus): boolean {
  return LOAN_TRANSITIONS[from].includes(to);
}

/** The capability a transition requires. Mirrors the database trigger. */
export function capabilityForTransition(from: LoanStatus, to: LoanStatus): string | null {
  if (!canTransition(from, to)) return null;

  if (to === 'pending_approval') return 'loans:submit';
  if (to === 'approved') return 'loans:approve';
  if (to === 'draft') return 'loans:approve';
  if (to === 'active') return 'loans:disburse';
  if (to === 'cancelled') return 'loans:cancel';

  return null;
}

/** Can the loan's commercial terms still be changed? */
export function termsAreEditable(status: LoanStatus): boolean {
  return status === 'draft';
}

/** Is this loan one the business is currently owed money on? */
export function isOutstanding(status: LoanStatus): boolean {
  return status === 'active';
}

// ---------------------------------------------------------------------------
// Eligibility failures
// ---------------------------------------------------------------------------

/**
 * The failure codes `public.validate_loan_for_approval` can return.
 *
 * Machine-readable rather than prose, so the database states the rule and the
 * interface decides how to say it — and so a test can assert which rule fired
 * rather than matching on a sentence somebody may later reword.
 */
export const LOAN_APPROVAL_FAILURES = [
  'loan_not_found',
  'settings_unavailable',
  'client_not_found',
  'client_not_active',
  'active_loan_exists',
  'below_minimum',
  'above_maximum',
  'term_not_permitted',
  'term_requires_higher_amount',
  'frequency_not_permitted',
  'insufficient_guarantors',
  'guarantor_incomplete',
  // Phase 13. Approval reads the application it was given: the product's own
  // questions have to have been answered, and the people who agreed to stand
  // behind the loan have to have signed and still be eligible.
  'salary_details_missing',
  'business_details_missing',
  'guarantor_consent_missing',
  'guarantor_ineligible',
] as const;

export type LoanApprovalFailure = (typeof LOAN_APPROVAL_FAILURES)[number];

export function isLoanApprovalFailure(value: unknown): value is LoanApprovalFailure {
  return (
    typeof value === 'string' &&
    (LOAN_APPROVAL_FAILURES as readonly string[]).includes(value)
  );
}

/**
 * What to tell the person looking at the screen.
 *
 * `detail` carries the figure the rule was checked against — the minimum, the
 * threshold, the count — so the message can say what is needed rather than
 * only that something is wrong. A staff member told "below the minimum" has to
 * go and look it up; one told "the minimum is UGX 100,000" does not.
 */
export function describeLoanApprovalFailure(
  code: LoanApprovalFailure,
  detail: string | null,
): string {
  const amount = (value: string | null): string =>
    value === null
      ? 'the configured amount'
      : `UGX ${Number(value).toLocaleString('en-UG')}`;

  switch (code) {
    case 'loan_not_found':
      return 'That loan no longer exists.';
    case 'settings_unavailable':
      return 'Business settings could not be read. Contact your administrator.';
    case 'client_not_found':
      return 'The client on this loan no longer exists.';
    case 'client_not_active':
      return `This client is ${detail ?? 'not active'} and cannot receive a loan.`;
    case 'active_loan_exists':
      return 'This client already has an active loan. It must be cleared first.';
    case 'below_minimum':
      return `The amount is below the current minimum of ${amount(detail)}.`;
    case 'above_maximum':
      return `The amount is above the current maximum of ${amount(detail)}.`;
    case 'term_not_permitted':
      return `A term of ${detail ?? 'that length'} months is not currently permitted.`;
    case 'term_requires_higher_amount':
      return `A loan of more than one month requires at least ${amount(detail)}.`;
    case 'frequency_not_permitted':
      return 'The selected repayment frequency is not currently offered.';
    case 'insufficient_guarantors':
      return `This client needs at least ${detail ?? 'one'} active guarantor before a loan can be approved.`;
    case 'guarantor_incomplete':
      return 'A guarantor is missing required information — a phone number, occupation, location, relationship or identification number.';
    case 'salary_details_missing':
      return `${detail ?? 'This product'} is a salary loan, and the employment details have not been entered.`;
    case 'business_details_missing':
      return `${detail ?? 'This product'} is a business loan, and the business details have not been entered.`;
    case 'guarantor_consent_missing':
      return detail === '1'
        ? 'One guarantor has not signed the undertaking.'
        : `${detail ?? 'Some'} guarantors have not signed the undertaking.`;
    case 'guarantor_ineligible':
      return 'A guarantor on this application is no longer eligible — archived, suspended or blacklisted since it was drafted.';
  }
}

// ---------------------------------------------------------------------------
// How a cancelled loan ended
// ---------------------------------------------------------------------------

/**
 * Why a cancelled loan was cancelled.
 *
 * `status` answers the question the whole system branches on — did this loan
 * ever become debt — and both of these answer no. What separates them is
 * whose decision it was: a refusal is a credit decision and belongs in a
 * report about lending standards; a withdrawal is a change of mind and does
 * not.
 */
export const LOAN_CLOSURE_KINDS = ['rejected', 'withdrawn'] as const;

export type LoanClosureKind = (typeof LOAN_CLOSURE_KINDS)[number];

export function isLoanClosureKind(value: unknown): value is LoanClosureKind {
  return (
    typeof value === 'string' && (LOAN_CLOSURE_KINDS as readonly string[]).includes(value)
  );
}

export const LOAN_CLOSURE_LABELS: Readonly<Record<LoanClosureKind, string>> = {
  rejected: 'Rejected',
  withdrawn: 'Cancelled',
};

export const LOAN_CLOSURE_DESCRIPTIONS: Readonly<Record<LoanClosureKind, string>> = {
  rejected: 'The business refused this application.',
  withdrawn: 'Taken back before any money was released.',
};

// ---------------------------------------------------------------------------
// The loan workflow
// ---------------------------------------------------------------------------

/**
 * The stage of the loan workflow a loan sits at.
 *
 * Derived in `public.loan_workflow_register` from the lifecycle status, the
 * intended disbursement date and the collection position — never stored, so
 * the passage of midnight moves a loan from `active` to `arrears` without any
 * process having to run.
 *
 * Mirrored here so the register's tabs can be declared once and so an
 * unrecognised value is caught rather than rendered. A test compares the two
 * representations.
 */
export const LOAN_WORKFLOW_STAGES = [
  'draft',
  'pending_approval',
  'approved',
  'awaiting_disbursement',
  'active',
  'grace_period',
  'arrears',
  'cleared',
  'rejected',
  'withdrawn',
] as const;

export type LoanWorkflowStage = (typeof LOAN_WORKFLOW_STAGES)[number];

export function isLoanWorkflowStage(value: unknown): value is LoanWorkflowStage {
  return (
    typeof value === 'string' &&
    (LOAN_WORKFLOW_STAGES as readonly string[]).includes(value)
  );
}

export const LOAN_WORKFLOW_LABELS: Readonly<Record<LoanWorkflowStage, string>> = {
  draft: 'Draft applications',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  awaiting_disbursement: 'Awaiting disbursement',
  active: 'Active loans',
  grace_period: 'Grace period',
  arrears: 'Arrears',
  cleared: 'Cleared loans',
  rejected: 'Rejected',
  withdrawn: 'Cancelled',
};

export const LOAN_WORKFLOW_DESCRIPTIONS: Readonly<Record<LoanWorkflowStage, string>> = {
  draft: 'Being entered. Not yet submitted for a decision.',
  pending_approval: 'Submitted and waiting for a decision.',
  approved: 'Agreed, and the money has not been released yet.',
  // Not a duplicate of Approved. This is the subset whose intended date has
  // arrived — the queue somebody works through this morning.
  awaiting_disbursement: 'Approved, and due to be paid out today or earlier.',
  active: 'Disbursed and being collected, with nothing overdue.',
  grace_period: 'Past the final collection date and inside the grace period.',
  arrears: 'A collection before today is uncovered.',
  cleared: 'Fully repaid, penalties included.',
  rejected: 'The business refused the application.',
  withdrawn: 'Taken back before any money was released.',
};

/**
 * Is a multi-month term available at this amount?
 *
 * The confirmed rule: at or above the threshold a loan *may* run longer, it
 * does not automatically do so. Takes the threshold explicitly rather than
 * reading settings, because this module is pure.
 */
export function permittedTermMonths(
  principal: UgxAmount,
  settings: {
    readonly minTermMonths: number;
    readonly maxTermMonths: number;
    readonly multiMonthMinAmount: number;
  },
): readonly number[] {
  const ceiling = principal >= settings.multiMonthMinAmount ? settings.maxTermMonths : 1;

  const terms: number[] = [];

  for (let months = Math.max(1, settings.minTermMonths); months <= ceiling; months += 1) {
    terms.push(months);
  }

  // A threshold above the maximum term, or a minimum term above the ceiling,
  // would otherwise yield nothing. One month is always available.
  return terms.length > 0 ? terms : [1];
}
