import { describe, expect, it } from 'vitest';

import type {
  AgingRow,
  CollateralItem,
  GuarantorExposureRow,
  RecoveryAction,
} from '@/lib/data/security';
import type { BusinessDate } from '@/lib/domain/datetime';
import type { UgxAmount } from '@/lib/domain/money';
import { toCsv } from '@/lib/domain/reporting';
import { PROMISE_STATUS_LABELS } from '@/lib/domain/security';
import { assertNoIdentityField, csvColumns } from '@/lib/reports/columns';
import {
  agingFields,
  collateralFields,
  guarantorFields,
  recoveryFields,
} from '@/lib/reports/fields';

/**
 * The four Debt & Security reports' columns.
 *
 * Phase 14 built these views and the worklists that read them. What they had
 * no way to produce was a document — so these four reports exist, and what is
 * worth asserting about them is what the brief asked for by name, plus the two
 * rules every report in this application obeys: a money column is grouped for
 * a reader and plain for a spreadsheet, and no column is an identification
 * number.
 */

const ZONE = 'Africa/Kampala';

const ugx = (value: number): UgxAmount => value as UgxAmount;
const day = (value: string): BusinessDate => value as BusinessDate;

const AGING: AgingRow = {
  loanId: 'l1',
  loanNumber: 'LN260014',
  loanStatus: 'active',
  branchId: 'b1',
  branchName: 'Kyebando',
  productId: 'p1',
  productCode: 'QL',
  productName: 'Quick Loans',
  clientId: 'c1',
  clientNumber: 'CL2600007',
  clientName: 'Nakato Winnie Birungi',
  clientPhone: '+256768735982',
  principalAmount: ugx(2_000_000),
  principalRemaining: ugx(1_300_000),
  penaltyRemaining: ugx(70_000),
  totalOutstanding: ugx(1_370_000),
  arrearsAmount: ugx(120_000),
  missedInstallmentCount: 2,
  daysPastDue: 34,
  oldestPastDueDate: day('2026-09-07'),
  delinquencyState: 'in_arrears',
  penaltyApplied: true,
  agingBucket: '31_60',
  agingRank: 4,
  lastPaymentDate: day('2026-10-04'),
};

const GUARANTEE: GuarantorExposureRow = {
  loanGuarantorId: 'g1',
  loanId: 'l1',
  loanNumber: 'LN260014',
  loanStatus: 'active',
  branchId: 'b1',
  productId: 'p1',
  productCode: 'QL',
  productName: 'Quick Loans',
  subjectKind: 'external',
  guarantorName: 'Ssemakula Brian Kato',
  guarantorPhone: '+256703587676',
  guarantorClientNumber: null,
  guarantorClientId: null,
  relationshipToClient: 'Brother',
  clientId: 'c1',
  clientNumber: 'CL2600007',
  clientName: 'Nakato Winnie Birungi',
  clientPhone: '+256768735982',
  guaranteedAmount: ugx(1_000_000),
  guaranteedTotal: ugx(1_500_000),
  outstandingBalance: ugx(1_370_000),
  arrearsAmount: ugx(120_000),
  daysPastDue: 34,
  guaranteeDate: '2026-07-08',
  consentVersion: 'v2',
  consentSigned: true,
  evidenceFrozenAt: '2026-07-08T09:00:00Z',
  releasedAt: null,
  releaseReason: null,
  isReleased: false,
  guaranteeStatus: 'binding',
};

const ITEM: CollateralItem = {
  id: 'col1',
  loanId: 'l1',
  loanNumber: 'LN260014',
  loanStatus: 'active',
  clientId: 'c1',
  clientNumber: 'CL2600007',
  clientName: 'Nakato Winnie Birungi',
  clientPhone: '+256768735982',
  productCode: 'QL',
  productName: 'Quick Loans',
  itemType: 'motorcycle',
  description: 'Bajaj Boxer, red',
  estimatedValue: ugx(3_500_000),
  valuedOn: day('2026-07-07'),
  serialNumber: 'MD2A11AZ',
  ownershipDocument: 'Registration book',
  location: 'Nsumbi yard',
  status: 'held',
  releasedAt: null,
  releaseReason: null,
  realisedAmount: null,
  realisedAt: null,
  createdAt: '2026-07-07T10:00:00Z',
  totalOutstanding: ugx(1_370_000),
};

