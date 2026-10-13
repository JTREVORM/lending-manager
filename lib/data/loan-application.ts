import 'server-only';

/**
 * Reading everything a loan application holds beyond its core terms: the
 * product's own answers, the guarantors on it, the undertaking each signed,
 * and the documents filed with it.
 *
 * Every query runs as the signed-in caller, so Row Level Security decides
 * what comes back. Nothing here uses the privileged client, and nothing here
 * re-states a rule the database already enforces — a caller who may not read
 * a loan's guarantors gets an empty list rather than a refusal, because
 * "you cannot see this" is a normal state for a borrower in the portal and an
 * exception thrown from a page render is not.
 */

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { GuarantorSubjectKind } from '@/lib/domain/guarantor';
import type { LoanDocumentKind } from '@/lib/validation/loan-application';

// ---------------------------------------------------------------------------
// The product's own questions
// ---------------------------------------------------------------------------

export interface LoanApplicationProfile {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly status: string;
  readonly productCode: string;
  readonly productName: string;
  readonly applicationProfile: string;
  readonly requiresSupportingDocuments: boolean;
  readonly detailsPresent: boolean;
  readonly documentCount: number;
  /**
   * Phase 14. What the product asks for by way of cover.
   *
   * Read here rather than by a second query for the product, because the
   * security panel's one job beyond listing items is to say "this product
   * expects security and none is recorded" — and a panel that needed another
   * round trip to say it would be a panel that quietly stopped saying it.
   */
  readonly collateralRequired: boolean;
  readonly minGuarantors: number;

  readonly salary: {
    readonly employerName: string;
    readonly employerContact: string | null;
    readonly jobTitle: string;
    readonly staffNumber: string | null;
    readonly netMonthlySalary: number;
    readonly salaryPayDay: number;
    readonly employmentStartedOn: string | null;
    readonly employmentStatus: string | null;
    readonly salaryVerification: string;
    readonly hasPayslip: boolean;
    readonly hasEmploymentLetter: boolean;
  } | null;

  readonly business: {
    readonly businessName: string;
    readonly businessType: string;
    readonly businessLocation: string;
    readonly businessContact: string | null;
    readonly tradingSince: string | null;
    readonly monthlyTurnover: number;
    readonly monthlyExpenses: number | null;
    readonly employeeCount: number | null;
    readonly premisesOwnership: string | null;
    readonly tradingLicenceNumber: string | null;
    readonly loanPurpose: string;
    readonly hasTradingLicence: boolean;
    readonly hasBankStatement: boolean;
  } | null;
}

/**
 * The application profile, or null when the loan is unreadable.
 *
 * The salary and business blocks are present only when the loan actually has
 * one. That is a different thing from "the product asks for it and nobody has
 * answered yet", which `detailsPresent` says — and the screens need both: one
 * decides which section to render, the other decides whether to warn.
 */
export async function getLoanApplicationProfile(
  loanId: string,
): Promise<LoanApplicationProfile | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_application_profile')
    .select('*')
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a loan application profile.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  return {
    loanId: String(data.loan_id),
    loanNumber: String(data.loan_number),
    status: String(data.status),
    productCode: String(data.product_code),
    productName: String(data.product_name),
    applicationProfile: String(data.application_profile),
    requiresSupportingDocuments: data.requires_supporting_documents === true,
    detailsPresent: data.details_present === true,
    documentCount: Number(data.document_count ?? 0),
    collateralRequired: data.collateral_required === true,
    minGuarantors: Number(data.min_guarantors ?? 0),
    salary:
      data.employer_name === null || data.employer_name === undefined
        ? null
        : {
            employerName: data.employer_name,
            employerContact: data.employer_contact,
            jobTitle: String(data.job_title),
            staffNumber: data.staff_number,
            netMonthlySalary: Number(data.net_monthly_salary),
            salaryPayDay: Number(data.salary_pay_day),
            employmentStartedOn: data.employment_started_on,
            employmentStatus: data.employment_status,
            salaryVerification: String(data.salary_verification ?? 'not_checked'),
            hasPayslip: data.has_payslip === true,
            hasEmploymentLetter: data.has_employment_letter === true,
          },
    business:
      data.business_name === null || data.business_name === undefined
        ? null
        : {
            businessName: data.business_name,
            businessType: String(data.business_type),
            businessLocation: String(data.business_location),
            businessContact: data.business_contact,
            tradingSince: data.trading_since,
            monthlyTurnover: Number(data.monthly_turnover),
            monthlyExpenses:
              data.monthly_expenses === null ? null : Number(data.monthly_expenses),
            employeeCount:
              data.employee_count === null ? null : Number(data.employee_count),
            premisesOwnership: data.premises_ownership,
            tradingLicenceNumber: data.trading_licence_number,
            loanPurpose: String(data.loan_purpose),
            hasTradingLicence: data.has_trading_licence === true,
            hasBankStatement: data.has_bank_statement === true,
          },
  };
}

