/**
 * The columns of each Agency report, declared once.
 *
 * ## Why these live beside the lending report fields and not inside a screen
 *
 * `lib/reports/fields.ts` exists because a report's columns used to exist
 * twice over — once as a CSV column list and once as JSX — and the two drifted
 * in the way that is hardest to notice: a heading saying one thing and cells
 * holding another. A field declares a column once, and the screen, the CSV and
 * the PDF are all derived from it.
 *
 * The Agency reports get the same treatment, in their own file because they
 * are a different module with a different set of rows, and because
 * `fields.ts` is already the longest file in the reporting layer.
 *
 * ## What `moneyField` guarantees, and why it matters here
 *
 * It writes `1,250,000` on a page and in a PDF and `1250000` in a CSV. A
 * grouped figure in a CSV is a parse failure waiting for a spreadsheet with a
 * different locale, and these files are opened in Excel to be totalled. It
 * also disarms text: a leading `=`, `+`, `-` or `@` is neutralised, because a
 * provider reference is user-supplied and a CSV cell beginning with `=` is a
 * formula.
 *
 * ## What is deliberately absent
 *
 * No customer identifier. `agency_transactions.customer_identifier` is a
 * phone number or an account number the customer gave at the counter, and an
 * exported file is the single most portable thing in this application. The
 * transaction report carries the *provider's* reference, which is what a
 * reconciliation is performed against, and the masked line identifier. A
 * reader who needs the customer identifier has the transaction's own page,
 * which is authorised per request and cannot be emailed.
 *
 * Nor any customer bank balance, for the stronger reason that client Rule 1
 * forbids it existing at all: "POLYTOS must never attempt to retrieve,
 * calculate or display an individual customer's banking balance." There is no
 * column for it because there is no column for it in the database.
 */

import {
  countField,
  dateField,
  moneyField,
  textField,
  type ReportField,
} from '@/lib/reports/columns';
import type {
  AgencyAgentAccountRow,
  AgencyCashBankingRow,
  AgencyCashCountRow,
  AgencyCommissionRow,
  AgencyCommissionSettlementRow,
  AgencyPayableRow,
  AgencyTransactionRow,
  AgencyVarianceRow,
} from '@/lib/domain/agency';

