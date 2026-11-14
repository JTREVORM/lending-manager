/**
 * Agency banking, as the application sees it.
 *
 * Every figure here is `UgxAmount` — an integer number of shillings, branded
 * so it cannot be mixed with a plain number. Nothing in this module or in the
 * data layer above it computes a balance: the Phase 4C views do that, in the
 * database, attributed per provider and per branch because GL 1310 and the
 * 2200-series accounts are shared between providers.
 */
import type { BusinessDate } from '@/lib/domain/datetime';
import type { UgxAmount } from '@/lib/domain/money';

export const AGENCY_STATUSES = [
  'draft',
  'awaiting_verification',
  'returned',
  'posted',
  'reversed',
  'cancelled',
] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];

export function isAgencyStatus(value: unknown): value is AgencyStatus {
  return (
    typeof value === 'string' && (AGENCY_STATUSES as readonly string[]).includes(value)
  );
}

export const AGENCY_DIRECTIONS = ['deposit', 'withdrawal', 'payment'] as const;
export type AgencyDirection = (typeof AGENCY_DIRECTIONS)[number];

export function isAgencyDirection(value: unknown): value is AgencyDirection {
  return (
    typeof value === 'string' && (AGENCY_DIRECTIONS as readonly string[]).includes(value)
  );
}

/** How a provider's commission is recognised. */
export type CommissionModel = 'deferred' | 'immediate';

/** Where the money a provider is owed sits until it is settled. */
export type FloatModel = 'provider_float' | 'cash_payable';

/** One row of `agency_transaction_history`. */
export interface AgencyTransactionRow {
  readonly id: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly direction: AgencyDirection | null;
  readonly transactionDate: BusinessDate;
  readonly status: AgencyStatus;
  readonly principalAmount: UgxAmount;
  readonly customerFee: UgxAmount;
  readonly commissionAmount: UgxAmount | null;
  readonly commissionComputed: UgxAmount | null;
  readonly commissionSupplied: UgxAmount | null;
  readonly commissionExceptionReason: string | null;
  readonly customerIdentifier: string | null;
  readonly providerReference: string | null;
  readonly journalEntryId: string | null;
  readonly reversalEntryId: string | null;
  readonly submittedBy: string | null;
  readonly verifiedBy: string | null;
  /**
   * What the figures were when this row was read.
   *
   * A verifier quotes it back, and the database refuses the posting if the
   * money has moved since - so a manager cannot approve a commission
   * exception an Owner authorised behind an open screen. Null only if the
   * view could not be read, in which case the screen offers no Verify button.
   */
  readonly revision: number | null;
  /**
   * Added by the Agency redesign, for the reports.
   *
   * `providerCategory` is what separates an Agent Banking transaction report
   * from a Mobile Money one without naming a provider code. The two names are
   * the maker and the checker: §6.1 asks for "entering and verifying
   * personnel" on a transaction report and §6.5 for a report per staff member,
   * and a report printing two UUIDs would have to be joined back to `profiles`
   * by every screen that showed one.
   *
   * All five are nullable because a draft has no verifier and a transaction
   * against a `cash_payable` provider has no agent line, so no agent code.
   */
  readonly providerCategory: AgencyProviderCategory | null;
  readonly branchName: string | null;
  readonly submittedByName: string | null;
  readonly verifiedByName: string | null;
  readonly floatAccountId: string | null;
  readonly agentCode: string | null;
}

/** One row of `agency_float_balances`. */
export interface AgencyFloatRow {
  readonly floatAccountId: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly tillName: string;
  readonly tillIsActive: boolean;
  readonly ledgerAccountCode: string;
  readonly balance: UgxAmount;
  readonly providerIsActive: boolean;
  readonly providerIsProvisional: boolean;
}

/** One row of `agency_commission_summary`. */
export interface AgencyCommissionRow {
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly earned: UgxAmount;
  readonly received: UgxAmount;
  readonly returned: UgxAmount;
  readonly outstanding: UgxAmount;
}

