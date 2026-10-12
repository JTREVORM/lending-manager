import { describe, expect, it } from 'vitest';

import type { ClientReportRow, CollectionRow, PortfolioRow } from '@/lib/data/reports';
import type { UgxAmount } from '@/lib/domain/money';
import type { BusinessDate } from '@/lib/domain/datetime';
import { toCsv } from '@/lib/domain/reporting';
import {
  assertNoIdentityField,
  csvColumns,
  textField,
  type ReportField,
} from '@/lib/reports/columns';
import {
  arrearsFields,
  clientFields,
  collectionFields,
  penaltyFields,
  portfolioFields,
  trialBalanceFields,
} from '@/lib/reports/fields';

/**
 * What every report's download looks like.
 *
 * A refactor that changes a download's shape is not a refactor — it is a
 * silent change to a file somebody has a saved formula against. These field
 * sets replaced five separate CSV column builders, and the headings below were
 * captured from those builders before they went, so the replacement provably
 * changed nothing. They stay written out in full because that is what makes
 * the next change visible.
 */

const ZONE = 'Africa/Kampala';

function ugx(value: number): UgxAmount {
  return value as UgxAmount;
}

function day(value: string): BusinessDate {
  return value as BusinessDate;
}

/**
 * Rows chosen to exercise the cases that distinguish the two renderings: a
 * formula-looking name, a null in every nullable column, a value with a comma
 * in it, and an amount large enough to be grouped.
 */
const COLLECTIONS: readonly CollectionRow[] = [
  {
    paymentId: 'p1',
    paymentNumber: 'RC2600001',
    businessDate: day('2026-10-11'),
    receivedAt: '2026-10-11T07:30:00Z',
    loanId: 'l1',
    loanNumber: 'LN260014',
    clientId: 'c1',
    clientNumber: 'CL2600007',
    clientName: 'Nakimuli Zaïnabu',
    clientNameAtPayment: 'Nakimuli Zaïnabu',
    amount: ugx(1_250_000),
    effectiveAmount: ugx(1_250_000),
    paymentMethod: 'cash',
    status: 'posted',
    isEffective: true,
    recordedBy: 'u1',
    recordedByLabel: 'AKELLO MARY',
    externalReference: 'MM-884,221',
    reversalReason: null,
    principalCollected: ugx(1_000_000),
    interestCollected: ugx(200_000),
    penaltyCollected: ugx(50_000),
  },
  {
    paymentId: 'p2',
    paymentNumber: 'RC2600002',
    businessDate: day('2026-10-11'),
    receivedAt: '2026-10-11T16:05:00Z',
    loanId: 'l2',
    loanNumber: null,
    clientId: 'c2',
    clientNumber: null,
    clientName: null,
    // A name that a spreadsheet would otherwise evaluate.
    clientNameAtPayment: '=Mukasa',
    amount: ugx(40_000),
    effectiveAmount: ugx(0),
    paymentMethod: 'mtn_mobile_money',
    status: 'reversed',
    isEffective: false,
    recordedBy: 'u2',
    recordedByLabel: 'Ssemakula Brian Kato',
    externalReference: null,
    reversalReason: 'Posted to the wrong loan, and "corrected"',
    principalCollected: ugx(0),
    interestCollected: ugx(0),
    penaltyCollected: ugx(0),
  },
];

