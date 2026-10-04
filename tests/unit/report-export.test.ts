import { describe, expect, it } from 'vitest';

import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { toCsv } from '@/lib/domain/reporting';
import {
  arrearsCsvColumns,
  clientCsvColumns,
  collectionCsvColumns,
  csvResponse,
  penaltyCsvColumns,
  portfolioCsvColumns,
} from '@/lib/reports/csv';
import type {
  ArrearsReportRow,
  ClientReportRow,
  CollectionRow,
  PenaltyReportRow,
  PortfolioRow,
} from '@/lib/data/reports';

/**
 * The CSV exports.
 *
 * ## The two things a report file must get right
 *
 * **It must not execute.** A CSV is opened in a spreadsheet, and a cell
 * beginning `=`, `+`, `-` or `@` is a formula to that spreadsheet. A client
 * name is user-controlled text, so a borrower who registers as
 * `=cmd|' /C calc'!A0` would otherwise hand a command to whoever opens the
 * file. Every text cell is disarmed; no number is, because a number cannot
 * carry a formula and prefixing one would corrupt a figure.
 *
 * **It must not carry an identification number.** Not behind a capability,
 * not as a column somebody can hide. A NIN is read one record at a time by
 * somebody with a reason; a file of them outlives every access control this
 * application has. §76.
 *
 * The rest — that money is plain digits, that the remark columns appear only
 * for a caller entitled to notes — follows from those two.
 */

const TIMEZONE = 'Africa/Kampala';
const ZERO = toUgx(0);

/** The canonical spreadsheet-injection payload. */
const PAYLOAD = "=cmd|' /C calc'!A0";

const collectionRow = (overrides: Partial<CollectionRow> = {}): CollectionRow => ({
  paymentId: 'p1',
  paymentNumber: 'RC-2026-00001',
  businessDate: toBusinessDate('2026-10-04'),
  receivedAt: '2026-10-04T07:30:00Z',
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  clientName: 'Nakimuli Zaïnabu',
  clientNameAtPayment: 'Nakimuli Zaïnabu',
  amount: toUgx(4_000),
  effectiveAmount: toUgx(4_000),
  paymentMethod: 'cash',
  status: 'posted',
  isEffective: true,
  recordedBy: 'profile-1',
  recordedByLabel: 'A Secretary',
  externalReference: null,
  reversalReason: null,
  principalCollected: toUgx(3_200),
  interestCollected: toUgx(800),
  penaltyCollected: ZERO,
  ...overrides,
});

const portfolioRow = (overrides: Partial<PortfolioRow> = {}): PortfolioRow => ({
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  clientName: 'Nakimuli Zaïnabu',
  clientPhone: '+256700000001',
  clientNameAtOrigination: 'Nakimuli Zaïnabu',
  clientPhoneAtOrigination: '+256700000001',
  loanStatus: 'active',
  principalAmount: toUgx(500_000),
  interestRateBps: 2_000,
  loanTermMonths: 1,
  repaymentFrequency: 'daily',
  contractualInterest: toUgx(100_000),
  totalExpectedRepayment: toUgx(600_000),
  gracePeriodDays: 3,
  penaltyRateBps: 5_000,
  disbursedAt: '2026-09-01T07:00:00Z',
  clearedAt: null,
  cancelledAt: null,
  scheduledTotal: toUgx(600_000),
  totalPaid: toUgx(200_000),
  principalPaid: toUgx(160_000),
  interestPaid: toUgx(40_000),
  contractualOutstanding: toUgx(400_000),
  penaltyAssessed: ZERO,
  penaltyPaid: ZERO,
  penaltyRemaining: ZERO,
  totalOutstanding: toUgx(400_000),
  totalCollected: toUgx(200_000),
  postedPaymentCount: 5,
  reversedPaymentCount: 0,
  lastPaymentAt: '2026-10-01T07:00:00Z',
  scheduledCompletionDate: toBusinessDate('2026-10-01'),
  installmentCount: 25,
  firstDueDate: toBusinessDate('2026-09-02'),
  arrearsAmount: toUgx(24_000),
  dueTodayAmount: toUgx(4_000),
  currentDue: toUgx(28_000),
  missedInstallmentCount: 6,
  daysPastDue: 6,
  oldestUnpaidDueDate: toBusinessDate('2026-09-28'),
  oldestPastDueDate: toBusinessDate('2026-09-28'),
  graceEndDate: toBusinessDate('2026-10-04'),
  penaltyEffectiveDate: toBusinessDate('2026-10-05'),
  withinGracePeriod: true,
  penaltyApplied: false,
  penaltyEligible: false,
  penaltyProjectedAmount: ZERO,
  state: 'in_arrears',
  ...overrides,
});

