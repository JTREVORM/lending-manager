/**
 * Each report's columns, declared once.
 *
 * No `server-only` marker: the imports from `lib/data/reports` are type-only
 * and erased at build time, and the properties that matter here — that a money
 * column is grouped for a reader and plain for a spreadsheet, that no column
 * exports an identification number — are the kind that have to be asserted
 * directly. Same reasoning as `csv.ts`, `columns.ts` and the PDF writer.
 *
 * ## What changed, and what deliberately did not
 *
 * These field sets replaced five separate `*CsvColumns` functions. The CSV they
 * produce is **byte-identical** to what those produced, which is not an
 * assumption: `tests/unit/report-fields.test.ts` renders the same sample rows
 * through both and compares. A download somebody has a saved formula against
 * does not change shape because the application reorganised itself.
 *
 * So the headings are the old headings, including the two a fresh design would
 * have written differently:
 *
 *   - `Rate (basis points)` on the penalty report, rather than a percentage.
 *     Basis points are how the rate is stored, how the charge was computed and
 *     what the migration's own arithmetic uses. A financial report is the one
 *     place where the precise unit beats the readable one.
 *   - `Has active loan` as `yes` / `no` rather than a boolean, because that is
 *     what the existing file contains and what a filter in a spreadsheet is
 *     already written against.
 *
 * ## Weights
 *
 * A field's weight decides how much of a PDF page's *spare* width it gets once
 * every column has its floor, and how wide the table's column is on screen. A
 * person's name carries the most, because it is the column a reader scans and
 * the one that identifies the row; a phone number carries little, because it
 * is a fixed thirteen characters and extra room buys nothing. Getting this
 * backwards is visible immediately: at weight 2.2 the guarantor report cut
 * "Ssemakula Brian Kato" to seventeen characters while its phone column sat
 * half empty.
 */

import { DELINQUENCY_STATE_LABELS } from '@/lib/domain/delinquency';
import { accountTypeLabel } from '@/lib/domain/trial-balance';
import type { TrialBalanceLine } from '@/lib/domain/trial-balance';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { AGING_BUCKET_LABELS } from '@/lib/domain/risk';
import {
  COLLATERAL_ITEM_TYPE_LABELS,
  COLLATERAL_STATUS_LABELS,
  GUARANTEE_STATUS_LABELS,
  PROMISE_STATUS_LABELS,
  RECOVERY_ACTION_KIND_LABELS,
  RECOVERY_OUTCOME_LABELS,
} from '@/lib/domain/security';
import type {
  AgingRow,
  CollateralItem,
  GuarantorExposureRow,
  RecoveryAction,
} from '@/lib/data/security';
import type {
  ArrearsReportRow,
  ClientReportRow,
  CollectionRow,
  PenaltyReportRow,
  PortfolioRow,
} from '@/lib/data/reports';

import {
  countField,
  dateField,
  instantField,
  moneyField,
  phoneField,
  textField,
  type ReportField,
} from './columns';

export function collectionFields(
  timeZone: string,
): readonly ReportField<CollectionRow>[] {
  return [
    textField('Payment number', (row) => row.paymentNumber, { weight: 1.2 }),
    dateField('Business date', (row) => row.businessDate),
    instantField('Received', (row) => row.receivedAt, timeZone),
    textField('Client number', (row) => row.clientNumber, { weight: 1 }),
    // The name on the receipt, not the client's current name: a historical
    // document should read the way the receipt does.
    textField('Client', (row) => row.clientNameAtPayment, { weight: 3 }),
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    moneyField('Amount', (row) => row.amount),
    moneyField('Effective amount', (row) => row.effectiveAmount),
    textField('Method', (row) => PAYMENT_METHOD_LABELS[row.paymentMethod], {
      weight: 1,
    }),
    textField('Status', (row) => row.status, { weight: 0.9 }),
    textField('Recorded by', (row) => row.recordedByLabel, { weight: 1.6 }),
    textField('Reference', (row) => row.externalReference, { weight: 1.2 }),
    textField('Reversal reason', (row) => row.reversalReason, { weight: 2 }),
    moneyField('Principal', (row) => row.principalCollected),
    moneyField('Interest', (row) => row.interestCollected),
    moneyField('Penalty', (row) => row.penaltyCollected),
  ];
}