const PORTFOLIO_BASE: PortfolioRow = {
  loanId: 'l1',
  loanNumber: 'LN260014',
  clientId: 'c1',
  clientNumber: 'CL2600007',
  clientName: 'Nakato Winnie Birungi',
  clientPhone: '+256768735982',
  clientNameAtOrigination: 'Nakato Winnie Birungi',
  clientPhoneAtOrigination: '+256768735982',
  loanStatus: 'active',
  principalAmount: ugx(2_000_000),
  interestRateBps: 1_500,
  loanTermMonths: 3,
  repaymentFrequency: 'weekly',
  contractualInterest: ugx(300_000),
  totalExpectedRepayment: ugx(2_300_000),
  gracePeriodDays: 7,
  penaltyRateBps: 500,
  disbursedAt: '2026-07-08T09:00:00Z',
  clearedAt: null,
  cancelledAt: null,
  scheduledTotal: ugx(2_300_000),
  totalPaid: ugx(900_000),
  principalPaid: ugx(700_000),
  interestPaid: ugx(200_000),
  contractualOutstanding: ugx(1_400_000),
  penaltyAssessed: ugx(70_000),
  penaltyPaid: ugx(0),
  penaltyRemaining: ugx(70_000),
  totalOutstanding: ugx(1_470_000),
  totalCollected: ugx(900_000),
  postedPaymentCount: 9,
  reversedPaymentCount: 0,
  lastPaymentAt: '2026-10-04T08:00:00Z',
  scheduledCompletionDate: day('2026-10-07'),
  installmentCount: 13,
  firstDueDate: day('2026-07-15'),
  arrearsAmount: ugx(120_000),
  dueTodayAmount: ugx(0),
  currentDue: ugx(120_000),
  missedInstallmentCount: 2,
  daysPastDue: 34,
  oldestUnpaidDueDate: day('2026-09-07'),
  oldestPastDueDate: day('2026-09-07'),
  graceEndDate: day('2026-10-14'),
  penaltyEffectiveDate: day('2026-10-15'),
  withinGracePeriod: true,
  penaltyApplied: true,
  penaltyEligible: true,
  penaltyProjectedAmount: ugx(70_000),
  state: 'in_arrears',
};

const PORTFOLIO: readonly PortfolioRow[] = [
  PORTFOLIO_BASE,
  {
    ...PORTFOLIO_BASE,
    loanId: 'l2',
    loanNumber: 'LN260015',
    clientNumber: null,
    clientName: null,
    clientPhone: null,
    loanStatus: 'cleared',
    clearedAt: '2026-09-30T10:00:00Z',
    disbursedAt: null,
    scheduledCompletionDate: null,
    graceEndDate: null,
    oldestPastDueDate: null,
    state: null,
  },
];

const CLIENTS: readonly ClientReportRow[] = [
  {
    clientId: 'c1',
    clientNumber: 'CL2600007',
    fullName: 'Nakimuli Zaïnabu',
    phone: '+256703587676',
    district: 'Kampala',
    villageArea: 'Nsumbi, Kyebando',
    occupation: 'Trader',
    status: 'active',
    registeredAt: '2026-06-01T08:00:00Z',
    hasActiveLoan: true,
    loanCount: 2,
    totalOutstanding: ugx(1_470_000),
    arrearsAmount: ugx(120_000),
    state: 'in_arrears',
  },
  {
    clientId: 'c2',
    clientNumber: 'CL2600008',
    fullName: 'Mukasa Joseph',
    phone: '+256768735982',
    district: null,
    villageArea: null,
    occupation: null,
    status: 'blacklisted',
    registeredAt: '2026-06-02T08:00:00Z',
    hasActiveLoan: false,
    loanCount: 0,
    totalOutstanding: ugx(0),
    arrearsAmount: ugx(0),
    state: null,
  },
];

/**
 * The heading row of every file this application produces.
 *
 * Written out in full rather than derived, because that is the point: a
 * heading row is the contract a spreadsheet on somebody's machine is written
 * against, and a refactor that reorders or renames a column silently breaks
 * every saved formula pointing at it. These strings were captured from the
 * five `*CsvColumns` builders the field sets replaced, so the replacement
 * provably changed nothing — and nothing can change one later without this
 * test saying which.
 */
