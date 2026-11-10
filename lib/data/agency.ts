import 'server-only';

/**
 * Reading agency banking.
 *
 * Every function reads one of the seven Phase 4C views and never a sum this
 * module performs itself — the Phase 10 rule carried forward. A commission or
 * payable figure on a screen is the database's figure, attributed by **source
 * entity** per provider and per branch, because GL 1310 and the 2200-series
 * accounts are each shared between providers and an account-level total would
 * mix them.
 *
 * All seven views are `security_invoker`, so these reads run as the signed-in
 * person and Row Level Security decides what comes back: the capability, and
 * the branch they may see. A borrower holds no agency capability and so reads
 * nothing at all. Nothing here restates that rule, because two copies of a
 * rule drift.
 */

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import {
  isAgencyDirection,
  isAgencyFloatSource,
  isAgencyLineStatus,
  isAgencyReconciliationStatus,
  isAgencySettlementStatus,
  isAgencyStatus,
  isAgencyTradeKind,
  isAgencyTradeStatus,
  type AgencyCashCountRow,
  type AgencyCashMovementRow,
  type AgencyCommissionRow,
  type AgencyCommissionMonthRow,
  type AgencyCommissionReconciliationRow,
  type AgencyCommissionSettlementRow,
  type AgencyExceptionRow,
  type AgencyFloatRow,
  type AgencyFloatStatementRow,
  type AgencyFloatTradeRow,
  type AgencyLineCommissionRow,
  type AgencyMoneyLineRow,
  type AgencyMoneyProviderRow,
  type AgencyPayableRow,
  type AgencyPayableSettlementRow,
  type AgencyProviderRow,
  type AgencyReconciliationStatus,
  type AgencyServiceTypeRow,
  type AgencyStatus,
  type AgencyTradeStatus,
  type AgencyTransactionRow,
  type AgencyVarianceRow,
} from '@/lib/domain/agency';

/** A figure that may be absent, as shillings. */
function ugxOrNull(value: unknown): ReturnType<typeof toUgx> | null {
  return typeof value === 'number' ? toUgx(value) : null;
}

function ugx(value: unknown): ReturnType<typeof toUgx> {
  return toUgx(typeof value === 'number' ? value : 0);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Why a failed read is not an empty list.
 *
 * Every reader here used to answer a failure with `[]`, logged and moved on.
 * On a screen that renders a register that reads as "nothing yet", and on a
 * screen that totals a column it reads as "UGX 0" - a figure the business
 * would act on, produced by a query that never ran. "No commission
 * outstanding" and "we could not read the commission" are opposite
 * statements, and the data layer was turning the second into the first.
 *
 * So a read returns an outcome and a screen has to handle both arms. The
 * kinds are the ones a reader can actually tell apart:
 *
 *   `forbidden`    the database refused the caller - PostgREST answers
 *                  42501 or its own 401/403 codes. The route guard and RLS
 *                  normally make this unreachable, which is exactly why it
 *                  is worth naming when it happens.
 *   `unavailable`  anything else: the network, the API, a view that is not
 *                  there, a statement timeout.
 *
 * Note what is *not* a kind. Row Level Security refuses by returning no rows
 * rather than by erroring, so "this officer may not see this branch" and
 * "this branch has nothing" are indistinguishable here by design - that
 * distinction is made before the read, by `guardPermission` on the route.
 * Detecting it afterwards would mean inventing a signal the database does
 * not send.
 */
export interface AgencyReadFailure {
  readonly ok: false;
  readonly kind: 'forbidden' | 'unavailable';
  /** What could not be read, for the sentence a screen shows. */
  readonly what: string;
}

/** Rows, or the reason there are none. */
export type AgencyRows<Row> =
  { readonly ok: true; readonly rows: readonly Row[] } | AgencyReadFailure;

/** One row, nothing, or the reason neither could be determined. */
export type AgencyMaybeRow<Row> =
  { readonly ok: true; readonly row: Row | null } | AgencyReadFailure;

/** PostgREST's ways of saying "not you". */
const FORBIDDEN_CODES = new Set(['42501', 'PGRST301', 'PGRST302', '401', '403']);

function failed(
  what: string,
  error: { readonly message: string; readonly code?: string } | null,
): AgencyReadFailure {
  if (error !== null) logger.warn(`Could not read ${what}.`, { error: error.message });
  const kind =
    error?.code !== undefined && FORBIDDEN_CODES.has(error.code)
      ? 'forbidden'
      : 'unavailable';
  return { ok: false, kind, what };
}

// ---------------------------------------------------------------------------
// 1. Float balances by provider and till
// ---------------------------------------------------------------------------

export async function getAgencyFloatBalances(): Promise<AgencyRows<AgencyFloatRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_float_balances')
    .select('*')
    .order('provider_name')
    .order('till_name');

  if (error !== null || data === null)
    return failed('the float and till balances', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      floatAccountId: str(r.float_account_id),
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      tillName: str(r.till_name),
      tillIsActive: r.till_is_active === true,
      ledgerAccountCode: str(r.ledger_account_code),
      balance: ugx(r.balance),
      providerIsActive: r.provider_is_active === true,
      providerIsProvisional: r.provider_is_provisional === true,
    })),
  };
}

