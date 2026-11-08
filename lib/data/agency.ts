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
  isAgencyReconciliationStatus,
  isAgencySettlementStatus,
  isAgencyStatus,
  type AgencyCashCountRow,
  type AgencyCashMovementRow,
  type AgencyCommissionRow,
  type AgencyCommissionSettlementRow,
  type AgencyExceptionRow,
  type AgencyFloatRow,
  type AgencyFloatStatementRow,
  type AgencyPayableRow,
  type AgencyPayableSettlementRow,
  type AgencyProviderRow,
  type AgencyReconciliationStatus,
  type AgencyServiceTypeRow,
  type AgencyStatus,
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

/** A read that came back empty because it failed, logged and not thrown. */
function empty<Row>(what: string, error: { message: string } | null): Row[] {
  if (error !== null) logger.warn(`Could not read ${what}.`, { error: error.message });
  return [];
}

// ---------------------------------------------------------------------------
// 1. Float balances by provider and till
// ---------------------------------------------------------------------------

export async function getAgencyFloatBalances(): Promise<AgencyFloatRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_float_balances')
    .select('*')
    .order('provider_name')
    .order('till_name');

  if (error !== null || data === null) return empty('agency float balances', error);

  return data.map((r) => ({
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
  }));
}

// ---------------------------------------------------------------------------
// 2. Transaction history
// ---------------------------------------------------------------------------

export async function getAgencyTransactions(options?: {
  readonly statuses?: readonly AgencyStatus[];
  readonly providerId?: string;
  readonly limit?: number;
}): Promise<AgencyTransactionRow[]> {
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
  if (error !== null || data === null) return empty('agency transactions', error);

  return data.map(mapTransaction);
}

export async function getAgencyTransaction(
  id: string,
): Promise<AgencyTransactionRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_transaction_history')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read the agency transaction.', { error: error.message });
    return null;
  }
  return data === null ? null : mapTransaction(data);
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

export async function getAgencyCommission(): Promise<AgencyCommissionRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_commission_summary')
    .select('*')
    .order('provider_name');

  if (error !== null || data === null) return empty('agency commission', error);

  return data.map((r) => ({
    providerId: str(r.provider_id),
    providerCode: str(r.provider_code),
    providerName: str(r.provider_name),
    branchId: str(r.branch_id),
    branchCode: str(r.branch_code),
    earned: ugx(r.commission_earned),
    received: ugx(r.commission_received),
    returned: ugx(r.commission_returned),
    outstanding: ugx(r.commission_outstanding),
  }));
}

// ---------------------------------------------------------------------------
// 4. Provider payables and remittances
// ---------------------------------------------------------------------------

export async function getAgencyPayables(): Promise<AgencyPayableRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_payable_summary')
    .select('*')
    .order('provider_name');

  if (error !== null || data === null) return empty('agency payables', error);

  return data.map((r) => ({
    providerId: str(r.provider_id),
    providerCode: str(r.provider_code),
    providerName: str(r.provider_name),
    branchId: str(r.branch_id),
    branchCode: str(r.branch_code),
    collected: ugx(r.collected_on_behalf),
    remitted: ugx(r.remitted),
    remittanceReversed: ugx(r.remittance_reversed),
    outstanding: ugx(r.payable_outstanding),
  }));
}

// ---------------------------------------------------------------------------
// 5. Cash and float variances
// ---------------------------------------------------------------------------

export async function getAgencyVariances(options?: {
  readonly kind?: 'cash' | 'float';
  readonly status?: 'open' | 'reconciled';
  readonly limit?: number;
}): Promise<AgencyVarianceRow[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('agency_variance_report')
    .select('*')
    .order('reconciliation_date', { ascending: false })
    .limit(options?.limit ?? 50);

  if (options?.kind !== undefined) query = query.eq('reconciliation_kind', options.kind);
  if (options?.status !== undefined) query = query.eq('status', options.status);

  const { data, error } = await query;
  if (error !== null || data === null) return empty('agency variances', error);

  return data.map((r) => ({
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
  }));
}

// ---------------------------------------------------------------------------
// 6. Daily agency cash movement
// ---------------------------------------------------------------------------

