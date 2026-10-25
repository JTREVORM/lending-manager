/**
 * The member loan domain.
 *
 * Pure. No React, no Supabase, no database, no clock — it takes explicit
 * inputs and returns explicit outputs, exactly like `lib/domain/loan.ts` and
 * for the same reason: a wrong ceiling is a false claim about what the
 * business will lend, and a wrong breakdown is a false claim about what a
 * member owes.
 *
 * ## Which implementation is authoritative
 *
 * The database, as everywhere in this system. `public.member_loan_interest`
 * computes the figures that are stored at approval;
 * `public.member_loan_eligibility_of` computes the assessment that is frozen
 * into `member_loan_eligibility_snapshots`. This module computes the
 * **preview** staff see while entering an application, and is tested
 * exhaustively in isolation. `tests/db/member-loan-approval.test.ts` drives
 * cases through both and asserts they agree, so a divergence fails a test
 * rather than quoting a member one figure and charging another.
 *
 * ## The two undecided questions this module refuses to answer
 *
 * `interestBasis` and `interestMethod` are nullable throughout, and `null`
 * means *the client has not decided*. Nothing here defaults either of them.
 * A function given a null basis returns a refusal naming the decision, which
 * is what the interface shows — rather than a plausible figure a member would
 * then be quoted.
 *
 * The same holds for `multiplierBps`: with no multiplier there is no ceiling,
 * and `memberLoanCeiling` returns `null`. A default multiplier would be an
 * invented credit limit.
 *
 * ## Why there is no floating point anywhere
 *
 * Interest is `applyRateBps`, which multiplies in `BigInt` and divides once
 * with explicit half-up rounding. Principal and per-loan interest are split
 * with `divideEvenly`, which is `BigInt` division plus an exact remainder
 * distribution. There is no decimal literal, no `parseFloat`, and no division
 * by a non-integer in this file — `npm run audit:money` enforces that
 * mechanically.
 */

import {
  calculateLoan,
  MAX_SUPPORTED_TERM_MONTHS,
  type LoanPeriod,
} from '@/lib/domain/loan';
import {
  applyRateBps,
  divideEvenly,
  sumUgx,
  toUgx,
  type UgxAmount,
} from '@/lib/domain/money';
import { MAX_BPS } from '@/lib/domain/rate';
import type { MemberInterestBasis, MemberInterestMethod } from '@/lib/domain/membership';
import type { MonthAnchor } from '@/lib/domain/repayment-schedule';

// ---------------------------------------------------------------------------
// The interest grid
// ---------------------------------------------------------------------------

/**
 * The four combinations of undecided questions 1 and 2, and which are defined.
 *
 * Three cells are well-defined arithmetic. `per_loan` + `reducing_balance_monthly`
 * is not a calculation anybody has described: a reducing-balance method charges
 * a rate on each period's opening balance, so "once over the loan" could mean
 * the rate divided by the term, the rate on the average outstanding balance,
 * or the rate on the original principal — three different prices, none stated.
 * It is refused, following the precedent Phase 2 set for `above_pledged`.
 *
 * `public.member_loan_interest` refuses exactly the same cell, in the same
 * words, and a database test asserts the two refusals agree.
 */
export const MEMBER_INTEREST_COMBINATIONS = [
  { basis: 'per_month', method: 'reducing_balance_monthly', supported: true },
  { basis: 'per_month', method: 'flat', supported: true },
  { basis: 'per_loan', method: 'flat', supported: true },
  { basis: 'per_loan', method: 'reducing_balance_monthly', supported: false },
] as const satisfies readonly {
  readonly basis: MemberInterestBasis;
  readonly method: MemberInterestMethod;
  readonly supported: boolean;
}[];

export function isSupportedMemberInterestCombination(
  basis: MemberInterestBasis,
  method: MemberInterestMethod,
): boolean {
  return MEMBER_INTEREST_COMBINATIONS.some(
    (combination) =>
      combination.basis === basis &&
      combination.method === method &&
      combination.supported,
  );
}

