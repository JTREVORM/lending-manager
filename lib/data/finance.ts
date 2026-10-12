import 'server-only';

/**
 * Reading money movement.
 *
 * Every function here reads a **view**, never a table and never a sum this
 * module computes itself. That is deliberate and it is the Phase 10 rule
 * carried forward: the ledger is the accounting source of truth, so a balance
 * shown on a screen must be the ledger's balance rather than an addition
 * performed in TypeScript over whatever rows happened to come back.
 *
 * The practical consequence is that a filter here narrows *which rows are
 * returned* and never *which rows count towards a total*. Where a page needs
 * both — a filtered list and a total for the filter — the total comes from
 * the same query the list came from, summed by the database.
 *
 * Reads run as the signed-in person, so Row Level Security decides what comes
 * back: the capability, and the branch they are allowed to see.
 */

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { toBusinessDate, type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import {
  isAccountType,
  isCashKind,
  isIncomeStatus,
  isMovementStatus,
  isReconciliationStatus,
  type AccountType,
  type BranchCashPosition,
  type CashKind,
  type ExpenseRow,
  type IncomeRow,
  type IncomeStatus,
  type LedgerAccountSummary,
  type LedgerLine,
  type MovementStatus,
  type ReconciliationRow,
  type ReconciliationStatus,
  type TransferRow,
} from '@/lib/domain/finance';

type Raw = Readonly<Record<string, unknown>>;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function nullableText(value: unknown): string | null {
  const read = text(value).trim();
  return read === '' ? null : read;
}

function money(value: unknown): UgxAmount {
  return toUgx(Number(value ?? 0));
}

function signed(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cashKind(value: unknown): CashKind | null {
  return isCashKind(value) ? value : null;
}

function accountType(value: unknown): AccountType {
  // An account whose type the database does not recognise cannot exist — a
  // CHECK constrains the column — so this falls back rather than throwing,
  // because a report refusing to render over one odd row helps nobody.
  return isAccountType(value) ? value : 'asset';
}

function movementStatus(value: unknown): MovementStatus {
  return isMovementStatus(value) ? value : 'posted';
}

/** How many rows a finance list shows before paging. */
export const FINANCE_PAGE_SIZE = 25;

export interface FinanceFilters {
  readonly from?: BusinessDate;
  readonly to?: BusinessDate;
  readonly branchId?: string;
  readonly status?: string;
  readonly accountId?: string;
  readonly limit?: number;
}

/**
 * The chart of accounts, with each account's balance.
 *
 * Read for the account pickers on every form and for the Accounts screen.
 * Inactive accounts are returned too, flagged, because a historical expense
 * still names the category it was posted to and a picker that hid it would
 * make that row unreadable.
 */
export async function getLedgerAccounts(options?: {
  readonly type?: AccountType;
  readonly cashOnly?: boolean;
  readonly postableOnly?: boolean;
  readonly activeOnly?: boolean;
}): Promise<readonly LedgerAccountSummary[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('ledger_account_balances')
    .select(
      `account_id, code, name, account_type, cash_kind, branch_id, branch_name, balance, status`,
    )
    .order('code');

  if (options?.type !== undefined) query = query.eq('account_type', options.type);
  if (options?.cashOnly === true) query = query.not('cash_kind', 'is', null);
  if (options?.activeOnly === true) query = query.eq('status', 'active');

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the chart of accounts.', { code: error.code });
    return [];
  }

  const rows = (data ?? []).map((row): LedgerAccountSummary => {
    const raw = row as Raw;
    return {
      accountId: text(raw.account_id),
      code: text(raw.code),
      name: text(raw.name),
      accountType: accountType(raw.account_type),
      cashKind: cashKind(raw.cash_kind),
      branchId: nullableText(raw.branch_id),
      branchName: nullableText(raw.branch_name),
      balance: money(raw.balance),
      // `ledger_account_balances` does not carry `is_postable`; a heading has
      // no lines and therefore no balance, and the pickers filter by type
      // anyway. Reported as postable so a caller never hides a real account.
      isPostable: true,
      status: text(raw.status) === 'inactive' ? 'inactive' : 'active',
    };
  });

  return rows;
}

/**
 * The postable accounts of one type, for a category picker.
 *
 * Headings are excluded by reading `ledger_accounts` directly rather than the
 * balance view, because `is_postable` is the thing being filtered on and only
 * the table carries it.
 */
export async function getPostableAccounts(
  type: AccountType,
): Promise<readonly LedgerAccountSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('ledger_accounts')
    .select('id, code, name, account_type, cash_kind, branch_id, is_postable, status')
    .eq('account_type', type)
    .eq('is_postable', true)
    .eq('status', 'active')
    .order('code');

  if (error !== null) {
    logger.warn('Could not read postable accounts.', { code: error.code, type });
    return [];
  }

  return (data ?? []).map((row): LedgerAccountSummary => {
    const raw = row as Raw;
    return {
      accountId: text(raw.id),
      code: text(raw.code),
      name: text(raw.name),
      accountType: accountType(raw.account_type),
      cashKind: cashKind(raw.cash_kind),
      branchId: nullableText(raw.branch_id),
      branchName: null,
      balance: toUgx(0),
      isPostable: true,
      status: 'active',
    };
  });
}