export function portfolioFields(timeZone: string): readonly ReportField<PortfolioRow>[] {
  return [
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    textField('Client number', (row) => row.clientNumber, { weight: 1 }),
    textField('Client', (row) => row.clientName, { weight: 3 }),
    phoneField('Phone', (row) => row.clientPhone),
    textField('Loan status', (row) => row.loanStatus, { weight: 1 }),
    textField(
      'Delinquency status',
      (row) => (row.state === null ? '' : DELINQUENCY_STATE_LABELS[row.state]),
      { weight: 1.4 },
    ),
    moneyField('Principal', (row) => row.principalAmount),
    moneyField('Interest', (row) => row.contractualInterest),
    moneyField('Penalty charged', (row) => row.penaltyAssessed),
    moneyField('Total expected', (row) => row.totalExpectedRepayment),
    moneyField('Collected', (row) => row.totalCollected),
    moneyField('Contract outstanding', (row) => row.contractualOutstanding),
    moneyField('Penalty outstanding', (row) => row.penaltyRemaining),
    moneyField('Total outstanding', (row) => row.totalOutstanding),
    moneyField('Arrears', (row) => row.arrearsAmount),
    countField('Missed collections', (row) => row.missedInstallmentCount),
    countField('Days past due', (row) => row.daysPastDue),
    instantField('Disbursed', (row) => row.disbursedAt, timeZone),
    dateField('Completion date', (row) => row.scheduledCompletionDate),
    dateField('Grace ends', (row) => row.graceEndDate),
    instantField('Cleared', (row) => row.clearedAt, timeZone),
  ];
}

export function arrearsFields(
  timeZone: string,
  options: { readonly withRemarks: boolean },
): readonly ReportField<ArrearsReportRow>[] {
  const base = portfolioFields(timeZone) as readonly ReportField<ArrearsReportRow>[];

  const extra: readonly ReportField<ArrearsReportRow>[] = [
    moneyField('Due today', (row) => row.dueTodayAmount),
    moneyField('Current due', (row) => row.currentDue),
    dateField('Oldest missed collection', (row) => row.oldestPastDueDate),
  ];

  // The remark columns appear only when the caller may read remarks. A heading
  // with every cell blank would imply there were no notes, which is a
  // different and misleading claim.
  const remarks: readonly ReportField<ArrearsReportRow>[] = options.withRemarks
    ? [
        textField('Latest note', (row) => row.latestRemark?.body ?? '', { weight: 3 }),
        textField('Note by', (row) => row.latestRemark?.createdByLabel ?? '', {
          weight: 1.6,
        }),
        instantField(
          'Note recorded',
          (row) => row.latestRemark?.createdAt ?? null,
          timeZone,
        ),
      ]
    : [];

  return [...base, ...extra, ...remarks];
}

export function penaltyFields(
  timeZone: string,
): readonly ReportField<PenaltyReportRow>[] {
  return [
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    textField('Client number', (row) => row.clientNumber, { weight: 1 }),
    textField('Client', (row) => row.clientName, { weight: 3 }),
    dateField('Final collection date', (row) => row.finalDueDate),
    countField('Grace days', (row) => row.gracePeriodDays),
    dateField('Grace ended', (row) => row.graceEndDate),
    dateField('Charge effective', (row) => row.effectiveDate),
    moneyField('Charged on', (row) => row.basisAmount),
    // Basis points, not a percentage. See the module note.
    countField('Rate (basis points)', (row) => row.penaltyRateBps, { weight: 1 }),
    moneyField('Charge', (row) => row.penaltyAmount),
    moneyField('Paid', (row) => row.penaltyPaid),
    moneyField('Remaining', (row) => row.penaltyRemaining),
    instantField('Recorded', (row) => row.appliedAt, timeZone),
  ];
}

export function clientFields(timeZone: string): readonly ReportField<ClientReportRow>[] {
  return [
    textField('Client number', (row) => row.clientNumber, { weight: 1 }),
    textField('Name', (row) => row.fullName, { weight: 3 }),
    phoneField('Phone', (row) => row.phone),
    textField('District', (row) => row.district, { weight: 1.3 }),
    textField('Village or area', (row) => row.villageArea, { weight: 1.6 }),
    textField('Occupation', (row) => row.occupation, { weight: 1.4 }),
    textField('Status', (row) => row.status, { weight: 1 }),
    textField('Has active loan', (row) => (row.hasActiveLoan ? 'yes' : 'no'), {
      weight: 0.9,
    }),
    countField('Loans', (row) => row.loanCount),
    moneyField('Outstanding', (row) => row.totalOutstanding),
    moneyField('Arrears', (row) => row.arrearsAmount),
    textField(
      'Delinquency status',
      (row) => (row.state === null ? '' : DELINQUENCY_STATE_LABELS[row.state]),
      { weight: 1.4 },
    ),
    instantField('Registered', (row) => row.registeredAt, timeZone),
    // Deliberately no National Identification Number. §76, and
    // `assertNoIdentityField` refuses one at registry build time.
  ];
}