/** One row of `agency_payable_summary`. */
export interface AgencyPayableRow {
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly collected: UgxAmount;
  readonly remitted: UgxAmount;
  readonly remittanceReversed: UgxAmount;
  readonly outstanding: UgxAmount;
}

/** One row of `agency_variance_report`. Two conventions, each stated. */
export interface AgencyVarianceRow {
  readonly kind: 'cash' | 'float';
  readonly id: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly providerName: string | null;
  readonly reconciliationDate: BusinessDate;
  readonly systemClosingBalance: UgxAmount;
  readonly countedOrStatement: UgxAmount;
  readonly variance: number;
  /**
   * What a positive `variance` means on this row.
   *
   * The two reconciliation tables use **opposite** generated conventions —
   * cash is the count less the books, float is the books less the statement —
   * so a reader must never infer the sign from the number alone. The database
   * states it per row and this carries it through unchanged.
   */
  readonly varianceMeans: string;
  readonly varianceWrittenOff: number;
  readonly status: 'open' | 'reconciled';
  readonly createdBy: string | null;
  readonly reconciledBy: string | null;
  readonly statementRef: string | null;
}

/** One row of `agency_daily_cash_movement`. */
export interface AgencyCashMovementRow {
  readonly branchId: string;
  readonly branchCode: string;
  readonly entryDate: BusinessDate;
  readonly cashAccountCode: string;
  readonly sourceType: string;
  readonly cashIn: UgxAmount;
  readonly cashOut: UgxAmount;
  readonly netMovement: number;
}

/** One row of `agency_end_of_day_exceptions`. */
export interface AgencyExceptionRow {
  readonly kind: string;
  readonly branchId: string;
  readonly asOfDate: BusinessDate | null;
  readonly subjectId: string;
  readonly providerName: string | null;
  readonly amount: number;
  readonly detail: string;
}

/** A provider as the configuration screen shows it. */
export interface AgencyProviderRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly floatModel: FloatModel;
  readonly commissionModel: CommissionModel;
  readonly commissionRateBps: number | null;
  readonly commissionFixed: UgxAmount | null;
  readonly isActive: boolean;
  readonly isProvisional: boolean;
}

/** One service a provider offers. */
export interface AgencyServiceTypeRow {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly code: string;
  readonly name: string;
  readonly direction: AgencyDirection;
  readonly maxSingleTransaction: UgxAmount | null;
  readonly requiresApprovalAbove: UgxAmount | null;
  readonly isActive: boolean;
}

/** The states a reconciliation can be in. */
export const AGENCY_RECONCILIATION_STATUSES = ['open', 'reconciled', 'adjusted'] as const;
export type AgencyReconciliationStatus = (typeof AGENCY_RECONCILIATION_STATUSES)[number];

export function isAgencyReconciliationStatus(
  value: unknown,
): value is AgencyReconciliationStatus {
  return (
    typeof value === 'string' &&
    (AGENCY_RECONCILIATION_STATUSES as readonly string[]).includes(value)
  );
}

/** The states a settlement can be in. */
export const AGENCY_SETTLEMENT_STATUSES = ['posted', 'reversed'] as const;
export type AgencySettlementStatus = (typeof AGENCY_SETTLEMENT_STATUSES)[number];