// ---------------------------------------------------------------------------
// 2. Transaction history
// ---------------------------------------------------------------------------

export async function getAgencyTransactions(options?: {
  readonly statuses?: readonly AgencyStatus[];
  readonly providerId?: string;
  readonly limit?: number;
}): Promise<AgencyRows<AgencyTransactionRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_transaction_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.statuses !== undefined && options.statuses.length > 0) {
    query = query.in('status', [...options.statuses]);
  }
  if (options?.providerId !== undefined) {
    query = query.eq('provider_id', options.providerId);
  }

  const { data, error } = await query;
  if (error !== null || data === null) return failed('the transaction register', error);

  return { ok: true, rows: data.map(mapTransaction) };
}

/**
 * One transaction, nothing, or the reason neither could be determined.
 *
 * The three are different answers and the screen shows three different
 * things. `null` means the row is not there or not this officer's to see -
 * deliberately indistinguishable, which is why the page answers both with
 * "not found". A failure is neither, and a page that treated it as "not
 * found" would tell an officer their transaction does not exist because a
 * query timed out.
 */
export async function getAgencyTransaction(
  id: string,
): Promise<AgencyMaybeRow<AgencyTransactionRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_transaction_history')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error !== null) return failed('this transaction', error);
  return { ok: true, row: data === null ? null : mapTransaction(data) };
}

/**
 * A counter, or nothing.
 *
 * Nothing rather than zero or NaN: a screen that could not read the revision
 * must offer no Verify button at all, and a silent default would hand the
 * weaker no-revision path to every caller.
 */
function intOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function mapTransaction(r: Record<string, unknown>): AgencyTransactionRow {
  return {
    id: str(r.id),
    branchId: str(r.branch_id),
    branchCode: str(r.branch_code),
    providerId: str(r.provider_id),
    providerCode: str(r.provider_code),
    providerName: str(r.provider_name),
    typeCode: str(r.type_code),
    typeName: str(r.type_name),
    direction: isAgencyDirection(r.direction) ? r.direction : null,
    transactionDate: toBusinessDate(str(r.transaction_date)),
    status: isAgencyStatus(r.status) ? r.status : 'draft',
    principalAmount: ugx(r.principal_amount),
    customerFee: ugx(r.customer_fee),
    commissionAmount: ugxOrNull(r.commission_amount),
    commissionComputed: ugxOrNull(r.commission_computed),
    commissionSupplied: ugxOrNull(r.commission_supplied),
    commissionExceptionReason: strOrNull(r.commission_exception_reason),
    customerIdentifier: strOrNull(r.customer_identifier),
    providerReference: strOrNull(r.provider_reference),
    journalEntryId: strOrNull(r.journal_entry_id),
    reversalEntryId: strOrNull(r.reversal_entry_id),
    submittedBy: strOrNull(r.submitted_by),
    verifiedBy: strOrNull(r.verified_by),
    revision: intOrNull(r.revision),
  };
}

// ---------------------------------------------------------------------------
// 3. Commission earned, received and outstanding
// ---------------------------------------------------------------------------

