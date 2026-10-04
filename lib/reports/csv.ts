/**
 * No `server-only` marker here, deliberately.
 *
 * Every other module under `lib/reports` and `lib/data` carries one, because
 * they reach the database or hold credentials. This one holds neither: it is
 * pure formatting, and its two most important behaviours — disarming a formula
 * cell and never emitting an identification number — are the kind of security
 * control that has to be *tested directly* rather than inferred from the
 * routes that call it. `server-only` throws when imported by the test
 * environment that can test them, so the marker would be buying a convention
 * at the cost of the assertions.
 *
 * Nothing is lost: the type-only imports below are erased at build time, so a
 * client bundle that imported this file would pull in formatting helpers it
 * already has.
 */

import { formatInstant, type BusinessDate } from '@/lib/domain/datetime';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { DELINQUENCY_STATE_LABELS } from '@/lib/domain/delinquency';
import { csvNumber, csvText, type CsvColumn } from '@/lib/domain/reporting';
import type {
  ArrearsReportRow,
  ClientReportRow,
  CollectionRow,
  PenaltyReportRow,
  PortfolioRow,
} from '@/lib/data/reports';

/**
 * The CSV shape of each report.
 *
 * ## Text is sanitised, numbers are not
 *
 * Every text cell goes through `csvText`, which neutralises a leading `=`,
 * `+`, `-` or `@` so a spreadsheet shows `=cmd|...` as text rather than
 * evaluating it. A client genuinely called `=Mukasa` appears as `=Mukasa`;
 * nothing is stripped, only disarmed.
 *
 * Money and counts go through `csvNumber`, which emits plain digits and never
 * prefixes anything. Prefixing a number would corrupt a figure to defend
 * against an attack a number cannot carry — a cell of `50000` has no formula
 * in it — and a column of `'50000` cannot be totalled by the person who asked
 * for the file.
 *
 * ## Money has no currency symbol and no separators
 *
 * `1250000`, not `UGX 1,250,000`. The screen is for reading and the file is
 * for totalling; a thousands separator in a CSV is a parse failure waiting for
 * a spreadsheet with different locale settings. The currency is in the column
 * heading instead.
 *
 * ## No National Identification Number in any export
 *
 * Not in the client report, not behind a capability. A NIN is read one record
 * at a time by somebody with a reason; a column of them in a file that
 * outlives every access control in the application is a different object
 * entirely. §76.
 */

function dateCell(value: BusinessDate | null): string {
  return value ?? '';
}

function instantCell(value: string | null, timeZone: string): string {
  return value === null ? '' : csvText(formatInstant(value, { timeZone }));
}

export function collectionCsvColumns(
  timeZone: string,
): readonly CsvColumn<CollectionRow>[] {
  return [
    { header: 'Payment number', cell: (row) => csvText(row.paymentNumber) },
    { header: 'Business date', cell: (row) => dateCell(row.businessDate) },
    { header: 'Received', cell: (row) => instantCell(row.receivedAt, timeZone) },
    { header: 'Client number', cell: (row) => csvText(row.clientNumber) },
    // The name on the receipt, not the client's current name: a historical
    // document should read the way the receipt does.
    { header: 'Client', cell: (row) => csvText(row.clientNameAtPayment) },
    { header: 'Loan number', cell: (row) => csvText(row.loanNumber) },
    { header: 'Amount (UGX)', cell: (row) => csvNumber(row.amount) },
    { header: 'Effective amount (UGX)', cell: (row) => csvNumber(row.effectiveAmount) },
    {
      header: 'Method',
      cell: (row) => csvText(PAYMENT_METHOD_LABELS[row.paymentMethod]),
    },
    { header: 'Status', cell: (row) => csvText(row.status) },
    { header: 'Recorded by', cell: (row) => csvText(row.recordedByLabel) },
    { header: 'Reference', cell: (row) => csvText(row.externalReference) },
    { header: 'Reversal reason', cell: (row) => csvText(row.reversalReason) },
    { header: 'Principal (UGX)', cell: (row) => csvNumber(row.principalCollected) },
    { header: 'Interest (UGX)', cell: (row) => csvNumber(row.interestCollected) },
    { header: 'Penalty (UGX)', cell: (row) => csvNumber(row.penaltyCollected) },
  ];
}

export function portfolioCsvColumns(
  timeZone: string,
): readonly CsvColumn<PortfolioRow>[] {
  return [
    { header: 'Loan number', cell: (row) => csvText(row.loanNumber) },
    { header: 'Client number', cell: (row) => csvText(row.clientNumber) },
    { header: 'Client', cell: (row) => csvText(row.clientName) },
    { header: 'Phone', cell: (row) => csvText(row.clientPhone) },
    { header: 'Loan status', cell: (row) => csvText(row.loanStatus) },
    {
      header: 'Delinquency status',
      cell: (row) =>
        csvText(row.state === null ? '' : DELINQUENCY_STATE_LABELS[row.state]),
    },
    { header: 'Principal (UGX)', cell: (row) => csvNumber(row.principalAmount) },
    { header: 'Interest (UGX)', cell: (row) => csvNumber(row.contractualInterest) },
    { header: 'Penalty charged (UGX)', cell: (row) => csvNumber(row.penaltyAssessed) },
    {
      header: 'Total expected (UGX)',
      cell: (row) => csvNumber(row.totalExpectedRepayment),
    },
    { header: 'Collected (UGX)', cell: (row) => csvNumber(row.totalCollected) },
    {
      header: 'Contract outstanding (UGX)',
      cell: (row) => csvNumber(row.contractualOutstanding),
    },
    {
      header: 'Penalty outstanding (UGX)',
      cell: (row) => csvNumber(row.penaltyRemaining),
    },
    { header: 'Total outstanding (UGX)', cell: (row) => csvNumber(row.totalOutstanding) },
    { header: 'Arrears (UGX)', cell: (row) => csvNumber(row.arrearsAmount) },
    {
      header: 'Missed collections',
      cell: (row) => csvNumber(row.missedInstallmentCount),
    },
    { header: 'Days past due', cell: (row) => csvNumber(row.daysPastDue) },
    { header: 'Disbursed', cell: (row) => instantCell(row.disbursedAt, timeZone) },
    { header: 'Completion date', cell: (row) => dateCell(row.scheduledCompletionDate) },
    { header: 'Grace ends', cell: (row) => dateCell(row.graceEndDate) },
    { header: 'Cleared', cell: (row) => instantCell(row.clearedAt, timeZone) },
  ];
}

