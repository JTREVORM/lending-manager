import 'server-only';

import { logger } from '@/lib/logger';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { sumUgx, toUgx, UGX_ZERO, type UgxAmount } from '@/lib/domain/money';
import {
  isCollateralItemType,
  isCollateralStatus,
  isGuaranteeStatus,
  isPromiseStatus,
  isRecoveryActionKind,
  isRecoveryOutcome,
  type CollateralItemType,
  type CollateralStatus,
  type GuaranteeStatus,
  type PromiseStatus,
  type RecoveryActionKind,
  type RecoveryOutcome,
} from '@/lib/domain/security';
import { isAgingBucket, type AgingBucket } from '@/lib/domain/risk';
import { MAX_EXPORT_ROWS, safeSearchTerm } from '@/lib/domain/reporting';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Reading security, recovery and risk.
 *
 * Every function here reads a view, under the reader's own Row Level Security
 * policies, for the reason `lib/data/delinquency.ts` sets out at length: a
 * figure the database computes and a figure TypeScript recomputes will
 * eventually disagree, and the borrower told two different arrears numbers has
 * no reason to believe either. So the aging bucket comes from `loan_aging`,
 * the PAR ratios come from `portfolio_at_risk`, and whether a promise was kept
 * comes from `loan_recovery_register` — none of them are decided here.
 *
 * ## What this module does decide
 *
 * Grouping. `portfolio_at_risk` returns the whole book and each slice of it in
 * one result set, and these functions pick the rows apart into the shape a
 * screen wants. That is presentation, not arithmetic: no number is added up
 * here that the database did not already add up.
 */

/* ------------------------------------------------------------------ */
/* Shared coercion                                                     */
/* ------------------------------------------------------------------ */

type Raw = Readonly<Record<string, unknown>>;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullableDate(value: unknown): BusinessDate | null {
  return value === null || value === undefined ? null : toBusinessDate(text(value));
}

function money(value: unknown): UgxAmount {
  return toUgx(Number(value ?? 0));
}

function nullableMoney(value: unknown): UgxAmount | null {
  return value === null || value === undefined ? null : toUgx(Number(value));
}

function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/* ------------------------------------------------------------------ */
/* Collateral                                                          */
/* ------------------------------------------------------------------ */

export interface CollateralItem {
  readonly id: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly loanStatus: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly clientName: string;
  readonly clientPhone: string;
  readonly productCode: string;
  readonly productName: string;
  readonly itemType: CollateralItemType;
  readonly description: string;
  readonly estimatedValue: UgxAmount;
  readonly valuedOn: BusinessDate;
  readonly serialNumber: string | null;
  readonly ownershipDocument: string | null;
  readonly location: string | null;
  readonly status: CollateralStatus;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
  readonly realisedAmount: UgxAmount | null;
  readonly realisedAt: string | null;
  readonly createdAt: string;
  /** What the loan still owes, or `null` where the reader cannot see it. */
  readonly totalOutstanding: UgxAmount | null;
}

const COLLATERAL_COLUMNS = `
  id, loan_id, loan_number, loan_status, branch_id, client_id, client_number,
  client_name, client_phone, product_code, product_name, item_type, description,
  estimated_value, valued_on, serial_number, ownership_document, location, status,
  released_at, release_reason, realised_amount, realised_at, created_at,
  total_outstanding
`;

function toCollateral(row: Raw): CollateralItem {
  // An unknown item type or status is a definition that drifted between the
  // migration and this module. It is logged and read as the widest honest
  // value rather than asserted, so one bad row does not blank a register.
  const itemType = isCollateralItemType(row.item_type) ? row.item_type : 'other';
  const status = isCollateralStatus(row.status) ? row.status : 'held';

  if (!isCollateralItemType(row.item_type) || !isCollateralStatus(row.status)) {
    logger.error('A collateral row carried a value this build does not know.', {
      itemType: text(row.item_type),
      status: text(row.status),
    });
  }

  return {
    id: text(row.id),
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    loanStatus: text(row.loan_status),
    clientId: text(row.client_id),
    clientNumber: text(row.client_number),
    clientName: text(row.client_name),
    clientPhone: text(row.client_phone),
    productCode: text(row.product_code),
    productName: text(row.product_name),
    itemType,
    description: text(row.description),
    estimatedValue: money(row.estimated_value),
    valuedOn: toBusinessDate(text(row.valued_on)),
    serialNumber: nullableText(row.serial_number),
    ownershipDocument: nullableText(row.ownership_document),
    location: nullableText(row.location),
    status,
    releasedAt: nullableText(row.released_at),
    releaseReason: nullableText(row.release_reason),
    realisedAmount: nullableMoney(row.realised_amount),
    realisedAt: nullableText(row.realised_at),
    createdAt: text(row.created_at),
    totalOutstanding: nullableMoney(row.total_outstanding),
  };
}

/** Every item pledged against one loan, newest first. */
export async function listLoanCollateral(loanId: string): Promise<CollateralItem[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_collateral_register')
    .select(COLLATERAL_COLUMNS)
    .eq('loan_id', loanId)
    .order('created_at', { ascending: false });

  if (error !== null) {
    logger.warn('Could not read the security on a loan.', { code: error.code });
    return [];
  }

  return (data ?? []).map(toCollateral);
}