export async function getAgencyCommission(): Promise<AgencyRows<AgencyCommissionRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_commission_summary')
    .select('*')
    .order('provider_name');

  if (error !== null || data === null) return failed('the commission position', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      earned: ugx(r.commission_earned),
      received: ugx(r.commission_received),
      returned: ugx(r.commission_returned),
      outstanding: ugx(r.commission_outstanding),
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. Provider payables and remittances
// ---------------------------------------------------------------------------

export async function getAgencyPayables(): Promise<AgencyRows<AgencyPayableRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_payable_summary')
    .select('*')
    .order('provider_name');

  if (error !== null || data === null) return failed('what is owed to providers', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      collected: ugx(r.collected_on_behalf),
      remitted: ugx(r.remitted),
      remittanceReversed: ugx(r.remittance_reversed),
      outstanding: ugx(r.payable_outstanding),
    })),
  };
}

// ---------------------------------------------------------------------------
// 5. Cash and float variances
// ---------------------------------------------------------------------------

export async function getAgencyVariances(options?: {
  readonly kind?: 'cash' | 'float';
  readonly status?: 'open' | 'reconciled';
  readonly limit?: number;
}): Promise<AgencyRows<AgencyVarianceRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_variance_report')
    .select('*')
    .order('reconciliation_date', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.kind !== undefined) query = query.eq('reconciliation_kind', options.kind);
  if (options?.status !== undefined) query = query.eq('status', options.status);

  const { data, error } = await query;
  if (error !== null || data === null)
    return failed('the reconciliation variances', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      kind: r.reconciliation_kind === 'float' ? 'float' : 'cash',
      id: str(r.id),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      providerName: strOrNull(r.provider_name),
      reconciliationDate: toBusinessDate(str(r.reconciliation_date)),
      systemClosingBalance: ugx(r.system_closing_balance),
      countedOrStatement: ugx(r.counted_or_statement_balance),
      variance: num(r.variance),
      varianceMeans: str(r.variance_means),
      varianceWrittenOff: num(r.variance_written_off),
      status: r.status === 'reconciled' ? 'reconciled' : 'open',
      createdBy: strOrNull(r.created_by),
      reconciledBy: strOrNull(r.reconciled_by),
      statementRef: strOrNull(r.provider_statement_ref),
    })),
  };
}

// ---------------------------------------------------------------------------
// 6. Daily agency cash movement
// ---------------------------------------------------------------------------

export async function getAgencyCashMovement(options?: {
  readonly limit?: number;
}): Promise<AgencyRows<AgencyCashMovementRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_daily_cash_movement')
    .select('*')
    .order('entry_date', { ascending: false })
    .limit(options?.limit ?? 60);

  if (error !== null || data === null) return failed("the day's cash movement", error);

  return {
    ok: true,
    rows: data.map((r) => ({
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      entryDate: toBusinessDate(str(r.entry_date)),
      cashAccountCode: str(r.cash_account_code),
      sourceType: str(r.source_type),
      cashIn: ugx(r.cash_in),
      cashOut: ugx(r.cash_out),
      netMovement: num(r.net_movement),
    })),
  };
}

// ---------------------------------------------------------------------------
// 7. End-of-day exceptions
// ---------------------------------------------------------------------------

export async function getAgencyExceptions(): Promise<AgencyRows<AgencyExceptionRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_end_of_day_exceptions')
    .select('*')
    .order('exception_kind');

  if (error !== null || data === null) return failed('the outstanding exceptions', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      kind: str(r.exception_kind),
      branchId: str(r.branch_id),
      asOfDate: r.as_of_date === null ? null : toBusinessDate(str(r.as_of_date)),
      subjectId: str(r.subject_id),
      providerName: strOrNull(r.provider_name),
      amount: num(r.amount),
      detail: str(r.detail),
    })),
  };
}

// ---------------------------------------------------------------------------
// Configuration: providers and the services they offer
// ---------------------------------------------------------------------------

