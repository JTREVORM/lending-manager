import 'server-only';

import { logger } from '@/lib/logger';
import { mapDatabaseError } from '@/lib/db-errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import { isMonthAnchor, type MonthAnchor } from '@/lib/domain/repayment-schedule';
import {
  isMemberInterestBasis,
  isMemberInterestMethod,
  type MemberInterestBasis,
  type MemberInterestMethod,
} from '@/lib/domain/membership';
import type { MemberLoanEligibility } from '@/lib/domain/member-loan';

/**
 * Reading member loans and member-loan eligibility.
 *
 * Every query runs as the signed-in caller, so Row Level Security decides what
 * comes back. Nothing here uses the privileged client.
 *
 * ## Why an absent figure is not an error
 *
 * Three of these reads come back empty or null for a caller the policies
 * refuse, and that is the designed outcome rather than a fault: a Secretary
 * opening the Member Loans dashboard sees the panels they are entitled to and
 * not a failed page. The capability is checked inside the database function,
 * so none of these can be talked into returning a figure by being called
 * differently.
 *
 * ## Why the ceiling can be null even on a successful read
 *
 * Because the savings-to-loan multiplier is undecided. A null ceiling is the
 * truthful answer and the interface says which decision is missing; it is not
 * a read that failed, and nothing here substitutes a default.
 */

const MEMBER_LOAN_PAGE_SIZE = 20;

/** `null` where the database returned null, and a branded amount otherwise. */
function optionalAmount(value: unknown): UgxAmount | null {
  if (value === null || value === undefined) return null;
  return toUgx(Number(value));
}

