import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { UGX_ZERO, fromDatabaseAmount, type UgxAmount } from '@/lib/domain/money';
import {
  isBenefitClaimStatus,
  isBenefitClaimType,
  type BeneficiaryStatus,
  type BeneficiaryVerificationStatus,
  type BenefitClaimStatus,
  type BenefitClaimType,
  type BenefitDocumentVerificationStatus,
  type BenefitRecipientKind,
  type BenefitYearBasis,
} from '@/lib/domain/benefits';
import type { PaymentMethod } from '@/lib/domain/payment';
import type { BeneficiarySearch, BenefitClaimSearch } from '@/lib/validation/benefits';

/**
 * Reading benefits.
 *
 * Every query here runs as the signed-in caller through
 * `createSupabaseServerClient`, never through the privileged client. That is
 * why none of these functions contains a capability check: the policies decide
 * what comes back, so a member calling `getBenefitClaim` with another member's
 * id gets nothing without this module containing a line about members, and a
 * Secretary gets their branch without this module containing a line about
 * branches.
 *
 * Using the service-role client here to "simplify" a query would move the
 * authorization decision out of the database and into whichever caller
 * remembered to make it. There is no such client in this file.
 *
 * ## The two reads that are deliberately narrower than the register
 *
 * `getAssessmentSnapshot` reads `benefit_assessment_snapshots`, whose policy
 * needs `benefits:assess` or `benefits:approve` — and, on a bereavement
 * claim, `membership:view_sensitive` as well, because the row carries the
 * payee's name. A Secretary/Treasurer who can run the register gets `null`
 * from it, which is correct: an assessment snapshot is an officer's working
 * record, not a register.
 *
 * `getPortalClaim` reads `benefit_claim_portal_view`, whose **column list is
 * the disclosure policy**. `assessment_note` is not in it, so a portal screen
 * cannot render an assessor's reasoning by accident and a future `select *`
 * cannot reintroduce it. The refusal reason *is* in it, because a member is
 * entitled to be told why.
 *
 * ## Why the beneficiary identity is a separate read
 *
 * `listBeneficiaries` returns no name and no telephone number: the register
 * view carries neither, because they live in `member_beneficiary_identities`
 * behind `membership:view_sensitive`. `getBeneficiaryIdentity` is the second
 * read, and it returns `null` for a caller without the capability — so a
 * screen renders "a verified spouse" for the counter and the name for a
 * supervisor, from the same component, without either of them being told
 * which case they are in by this module.
 *
 * ## One round trip per screen
 *
 * The dashboard reads `benefit_summary()`, one call for every tile. The
 * alternative — a query per figure — is how a register read came to invoke
 * `user_has_permission` 20,524 times in Phase 18, and the Supabase free tier
 * is the constraint this system is actually under.
 */

const CLAIM_PAGE_SIZE = 25;
const BENEFICIARY_PAGE_SIZE = 25;
const PAYMENT_PAGE_SIZE = 25;

/** See `lib/data/clients.ts`: a filter injection, escaped rather than hoped about. */
function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

function amount(value: number | string | null): UgxAmount | null {
  return fromDatabaseAmount(value);
}

function requiredAmount(value: number | string | null): UgxAmount {
  return fromDatabaseAmount(value) ?? UGX_ZERO;
}

// ---------------------------------------------------------------------------
// The claim register
// ---------------------------------------------------------------------------

export interface BenefitClaimSummary {
  readonly id: string;
  readonly claimNumber: string;
  readonly claimType: BenefitClaimType;
  readonly status: BenefitClaimStatus;
  readonly eventDate: string;
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly membershipStatus: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly memberName: string;
  readonly branchName: string;
  readonly policyVersion: string;
  readonly claimedAmount: UgxAmount | null;
  readonly assessedAmount: UgxAmount | null;
  readonly approvedAmount: UgxAmount | null;
  readonly providerName: string | null;
  readonly billAmount: UgxAmount | null;
  readonly admissionNights: number | null;
  readonly admissionInclusiveDays: number | null;
  readonly admissionElapsedDays: number | null;
  readonly deceasedName: string | null;
  readonly deceasedRelationshipLabel: string | null;
  readonly beneficiaryId: string | null;
  readonly beneficiaryNumber: string | null;
  readonly beneficiaryVerificationStatus: BeneficiaryVerificationStatus | null;
  readonly submittedAt: string | null;
  readonly submittedByLabel: string | null;
  readonly assessedAt: string | null;
  readonly assessedByLabel: string | null;
  readonly decidedAt: string | null;
  readonly decidedByLabel: string | null;
  readonly rejectedReason: string | null;
  readonly cancelledReason: string | null;
  readonly informationRequiredNote: string | null;
  readonly paymentNumber: string | null;
  readonly paidOn: string | null;
  readonly paymentReversedAt: string | null;
  readonly documentCount: number;
  readonly verifiedDocumentCount: number;
  readonly requiredDocumentCount: number;
}

