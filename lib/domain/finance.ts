/**
 * The vocabulary of money movement.
 *
 * Phase 10 gave the business a ledger. Phase 11 gives it the four ways money
 * moves that are not a loan: a transfer between its own accounts, an expense,
 * a fee or other income, and the daily count that checks the books against
 * what is actually in the drawer.
 *
 * Nothing in this module computes a balance or decides whether a movement is
 * allowed. The database does both, inside the same transaction that writes
 * the journal — see `supabase/migrations/20261011000200_money_movement.sql`.
 * What lives here is the closed set of words the two sides agree on, so a
 * status string cannot be misspelled into existence on the way through.
 */

import type { UgxAmount } from '@/lib/domain/money';
import type { BusinessDate } from '@/lib/domain/datetime';

/**
 * Where money physically sits.
 *
 * The same four kinds `ledger_accounts.cash_kind` constrains, in the order a
 * cash position is read: the drawer first, then the two wallets, then the
 * bank.
 */
export const CASH_KINDS = [
  'cash_at_hand',
  'mtn_mobile_money',
  'airtel_money',
  'bank',
] as const;

export type CashKind = (typeof CASH_KINDS)[number];

export function isCashKind(value: unknown): value is CashKind {
  return typeof value === 'string' && (CASH_KINDS as readonly string[]).includes(value);
}

export const CASH_KIND_LABELS: Readonly<Record<CashKind, string>> = {
  cash_at_hand: 'Cash at Hand',
  mtn_mobile_money: 'MTN Mobile Money',
  airtel_money: 'Airtel Money',
  bank: 'Bank',
};

/** Short forms, for a column header or a stat card where the full name wraps. */
export const CASH_KIND_SHORT_LABELS: Readonly<Record<CashKind, string>> = {
  cash_at_hand: 'Cash',
  mtn_mobile_money: 'MTN',
  airtel_money: 'Airtel',
  bank: 'Bank',
};

/**
 * The five kinds of account in the chart.
 *
 * Mirrors `ledger_accounts.account_type`. Assets and expenses increase on the
 * debit side and everything else on the credit side, which is the one piece
 * of accounting here that is not a policy choice — the database constrains it.
 */
export const ACCOUNT_TYPES = [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function isAccountType(value: unknown): value is AccountType {
  return (
    typeof value === 'string' && (ACCOUNT_TYPES as readonly string[]).includes(value)
  );
}

export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  income: 'Income',
  expense: 'Expense',
};

/**
 * What a document that moves money can be.
 *
 * `pending_approval` carries **no journal at all**. Nothing has moved, so
 * there is nothing to post; writing a journal and reversing it on rejection
 * would put two entries in the books for an event that never happened.
 */
export const MOVEMENT_STATUSES = [
  'pending_approval',
  'posted',
  'rejected',
  'reversed',
] as const;

export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

export function isMovementStatus(value: unknown): value is MovementStatus {
  return (
    typeof value === 'string' && (MOVEMENT_STATUSES as readonly string[]).includes(value)
  );
}

export const MOVEMENT_STATUS_LABELS: Readonly<Record<MovementStatus, string>> = {
  pending_approval: 'Awaiting approval',
  posted: 'Posted',
  rejected: 'Rejected',
  reversed: 'Reversed',
};

/** Only a posted movement has affected the books. */
export function isEffective(status: MovementStatus): boolean {
  return status === 'posted';
}

/**
 * Income is recorded, never approved.
 *
 * Money has already arrived by the time anybody types it in. Holding it in a
 * pending state would leave cash in a drawer the books do not know about,
 * which is the opposite of control — so `other_income.status` has two values
 * where the other documents have four.
 */
export const INCOME_STATUSES = ['posted', 'reversed'] as const;
export type IncomeStatus = (typeof INCOME_STATUSES)[number];