export async function getAgencyProviders(): Promise<AgencyRows<AgencyProviderRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_service_providers')
    .select(
      'id, code, name, category, float_model, commission_model, commission_rate_bps, commission_fixed, is_active, is_provisional',
    )
    .order('name');

  if (error !== null || data === null) return failed('the registered providers', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      code: str(r.code),
      name: str(r.name),
      category: str(r.category),
      floatModel: r.float_model === 'cash_payable' ? 'cash_payable' : 'provider_float',
      commissionModel: r.commission_model === 'immediate' ? 'immediate' : 'deferred',
      commissionRateBps:
        typeof r.commission_rate_bps === 'number' ? r.commission_rate_bps : null,
      commissionFixed: ugxOrNull(r.commission_fixed),
      isActive: r.is_active === true,
      isProvisional: r.is_provisional === true,
    })),
  };
}

export async function getAgencyServiceTypes(options?: {
  readonly providerId?: string;
}): Promise<AgencyRows<AgencyServiceTypeRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_transaction_types')
    .select(
      'id, provider_id, code, name, direction, max_single_transaction, requires_approval_above, is_active, agency_service_providers(name)',
    )
    .order('code');

  if (options?.providerId !== undefined) {
    query = query.eq('provider_id', options.providerId);
  }

  const { data, error } = await query;
  if (error !== null || data === null) return failed('the service types', error);

  return {
    ok: true,
    rows: data.map((r) => {
      const provider = r.agency_service_providers as { name?: unknown } | null;
      return {
        id: str(r.id),
        providerId: str(r.provider_id),
        providerName: str(provider?.name),
        code: str(r.code),
        name: str(r.name),
        direction: isAgencyDirection(r.direction) ? r.direction : 'deposit',
        maxSingleTransaction: ugxOrNull(r.max_single_transaction),
        requiresApprovalAbove: ugxOrNull(r.requires_approval_above),
        isActive: r.is_active === true,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 8. The four Phase 4D operational registers
//
// What an officer has to act on, rather than what a period totalled: counts
// waiting for a second signature, statements waiting to be certified,
// settlements that may need reversing. Each read is one view and no sum.
// ---------------------------------------------------------------------------

export async function getAgencyCashCounts(options?: {
  readonly statuses?: readonly AgencyReconciliationStatus[];
  readonly limit?: number;
}): Promise<AgencyRows<AgencyCashCountRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_cash_reconciliation_register')
    .select('*')
    .order('reconciliation_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.statuses !== undefined && options.statuses.length > 0) {
    query = query.in('status', [...options.statuses]);
  }

  const { data, error } = await query;
  if (error !== null || data === null) return failed('the physical cash counts', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      cashAccountId: str(r.cash_account_id),
      accountCode: str(r.account_code),
      accountName: str(r.account_name),
      reconciliationDate: toBusinessDate(str(r.reconciliation_date)),
      status: isAgencyReconciliationStatus(r.status) ? r.status : 'open',
      systemClosingBalance: ugx(r.system_closing_balance),
      physicalCount: ugx(r.physical_count),
      variance: ugx(r.variance),
      varianceMeans: str(r.variance_means),
      varianceWrittenOff: ugx(r.variance_written_off),
      varianceJournalEntryId: strOrNull(r.variance_journal_entry_id),
      notes: strOrNull(r.notes),
      createdBy: strOrNull(r.created_by),
      reconciledBy: strOrNull(r.reconciled_by),
      currentSystemBalance: ugx(r.current_system_balance),
      balanceMoved: r.balance_moved === true,
    })),
  };
}

export async function getAgencyFloatStatements(options?: {
  readonly statuses?: readonly AgencyReconciliationStatus[];
  readonly limit?: number;
}): Promise<AgencyRows<AgencyFloatStatementRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_float_reconciliation_register')
    .select('*')
    .order('reconciliation_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.statuses !== undefined && options.statuses.length > 0) {
    query = query.in('status', [...options.statuses]);
  }

  const { data, error } = await query;
  if (error !== null || data === null)
    return failed('the provider float statements', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      floatAccountId: str(r.float_account_id),
      tillName: str(r.till_name),
      accountCode: str(r.account_code),
      accountName: str(r.account_name),
      providerId: strOrNull(r.provider_id),
      providerCode: strOrNull(r.provider_code),
      providerName: strOrNull(r.provider_name),
      branchId: strOrNull(r.branch_id),
      branchCode: strOrNull(r.branch_code),
      reconciliationDate: toBusinessDate(str(r.reconciliation_date)),
      status: isAgencyReconciliationStatus(r.status) ? r.status : 'open',
      systemClosingBalance: ugx(r.system_closing_balance),
      providerStatementBalance: ugx(r.provider_statement_balance),
      providerStatementRef: strOrNull(r.provider_statement_ref),
      variance: ugx(r.variance),
      varianceMeans: str(r.variance_means),
      varianceWrittenOff: ugx(r.variance_written_off),
      varianceJournalEntryId: strOrNull(r.variance_journal_entry_id),
      notes: strOrNull(r.notes),
      createdBy: strOrNull(r.created_by),
      reconciledBy: strOrNull(r.reconciled_by),
      currentSystemBalance: ugx(r.current_system_balance),
      balanceMoved: r.balance_moved === true,
    })),
  };
}