/** The security register across the book. */
export async function listCollateral(
  filter: {
    readonly status?: CollateralStatus | null;
    readonly page?: number;
  } = {},
): Promise<{
  readonly items: CollateralItem[];
  readonly page: number;
  readonly hasMore: boolean;
}> {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, filter.page ?? 1);
  const size = 25;
  const from = (page - 1) * size;

  let query = supabase
    .from('loan_collateral_register')
    .select(COLLATERAL_COLUMNS)
    .order('created_at', { ascending: false })
    .range(from, from + size);

  if (filter.status !== null && filter.status !== undefined) {
    query = query.eq('status', filter.status);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the security register.', { code: error.code });
    return { items: [], page, hasMore: false };
  }

  const rows = data ?? [];

  // One row past the page is fetched to answer "is there a next page" without
  // a second count query, which is how every register in this codebase pages.
  return {
    items: rows.slice(0, size).map(toCollateral),
    page,
    hasMore: rows.length > size,
  };
}

/* ------------------------------------------------------------------ */
/* Guarantor exposure                                                  */
/* ------------------------------------------------------------------ */

export interface GuarantorExposureRow {
  readonly loanGuarantorId: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly loanStatus: string;
  readonly branchId: string | null;
  readonly productId: string;
  readonly productCode: string;
  readonly productName: string;
  readonly subjectKind: 'client' | 'external';
  readonly guarantorName: string;
  readonly guarantorPhone: string;
  readonly guarantorClientNumber: string | null;
  readonly guarantorClientId: string | null;
  readonly relationshipToClient: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly clientName: string;
  readonly clientPhone: string;
  readonly guaranteedAmount: UgxAmount;
  readonly guaranteedTotal: UgxAmount;
  readonly outstandingBalance: UgxAmount | null;
  readonly arrearsAmount: UgxAmount | null;
  readonly daysPastDue: number | null;
  readonly guaranteeDate: string | null;
  readonly consentVersion: string | null;
  readonly consentSigned: boolean;
  readonly evidenceFrozenAt: string | null;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
  readonly isReleased: boolean;
  readonly guaranteeStatus: GuaranteeStatus;
}

const EXPOSURE_COLUMNS = `
  loan_guarantor_id, loan_id, loan_number, loan_status, branch_id, loan_product_id,
  product_code, product_name, subject_kind, guarantor_id, guarantor_client_id,
  guarantor_name, guarantor_phone, guarantor_client_number, relationship_to_client,
  client_id, client_number, client_name, client_phone, guaranteed_amount,
  guaranteed_total, outstanding_balance, arrears_amount, days_past_due,
  delinquency_state, guarantee_date, consent_version, consent_signed,
  evidence_frozen_at, released_at, release_reason, is_released, guarantee_status,
  created_at
`;

function toExposure(row: Raw): GuarantorExposureRow {
  const status = isGuaranteeStatus(row.guarantee_status)
    ? row.guarantee_status
    : 'binding';

  if (!isGuaranteeStatus(row.guarantee_status)) {
    logger.error('A guarantee reported a status this build does not know.', {
      status: text(row.guarantee_status),
    });
  }

  return {
    loanGuarantorId: text(row.loan_guarantor_id),
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    loanStatus: text(row.loan_status),
    branchId: nullableText(row.branch_id),
    productId: text(row.loan_product_id),
    productCode: text(row.product_code),
    productName: text(row.product_name),
    subjectKind: row.subject_kind === 'client' ? 'client' : 'external',
    guarantorName: text(row.guarantor_name),
    guarantorPhone: text(row.guarantor_phone),
    guarantorClientNumber: nullableText(row.guarantor_client_number),
    guarantorClientId: nullableText(row.guarantor_client_id),
    relationshipToClient: text(row.relationship_to_client),
    clientId: text(row.client_id),
    clientNumber: text(row.client_number),
    clientName: text(row.client_name),
    clientPhone: text(row.client_phone),
    guaranteedAmount: money(row.guaranteed_amount),
    guaranteedTotal: money(row.guaranteed_total),
    outstandingBalance: nullableMoney(row.outstanding_balance),
    arrearsAmount: nullableMoney(row.arrears_amount),
    daysPastDue: nullableInt(row.days_past_due),
    guaranteeDate: nullableText(row.guarantee_date),
    consentVersion: nullableText(row.consent_version),
    consentSigned: Boolean(row.consent_signed),
    evidenceFrozenAt: nullableText(row.evidence_frozen_at),
    releasedAt: nullableText(row.released_at),
    releaseReason: nullableText(row.release_reason),
    isReleased: Boolean(row.is_released),
    guaranteeStatus: status,
  };
}

/** Every guarantee on one loan, with its exposure. */
export async function listLoanGuaranteeExposure(
  loanId: string,
): Promise<GuarantorExposureRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('guarantor_exposure')
    .select(EXPOSURE_COLUMNS)
    .eq('loan_id', loanId)
    .order('created_at', { ascending: true });

  if (error !== null) {
    logger.warn('Could not read the guarantees on a loan.', { code: error.code });
    return [];
  }

  return (data ?? []).map(toExposure);
}