const arrearsRow = (overrides: Partial<ArrearsReportRow> = {}): ArrearsReportRow => ({
  ...portfolioRow(),
  latestRemark: null,
  ...overrides,
});

const penaltyRow = (overrides: Partial<PenaltyReportRow> = {}): PenaltyReportRow => ({
  penaltyId: 'pen-1',
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  clientName: 'Nakimuli Zaïnabu',
  penaltyType: 'expiry',
  finalDueDate: toBusinessDate('2026-10-01'),
  gracePeriodDays: 3,
  graceEndDate: toBusinessDate('2026-10-04'),
  effectiveDate: toBusinessDate('2026-10-05'),
  basisAmount: toUgx(400_000),
  penaltyRateBps: 5_000,
  penaltyAmount: toUgx(200_000),
  penaltyPaid: ZERO,
  penaltyRemaining: toUgx(200_000),
  appliedAt: '2026-10-05T07:00:00Z',
  ...overrides,
});

const clientRow = (overrides: Partial<ClientReportRow> = {}): ClientReportRow => ({
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  fullName: 'Nakimuli Zaïnabu',
  phone: '+256700000001',
  district: 'Kampala',
  villageArea: 'Kalerwe',
  occupation: 'Trader',
  status: 'active',
  registeredAt: '2026-01-15T07:00:00Z',
  hasActiveLoan: true,
  loanCount: 2,
  totalOutstanding: toUgx(400_000),
  arrearsAmount: toUgx(24_000),
  state: 'in_arrears',
  ...overrides,
});

const ALL_COLUMN_SETS = () => [
  { name: 'collections', columns: collectionCsvColumns(TIMEZONE) },
  { name: 'portfolio', columns: portfolioCsvColumns(TIMEZONE) },
  { name: 'arrears', columns: arrearsCsvColumns(TIMEZONE, { withRemarks: true }) },
  { name: 'penalties', columns: penaltyCsvColumns(TIMEZONE) },
  { name: 'clients', columns: clientCsvColumns(TIMEZONE) },
];

// ===========================================================================
describe('every export', () => {
  it('names each column', () => {
    for (const set of ALL_COLUMN_SETS()) {
      expect(set.columns.length, set.name).toBeGreaterThan(5);
      for (const column of set.columns) {
        expect(column.header.length, `${set.name}: ${column.header}`).toBeGreaterThan(0);
      }
    }
  });

  it('names the currency in the heading, never in the cell', () => {
    // The screen is for reading and the file is for totalling, so a money cell
    // is plain digits and the column says UGX.
    for (const set of ALL_COLUMN_SETS()) {
      const money = set.columns.filter((column) => column.header.includes('(UGX)'));
      expect(money.length, set.name).toBeGreaterThan(0);
    }
  });

  it('carries no identification number, in any report', () => {
    // §76. The absence is structural: there is no such column to gate.
    for (const set of ALL_COLUMN_SETS()) {
      for (const column of set.columns) {
        // A word-boundary match: "Remaining (UGX)" contains the letters but is
        // not a National Identification Number column.
        expect(column.header, `${set.name}: ${column.header}`).not.toMatch(/\bnin\b/i);
        expect(column.header, `${set.name}: ${column.header}`).not.toMatch(
          /identification|national id|id document/i,
        );
      }
    }
  });
});