export async function getAgencyCashMovement(options?: {
  readonly limit?: number;
}): Promise<AgencyCashMovementRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_daily_cash_movement')
    .select('*')
    .order('entry_date', { ascending: false })
    .limit(options?.limit ?? 60);

  if (error !== null || data === null) return empty('agency cash movement', error);

  return data.map((r) => ({
    branchId: str(r.branch_id),
    branchCode: str(r.branch_code),
    entryDate: toBusinessDate(str(r.entry_date)),
    cashAccountCode: str(r.cash_account_code),
    sourceType: str(r.source_type),
    cashIn: ugx(r.cash_in),
    cashOut: ugx(r.cash_out),
    netMovement: num(r.net_movement),
  }));
}

// ---------------------------------------------------------------------------
// 7. End-of-day exceptions
// ---------------------------------------------------------------------------

export async function getAgencyExceptions(): Promise<AgencyExceptionRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_end_of_day_exceptions')
    .select('*')
    .order('exception_kind');

  if (error !== null || data === null) return empty('agency exceptions', error);

  return data.map((r) => ({
    kind: str(r.exception_kind),
    branchId: str(r.branch_id),
    asOfDate: r.as_of_date === null ? null : toBusinessDate(str(r.as_of_date)),
    subjectId: str(r.subject_id),
    providerName: strOrNull(r.provider_name),
    amount: num(r.amount),
    detail: str(r.detail),
  }));
}

// ---------------------------------------------------------------------------
// Configuration: providers and the services they offer
// ---------------------------------------------------------------------------

export async function getAgencyProviders(): Promise<AgencyProviderRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_service_providers')
    .select(
      'id, code, name, category, float_model, commission_model, commission_rate_bps, commission_fixed, is_active, is_provisional',
    )
    .order('name');

  if (error !== null || data === null) return empty('agency providers', error);

  return data.map((r) => ({
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
  }));
}

export async function getAgencyServiceTypes(options?: {
  readonly providerId?: string;
}): Promise<AgencyServiceTypeRow[]> {
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
  if (error !== null || data === null) return empty('agency service types', error);

  return data.map((r) => {
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
  });
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
}): Promise<AgencyCashCountRow[]> {
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
  if (error !== null || data === null) return empty('agency cash counts', error);

  return data.map((r) => ({
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
    varianceWrittenOff: ugx(r.variance_written_off),
    varianceJournalEntryId: strOrNull(r.variance_journal_entry_id),
    notes: strOrNull(r.notes),
    createdBy: strOrNull(r.created_by),
    reconciledBy: strOrNull(r.reconciled_by),
    currentSystemBalance: ugx(r.current_system_balance),
    balanceMoved: r.balance_moved === true,
  }));
}

export async function getAgencyFloatStatements(options?: {
  readonly statuses?: readonly AgencyReconciliationStatus[];
  readonly limit?: number;
}): Promise<AgencyFloatStatementRow[]> {
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
  if (error !== null || data === null) return empty('agency float statements', error);

  return data.map((r) => ({
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
    varianceWrittenOff: ugx(r.variance_written_off),
    varianceJournalEntryId: strOrNull(r.variance_journal_entry_id),
    notes: strOrNull(r.notes),
    createdBy: strOrNull(r.created_by),
    reconciledBy: strOrNull(r.reconciled_by),
    currentSystemBalance: ugx(r.current_system_balance),
    balanceMoved: r.balance_moved === true,
  }));
}

export async function getAgencyCommissionSettlements(options?: {
  readonly limit?: number;
}): Promise<AgencyCommissionSettlementRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_commission_settlement_register')
    .select('*')
    .order('settlement_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (error !== null || data === null) {
    return empty('agency commission settlements', error);
  }

  return data.map((r) => ({
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
  }));
}

export async function getAgencyPayableSettlements(options?: {
  readonly limit?: number;
}): Promise<AgencyPayableSettlementRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('agency_payable_settlement_register')
    .select('*')
    .order('settlement_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 50);

  if (error !== null || data === null) {
    return empty('agency payable settlements', error);
  }

  return data.map((r) => ({
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
  }));
}

/** The tills a signed-in officer may actually post against, for a form. */
export async function getPostableFloatTills(): Promise<AgencyFloatRow[]> {
  const all = await getAgencyFloatBalances();
  return all.filter(
    (f) => f.tillIsActive && f.providerIsActive && !f.providerIsProvisional,
  );
}