// ===========================================================================
// Phase 16 — the four reports the Debt & Security module had no document for
//
// Phase 14 built these views and the screens that work from them. What they
// had no way to produce was a *document*: aging and portfolio-at-risk figures
// that could be printed for a committee, a guarantor register that could be
// handed to whoever is chasing a guarantee, a valuation of the security held,
// a recovery file somebody could file.
//
// So each is a report now, on the same framework as the other six, and each
// one's page says plainly which operational screen to use instead when the
// job is to *act* rather than to account.
// ===========================================================================

/**
 * Aging takes no timezone, because every date on it is a business date.
 *
 * A bucket is a count of whole days and the dates beside it are calendar
 * dates. Stamping a time on any of them would imply a precision the
 * arithmetic has not got, and a report that said a loan fell 31 days behind
 * "at 14:05" would be inviting a question it cannot answer.
 */
export function agingFields(): readonly ReportField<AgingRow>[] {
  return [
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    textField('Client number', (row) => row.clientNumber, { weight: 1 }),
    textField('Client', (row) => row.clientName, { weight: 3 }),
    phoneField('Phone', (row) => row.clientPhone),
    textField('Branch', (row) => row.branchName, { weight: 1.4 }),
    textField('Product', (row) => row.productName, { weight: 1.6 }),
    textField('Aging bucket', (row) => AGING_BUCKET_LABELS[row.agingBucket], {
      weight: 1.3,
    }),
    countField('Days past due', (row) => row.daysPastDue),
    countField('Missed collections', (row) => row.missedInstallmentCount),
    dateField('Oldest missed collection', (row) => row.oldestPastDueDate),
    moneyField('Principal outstanding', (row) => row.principalRemaining),
    moneyField('Penalty outstanding', (row) => row.penaltyRemaining),
    moneyField('Total outstanding', (row) => row.totalOutstanding),
    moneyField('Arrears', (row) => row.arrearsAmount),
    textField('Delinquency status', (row) => row.delinquencyState, { weight: 1.4 }),
    textField('Loan status', (row) => row.loanStatus, { weight: 1 }),
    dateField('Last payment', (row) => row.lastPaymentDate),
    // `instantField` is unused here on purpose: every date on this report is a
    // business date, not a moment. A bucket is a count of whole days, and
    // stamping a time on it would imply a precision the arithmetic has not
    // got.
    textField('Charge applied', (row) => (row.penaltyApplied ? 'yes' : 'no'), {
      weight: 0.9,
    }),
  ];
}

export function guarantorFields(
  timeZone: string,
): readonly ReportField<GuarantorExposureRow>[] {
  return [
    textField('Guarantor', (row) => row.guarantorName, { weight: 3.2 }),
    // The brief asks for this column by name: whether the guarantor is an
    // existing borrower or somebody from outside. It changes what the
    // business can do about the guarantee.
    textField(
      'Existing client or external',
      (row) => (row.subjectKind === 'client' ? 'Existing client' : 'External'),
      { weight: 1.4 },
    ),
    phoneField('Guarantor phone', (row) => row.guarantorPhone),
    textField('Guarantor client number', (row) => row.guarantorClientNumber, {
      weight: 0.9,
    }),
    textField('Relationship', (row) => row.relationshipToClient, { weight: 1.3 }),
    textField('Borrower', (row) => row.clientName, { weight: 3.2 }),
    textField('Borrower number', (row) => row.clientNumber, { weight: 1 }),
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    textField('Product', (row) => row.productName, { weight: 1.6 }),
    // The loan's principal: on this view a guarantor stands behind the whole
    // loan rather than a share of it, which is why two guarantors on one loan
    // show the same figure. A *total* of this column therefore has to be
    // taken per loan, which `getGuarantorExposureExport` does.
    moneyField('Guaranteed amount', (row) => row.guaranteedAmount),
    // The loan's total expected repayment — principal plus contractual
    // interest. What the guarantee is ultimately standing behind, as opposed
    // to the principal that was handed over.
    moneyField('Total repayable', (row) => row.guaranteedTotal),
    moneyField('Outstanding balance', (row) => row.outstandingBalance),
    moneyField('Arrears', (row) => row.arrearsAmount),
    countField('Days past due', (row) => row.daysPastDue),
    dateField('Guarantee date', (row) => row.guaranteeDate),
    textField('Loan status', (row) => row.loanStatus, { weight: 1 }),
    textField('Guarantee status', (row) => GUARANTEE_STATUS_LABELS[row.guaranteeStatus], {
      weight: 1.4,
    }),
    textField('Released', (row) => (row.isReleased ? 'yes' : 'no'), { weight: 0.9 }),
    instantField('Released on', (row) => row.releasedAt, timeZone),
    textField('Release reason', (row) => row.releaseReason, { weight: 2.4 }),
    textField('Consent signed', (row) => (row.consentSigned ? 'yes' : 'no'), {
      weight: 1,
    }),
    textField('Undertaking version', (row) => row.consentVersion, { weight: 1.2 }),
  ];
}