const EXPECTED_HEADERS: Readonly<Record<string, string>> = {
  collections:
    'Payment number,Business date,Received,Client number,Client,Loan number,' +
    'Amount (UGX),Effective amount (UGX),Method,Status,Recorded by,Reference,' +
    'Reversal reason,Principal (UGX),Interest (UGX),Penalty (UGX)',
  loans:
    'Loan number,Client number,Client,Phone,Loan status,Delinquency status,' +
    'Principal (UGX),Interest (UGX),Penalty charged (UGX),Total expected (UGX),' +
    'Collected (UGX),Contract outstanding (UGX),Penalty outstanding (UGX),' +
    'Total outstanding (UGX),Arrears (UGX),Missed collections,Days past due,' +
    'Disbursed,Completion date,Grace ends,Cleared',
  'arrears-with-remarks':
    'Loan number,Client number,Client,Phone,Loan status,Delinquency status,' +
    'Principal (UGX),Interest (UGX),Penalty charged (UGX),Total expected (UGX),' +
    'Collected (UGX),Contract outstanding (UGX),Penalty outstanding (UGX),' +
    'Total outstanding (UGX),Arrears (UGX),Missed collections,Days past due,' +
    'Disbursed,Completion date,Grace ends,Cleared,Due today (UGX),' +
    'Current due (UGX),Oldest missed collection,Latest note,Note by,Note recorded',
  penalties:
    'Loan number,Client number,Client,Final collection date,Grace days,' +
    'Grace ended,Charge effective,Charged on (UGX),Rate (basis points),' +
    'Charge (UGX),Paid (UGX),Remaining (UGX),Recorded',
  clients:
    'Client number,Name,Phone,District,Village or area,Occupation,Status,' +
    'Has active loan,Loans,Outstanding (UGX),Arrears (UGX),Delinquency status,' +
    'Registered',
  // Phase 18. Both pairs of money columns, because movement and net balance
  // are different questions: an account with a million debited and a million
  // credited has moved two million and holds nothing.
  'trial-balance':
    'Code,Account,Type,Debits (UGX),Credits (UGX),Debit balance (UGX),' +
    'Credit balance (UGX)',
};

function headerRow<Row>(fields: readonly ReportField<Row>[]): string {
  return csvColumns(fields)
    .map((column) => column.header)
    .join(',');
}

describe('the heading row each report writes', () => {
  it('collections', () => {
    expect(headerRow(collectionFields(ZONE))).toBe(EXPECTED_HEADERS.collections);
  });

  it('loan portfolio', () => {
    expect(headerRow(portfolioFields(ZONE))).toBe(EXPECTED_HEADERS.loans);
  });

  it('arrears, with remarks', () => {
    expect(headerRow(arrearsFields(ZONE, { withRemarks: true }))).toBe(
      EXPECTED_HEADERS['arrears-with-remarks'],
    );
  });

  it('arrears, without remarks, is the portfolio set plus three', () => {
    // A caller who may not read remarks gets a narrower file, not a wider one
    // with empty cells — which would imply there were no notes.
    const plain = headerRow(arrearsFields(ZONE, { withRemarks: false }));

    expect(plain).toBe(
      `${EXPECTED_HEADERS.loans ?? ''},Due today (UGX),Current due (UGX),Oldest missed collection`,
    );
    expect(plain).not.toContain('Latest note');
  });

  it('late-payment charges', () => {
    expect(headerRow(penaltyFields(ZONE))).toBe(EXPECTED_HEADERS.penalties);
  });

  it('clients', () => {
    expect(headerRow(clientFields(ZONE))).toBe(EXPECTED_HEADERS.clients);
  });

  it('trial balance', () => {
    expect(headerRow(trialBalanceFields())).toBe(EXPECTED_HEADERS['trial-balance']);
  });

  it('trial balance exports no identification number', () => {
    // The same refusal every report is held to. §76.
    expect(() => {
      assertNoIdentityField('trial-balance', trialBalanceFields());
    }).not.toThrow();
  });

  it('trial balance takes no timezone, because it has no instant in it', () => {
    // Every other field set is a function of the business timezone. This one
    // holds no date and no timestamp at all: a trial balance is a position,
    // and the only date on the page is the day it was run, which the page
    // supplies.
    expect(trialBalanceFields).toHaveLength(0);
  });
});

describe('the whole file, not just its heading', () => {
  it('is a byte-order mark, CRLF endings and one record per row', () => {
    const file = toCsv(csvColumns(collectionFields(ZONE)), COLLECTIONS);

    // The BOM is what makes a spreadsheet open the file as UTF-8 rather than
    // as the machine's code page — without it Nakimuli Zaïnabu is mojibake,
    // which is a correctness problem in a document used to identify a person.
    expect(file.startsWith('\ufeff')).toBe(true);
    expect(file.endsWith('\r\n')).toBe(true);
    // Heading plus two rows, and the free text holding a comma, a quote pair
    // and a newline has not split a record in two.
    expect(file.trimEnd().split('\r\n')).toHaveLength(3);
  });

  it('keeps a comma and a quote inside one field', () => {
    const file = toCsv(csvColumns(collectionFields(ZONE)), COLLECTIONS);

    expect(file).toContain('"MM-884,221"');
    expect(file).toContain('"Posted to the wrong loan, and ""corrected"""');
  });
});