// ===========================================================================
describe('spreadsheet formula injection', () => {
  it('disarms a payload in a client name, in every report that shows one', () => {
    const files = [
      toCsv(collectionCsvColumns(TIMEZONE), [
        collectionRow({ clientNameAtPayment: PAYLOAD, clientName: PAYLOAD }),
      ]),
      toCsv(portfolioCsvColumns(TIMEZONE), [portfolioRow({ clientName: PAYLOAD })]),
      toCsv(arrearsCsvColumns(TIMEZONE, { withRemarks: true }), [
        arrearsRow({ clientName: PAYLOAD }),
      ]),
      toCsv(penaltyCsvColumns(TIMEZONE), [penaltyRow({ clientName: PAYLOAD })]),
      toCsv(clientCsvColumns(TIMEZONE), [clientRow({ fullName: PAYLOAD })]),
    ];

    for (const file of files) {
      // The payload is present — nothing is stripped — but it can no longer
      // be read as a formula, because the cell now starts with a quote.
      expect(file).toContain('calc');
      expect(file).toContain("'=cmd");
      // And no cell begins with a bare formula character.
      for (const line of file.replace('﻿', '').trim().split('\r\n').slice(1)) {
        for (const cell of line.split(',')) {
          expect(['=', '@'].includes(cell.charAt(0)), cell).toBe(false);
        }
      }
    }
  });

  it('disarms a payload in a remark, which is free text somebody typed', () => {
    const file = toCsv(arrearsCsvColumns(TIMEZONE, { withRemarks: true }), [
      arrearsRow({
        latestRemark: {
          id: 'r1',
          body: '@SUM(1+1)*cmd|/C calc',
          category: 'general',
          createdByLabel: 'A Manager',
          createdAt: '2026-10-02T09:00:00Z',
        },
      }),
    ]);

    expect(file).toContain("'@SUM(1+1)*cmd|/C calc");
  });

  it('disarms a payload in a reversal reason', () => {
    const file = toCsv(collectionCsvColumns(TIMEZONE), [
      collectionRow({ status: 'reversed', reversalReason: '-1+1' }),
    ]);

    expect(file).toContain("'-1+1");
  });

  it('leaves money alone, because a number carries no formula', () => {
    const file = toCsv(collectionCsvColumns(TIMEZONE), [collectionRow()]);
    const [header, ...rows] = file.replace('\uFEFF', '').trim().split('\r\n');

    // The currency belongs in the heading…
    expect(header).toContain('(UGX)');

    // …and the cells are plain digits: no quote prefix, no separator, no code.
    const body = rows.join('\r\n');
    expect(body).toContain(',4000,');
    expect(body).not.toContain("'4000");
    expect(body).not.toContain('4,000');
    expect(body).not.toContain('UGX');
  });

  it('keeps a comma or a quote in a name from breaking the row', () => {
    const file = toCsv(clientCsvColumns(TIMEZONE), [
      clientRow({ fullName: 'Ssemakula, Kyagaba "Junior"', villageArea: 'Kalerwe, B' }),
    ]);

    const rows = file.replace('﻿', '').trim().split('\r\n');
    // Header plus exactly one data row: the embedded comma did not split it.
    expect(rows).toHaveLength(2);
    expect(file).toContain('"Ssemakula, Kyagaba ""Junior"""');
  });

  it('keeps a newline in free text from splitting a record', () => {
    const file = toCsv(arrearsCsvColumns(TIMEZONE, { withRemarks: true }), [
      arrearsRow({
        latestRemark: {
          id: 'r1',
          body: 'Visited the shop.\nPromised Friday.',
          category: 'contact',
          createdByLabel: 'A Manager',
          createdAt: '2026-10-02T09:00:00Z',
        },
      }),
    ]);

    expect(file.replace('﻿', '').trim().split('\r\n')).toHaveLength(2);
    expect(file).toContain('Visited the shop. Promised Friday.');
  });

  it('carries a non-ASCII name intact, with a byte-order mark', () => {
    // Without the BOM a spreadsheet opens the file in the machine's local code
    // page and the name arrives as mojibake — a correctness problem in a
    // document used to identify a borrower.
    const file = toCsv(clientCsvColumns(TIMEZONE), [clientRow()]);

    expect(file.startsWith('﻿')).toBe(true);
    expect(file).toContain('Nakimuli Zaïnabu');
  });
});

