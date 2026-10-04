import 'server-only';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import { isPaymentMethod, type PaymentMethod } from '@/lib/domain/payment';
import { isDelinquencyState, type DelinquencyState } from '@/lib/domain/delinquency';
import {
  isCollectionStatus,
  resolvePageRequest,
  takePage,
  pageWindow,
  type CollectionStatus,
  type Paged,
} from '@/lib/domain/reporting';

/**
 * Reading the dashboards.
 *
 * ## Every figure is read, none is computed
 *
 * `dashboard_portfolio_summary` and `dashboard_collection_summary` are
 * database views that aggregate `loans`, `loan_balances`, `loan_delinquency`
 * and the payment ledger. This module converts their columns into typed
 * values and does nothing else — no addition, no apportioning, no ratios.
 *
 * That is not fastidiousness. A dashboard card that computed its own total
 * would be a second answer to a question the ledger has already answered, and
 * the first time the two disagreed, the business would have no way to tell
 * which was wrong. So the rule is that a card displays a column.
 *
 * ## Under the caller's own policies
 *
 * Every query uses the ordinary server client, so Row Level Security applies.
 * The summary views are `security_invoker`: a caller sees aggregates over the
 * rows their policies admit, not over the whole table. Nothing here uses the
 * privileged client, and a business-wide figure is business-wide only because
 * the caller is entitled to every row in it.
 *
 * ## Reading a dashboard writes nothing
 *
 * Including no penalty. A loan past its grace deadline contributes to
 * `loans_penalty_pending` and its projected charge is labelled pending; the
 * charge is written by the next transaction that touches the loan. Phase 7
 * made reads side-effect free and Phase 8 keeps them that way.
 */

type Raw = Readonly<Record<string, unknown>>;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  return '';
}