/** Where the company's money is, per branch. */
export async function getCashPositions(): Promise<readonly BranchCashPosition[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('branch_cash_position')
    .select(
      `branch_id, branch_code, branch_name, cash_at_hand, mtn_mobile_money, airtel_money, cash_at_bank, total_liquidity`,
    )
    .order('branch_code');

  if (error !== null) {
    logger.warn('Could not read the cash position.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row): BranchCashPosition => {
    const raw = row as Raw;
    return {
      branchId: text(raw.branch_id),
      branchCode: text(raw.branch_code),
      branchName: text(raw.branch_name),
      cashAtHand: money(raw.cash_at_hand),
      mtnMobileMoney: money(raw.mtn_mobile_money),
      airtelMoney: money(raw.airtel_money),
      cashAtBank: money(raw.cash_at_bank),
      totalLiquidity: money(raw.total_liquidity),
    };
  });
}

export async function getTransfers(
  filters: FinanceFilters = {},
): Promise<readonly TransferRow[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('transfer_register')
    .select(
      `id, transfer_number, branch_id, branch_name, transfer_date, amount, status, from_account_name, from_cash_kind, to_account_name, to_cash_kind, external_reference, description, initiated_by_label, approved_by_label, decision_reason`,
    )
    .order('transfer_date', { ascending: false })
    .order('transfer_number', { ascending: false })
    .limit(filters.limit ?? FINANCE_PAGE_SIZE);

  if (filters.from !== undefined) query = query.gte('transfer_date', filters.from);
  if (filters.to !== undefined) query = query.lte('transfer_date', filters.to);
  if (filters.branchId !== undefined) query = query.eq('branch_id', filters.branchId);
  if (filters.status !== undefined) query = query.eq('status', filters.status);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read transfers.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row): TransferRow => {
    const raw = row as Raw;
    return {
      id: text(raw.id),
      transferNumber: text(raw.transfer_number),
      branchId: text(raw.branch_id),
      branchName: text(raw.branch_name),
      transferDate: toBusinessDate(text(raw.transfer_date)),
      amount: money(raw.amount),
      status: movementStatus(raw.status),
      fromAccountName: text(raw.from_account_name),
      fromCashKind: cashKind(raw.from_cash_kind),
      toAccountName: text(raw.to_account_name),
      toCashKind: cashKind(raw.to_cash_kind),
      externalReference: nullableText(raw.external_reference),
      description: text(raw.description),
      initiatedByLabel: text(raw.initiated_by_label),
      approvedByLabel: nullableText(raw.approved_by_label),
      decisionReason: nullableText(raw.decision_reason),
    };
  });
}