/** §6.1 — the transaction report. */
export function agencyTransactionFields(): readonly ReportField<AgencyTransactionRow>[] {
  return [
    dateField('Date', (row) => row.transactionDate),
    textField('Provider', (row) => row.providerName, { weight: 2 }),
    textField('Account', (row) => row.agentCode ?? '—', { weight: 1.4 }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    textField('Type', (row) => row.typeName, { weight: 2 }),
    textField('Direction', (row) => row.direction ?? '—', { weight: 1.2 }),
    textField('Status', (row) => row.status, { weight: 1.3 }),
    moneyField('Principal', (row) => row.principalAmount),
    moneyField('Charge', (row) => row.customerFee),
    moneyField('Commission', (row) => row.commissionAmount ?? 0),
    textField('Provider reference', (row) => row.providerReference ?? '—', {
      weight: 1.8,
    }),
    textField('Recorded by', (row) => row.submittedByName ?? '—', { weight: 1.8 }),
    textField('Verified by', (row) => row.verifiedByName ?? '—', { weight: 1.8 }),
  ];
}

/** §6.2 — electronic float, per account. */
export function agencyFloatFields(): readonly ReportField<AgencyAgentAccountRow>[] {
  return [
    textField('Provider', (row) => row.providerName, { weight: 2 }),
    textField('Account', (row) => row.label ?? row.tillName, { weight: 2 }),
    textField('Identifier', (row) => row.agentCode ?? row.lineMsisdnMasked ?? '—', {
      weight: 1.6,
    }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    textField('Ledger account', (row) => row.ledgerAccountCode, { weight: 1.6 }),
    textField('Status', (row) => row.lineStatus, { weight: 1.1 }),
    moneyField('Float held', (row) => row.floatBalance),
    moneyField('Deposits today', (row) => row.depositValueToday),
    moneyField('Withdrawals today', (row) => row.withdrawalValueToday),
    moneyField('Commission today', (row) => row.commissionToday),
    moneyField('Commission receivable', (row) => row.commissionOutstanding),
    moneyField('Owed back', (row) => row.recoveryOwed),
  ];
}

/** §6.3 — cash banked. */
export function agencyCashBankingFields(): readonly ReportField<AgencyCashBankingRow>[] {
  return [
    dateField('Date', (row) => row.bankingDate),
    textField('Reference', (row) => row.depositReference, { weight: 1.6 }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    textField('Banked into', (row) => row.bankAccountName, { weight: 2.4 }),
    textField('Banked by', (row) => row.bankedByName, { weight: 2 }),
    moneyField('Amount', (row) => row.amount),
    moneyField('Charge', (row) => row.charge),
    moneyField('Net banked', (row) => row.netBanked),
    textField('Status', (row) => row.status, { weight: 1.2 }),
    textField('Recorded by', (row) => row.createdByName, { weight: 1.8 }),
    textField('Verified by', (row) => row.verifiedByName ?? '—', { weight: 1.8 }),
  ];
}

/** §6.3 — counted cash against the book. */
export function agencyCashCountFields(): readonly ReportField<AgencyCashCountRow>[] {
  return [
    dateField('Date', (row) => row.reconciliationDate),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    textField('Account', (row) => row.accountCode, { weight: 1.6 }),
    moneyField('Book balance', (row) => row.systemClosingBalance),
    moneyField('Counted', (row) => row.physicalCount),
    moneyField('Variance', (row) => row.variance),
    // The database's own statement of what the sign means. Cash and float use
    // opposite conventions, so a file that omitted it would be a file a reader
    // could get backwards.
    textField('Variance means', (row) => row.varianceMeans, { weight: 2.6 }),
    moneyField('Written off', (row) => row.varianceWrittenOff),
    textField('Status', (row) => row.status, { weight: 1.2 }),
  ];
}

/** §6.4 — commission earned against commission received. */
export function agencyCommissionFields(): readonly ReportField<AgencyCommissionRow>[] {
  return [
    textField('Provider', (row) => row.providerName, { weight: 2.4 }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    moneyField('Earned', (row) => row.earned),
    moneyField('Received', (row) => row.received),
    moneyField('Returned', (row) => row.returned),
    moneyField('Outstanding', (row) => row.outstanding),
  ];
}

/** §6.6 — what a provider has actually settled. */
export function agencyCommissionSettlementFields(): readonly ReportField<AgencyCommissionSettlementRow>[] {
  return [
    dateField('Date', (row) => row.settlementDate),
    textField('Provider', (row) => row.providerName, { weight: 2.2 }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    textField('Statement', (row) => row.providerStatementRef ?? '—', { weight: 1.8 }),
    moneyField('Amount', (row) => row.settlementAmount),
    textField('Settled into', (row) => row.settlementAccountCode, { weight: 1.6 }),
    textField('Status', (row) => row.status, { weight: 1.2 }),
    textField('Reversal reason', (row) => row.reversalReason ?? '—', { weight: 2.2 }),
  ];
}

/** §6.6 — the provider's payable position. */
export function agencyPayableFields(): readonly ReportField<AgencyPayableRow>[] {
  return [
    textField('Provider', (row) => row.providerName, { weight: 2.4 }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    moneyField('Collected', (row) => row.collected),
    moneyField('Remitted', (row) => row.remitted),
    moneyField('Reversed', (row) => row.remittanceReversed),
    moneyField('Outstanding', (row) => row.outstanding),
  ];
}

/** §6.6 — every variance, cash and float, each with its own convention. */
export function agencyVarianceFields(): readonly ReportField<AgencyVarianceRow>[] {
  return [
    dateField('Date', (row) => row.reconciliationDate),
    textField('Kind', (row) => row.kind, { weight: 1 }),
    textField('Branch', (row) => row.branchCode, { weight: 1 }),
    textField('Provider', (row) => row.providerName ?? '—', { weight: 2 }),
    moneyField('System balance', (row) => row.systemClosingBalance),
    moneyField('Counted / statement', (row) => row.countedOrStatement),
    moneyField('Variance', (row) => row.variance),
    textField('Variance means', (row) => row.varianceMeans, { weight: 2.6 }),
    moneyField('Written off', (row) => row.varianceWrittenOff),
    textField('Status', (row) => row.status, { weight: 1.2 }),
    textField('Statement', (row) => row.statementRef ?? '—', { weight: 1.6 }),
  ];
}

/**
 * §6.5 — what each staff member handled.
 *
 * Its own row type, because this report has no view behind it: it is a tally
 * over the transaction rows the database returned, grouped by the officer
 * named on each. Declared here so the screen's table and the file's columns
 * are the same declaration, which is the whole point of this layer.
 *
 * No commission column. Commission is earned by an *account*, not by the
 * officer who keyed the transaction, and attributing it to a person would be
 * inventing an allocation rule the business has not stated. The volume columns
 * are named as service volume, because §6.5 says in terms: "Do not treat the
 * full monetary volume of customer transactions as profit."
 */
export interface AgencyPerformanceRow {
  readonly name: string;
  readonly recorded: number;
  readonly verified: number;
  readonly deposits: number;
  readonly depositValue: number;
  readonly withdrawals: number;
  readonly withdrawalValue: number;
  readonly reversed: number;
}

export function agencyPerformanceFields(): readonly ReportField<AgencyPerformanceRow>[] {
  return [
    textField('Staff member', (row) => row.name, { weight: 2.6 }),
    countField('Recorded', (row) => row.recorded),
    countField('Verified', (row) => row.verified),
    countField('Deposits', (row) => row.deposits),
    moneyField('Deposit service volume', (row) => row.depositValue),
    countField('Withdrawals', (row) => row.withdrawals),
    moneyField('Withdrawal service volume', (row) => row.withdrawalValue),
    countField('Reversed', (row) => row.reversed),
  ];
}