export async function getAgencyCommissionSettlements(options?: {
  readonly limit?: number;
}): Promise<AgencyRows<AgencyCommissionSettlementRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_commission_settlement_register')
    .select('*')
    .order('settlement_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (error !== null || data === null) {
    return failed('the commission remittances received', error);
  }

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      settlementDate: toBusinessDate(str(r.settlement_date)),
      settlementAmount: ugx(r.settlement_amount),
      settlementAccountCode: str(r.settlement_account_code),
      settlementAccountName: str(r.settlement_account_name),
      providerStatementRef: strOrNull(r.provider_statement_ref),
      status: isAgencySettlementStatus(r.status) ? r.status : 'posted',
      journalEntryId: strOrNull(r.journal_entry_id),
      reversalEntryId: strOrNull(r.reversal_entry_id),
      reversalReason: strOrNull(r.reversal_reason),
    })),
  };
}

export async function getAgencyPayableSettlements(options?: {
  readonly limit?: number;
}): Promise<AgencyRows<AgencyPayableSettlementRow>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_payable_settlement_register')
    .select('*')
    .order('settlement_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (error !== null || data === null) {
    return failed('the remittances paid to providers', error);
  }

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      settlementDate: toBusinessDate(str(r.settlement_date)),
      settlementAmount: ugx(r.settlement_amount),
      cashAccountCode: str(r.cash_account_code),
      cashAccountName: str(r.cash_account_name),
      providerReceiptRef: strOrNull(r.provider_receipt_ref),
      status: isAgencySettlementStatus(r.status) ? r.status : 'posted',
      journalEntryId: strOrNull(r.journal_entry_id),
      reversalEntryId: strOrNull(r.reversal_entry_id),
      reversalReason: strOrNull(r.reversal_reason),
    })),
  };
}

/**
 * The tills a signed-in officer may actually post against, for a form.
 *
 * A failed read is passed through rather than filtered into an empty list.
 * "No till is available" and "we could not read the tills" look identical on
 * a form - both offer nothing to choose - and only one of them means the
 * officer should wait and try again.
 */
export async function getPostableFloatTills(): Promise<AgencyRows<AgencyFloatRow>> {
  const all = await getAgencyFloatBalances();
  if (!all.ok) return all;
  return {
    ok: true,
    rows: all.rows.filter(
      (f) => f.tillIsActive && f.providerIsActive && !f.providerIsProvisional,
    ),
  };
}

// ---------------------------------------------------------------------------
// Phase 4E — Mobile Money
//
// Six more views, read exactly as the seven before them: `security_invoker`,
// so the signed-in person's capability and branch decide what comes back, and
// never a sum this module performs itself. The per-line commission figures in
// particular come from the same functions the posting refusals use, so a
// screen cannot promise what a refusal would deny.
// ---------------------------------------------------------------------------

function mapLineCommission(r: Record<string, unknown>): AgencyLineCommissionRow {
  return {
    floatAccountId: str(r.float_account_id),
    providerId: str(r.provider_id),
    providerCode: str(r.provider_code),
    providerName: str(r.provider_name),
    branchId: str(r.branch_id),
    branchCode: str(r.branch_code),
    tillName: str(r.till_name),
    label: strOrNull(r.label),
    lineStatus: isAgencyLineStatus(r.line_status) ? r.line_status : 'active',
    ledgerAccountCode: str(r.ledger_account_code),
    floatBalance: ugx(r.float_balance),
    commissionOutstanding: ugx(r.commission_outstanding),
    recoveryOwed: ugx(r.recovery_owed),
  };
}