export async function getExpenses(
  filters: FinanceFilters = {},
): Promise<readonly ExpenseRow[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('expense_register')
    .select(
      `id, expense_number, branch_id, branch_name, expense_date, amount, effective_amount, status, category_code, category_name, payment_account_name, payment_cash_kind, payee, description, external_reference, receipt_path, recorded_by_label, approved_by_label, decision_reason`,
    )
    .order('expense_date', { ascending: false })
    .order('expense_number', { ascending: false })
    .limit(filters.limit ?? FINANCE_PAGE_SIZE);

  if (filters.from !== undefined) query = query.gte('expense_date', filters.from);
  if (filters.to !== undefined) query = query.lte('expense_date', filters.to);
  if (filters.branchId !== undefined) query = query.eq('branch_id', filters.branchId);
  if (filters.status !== undefined) query = query.eq('status', filters.status);
  if (filters.accountId !== undefined) {
    query = query.eq('expense_account_id', filters.accountId);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read expenses.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row): ExpenseRow => {
    const raw = row as Raw;
    return {
      id: text(raw.id),
      expenseNumber: text(raw.expense_number),
      branchId: text(raw.branch_id),
      branchName: text(raw.branch_name),
      expenseDate: toBusinessDate(text(raw.expense_date)),
      amount: money(raw.amount),
      effectiveAmount: money(raw.effective_amount),
      status: movementStatus(raw.status),
      categoryCode: text(raw.category_code),
      categoryName: text(raw.category_name),
      paymentAccountName: text(raw.payment_account_name),
      paymentCashKind: cashKind(raw.payment_cash_kind),
      payee: nullableText(raw.payee),
      description: text(raw.description),
      externalReference: nullableText(raw.external_reference),
      receiptPath: nullableText(raw.receipt_path),
      recordedByLabel: text(raw.recorded_by_label),
      approvedByLabel: nullableText(raw.approved_by_label),
      decisionReason: nullableText(raw.decision_reason),
    };
  });
}

export async function getOtherIncome(
  filters: FinanceFilters = {},
): Promise<readonly IncomeRow[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('income_register')
    .select(
      `id, income_number, branch_id, branch_name, income_date, amount, effective_amount, status, category_code, category_name, receiving_account_name, receiving_cash_kind, payer, client_id, client_number, client_name, loan_id, loan_number, description, external_reference, recorded_by_label`,
    )
    .order('income_date', { ascending: false })
    .order('income_number', { ascending: false })
    .limit(filters.limit ?? FINANCE_PAGE_SIZE);

  if (filters.from !== undefined) query = query.gte('income_date', filters.from);
  if (filters.to !== undefined) query = query.lte('income_date', filters.to);
  if (filters.branchId !== undefined) query = query.eq('branch_id', filters.branchId);
  if (filters.status !== undefined) query = query.eq('status', filters.status);
  if (filters.accountId !== undefined) {
    query = query.eq('income_account_id', filters.accountId);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read other income.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row): IncomeRow => {
    const raw = row as Raw;
    const status = text(raw.status);
    return {
      id: text(raw.id),
      incomeNumber: text(raw.income_number),
      branchId: text(raw.branch_id),
      branchName: text(raw.branch_name),
      incomeDate: toBusinessDate(text(raw.income_date)),
      amount: money(raw.amount),
      effectiveAmount: money(raw.effective_amount),
      status: (isIncomeStatus(status) ? status : 'posted') satisfies IncomeStatus,
      categoryCode: text(raw.category_code),
      categoryName: text(raw.category_name),
      receivingAccountName: text(raw.receiving_account_name),
      receivingCashKind: cashKind(raw.receiving_cash_kind),
      payer: nullableText(raw.payer),
      clientId: nullableText(raw.client_id),
      clientNumber: nullableText(raw.client_number),
      clientName: nullableText(raw.client_name),
      loanId: nullableText(raw.loan_id),
      loanNumber: nullableText(raw.loan_number),
      description: text(raw.description),
      externalReference: nullableText(raw.external_reference),
      recordedByLabel: text(raw.recorded_by_label),
    };
  });
}

export async function getReconciliations(
  filters: FinanceFilters = {},
): Promise<readonly ReconciliationRow[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('reconciliation_register')
    .select(
      `id, reconciliation_number, branch_id, branch_name, account_code, account_name, cash_kind, business_date, system_balance, counted_balance, variance, status, explanation, performed_by_label, reviewed_by_label, review_notes`,
    )
    .order('business_date', { ascending: false })
    .order('reconciliation_number', { ascending: false })
    .limit(filters.limit ?? FINANCE_PAGE_SIZE);

  if (filters.from !== undefined) query = query.gte('business_date', filters.from);
  if (filters.to !== undefined) query = query.lte('business_date', filters.to);
  if (filters.branchId !== undefined) query = query.eq('branch_id', filters.branchId);
  if (filters.status !== undefined) query = query.eq('status', filters.status);
  if (filters.accountId !== undefined) query = query.eq('account_id', filters.accountId);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read reconciliations.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row): ReconciliationRow => {
    const raw = row as Raw;
    const status = text(raw.status);
    return {
      id: text(raw.id),
      reconciliationNumber: text(raw.reconciliation_number),
      branchId: text(raw.branch_id),
      branchName: text(raw.branch_name),
      accountCode: text(raw.account_code),
      accountName: text(raw.account_name),
      cashKind: cashKind(raw.cash_kind),
      businessDate: toBusinessDate(text(raw.business_date)),
      systemBalance: money(raw.system_balance),
      countedBalance: money(raw.counted_balance),
      variance: signed(raw.variance),
      status: (isReconciliationStatus(status)
        ? status
        : 'submitted') satisfies ReconciliationStatus,
      explanation: nullableText(raw.explanation),
      performedByLabel: text(raw.performed_by_label),
      reviewedByLabel: nullableText(raw.reviewed_by_label),
      reviewNotes: nullableText(raw.review_notes),
    };
  });
}

