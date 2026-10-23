import 'server-only';

import { unstable_rethrow } from 'next/navigation';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { UGX_ZERO, fromDatabaseAmount, type UgxAmount } from '@/lib/domain/money';
import { fromDatabaseBps, toBps, type BasisPoints } from '@/lib/domain/rate';
import {
  isMembershipPolicyStatus,
  isMembershipStatus,
  type MemberInterestBasis,
  type MemberInterestMethod,
  type MembershipPolicyStatus,
  type MembershipStatus,
  type ProfitDistributionBasis,
  type SavingsWithdrawalRule,
} from '@/lib/domain/membership';
import type { MembershipSearchInput } from '@/lib/validation/membership';

/**
 * Reading memberships.
 *
 * Every query here runs as the signed-in caller through
 * `createSupabaseServerClient`, never through the privileged client. That is
 * the point, and it is the reason none of these functions contains a
 * capability check: Row Level Security decides what comes back, so a borrower
 * calling `listClientMemberships` gets their own membership and nothing else
 * without this module containing a single line about borrowers.
 *
 * Using the service-role client here to "simplify" a query would move the
 * authorization decision out of the database and into whichever caller
 * remembered to make it. There is no such client in this file.
 *
 * ## One round trip per screen
 *
 * The register reads `public.membership_register`, a `security_invoker` view
 * that joins the membership to its client and its policy version. Without it
 * the register would be one membership query followed by a client lookup per
 * row — the query waterfall Phases 17 and 19 were spent removing, and the one
 * a Supabase free tier punishes hardest.
 *
 * ## Paging, not counting
 *
 * One row more than the page needs is fetched, and its presence is what
 * `hasMore` means. A `count: 'exact'` on every page view is a full scan of
 * the filtered set; the register says what it can afford to know, which is
 * what `RegisterCount` renders.
 */

export const MEMBERSHIPS_PAGE_SIZE = 20;

/** A membership as the register shows it. */
export interface MembershipSummary {
  readonly id: string;
  readonly membershipNumber: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly phone: string;
  readonly villageArea: string;
  readonly district: string;
  readonly branchName: string | null;
  readonly status: MembershipStatus;
  readonly appliedOn: string;
  readonly activatedOn: string | null;
  readonly endedOn: string | null;
  readonly policyVersion: string;
}