// ===========================================================================
describe('the collection export', () => {
  it('reports gross and effective amounts separately', () => {
    // A reversed payment is in the file with its recorded amount and an
    // effective amount of zero, so a reader can total either and know which.
    const file = toCsv(collectionCsvColumns(TIMEZONE), [
      collectionRow({
        status: 'reversed',
        isEffective: false,
        effectiveAmount: ZERO,
        principalCollected: ZERO,
        interestCollected: ZERO,
        reversalReason: 'Credited to the wrong borrower',
      }),
    ]);

    const headers = file.replace('﻿', '').split('\r\n')[0] ?? '';
    expect(headers).toContain('Amount (UGX)');
    expect(headers).toContain('Effective amount (UGX)');
    expect(file).toContain('reversed');
    expect(file).toContain('Credited to the wrong borrower');
  });

  it('carries the name recorded on the receipt', () => {
    const file = toCsv(collectionCsvColumns(TIMEZONE), [
      collectionRow({ clientName: 'Renamed Later', clientNameAtPayment: 'As Recorded' }),
    ]);

    expect(file).toContain('As Recorded');
    expect(file).not.toContain('Renamed Later');
  });

  it('splits each payment into its components', () => {
    const file = toCsv(collectionCsvColumns(TIMEZONE), [collectionRow()]);

    const headers = file.replace('﻿', '').split('\r\n')[0] ?? '';
    expect(headers).toContain('Principal (UGX)');
    expect(headers).toContain('Interest (UGX)');
    expect(headers).toContain('Penalty (UGX)');
    expect(file).toContain('3200,800,0');
  });
});

// ===========================================================================
describe('the arrears export', () => {
  it('adds the remark columns only when the caller may read notes', () => {
    const withNotes = arrearsCsvColumns(TIMEZONE, { withRemarks: true }).map(
      (column) => column.header,
    );
    const without = arrearsCsvColumns(TIMEZONE, { withRemarks: false }).map(
      (column) => column.header,
    );

    expect(withNotes).toContain('Latest note');
    expect(withNotes).toContain('Note by');
    // Not a header with blank cells: that would imply there were no notes,
    // which is a different and misleading claim.
    expect(without).not.toContain('Latest note');
    expect(without).not.toContain('Note by');
  });

  it('carries the delinquency figures a collections officer works from', () => {
    const headers = arrearsCsvColumns(TIMEZONE, { withRemarks: false }).map(
      (column) => column.header,
    );

    expect(headers).toContain('Arrears (UGX)');
    expect(headers).toContain('Due today (UGX)');
    expect(headers).toContain('Current due (UGX)');
    expect(headers).toContain('Missed collections');
    expect(headers).toContain('Days past due');
    expect(headers).toContain('Oldest missed collection');
  });

  it('keeps missed collections and days past due as separate columns', () => {
    // Three missed collections on an every-three-days loan are nine days.
    const file = toCsv(arrearsCsvColumns(TIMEZONE, { withRemarks: false }), [
      arrearsRow({ missedInstallmentCount: 3, daysPastDue: 9 }),
    ]);

    expect(file).toContain('3,9');
  });
});

// ===========================================================================
describe('the penalty export', () => {
  it('shows each charge with its own arithmetic', () => {
    const file = toCsv(penaltyCsvColumns(TIMEZONE), [penaltyRow()]);

    const headers = file.replace('﻿', '').split('\r\n')[0] ?? '';
    expect(headers).toContain('Charged on (UGX)');
    expect(headers).toContain('Rate (basis points)');
    expect(headers).toContain('Charge (UGX)');
    // 400,000 at 5,000 basis points is 200,000 — the row shows all three, so
    // anybody can check it without being told the rule.
    expect(file).toContain('400000,5000,200000');
  });
});

// ===========================================================================
describe('the client export', () => {
  it('shows contact details and position, and no identification number', () => {
    const headers = clientCsvColumns(TIMEZONE).map((column) => column.header);

    expect(headers).toContain('Client number');
    expect(headers).toContain('Phone');
    expect(headers).toContain('Outstanding (UGX)');
    expect(headers).toContain('Arrears (UGX)');
    expect(headers.join(' ').toLowerCase()).not.toContain('nin');
  });

  it('says yes or no rather than true or false', () => {
    const file = toCsv(clientCsvColumns(TIMEZONE), [
      clientRow({ hasActiveLoan: true }),
      clientRow({ clientId: 'c2', hasActiveLoan: false }),
    ]);

    expect(file).toContain(',yes,');
    expect(file).toContain(',no,');
  });
});

// ===========================================================================
describe('the download response', () => {
  it('sends a CSV as an attachment, uncached', () => {
    const response = csvResponse('a,b\r\n1,2\r\n', 'collections-2026-10-04.csv');

    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="collections-2026-10-04.csv"',
    );
    // A report is a snapshot of live figures; a cached copy would be shown as
    // current when it is not.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('tells the browser not to sniff the type', () => {
    // `attachment` plus `nosniff` is what stops a file holding user-supplied
    // text being rendered in place as something else.
    const response = csvResponse('a\r\n', 'x.csv');

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