interface ClaimRegisterRow {
  readonly id: string;
  readonly claim_number: string;
  readonly claim_type: string;
  readonly status: string;
  readonly event_date: string;
  readonly membership_id: string;
  readonly membership_number: string;
  readonly membership_status: string;
  readonly client_id: string;
  readonly client_number: string;
  readonly member_name: string;
  readonly branch_name: string;
  readonly policy_version: string;
  readonly claimed_amount: string | null;
  readonly assessed_amount: string | null;
  readonly approved_amount: string | null;
  readonly provider_name: string | null;
  readonly bill_amount: string | null;
  readonly admission_nights: number | null;
  readonly admission_inclusive_days: number | null;
  readonly admission_elapsed_days: number | null;
  readonly deceased_name: string | null;
  readonly deceased_relationship_label: string | null;
  readonly beneficiary_id: string | null;
  readonly beneficiary_number: string | null;
  readonly beneficiary_verification_status: string | null;
  readonly submitted_at: string | null;
  readonly submitted_by_label: string | null;
  readonly assessed_at: string | null;
  readonly assessed_by_label: string | null;
  readonly decided_at: string | null;
  readonly decided_by_label: string | null;
  readonly rejected_reason: string | null;
  readonly cancelled_reason: string | null;
  readonly information_required_note: string | null;
  readonly payment_number: string | null;
  readonly paid_on: string | null;
  readonly payment_reversed_at: string | null;
  readonly document_count: number;
  readonly verified_document_count: number;
  readonly required_document_count: number;
}

const CLAIM_COLUMNS = `
  id, claim_number, claim_type, status, event_date,
  membership_id, membership_number, membership_status,
  client_id, client_number, member_name, branch_name, policy_version,
  claimed_amount, assessed_amount, approved_amount,
  provider_name, bill_amount,
  admission_nights, admission_inclusive_days, admission_elapsed_days,
  deceased_name, deceased_relationship_label,
  beneficiary_id, beneficiary_number, beneficiary_verification_status,
  submitted_at, submitted_by_label, assessed_at, assessed_by_label,
  decided_at, decided_by_label,
  rejected_reason, cancelled_reason, information_required_note,
  payment_number, paid_on, payment_reversed_at,
  document_count, verified_document_count, required_document_count
`;

function toClaimSummary(row: ClaimRegisterRow): BenefitClaimSummary {
  return {
    id: row.id,
    claimNumber: row.claim_number,
    claimType: isBenefitClaimType(row.claim_type) ? row.claim_type : 'medical',
    status: isBenefitClaimStatus(row.status) ? row.status : 'draft',
    eventDate: row.event_date,
    membershipId: row.membership_id,
    membershipNumber: row.membership_number,
    membershipStatus: row.membership_status,
    clientId: row.client_id,
    clientNumber: row.client_number,
    memberName: row.member_name,
    branchName: row.branch_name,
    policyVersion: row.policy_version,
    claimedAmount: amount(row.claimed_amount),
    assessedAmount: amount(row.assessed_amount),
    approvedAmount: amount(row.approved_amount),
    providerName: row.provider_name,
    billAmount: amount(row.bill_amount),
    admissionNights: row.admission_nights,
    admissionInclusiveDays: row.admission_inclusive_days,
    admissionElapsedDays: row.admission_elapsed_days,
    deceasedName: row.deceased_name,
    deceasedRelationshipLabel: row.deceased_relationship_label,
    beneficiaryId: row.beneficiary_id,
    beneficiaryNumber: row.beneficiary_number,
    beneficiaryVerificationStatus:
      row.beneficiary_verification_status as BeneficiaryVerificationStatus | null,
    submittedAt: row.submitted_at,
    submittedByLabel: row.submitted_by_label,
    assessedAt: row.assessed_at,
    assessedByLabel: row.assessed_by_label,
    decidedAt: row.decided_at,
    decidedByLabel: row.decided_by_label,
    rejectedReason: row.rejected_reason,
    cancelledReason: row.cancelled_reason,
    informationRequiredNote: row.information_required_note,
    paymentNumber: row.payment_number,
    paidOn: row.paid_on,
    paymentReversedAt: row.payment_reversed_at,
    documentCount: row.document_count,
    verifiedDocumentCount: row.verified_document_count,
    requiredDocumentCount: row.required_document_count,
  };
}

export interface BenefitClaimPage {
  readonly claims: readonly BenefitClaimSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/**
 * The claim register, searched and filtered.
 *
 * Search covers the claim number, the membership number, the member's name and
 * their client number — the four identifiers somebody standing at a counter
 * actually has. Deliberately **not** the hospital or the deceased's name:
 * searching a column implies being able to confirm its contents, and typing
 * enough guesses into a box that matched a hospital would confirm which
 * members had been admitted where.
 *
 * `status=open` is a filter the register offers and the database does not: it
 * is every status a claim can still move out of, which is the view somebody
 * working a queue wants and which no single column holds.
 */
export async function listBenefitClaims(
  filter: BenefitClaimSearch,
): Promise<BenefitClaimPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * CLAIM_PAGE_SIZE;
  const to = from + CLAIM_PAGE_SIZE;

  let query = supabase
    .from('benefit_claim_register')
    .select(CLAIM_COLUMNS)
    .order('claim_number', { ascending: false })
    .range(from, to);

  if (filter.type !== 'all') {
    query = query.eq('claim_type', filter.type);
  }

  if (filter.status === 'open') {
    query = query.in('status', [
      'draft',
      'submitted',
      'under_verification',
      'information_required',
      'assessed',
      'approved',
    ]);
  } else if (filter.status !== 'all') {
    query = query.eq('status', filter.status);
  }

  const term = filter.query === null ? '' : escapeSearchTerm(filter.query.trim());