function money(value: unknown): UgxAmount {
  return toUgx(Number(value ?? 0));
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableDate(value: unknown): BusinessDate | null {
  return value === null || value === undefined ? null : toBusinessDate(text(value));
}

// ---------------------------------------------------------------------------
// The portfolio summary
// ---------------------------------------------------------------------------

export interface PortfolioSummary {
  readonly businessDate: BusinessDate;

  readonly totalClients: number;
  readonly activeClients: number;
  readonly inactiveClients: number;
  readonly suspendedClients: number;
  readonly blacklistedClients: number;
  readonly archivedClients: number;
  readonly clientsWithActiveLoan: number;

  readonly loansTotal: number;
  readonly loansDraft: number;
  readonly loansPendingApproval: number;
  readonly loansApproved: number;
  readonly loansActive: number;
  readonly loansCleared: number;
  readonly loansCancelled: number;

  readonly principalDisbursed: UgxAmount;
  readonly contractualInterest: UgxAmount;
  readonly contractualExpected: UgxAmount;

  readonly contractCollected: UgxAmount;
  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;
  readonly totalCollected: UgxAmount;
  readonly postedPaymentTotal: UgxAmount;

  readonly contractualOutstanding: UgxAmount;
  readonly principalOutstanding: UgxAmount;
  readonly interestOutstanding: UgxAmount;
  readonly penaltyAssessed: UgxAmount;
  readonly penaltyOutstanding: UgxAmount;
  readonly totalOutstanding: UgxAmount;

  /** Mutually exclusive: these partition the disbursed book exactly. */
  readonly byState: Readonly<Record<DelinquencyState, number>>;
  readonly loansWithSchedule: number;

  /** Overlapping measures — a loan may be counted in more than one. */
  readonly loansWithArrears: number;
  readonly loansPenalised: number;
  readonly loansPenaltyPending: number;

  readonly arrearsTotal: UgxAmount;
  readonly dueTodayTotal: UgxAmount;
  readonly currentDueTotal: UgxAmount;
}

const PORTFOLIO_COLUMNS = `
  business_date, total_clients, active_clients, inactive_clients, suspended_clients,
  blacklisted_clients, archived_clients, clients_with_active_loan,
  loans_total, loans_draft, loans_pending_approval, loans_approved, loans_active,
  loans_cleared, loans_cancelled, principal_disbursed, contractual_interest,
  contractual_expected, contract_collected, principal_collected, interest_collected,
  penalty_collected, total_collected, posted_payment_total, contractual_outstanding,
  principal_outstanding, interest_outstanding, penalty_assessed, penalty_outstanding,
  total_outstanding, loans_with_schedule, loans_state_current, loans_state_due_today,
  loans_state_in_arrears, loans_state_grace_period, loans_state_expired_unpaid,
  loans_state_penalty_due, loans_state_cleared, loans_with_arrears, loans_penalised,
  loans_penalty_pending, arrears_total, due_today_total, current_due_total
`;

/**
 * The business-wide position.
 *
 * Returns `null` when it cannot be read, and the caller shows an explanation
 * rather than zeroes. A dashboard of zeroes that means "the query failed" is
 * indistinguishable from one that means "the business has lent nothing", and
 * the two call for very different reactions.
 */
export async function getPortfolioSummary(): Promise<PortfolioSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('dashboard_portfolio_summary')
    .select(PORTFOLIO_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read the portfolio summary.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  const row = data as Raw;

  return {
    businessDate: toBusinessDate(text(row.business_date)),

    totalClients: count(row.total_clients),
    activeClients: count(row.active_clients),
    inactiveClients: count(row.inactive_clients),
    suspendedClients: count(row.suspended_clients),
    blacklistedClients: count(row.blacklisted_clients),
    archivedClients: count(row.archived_clients),
    clientsWithActiveLoan: count(row.clients_with_active_loan),

    loansTotal: count(row.loans_total),
    loansDraft: count(row.loans_draft),
    loansPendingApproval: count(row.loans_pending_approval),
    loansApproved: count(row.loans_approved),
    loansActive: count(row.loans_active),
    loansCleared: count(row.loans_cleared),
    loansCancelled: count(row.loans_cancelled),

    principalDisbursed: money(row.principal_disbursed),
    contractualInterest: money(row.contractual_interest),
    contractualExpected: money(row.contractual_expected),

    contractCollected: money(row.contract_collected),
    principalCollected: money(row.principal_collected),
    interestCollected: money(row.interest_collected),
    penaltyCollected: money(row.penalty_collected),
    totalCollected: money(row.total_collected),
    postedPaymentTotal: money(row.posted_payment_total),

    contractualOutstanding: money(row.contractual_outstanding),
    principalOutstanding: money(row.principal_outstanding),
    interestOutstanding: money(row.interest_outstanding),
    penaltyAssessed: money(row.penalty_assessed),
    penaltyOutstanding: money(row.penalty_outstanding),
    totalOutstanding: money(row.total_outstanding),

    byState: {
      current: count(row.loans_state_current),
      due_today: count(row.loans_state_due_today),
      in_arrears: count(row.loans_state_in_arrears),
      grace_period: count(row.loans_state_grace_period),
      expired_unpaid: count(row.loans_state_expired_unpaid),
      penalty_due: count(row.loans_state_penalty_due),
      cleared: count(row.loans_state_cleared),
    },
    loansWithSchedule: count(row.loans_with_schedule),

    loansWithArrears: count(row.loans_with_arrears),
    loansPenalised: count(row.loans_penalised),
    loansPenaltyPending: count(row.loans_penalty_pending),

    arrearsTotal: money(row.arrears_total),
    dueTodayTotal: money(row.due_today_total),
    currentDueTotal: money(row.current_due_total),
  };
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export interface CollectionSummary {
  readonly businessDate: BusinessDate;

  /** The day's target as it stood this morning. */
  readonly expectedToday: UgxAmount;
  /** What is still uncovered of today's collections, right now. */
  readonly remainingToday: UgxAmount;
  readonly loansDueToday: number;
  readonly clientsDueToday: number;
  readonly loansSettledToday: number;

  /** Posted payments received today, reversals excluded. */
  readonly collectedToday: UgxAmount;
  readonly paymentsToday: number;
  readonly clientsPayingToday: number;

  readonly cashReceived: UgxAmount;
  readonly mtnReceived: UgxAmount;
  readonly airtelReceived: UgxAmount;

  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;

  readonly reversedTodayAmount: UgxAmount;
  readonly reversedTodayCount: number;
}

const COLLECTION_COLUMNS = `
  business_date, expected_today, remaining_today, loans_due_today, clients_due_today,
  loans_settled_today, collected_today, payments_today, clients_paying_today,
  cash_received, mtn_received, airtel_received, principal_collected,
  interest_collected, penalty_collected, reversed_today_amount, reversed_today_count
`;

export async function getCollectionSummary(): Promise<CollectionSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('dashboard_collection_summary')
    .select(COLLECTION_COLUMNS)
    .maybeSingle();

  if (error !== null) {
    logger.warn("Could not read today's collection summary.", { code: error.code });
    return null;
  }

  if (data === null) return null;

  const row = data as Raw;

  return {
    businessDate: toBusinessDate(text(row.business_date)),

    expectedToday: money(row.expected_today),
    remainingToday: money(row.remaining_today),
    loansDueToday: count(row.loans_due_today),
    clientsDueToday: count(row.clients_due_today),
    loansSettledToday: count(row.loans_settled_today),

    collectedToday: money(row.collected_today),
    paymentsToday: count(row.payments_today),
    clientsPayingToday: count(row.clients_paying_today),

    cashReceived: money(row.cash_received),
    mtnReceived: money(row.mtn_received),
    airtelReceived: money(row.airtel_received),

    principalCollected: money(row.principal_collected),
    interestCollected: money(row.interest_collected),
    penaltyCollected: money(row.penalty_collected),

    reversedTodayAmount: money(row.reversed_today_amount),
    reversedTodayCount: count(row.reversed_today_count),
  };
}

// ---------------------------------------------------------------------------
// Today's collection sheet
// ---------------------------------------------------------------------------

export type { CollectionStatus };

export interface CollectionSheetRow {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly loanStatus: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly clientName: string;
  readonly clientPhone: string;
  readonly installmentNumber: number;
  readonly scheduledAmount: UgxAmount;
  readonly expectedToday: UgxAmount;
  readonly collectedToday: UgxAmount;
  readonly paymentsToday: number;
  readonly remainingToday: UgxAmount;
  readonly arrearsAmount: UgxAmount;
  readonly currentDue: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly daysPastDue: number;
  readonly missedInstallmentCount: number;
  readonly state: DelinquencyState;
  readonly collectionStatus: CollectionStatus;
}

const SHEET_COLUMNS = `
  loan_id, loan_number, loan_status, client_id, client_number, client_name,
  client_phone, business_date, installment_number, scheduled_amount, expected_today,
  collected_today, payments_today, remaining_today, arrears_amount, current_due,
  total_outstanding, days_past_due, missed_installment_count, delinquency_state,
  collection_status
`;

function toSheetRow(row: Raw): CollectionSheetRow {
  const rawState = row.delinquency_state;
  const rawStatus = row.collection_status;

  return {
    loanId: text(row.loan_id),
    loanNumber: text(row.loan_number),
    loanStatus: text(row.loan_status),
    clientId: text(row.client_id),
    clientNumber: text(row.client_number),
    clientName: text(row.client_name),
    clientPhone: text(row.client_phone),
    installmentNumber: count(row.installment_number),
    scheduledAmount: money(row.scheduled_amount),
    expectedToday: money(row.expected_today),
    collectedToday: money(row.collected_today),
    paymentsToday: count(row.payments_today),
    remainingToday: money(row.remaining_today),
    arrearsAmount: money(row.arrears_amount),
    currentDue: money(row.current_due),
    totalOutstanding: money(row.total_outstanding),
    daysPastDue: count(row.days_past_due),
    missedInstallmentCount: count(row.missed_installment_count),
    state: isDelinquencyState(rawState) ? rawState : 'current',
    collectionStatus: isCollectionStatus(rawStatus) ? rawStatus : 'unpaid',
  };
}

/**
 * Who is due today.
 *
 * A loan whose collection due today was already covered by an earlier
 * overpayment is absent from the underlying view, so it never appears here.
 * Sending somebody to collect from a borrower who paid ahead is the kind of
 * error that costs the business a customer.
 *
 * Unpaid first, because that is the working order: the list is read top to
 * bottom during the day and the settled rows belong at the bottom.
 */
export async function listCollectionSheet(
  options: {
    readonly status?: CollectionStatus;
    readonly page?: unknown;
    readonly pageSize?: unknown;
  } = {},
): Promise<Paged<CollectionSheetRow>> {
  const supabase = await createSupabaseServerClient();
  const request = resolvePageRequest(options);
  const window = pageWindow(request);

  let query = supabase
    .from('collections_today')
    .select(SHEET_COLUMNS)
    .order('collection_status', { ascending: true })
    .order('remaining_today', { ascending: false })
    .order('loan_number', { ascending: true })
    .range(window.from, window.to);

  if (options.status !== undefined) {
    query = query.eq('collection_status', options.status);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn("Could not read today's collection sheet.", { code: error.code });
    return { rows: [], page: request.page, pageSize: request.pageSize, hasMore: false };
  }

  return takePage(
    (data ?? []).map((row) => toSheetRow(row as Raw)),
    request,
  );
}

// ---------------------------------------------------------------------------
// Recent payments
// ---------------------------------------------------------------------------

export interface RecentPayment {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly amount: UgxAmount;
  readonly paymentMethod: PaymentMethod;
  readonly status: string;
  readonly isEffective: boolean;
  readonly receivedAt: string;
  readonly businessDate: BusinessDate;
  readonly recordedByLabel: string;
}

/**
 * The latest payments, newest first.
 *
 * Reversed payments are included and labelled. A recent-activity panel that
 * hid them would show a payment this morning that has since been withdrawn as
 * though the money were still in — and the person most likely to look at this
 * panel is the one who needs to know it was taken back.
 */
export async function listRecentPayments(
  limit = 8,
  options: { readonly clientId?: string; readonly loanId?: string } = {},
): Promise<readonly RecentPayment[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('payment_register')
    .select(
      `payment_id, payment_number, loan_id, loan_number, client_id, client_name,
       amount, payment_method, status, is_effective, received_at, business_date,
       recorded_by_label`,
    )
    .order('received_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));

  if (options.clientId !== undefined) query = query.eq('client_id', options.clientId);
  if (options.loanId !== undefined) query = query.eq('loan_id', options.loanId);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read recent payments.', { code: error.code });
    return [];
  }

  return (data ?? []).map((raw) => {
    const row = raw as Raw;
    const method = row.payment_method;

    return {
      paymentId: text(row.payment_id),
      paymentNumber: text(row.payment_number),
      loanId: text(row.loan_id),
      loanNumber: text(row.loan_number),
      clientId: text(row.client_id),
      clientName: text(row.client_name),
      amount: money(row.amount),
      paymentMethod: isPaymentMethod(method) ? method : 'cash',
      status: text(row.status),
      isEffective: Boolean(row.is_effective),
      receivedAt: text(row.received_at),
      businessDate: toBusinessDate(text(row.business_date)),
      recordedByLabel: text(row.recorded_by_label),
    };
  });
}

// ---------------------------------------------------------------------------
// Upcoming collections
// ---------------------------------------------------------------------------

export interface UpcomingCollection {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly installmentNumber: number;
  readonly dueDate: BusinessDate;
  readonly expectedAmount: UgxAmount;
  readonly remainingAmount: UgxAmount;
}

/**
 * Scheduled collections still to come.
 *
 * Filtered on `remaining_amount > 0`, so a future collection a borrower has
 * already covered by paying ahead does not appear. §58 and §130: a prepaid
 * installment is not upcoming work.
 */
export async function listUpcomingCollections(options: {
  readonly after: BusinessDate;
  readonly through: BusinessDate;
  readonly limit?: number;
}): Promise<readonly UpcomingCollection[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_installment_coverage')
    .select('loan_id, installment_number, due_date, expected_amount, remaining_amount')
    .gt('due_date', options.after)
    .lte('due_date', options.through)
    .gt('remaining_amount', 0)
    .order('due_date', { ascending: true })
    .limit(Math.min(200, Math.max(1, options.limit ?? 25)));

  if (error !== null) {
    logger.warn('Could not read upcoming collections.', { code: error.code });
    return [];
  }

  const rows = (data ?? []).map((raw) => {
    const row = raw as Raw;
    return {
      loanId: text(row.loan_id),
      installmentNumber: count(row.installment_number),
      dueDate: toBusinessDate(text(row.due_date)),
      expectedAmount: money(row.expected_amount),
      remainingAmount: money(row.remaining_amount),
    };
  });

  if (rows.length === 0) return [];

  // The coverage view carries no foreign key for PostgREST to embed through, so
  // the loan numbers come from one extra query keyed on the ids already read —
  // not one query per row.
  const { data: loans } = await supabase
    .from('loans')
    .select('id, loan_number')
    .in('id', [...new Set(rows.map((row) => row.loanId))]);

  const numbers = new Map(
    (loans ?? []).map((loan) => [text(loan.id), text(loan.loan_number)]),
  );

  return rows.map((row) => ({
    ...row,
    loanNumber: numbers.get(row.loanId) ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Recent lifecycle activity
// ---------------------------------------------------------------------------

export interface LoanActivityRow {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly principalAmount: UgxAmount;
  readonly totalOutstanding: UgxAmount;
  readonly disbursedAt: string | null;
  readonly clearedAt: string | null;
  readonly penaltyEffectiveDate: BusinessDate | null;
}

async function listLoanActivity(
  column: 'disbursed_at' | 'cleared_at',
  limit: number,
): Promise<readonly LoanActivityRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_portfolio_report')
    .select(
      `loan_id, loan_number, client_id, client_name, principal_amount,
       total_outstanding, disbursed_at, cleared_at, penalty_effective_date`,
    )
    .not(column, 'is', null)
    .order(column, { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));

  if (error !== null) {
    logger.warn('Could not read recent loan activity.', { code: error.code, column });
    return [];
  }

  return (data ?? []).map((raw) => {
    const row = raw as Raw;
    return {
      loanId: text(row.loan_id),
      loanNumber: text(row.loan_number),
      clientId: text(row.client_id),
      clientName: text(row.client_name),
      principalAmount: money(row.principal_amount),
      totalOutstanding: money(row.total_outstanding),
      disbursedAt: row.disbursed_at === null ? null : text(row.disbursed_at),
      clearedAt: row.cleared_at === null ? null : text(row.cleared_at),
      penaltyEffectiveDate: nullableDate(row.penalty_effective_date),
    };
  });
}

export function listRecentDisbursements(limit = 5): Promise<readonly LoanActivityRow[]> {
  return listLoanActivity('disbursed_at', limit);
}

export function listRecentClearances(limit = 5): Promise<readonly LoanActivityRow[]> {
  return listLoanActivity('cleared_at', limit);
}

/** Loans carrying a recorded late-payment charge, most recent charge first. */
export async function listRecentlyPenalised(
  limit = 5,
): Promise<readonly LoanActivityRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_portfolio_report')
    .select(
      `loan_id, loan_number, client_id, client_name, principal_amount,
       total_outstanding, disbursed_at, cleared_at, penalty_effective_date`,
    )
    .eq('penalty_applied', true)
    .order('penalty_effective_date', { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));

  if (error !== null) {
    logger.warn('Could not read recently penalised loans.', { code: error.code });
    return [];
  }

  return (data ?? []).map((raw) => {
    const row = raw as Raw;
    return {
      loanId: text(row.loan_id),
      loanNumber: text(row.loan_number),
      clientId: text(row.client_id),
      clientName: text(row.client_name),
      principalAmount: money(row.principal_amount),
      totalOutstanding: money(row.total_outstanding),
      disbursedAt: row.disbursed_at === null ? null : text(row.disbursed_at),
      clearedAt: row.cleared_at === null ? null : text(row.cleared_at),
      penaltyEffectiveDate: nullableDate(row.penalty_effective_date),
    };
  });
}