/**
 * The general ledger, optionally narrowed to one account.
 *
 * This is the drill-down behind every financial figure in the system: a
 * balance on a card, a total in a report, a line in the trial balance. It
 * reads `general_ledger`, which is the join of lines, entries, accounts and
 * branches, so nothing here re-derives what a posting meant.
 */
export async function getLedgerLines(
  filters: FinanceFilters & { readonly sourceType?: string } = {},
): Promise<readonly LedgerLine[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('general_ledger')
    .select(
      `line_id, entry_id, entry_number, entry_date, branch_name, source_type, entry_description, account_code, account_name, account_type, debit, credit, signed_amount, memo, loan_id, client_id, reversed_by_entry_id`,
    )
    .order('entry_date', { ascending: false })
    .order('entry_number', { ascending: false })
    .order('line_number', { ascending: true })
    .limit(filters.limit ?? 100);

  if (filters.from !== undefined) query = query.gte('entry_date', filters.from);
  if (filters.to !== undefined) query = query.lte('entry_date', filters.to);
  if (filters.branchId !== undefined) query = query.eq('branch_id', filters.branchId);
  if (filters.accountId !== undefined) query = query.eq('account_id', filters.accountId);
  if (filters.sourceType !== undefined)
    query = query.eq('source_type', filters.sourceType);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the general ledger.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row): LedgerLine => {
    const raw = row as Raw;
    return {
      lineId: text(raw.line_id),
      entryId: text(raw.entry_id),
      entryNumber: text(raw.entry_number),
      entryDate: toBusinessDate(text(raw.entry_date)),
      branchName: text(raw.branch_name),
      sourceType: text(raw.source_type),
      entryDescription: text(raw.entry_description),
      accountCode: text(raw.account_code),
      accountName: text(raw.account_name),
      accountType: accountType(raw.account_type),
      debit: money(raw.debit),
      credit: money(raw.credit),
      signedAmount: signed(raw.signed_amount),
      memo: nullableText(raw.memo),
      loanId: nullableText(raw.loan_id),
      clientId: nullableText(raw.client_id),
      reversedByEntryId: nullableText(raw.reversed_by_entry_id),
    };
  });
}

export interface FinanceSettings {
  readonly transferApprovalThreshold: UgxAmount | null;
  readonly expenseApprovalThreshold: UgxAmount | null;
  readonly allowNegativeCash: boolean;
  readonly reconciliationRequiresReview: boolean;
  readonly lowBalanceCashAtHand: UgxAmount;
  readonly lowBalanceMtn: UgxAmount;
  readonly lowBalanceAirtel: UgxAmount;
  readonly lowBalanceBank: UgxAmount;
}

export async function getFinanceSettings(): Promise<FinanceSettings | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('finance_settings')
    .select(
      `transfer_approval_threshold, expense_approval_threshold, allow_negative_cash, reconciliation_requires_review, low_balance_cash_at_hand, low_balance_mtn_mobile_money, low_balance_airtel_money, low_balance_bank`,
    )
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read finance settings.', { code: error.code });
    return null;
  }

  if (data === null) return null;

  const raw = data as Raw;

  return {
    transferApprovalThreshold:
      raw.transfer_approval_threshold === null
        ? null
        : money(raw.transfer_approval_threshold),
    expenseApprovalThreshold:
      raw.expense_approval_threshold === null
        ? null
        : money(raw.expense_approval_threshold),
    allowNegativeCash: raw.allow_negative_cash === true,
    reconciliationRequiresReview: raw.reconciliation_requires_review === true,
    lowBalanceCashAtHand: money(raw.low_balance_cash_at_hand),
    lowBalanceMtn: money(raw.low_balance_mtn_mobile_money),
    lowBalanceAirtel: money(raw.low_balance_airtel_money),
    lowBalanceBank: money(raw.low_balance_bank),
  };
}