export function isIncomeStatus(value: unknown): value is IncomeStatus {
  return (
    typeof value === 'string' && (INCOME_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * What became of a count.
 *
 * `balanced` is the happy path and posts nothing. `submitted` is a difference
 * nobody has decided about yet, and it stays visible for exactly as long as
 * that is true. `rejected` is a difference somebody looked at and declined to
 * write off — the ledger still says what it said, and the count still
 * disagrees with it.
 */
export const RECONCILIATION_STATUSES = [
  'balanced',
  'submitted',
  'approved',
  'rejected',
] as const;

export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export function isReconciliationStatus(value: unknown): value is ReconciliationStatus {
  return (
    typeof value === 'string' &&
    (RECONCILIATION_STATUSES as readonly string[]).includes(value)
  );
}

export const RECONCILIATION_STATUS_LABELS: Readonly<
  Record<ReconciliationStatus, string>
> = {
  balanced: 'Balanced',
  submitted: 'Difference unresolved',
  approved: 'Difference written off',
  rejected: 'Difference rejected',
};

/** A reconciliation that still needs somebody to decide about it. */
export function needsDecision(status: ReconciliationStatus): boolean {
  return status === 'submitted';
}

/**
 * How a variance reads in words.
 *
 * Positive means more money was found than the books expected. Saying
 * "over" and "short" rather than showing a signed number is how a cashier
 * describes it, and the sign is easy to misread on a dense row.
 */
export function describeVariance(variance: number): string {
  if (variance === 0) return 'Agrees with the ledger';
  return variance > 0 ? 'Over' : 'Short';
}

/** A ledger account as the finance screens read it. */
export interface LedgerAccountSummary {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountType;
  readonly cashKind: CashKind | null;
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly balance: UgxAmount;
  readonly isPostable: boolean;
  readonly status: 'active' | 'inactive';
}

/** One branch's liquidity, as the dashboard and the finance pages show it. */
export interface BranchCashPosition {
  readonly branchId: string;
  readonly branchCode: string;
  readonly branchName: string;
  readonly cashAtHand: UgxAmount;
  readonly mtnMobileMoney: UgxAmount;
  readonly airtelMoney: UgxAmount;
  readonly cashAtBank: UgxAmount;
  readonly totalLiquidity: UgxAmount;
}

export interface TransferRow {
  readonly id: string;
  readonly transferNumber: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly transferDate: BusinessDate;
  readonly amount: UgxAmount;
  readonly status: MovementStatus;
  readonly fromAccountName: string;
  readonly fromCashKind: CashKind | null;
  readonly toAccountName: string;
  readonly toCashKind: CashKind | null;
  readonly externalReference: string | null;
  readonly description: string;
  readonly initiatedByLabel: string;
  readonly approvedByLabel: string | null;
  readonly decisionReason: string | null;
}

export interface ExpenseRow {
  readonly id: string;
  readonly expenseNumber: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly expenseDate: BusinessDate;
  readonly amount: UgxAmount;
  readonly effectiveAmount: UgxAmount;
  readonly status: MovementStatus;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly paymentAccountName: string;
  readonly paymentCashKind: CashKind | null;
  readonly payee: string | null;
  readonly description: string;
  readonly externalReference: string | null;
  readonly receiptPath: string | null;
  readonly recordedByLabel: string;
  readonly approvedByLabel: string | null;
  readonly decisionReason: string | null;
}

export interface IncomeRow {
  readonly id: string;
  readonly incomeNumber: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly incomeDate: BusinessDate;
  readonly amount: UgxAmount;
  readonly effectiveAmount: UgxAmount;
  readonly status: IncomeStatus;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly receivingAccountName: string;
  readonly receivingCashKind: CashKind | null;
  readonly payer: string | null;
  readonly clientId: string | null;
  readonly clientNumber: string | null;
  readonly clientName: string | null;
  readonly loanId: string | null;
  readonly loanNumber: string | null;
  readonly description: string;
  readonly externalReference: string | null;
  readonly recordedByLabel: string;
}

export interface ReconciliationRow {
  readonly id: string;
  readonly reconciliationNumber: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly cashKind: CashKind | null;
  readonly businessDate: BusinessDate;
  readonly systemBalance: UgxAmount;
  readonly countedBalance: UgxAmount;
  /** Counted less system. Positive is over, negative is short. */
  readonly variance: number;
  readonly status: ReconciliationStatus;
  readonly explanation: string | null;
  readonly performedByLabel: string;
  readonly reviewedByLabel: string | null;
  readonly reviewNotes: string | null;
}

/** One line of the general ledger. */
export interface LedgerLine {
  readonly lineId: string;
  readonly entryId: string;
  readonly entryNumber: string;
  readonly entryDate: BusinessDate;
  readonly branchName: string;
  readonly sourceType: string;
  readonly entryDescription: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  readonly debit: UgxAmount;
  readonly credit: UgxAmount;
  /** Signed the way the account is read, so a filtered sum is that slice's movement. */
  readonly signedAmount: number;
  readonly memo: string | null;
  readonly loanId: string | null;
  readonly clientId: string | null;
  readonly reversedByEntryId: string | null;
}

/**
 * How a source type reads on a screen.
 *
 * The journal's `source_type` is the event that produced the entry, and a
 * person reading the general ledger wants the event, not the enum.
 */
export const JOURNAL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  opening_balance: 'Opening balance',
  loan_disbursement: 'Loan disbursed',
  loan_repayment: 'Repayment',
  payment_reversal: 'Payment reversed',
  penalty_charge: 'Penalty charged',
  transfer: 'Transfer',
  transfer_reversal: 'Transfer reversed',
  expense: 'Expense',
  expense_reversal: 'Expense reversed',
  other_income: 'Other income',
  other_income_reversal: 'Income reversed',
  reconciliation_adjustment: 'Reconciliation adjustment',
  adjustment: 'Adjustment',
};

export function describeJournalSource(sourceType: string): string {
  return JOURNAL_SOURCE_LABELS[sourceType] ?? sourceType;
}