// ---------------------------------------------------------------------------
// Guarantors
// ---------------------------------------------------------------------------

export interface LoanGuarantor {
  readonly id: string;
  readonly loanId: string;
  readonly subjectKind: GuarantorSubjectKind;
  readonly guarantorId: string | null;
  readonly guarantorClientId: string | null;
  readonly clientNumber: string | null;
  readonly fullName: string;
  readonly phone: string;
  readonly alternativePhone: string | null;
  readonly sex: string | null;
  readonly dateOfBirth: string | null;
  readonly occupation: string | null;
  readonly employerName: string | null;
  readonly location: string | null;
  readonly district: string | null;
  readonly relationshipToClient: string;
  readonly consentTermsId: string | null;
  readonly consentVersion: string | null;
  readonly consentedAt: string | null;
  readonly signatureName: string | null;
  readonly witnessName: string | null;
  readonly witnessPhone: string | null;
  readonly consentPlace: string | null;
  readonly consentSigned: boolean;
  readonly hasIdentification: boolean;
  readonly hasSignatureImage: boolean;
  readonly hasPhotograph: boolean;
  readonly evidenceFrozen: boolean;
  readonly documentCount: number;
  readonly createdAt: string;
}

/** The guarantors on one application, external and client alike. */
export async function getLoanGuarantors(
  loanId: string,
): Promise<readonly LoanGuarantor[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_guarantor_register')
    .select('*')
    .eq('loan_id', loanId)
    .order('created_at', { ascending: true });

  if (error !== null) {
    logger.debug('Loan guarantors not readable by this caller.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    loanId: String(row.loan_id),
    subjectKind: row.subject_kind === 'client' ? 'client' : 'external',
    guarantorId: row.guarantor_id,
    guarantorClientId: row.guarantor_client_id,
    clientNumber: row.client_number,
    fullName: String(row.full_name ?? ''),
    phone: String(row.phone ?? ''),
    alternativePhone: row.alternative_phone,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    occupation: row.occupation,
    employerName: row.employer_name,
    location: row.location,
    district: row.district,
    relationshipToClient: String(row.relationship_to_client ?? ''),
    consentTermsId: row.consent_terms_id,
    consentVersion: row.consent_version,
    consentedAt: row.consented_at,
    signatureName: row.signature_name,
    witnessName: row.witness_name,
    witnessPhone: row.witness_phone,
    consentPlace: row.consent_place,
    consentSigned: row.consent_signed === true,
    hasIdentification: row.has_identification === true,
    hasSignatureImage: row.has_signature_image === true,
    hasPhotograph: row.has_photograph === true,
    evidenceFrozen: row.evidence_frozen === true,
    documentCount: Number(row.document_count ?? 0),
    createdAt: String(row.created_at),
  }));
}