  if (term !== '') {
    query = query.or(
      [
        `claim_number.ilike.%${term}%`,
        `membership_number.ilike.%${term}%`,
        `member_name.ilike.%${term}%`,
        `client_number.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list benefit claims.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  const rows = (data ?? []) as unknown as ClaimRegisterRow[];
  const hasMore = rows.length > CLAIM_PAGE_SIZE;

  return {
    claims: rows.slice(0, CLAIM_PAGE_SIZE).map(toClaimSummary),
    page,
    hasMore,
  };
}

/** One claim, or `null` when the caller may not see it. */
export async function getBenefitClaim(
  claimId: string,
): Promise<BenefitClaimSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_claim_register')
    .select(CLAIM_COLUMNS)
    .eq('id', claimId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a benefit claim.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return data === null ? null : toClaimSummary(data as unknown as ClaimRegisterRow);
}

/** Every claim on one membership, newest event first. For the member's profile. */
export async function listClaimsForMembership(
  membershipId: string,
): Promise<readonly BenefitClaimSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_claim_register')
    .select(CLAIM_COLUMNS)
    .eq('membership_id', membershipId)
    .order('event_date', { ascending: false })
    .limit(50);

  if (error !== null) {
    logger.warn('Could not list a member’s benefit claims.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return ((data ?? []) as unknown as ClaimRegisterRow[]).map(toClaimSummary);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityFailure {
  readonly code: string;
  readonly detail: string;
}

/**
 * Why a claim cannot be assessed, as the database sees it.
 *
 * The same function `assess_benefit_claim` refuses on, so what an assessment
 * screen shows is exactly what pressing the button would say. The alternative
 * — a screen that computes its own view of eligibility — is two
 * implementations of sixteen rules, and the one that drifts is the one a
 * member is standing in front of.
 *
 * An empty array means the claim can be assessed. A caller without
 * `benefits:assess` or `benefits:approve` gets an error from
 * `medical_benefit_consumed` inside it, which surfaces here as `null`: a
 * screen they should not be on, rather than a wrong answer.
 */
export async function getClaimEligibility(
  claimId: string,
): Promise<readonly EligibilityFailure[] | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('benefit_claim_eligibility', {
    p_claim_id: claimId,
  });

  if (error !== null) {
    // `42501` is the capability refusal inside the function. Everything else
    // is a fault worth logging.
    if (error.code !== '42501') {
      logger.warn('Could not read benefit claim eligibility.', { code: error.code });
    }
    return null;
  }

  const rows = (data ?? []) as readonly {
    readonly failure_code: string;
    readonly detail: string;
  }[];

  return rows.map((row) => ({ code: row.failure_code, detail: row.detail }));
}

// ---------------------------------------------------------------------------
// The assessment snapshot
// ---------------------------------------------------------------------------

export interface AssessmentSnapshot {
  readonly claimNumber: string;
  readonly claimType: BenefitClaimType;
  readonly membershipNumber: string;
  readonly policyVersion: string;
  readonly assessedOn: string;
  readonly eventDate: string;
  readonly benefitRateBps: number | null;
  readonly minAdmissionDays: number | null;
  readonly fixedBenefitAmount: UgxAmount | null;
  readonly waitingPeriodDays: number;
  readonly billAmount: UgxAmount | null;
  readonly admissionNights: number | null;
  readonly admissionInclusiveDays: number | null;
  readonly admissionElapsedDays: number | null;
  readonly yearBasis: BenefitYearBasis | null;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  readonly annualCap: UgxAmount | null;
  readonly claimsPerYear: number | null;
  readonly priorClaimsInPeriod: number | null;
  readonly priorAmountInPeriod: UgxAmount | null;
  readonly remainingCapBefore: UgxAmount | null;
  readonly deceasedRelationship: string | null;
  readonly relationshipEligible: boolean | null;
  readonly beneficiaryNumber: string | null;
  readonly beneficiaryName: string | null;
  readonly beneficiaryRelationship: string | null;
  readonly beneficiaryPhone: string | null;
  readonly beneficiaryVerifiedAt: string | null;
  readonly beneficiaryVerifiedByLabel: string | null;
  readonly outstandingMemberLoanPrincipal: UgxAmount;
  readonly activeMemberLoanCount: number;
  readonly pledgedSavings: UgxAmount;
  readonly savingsBalance: UgxAmount;
  readonly verifiedDocumentCount: number;
  readonly verifiedDocumentKinds: readonly string[];
  readonly assessedAmount: UgxAmount;
  readonly assessmentNote: string | null;
  readonly assessedByLabel: string;
  readonly capturedAt: string;
}

/**
 * The frozen assessment, or `null` when there is none or the caller may not
 * read it.
 *
 * The two cases are deliberately indistinguishable to a caller. A screen that
 * said "you are not allowed to see this assessment" would confirm that one
 * exists, and for a bereavement claim that is itself a disclosure: it says the
 * business has identified a payee.
 */
export async function getAssessmentSnapshot(
  claimId: string,
): Promise<AssessmentSnapshot | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_assessment_snapshots')
    .select('*')
    .eq('claim_id', claimId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a benefit assessment snapshot.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  const row = data;

  return {
    claimNumber: row.claim_number,
    claimType: row.claim_type as BenefitClaimType,
    membershipNumber: row.membership_number,
    policyVersion: row.policy_version,
    assessedOn: row.assessed_on,
    eventDate: row.event_date,
    benefitRateBps: row.benefit_rate_bps,
    minAdmissionDays: row.min_admission_days,
    fixedBenefitAmount: amount(row.fixed_benefit_amount),
    waitingPeriodDays: row.waiting_period_days,
    billAmount: amount(row.bill_amount),
    admissionNights: row.admission_nights,
    admissionInclusiveDays: row.admission_inclusive_days,
    admissionElapsedDays: row.admission_elapsed_days,
    yearBasis: row.year_basis as BenefitYearBasis | null,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    annualCap: amount(row.annual_cap),
    claimsPerYear: row.claims_per_year,
    priorClaimsInPeriod: row.prior_claims_in_period,
    priorAmountInPeriod: amount(row.prior_amount_in_period),
    remainingCapBefore: amount(row.remaining_cap_before),
    deceasedRelationship: row.deceased_relationship,
    relationshipEligible: row.relationship_eligible,
    beneficiaryNumber: row.beneficiary_number,
    beneficiaryName: row.beneficiary_name,
    beneficiaryRelationship: row.beneficiary_relationship,
    beneficiaryPhone: row.beneficiary_phone,
    beneficiaryVerifiedAt: row.beneficiary_verified_at,
    beneficiaryVerifiedByLabel: row.beneficiary_verified_by_label,
    outstandingMemberLoanPrincipal: requiredAmount(row.outstanding_member_loan_principal),
    activeMemberLoanCount: row.active_member_loan_count,
    pledgedSavings: requiredAmount(row.pledged_savings),
    savingsBalance: requiredAmount(row.savings_balance),
    verifiedDocumentCount: row.verified_document_count,
    verifiedDocumentKinds: row.verified_document_kinds,
    assessedAmount: requiredAmount(row.assessed_amount),
    assessmentNote: row.assessment_note,
    assessedByLabel: row.assessed_by_label,
    capturedAt: row.captured_at,
  };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface BenefitDocument {
  readonly id: string;
  readonly claimId: string | null;
  readonly beneficiaryId: string | null;
  readonly kind: string;
  readonly kindLabel: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly label: string | null;
  readonly uploadedAt: string;
  readonly uploadedByLabel: string;
  readonly verificationStatus: BenefitDocumentVerificationStatus;
  readonly verifiedAt: string | null;
  readonly verifiedByLabel: string | null;
  readonly verificationNote: string | null;
}

interface DocumentRow {
  readonly id: string;
  readonly claim_id: string | null;
  readonly beneficiary_id: string | null;
  readonly kind: string;
  readonly object_path: string;
  readonly content_type: string;
  readonly byte_size: string;
  readonly label: string | null;
  readonly uploaded_at: string;
  readonly uploaded_by_label: string;
  readonly verification_status: string;
  readonly verified_at: string | null;
  readonly verified_by_label: string | null;
  readonly verification_note: string | null;
  readonly benefit_document_kinds: { readonly label: string } | null;
}

function toDocument(row: DocumentRow): BenefitDocument {
  return {
    id: row.id,
    claimId: row.claim_id,
    beneficiaryId: row.beneficiary_id,
    kind: row.kind,
    kindLabel: row.benefit_document_kinds?.label ?? row.kind,
    objectPath: row.object_path,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    label: row.label,
    uploadedAt: row.uploaded_at,
    uploadedByLabel: row.uploaded_by_label,
    verificationStatus: row.verification_status as BenefitDocumentVerificationStatus,
    verifiedAt: row.verified_at,
    verifiedByLabel: row.verified_by_label,
    verificationNote: row.verification_note,
  };
}

const DOCUMENT_COLUMNS = `
  id, claim_id, beneficiary_id, kind, object_path, content_type, byte_size,
  label, uploaded_at, uploaded_by_label,
  verification_status, verified_at, verified_by_label, verification_note,
  benefit_document_kinds ( label )
`;

export async function listClaimDocuments(
  claimId: string,
): Promise<readonly BenefitDocument[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_claim_documents')
    .select(DOCUMENT_COLUMNS)
    .eq('claim_id', claimId)
    .order('uploaded_at', { ascending: true });

  if (error !== null) {
    logger.warn('Could not list claim documents.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return ((data ?? []) as unknown as DocumentRow[]).map(toDocument);
}

export async function listBeneficiaryDocuments(
  beneficiaryId: string,
): Promise<readonly BenefitDocument[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_claim_documents')
    .select(DOCUMENT_COLUMNS)
    .eq('beneficiary_id', beneficiaryId)
    .order('uploaded_at', { ascending: true });

  if (error !== null) {
    logger.warn('Could not list beneficiary documents.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return ((data ?? []) as unknown as DocumentRow[]).map(toDocument);
}

export interface BenefitDocumentKind {
  readonly key: string;
  readonly label: string;
  readonly claimType: BenefitClaimType | null;
  readonly isRequiredForAssessment: boolean;
}

/** The document vocabulary a form renders. Readable by any signed-in caller. */
export async function listBenefitDocumentKinds(
  claimType?: BenefitClaimType,
): Promise<readonly BenefitDocumentKind[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('benefit_document_kinds')
    .select('key, label, claim_type, is_required_for_assessment')
    .order('sort_order', { ascending: true });

  if (claimType !== undefined) {
    // The type's own kinds plus the ones any claim may carry.
    query = query.or(`claim_type.eq.${claimType},claim_type.is.null`);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list benefit document kinds.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return (
    (data ?? []) as unknown as readonly {
      readonly key: string;
      readonly label: string;
      readonly claim_type: string | null;
      readonly is_required_for_assessment: boolean;
    }[]
  ).map((row) => ({
    key: row.key,
    label: row.label,
    claimType: row.claim_type as BenefitClaimType | null,
    isRequiredForAssessment: row.is_required_for_assessment,
  }));
}

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

export interface BeneficiarySummary {
  readonly id: string;
  readonly beneficiaryNumber: string;
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly membershipStatus: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly memberName: string;
  readonly relationship: string;
  readonly relationshipLabel: string;
  readonly isPrimary: boolean;
  readonly status: BeneficiaryStatus;
  readonly verificationStatus: BeneficiaryVerificationStatus;
  readonly verificationEvidenceKind: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByLabel: string | null;
  readonly rejectedReason: string | null;
  readonly recordedOn: string;
  readonly recordedByLabel: string;
  readonly endedOn: string | null;
  readonly endedReason: string | null;
  readonly supersedesNumber: string | null;
  readonly documentCount: number;
}

interface BeneficiaryRow {
  readonly id: string;
  readonly beneficiary_number: string;
  readonly membership_id: string;
  readonly membership_number: string;
  readonly membership_status: string;
  readonly client_id: string;
  readonly client_number: string;
  readonly member_name: string;
  readonly relationship: string;
  readonly relationship_label: string | null;
  readonly is_primary: boolean;
  readonly status: string;
  readonly verification_status: string;
  readonly verification_evidence_kind: string | null;
  readonly verified_at: string | null;
  readonly verified_by_label: string | null;
  readonly rejected_reason: string | null;
  readonly recorded_on: string;
  readonly recorded_by_label: string;
  readonly ended_on: string | null;
  readonly ended_reason: string | null;
  readonly supersedes_number: string | null;
  readonly document_count: number;
}

const BENEFICIARY_COLUMNS = `
  id, beneficiary_number, membership_id, membership_number, membership_status,
  client_id, client_number, member_name,
  relationship, relationship_label, is_primary, status,
  verification_status, verification_evidence_kind, verified_at, verified_by_label,
  rejected_reason, recorded_on, recorded_by_label, ended_on, ended_reason,
  supersedes_number, document_count
`;

function toBeneficiary(row: BeneficiaryRow): BeneficiarySummary {
  return {
    id: row.id,
    beneficiaryNumber: row.beneficiary_number,
    membershipId: row.membership_id,
    membershipNumber: row.membership_number,
    membershipStatus: row.membership_status,
    clientId: row.client_id,
    clientNumber: row.client_number,
    memberName: row.member_name,
    relationship: row.relationship,
    relationshipLabel: row.relationship_label ?? row.relationship,
    isPrimary: row.is_primary,
    status: row.status as BeneficiaryStatus,
    verificationStatus: row.verification_status as BeneficiaryVerificationStatus,
    verificationEvidenceKind: row.verification_evidence_kind,
    verifiedAt: row.verified_at,
    verifiedByLabel: row.verified_by_label,
    rejectedReason: row.rejected_reason,
    recordedOn: row.recorded_on,
    recordedByLabel: row.recorded_by_label,
    endedOn: row.ended_on,
    endedReason: row.ended_reason,
    supersedesNumber: row.supersedes_number,
    documentCount: row.document_count,
  };
}

export interface BeneficiaryPage {
  readonly beneficiaries: readonly BeneficiarySummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/**
 * The beneficiary register, searched and filtered.
 *
 * Carries **no name and no telephone number**, because the view does not: the
 * register's job is to make the unverified records findable, and an unverified
 * beneficiary is a bereavement benefit that cannot be paid. Search is
 * therefore over the record number, the membership number, the member's name
 * and their client number — never the beneficiary's own name, which a
 * Secretary/Treasurer may not read at all.
 */
export async function listBeneficiaries(
  filter: BeneficiarySearch,
): Promise<BeneficiaryPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * BENEFICIARY_PAGE_SIZE;
  const to = from + BENEFICIARY_PAGE_SIZE;

  let query = supabase
    .from('member_beneficiary_register')
    .select(BENEFICIARY_COLUMNS)
    .eq('status', 'active')
    .order('beneficiary_number', { ascending: false })
    .range(from, to);

  if (filter.verification !== 'all') {
    query = query.eq('verification_status', filter.verification);
  }

  const term = filter.query === null ? '' : escapeSearchTerm(filter.query.trim());

  if (term !== '') {
    query = query.or(
      [
        `beneficiary_number.ilike.%${term}%`,
        `membership_number.ilike.%${term}%`,
        `member_name.ilike.%${term}%`,
        `client_number.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list beneficiaries.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  const rows = (data ?? []) as unknown as BeneficiaryRow[];
  const hasMore = rows.length > BENEFICIARY_PAGE_SIZE;

  return {
    beneficiaries: rows.slice(0, BENEFICIARY_PAGE_SIZE).map(toBeneficiary),
    page,
    hasMore,
  };
}

/**
 * Every beneficiary record on one membership, current first then history.
 *
 * The history matters and is not decoration: "who was the beneficiary when
 * this claim was approved" has to be answerable, and a superseded record keeps
 * its details and its verification for exactly that reason.
 */
export async function listBeneficiariesForMembership(
  membershipId: string,
): Promise<readonly BeneficiarySummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('member_beneficiary_register')
    .select(BENEFICIARY_COLUMNS)
    .eq('membership_id', membershipId)
    .order('status', { ascending: true })
    .order('beneficiary_number', { ascending: false });

  if (error !== null) {
    logger.warn('Could not list a member’s beneficiaries.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return ((data ?? []) as unknown as BeneficiaryRow[]).map(toBeneficiary);
}

export async function getBeneficiary(
  beneficiaryId: string,
): Promise<BeneficiarySummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('member_beneficiary_register')
    .select(BENEFICIARY_COLUMNS)
    .eq('id', beneficiaryId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a beneficiary.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return data === null ? null : toBeneficiary(data as unknown as BeneficiaryRow);
}

export interface BeneficiaryIdentity {
  readonly fullName: string;
  readonly phone: string;
  readonly alternativePhone: string | null;
  readonly villageArea: string | null;
  readonly district: string | null;
  readonly identityReference: string | null;
  readonly identityDocumentKind: string | null;
}

/**
 * Who a beneficiary is, for a caller holding `membership:view_sensitive`.
 *
 * `null` for everybody else, and the policy is what decides — this function
 * contains no capability check, so a Secretary/Treasurer gets no row and a
 * Manager gets one without either case being written here. That is the point
 * of reading as the caller: the screen renders "a verified spouse" or the
 * name, from one component, and neither is a branch in this module.
 */
export async function getBeneficiaryIdentity(
  beneficiaryId: string,
): Promise<BeneficiaryIdentity | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('member_beneficiary_identities')
    .select(
      'full_name, phone, alternative_phone, village_area, district, identity_reference, identity_document_kind',
    )
    .eq('beneficiary_id', beneficiaryId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a beneficiary identity.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  const row = data as unknown as {
    readonly full_name: string;
    readonly phone: string;
    readonly alternative_phone: string | null;
    readonly village_area: string | null;
    readonly district: string | null;
    readonly identity_reference: string | null;
    readonly identity_document_kind: string | null;
  };

  return {
    fullName: row.full_name,
    phone: row.phone,
    alternativePhone: row.alternative_phone,
    villageArea: row.village_area,
    district: row.district,
    identityReference: row.identity_reference,
    identityDocumentKind: row.identity_document_kind,
  };
}

export interface BeneficiaryRelationship {
  readonly key: string;
  readonly label: string;
  readonly condolenceEligible: boolean | null;
}

/**
 * The relationship vocabulary a form renders.
 *
 * `condolenceEligible` is NULL on every row, because the client has not
 * defined an eligible family member. It is returned rather than hidden so a
 * form can say so where it matters, instead of offering a choice whose
 * consequence nobody has settled.
 */
export async function listBeneficiaryRelationships(): Promise<
  readonly BeneficiaryRelationship[]
> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('beneficiary_relationships')
    .select('key, label, condolence_eligible')
    .order('sort_order', { ascending: true });

  if (error !== null) {
    logger.warn('Could not list beneficiary relationships.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return (
    (data ?? []) as unknown as readonly {
      readonly key: string;
      readonly label: string;
      readonly condolence_eligible: boolean | null;
    }[]
  ).map((row) => ({
    key: row.key,
    label: row.label,
    condolenceEligible: row.condolence_eligible,
  }));
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface BenefitPaymentSummary {
  readonly id: string;
  readonly paymentNumber: string;
  readonly claimId: string;
  readonly claimNumber: string;
  readonly claimType: BenefitClaimType;
  readonly membershipNumber: string;
  readonly memberName: string;
  readonly branchName: string;
  readonly amount: UgxAmount;
  readonly recipientKind: BenefitRecipientKind;
  readonly recipientName: string;
  readonly recipientBeneficiaryNumber: string | null;
  readonly paymentMethod: PaymentMethod;
  readonly externalReference: string | null;
  readonly expenseAccountCode: string;
  readonly expenseAccountName: string;
  readonly cashAccountCode: string;
  readonly cashAccountName: string;
  readonly valueDate: string;
  readonly journalEntryId: string;
  readonly paidAt: string;
  readonly paidByLabel: string;
  readonly reversedAt: string | null;
  readonly reversedByLabel: string | null;
  readonly reversalReason: string | null;
  readonly reversalJournalEntryId: string | null;
  readonly isLive: boolean;
}

interface PaymentRow {
  readonly id: string;
  readonly payment_number: string;
  readonly claim_id: string;
  readonly claim_number: string;
  readonly claim_type: string;
  readonly membership_number: string;
  readonly member_name: string;
  readonly branch_name: string;
  readonly amount: string;
  readonly recipient_kind: string;
  readonly recipient_name: string;
  readonly recipient_beneficiary_number: string | null;
  readonly payment_method: string;
  readonly external_reference: string | null;
  readonly expense_account_code: string;
  readonly expense_account_name: string;
  readonly cash_account_code: string;
  readonly cash_account_name: string;
  readonly value_date: string;
  readonly journal_entry_id: string;
  readonly paid_at: string;
  readonly paid_by_label: string;
  readonly reversed_at: string | null;
  readonly reversed_by_label: string | null;
  readonly reversal_reason: string | null;
  readonly reversal_journal_entry_id: string | null;
  readonly is_live: boolean;
}

const PAYMENT_COLUMNS = `
  id, payment_number, claim_id, claim_number, claim_type,
  membership_number, member_name, branch_name, amount,
  recipient_kind, recipient_name, recipient_beneficiary_number,
  payment_method, external_reference,
  expense_account_code, expense_account_name,
  cash_account_code, cash_account_name,
  value_date, journal_entry_id, paid_at, paid_by_label,
  reversed_at, reversed_by_label, reversal_reason, reversal_journal_entry_id,
  is_live
`;

function toPayment(row: PaymentRow): BenefitPaymentSummary {
  return {
    id: row.id,
    paymentNumber: row.payment_number,
    claimId: row.claim_id,
    claimNumber: row.claim_number,
    claimType: row.claim_type as BenefitClaimType,
    membershipNumber: row.membership_number,
    memberName: row.member_name,
    branchName: row.branch_name,
    amount: requiredAmount(row.amount),
    recipientKind: row.recipient_kind as BenefitRecipientKind,
    recipientName: row.recipient_name,
    recipientBeneficiaryNumber: row.recipient_beneficiary_number,
    paymentMethod: row.payment_method as PaymentMethod,
    externalReference: row.external_reference,
    expenseAccountCode: row.expense_account_code,
    expenseAccountName: row.expense_account_name,
    cashAccountCode: row.cash_account_code,
    cashAccountName: row.cash_account_name,
    valueDate: row.value_date,
    journalEntryId: row.journal_entry_id,
    paidAt: row.paid_at,
    paidByLabel: row.paid_by_label,
    reversedAt: row.reversed_at,
    reversedByLabel: row.reversed_by_label,
    reversalReason: row.reversal_reason,
    reversalJournalEntryId: row.reversal_journal_entry_id,
    isLive: row.is_live,
  };
}

export interface BenefitPaymentPage {
  readonly payments: readonly BenefitPaymentSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/**
 * The payment history.
 *
 * A caller without `membership:view_sensitive` sees payments to *members* and
 * not payments to beneficiaries, because the row carries the payee's name and
 * the policy is written against `recipient_kind`. So a Secretary/Treasurer can
 * reconcile medical and condolence benefits and a bereavement payment is a row
 * they are not entitled to read — rather than a name they should not have
 * seen.
 */
export async function listBenefitPayments(options: {
  readonly page?: number;
  readonly claimType?: BenefitClaimType;
  readonly from?: string;
  readonly to?: string;
}): Promise<BenefitPaymentPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, options.page ?? 1);
  const from = (page - 1) * PAYMENT_PAGE_SIZE;
  const to = from + PAYMENT_PAGE_SIZE;

  let query = supabase
    .from('benefit_payment_register')
    .select(PAYMENT_COLUMNS)
    .order('value_date', { ascending: false })
    .order('payment_number', { ascending: false })
    .range(from, to);

  if (options.claimType !== undefined) {
    query = query.eq('claim_type', options.claimType);
  }

  if (options.from !== undefined) {
    query = query.gte('value_date', options.from);
  }

  if (options.to !== undefined) {
    query = query.lte('value_date', options.to);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list benefit payments.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  const rows = (data ?? []) as unknown as PaymentRow[];
  const hasMore = rows.length > PAYMENT_PAGE_SIZE;

  return {
    payments: rows.slice(0, PAYMENT_PAGE_SIZE).map(toPayment),
    page,
    hasMore,
  };
}

export async function getBenefitPaymentForClaim(
  claimId: string,
): Promise<BenefitPaymentSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_payment_register')
    .select(PAYMENT_COLUMNS)
    .eq('claim_id', claimId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a benefit payment.', { code: error.code });
    return null;
  }

  return data === null ? null : toPayment(data as unknown as PaymentRow);
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

export interface BenefitSummary {
  readonly claimsDraft: number;
  readonly claimsSubmitted: number;
  readonly claimsUnderVerification: number;
  readonly claimsInformationRequired: number;
  readonly claimsAssessed: number;
  readonly claimsApproved: number;
  readonly claimsRejected: number;
  readonly claimsPaid: number;
  readonly claimsTotal: number;
  readonly paidTotal: UgxAmount;
  readonly paidMedical: UgxAmount;
  readonly paidCondolence: UgxAmount;
  readonly paidBereavement: UgxAmount;
  readonly paymentsReversed: number;
  readonly reversedTotal: UgxAmount;
  readonly approvedAwaitingPayment: UgxAmount;
  readonly membersWithBeneficiary: number;
  readonly membersWithVerifiedBeneficiary: number;
  readonly beneficiariesAwaitingVerification: number;
  readonly liveMemberships: number;
  readonly meetingsUpcoming: number;
  readonly meetingsHeldInPeriod: number;
  readonly attendanceRecordedInPeriod: number;
  readonly meetingActionsOpen: number;
  readonly benefitsOpen: boolean;
  readonly blockedReason: string | null;
}

/**
 * Every figure on the Benefits dashboard, in one round trip.
 *
 * `null` rather than a throw when the caller does not hold `benefits:view`: a
 * dashboard that 500s for a Secretary is worse than one that leaves out a
 * figure they were never meant to see. The same judgement `getSavingsSummary`
 * makes.
 */
export async function getBenefitSummary(
  options: {
    readonly from?: string;
    readonly to?: string;
  } = {},
): Promise<BenefitSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .rpc('benefit_summary', {
      p_from: options.from ?? null,
      p_to: options.to ?? null,
    })
    .maybeSingle();

  if (error !== null) {
    if (error.code !== '42501') {
      logger.warn('Could not read the benefit summary.', { code: error.code });
    }
    return null;
  }

  if (data === null) return null;

  const row = data as unknown as Record<string, string | number | boolean | null>;

  return {
    claimsDraft: Number(row.claims_draft ?? 0),
    claimsSubmitted: Number(row.claims_submitted ?? 0),
    claimsUnderVerification: Number(row.claims_under_verification ?? 0),
    claimsInformationRequired: Number(row.claims_information_required ?? 0),
    claimsAssessed: Number(row.claims_assessed ?? 0),
    claimsApproved: Number(row.claims_approved ?? 0),
    claimsRejected: Number(row.claims_rejected ?? 0),
    claimsPaid: Number(row.claims_paid ?? 0),
    claimsTotal: Number(row.claims_total ?? 0),
    paidTotal: requiredAmount(row.paid_total as string),
    paidMedical: requiredAmount(row.paid_medical as string),
    paidCondolence: requiredAmount(row.paid_condolence as string),
    paidBereavement: requiredAmount(row.paid_bereavement as string),
    paymentsReversed: Number(row.payments_reversed ?? 0),
    reversedTotal: requiredAmount(row.reversed_total as string),
    approvedAwaitingPayment: requiredAmount(row.approved_awaiting_payment as string),
    membersWithBeneficiary: Number(row.members_with_beneficiary ?? 0),
    membersWithVerifiedBeneficiary: Number(row.members_with_verified_beneficiary ?? 0),
    beneficiariesAwaitingVerification: Number(
      row.beneficiaries_awaiting_verification ?? 0,
    ),
    liveMemberships: Number(row.live_memberships ?? 0),
    meetingsUpcoming: Number(row.meetings_upcoming ?? 0),
    meetingsHeldInPeriod: Number(row.meetings_held_in_period ?? 0),
    attendanceRecordedInPeriod: Number(row.attendance_recorded_in_period ?? 0),
    meetingActionsOpen: Number(row.meeting_actions_open ?? 0),
    benefitsOpen: row.benefits_open === true,
    blockedReason: (row.blocked_reason as string | null) ?? null,
  };
}

export interface BenefitExpenseLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly claimType: BenefitClaimType | null;
  readonly postedDebits: UgxAmount;
  readonly postedCredits: UgxAmount;
  readonly netExpense: UgxAmount;
}

/**
 * What the benefits scheme cost over a period, by promise, from the General
 * Ledger.
 *
 * Read from the journal rather than from the claim table deliberately: the two
 * should agree, and a report that read the claim table could not tell anybody
 * when they did not. This one reconciles against the trial balance by
 * construction, because it sums the same rows.
 *
 * `null` when the caller does not hold `reports:view_financial` — who may read
 * the company's expense accounts is a financial-reporting question rather than
 * a benefits one.
 */
export async function getBenefitExpenseByType(
  from: string,
  to: string,
): Promise<readonly BenefitExpenseLine[] | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('benefit_expense_by_type', {
    p_from: from,
    p_to: to,
  });

  if (error !== null) {
    if (error.code !== '42501') {
      logger.warn('Could not read benefit expense by type.', { code: error.code });
    }
    return null;
  }

  return (
    (data ?? []) as unknown as readonly {
      readonly account_code: string;
      readonly account_name: string;
      readonly claim_type: string | null;
      readonly posted_debits: string;
      readonly posted_credits: string;
      readonly net_expense: string;
    }[]
  ).map((row) => ({
    accountCode: row.account_code,
    accountName: row.account_name,
    claimType: row.claim_type as BenefitClaimType | null,
    postedDebits: requiredAmount(row.posted_debits),
    postedCredits: requiredAmount(row.posted_credits),
    netExpense: requiredAmount(row.net_expense),
  }));
}

// ---------------------------------------------------------------------------
// The portal
// ---------------------------------------------------------------------------

export interface PortalClaim {
  readonly id: string;
  readonly claimNumber: string;
  readonly claimType: BenefitClaimType;
  readonly status: BenefitClaimStatus;
  readonly eventDate: string;
  readonly claimedAmount: UgxAmount | null;
  readonly assessedAmount: UgxAmount | null;
  readonly approvedAmount: UgxAmount | null;
  readonly providerName: string | null;
  readonly billAmount: UgxAmount | null;
  readonly deceasedName: string | null;
  readonly informationRequiredNote: string | null;
  readonly rejectedReason: string | null;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly paymentNumber: string | null;
  readonly paidOn: string | null;
  readonly paidAmount: UgxAmount | null;
  readonly paymentMethod: PaymentMethod | null;
}

/**
 * A member's own claims, through the view whose column list is the disclosure
 * policy.
 *
 * Reading `benefit_claims` directly would work — the policy grants a member
 * their own rows — and would hand them `assessment_note`, which is an
 * officer's reasoning about whether their documents looked genuine. The view
 * does not have the column, so this is structural rather than a habit.
 */
export async function listPortalClaims(): Promise<readonly PortalClaim[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('benefit_claim_portal_view')
    .select('*')
    .order('event_date', { ascending: false })
    .limit(50);

  if (error !== null) {
    logger.warn('Could not list a member’s own benefit claims.', { code: error.code });
    throw mapDatabaseError(error, 'benefits');
  }

  return (
    (data ?? []) as unknown as readonly Record<string, string | number | null>[]
  ).map((row) => ({
    id: row.id as string,
    claimNumber: row.claim_number as string,
    claimType: row.claim_type as BenefitClaimType,
    status: row.status as BenefitClaimStatus,
    eventDate: row.event_date as string,
    claimedAmount: amount(row.claimed_amount as string | null),
    assessedAmount: amount(row.assessed_amount as string | null),
    approvedAmount: amount(row.approved_amount as string | null),
    providerName: row.provider_name as string | null,
    billAmount: amount(row.bill_amount as string | null),
    deceasedName: row.deceased_name as string | null,
    informationRequiredNote: row.information_required_note as string | null,
    rejectedReason: row.rejected_reason as string | null,
    submittedAt: row.submitted_at as string | null,
    decidedAt: row.decided_at as string | null,
    paymentNumber: row.payment_number as string | null,
    paidOn: row.paid_on as string | null,
    paidAmount: amount(row.paid_amount as string | null),
    paymentMethod: row.payment_method as PaymentMethod | null,
  }));
}