function requiredAmount(value: unknown): UgxAmount {
  return toUgx(Number(value ?? 0));
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

/**
 * A text column, as text.
 *
 * `String(value)` would stringify an object to `[object Object]`, which is how
 * a mapping bug reaches a screen looking like data. A text column holding
 * anything but a string is a defect, so the non-string case comes back null
 * and renders as an absence rather than as nonsense.
 */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requiredText(value: unknown): string {
  return optionalText(value) ?? '';
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export interface MemberLoanSummary {
  readonly applicationsDraft: number;
  readonly applicationsPending: number;
  readonly loansApproved: number;
  readonly loansActive: number;
  readonly loansCleared: number;

  readonly principalDisbursed: UgxAmount;
  readonly principalOutstanding: UgxAmount;
  readonly interestOutstanding: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly totalCollected: UgxAmount;

  readonly dueToday: UgxAmount;
  readonly overdueLoans: number;
  readonly arrearsAmount: UgxAmount;

  readonly liveMemberships: number;
  readonly membersQualified: number;
  readonly membersNotYetQualified: number;
  readonly membersWithMemberLoan: number;

  readonly savingsPledged: UgxAmount;

  readonly lendingOpen: boolean;
  readonly blockedReason: string | null;
}

/**
 * The member loan position, for the dashboard.
 *
 * `null` when the caller does not hold `loans:view`, rather than a thrown
 * error. The capability is checked inside `member_loan_summary`.
 */
export async function getMemberLoanSummary(): Promise<MemberLoanSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('member_loan_summary');

  if (error !== null) {
    logger.debug('The member loan summary was not available to this caller.', {
      code: error.code,
    });
    return null;
  }

  const row = (data ?? [])[0];
  if (row === undefined) return null;

  return {
    applicationsDraft: Number(row.applications_draft ?? 0),
    applicationsPending: Number(row.applications_pending ?? 0),
    loansApproved: Number(row.loans_approved ?? 0),
    loansActive: Number(row.loans_active ?? 0),
    loansCleared: Number(row.loans_cleared ?? 0),

    principalDisbursed: requiredAmount(row.principal_disbursed),
    principalOutstanding: requiredAmount(row.principal_outstanding),
    interestOutstanding: requiredAmount(row.interest_outstanding),
    totalOutstanding: requiredAmount(row.total_outstanding),
    totalCollected: requiredAmount(row.total_collected),

    dueToday: requiredAmount(row.due_today),
    overdueLoans: Number(row.overdue_loans ?? 0),
    arrearsAmount: requiredAmount(row.arrears_amount),

    liveMemberships: Number(row.live_memberships ?? 0),
    membersQualified: Number(row.members_qualified ?? 0),
    membersNotYetQualified: Number(row.members_not_yet_qualified ?? 0),
    membersWithMemberLoan: Number(row.members_with_member_loan ?? 0),

    savingsPledged: requiredAmount(row.savings_pledged),

    lendingOpen: row.lending_open === true,
    blockedReason: row.blocked_reason,
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Whether a client may take a member loan, and how much.
 *
 * `amount` and `termMonths` are optional: without them the answer is "may this
 * member borrow at all", which is what the eligibility panel asks. With them
 * it is "may this member borrow *this*", which is what the application form
 * asks — and the same question `validate_loan_for_approval` asks again at
 * approval, from the loan's own figures rather than from anything a form sent.
 *
 * Returns `null` when the caller may not read an assessment: the function
 * raises, and an absent panel is the right outcome for a screen the caller is
 * otherwise entitled to.
 */
export async function assessMemberLoanEligibility(
  clientId: string,
  request?: {
    readonly amount?: number | null;
    readonly termMonths?: number | null;
    readonly repaymentFrequency?: string | null;
    readonly asOf?: string | null;
  },
): Promise<MemberLoanEligibility | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('assess_member_loan_eligibility', {
    p_client_id: clientId,
    p_amount: request?.amount ?? null,
    p_term_months: request?.termMonths ?? null,
    p_repayment_frequency: request?.repaymentFrequency ?? null,
    p_as_of: request?.asOf ?? null,
  });

  if (error !== null) {
    logger.debug('A member loan eligibility assessment was not available.', {
      code: error.code,
    });
    return null;
  }

  const row = (data ?? [])[0];
  if (row === undefined) return null;

  return {
    clientId: String(row.client_id ?? clientId),
    membershipId: row.membership_id,
    membershipNumber: row.membership_number,
    membershipStatus: row.membership_status,
    policyVersionId: row.policy_version_id,
    policyVersion: row.policy_version,
    asOf: requiredText(row.as_of),
    savingsAccountId: row.savings_account_id,
    savingsAccountNumber: row.savings_account_number,
    savingsAccountStatus: row.savings_account_status,
    monthsRequired: optionalNumber(row.months_required),
    mustBeConsecutive: row.must_be_consecutive,
    qualifyingMonths: optionalNumber(row.qualifying_months),
    consecutiveQualifyingMonths: optionalNumber(row.consecutive_qualifying_months),
    savingsQualifies: row.savings_qualifies,
    eligibleSavings: optionalAmount(row.eligible_savings),
    multiplierBps: optionalNumber(row.multiplier_bps),
    maxEligibleLoan: optionalAmount(row.max_eligible_loan),
    maxTermMonths: optionalNumber(row.max_term_months),
    requiredCadence: row.required_cadence,
    activeLoanCount: optionalNumber(row.active_loan_count),
    activeLoanLimit: optionalNumber(row.active_loan_limit),
    outstandingPrincipal: optionalAmount(row.outstanding_principal),
    pledgedSavings: optionalAmount(row.pledged_savings),
    pendingWithdrawals: optionalAmount(row.pending_withdrawals),
    availableSavings: optionalAmount(row.available_savings),
    amountRequested: optionalAmount(row.amount_requested),
    termRequested: optionalNumber(row.term_requested),
    isEligible: row.is_eligible === true,
    mayProceed: row.may_proceed === true,
    blockingReasons: row.blocking_reasons ?? [],
  };
}

// ---------------------------------------------------------------------------
// The eligibility register
// ---------------------------------------------------------------------------

export interface MemberEligibilityRow {
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly clientId: string;
  readonly fullName: string;
  readonly clientNumber: string;
  readonly membershipStatus: string;
  readonly policyVersion: string;
  readonly monthsRequired: number;
  readonly qualifyingMonths: number;
  readonly savingsMonthsMet: boolean;
  readonly eligibleSavings: UgxAmount;
  readonly pledgedSavings: UgxAmount;
  readonly pendingWithdrawals: UgxAmount;
  readonly availableSavings: UgxAmount;
  readonly multiplierBps: number | null;
  readonly maxEligibleLoan: UgxAmount | null;
  readonly activeLoanCount: number;
  readonly memberLoanCount: number;
  readonly activeLoanLimit: number;
  readonly policyLendingOpen: boolean;
}

export interface MemberEligibilityPage {
  readonly rows: readonly MemberEligibilityRow[];
  readonly page: number;
  readonly hasMore: boolean;
}

const ELIGIBILITY_SORTS = ['savings', 'name', 'months'] as const;
export type EligibilitySort = (typeof ELIGIBILITY_SORTS)[number];

export function isEligibilitySort(value: unknown): value is EligibilitySort {
  return (
    typeof value === 'string' && (ELIGIBILITY_SORTS as readonly string[]).includes(value)
  );
}

function toEligibilityRow(row: Record<string, unknown>): MemberEligibilityRow {
  return {
    membershipId: requiredText(row.membership_id),
    membershipNumber: requiredText(row.membership_number),
    clientId: requiredText(row.client_id),
    fullName: requiredText(row.full_name),
    clientNumber: requiredText(row.client_number),
    membershipStatus: requiredText(row.membership_status),
    policyVersion: requiredText(row.policy_version),
    monthsRequired: Number(row.months_required ?? 0),
    qualifyingMonths: Number(row.qualifying_months ?? 0),
    savingsMonthsMet: row.savings_months_met === true,
    eligibleSavings: requiredAmount(row.eligible_savings),
    pledgedSavings: requiredAmount(row.pledged_savings),
    pendingWithdrawals: requiredAmount(row.pending_withdrawals),
    availableSavings: requiredAmount(row.available_savings),
    multiplierBps: optionalNumber(row.multiplier_bps),
    maxEligibleLoan: optionalAmount(row.max_eligible_loan),
    activeLoanCount: Number(row.active_loan_count ?? 0),
    memberLoanCount: Number(row.member_loan_count ?? 0),
    activeLoanLimit: Number(row.active_loan_limit ?? 0),
    policyLendingOpen: row.policy_lending_open === true,
  };
}

/**
 * Which members qualify, and what their savings support.
 *
 * Paged the way every register here is: one row more than the page needs is
 * fetched, and its presence is `hasMore`. No `count: 'exact'` — the Phase 18
 * rule, because a count is a second full scan for a figure nobody acts on.
 */
export async function listMemberEligibility(filter: {
  readonly query: string | null;
  readonly qualified: 'all' | 'qualified' | 'not_qualified';
  readonly sort: EligibilitySort;
  readonly page: number;
}): Promise<MemberEligibilityPage> {
  const supabase = await createSupabaseServerClient();

  const from = (filter.page - 1) * MEMBER_LOAN_PAGE_SIZE;

  let request = supabase
    .from('member_loan_eligibility')
    // One string literal, not a concatenation: Supabase's typed client parses
    // the column list at the type level and cannot see through a `+`.
    // prettier-ignore
    .select(
      'membership_id, membership_number, client_id, full_name, client_number, membership_status, policy_version, months_required, qualifying_months, savings_months_met, eligible_savings, pledged_savings, pending_withdrawals, available_savings, multiplier_bps, max_eligible_loan, active_loan_count, member_loan_count, active_loan_limit, policy_lending_open',
    )
    .range(from, from + MEMBER_LOAN_PAGE_SIZE);

  if (filter.query !== null && filter.query.trim() !== '') {
    const term = `%${filter.query.trim()}%`;
    request = request.or(
      `full_name.ilike.${term},membership_number.ilike.${term},client_number.ilike.${term}`,
    );
  }

  if (filter.qualified === 'qualified') {
    request = request.eq('savings_months_met', true);
  } else if (filter.qualified === 'not_qualified') {
    request = request.eq('savings_months_met', false);
  }

  if (filter.sort === 'name') {
    request = request.order('full_name', { ascending: true });
  } else if (filter.sort === 'months') {
    request = request.order('qualifying_months', { ascending: false });
  } else {
    request = request.order('eligible_savings', { ascending: false });
  }

  const { data, error } = await request;

  if (error !== null) {
    logger.warn('The member eligibility register could not be read.', {
      code: error.code,
    });
    return { rows: [], page: filter.page, hasMore: false };
  }

  const rows = data ?? [];
  const hasMore = rows.length > MEMBER_LOAN_PAGE_SIZE;

  return {
    rows: rows
      .slice(0, MEMBER_LOAN_PAGE_SIZE)
      .map((row) => toEligibilityRow(row as Record<string, unknown>)),
    page: filter.page,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// The member loan register
// ---------------------------------------------------------------------------

export interface MemberLoanRow {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly fullName: string;
  readonly clientNumber: string;
  readonly status: string;
  readonly principalAmount: UgxAmount;
  readonly interestRateBps: number;
  readonly interestBasis: MemberInterestBasis | null;
  readonly interestMethod: MemberInterestMethod | null;
  readonly loanTermMonths: number;
  readonly repaymentFrequency: string;
  readonly totalInterest: UgxAmount;
  readonly totalExpectedRepayment: UgxAmount;
  readonly approvedAt: string | null;
  readonly disbursedAt: string | null;
  readonly membershipId: string | null;
  readonly membershipNumber: string | null;
  readonly membershipStatus: string | null;
  readonly policyVersion: string | null;
  readonly savingsAccountId: string | null;
  readonly savingsAccountNumber: string | null;
  readonly eligibleSavings: UgxAmount | null;
  readonly multiplierBps: number | null;
  readonly maxEligibleLoan: UgxAmount | null;
  readonly qualifyingMonths: number | null;
  readonly monthsRequired: number | null;
  readonly pledgedAmount: UgxAmount | null;
  readonly pledgeReleasedAt: string | null;
  readonly principalRemaining: UgxAmount | null;
  readonly interestRemaining: UgxAmount | null;
  readonly penaltyRemaining: UgxAmount | null;
  readonly totalOutstanding: UgxAmount | null;
  readonly totalPaid: UgxAmount | null;
  readonly arrearsAmount: UgxAmount | null;
  readonly daysPastDue: number | null;
  readonly delinquencyState: string | null;
}

// One string literal, for the reason above.
// prettier-ignore
const MEMBER_LOAN_COLUMNS = 'loan_id, loan_number, client_id, full_name, client_number, status, principal_amount, interest_rate_bps, interest_basis, interest_method, loan_term_months, repayment_frequency, total_interest, total_expected_repayment, approved_at, disbursed_at, membership_id, membership_number, membership_status, policy_version, savings_account_id, savings_account_number, eligible_savings, multiplier_bps, max_eligible_loan, qualifying_months, months_required, pledged_amount, pledge_released_at, principal_remaining, interest_remaining, penalty_remaining, total_outstanding, total_paid, arrears_amount, days_past_due, delinquency_state';

function toMemberLoanRow(row: Record<string, unknown>): MemberLoanRow {
  return {
    loanId: requiredText(row.loan_id),
    loanNumber: requiredText(row.loan_number),
    clientId: requiredText(row.client_id),
    fullName: requiredText(row.full_name),
    clientNumber: requiredText(row.client_number),
    status: requiredText(row.status),
    principalAmount: requiredAmount(row.principal_amount),
    interestRateBps: Number(row.interest_rate_bps ?? 0),
    interestBasis: isMemberInterestBasis(row.interest_basis) ? row.interest_basis : null,
    interestMethod: isMemberInterestMethod(row.interest_method)
      ? row.interest_method
      : null,
    loanTermMonths: Number(row.loan_term_months ?? 0),
    repaymentFrequency: requiredText(row.repayment_frequency),
    totalInterest: requiredAmount(row.total_interest),
    totalExpectedRepayment: requiredAmount(row.total_expected_repayment),
    approvedAt: optionalText(row.approved_at),
    disbursedAt: optionalText(row.disbursed_at),
    membershipId: optionalText(row.membership_id),
    membershipNumber: optionalText(row.membership_number),
    membershipStatus: optionalText(row.membership_status),
    policyVersion: optionalText(row.policy_version),
    savingsAccountId: optionalText(row.savings_account_id),
    savingsAccountNumber: optionalText(row.savings_account_number),
    eligibleSavings: optionalAmount(row.eligible_savings),
    multiplierBps: optionalNumber(row.multiplier_bps),
    maxEligibleLoan: optionalAmount(row.max_eligible_loan),
    qualifyingMonths: optionalNumber(row.qualifying_months),
    monthsRequired: optionalNumber(row.months_required),
    pledgedAmount: optionalAmount(row.pledged_amount),
    pledgeReleasedAt: optionalText(row.pledge_released_at),
    principalRemaining: optionalAmount(row.principal_remaining),
    interestRemaining: optionalAmount(row.interest_remaining),
    penaltyRemaining: optionalAmount(row.penalty_remaining),
    totalOutstanding: optionalAmount(row.total_outstanding),
    totalPaid: optionalAmount(row.total_paid),
    arrearsAmount: optionalAmount(row.arrears_amount),
    daysPastDue: optionalNumber(row.days_past_due),
    delinquencyState: optionalText(row.delinquency_state),
  };
}

export interface MemberLoanPage {
  readonly rows: readonly MemberLoanRow[];
  readonly page: number;
  readonly hasMore: boolean;
}

export async function listMemberLoans(filter: {
  readonly query: string | null;
  readonly status: string;
  readonly page: number;
}): Promise<MemberLoanPage> {
  const supabase = await createSupabaseServerClient();

  const from = (filter.page - 1) * MEMBER_LOAN_PAGE_SIZE;

  let request = supabase
    .from('member_loan_register')
    .select(MEMBER_LOAN_COLUMNS)
    .order('created_at', { ascending: false })
    .range(from, from + MEMBER_LOAN_PAGE_SIZE);

  if (filter.query !== null && filter.query.trim() !== '') {
    const term = `%${filter.query.trim()}%`;
    request = request.or(
      `loan_number.ilike.${term},full_name.ilike.${term},membership_number.ilike.${term}`,
    );
  }

  if (filter.status !== 'all') {
    request = request.eq('status', filter.status);
  }

  const { data, error } = await request;

  if (error !== null) {
    logger.warn('The member loan register could not be read.', { code: error.code });
    return { rows: [], page: filter.page, hasMore: false };
  }

  const rows = data ?? [];
  const hasMore = rows.length > MEMBER_LOAN_PAGE_SIZE;

  return {
    rows: rows
      .slice(0, MEMBER_LOAN_PAGE_SIZE)
      .map((row) => toMemberLoanRow(row as Record<string, unknown>)),
    page: filter.page,
    hasMore,
  };
}

/** One member loan, with its frozen evidence. Null when the caller may not see it. */
export async function getMemberLoan(loanId: string): Promise<MemberLoanRow | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('member_loan_register')
    .select(MEMBER_LOAN_COLUMNS)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null || data === null) {
    if (error !== null) {
      logger.warn('A member loan could not be read.', { code: error.code });
    }
    return null;
  }

  return toMemberLoanRow(data);
}

// ---------------------------------------------------------------------------
// Readiness: what member lending is waiting for
// ---------------------------------------------------------------------------

export interface MemberLendingState {
  readonly policyVersionId: string | null;
  readonly policyVersion: string | null;
  readonly interestBasis: MemberInterestBasis | null;
  readonly interestMethod: MemberInterestMethod | null;
  readonly interestRateBps: number | null;
  readonly savingsToLoanMultiplierBps: number | null;
  readonly maxTermMonths: number | null;
  readonly weeklyCadenceMaxMonths: number | null;
  readonly monthAnchor: MonthAnchor | null;
  readonly monthlyCadenceOpen: boolean;
  readonly productActive: boolean;
}

/**
 * The configuration member lending depends on, read in one place.
 *
 * Four values decide whether a member loan can be priced and scheduled, and
 * they live in two tables: three on the in-force policy version and the
 * monthly collection anchor on the cadence. A screen that read them
 * separately would show a reader three of four and leave the fourth to be
 * discovered at the approval counter.
 */
export async function getMemberLendingState(): Promise<MemberLendingState> {
  const supabase = await createSupabaseServerClient();

  const [policyResult, cadenceResult, productResult] = await Promise.all([
    supabase
      .from('membership_policy_versions')
      // prettier-ignore
      .select(
        'id, version, interest_basis, interest_method, member_loan_interest_rate_bps, savings_to_loan_multiplier_bps, member_loan_max_term_months, member_loan_weekly_cadence_max_months',
      )
      .eq('status', 'active')
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('repayment_frequencies')
      .select('month_anchor, is_active')
      .eq('key', 'monthly')
      .maybeSingle(),
    supabase
      .from('loan_products')
      .select('status')
      .eq('product_code', 'ML')
      .maybeSingle(),
  ]);

  const policy = policyResult.data;
  const cadence = cadenceResult.data;

  return {
    policyVersionId: policy === null || policy === undefined ? null : String(policy.id),
    policyVersion:
      policy === null || policy === undefined ? null : String(policy.version),
    interestBasis:
      policy !== null &&
      policy !== undefined &&
      isMemberInterestBasis(policy.interest_basis)
        ? policy.interest_basis
        : null,
    interestMethod:
      policy !== null &&
      policy !== undefined &&
      isMemberInterestMethod(policy.interest_method)
        ? policy.interest_method
        : null,
    interestRateBps:
      policy === null || policy === undefined
        ? null
        : Number(policy.member_loan_interest_rate_bps),
    savingsToLoanMultiplierBps:
      policy === null || policy === undefined
        ? null
        : optionalNumber(policy.savings_to_loan_multiplier_bps),
    maxTermMonths:
      policy === null || policy === undefined
        ? null
        : Number(policy.member_loan_max_term_months),
    weeklyCadenceMaxMonths:
      policy === null || policy === undefined
        ? null
        : Number(policy.member_loan_weekly_cadence_max_months),
    monthAnchor:
      cadence !== null && cadence !== undefined && isMonthAnchor(cadence.month_anchor)
        ? cadence.month_anchor
        : null,
    monthlyCadenceOpen: cadence?.is_active === true,
    productActive: productResult.data?.status === 'active',
  };
}

// ---------------------------------------------------------------------------
// The repayment preview
// ---------------------------------------------------------------------------

export interface MemberLoanPreviewPeriod {
  readonly periodNumber: number;
  readonly openingPrincipal: UgxAmount;
  readonly principalPortion: UgxAmount;
  readonly interest: UgxAmount;
  readonly totalObligation: UgxAmount;
  readonly closingPrincipal: UgxAmount;
}

export interface MemberLoanPreview {
  readonly periods: readonly MemberLoanPreviewPeriod[];
  readonly totalInterest: UgxAmount;
  readonly totalExpectedRepayment: UgxAmount;
}

/**
 * The contractual breakdown a member loan would carry, from the database.
 *
 * Read from `member_loan_interest` rather than computed in the browser, so
 * staff see the authoritative figures. `lib/domain/member-loan.ts` computes
 * the same thing and a database test asserts they agree; this is the one the
 * screen shows, because it is the one approval will store.
 *
 * `null` when the policy cannot price the loan — the function raises, naming
 * the undecided decision, and the form shows that reason instead of a table.
 */
export async function previewMemberLoan(input: {
  readonly principal: number;
  readonly interestRateBps: number;
  readonly termMonths: number;
  readonly interestBasis: MemberInterestBasis;
  readonly interestMethod: MemberInterestMethod;
}): Promise<MemberLoanPreview | { readonly blockedReason: string }> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('member_loan_interest', {
    p_principal: input.principal,
    p_interest_rate_bps: input.interestRateBps,
    p_term_months: input.termMonths,
    p_interest_basis: input.interestBasis,
    p_interest_method: input.interestMethod,
  });

  if (error !== null) {
    logger.debug('A member loan could not be priced.', { code: error.code });
    return { blockedReason: mapDatabaseError(error).message };
  }

  const rows = data ?? [];

  const periods = rows.map((row): MemberLoanPreviewPeriod => ({
    periodNumber: Number(row.period_number),
    openingPrincipal: requiredAmount(row.opening_principal),
    principalPortion: requiredAmount(row.principal_portion),
    interest: requiredAmount(row.interest),
    totalObligation: requiredAmount(row.total_obligation),
    closingPrincipal: requiredAmount(row.closing_principal),
  }));

  const totalInterest = toUgx(
    periods.reduce((total, period) => total + period.interest, 0),
  );

  return {
    periods,
    totalInterest,
    totalExpectedRepayment: toUgx(input.principal + totalInterest),
  };
}

/** The business date, for an "as of" the interface can show. */
export async function memberLoanBusinessDate(): Promise<BusinessDate | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('business_date');

  if (error !== null || typeof data !== 'string') return null;

  return toBusinessDate(data);
}