export interface GuarantorEvidence {
  readonly loanId: string;
  readonly subjectKind: GuarantorSubjectKind;
  readonly guarantorId: string | null;
  readonly guarantorClientId: string | null;
  readonly fullName: string;
  readonly phone: string;
  readonly alternativePhone: string | null;
  readonly sex: string | null;
  readonly dateOfBirth: string | null;
  readonly occupation: string | null;
  readonly location: string | null;
  readonly district: string | null;
  readonly relationshipToClient: string;
  readonly hadPhotograph: boolean;
  readonly hadIdentification: boolean | null;
  readonly consentVersion: string | null;
  readonly consentedAt: string | null;
  readonly signatureName: string | null;
  readonly witnessName: string | null;
  readonly capturedAt: string | null;
  readonly source: string;
}

/**
 * Who guaranteed this loan, as frozen at approval.
 *
 * Reads `loan_guarantor_evidence`, which presents both eras as one list — the
 * loans approved from Phase 13 onward carry their evidence on
 * `loan_guarantors`, and the ones before it in `loan_guarantor_snapshots`. A
 * reader never has to know which era a loan is from.
 */
export async function getLoanGuarantorEvidence(
  loanId: string,
): Promise<readonly GuarantorEvidence[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_guarantor_evidence')
    .select('*')
    .eq('loan_id', loanId);

  if (error !== null) {
    logger.debug('Guarantor evidence not readable by this caller.', {
      code: error.code,
    });
    return [];
  }

  return (data ?? []).map((row) => ({
    loanId: String(row.loan_id),
    subjectKind: row.subject_kind === 'client' ? 'client' : 'external',
    guarantorId: row.guarantor_id,
    guarantorClientId: row.guarantor_client_id,
    fullName: String(row.full_name ?? ''),
    phone: String(row.phone ?? ''),
    alternativePhone: row.alternative_phone,
    sex: row.sex,
    dateOfBirth: row.date_of_birth,
    occupation: row.occupation,
    location: row.location,
    district: row.district,
    relationshipToClient: String(row.relationship_to_client ?? ''),
    hadPhotograph: row.had_photograph === true,
    hadIdentification: row.had_identification,
    consentVersion: row.consent_version,
    consentedAt: row.consented_at,
    signatureName: row.signature_name,
    witnessName: row.witness_name,
    capturedAt: row.captured_at,
    source: String(row.source ?? ''),
  }));
}

export interface GuarantorConsentTerms {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly effectiveFrom: string;
}

/**
 * The undertaking currently in force.
 *
 * Exactly one row is marked current, by a partial unique index, so no screen
 * has to decide which of two it meant.
 */