/** Commission owed to and by every agent line. */
export async function getAgencyLineCommission(options?: {
  readonly providerCode?: string;
}): Promise<AgencyRows<AgencyLineCommissionRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_commission_by_line')
    .select('*')
    .order('provider_name')
    .order('till_name');

  if (options?.providerCode !== undefined) {
    query = query.eq('provider_code', options.providerCode);
  }

  const { data, error } = await query;
  if (error !== null || data === null)
    return failed('the commission owed to each agent line', error);

  return { ok: true, rows: data.map(mapLineCommission) };
}

/** One row per agent line: the provider-scoped operational dashboard. */
export async function getAgencyMoneyDashboard(options?: {
  readonly providerCode?: string;
}): Promise<AgencyRows<AgencyMoneyLineRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_mobile_money_dashboard')
    .select('*')
    .order('provider_name')
    .order('till_name');

  if (options?.providerCode !== undefined) {
    query = query.eq('provider_code', options.providerCode);
  }

  const { data, error } = await query;
  if (error !== null || data === null) return failed('the Mobile Money dashboard', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      ...mapLineCommission(r),
      depositsToday: num(r.deposits_today),
      depositValueToday: ugx(r.deposit_value_today),
      withdrawalsToday: num(r.withdrawals_today),
      withdrawalValueToday: ugx(r.withdrawal_value_today),
      commissionToday: ugx(r.commission_today),
      customerFeesToday: ugx(r.customer_fees_today),
      pendingTrades: num(r.pending_trades),
      transactionsInFlight: num(r.transactions_in_flight),
      openCommissionReconciliations: num(r.open_commission_reconciliations),
    })),
  };
}

/**
 * One row per provider per branch.
 *
 * Transfers are their own two columns here because they are their own two
 * columns in the view: adding them to the purchase or sale totals would
 * report twice an amount that never left the provider.
 */
export async function getAgencyMoneyConsolidated(): Promise<
  AgencyRows<AgencyMoneyProviderRow>
> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_mobile_money_consolidated')
    .select('*')
    .order('provider_name')
    .order('branch_code');

  if (error !== null || data === null)
    return failed('the consolidated Mobile Money report', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      agentLines: num(r.agent_lines),
      activeLines: num(r.active_lines),
      suspendedLines: num(r.suspended_lines),
      floatHeld: ugx(r.float_held),
      commissionOutstanding: ugx(r.commission_outstanding),
      recoveryOwed: ugx(r.recovery_owed),
      floatPurchased: ugx(r.float_purchased),
      purchasePremium: ugx(r.purchase_premium),
      purchaseDiscount: ugx(r.purchase_discount),
      floatSold: ugx(r.float_sold),
      saleFeeIncome: ugx(r.sale_fee_income),
      floatTransferredOut: ugx(r.float_transferred_out),
      floatTransferredIn: ugx(r.float_transferred_in),
    })),
  };
}

/** Float purchases, sales and line-to-line transfers. */
export async function getAgencyFloatTrades(options?: {
  readonly providerCode?: string;
  readonly statuses?: readonly AgencyTradeStatus[];
  readonly limit?: number;
}): Promise<AgencyRows<AgencyFloatTradeRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_float_trade_register')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.providerCode !== undefined) {
    query = query.eq('provider_code', options.providerCode);
  }
  if (options?.statuses !== undefined && options.statuses.length > 0) {
    query = query.in('status', [...options.statuses]);
  }

  const { data, error } = await query;
  if (error !== null || data === null) return failed('the float trade register', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      kind: isAgencyTradeKind(r.kind) ? r.kind : 'purchase',
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      floatAccountId: str(r.float_account_id),
      tillName: str(r.till_name),
      label: strOrNull(r.label),
      counterFloatAccountId: strOrNull(r.counter_float_account_id),
      counterTillName: strOrNull(r.counter_till_name),
      counterLabel: strOrNull(r.counter_label),
      counterBranchCode: strOrNull(r.counter_branch_code),
      settlementAccountCode: strOrNull(r.settlement_account_code),
      settlementAccountName: strOrNull(r.settlement_account_name),
      tradeDate: str(r.trade_date),
      floatAmount: ugx(r.float_amount),
      cashAmount: ugxOrNull(r.cash_amount),
      feeAmount: ugxOrNull(r.fee_amount),
      totalAmount: ugx(r.total_amount),
      purchaseBasis: strOrNull(r.purchase_basis),
      purchaseDifference: ugxOrNull(r.purchase_difference),
      sourceKind: isAgencyFloatSource(r.source_kind) ? r.source_kind : null,
      counterpartyName: strOrNull(r.counterparty_name),
      reference: str(r.reference),
      notes: strOrNull(r.notes),
      status: isAgencyTradeStatus(r.status) ? r.status : 'pending',
      revision: num(r.revision),
      createdBy: str(r.created_by),
      createdAt: str(r.created_at),
      verifiedBy: strOrNull(r.verified_by),
      rejectedReason: strOrNull(r.rejected_reason),
      reversalReason: strOrNull(r.reversal_reason),
    })),
  };
}