describe('the two renderings differ where they should', () => {
  it('groups money for a reader and leaves it plain for a spreadsheet', () => {
    const amount = collectionFields(ZONE).find(
      (field) => field.header === 'Amount (UGX)',
    );

    expect(amount).toBeDefined();
    // The screen and the PDF are for reading.
    expect(amount?.text(COLLECTIONS[0]!)).toBe('1,250,000');
    // The file is for totalling. A separator here is a parse failure waiting
    // for a spreadsheet with different locale settings.
    expect(amount?.csv(COLLECTIONS[0]!)).toBe('1250000');
  });

  it('disarms a formula for a spreadsheet and leaves the name alone for a reader', () => {
    const client = collectionFields(ZONE).find((field) => field.header === 'Client');

    expect(client).toBeDefined();
    // Nothing is stripped: a borrower genuinely called `=Mukasa` is called
    // that in both renderings. Only the spreadsheet's copy is neutralised,
    // because only a spreadsheet has a formula engine to defend against.
    expect(client?.text(COLLECTIONS[1]!)).toBe('=Mukasa');
    expect(client?.csv(COLLECTIONS[1]!)).toBe("'=Mukasa");
  });

  it('distinguishes nothing recorded from zero, for a reader', () => {
    const outstanding = clientFields(ZONE).find(
      (field) => field.header === 'Outstanding (UGX)',
    );

    // A real zero is a zero.
    expect(outstanding?.text(CLIENTS[1]!)).toBe('0');

    const missing = clientFields(ZONE).find((field) => field.header === 'District');
    // And nothing recorded is empty rather than a word.
    expect(missing?.text(CLIENTS[1]!)).toBe('');
  });

  it('leaves a null instant empty rather than inventing a date', () => {
    const disbursed = portfolioFields(ZONE).find((field) => field.header === 'Disbursed');
    const phone = portfolioFields(ZONE).find((field) => field.header === 'Phone');

    // The second fixture row is a cleared loan with no disbursement instant
    // and no phone on file. Both are genuinely absent, and a formatter that
    // rendered the epoch or the word "null" would be stating something false.
    expect(disbursed?.text(PORTFOLIO[1]!)).toBe('');
    expect(disbursed?.csv(PORTFOLIO[1]!)).toBe('');
    expect(phone?.text(PORTFOLIO[1]!)).toBe('');

    // And a real instant is rendered in the business timezone, never the
    // server's: 09:00 UTC is noon in Kampala.
    expect(disbursed?.text(PORTFOLIO[0]!)).toContain('12:00');
  });

  it('right-aligns figures and left-aligns everything else', () => {
    for (const field of portfolioFields(ZONE)) {
      const expected =
        field.kind === 'money' || field.kind === 'count' || field.kind === 'percent'
          ? 'right'
          : 'left';
      expect(field.align, field.header).toBe(expected);
    }
  });
});

describe('no report exports an identification number', () => {
  it('passes every field set this application ships', () => {
    // §76. The client report is the one that could plausibly carry a NIN —
    // the column exists on the table — so its absence is the assertion.
    expect(clientFields(ZONE).some((field) => /nin|national/i.test(field.header))).toBe(
      false,
    );

    // Each in its own statement: a tuple array would collapse the five row
    // types into a union and `assertNoIdentityField` would have nothing to
    // check against.
    expect(() => {
      assertNoIdentityField('collections', collectionFields(ZONE));
      assertNoIdentityField('loans', portfolioFields(ZONE));
      assertNoIdentityField('arrears', arrearsFields(ZONE, { withRemarks: true }));
      assertNoIdentityField('penalties', penaltyFields(ZONE));
      assertNoIdentityField('clients', clientFields(ZONE));
    }).not.toThrow();
  });

  it('refuses a field set that declares one', () => {
    // The guard is what makes "no report exports one" a property of the
    // system rather than a habit of whoever wrote the last report.
    expect(() => {
      assertNoIdentityField('invented', [
        textField<{ nin: string }>('NIN', (row) => row.nin),
      ]);
    }).toThrow(/identification number/i);

    for (const heading of ['National ID', 'Identification number', 'Passport number']) {
      expect(() => {
        assertNoIdentityField('invented', [textField<object>(heading, () => '')]);
      }, heading).toThrow(/§76/);
    }
  });
});