export async function getCurrentConsentTerms(): Promise<GuarantorConsentTerms | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('guarantor_consent_terms')
    .select('id, version, title, body, effective_from')
    .eq('is_current', true)
    .maybeSingle();

  if (error !== null || data === null) {
    if (error !== null) {
      logger.warn('The guarantor undertaking could not be read.', { code: error.code });
    }
    return null;
  }

  return {
    id: data.id,
    version: data.version,
    title: data.title,
    body: data.body,
    effectiveFrom: data.effective_from,
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface GuarantorCandidate {
  readonly clientId: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly phone: string;
  readonly occupation: string;
  readonly location: string;
  readonly district: string | null;
  readonly status: string;
  readonly hasIdentification: boolean;
  readonly activeLoanCount: number;
  readonly arrearsAmount: number;
  readonly guaranteeingCount: number;
  readonly alreadyAttached: boolean;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * The existing clients who could back this application.
 *
 * Returns the ineligible ones too, with their reasons. A search that silently
 * omitted them would send a staff member looking for somebody who is standing
 * in front of them, and the one thing worse than "cannot be chosen" is
 * "mysteriously absent".
 */
export async function searchGuarantorCandidates(
  loanId: string,
  term: string | null,
): Promise<readonly GuarantorCandidate[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('guarantor_candidates', {
    p_loan_id: loanId,
    p_search: term,
  });

  if (error !== null) {
    logger.warn('Could not search for guarantor candidates.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    clientId: row.client_id,
    clientNumber: row.client_number,
    fullName: row.full_name,
    phone: row.phone,
    occupation: row.occupation,
    location: row.location,
    district: row.district,
    status: row.status,
    hasIdentification: row.has_identification,
    activeLoanCount: Number(row.active_loan_count),
    arrearsAmount: Number(row.arrears_amount),
    guaranteeingCount: Number(row.guaranteeing_count),
    alreadyAttached: row.already_attached,
    eligible: row.eligible,
    reasons: row.reasons,
  }));
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface LoanDocument {
  readonly id: string;
  readonly loanId: string;
  readonly loanGuarantorId: string | null;
  readonly kind: LoanDocumentKind;
  readonly storagePath: string;
  readonly label: string | null;
  readonly contentType: string;
  readonly byteSize: number;
  readonly createdAt: string;
}

/** What was filed with an application. The paths, never a URL. */
export async function getLoanDocuments(loanId: string): Promise<readonly LoanDocument[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_documents')
    .select(
      'id, loan_id, loan_guarantor_id, kind, storage_path, label, content_type, byte_size, created_at',
    )
    .eq('loan_id', loanId)
    .order('created_at', { ascending: true });

  if (error !== null) {
    logger.debug('Loan documents not readable by this caller.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    loanId: row.loan_id,
    loanGuarantorId: row.loan_guarantor_id,
    kind: row.kind as LoanDocumentKind,
    storagePath: row.storage_path,
    label: row.label,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Portfolio by product
// ---------------------------------------------------------------------------

export interface ProductPortfolioRow {
  readonly productId: string;
  readonly productCode: string;
  readonly productName: string;
  readonly applicationProfile: string;
  readonly loanCount: number;
  readonly activeCount: number;
  readonly arrearsCount: number;
  readonly clearedCount: number;
  readonly principalDisbursed: number;
  readonly outstanding: number;
}

/**
 * The portfolio, grouped by the product each loan was written under.
 *
 * Aggregated here rather than in a view, deliberately. The grouping is a
 * presentation choice — which columns, which stages count as "in arrears" —
 * and a view would fix it for every future caller. The row set it reduces is
 * the loan register, which at this size is a few hundred rows; when it is
 * tens of thousands this becomes a view, and that is a Phase 7 decision made
 * against real volumes rather than a guess made now.
 */
export async function getPortfolioByProduct(): Promise<readonly ProductPortfolioRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_workflow_register')
    .select(
      'loan_product_id, product_code, product_name, application_profile, status, workflow_stage, principal_amount, total_outstanding',
    );

  if (error !== null) {
    logger.warn('Could not read the portfolio by product.', { code: error.code });
    return [];
  }

  const byProduct = new Map<string, ProductPortfolioRow>();

  for (const row of data ?? []) {
    const id = String(row.loan_product_id);

    const current = byProduct.get(id) ?? {
      productId: id,
      productCode: String(row.product_code),
      productName: String(row.product_name),
      applicationProfile: String(row.application_profile),
      loanCount: 0,
      activeCount: 0,
      arrearsCount: 0,
      clearedCount: 0,
      principalDisbursed: 0,
      outstanding: 0,
    };

    const disbursed =
      row.status === 'active' || row.status === 'cleared'
        ? Number(row.principal_amount)
        : 0;

    byProduct.set(id, {
      ...current,
      loanCount: current.loanCount + 1,
      activeCount: current.activeCount + (row.status === 'active' ? 1 : 0),
      arrearsCount: current.arrearsCount + (row.workflow_stage === 'arrears' ? 1 : 0),
      clearedCount: current.clearedCount + (row.status === 'cleared' ? 1 : 0),
      principalDisbursed: current.principalDisbursed + disbursed,
      outstanding:
        current.outstanding +
        (row.status === 'active' ? Number(row.total_outstanding ?? 0) : 0),
    });
  }

  return [...byProduct.values()].sort((a, b) =>
    a.productName.localeCompare(b.productName),
  );
}