/** The guarantor register. */
export async function listGuarantorExposure(filter: {
  readonly query?: string | null;
  readonly subjectKind?: 'client' | 'external' | null;
  readonly guaranteeStatus?: GuaranteeStatus | null;
  readonly productId?: string | null;
  readonly page?: number;
}): Promise<{
  readonly rows: GuarantorExposureRow[];
  readonly page: number;
  readonly hasMore: boolean;
}> {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, filter.page ?? 1);
  const size = 25;
  const from = (page - 1) * size;

  let query = supabase
    .from('guarantor_exposure')
    .select(EXPOSURE_COLUMNS)
    .order('created_at', { ascending: false })
    .range(from, from + size);

  const term = filter.query?.trim() ?? '';

  if (term !== '') {
    // Escaped the way every other register in this codebase escapes a term:
    // a comma or a parenthesis would otherwise be read as PostgREST syntax.
    const safe = term.replace(/[,()]/g, ' ').trim();

    if (safe !== '') {
      query = query.or(
        [
          `guarantor_name.ilike.%${safe}%`,
          `guarantor_phone.ilike.%${safe}%`,
          `client_name.ilike.%${safe}%`,
          `loan_number.ilike.%${safe}%`,
        ].join(','),
      );
    }
  }

  if (filter.subjectKind != null) query = query.eq('subject_kind', filter.subjectKind);
  if (filter.guaranteeStatus != null) {
    query = query.eq('guarantee_status', filter.guaranteeStatus);
  }
  if (filter.productId != null) query = query.eq('loan_product_id', filter.productId);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the guarantor register.', { code: error.code });
    return { rows: [], page, hasMore: false };
  }

  const rows = data ?? [];

  return {
    rows: rows.slice(0, size).map(toExposure),
    page,
    hasMore: rows.length > size,
  };
}

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

export interface RecoveryAction {
  readonly id: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientName: string;
  readonly clientPhone: string;
  readonly actionKind: RecoveryActionKind;
  readonly outcome: RecoveryOutcome | null;
  readonly notes: string;
  readonly actionDate: BusinessDate;
  readonly followUpOn: BusinessDate | null;
  readonly promisedAmount: UgxAmount | null;
  readonly promisedOn: BusinessDate | null;
  readonly promisePaidAmount: UgxAmount | null;
  readonly promiseStatus: PromiseStatus | null;
  readonly correctsActionId: string | null;
  readonly isCorrected: boolean;
  readonly createdByLabel: string;
  readonly createdAt: string;
}

const RECOVERY_COLUMNS = `
  id, loan_id, loan_number, loan_status, branch_id, client_id, client_number,
  client_name, client_phone, product_code, product_name, action_kind, outcome,
  notes, action_date, follow_up_on, promised_amount, promised_on,
  corrects_action_id, created_by, created_by_label, created_at, is_corrected,
  promise_paid_amount, promise_status
`;

function toRecoveryAction(row: Raw): RecoveryAction {
  const kind = isRecoveryActionKind(row.action_kind) ? row.action_kind : 'note';

  if (!isRecoveryActionKind(row.action_kind)) {
    logger.error('A recovery action reported a kind this build does not know.', {
      kind: text(row.action_kind),
    });
  }

  return {
    id: text(row.id),
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    clientName: text(row.client_name),
    clientPhone: text(row.client_phone),
    actionKind: kind,
    outcome: isRecoveryOutcome(row.outcome) ? row.outcome : null,
    notes: text(row.notes),
    actionDate: toBusinessDate(text(row.action_date)),
    followUpOn: nullableDate(row.follow_up_on),
    promisedAmount: nullableMoney(row.promised_amount),
    promisedOn: nullableDate(row.promised_on),
    promisePaidAmount: nullableMoney(row.promise_paid_amount),
    promiseStatus: isPromiseStatus(row.promise_status) ? row.promise_status : null,
    correctsActionId: nullableText(row.corrects_action_id),
    isCorrected: Boolean(row.is_corrected),
    createdByLabel: text(row.created_by_label),
    createdAt: text(row.created_at),
  };
}

/** Everything recorded against one loan, most recent first. */
export async function listLoanRecoveryActions(loanId: string): Promise<RecoveryAction[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_recovery_register')
    .select(RECOVERY_COLUMNS)
    .eq('loan_id', loanId)
    .order('action_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error !== null) {
    logger.warn('Could not read the recovery history on a loan.', { code: error.code });
    return [];
  }

  return (data ?? []).map(toRecoveryAction);
}

/** Every promise to pay on the book, most recently promised first. */
export async function listPromises(filter: {
  readonly status?: PromiseStatus | null;
  readonly page?: number;
}): Promise<{
  readonly promises: RecoveryAction[];
  readonly page: number;
  readonly hasMore: boolean;
}> {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, filter.page ?? 1);
  const size = 25;
  const from = (page - 1) * size;

  let query = supabase
    .from('loan_recovery_register')
    .select(RECOVERY_COLUMNS)
    .not('promised_amount', 'is', null)
    .order('promised_on', { ascending: false })
    .range(from, from + size);

  if (filter.status != null) query = query.eq('promise_status', filter.status);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the promises register.', { code: error.code });
    return { promises: [], page, hasMore: false };
  }

  const rows = data ?? [];

  return {
    promises: rows.slice(0, size).map(toRecoveryAction),
    page,
    hasMore: rows.length > size,
  };
}