export function collateralFields(
  timeZone: string,
): readonly ReportField<CollateralItem>[] {
  return [
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    textField('Client number', (row) => row.clientNumber, { weight: 1 }),
    textField('Client', (row) => row.clientName, { weight: 3 }),
    phoneField('Phone', (row) => row.clientPhone),
    textField('Product', (row) => row.productName, { weight: 1.6 }),
    textField('Item type', (row) => COLLATERAL_ITEM_TYPE_LABELS[row.itemType], {
      weight: 1.4,
    }),
    textField('Description', (row) => row.description, { weight: 2.6 }),
    moneyField('Valued at', (row) => row.estimatedValue),
    dateField('Valued on', (row) => row.valuedOn),
    textField('Serial number', (row) => row.serialNumber, { weight: 1.4 }),
    textField('Ownership document', (row) => row.ownershipDocument, { weight: 1.6 }),
    textField('Where it is', (row) => row.location, { weight: 1.6 }),
    textField('Status', (row) => COLLATERAL_STATUS_LABELS[row.status], { weight: 1.2 }),
    instantField('Released on', (row) => row.releasedAt, timeZone),
    textField('Release reason', (row) => row.releaseReason, { weight: 2.2 }),
    moneyField('Realised for', (row) => row.realisedAmount),
    instantField('Realised on', (row) => row.realisedAt, timeZone),
    moneyField('Loan outstanding', (row) => row.totalOutstanding),
    textField('Loan status', (row) => row.loanStatus, { weight: 1 }),
    instantField('Recorded', (row) => row.createdAt, timeZone),
  ];
}

export function recoveryFields(timeZone: string): readonly ReportField<RecoveryAction>[] {
  return [
    dateField('Action date', (row) => row.actionDate),
    textField('Loan number', (row) => row.loanNumber, { weight: 1.1 }),
    textField('Client', (row) => row.clientName, { weight: 3 }),
    phoneField('Phone', (row) => row.clientPhone),
    textField('What was done', (row) => RECOVERY_ACTION_KIND_LABELS[row.actionKind], {
      weight: 1.4,
    }),
    textField(
      'Outcome',
      (row) => (row.outcome === null ? '' : RECOVERY_OUTCOME_LABELS[row.outcome]),
      { weight: 1.4 },
    ),
    textField('Note', (row) => row.notes, { weight: 3.2 }),
    dateField('Follow up on', (row) => row.followUpOn),
    moneyField('Promised', (row) => row.promisedAmount),
    dateField('Promised by', (row) => row.promisedOn),
    moneyField('Paid against the promise', (row) => row.promisePaidAmount),
    // Derived from the posted payments on every read, never stored — which is
    // why a promise's verdict in this report is correct on the day it is run
    // rather than on the day somebody last looked at it.
    textField(
      'Promise verdict',
      (row) =>
        row.promiseStatus === null ? '' : PROMISE_STATUS_LABELS[row.promiseStatus],
      { weight: 1.3 },
    ),
    textField('Corrected', (row) => (row.isCorrected ? 'yes' : 'no'), { weight: 1 }),
    textField('Recorded by', (row) => row.createdByLabel, { weight: 1.8 }),
    instantField('Recorded', (row) => row.createdAt, timeZone),
  ];
}

/**
 * The trial balance's columns.
 *
 * Seven, in the order a trial balance has always been read: what the account
 * is, what moved through it, and what it holds. Both pairs of money columns
 * are here for the reason `lib/domain/trial-balance.ts` gives — movement and
 * net balance are different questions, and a statement showing only one of
 * them can be misread.
 *
 * The same fields drive the screen, the CSV and the PDF, so a heading cannot
 * say one thing on paper and another in a spreadsheet, and the money columns
 * are grouped for a reader and plain for a spreadsheet by construction.
 *
 * No `defaultPeriod` and no filter columns: the view this reads has neither a
 * date nor a branch, by design (see the page).
 */
export function trialBalanceFields(): readonly ReportField<TrialBalanceLine>[] {
  return [
    textField('Code', (row) => row.code, { weight: 1, minWidth: 54 }),
    textField('Account', (row) => row.name, { weight: 3.2 }),
    textField('Type', (row) => accountTypeLabel(row.accountType), { weight: 1.2 }),
    moneyField('Debits', (row) => row.totalDebit),
    moneyField('Credits', (row) => row.totalCredit),
    moneyField('Debit balance', (row) => row.debitBalance),
    moneyField('Credit balance', (row) => row.creditBalance),
  ];
}