/** Provider statement periods reconciled against the books. */
export async function getAgencyCommissionReconciliations(options?: {
  readonly providerCode?: string;
  readonly limit?: number;
}): Promise<AgencyRows<AgencyCommissionReconciliationRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_commission_reconciliation_register')
    .select('*')
    .order('period_end', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.providerCode !== undefined) {
    query = query.eq('provider_code', options.providerCode);
  }

  const { data, error } = await query;
  if (error !== null || data === null)
    return failed('the commission reconciliation register', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      id: str(r.id),
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      branchCode: str(r.branch_code),
      floatAccountId: str(r.float_account_id),
      tillName: str(r.till_name),
      label: strOrNull(r.label),
      periodStart: str(r.period_start),
      periodEnd: str(r.period_end),
      systemCommissionEarned: ugx(r.system_commission_earned),
      providerReportedCommission: ugx(r.provider_reported_commission),
      variance: ugx(r.variance),
      varianceMeans: str(r.variance_means),
      statementRef: str(r.statement_ref),
      status: r.status === 'certified' ? 'certified' : 'open',
      notes: strOrNull(r.notes),
      createdBy: str(r.created_by),
      reconciledBy: strOrNull(r.reconciled_by),
      currentSystemEarned: ugx(r.current_system_earned),
    })),
  };
}

/** Commission and volume per line per calendar month. */
export async function getAgencyCommissionMonths(options?: {
  readonly providerCode?: string;
  readonly limit?: number;
}): Promise<AgencyRows<AgencyCommissionMonthRow>> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_commission_monthly')
    .select('*')
    .order('month_start', { ascending: false })
    .order('till_name')
    .limit(options?.limit ?? 60);

  if (options?.providerCode !== undefined) {
    query = query.eq('provider_code', options.providerCode);
  }

  const { data, error } = await query;
  if (error !== null || data === null)
    return failed('the monthly commission report', error);

  return {
    ok: true,
    rows: data.map((r) => ({
      floatAccountId: str(r.float_account_id),
      providerId: str(r.provider_id),
      providerCode: str(r.provider_code),
      providerName: str(r.provider_name),
      branchId: str(r.branch_id),
      tillName: str(r.till_name),
      label: strOrNull(r.label),
      monthStart: str(r.month_start),
      transactions: num(r.transactions),
      principal: ugx(r.principal),
      customerFees: ugx(r.customer_fees),
      commissionEarned: ugx(r.commission_earned),
    })),
  };
}

/**
 * The lines a float trade may name, and what stands in the way of closing
 * each one.
 *
 * `obligations` comes from `agency_agent_line_obligations()`, the same
 * function `close_agency_agent_line()` refuses with — so the screen offers the
 * close button on exactly the lines the database would accept, rather than on
 * a second implementation of the rule.
 */
export async function getAgencyAgentLineObligations(
  floatAccountId: string,
): Promise<AgencyMaybeRow<readonly string[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('agency_agent_line_obligations', {
    p_float_account_id: floatAccountId,
  });

  if (error !== null) return failed('what stands in the way of closing this line', error);

  return { ok: true, row: Array.isArray(data) ? data.map((v) => String(v)) : [] };
}