export interface RecoveryStatusRow {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly loanStatus: string;
  readonly branchId: string | null;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly clientName: string;
  readonly clientPhone: string;
  readonly productCode: string;
  readonly productName: string;
  readonly arrearsAmount: UgxAmount | null;
  readonly daysPastDue: number | null;
  readonly delinquencyState: string | null;
  readonly totalOutstanding: UgxAmount | null;
  readonly actionCount: number;
  readonly lastActionDate: BusinessDate | null;
  readonly lastActionKind: RecoveryActionKind | null;
  readonly lastActionNotes: string | null;
  readonly lastActionBy: string | null;
  readonly nextFollowUpOn: BusinessDate | null;
  readonly overdueFollowUpOn: BusinessDate | null;
  readonly openPromiseAmount: UgxAmount | null;
  readonly openPromiseOn: BusinessDate | null;
  readonly openPromiseStatus: PromiseStatus | null;
}

const RECOVERY_STATUS_COLUMNS = `
  loan_id, loan_number, loan_status, branch_id, client_id, client_number,
  client_name, client_phone, product_code, product_name, arrears_amount,
  days_past_due, delinquency_state, total_outstanding, action_count,
  last_action_date, last_action_kind, last_action_notes, last_action_by,
  next_follow_up_on, overdue_follow_up_on, open_promise_amount,
  open_promise_on, open_promise_status
`;

function toRecoveryStatus(row: Raw): RecoveryStatusRow {
  return {
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    loanStatus: text(row.loan_status),
    branchId: nullableText(row.branch_id),
    clientId: text(row.client_id),
    clientNumber: text(row.client_number),
    clientName: text(row.client_name),
    clientPhone: text(row.client_phone),
    productCode: text(row.product_code),
    productName: text(row.product_name),
    arrearsAmount: nullableMoney(row.arrears_amount),
    daysPastDue: nullableInt(row.days_past_due),
    delinquencyState: nullableText(row.delinquency_state),
    totalOutstanding: nullableMoney(row.total_outstanding),
    actionCount: Number(row.action_count ?? 0),
    lastActionDate: nullableDate(row.last_action_date),
    lastActionKind: isRecoveryActionKind(row.last_action_kind)
      ? row.last_action_kind
      : null,
    lastActionNotes: nullableText(row.last_action_notes),
    lastActionBy: nullableText(row.last_action_by),
    nextFollowUpOn: nullableDate(row.next_follow_up_on),
    overdueFollowUpOn: nullableDate(row.overdue_follow_up_on),
    openPromiseAmount: nullableMoney(row.open_promise_amount),
    openPromiseOn: nullableDate(row.open_promise_on),
    openPromiseStatus: isPromiseStatus(row.open_promise_status)
      ? row.open_promise_status
      : null,
  };
}

/** One loan's recovery state, for the panel on its detail page. */
export async function getLoanRecoveryStatus(
  loanId: string,
): Promise<RecoveryStatusRow | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_recovery_status')
    .select(RECOVERY_STATUS_COLUMNS)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a loan recovery status.', { code: error.code });
    return null;
  }

  return data === null ? null : toRecoveryStatus(data);
}

/** The follow-up worklist: loans with an outstanding follow-up, oldest first. */
export async function listFollowUps(limit = 50): Promise<RecoveryStatusRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_recovery_status')
    .select(RECOVERY_STATUS_COLUMNS)
    .not('overdue_follow_up_on', 'is', null)
    .order('overdue_follow_up_on', { ascending: true })
    .limit(limit);

  if (error !== null) {
    logger.warn('Could not read the follow-up worklist.', { code: error.code });
    return [];
  }

  return (data ?? []).map(toRecoveryStatus);
}

/* ------------------------------------------------------------------ */
/* Aging and portfolio at risk                                         */
/* ------------------------------------------------------------------ */

export interface AgingRow {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly loanStatus: string;
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly productId: string;
  readonly productCode: string;
  readonly productName: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly clientName: string;
  readonly clientPhone: string;
  readonly principalAmount: UgxAmount;
  readonly principalRemaining: UgxAmount;
  readonly penaltyRemaining: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly arrearsAmount: UgxAmount;
  readonly missedInstallmentCount: number;
  readonly daysPastDue: number;
  readonly oldestPastDueDate: BusinessDate | null;
  readonly delinquencyState: string | null;
  readonly penaltyApplied: boolean;
  readonly agingBucket: AgingBucket;
  readonly agingRank: number;
  readonly lastPaymentDate: BusinessDate | null;
}

const AGING_COLUMNS = `
  loan_id, loan_number, loan_status, branch_id, branch_name, loan_product_id,
  product_code, product_name, client_id, client_number, client_name, client_phone,
  principal_amount, principal_remaining, interest_remaining, penalty_remaining,
  total_outstanding, arrears_amount, current_due, missed_installment_count,
  days_past_due, oldest_past_due_date, grace_end_date, within_grace_period,
  delinquency_state, penalty_applied, penalty_amount, penalty_paid, aging_bucket,
  aging_rank, at_risk_1, at_risk_7, at_risk_30, at_risk_60, at_risk_90,
  disbursed_at, last_payment_date
`;