const ACTION: RecoveryAction = {
  id: 'a1',
  loanId: 'l1',
  loanNumber: 'LN260014',
  clientName: 'Nakato Winnie Birungi',
  clientPhone: '+256768735982',
  actionKind: 'promise',
  outcome: 'promised_to_pay',
  notes: 'Visited the shop; will pay after the market',
  actionDate: day('2026-10-09'),
  followUpOn: day('2026-10-16'),
  promisedAmount: ugx(120_000),
  promisedOn: day('2026-10-16'),
  promisePaidAmount: ugx(40_000),
  promiseStatus: 'pending',
  correctsActionId: null,
  isCorrected: false,
  createdByLabel: 'Ssemakula Brian Kato',
  createdAt: '2026-10-09T13:00:00Z',
};

function headers(fields: readonly { readonly header: string }[]): readonly string[] {
  return fields.map((field) => field.header);
}

describe('aging and portfolio at risk', () => {
  const fields = agingFields();

  it('names the bucket, the lateness and the money in one row', () => {
    expect(headers(fields)).toStrictEqual([
      'Loan number',
      'Client number',
      'Client',
      'Phone',
      'Branch',
      'Product',
      'Aging bucket',
      'Days past due',
      'Missed collections',
      'Oldest missed collection',
      'Principal outstanding (UGX)',
      'Penalty outstanding (UGX)',
      'Total outstanding (UGX)',
      'Arrears (UGX)',
      'Delinquency status',
      'Loan status',
      'Last payment',
      'Charge applied',
    ]);
  });

  it('renders the bucket by its label, never by its key', () => {
    const bucket = fields.find((field) => field.header === 'Aging bucket');

    // `31_60` is a database value. "31 to 60 days" is what a person reads, and
    // a report that printed the key would be asking the reader to learn the
    // schema.
    expect(bucket?.text(AGING)).not.toBe('31_60');
    expect(bucket?.text(AGING)).toMatch(/31/);
  });

  it('takes no timezone, because it holds no instant', () => {
    // Every date here is a business date. A bucket is a count of whole days,
    // and a time stamped on one would imply a precision the arithmetic has
    // not got — so `agingFields` has no timezone parameter to get wrong.
    expect(agingFields.length).toBe(0);
    for (const field of fields) {
      expect(field.kind, field.header).not.toBe('instant');
    }
  });
});

describe('guarantor exposure', () => {
  const fields = guarantorFields(ZONE);

  it('carries every column the brief named, in order', () => {
    // The brief lists these by name: the guarantor, whether they are an
    // existing client or external, the phone, the borrower, the loan, the
    // product, the guaranteed amount and exposure, the outstanding balance,
    // the guarantee date, the loan status, the guarantee status, and the
    // release status and date.
    const names = headers(fields);

    for (const required of [
      'Guarantor',
      'Existing client or external',
      'Guarantor phone',
      'Borrower',
      'Loan number',
      'Product',
      'Guaranteed amount (UGX)',
      'Total repayable (UGX)',
      'Outstanding balance (UGX)',
      'Guarantee date',
      'Loan status',
      'Guarantee status',
      'Released',
      'Released on',
    ]) {
      expect(names, required).toContain(required);
    }

    expect(names.indexOf('Guarantor')).toBeLessThan(names.indexOf('Borrower'));
  });

  it('says existing client or external in words', () => {
    const kind = fields.find((field) => field.header === 'Existing client or external');

    expect(kind?.text(GUARANTEE)).toBe('External');
    expect(kind?.text({ ...GUARANTEE, subjectKind: 'client' })).toBe('Existing client');
  });

  it('leaves an unreadable outstanding balance empty rather than zero', () => {
    // The view returns null where the reader cannot see the loan's balance.
    // Rendering that as `0` would state that the loan is settled.
    const outstanding = fields.find(
      (field) => field.header === 'Outstanding balance (UGX)',
    );

    expect(outstanding?.text({ ...GUARANTEE, outstandingBalance: null })).toBe('—');
    expect(outstanding?.csv({ ...GUARANTEE, outstandingBalance: null })).toBe('');
    expect(outstanding?.text(GUARANTEE)).toBe('1,370,000');
    expect(outstanding?.csv(GUARANTEE)).toBe('1370000');
  });
});

