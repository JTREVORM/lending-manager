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