function toAging(row: Raw): AgingRow {
  const bucket = isAgingBucket(row.aging_bucket) ? row.aging_bucket : 'current';

  if (!isAgingBucket(row.aging_bucket)) {
    logger.error('A loan reported an aging bucket this build does not know.', {
      bucket: text(row.aging_bucket),
    });
  }

  return {
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    loanStatus: text(row.loan_status),
    branchId: nullableText(row.branch_id),
    branchName: nullableText(row.branch_name),
    productId: text(row.loan_product_id),
    productCode: text(row.product_code),
    productName: text(row.product_name),
    clientId: text(row.client_id),
    clientNumber: text(row.client_number),
    clientName: text(row.client_name),
    clientPhone: text(row.client_phone),
    principalAmount: money(row.principal_amount),
    principalRemaining: money(row.principal_remaining),
    penaltyRemaining: money(row.penalty_remaining),
    totalOutstanding: money(row.total_outstanding),
    arrearsAmount: money(row.arrears_amount),
    missedInstallmentCount: Number(row.missed_installment_count ?? 0),
    daysPastDue: Number(row.days_past_due ?? 0),
    oldestPastDueDate: nullableDate(row.oldest_past_due_date),
    delinquencyState: nullableText(row.delinquency_state),
    penaltyApplied: Boolean(row.penalty_applied),
    agingBucket: bucket,
    agingRank: Number(row.aging_rank ?? 0),
    lastPaymentDate: nullableDate(row.last_payment_date),
  };
}

/** The aging register, optionally narrowed to one bucket. */
export async function listAging(filter: {
  readonly bucket?: AgingBucket | null;
  readonly productId?: string | null;
  readonly branchId?: string | null;
  readonly query?: string | null;
  readonly page?: number;
}): Promise<{
  readonly rows: AgingRow[];
  readonly page: number;
  readonly hasMore: boolean;
}> {
  const supabase = await createSupabaseServerClient();
  const page = Math.max(1, filter.page ?? 1);
  const size = 25;
  const from = (page - 1) * size;

  let query = supabase
    .from('loan_aging')
    .select(AGING_COLUMNS)
    // Worst first: a worklist that opens on the loans one day late buries the
    // ones three months late under them.
    .order('aging_rank', { ascending: false })
    .order('days_past_due', { ascending: false })
    .range(from, from + size);

  if (filter.bucket != null) query = query.eq('aging_bucket', filter.bucket);
  if (filter.productId != null) query = query.eq('loan_product_id', filter.productId);
  if (filter.branchId != null) query = query.eq('branch_id', filter.branchId);

  const term = filter.query?.trim() ?? '';

  if (term !== '') {
    const safe = term.replace(/[,()]/g, ' ').trim();

    if (safe !== '') {
      query = query.or(
        [
          `client_name.ilike.%${safe}%`,
          `client_number.ilike.%${safe}%`,
          `client_phone.ilike.%${safe}%`,
          `loan_number.ilike.%${safe}%`,
        ].join(','),
      );
    }
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the aging register.', { code: error.code });
    return { rows: [], page, hasMore: false };
  }

  const rows = data ?? [];

  return { rows: rows.slice(0, size).map(toAging), page, hasMore: rows.length > size };
}

export interface ParSlice {
  readonly scope: 'portfolio' | 'branch' | 'product' | 'branch_product';
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly productId: string | null;
  readonly productCode: string | null;
  readonly productName: string | null;
  readonly loanCount: number;
  readonly principalOutstanding: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly arrearsAmount: UgxAmount;
  readonly loansAtRisk: Readonly<Record<1 | 7 | 30 | 60 | 90, number>>;
  readonly principalAtRisk: Readonly<Record<1 | 7 | 30 | 60 | 90, UgxAmount>>;
  /** The ratio in basis points, or `null` where there is no portfolio. */
  readonly parBps: Readonly<Record<1 | 7 | 30 | 60 | 90, number | null>>;
  readonly loansByBucket: Readonly<Record<AgingBucket, number>>;
  readonly principalByBucket: Readonly<Record<AgingBucket, UgxAmount>>;
}

const PAR_COLUMNS = `
  scope, branch_id, branch_name, loan_product_id, product_code, product_name,
  loan_count, principal_outstanding, total_outstanding, arrears_amount,
  loans_at_risk_1, loans_at_risk_7, loans_at_risk_30, loans_at_risk_60,
  loans_at_risk_90, principal_at_risk_1, principal_at_risk_7, principal_at_risk_30,
  principal_at_risk_60, principal_at_risk_90, par1_bps, par7_bps, par30_bps,
  par60_bps, par90_bps, loans_bucket_current, loans_bucket_1_7, loans_bucket_8_30,
  loans_bucket_31_60, loans_bucket_61_90, loans_bucket_90_plus,
  principal_bucket_current, principal_bucket_1_7, principal_bucket_8_30,
  principal_bucket_31_60, principal_bucket_61_90, principal_bucket_90_plus
`;

