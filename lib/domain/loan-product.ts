/**
 * Loan products: what the business sells, and the vocabulary for describing it.
 *
 * ## Precedence, which is the thing to understand before reading anything else
 *
 * Two places hold lending rules, and the rule about the rules is stated once
 * at the head of migration `20261012000200`. In short:
 *
 *   1. `business_settings` is the **guard rail**. Its amount range, term
 *      range, interest ceiling and penalty ceiling bound what any product may
 *      offer, and a trigger refuses a product that steps outside them.
 *   2. The **product** is the source of truth for a loan: inside the guard
 *      rail it decides the amount range, the rate and its band, the method,
 *      the durations, the cadences, the grace period, the penalty, whether a
 *      guarantor or collateral is required, and what happens on early or
 *      extra payment.
 *   3. `max_active_loans_per_client` stays **global and only global** — it is
 *      a fact about the borrower, not the product.
 *   4. At approval the effective terms are **snapshotted** onto
 *      `loan_product_snapshots` and nothing afterwards rewrites them.
 *
 * Nothing in this module evaluates any of that. The labels are for reading;
 * the rules are enforced in the database, where they hold for the application
 * and for anything else that connects.
 */

/** Whether a product may be chosen for a new application. */
export const PRODUCT_STATUSES = ['active', 'inactive'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_STATUS_LABELS: Readonly<Record<ProductStatus, string>> = {
  active: 'Offered',
  // Not "deleted" and not "archived": an inactive product keeps every loan
  // ever written under it, and its snapshots keep its terms. What changes is
  // that it cannot be chosen again.
  inactive: 'Withdrawn',
};

/**
 * How interest is computed.
 *
 * One method, and a column rather than a constant, because the schema has
 * carried `interest_method` on every loan since Phase 4 and the engine reads
 * it. A second method is a change to the engine, not to a dropdown.
 */
export const INTEREST_METHODS = ['reducing_balance_monthly'] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

export const INTEREST_METHOD_LABELS: Readonly<Record<InterestMethod, string>> = {
  reducing_balance_monthly: 'Reducing balance, monthly',
};

/** How a late-payment charge is computed. */
export const PENALTY_METHODS = ['one_time_percent_of_outstanding'] as const;
export type PenaltyMethod = (typeof PENALTY_METHODS)[number];

export const PENALTY_METHOD_LABELS: Readonly<Record<PenaltyMethod, string>> = {
  one_time_percent_of_outstanding: 'Once, on the balance outstanding',
};

/** What happens when a borrower clears a loan ahead of its final date. */
export const EARLY_REPAYMENT_OPTIONS = [
  'allowed_no_rebate',
  'allowed_with_rebate',
  'not_allowed',
] as const;
export type EarlyRepayment = (typeof EARLY_REPAYMENT_OPTIONS)[number];

export const EARLY_REPAYMENT_LABELS: Readonly<Record<EarlyRepayment, string>> = {
  allowed_no_rebate: 'Allowed, interest unchanged',
  allowed_with_rebate: 'Allowed, with an interest rebate',
  not_allowed: 'Not allowed',
};

export const EARLY_REPAYMENT_HINTS: Readonly<Record<EarlyRepayment, string>> = {
  allowed_no_rebate:
    'The borrower may settle early and still owes the interest the agreement set out.',
  allowed_with_rebate:
    'The borrower may settle early and part of the remaining interest is forgiven.',
  not_allowed: 'The agreement runs to its final collection date.',
};

/** What happens when a borrower pays more than the instalment asks for. */
export const EXTRA_PAYMENT_OPTIONS = [
  'reduces_balance',
  'advances_schedule',
  'not_allowed',
] as const;
export type ExtraPayment = (typeof EXTRA_PAYMENT_OPTIONS)[number];

export const EXTRA_PAYMENT_LABELS: Readonly<Record<ExtraPayment, string>> = {
  reduces_balance: 'Reduces the balance',
  advances_schedule: 'Pays the next collections forward',
  not_allowed: 'Not accepted',
};

/**
 * Which questions the application asks.
 *
 * A Salary Loan asks for an employer and a payslip; a Business Loan asks for
 * turnover and a trading licence. Those are different questions, not
 * different columns on `loans` — the product names a profile and Phase 4
 * hangs the answers off the loan in their own typed table.
 */
export const APPLICATION_PROFILES = [
  'individual',
  'salary',
  'business',
  'quick',
] as const;
export type ApplicationProfile = (typeof APPLICATION_PROFILES)[number];

export const APPLICATION_PROFILE_LABELS: Readonly<Record<ApplicationProfile, string>> = {
  individual: 'Individual',
  salary: 'Salaried employment',
  business: 'Business',
  quick: 'Quick advance',
};

export const APPLICATION_PROFILE_HINTS: Readonly<Record<ApplicationProfile, string>> = {
  individual: 'The standard application.',
  salary: 'Also asks for the employer, the pay date and the evidence of both.',
  business: 'Also asks for the business, its turnover and what the money is for.',
  quick:
    'A shorter application. Approval is unchanged — every check a longer application faces, this one faces too.',
};

/**
 * A product as the catalogue view returns it.
 *
 * `branchIds` is null when the product is sold at every branch, which is what
 * no rows in the join table means and what a single-branch business always
 * wants.
 */
export interface LoanProduct {
  readonly productId: string;
  readonly productCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProductStatus;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly defaultInterestRateBps: number;
  readonly minInterestRateBps: number;
  readonly maxInterestRateBps: number;
  readonly interestMethod: string;
  readonly interestOverrideAllowed: boolean;
  readonly interestOverrideRoles: readonly string[];
  readonly minTermMonths: number;
  readonly maxTermMonths: number;
  readonly allowedTermMonths: readonly number[] | null;
  readonly allowedRepaymentFrequencies: readonly string[];
  readonly defaultRepaymentFrequency: string;
  readonly gracePeriodDays: number;
  readonly penaltyRateBps: number;
  readonly penaltyMethod: string;
  readonly guarantorRequired: boolean;
  readonly minGuarantors: number;
  readonly collateralRequired: boolean;
  readonly earlyRepayment: string;
  readonly extraPayment: string;
  readonly applicationProfile: string;
  readonly requiresSupportingDocuments: boolean;
  readonly branchIds: readonly string[] | null;
  /** How many loans have been written against it. Nothing may delete it. */
  readonly loansWritten: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A label for a value that came from the database and might be unknown. */
export function labelFor<Key extends string>(
  labels: Readonly<Record<Key, string>>,
  value: string,
): string {
  return (labels as Readonly<Record<string, string>>)[value] ?? value;
}

/**
 * The durations a product offers, in words.
 *
 * A named menu reads as the menu; an open range reads as the range. Said
 * once here because the list, the form and the loan application all have to
 * say the same thing.
 */
export function describeTerms(product: {
  readonly minTermMonths: number;
  readonly maxTermMonths: number;
  readonly allowedTermMonths: readonly number[] | null;
}): string {
  if (product.allowedTermMonths !== null && product.allowedTermMonths.length > 0) {
    const months = [...product.allowedTermMonths].sort((a, b) => a - b);
    return months.length === 1
      ? `${String(months[0])} month${months[0] === 1 ? '' : 's'}`
      : `${months.map(String).join(', ')} months`;
  }

  if (product.minTermMonths === product.maxTermMonths) {
    return `${String(product.minTermMonths)} month${product.minTermMonths === 1 ? '' : 's'}`;
  }

  return `${String(product.minTermMonths)} to ${String(product.maxTermMonths)} months`;
}

/** Whether a product may be chosen for a new application today. */
export function isSellable(product: { readonly status: string }): boolean {
  return product.status === 'active';
}