export function arrearsCsvColumns(
  timeZone: string,
  options: { readonly withRemarks: boolean },
): readonly CsvColumn<ArrearsReportRow>[] {
  const base = portfolioCsvColumns(timeZone) as readonly CsvColumn<ArrearsReportRow>[];

  const extra: readonly CsvColumn<ArrearsReportRow>[] = [
    { header: 'Due today (UGX)', cell: (row) => csvNumber(row.dueTodayAmount) },
    { header: 'Current due (UGX)', cell: (row) => csvNumber(row.currentDue) },
    {
      header: 'Oldest missed collection',
      cell: (row) => dateCell(row.oldestPastDueDate),
    },
  ];

  // The remark column appears only when the caller may read remarks. A header
  // with every cell blank would imply there were no notes, which is a
  // different and misleading claim.
  const remarks: readonly CsvColumn<ArrearsReportRow>[] = options.withRemarks
    ? [
        {
          header: 'Latest note',
          cell: (row) => csvText(row.latestRemark?.body ?? ''),
        },
        {
          header: 'Note by',
          cell: (row) => csvText(row.latestRemark?.createdByLabel ?? ''),
        },
        {
          header: 'Note recorded',
          cell: (row) => instantCell(row.latestRemark?.createdAt ?? null, timeZone),
        },
      ]
    : [];

  return [...base, ...extra, ...remarks];
}

export function penaltyCsvColumns(
  timeZone: string,
): readonly CsvColumn<PenaltyReportRow>[] {
  return [
    { header: 'Loan number', cell: (row) => csvText(row.loanNumber) },
    { header: 'Client number', cell: (row) => csvText(row.clientNumber) },
    { header: 'Client', cell: (row) => csvText(row.clientName) },
    { header: 'Final collection date', cell: (row) => dateCell(row.finalDueDate) },
    { header: 'Grace days', cell: (row) => csvNumber(row.gracePeriodDays) },
    { header: 'Grace ended', cell: (row) => dateCell(row.graceEndDate) },
    { header: 'Charge effective', cell: (row) => dateCell(row.effectiveDate) },
    { header: 'Charged on (UGX)', cell: (row) => csvNumber(row.basisAmount) },
    { header: 'Rate (basis points)', cell: (row) => csvNumber(row.penaltyRateBps) },
    { header: 'Charge (UGX)', cell: (row) => csvNumber(row.penaltyAmount) },
    { header: 'Paid (UGX)', cell: (row) => csvNumber(row.penaltyPaid) },
    { header: 'Remaining (UGX)', cell: (row) => csvNumber(row.penaltyRemaining) },
    { header: 'Recorded', cell: (row) => instantCell(row.appliedAt, timeZone) },
  ];
}

export function clientCsvColumns(
  timeZone: string,
): readonly CsvColumn<ClientReportRow>[] {
  return [
    { header: 'Client number', cell: (row) => csvText(row.clientNumber) },
    { header: 'Name', cell: (row) => csvText(row.fullName) },
    { header: 'Phone', cell: (row) => csvText(row.phone) },
    { header: 'District', cell: (row) => csvText(row.district) },
    { header: 'Village or area', cell: (row) => csvText(row.villageArea) },
    { header: 'Occupation', cell: (row) => csvText(row.occupation) },
    { header: 'Status', cell: (row) => csvText(row.status) },
    { header: 'Has active loan', cell: (row) => (row.hasActiveLoan ? 'yes' : 'no') },
    { header: 'Loans', cell: (row) => csvNumber(row.loanCount) },
    { header: 'Outstanding (UGX)', cell: (row) => csvNumber(row.totalOutstanding) },
    { header: 'Arrears (UGX)', cell: (row) => csvNumber(row.arrearsAmount) },
    {
      header: 'Delinquency status',
      cell: (row) =>
        csvText(row.state === null ? '' : DELINQUENCY_STATE_LABELS[row.state]),
    },
    { header: 'Registered', cell: (row) => instantCell(row.registeredAt, timeZone) },
    // Deliberately no National Identification Number. See the module note.
  ];
}

/** The response a CSV export returns. One place, so every route agrees. */
export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // `attachment` matters beyond convenience: it stops a browser rendering
      // the file in place, which is what turns a CSV holding user-supplied text
      // into a content-sniffing problem.
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
