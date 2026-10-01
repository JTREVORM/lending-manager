import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  isLoanStatus,
  isLoanApprovalFailure,
  type LoanApprovalFailure,
  type LoanPeriod,
  type LoanStatus,
} from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import type { LoanSearchInput } from '@/lib/validation/loan';

/**
 * Reading loans.
 *
 * Every query runs as the signed-in caller, so Row Level Security decides what
 * comes back. Nothing here uses the privileged client.
 *
 * ## The sensitive snapshot is a separate call
 *
 * `loan_identity_snapshots` holds the National Identification Numbers captured
 * at approval, behind `loans:view_sensitive`. No function in this module that
 * returns a loan or a list of loans touches that table — so a
 * Secretary/Treasurer, who reads the register all day, cannot leak a NIN
 * through a loan view. `getLoanIdentitySnapshots` is the one function that
 * reads it, and it returns an empty list rather than throwing when the policy
 * refuses, because "you cannot see this" is a normal state for that role
 * rather than an error.
 */

export const LOANS_PAGE_SIZE = 20;

export interface LoanSummary {
  readonly id: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly clientNumber: string;
  readonly principalAmount: number;
  readonly interestRateBps: number;
  readonly loanTermMonths: number;
  readonly repaymentFrequency: string;
  readonly totalExpectedRepayment: number;
  readonly status: LoanStatus;
  readonly createdAt: string;
  readonly proposedDisbursementDate: string;
  readonly disbursedAt: string | null;
}

export interface LoanDetail extends LoanSummary {
  readonly interestMethod: string;
  readonly totalInterest: number;
  readonly currencyCode: string;
  readonly minLoanAmountApplied: number;
  readonly maxLoanAmountApplied: number | null;
  readonly gracePeriodDaysApplied: number;
  readonly penaltyRateBpsApplied: number;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly reviewNote: string | null;
  readonly notes: string | null;
  readonly updatedAt: string;
}