/** Everything on the membership record itself. */
export interface MembershipDetail extends MembershipSummary {
  readonly clientStatus: string;
  readonly branchId: string | null;
  readonly policyVersionId: string;
  readonly policyIsFinanciallyEnabled: boolean;
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MembershipPage {
  readonly memberships: readonly MembershipSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/** One entry in a membership's lifecycle history. */
export interface MembershipStatusEvent {
  readonly id: number;
  readonly fromStatus: MembershipStatus | null;
  readonly toStatus: MembershipStatus;
  readonly reason: string | null;
  readonly effectiveOn: string;
  readonly changedByLabel: string;
  readonly occurredAt: string;
}

/**
 * A membership policy version, as the configuration screen reads it.
 *
 * Nullable fields are decisions the client has not made. `null` is never
 * rendered as a zero or a default — see
 * `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`.
 */
export interface MembershipPolicy {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly effectiveFrom: string;
  readonly status: MembershipPolicyStatus;

  readonly registrationFee: UgxAmount;
  readonly monthlySavingsMinimum: UgxAmount;
  readonly savingsQualifyingMonths: number;

  readonly memberLoanInterestRateBps: BasisPoints;
  readonly memberLoanMaxTermMonths: number;
  readonly memberLoanWeeklyCadenceMaxMonths: number;
  readonly nonMemberLoanMaxTermMonths: number;

  readonly medicalBenefitRateBps: BasisPoints;
  readonly medicalBenefitMinAdmissionDays: number;
  readonly familyCondolenceBenefit: UgxAmount;
  readonly memberBereavementBenefit: UgxAmount;

  readonly interestBasis: MemberInterestBasis | null;
  readonly interestMethod: MemberInterestMethod | null;
  readonly savingsToLoanMultiplierBps: BasisPoints | null;
  readonly qualifyingMonthsConsecutive: boolean | null;
  readonly savingsWithdrawalWithActiveLoan: SavingsWithdrawalRule | null;
  readonly profitDistributionBasis: ProfitDistributionBasis | null;
  readonly medicalBenefitAnnualCap: UgxAmount | null;
  readonly medicalBenefitClaimsPerYear: number | null;
  readonly benefitWaitingPeriodDays: number | null;

  readonly approvedAt: string | null;
  readonly approvedByLabel: string | null;
  readonly approvalReference: string | null;
  readonly isFinanciallyEnabled: boolean;
  readonly notes: string | null;
}

/** The columns the register needs. Deliberately not `select('*')`. */
const SUMMARY_COLUMNS =
  'id, membership_number, client_id, client_number, full_name, phone, ' +
  'village_area, district, branch_name, status, applied_on, activated_on, ' +
  'ended_on, policy_version';

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, client_status, branch_id, policy_version_id, policy_is_financially_enabled, status_reason, status_changed_at, notes, created_at, updated_at`;

interface SummaryRow {
  id: string;
  membership_number: string;
  client_id: string;
  client_number: string;
  full_name: string;
  phone: string;
  village_area: string;
  district: string;
  branch_name: string | null;
  status: string;
  applied_on: string;
  activated_on: string | null;
  ended_on: string | null;
  policy_version: string;
}

function toSummary(row: SummaryRow): MembershipSummary {
  return {
    id: row.id,
    membershipNumber: row.membership_number,
    clientId: row.client_id,
    clientNumber: row.client_number,
    fullName: row.full_name,
    phone: row.phone,
    villageArea: row.village_area,
    district: row.district,
    branchName: row.branch_name,
    // Validated rather than asserted: an unrecognised status would otherwise
    // flow into a badge lookup and render as undefined.
    status: isMembershipStatus(row.status) ? row.status : 'pending',
    appliedOn: row.applied_on,
    activatedOn: row.activated_on,
    endedOn: row.ended_on,
    policyVersion: row.policy_version,
  };
}

/**
 * Escape a user-supplied search term for a PostgREST `ilike` pattern.
 *
 * `%` and `_` are wildcards and a comma terminates a value inside the `or()`
 * filter syntax, so an unescaped term lets a caller alter the shape of the
 * query. Not a SQL injection — the values are still parameters — but a filter
 * injection, and the fix is the same.
 */
function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

/**
 * The membership register, searched and filtered.
 *
 * Search covers the three identifiers a person at a counter would quote: the
 * membership number, the member's name and the client number. Not the phone
 * number, and not the National Identification Number — the first belongs to
 * the client directory, which already searches it, and the second is not in
 * any table this query reads, so no amount of typing into this box can
 * confirm one.
 */
export async function listMemberships(
  filter: MembershipSearchInput,
): Promise<MembershipPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * MEMBERSHIPS_PAGE_SIZE;
  // One extra row, to learn whether there is a next page without a count
  // query.
  const to = from + MEMBERSHIPS_PAGE_SIZE;

  let query = supabase
    .from('membership_register')
    .select(SUMMARY_COLUMNS)
    .order('applied_on', { ascending: false })
    .order('membership_number', { ascending: false })
    .range(from, to);

  if (filter.status !== null) {
    query = query.eq('status', filter.status);
  }

  if (filter.query !== null) {
    const term = escapeSearchTerm(filter.query.trim());

    if (term !== '') {
      query = query.or(
        [
          `membership_number.ilike.%${term}%`,
          `full_name.ilike.%${term}%`,
          `client_number.ilike.%${term}%`,
        ].join(','),
      );
    }
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list memberships.', { code: error.code });
    throw mapDatabaseError(error, 'membership');
  }

  const rows = (data ?? []) as unknown as SummaryRow[];
  const hasMore = rows.length > MEMBERSHIPS_PAGE_SIZE;

  return {
    memberships: rows.slice(0, MEMBERSHIPS_PAGE_SIZE).map(toSummary),
    page,
    hasMore,
  };
}

type DetailRow = SummaryRow & {
  client_status: string;
  branch_id: string | null;
  policy_version_id: string;
  policy_is_financially_enabled: boolean;
  status_reason: string | null;
  status_changed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

function toDetail(row: DetailRow): MembershipDetail {
  return {
    ...toSummary(row),
    clientStatus: row.client_status,
    branchId: row.branch_id,
    policyVersionId: row.policy_version_id,
    policyIsFinanciallyEnabled: row.policy_is_financially_enabled === true,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One membership, or null when it does not exist or the caller may not see
 * it.
 *
 * The two are deliberately indistinguishable. Telling a caller that a
 * membership exists but is not theirs confirms a fact the policy is there to
 * withhold.
 */
export async function getMembership(
  membershipId: string,
): Promise<MembershipDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_register')
    .select(DETAIL_COLUMNS)
    .eq('id', membershipId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a membership.', { code: error.code });
    throw mapDatabaseError(error, 'membership');
  }

  if (data === null) return null;

  return toDetail(data as unknown as DetailRow);
}

/**
 * Every membership a client has ever held, newest first.
 *
 * This is the brief's "retrieve membership information through an existing
 * client ID", and it is deliberately the *only* such function. A
 * `getLiveMembership(clientId)` beside it would return a row this already
 * returns, through a second query, with its own copy of the rule about which
 * statuses count as live — and `isLiveMembershipStatus()` in
 * `lib/domain/membership.ts` is where that rule belongs, over data the
 * caller already has.
 *
 * Normally one row, or none. More than one means the client withdrew and
 * rejoined, which the schema permits deliberately and which the client
 * profile should show rather than hide.
 */
export async function listClientMemberships(
  clientId: string,
): Promise<readonly MembershipSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_register')
    .select(SUMMARY_COLUMNS)
    .eq('client_id', clientId)
    .order('applied_on', { ascending: false })
    .limit(20);

  if (error !== null) {
    unstable_rethrow(error);
    logger.warn('Could not list a client memberships.', { code: error.code });
    return [];
  }

  return ((data ?? []) as unknown as SummaryRow[]).map(toSummary);
}

/**
 * A membership's lifecycle history, oldest first.
 *
 * Returns an empty list rather than throwing when the caller may not read it:
 * the policy on `membership_status_history` has no self-clause, so a borrower
 * reaching a page that renders this simply sees nothing, which is the
 * intended outcome rather than an error.
 */
export async function listMembershipHistory(
  membershipId: string,
): Promise<readonly MembershipStatusEvent[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_status_history')
    .select(
      'id, from_status, to_status, reason, effective_on, changed_by_label, occurred_at',
    )
    .eq('membership_id', membershipId)
    .order('id', { ascending: true })
    .limit(100);

  if (error !== null) {
    unstable_rethrow(error);
    logger.debug('Membership history returned no rows.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    id: Number(row.id),
    fromStatus: isMembershipStatus(row.from_status) ? row.from_status : null,
    toStatus: isMembershipStatus(row.to_status) ? row.to_status : 'pending',
    reason: row.reason,
    effectiveOn: row.effective_on,
    changedByLabel: row.changed_by_label,
    occurredAt: row.occurred_at,
  }));
}

const POLICY_COLUMNS =
  'id, version, title, effective_from, status, registration_fee, ' +
  'monthly_savings_minimum, savings_qualifying_months, ' +
  'member_loan_interest_rate_bps, member_loan_max_term_months, ' +
  'member_loan_weekly_cadence_max_months, non_member_loan_max_term_months, ' +
  'medical_benefit_rate_bps, medical_benefit_min_admission_days, ' +
  'family_condolence_benefit, member_bereavement_benefit, ' +
  'interest_basis, interest_method, savings_to_loan_multiplier_bps, ' +
  'qualifying_months_consecutive, savings_withdrawal_with_active_loan, ' +
  'profit_distribution_basis, medical_benefit_annual_cap, ' +
  'medical_benefit_claims_per_year, benefit_waiting_period_days, ' +
  'approved_at, approved_by_label, approval_reference, ' +
  'is_financially_enabled, notes';

interface PolicyRow {
  id: string;
  version: string;
  title: string;
  effective_from: string;
  status: string;
  registration_fee: number | string;
  monthly_savings_minimum: number | string;
  savings_qualifying_months: number;
  member_loan_interest_rate_bps: number;
  member_loan_max_term_months: number;
  member_loan_weekly_cadence_max_months: number;
  non_member_loan_max_term_months: number;
  medical_benefit_rate_bps: number;
  medical_benefit_min_admission_days: number;
  family_condolence_benefit: number | string;
  member_bereavement_benefit: number | string;
  interest_basis: string | null;
  interest_method: string | null;
  savings_to_loan_multiplier_bps: number | null;
  qualifying_months_consecutive: boolean | null;
  savings_withdrawal_with_active_loan: string | null;
  profit_distribution_basis: string | null;
  medical_benefit_annual_cap: number | string | null;
  medical_benefit_claims_per_year: number | null;
  benefit_waiting_period_days: number | null;
  approved_at: string | null;
  approved_by_label: string | null;
  approval_reference: string | null;
  is_financially_enabled: boolean;
  notes: string | null;
}

/**
 * A `bigint` column, as a validated whole-shilling amount.
 *
 * `fromDatabaseAmount` is the shared reader: it accepts the number or the
 * string PostgREST may send, refuses anything that is not an exact integer,
 * and brands the result so a raw `number` cannot be passed where an amount is
 * expected. A `NOT NULL` column cannot come back null, but the reader's type
 * says it can, so the fallback is stated rather than asserted — an asserted
 * non-null that one day *is* null is how `undefined` reaches a currency
 * formatter.
 */
function requiredAmount(value: number | string): UgxAmount {
  return fromDatabaseAmount(value) ?? UGX_ZERO;
}

function toPolicy(row: PolicyRow): MembershipPolicy {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    effectiveFrom: row.effective_from,
    status: isMembershipPolicyStatus(row.status) ? row.status : 'draft',

    registrationFee: requiredAmount(row.registration_fee),
    monthlySavingsMinimum: requiredAmount(row.monthly_savings_minimum),
    savingsQualifyingMonths: row.savings_qualifying_months,

    memberLoanInterestRateBps:
      fromDatabaseBps(row.member_loan_interest_rate_bps) ?? toBps(0),
    memberLoanMaxTermMonths: row.member_loan_max_term_months,
    memberLoanWeeklyCadenceMaxMonths: row.member_loan_weekly_cadence_max_months,
    nonMemberLoanMaxTermMonths: row.non_member_loan_max_term_months,

    medicalBenefitRateBps: fromDatabaseBps(row.medical_benefit_rate_bps) ?? toBps(0),
    medicalBenefitMinAdmissionDays: row.medical_benefit_min_admission_days,
    familyCondolenceBenefit: requiredAmount(row.family_condolence_benefit),
    memberBereavementBenefit: requiredAmount(row.member_bereavement_benefit),

    // Cast rather than validated: the column's own CHECK constraint is the
    // vocabulary, and a value outside it cannot be in the table. NULL is
    // preserved as NULL, because NULL means undecided and must never become
    // a default.
    interestBasis: row.interest_basis as MemberInterestBasis | null,
    interestMethod: row.interest_method as MemberInterestMethod | null,
    savingsToLoanMultiplierBps: fromDatabaseBps(row.savings_to_loan_multiplier_bps),
    qualifyingMonthsConsecutive: row.qualifying_months_consecutive,
    savingsWithdrawalWithActiveLoan:
      row.savings_withdrawal_with_active_loan as SavingsWithdrawalRule | null,
    profitDistributionBasis:
      row.profit_distribution_basis as ProfitDistributionBasis | null,
    medicalBenefitAnnualCap: fromDatabaseAmount(row.medical_benefit_annual_cap),
    medicalBenefitClaimsPerYear: row.medical_benefit_claims_per_year,
    benefitWaitingPeriodDays: row.benefit_waiting_period_days,

    approvedAt: row.approved_at,
    approvedByLabel: row.approved_by_label,
    approvalReference: row.approval_reference,
    isFinanciallyEnabled: row.is_financially_enabled === true,
    notes: row.notes,
  };
}

/**
 * The membership policy version currently in force, or null when none has
 * been activated.
 *
 * Null is the honest answer today: version 1.0 is a draft, because nine of
 * its rules are undecided. A caller must not substitute a default for it.
 */
export async function getActiveMembershipPolicy(): Promise<MembershipPolicy | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_policy_versions')
    .select(POLICY_COLUMNS)
    .eq('status', 'active')
    .maybeSingle();

  if (error !== null) {
    unstable_rethrow(error);
    logger.warn('Could not read the active membership policy.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  return toPolicy(data as unknown as PolicyRow);
}

/**
 * Every policy version the caller may read, newest effective date first.
 *
 * The configuration screen's list. Capped: a programme with more than fifty
 * published versions is a different problem than paging.
 */
export async function listMembershipPolicies(): Promise<readonly MembershipPolicy[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_policy_versions')
    .select(POLICY_COLUMNS)
    .order('effective_from', { ascending: false })
    .order('version', { ascending: false })
    .limit(50);

  if (error !== null) {
    unstable_rethrow(error);
    logger.warn('Could not list the membership policies.', { code: error.code });
    return [];
  }

  return ((data ?? []) as unknown as PolicyRow[]).map(toPolicy);
}

/** One policy version by id, for the membership profile's terms panel. */
export async function getMembershipPolicy(
  policyVersionId: string,
): Promise<MembershipPolicy | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_policy_versions')
    .select(POLICY_COLUMNS)
    .eq('id', policyVersionId)
    .maybeSingle();

  if (error !== null) {
    unstable_rethrow(error);
    logger.warn('Could not read a membership policy version.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  return toPolicy(data as unknown as PolicyRow);
}