function toParSlice(row: Raw): ParSlice {
  const scope = row.scope;

  return {
    scope:
      scope === 'branch' || scope === 'product' || scope === 'branch_product'
        ? scope
        : 'portfolio',
    branchId: nullableText(row.branch_id),
    branchName: nullableText(row.branch_name),
    productId: nullableText(row.loan_product_id),
    productCode: nullableText(row.product_code),
    productName: nullableText(row.product_name),
    loanCount: Number(row.loan_count ?? 0),
    principalOutstanding: money(row.principal_outstanding),
    totalOutstanding: money(row.total_outstanding),
    arrearsAmount: money(row.arrears_amount),
    loansAtRisk: {
      1: Number(row.loans_at_risk_1 ?? 0),
      7: Number(row.loans_at_risk_7 ?? 0),
      30: Number(row.loans_at_risk_30 ?? 0),
      60: Number(row.loans_at_risk_60 ?? 0),
      90: Number(row.loans_at_risk_90 ?? 0),
    },
    principalAtRisk: {
      1: money(row.principal_at_risk_1),
      7: money(row.principal_at_risk_7),
      30: money(row.principal_at_risk_30),
      60: money(row.principal_at_risk_60),
      90: money(row.principal_at_risk_90),
    },
    parBps: {
      1: nullableInt(row.par1_bps),
      7: nullableInt(row.par7_bps),
      30: nullableInt(row.par30_bps),
      60: nullableInt(row.par60_bps),
      90: nullableInt(row.par90_bps),
    },
    loansByBucket: {
      current: Number(row.loans_bucket_current ?? 0),
      '1_7': Number(row.loans_bucket_1_7 ?? 0),
      '8_30': Number(row.loans_bucket_8_30 ?? 0),
      '31_60': Number(row.loans_bucket_31_60 ?? 0),
      '61_90': Number(row.loans_bucket_61_90 ?? 0),
      '90_plus': Number(row.loans_bucket_90_plus ?? 0),
    },
    principalByBucket: {
      current: money(row.principal_bucket_current),
      '1_7': money(row.principal_bucket_1_7),
      '8_30': money(row.principal_bucket_8_30),
      '31_60': money(row.principal_bucket_31_60),
      '61_90': money(row.principal_bucket_61_90),
      '90_plus': money(row.principal_bucket_90_plus),
    },
  };
}

const EMPTY_PAR: ParSlice = {
  scope: 'portfolio',
  branchId: null,
  branchName: null,
  productId: null,
  productCode: null,
  productName: null,
  loanCount: 0,
  principalOutstanding: toUgx(0),
  totalOutstanding: toUgx(0),
  arrearsAmount: toUgx(0),
  loansAtRisk: { 1: 0, 7: 0, 30: 0, 60: 0, 90: 0 },
  principalAtRisk: {
    1: toUgx(0),
    7: toUgx(0),
    30: toUgx(0),
    60: toUgx(0),
    90: toUgx(0),
  },
  // Null, not zero. A book with no active loans has no PAR, and 0.0% would
  // read as perfect health rather than as nothing to measure.
  parBps: { 1: null, 7: null, 30: null, 60: null, 90: null },
  loansByBucket: {
    current: 0,
    '1_7': 0,
    '8_30': 0,
    '31_60': 0,
    '61_90': 0,
    '90_plus': 0,
  },
  principalByBucket: {
    current: toUgx(0),
    '1_7': toUgx(0),
    '8_30': toUgx(0),
    '31_60': toUgx(0),
    '61_90': toUgx(0),
    '90_plus': toUgx(0),
  },
};

/**
 * Risk monitoring, whole book and every slice, in one query.
 *
 * `portfolio_at_risk` returns the grouping sets together, so this reads once
 * and sorts the rows into the three shapes a screen asks for. ADR-042's
 * doctrine, applied to a view that was built for it.
 */
export async function getPortfolioAtRisk(): Promise<{
  readonly portfolio: ParSlice;
  readonly byBranch: ParSlice[];
  readonly byProduct: ParSlice[];
}> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.from('portfolio_at_risk').select(PAR_COLUMNS);

  if (error !== null) {
    logger.warn('Could not read portfolio at risk.', { code: error.code });
    return { portfolio: EMPTY_PAR, byBranch: [], byProduct: [] };
  }

  const slices = (data ?? []).map(toParSlice);

  return {
    portfolio: slices.find((slice) => slice.scope === 'portfolio') ?? EMPTY_PAR,
    byBranch: slices
      .filter((slice) => slice.scope === 'branch')
      .sort((a, b) => (a.branchName ?? '').localeCompare(b.branchName ?? '')),
    byProduct: slices
      .filter((slice) => slice.scope === 'product')
      .sort((a, b) => (a.productCode ?? '').localeCompare(b.productCode ?? '')),
  };
}

// ===========================================================================
// Export-shaped reads
//
// The loaders above are built for operational screens: twenty-five rows and a
// `hasMore`, because a worklist is something somebody works down.
//
// A report is a different question. It needs **every** matching row — a file
// holding page three of a register would be a subtle lie about what was
// downloaded — plus the totals and the honest admission when the set is too
// large to total. So these four read the same views, through the same column
// lists and the same mappers as the screens, and return the shape
// `lib/data/reports.ts` established: the rows, the totals, and `truncated`.
//
// Sharing the column lists and mappers is the point. A second copy of
// `AGING_COLUMNS` would be the thing that drifts, and a report whose columns
// had drifted from the screen's would disagree with it about the same loan.
// ===========================================================================

/** What every export-shaped read returns. Matches the Phase 8 report shape. */
export interface SecurityExport<Row, Totals> {
  readonly rows: readonly Row[];
  readonly totals: Totals;
  /** The set hit `MAX_EXPORT_ROWS`, so the totals describe only part of it. */
  readonly truncated: boolean;
  readonly matchedRows: number;
}