export const UNSUPPORTED_COMBINATION_MESSAGE =
  'A rate charged once over the loan on a reducing balance is not a calculation ' +
  'the business has described. A reducing-balance method charges a rate on each ' +
  "period's opening balance, so “once over the loan” could mean the rate " +
  'divided by the term, the rate applied to the average outstanding balance, or ' +
  'the rate applied to the original principal — three different prices. The ' +
  'client must settle which, or choose the flat method.';

export class MemberLoanError extends Error {
  readonly code: MemberLoanFailureCode;

  constructor(code: MemberLoanFailureCode, message: string) {
    super(message);
    this.name = 'MemberLoanError';
    this.code = code;
  }
}

export const MEMBER_LOAN_FAILURE_CODES = [
  'basis_undecided',
  'method_undecided',
  'combination_undefined',
  'invalid_principal',
  'invalid_rate',
  'invalid_term',
] as const;

export type MemberLoanFailureCode = (typeof MEMBER_LOAN_FAILURE_CODES)[number];

export interface MemberLoanCalculationInput {
  readonly principal: UgxAmount;
  /** The policy version's member rate, in basis points. 5% is 500. */
  readonly interestRateBps: number;
  readonly termMonths: number;
  /** `null` means undecided — question 1. Nothing here defaults it. */
  readonly interestBasis: MemberInterestBasis | null;
  /** `null` means undecided — question 2. Nothing here defaults it. */
  readonly interestMethod: MemberInterestMethod | null;
}

export interface MemberLoanCalculation {
  readonly periods: readonly LoanPeriod[];
  readonly principal: UgxAmount;
  readonly totalInterest: UgxAmount;
  readonly totalExpectedRepayment: UgxAmount;
  readonly interestBasis: MemberInterestBasis;
  readonly interestMethod: MemberInterestMethod;
  readonly interestRateBps: number;
  readonly termMonths: number;
}

/**
 * The contractual monthly breakdown of a member loan.
 *
 * Worked examples, UGX 500,000 over 2 months at 5% (500 bp):
 *
 * | Basis | Method | Interest period 1 | Interest period 2 | Total interest |
 * | --- | --- | --- | --- | --- |
 * | per_month | reducing_balance_monthly | 25,000 | 12,500 | 37,500 |
 * | per_month | flat | 25,000 | 25,000 | 50,000 |
 * | per_loan | flat | 12,500 | 12,500 | 25,000 |
 *
 * The first row is the existing engine: `calculateLoan` is **called**, not
 * reimplemented, which is what makes an ordinary loan and a per-month
 * reducing-balance member loan of the same principal, rate and term produce
 * identical figures by construction rather than by two functions agreeing.
 *
 * @throws MemberLoanError on an undecided basis or method, on the undefined
 *   combination, or on an input the engine cannot compute.
 */