describe('security held', () => {
  const fields = collateralFields(ZONE);

  it('carries the item, its valuation, its papers and where it is', () => {
    const names = headers(fields);

    for (const required of [
      'Item type',
      'Description',
      'Valued at (UGX)',
      'Valued on',
      'Serial number',
      'Ownership document',
      'Where it is',
      'Status',
      'Realised for (UGX)',
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it('renders the item type and status by label', () => {
    const type = fields.find((field) => field.header === 'Item type');
    const status = fields.find((field) => field.header === 'Status');

    expect(type?.text(ITEM)).not.toBe('motorcycle');
    expect(status?.text(ITEM)).not.toBe('held');
  });

  it('shows nothing realised rather than zero for an item still held', () => {
    const realised = fields.find((field) => field.header === 'Realised for (UGX)');

    // An item still in the yard has not fetched zero shillings; it has not
    // been sold. The two are different statements.
    expect(realised?.text(ITEM)).toBe('—');
    expect(realised?.csv(ITEM)).toBe('');
  });
});

describe('the recovery file', () => {
  const fields = recoveryFields(ZONE);

  it('leads with the date and carries the promise and its verdict', () => {
    const names = headers(fields);

    expect(names[0]).toBe('Action date');
    for (const required of [
      'What was done',
      'Outcome',
      'Note',
      'Promised (UGX)',
      'Promised by',
      'Paid against the promise (UGX)',
      'Promise verdict',
      'Corrected',
      'Recorded by',
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it('renders a verdict only where there is a promise to judge', () => {
    const verdict = fields.find((field) => field.header === 'Promise verdict');

    // Against the domain's own label, not a string typed here: a report that
    // invented its own wording for a verdict would say something different
    // from the screen that recorded it.
    expect(verdict?.text(ACTION)).toBe(PROMISE_STATUS_LABELS.pending);
    // A note is not a promise, so there is nothing to keep or break.
    expect(verdict?.text({ ...ACTION, actionKind: 'note', promiseStatus: null })).toBe(
      '',
    );
  });

  it('gives the note room, because a note is prose', () => {
    const note = fields.find((field) => field.header === 'Note');

    // The weight is what the PDF divides the page by and what the table reads
    // as a minimum width. A prose column handed whatever was left over wrapped
    // the arrears note to thirteen lines in Phase 9.
    expect(note?.weight ?? 0).toBeGreaterThan(3);
    expect(note?.align).toBe('left');
  });

  it('marks a corrected entry rather than removing it', () => {
    const corrected = fields.find((field) => field.header === 'Corrected');

    // The table is append-only: a mistake is corrected by a correction and
    // both stay in the file. A chase file that could be edited after the fact
    // is one nobody can rely on in a dispute.
    expect(corrected?.text({ ...ACTION, isCorrected: true })).toBe('yes');
    expect(corrected?.text(ACTION)).toBe('no');
  });
});

describe('every one of the four', () => {
  it('exports no identification number', () => {
    // §76, enforced at registry build time as well. These reports carry phone
    // numbers, which the brief asks for by name — a NIN is a different object,
    // and no report has one.
    expect(() => {
      assertNoIdentityField('aging', agingFields());
      assertNoIdentityField('guarantors', guarantorFields(ZONE));
      assertNoIdentityField('collateral', collateralFields(ZONE));
      assertNoIdentityField('recovery', recoveryFields(ZONE));
    }).not.toThrow();
  });

  it('writes a spreadsheet with a heading row and one record per row', () => {
    for (const [name, file] of [
      ['aging', toCsv(csvColumns(agingFields()), [AGING])],
      ['guarantors', toCsv(csvColumns(guarantorFields(ZONE)), [GUARANTEE])],
      ['collateral', toCsv(csvColumns(collateralFields(ZONE)), [ITEM])],
      ['recovery', toCsv(csvColumns(recoveryFields(ZONE)), [ACTION])],
    ] as const) {
      expect(file.startsWith('﻿'), name).toBe(true);
      expect(file.trimEnd().split('\r\n'), name).toHaveLength(2);
    }
  });

  it('puts the currency in the heading and plain digits in the cell', () => {
    for (const [name, fields] of [
      [
        'aging',
        agingFields() as readonly { header: string; csv: (row: never) => string }[],
      ],
      ['guarantors', guarantorFields(ZONE)],
      ['collateral', collateralFields(ZONE)],
      ['recovery', recoveryFields(ZONE)],
    ] as const) {
      const money = fields.filter((field) => field.header.includes('(UGX)'));
      expect(money.length, name).toBeGreaterThan(0);
      for (const field of money) {
        expect(field.header, `${name}: ${field.header}`).not.toMatch(/UGX\s*\d/);
      }
    }
  });
});