/**
 * The upper bound of the read window, which fetches one row past the ceiling.
 *
 * `range(from, to)` is **inclusive** at both ends in PostgREST, so
 * `range(0, MAX_EXPORT_ROWS)` returns up to `MAX_EXPORT_ROWS + 1` rows. That
 * extra row is the whole point: asking for exactly the ceiling cannot tell a
 * set of exactly that size from one of fifty thousand, and the difference
 * decides whether the totals are shown at all (ADR-042). The row itself is
 * discarded — `truncated` is `all.length > MAX_EXPORT_ROWS`, and the rows
 * returned are sliced back to the ceiling.
 */
const EXPORT_WINDOW = MAX_EXPORT_ROWS;

export interface AgingExportTotals {
  readonly loanCount: number;
  readonly principalOutstanding: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly arrears: UgxAmount;
  readonly penaltyOutstanding: UgxAmount;
}

export async function getAgingExport(
  filter: {
    readonly bucket?: AgingBucket | null;
    readonly productId?: string | null;
    readonly branchId?: string | null;
    readonly query?: string | null;
  } = {},
): Promise<SecurityExport<AgingRow, AgingExportTotals>> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('loan_aging')
    .select(AGING_COLUMNS)
    // Worst first, the same order the screen uses: a register that opens on
    // the loans one day late buries the ones three months late under them.
    .order('aging_rank', { ascending: false })
    .order('days_past_due', { ascending: false })
    .range(0, EXPORT_WINDOW);

  if (filter.bucket != null) query = query.eq('aging_bucket', filter.bucket);
  if (filter.productId != null) query = query.eq('loan_product_id', filter.productId);
  if (filter.branchId != null) query = query.eq('branch_id', filter.branchId);

  const term = safeSearchTerm(filter.query);
  if (term !== null) {
    query = query.or(
      [
        `loan_number.ilike.%${term}%`,
        `client_number.ilike.%${term}%`,
        `client_name.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the aging report.', { code: error.code });
    return { rows: [], totals: emptyAgingTotals(), truncated: false, matchedRows: 0 };
  }

  const all = (data ?? []).map((row) => toAging(row as Raw));
  const truncated = all.length > MAX_EXPORT_ROWS;
  const rows = truncated ? all.slice(0, MAX_EXPORT_ROWS) : all;

  return {
    rows,
    totals: {
      loanCount: rows.length,
      principalOutstanding: sumUgx(rows.map((row) => row.principalRemaining)),
      totalOutstanding: sumUgx(rows.map((row) => row.totalOutstanding)),
      arrears: sumUgx(rows.map((row) => row.arrearsAmount)),
      penaltyOutstanding: sumUgx(rows.map((row) => row.penaltyRemaining)),
    },
    truncated,
    matchedRows: rows.length,
  };
}

function emptyAgingTotals(): AgingExportTotals {
  return {
    loanCount: 0,
    principalOutstanding: UGX_ZERO,
    totalOutstanding: UGX_ZERO,
    arrears: UGX_ZERO,
    penaltyOutstanding: UGX_ZERO,
  };
}

export interface GuarantorExportTotals {
  /** Rows in the report: one per guarantee, released ones included. */
  readonly guaranteeCount: number;
  /** Distinct loans with at least one live guarantee. What the money is of. */
  readonly guaranteedLoanCount: number;
  /** Principal of those loans. Per loan, never per guarantee — see below. */
  readonly guaranteed: UgxAmount;
  readonly outstanding: UgxAmount;
  readonly arrears: UgxAmount;
  readonly releasedCount: number;
}

export async function getGuarantorExposureExport(
  filter: {
    readonly query?: string | null;
    readonly subjectKind?: 'client' | 'external' | null;
    readonly guaranteeStatus?: GuaranteeStatus | null;
    readonly productId?: string | null;
  } = {},
): Promise<SecurityExport<GuarantorExposureRow, GuarantorExportTotals>> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('guarantor_exposure')
    .select(EXPOSURE_COLUMNS)
    .order('created_at', { ascending: false })
    .range(0, EXPORT_WINDOW);

  const term = safeSearchTerm(filter.query);
  if (term !== null) {
    query = query.or(
      [
        `guarantor_name.ilike.%${term}%`,
        `client_name.ilike.%${term}%`,
        `loan_number.ilike.%${term}%`,
      ].join(','),
    );
  }

  if (filter.subjectKind != null) query = query.eq('subject_kind', filter.subjectKind);
  if (filter.guaranteeStatus != null) {
    query = query.eq('guarantee_status', filter.guaranteeStatus);
  }
  if (filter.productId != null) query = query.eq('loan_product_id', filter.productId);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the guarantor exposure report.', { code: error.code });
    return {
      rows: [],
      totals: {
        guaranteeCount: 0,
        guaranteedLoanCount: 0,
        guaranteed: UGX_ZERO,
        outstanding: UGX_ZERO,
        arrears: UGX_ZERO,
        releasedCount: 0,
      },
      truncated: false,
      matchedRows: 0,
    };
  }

  const all = (data ?? []).map((row) => toExposure(row as Raw));
  const truncated = all.length > MAX_EXPORT_ROWS;
  const rows = truncated ? all.slice(0, MAX_EXPORT_ROWS) : all;

  // Two exclusions, and the second one is the subtle one.
  //
  // **Released guarantees are out.** A released guarantor was told they are
  // out, so counting their amount among what the business is covered for
  // would overstate the cover by every guarantee ever let go — and that is a
  // figure that gets quoted in a lending decision.
  //
  // **Each loan counts once.** `guaranteed_amount` on this view is the
  // *loan's* principal, not a per-guarantor share of it: the view's framing is
  // that a guarantor stands behind the whole loan. So a loan with two live
  // guarantors has two rows carrying the same principal, and summing the
  // column would double the cover — on a book where the product requires two
  // guarantors, it would double the whole figure. The same applies to the
  // outstanding balance and the arrears, which are also the loan's.
  //
  // The per-row column is still right and still useful: it says what that
  // guarantor put their name to. It is the *total* that has to be taken per
  // loan, which is what `byLoan` below does.
  const live = rows.filter((row) => !row.isReleased);

  const byLoan = new Map<string, GuarantorExposureRow>();
  for (const row of live) {
    if (!byLoan.has(row.loanId)) byLoan.set(row.loanId, row);
  }
  const loans = [...byLoan.values()];

  return {
    rows,
    totals: {
      guaranteeCount: rows.length,
      guaranteedLoanCount: loans.length,
      guaranteed: sumUgx(loans.map((row) => row.guaranteedAmount)),
      outstanding: sumUgx(loans.map((row) => row.outstandingBalance ?? UGX_ZERO)),
      arrears: sumUgx(loans.map((row) => row.arrearsAmount ?? UGX_ZERO)),
      releasedCount: rows.length - live.length,
    },
    truncated,
    matchedRows: rows.length,
  };
}

export interface CollateralExportTotals {
  readonly itemCount: number;
  readonly valuedAt: UgxAmount;
  readonly heldCount: number;
  readonly realisedCount: number;
  readonly realised: UgxAmount;
}

export async function getCollateralExport(
  filter: { readonly status?: CollateralStatus | null } = {},
): Promise<SecurityExport<CollateralItem, CollateralExportTotals>> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('loan_collateral_register')
    .select(COLLATERAL_COLUMNS)
    .order('created_at', { ascending: false })
    .range(0, EXPORT_WINDOW);

  if (filter.status != null) query = query.eq('status', filter.status);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the security register report.', { code: error.code });
    return {
      rows: [],
      totals: {
        itemCount: 0,
        valuedAt: UGX_ZERO,
        heldCount: 0,
        realisedCount: 0,
        realised: UGX_ZERO,
      },
      truncated: false,
      matchedRows: 0,
    };
  }

  const all = (data ?? []).map((row) => toCollateral(row as Raw));
  const truncated = all.length > MAX_EXPORT_ROWS;
  const rows = truncated ? all.slice(0, MAX_EXPORT_ROWS) : all;

  const held = rows.filter((row) => row.status === 'held');
  const realised = rows.filter((row) => row.status === 'realised');

  return {
    rows,
    totals: {
      itemCount: rows.length,
      // The valuation of what is *held*, not of everything ever taken in. An
      // item released or sold is not cover any more, and a figure that
      // included it would say the business is secured against things it has
      // handed back.
      valuedAt: sumUgx(held.map((row) => row.estimatedValue)),
      heldCount: held.length,
      realisedCount: realised.length,
      realised: sumUgx(realised.map((row) => row.realisedAmount ?? UGX_ZERO)),
    },
    truncated,
    matchedRows: rows.length,
  };
}

export interface RecoveryExportTotals {
  readonly actionCount: number;
  readonly promiseCount: number;
  readonly promised: UgxAmount;
  readonly promisePaid: UgxAmount;
  readonly keptCount: number;
  readonly brokenCount: number;
}

export async function getRecoveryExport(
  filter: {
    readonly kind?: RecoveryActionKind | null;
    readonly promiseStatus?: PromiseStatus | null;
    readonly query?: string | null;
  } = {},
): Promise<SecurityExport<RecoveryAction, RecoveryExportTotals>> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('loan_recovery_register')
    .select(RECOVERY_COLUMNS)
    .order('action_date', { ascending: false })
    .order('created_at', { ascending: false })
    .range(0, EXPORT_WINDOW);

  if (filter.kind != null) query = query.eq('action_kind', filter.kind);
  if (filter.promiseStatus != null) {
    query = query.eq('promise_status', filter.promiseStatus);
  }

  const term = safeSearchTerm(filter.query);
  if (term !== null) {
    query = query.or(
      [`loan_number.ilike.%${term}%`, `client_name.ilike.%${term}%`].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the recovery report.', { code: error.code });
    return {
      rows: [],
      totals: {
        actionCount: 0,
        promiseCount: 0,
        promised: UGX_ZERO,
        promisePaid: UGX_ZERO,
        keptCount: 0,
        brokenCount: 0,
      },
      truncated: false,
      matchedRows: 0,
    };
  }

  const all = (data ?? []).map((row) => toRecoveryAction(row as Raw));
  const truncated = all.length > MAX_EXPORT_ROWS;
  const rows = truncated ? all.slice(0, MAX_EXPORT_ROWS) : all;

  const promises = rows.filter((row) => row.promisedAmount !== null);

  return {
    rows,
    totals: {
      actionCount: rows.length,
      promiseCount: promises.length,
      promised: sumUgx(promises.map((row) => row.promisedAmount ?? UGX_ZERO)),
      promisePaid: sumUgx(promises.map((row) => row.promisePaidAmount ?? UGX_ZERO)),
      keptCount: promises.filter((row) => row.promiseStatus === 'kept').length,
      brokenCount: promises.filter((row) => row.promiseStatus === 'broken').length,
    },
    truncated,
    matchedRows: rows.length,
  };
}