export function calculateMemberLoan(
  input: MemberLoanCalculationInput,
): MemberLoanCalculation {
  const { principal, interestRateBps, termMonths, interestBasis, interestMethod } = input;

  if (interestBasis === null) {
    throw new MemberLoanError(
      'basis_undecided',
      'Whether the member interest rate is charged per month or once over the loan ' +
        'has not been decided, so a member loan cannot be priced.',
    );
  }

  if (interestMethod === null) {
    throw new MemberLoanError(
      'method_undecided',
      'Whether member interest is flat on the original principal or on a reducing ' +
        'balance has not been decided, so a member loan cannot be priced.',
    );
  }

  if (!isSupportedMemberInterestCombination(interestBasis, interestMethod)) {
    throw new MemberLoanError('combination_undefined', UNSUPPORTED_COMBINATION_MESSAGE);
  }

  if (!Number.isInteger(principal) || principal <= 0) {
    throw new MemberLoanError(
      'invalid_principal',
      `A loan principal must be a positive whole number of shillings, received ${String(principal)}.`,
    );
  }

  if (!Number.isInteger(interestRateBps) || interestRateBps < 0) {
    throw new MemberLoanError(
      'invalid_rate',
      `An interest rate must be a non-negative whole number of basis points, received ${String(interestRateBps)}.`,
    );
  }

  if (interestRateBps > MAX_BPS) {
    throw new MemberLoanError(
      'invalid_rate',
      `An interest rate of ${String(interestRateBps)} basis points is beyond the supported range.`,
    );
  }

  if (!Number.isInteger(termMonths) || termMonths < 1) {
    throw new MemberLoanError(
      'invalid_term',
      `A loan term must be a positive whole number of months, received ${String(termMonths)}.`,
    );
  }

  if (termMonths > MAX_SUPPORTED_TERM_MONTHS) {
    throw new MemberLoanError(
      'invalid_term',
      `A term of ${String(termMonths)} months is beyond the supported range of ${String(MAX_SUPPORTED_TERM_MONTHS)}.`,
    );
  }

  // --- The delegated cell --------------------------------------------------
  if (interestBasis === 'per_month' && interestMethod === 'reducing_balance_monthly') {
    const existing = calculateLoan({
      principal,
      monthlyInterestRateBps: interestRateBps,
      termMonths,
    });

    return {
      periods: existing.periods,
      principal: existing.principal,
      totalInterest: existing.totalInterest,
      totalExpectedRepayment: existing.totalExpectedRepayment,
      interestBasis,
      interestMethod,
      interestRateBps,
      termMonths,
    };
  }

  // --- Flat, on either basis ----------------------------------------------
  // Level principal portions, remainder in the final periods, which is the
  // rule every allocation in this system uses.
  const principalPortions = divideEvenly(principal, termMonths, { remainder: 'last' });

  // Flat means charged on the **original** principal, never on what is left.
  const flatCharge = applyRateBps(principal, interestRateBps, 'half-up');

  const interestPortions =
    interestBasis === 'per_loan'
      ? // Charged once and spread, so the periods sum to the total exactly and
        // the final period carries the odd shilling.
        divideEvenly(flatCharge, termMonths, { remainder: 'last' })
      : // Charged every month, at the same figure. No division, no remainder.
        Array.from({ length: termMonths }, () => flatCharge);

  const periods: LoanPeriod[] = [];
  let openingPrincipal = principal;

  for (let index = 0; index < termMonths; index += 1) {
    const principalPortion = principalPortions[index] ?? toUgx(0);
    const interest = interestPortions[index] ?? toUgx(0);
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

  if (openingPrincipal !== 0) {
    throw new MemberLoanError(
      'invalid_principal',
      `Loan breakdown did not fully allocate the principal; ${String(openingPrincipal)} remains.`,
    );
  }

  const totalInterest = sumUgx(periods.map((period) => period.interest));

  return {
    periods,
    principal,
    totalInterest,
    totalExpectedRepayment: toUgx(principal + totalInterest),
    interestBasis,
    interestMethod,
    interestRateBps,
    termMonths,
  };
}

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

/**
 * How much a member's savings support, before any other limit.
 *
 * `null` when the multiplier is undecided, and that is the whole point: a
 * figure here would be an invented credit limit, and an interface showing one
 * would have staff quoting it to members.
 *
 * The base is the savings **available** — the balance less what already
 * secures a live member loan and less anything awaiting payment as a
 * withdrawal. A member who saved UGX 600,000 and withdrew UGX 500,000 has
 * UGX 100,000 securing a loan.
 * `public.member_loan_eligibility_of` computes the same figure the same way.
 *
 * ## Why this rounds **down** and not half-up
 *
 * Because a ceiling and a pledge have to agree, and rounding them the same way
 * makes them disagree. A pledge is `principal / multiplier` rounded **up**, so
 * that rounding can only over-pledge — under-pledging by a shilling would let
 * two loans between them consume more capacity than the member has. If the
 * ceiling rounded half-up as well, then at a multiplier below 1x a loan taken
 * at exactly the ceiling would pledge one shilling more than the member holds,
 * and `approve_loan`'s own invariant would refuse a legitimate approval.
 *
 * Worked: savings of 333,333 at 5,000 bp (0.5x). Half-up gives a ceiling of
 * 166,667, whose pledge is 333,334 — one shilling more than is there.
 * Flooring gives 166,666, whose pledge is 333,332. Found by the property test
 * below, which is why it is a property test.
 *
 * Rounding a maximum down is also the right direction on its own terms: a
 * ceiling rounded up grants a shilling nobody authorised.
 */
export function memberLoanCeiling(
  eligibleSavings: UgxAmount,
  multiplierBps: number | null,
): UgxAmount | null {
  if (multiplierBps === null) return null;

  if (!Number.isInteger(multiplierBps) || multiplierBps <= 0) {
    throw new MemberLoanError(
      'invalid_rate',
      `A savings-to-loan multiplier must be a positive whole number of basis points, received ${String(multiplierBps)}.`,
    );
  }

  return applyRateBps(eligibleSavings, multiplierBps, 'down');
}

/**
 * The savings capacity a loan of this principal consumes under a multiplier.
 *
 * The multiplier read in the other direction: if savings of S support a loan
 * of S x M, then a loan of P consumed P / M. Rounded **up**, so rounding can
 * only ever over-pledge — under-pledging by a shilling would let two loans
 * between them consume more capacity than the member has.
 *
 * Mirrors the `member_loan_pledges_amount_follows` CHECK constraint exactly,
 * which is what stops a pledge row existing whose figure does not follow from
 * its own inputs.
 */
export function pledgedSavingsForLoan(
  principal: UgxAmount,
  multiplierBps: number,
): UgxAmount {
  if (!Number.isInteger(multiplierBps) || multiplierBps <= 0) {
    throw new MemberLoanError(
      'invalid_rate',
      `A savings-to-loan multiplier must be a positive whole number of basis points, received ${String(multiplierBps)}.`,
    );
  }

  if (!Number.isInteger(principal) || principal <= 0) {
    throw new MemberLoanError(
      'invalid_principal',
      `A loan principal must be a positive whole number of shillings, received ${String(principal)}.`,
    );
  }

  // Ceiling division in BigInt: (a + b - 1) / b.
  const numerator = BigInt(principal) * 10_000n;
  const divisor = BigInt(multiplierBps);

  return toUgx(Number((numerator + divisor - 1n) / divisor));
}

/**
 * Which cadence a member loan of this term must be collected on.
 *
 * The confirmed rule: weekly up to the policy version's weekly boundary
 * (`member_loan_weekly_cadence_max_months`, 2), calendar-monthly beyond it.
 * Mirrors `public.member_loan_cadence_for_term`.
 */
export function requiredMemberCadence(
  termMonths: number,
  weeklyCadenceMaxMonths: number,
): 'weekly' | 'monthly' {
  return termMonths <= weeklyCadenceMaxMonths ? 'weekly' : 'monthly';
}

// ---------------------------------------------------------------------------
// The assessment, as the interface reads it
// ---------------------------------------------------------------------------

export interface MemberLoanEligibility {
  readonly clientId: string;
  readonly membershipId: string | null;
  readonly membershipNumber: string | null;
  readonly membershipStatus: string | null;
  readonly policyVersionId: string | null;
  readonly policyVersion: string | null;
  readonly asOf: string;
  readonly savingsAccountId: string | null;
  readonly savingsAccountNumber: string | null;
  readonly savingsAccountStatus: string | null;
  readonly monthsRequired: number | null;
  readonly mustBeConsecutive: boolean | null;
  readonly qualifyingMonths: number | null;
  readonly consecutiveQualifyingMonths: number | null;
  readonly savingsQualifies: boolean | null;
  readonly eligibleSavings: UgxAmount | null;
  readonly multiplierBps: number | null;
  readonly maxEligibleLoan: UgxAmount | null;
  readonly maxTermMonths: number | null;
  readonly requiredCadence: string | null;
  readonly activeLoanCount: number | null;
  readonly activeLoanLimit: number | null;
  readonly outstandingPrincipal: UgxAmount | null;
  readonly pledgedSavings: UgxAmount | null;
  /** Asked for and approved, but not yet paid. Still in the balance. */
  readonly pendingWithdrawals: UgxAmount | null;
  /** The balance less what is pledged and less what is awaiting payment. */
  readonly availableSavings: UgxAmount | null;
  readonly amountRequested: UgxAmount | null;
  readonly termRequested: number | null;
  readonly isEligible: boolean;
  readonly mayProceed: boolean;
  readonly blockingReasons: readonly string[];
}

/**
 * The terms a member loan would carry, or why it cannot be priced.
 *
 * One function, so the application form, the approval screen and the preview
 * all say the same thing about an undecided policy rather than each wording a
 * guess of their own.
 */
export interface MemberLoanQuote {
  readonly priced: boolean;
  readonly calculation: MemberLoanCalculation | null;
  /** Present exactly when `priced` is false. */
  readonly blockedReason: string | null;
}

export function quoteMemberLoan(input: MemberLoanCalculationInput): MemberLoanQuote {
  try {
    return {
      priced: true,
      calculation: calculateMemberLoan(input),
      blockedReason: null,
    };
  } catch (error) {
    if (error instanceof MemberLoanError) {
      return { priced: false, calculation: null, blockedReason: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The unresolved decisions, named for the interface
// ---------------------------------------------------------------------------

/**
 * The decisions member lending is waiting on, in the words a screen shows.
 *
 * Three are the policy questions Phase 1 recorded as nullable columns. The
 * fourth is the monthly collection anchor, which is **not** one of the nine:
 * it is a property of the cadence rather than of the membership programme, so
 * it lives on `repayment_frequencies` and is listed here because a reader
 * planning the work needs all four in one place. See ADR-059.
 */
export const MEMBER_LENDING_DECISIONS = [
  {
    key: 'interest_basis',
    question: 'Is the 5% member rate charged per month, or once over the whole loan?',
    consequence:
      'On a five-month loan the difference is five-fold. Nothing can be priced without it.',
    home: 'membership_policy_versions.interest_basis',
  },
  {
    key: 'interest_method',
    question:
      'Is member interest flat on the original principal, or on a reducing balance?',
    consequence:
      'Flat charges the same interest every month; reducing balance charges less as the ' +
      'principal falls. Both are implemented and neither is a default.',
    home: 'membership_policy_versions.interest_method',
  },
  {
    key: 'savings_to_loan_multiplier_bps',
    question: 'What multiple of their savings may a qualified member borrow?',
    consequence:
      'This is the whole eligibility formula. Until it is set, no ceiling can be shown ' +
      'and no member loan can be approved.',
    home: 'membership_policy_versions.savings_to_loan_multiplier_bps',
  },
  {
    key: 'month_anchor',
    question:
      'When a monthly collection day does not exist in a later month — a loan ' +
      'disbursed on 31 January, say — does the collection fall on the last day of ' +
      'that month, or on the first day of the next?',
    consequence:
      'Calendar-monthly collection cannot be scheduled without it, so member loans of ' +
      'three to five months cannot be approved.',
    home: 'repayment_frequencies.month_anchor',
  },
] as const;

export type MemberLendingDecisionKey = (typeof MEMBER_LENDING_DECISIONS)[number]['key'];

export interface MemberLendingReadiness {
  /** The decisions still open, in the order above. */
  readonly outstanding: readonly MemberLendingDecisionKey[];
  readonly isReady: boolean;
}

/**
 * Which of the four member-lending decisions are still open.
 *
 * Takes the state rather than reading it, so it is testable and so the one
 * caller that has the policy row and the cadence row decides what to pass.
 * A decided `false` and a decided `0` both count as decided, which is the
 * same rule `outstandingPolicyDecisions` applies to the nine.
 */
export function memberLendingReadiness(state: {
  readonly interestBasis: MemberInterestBasis | null;
  readonly interestMethod: MemberInterestMethod | null;
  readonly savingsToLoanMultiplierBps: number | null;
  readonly monthAnchor: MonthAnchor | null;
}): MemberLendingReadiness {
  const outstanding: MemberLendingDecisionKey[] = [];

  if (state.interestBasis === null) outstanding.push('interest_basis');
  if (state.interestMethod === null) outstanding.push('interest_method');
  if (state.savingsToLoanMultiplierBps === null) {
    outstanding.push('savings_to_loan_multiplier_bps');
  }
  if (state.monthAnchor === null) outstanding.push('month_anchor');

  return { outstanding, isReady: outstanding.length === 0 };
}