export function isAgencySettlementStatus(
  value: unknown,
): value is AgencySettlementStatus {
  return (
    typeof value === 'string' &&
    (AGENCY_SETTLEMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * One row of `agency_cash_reconciliation_register`: a counted drawer.
 *
 * `varianceMeans` is carried from the view, as the variance report does it.
 * The cash and float tables use opposite conventions - a cash variance is
 * the count less the books, a float variance is the books less the
 * provider - and a screen that stated either from memory would eventually
 * state it backwards. This one did, before the seeded figures showed it.
 */
export interface AgencyCashCountRow {
  readonly id: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly cashAccountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly reconciliationDate: BusinessDate;
  readonly status: AgencyReconciliationStatus;
  readonly systemClosingBalance: UgxAmount;
  readonly physicalCount: UgxAmount;
  readonly variance: UgxAmount;
  /** The database's own statement of what this row's sign means. */
  readonly varianceMeans: string;
  readonly varianceWrittenOff: UgxAmount;
  readonly varianceJournalEntryId: string | null;
  readonly notes: string | null;
  readonly createdBy: string | null;
  readonly reconciledBy: string | null;
  /** What the books say now, which approval compares against. */
  readonly currentSystemBalance: UgxAmount;
  /**
   * Whether the account has moved since it was counted.
   *
   * True means approval will refuse this count: its variance no longer
   * describes anything. The screen says so instead of offering a button that
   * cannot work - but the refusal is the database's, not this flag's.
   */
  readonly balanceMoved: boolean;
}

/** One row of `agency_float_reconciliation_register`: a provider statement. */
export interface AgencyFloatStatementRow {
  readonly id: string;
  readonly floatAccountId: string;
  readonly tillName: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly providerId: string | null;
  readonly providerCode: string | null;
  readonly providerName: string | null;
  readonly branchId: string | null;
  readonly branchCode: string | null;
  readonly reconciliationDate: BusinessDate;
  readonly status: AgencyReconciliationStatus;
  readonly systemClosingBalance: UgxAmount;
  readonly providerStatementBalance: UgxAmount;
  readonly providerStatementRef: string | null;
  readonly variance: UgxAmount;
  /** The database's own statement, and the opposite sign to a cash count. */
  readonly varianceMeans: string;
  readonly varianceWrittenOff: UgxAmount;
  readonly varianceJournalEntryId: string | null;
  readonly notes: string | null;
  readonly createdBy: string | null;
  readonly reconciledBy: string | null;
  readonly currentSystemBalance: UgxAmount;
  readonly balanceMoved: boolean;
}

/** One row of `agency_commission_settlement_register`. */
export interface AgencyCommissionSettlementRow {
  readonly id: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly settlementDate: BusinessDate;
  readonly settlementAmount: UgxAmount;
  readonly settlementAccountCode: string;
  readonly settlementAccountName: string;
  readonly providerStatementRef: string | null;
  readonly status: AgencySettlementStatus;
  readonly journalEntryId: string | null;
  readonly reversalEntryId: string | null;
  readonly reversalReason: string | null;
}

/** One row of `agency_payable_settlement_register`. */
export interface AgencyPayableSettlementRow {
  readonly id: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly settlementDate: BusinessDate;
  readonly settlementAmount: UgxAmount;
  readonly cashAccountCode: string;
  readonly cashAccountName: string;
  readonly providerReceiptRef: string | null;
  readonly status: AgencySettlementStatus;
  readonly journalEntryId: string | null;
  readonly reversalEntryId: string | null;
  readonly reversalReason: string | null;
}

/**
 * Why a provider cannot be used to post, in words a counter officer can act
 * on. `null` means it can.
 *
 * The readiness rule lives in the database and fails closed there; this is
 * only an explanation, so a screen never has to guess why a refusal happened.
 */
export function providerBlockedReason(provider: {
  readonly isActive: boolean;
  readonly isProvisional: boolean;
}): string | null {
  if (provider.isProvisional) {
    return 'Provisional: its commercial terms have not been approved yet.';
  }
  if (!provider.isActive) return 'Not active.';
  return null;
}

// ---------------------------------------------------------------------------
// Phase 4E — Mobile Money
// ---------------------------------------------------------------------------

/** What an agent line is doing, as decision OD-4 distinguishes it. */
export const AGENCY_LINE_STATUSES = ['active', 'suspended', 'closed'] as const;
export type AgencyLineStatus = (typeof AGENCY_LINE_STATUSES)[number];

export function isAgencyLineStatus(value: unknown): value is AgencyLineStatus {
  return (
    typeof value === 'string' &&
    (AGENCY_LINE_STATUSES as readonly string[]).includes(value)
  );
}

/** The three things a float trade can be. */
export const AGENCY_TRADE_KINDS = ['purchase', 'sale', 'transfer'] as const;
export type AgencyTradeKind = (typeof AGENCY_TRADE_KINDS)[number];

export function isAgencyTradeKind(value: unknown): value is AgencyTradeKind {
  return (
    typeof value === 'string' && (AGENCY_TRADE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Where a float trade is in its maker-checker lifecycle.
 *
 * `pending` is the one that matters: it has moved no money, because nothing
 * writes a journal until a second officer verifies it.
 */
export const AGENCY_TRADE_STATUSES = [
  'pending',
  'posted',
  'rejected',
  'reversed',
] as const;
export type AgencyTradeStatus = (typeof AGENCY_TRADE_STATUSES)[number];

export function isAgencyTradeStatus(value: unknown): value is AgencyTradeStatus {
  return (
    typeof value === 'string' &&
    (AGENCY_TRADE_STATUSES as readonly string[]).includes(value)
  );
}

/** Where a purchase's float came from. */
export const AGENCY_FLOAT_SOURCES = [
  'provider_service_centre',
  'external_agent',
  'bank',
  'cash',
] as const;
export type AgencyFloatSource = (typeof AGENCY_FLOAT_SOURCES)[number];

export function isAgencyFloatSource(value: unknown): value is AgencyFloatSource {
  return (
    typeof value === 'string' &&
    (AGENCY_FLOAT_SOURCES as readonly string[]).includes(value)
  );
}

/** How a commission recovery payable was cleared (decision OD-10). */
export const AGENCY_RECOVERY_METHODS = ['float_deduction', 'commission_offset'] as const;
export type AgencyRecoveryMethod = (typeof AGENCY_RECOVERY_METHODS)[number];

export function isAgencyRecoveryMethod(value: unknown): value is AgencyRecoveryMethod {
  return (
    typeof value === 'string' &&
    (AGENCY_RECOVERY_METHODS as readonly string[]).includes(value)
  );
}

/** How a withdrawal's customer fee crossed the counter (decision OD-5). */
export const AGENCY_FEE_MODES = ['deduct_from_payout', 'collect_separately'] as const;
export type AgencyFeeMode = (typeof AGENCY_FEE_MODES)[number];

export function isAgencyFeeMode(value: unknown): value is AgencyFeeMode {
  return (
    typeof value === 'string' && (AGENCY_FEE_MODES as readonly string[]).includes(value)
  );
}

/** One row of `agency_commission_by_line`. */
export interface AgencyLineCommissionRow {
  readonly floatAccountId: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly tillName: string;
  readonly label: string | null;
  readonly lineStatus: AgencyLineStatus;
  readonly ledgerAccountCode: string;
  readonly floatBalance: UgxAmount;
  readonly commissionOutstanding: UgxAmount;
  readonly recoveryOwed: UgxAmount;
}

/**
 * One row of `agency_mobile_money_dashboard`: one agent line, and everything
 * a supervisor asks about it at once.
 */
export interface AgencyMoneyLineRow extends AgencyLineCommissionRow {
  readonly depositsToday: number;
  readonly depositValueToday: UgxAmount;
  readonly withdrawalsToday: number;
  readonly withdrawalValueToday: UgxAmount;
  readonly commissionToday: UgxAmount;
  readonly customerFeesToday: UgxAmount;
  readonly pendingTrades: number;
  readonly transactionsInFlight: number;
  readonly openCommissionReconciliations: number;
}

/**
 * One row of `agency_mobile_money_consolidated`.
 *
 * `floatTransferredIn` and `floatTransferredOut` are their own columns and are
 * **not** part of `floatPurchased` or `floatSold`: a transfer moves float
 * between two of one provider's own lines, so counting it on both sides would
 * report twice an amount that never moved at all.
 */
export interface AgencyMoneyProviderRow {
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly agentLines: number;
  readonly activeLines: number;
  readonly suspendedLines: number;
  readonly floatHeld: UgxAmount;
  readonly commissionOutstanding: UgxAmount;
  readonly recoveryOwed: UgxAmount;
  readonly floatPurchased: UgxAmount;
  readonly purchasePremium: UgxAmount;
  readonly purchaseDiscount: UgxAmount;
  readonly floatSold: UgxAmount;
  readonly saleFeeIncome: UgxAmount;
  readonly floatTransferredOut: UgxAmount;
  readonly floatTransferredIn: UgxAmount;
}

/** One row of `agency_float_trade_register`. */
export interface AgencyFloatTradeRow {
  readonly id: string;
  readonly kind: AgencyTradeKind;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly floatAccountId: string;
  readonly tillName: string;
  readonly label: string | null;
  readonly counterFloatAccountId: string | null;
  readonly counterTillName: string | null;
  readonly counterLabel: string | null;
  readonly counterBranchCode: string | null;
  readonly settlementAccountCode: string | null;
  readonly settlementAccountName: string | null;
  readonly tradeDate: string;
  readonly floatAmount: UgxAmount;
  readonly cashAmount: UgxAmount | null;
  readonly feeAmount: UgxAmount | null;
  readonly totalAmount: UgxAmount;
  /** 'face value' | 'premium paid' | 'discount received', on a purchase only. */
  readonly purchaseBasis: string | null;
  readonly purchaseDifference: UgxAmount | null;
  readonly sourceKind: AgencyFloatSource | null;
  readonly counterpartyName: string | null;
  readonly reference: string;
  readonly notes: string | null;
  readonly status: AgencyTradeStatus;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly verifiedBy: string | null;
  readonly rejectedReason: string | null;
  readonly reversalReason: string | null;
}

/** One row of `agency_commission_reconciliation_register`. */
export interface AgencyCommissionReconciliationRow {
  readonly id: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly floatAccountId: string;
  readonly tillName: string;
  readonly label: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly systemCommissionEarned: UgxAmount;
  readonly providerReportedCommission: UgxAmount;
  readonly variance: UgxAmount;
  readonly varianceMeans: string;
  readonly statementRef: string;
  readonly status: 'open' | 'certified';
  readonly notes: string | null;
  readonly createdBy: string;
  readonly reconciledBy: string | null;
  /** What the same period says now; a gap means something was reversed since. */
  readonly currentSystemEarned: UgxAmount;
}

/** One row of `agency_commission_monthly`. */
export interface AgencyCommissionMonthRow {
  readonly floatAccountId: string;
  readonly providerId: string;
  readonly providerCode: string;
  readonly providerName: string;
  readonly branchId: string;
  readonly tillName: string;
  readonly label: string | null;
  readonly monthStart: string;
  readonly transactions: number;
  readonly principal: UgxAmount;
  readonly customerFees: UgxAmount;
  readonly commissionEarned: UgxAmount;
}

/**
 * A branch an officer may record an agency transaction at.
 *
 * In the domain module rather than the data layer because the recording form
 * needs it, and `lib/data/*` is server-only.
 */
export interface OperatingBranchOption {
  readonly id: string;
  readonly branchCode: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Cash banking — the Agency redesign, client Rule 5
// ---------------------------------------------------------------------------

/**
 * The states a cash banking can be in.
 *
 * Four rather than two, for the reason the float trade has four: a control
 * that can only say yes is not a control, so a rejected slip is kept with its
 * reason, and a posted banking that turns out to have gone to the wrong
 * account is reversed rather than edited.
 */
export const AGENCY_CASH_BANKING_STATUSES = [
  'pending',
  'posted',
  'rejected',
  'reversed',
] as const;
export type AgencyCashBankingStatus = (typeof AGENCY_CASH_BANKING_STATUSES)[number];

export function isAgencyCashBankingStatus(
  value: unknown,
): value is AgencyCashBankingStatus {
  return (
    typeof value === 'string' &&
    (AGENCY_CASH_BANKING_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * One row of `agency_cash_banking_register`.
 *
 * `netBanked` is the database's own `amount - charge`, not a subtraction done
 * here: it is what the bank actually credited, and a screen that recomputed it
 * would be a second opinion on a figure the journal already settled.
 */
export interface AgencyCashBankingRow {
  readonly id: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly branchName: string;
  readonly bankingDate: string;
  readonly amount: UgxAmount;
  readonly charge: UgxAmount;
  readonly netBanked: UgxAmount;
  readonly depositReference: string;
  readonly evidenceNote: string | null;
  readonly notes: string | null;
  readonly status: AgencyCashBankingStatus;
  readonly revision: number;
  readonly cashAccountId: string;
  readonly cashAccountCode: string;
  readonly bankAccountId: string;
  readonly bankAccountCode: string;
  readonly bankAccountName: string;
  readonly bankInstitution: string | null;
  readonly bankedBy: string;
  readonly bankedByName: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly createdAt: string;
  readonly verifiedBy: string | null;
  readonly verifiedByName: string | null;
  readonly verifiedAt: string | null;
  readonly rejectedReason: string | null;
  readonly journalEntryId: string | null;
  readonly reversalEntryId: string | null;
  readonly reversedBy: string | null;
  readonly reversedByName: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
}

/** A bank account a cash banking may be paid into. */
export interface BankAccountOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly institution: string | null;
  readonly branchId: string;
  readonly branchCode: string;
}

/** A staff member who may be named as having carried the cash. */
export interface BankingStaffOption {
  readonly profileId: string;
  readonly fullName: string;
  readonly branchId: string | null;
}

// ---------------------------------------------------------------------------
// Provider categories — what separates the two operational modules
// ---------------------------------------------------------------------------

/**
 * The categories `agency_service_providers.category` admits.
 *
 * Declared here as the single list the navigation, the banking screens and the
 * Mobile Money screens all read, so "which providers are banks" is one answer
 * in one place rather than a predicate written three times. The values are the
 * database's own CHECK from Phase 4A and are not invented here.
 */
export const AGENCY_PROVIDER_CATEGORIES = [
  'mobile_money',
  'agency_banking',
  'utility',
  'school_fees',
  'tv_subscription',
  'airtime_data',
  'other',
] as const;
export type AgencyProviderCategory = (typeof AGENCY_PROVIDER_CATEGORIES)[number];

export function isAgencyProviderCategory(
  value: unknown,
): value is AgencyProviderCategory {
  return (
    typeof value === 'string' &&
    (AGENCY_PROVIDER_CATEGORIES as readonly string[]).includes(value)
  );
}

/** How a category is written on a screen. */
export const AGENCY_CATEGORY_LABELS: Readonly<Record<AgencyProviderCategory, string>> = {
  mobile_money: 'Mobile Money',
  agency_banking: 'Agent Banking',
  utility: 'Utilities',
  school_fees: 'School fees',
  tv_subscription: 'TV subscriptions',
  airtime_data: 'Airtime & data',
  other: 'Other services',
};

/**
 * One agent account or agent line, with its identity and today's position.
 *
 * The same row shape for a bank agent account and a Mobile Money line,
 * because in the database they are the same thing: a row of
 * `agency_provider_float_accounts` with its own ledger account. The two
 * modules differ in which `providerCategory` they read, not in what an
 * account is — which is what keeps one tested aggregation behind both.
 */
export interface AgencyAgentAccountRow extends AgencyMoneyLineRow {
  readonly providerCategory: AgencyProviderCategory;
  readonly lineMsisdnMasked: string | null;
  readonly agentCode: string | null;
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  readonly branchName: string;
  readonly transactionsToday: number;
}

/**
 * What a reader calls an account in this module.
 *
 * A bank calls it an agent account and prints an agent number on its
 * statement; MTN and Airtel call it a line and it has a phone number. One
 * screen serving both would otherwise have to pick one word and be wrong half
 * the time.
 */
export function agentAccountNoun(category: AgencyProviderCategory): {
  readonly singular: string;
  readonly plural: string;
} {
  return category === 'mobile_money'
    ? { singular: 'agent line', plural: 'agent lines' }
    : { singular: 'agent account', plural: 'agent accounts' };
}

/**
 * The name to show for an account: its label, else its provider identifier,
 * else the till it is.
 *
 * Never the raw MSISDN, which is masked in the view it comes from.
 */
export function agentAccountName(row: {
  readonly label: string | null;
  readonly agentCode: string | null;
  readonly lineMsisdnMasked: string | null;
  readonly tillName: string;
}): string {
  return row.label ?? row.agentCode ?? row.lineMsisdnMasked ?? `Till ${row.tillName}`;
}