export interface LoanPage {
  readonly loans: readonly LoanSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/** A client snapshot as captured at approval. */
export interface LoanClientSnapshot {
  readonly clientId: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly phone: string;
  readonly alternativePhone: string | null;
  readonly sex: string;
  readonly dateOfBirth: string;
  readonly occupation: string;
  readonly businessType: string | null;
  readonly villageArea: string;
  readonly district: string;
  readonly clientStatusAtOrigination: string;
  readonly capturedAt: string;
}

export interface LoanGuarantorSnapshot {
  readonly id: string;
  readonly guarantorId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly sex: string;
  readonly occupation: string;
  readonly location: string;
  readonly district: string | null;
  readonly relationshipToClient: string;
  readonly hadPhotograph: boolean;
}

export interface LoanIdentitySnapshot {
  readonly subjectType: 'client' | 'guarantor';
  readonly subjectId: string;
  readonly nin: string | null;
}

const SUMMARY_COLUMNS =
  'id, loan_number, client_id, principal_amount, interest_rate_bps, loan_term_months, repayment_frequency, total_expected_repayment, status, created_at, proposed_disbursement_date, disbursed_at, clients!inner(full_name, client_number)';

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, interest_method, total_interest, currency_code, min_loan_amount_applied, max_loan_amount_applied, grace_period_days_applied, penalty_rate_bps_applied, submitted_at, approved_at, cancelled_at, cancellation_reason, review_note, notes, updated_at`;

/** Pull a string out of a loosely-typed embedded relation. See lib/data/guarantors.ts. */
function textField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A nullable string column, read without coercion.
 *
 * `String(value)` would render an unexpected object as the literal text
 * `[object Object]` into the interface — which for a cancellation reason or an
 * approval timestamp would be worse than showing nothing.
 */
function nullableText(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' ? value : null;
}

function toSummary(row: Record<string, unknown>): LoanSummary {
  const client =
    typeof row.clients === 'object' && row.clients !== null
      ? (row.clients as Record<string, unknown>)
      : {};

  const status = row.status;

  return {
    id: String(row.id),
    loanNumber: String(row.loan_number),
    clientId: String(row.client_id),
    clientName: textField(client, 'full_name'),
    clientNumber: textField(client, 'client_number'),
    principalAmount: Number(row.principal_amount),
    interestRateBps: Number(row.interest_rate_bps),
    loanTermMonths: Number(row.loan_term_months),
    repaymentFrequency: String(row.repayment_frequency),
    totalExpectedRepayment: Number(row.total_expected_repayment),
    // Validated rather than asserted: an unrecognised status would otherwise
    // flow into a badge lookup and render as undefined.
    status: isLoanStatus(status) ? status : 'draft',
    createdAt: String(row.created_at),
    proposedDisbursementDate: String(row.proposed_disbursement_date),
    disbursedAt: nullableText(row, 'disbursed_at'),
  };
}

/** See lib/data/clients.ts — `%`, `_` and `,` are PostgREST filter metacharacters. */
function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

/**
 * The loan register.
 *
 * Searched by loan number, client number and client name — the three things a
 * staff member has when somebody is standing in front of them.
 */
export async function listLoans(filter: LoanSearchInput): Promise<LoanPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * LOANS_PAGE_SIZE;
  // One extra row, to learn whether there is a next page without a count
  // query on every keystroke.
  const to = from + LOANS_PAGE_SIZE;

  let query = supabase
    .from('loans')
    .select(SUMMARY_COLUMNS)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (filter.status !== null) {
    query = query.eq('status', filter.status);
  }

  if (filter.clientId !== null) {
    query = query.eq('client_id', filter.clientId);
  }

  if (filter.query !== null) {
    const term = escapeSearchTerm(filter.query.trim());

    if (term !== '') {
      // The loan number lives on this table; the client's name and number are
      // on the embedded relation, which PostgREST filters by path.
      query = query.or(
        [
          `loan_number.ilike.%${term}%`,
          `clients.full_name.ilike.%${term}%`,
          `clients.client_number.ilike.%${term}%`,
        ].join(','),
      );
    }
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list loans.', { code: error.code });
    throw mapDatabaseError(error, 'loan');
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > LOANS_PAGE_SIZE;

  return {
    loans: rows.slice(0, LOANS_PAGE_SIZE).map(toSummary),
    page,
    hasMore,
  };
}

/** One loan, or null when it does not exist or the caller may not see it. */
export async function getLoan(loanId: string): Promise<LoanDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loans')
    .select(DETAIL_COLUMNS)
    .eq('id', loanId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a loan.', { code: error.code });
    throw mapDatabaseError(error, 'loan');
  }

  if (data === null) return null;

  const row = data as unknown as Record<string, unknown>;

  return {
    ...toSummary(row),
    interestMethod: String(row.interest_method),
    totalInterest: Number(row.total_interest),
    currencyCode: String(row.currency_code),
    minLoanAmountApplied: Number(row.min_loan_amount_applied),
    maxLoanAmountApplied:
      row.max_loan_amount_applied === null ? null : Number(row.max_loan_amount_applied),
    gracePeriodDaysApplied: Number(row.grace_period_days_applied),
    penaltyRateBpsApplied: Number(row.penalty_rate_bps_applied),
    submittedAt: nullableText(row, 'submitted_at'),
    approvedAt: nullableText(row, 'approved_at'),
    cancelledAt: nullableText(row, 'cancelled_at'),
    cancellationReason: nullableText(row, 'cancellation_reason'),
    reviewNote: nullableText(row, 'review_note'),
    notes: nullableText(row, 'notes'),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The stored contractual breakdown.
 *
 * Read, never recomputed. What the borrower was told is what the system
 * reports, so a later change to the engine cannot restate an existing loan.
 */
export async function getLoanPeriods(loanId: string): Promise<readonly LoanPeriod[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_periods')
    .select(
      'period_number, opening_principal, principal_portion, interest, total_obligation, closing_principal',
    )
    .eq('loan_id', loanId)
    .order('period_number', { ascending: true });

  if (error !== null) {
    logger.warn('Could not read a loan breakdown.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    periodNumber: Number(row.period_number),
    openingPrincipal: toUgx(Number(row.opening_principal)),
    principalPortion: toUgx(Number(row.principal_portion)),
    interest: toUgx(Number(row.interest)),
    totalObligation: toUgx(Number(row.total_obligation)),
    closingPrincipal: toUgx(Number(row.closing_principal)),
  }));
}

/**
 * The authoritative breakdown for figures not yet stored.
 *
 * Calls the database function rather than the TypeScript engine, so the
 * preview a staff member sees while entering a loan is the same arithmetic
 * that will be stored at approval. The TypeScript engine exists for tests and
 * for the browser-side preview; this is what the server shows.
 */
export async function previewLoanBreakdown(
  principalAmount: number,
  loanTermMonths: number,
  interestRateBps: number,
): Promise<readonly LoanPeriod[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('calculate_loan_breakdown', {
    p_principal: principalAmount,
    p_interest_rate_bps: interestRateBps,
    p_term_months: loanTermMonths,
  });

  if (error !== null) {
    logger.warn('Could not compute a loan preview.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    periodNumber: Number(row.period_number),
    openingPrincipal: toUgx(Number(row.opening_principal)),
    principalPortion: toUgx(Number(row.principal_portion)),
    interest: toUgx(Number(row.interest)),
    totalObligation: toUgx(Number(row.total_obligation)),
    closingPrincipal: toUgx(Number(row.closing_principal)),
  }));
}

/**
 * Why this loan cannot be approved, or an empty list.
 *
 * Asks the database, which is the same function `approve_loan` calls — so the
 * approval screen cannot show a green light that approval then refuses.
 */
export async function loanApprovalFailures(
  loanId: string,
): Promise<readonly { code: LoanApprovalFailure; detail: string | null }[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('validate_loan_for_approval', {
    p_loan_id: loanId,
  });

  if (error !== null) {
    logger.warn('Could not validate a loan for approval.', { code: error.code });
    // Fail closed: an unreadable validation is reported as a blocker rather
    // than as "nothing wrong".
    return [{ code: 'settings_unavailable', detail: null }];
  }

  return (data ?? []).flatMap((row) => {
    const code = row.failure_code;
    if (!isLoanApprovalFailure(code)) return [];
    return [{ code, detail: row.detail === null ? null : String(row.detail) }];
  });
}

export async function getLoanClientSnapshot(
  loanId: string,
): Promise<LoanClientSnapshot | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_client_snapshots')
    .select('*')
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null || data === null) return null;

  return {
    clientId: data.client_id,
    clientNumber: data.client_number,
    fullName: data.full_name,
    phone: data.phone,
    alternativePhone: data.alternative_phone,
    sex: data.sex,
    dateOfBirth: data.date_of_birth,
    occupation: data.occupation,
    businessType: data.business_type,
    villageArea: data.village_area,
    district: data.district,
    clientStatusAtOrigination: data.client_status_at_origination,
    capturedAt: data.captured_at,
  };
}

export async function getLoanGuarantorSnapshots(
  loanId: string,
): Promise<readonly LoanGuarantorSnapshot[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_guarantor_snapshots')
    .select('*')
    .eq('loan_id', loanId)
    .order('captured_at', { ascending: true });

  if (error !== null) return [];

  return (data ?? []).map((row) => ({
    id: row.id,
    guarantorId: row.guarantor_id,
    fullName: row.full_name,
    phone: row.phone,
    sex: row.sex,
    occupation: row.occupation,
    location: row.location,
    district: row.district,
    relationshipToClient: row.relationship_to_client,
    hadPhotograph: row.had_photograph,
  }));
}

/**
 * The identity snapshots, or an empty list.
 *
 * Empty for a caller without `loans:view_sensitive`, because the policy
 * filters them out. No capability check is written here: the database's answer
 * is the authority, and duplicating the rule in TypeScript would create a
 * second place for it to drift.
 */
export async function getLoanIdentitySnapshots(
  loanId: string,
): Promise<readonly LoanIdentitySnapshot[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_identity_snapshots')
    .select('subject_type, subject_id, nin')
    .eq('loan_id', loanId);

  if (error !== null) {
    // A refusal is the expected outcome for a Secretary/Treasurer. Logged at
    // debug level so it does not fill the log with non-events.
    logger.debug('Identity snapshots not readable by this caller.', {
      code: error.code,
    });
    return [];
  }

  return (data ?? []).flatMap((row) => {
    const subjectType = row.subject_type;

    if (subjectType !== 'client' && subjectType !== 'guarantor') return [];

    return [{ subjectType, subjectId: row.subject_id, nin: row.nin }];
  });
}

/** Does this client already have an active loan? For the creation screen. */
export async function clientHasActiveLoan(clientId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loans')
    .select('id')
    .eq('client_id', clientId)
    .eq('status', 'active')
    .limit(1);

  if (error !== null) {
    // Fail closed. Reporting "no active loan" when the check failed would
    // invite a creation that approval then refuses.
    logger.warn('Could not check for an active loan.', { code: error.code });
    return true;
  }

  return (data ?? []).length > 0;
}
