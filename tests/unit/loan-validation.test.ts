import { describe, expect, it } from 'vitest';

import {
  LOAN_STATUSES,
  LOAN_TRANSITIONS,
  canTransition,
  capabilityForTransition,
  describeLoanApprovalFailure,
  isLoanApprovalFailure,
  isLoanStatus,
  isOutstanding,
  permittedTermMonths,
  termsAreEditable,
} from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import {
  cancelLoanSchema,
  createLoanSchema,
  loanPrincipalSchema,
  loanTermSchema,
  proposedDisbursementDateSchema,
  returnLoanSchema,
  updateLoanDraftSchema,
} from '@/lib/validation/loan';

const VALID_LOAN = {
  clientId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  principalAmount: '600000',
  loanTermMonths: '3',
  repaymentFrequency: 'daily',
  proposedDisbursementDate: '2026-10-15',
  notes: '',
};

describe('the loan principal', () => {
  it('accepts a whole number of shillings', () => {
    const parsed = loanPrincipalSchema.safeParse('600000');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(600_000);
  });

  it('accepts the way people actually write amounts', () => {
    // Commas and spaces are formatting, not data.
    for (const input of ['600,000', '600 000', ' 600000 ']) {
      const parsed = loanPrincipalSchema.safeParse(input);
      expect(parsed.success, input).toBe(true);
      if (parsed.success) expect(parsed.data).toBe(600_000);
    }
  });

  it('rejects a fractional amount rather than rounding it', () => {
    // Somebody typing 100000.50 has either mistyped or is thinking in another
    // currency. Quietly making it 100,001 would hide which.
    for (const input of ['100000.50', '100000.5']) {
      expect(loanPrincipalSchema.safeParse(input).success, input).toBe(false);
    }
  });

  it('rejects a decimal comma instead of inflating the amount', () => {
    // The bug this test exists for: stripping every comma turned
    // `100000,50` into 10,000,050 shillings — a hundredfold error on the most
    // important number in the system, accepted silently.
    for (const input of ['100000,50', '600,00', '6,0000', '1,2,3']) {
      expect(loanPrincipalSchema.safeParse(input).success, input).toBe(false);
    }
  });

  it('still accepts a genuine thousands separator', () => {
    for (const [input, expected] of [
      ['600,000', 600_000],
      ['1,000,000', 1_000_000],
      ['100,000', 100_000],
      ['999', 999],
    ] as const) {
      const parsed = loanPrincipalSchema.safeParse(input);
      expect(parsed.success, input).toBe(true);
      if (parsed.success) expect(parsed.data, input).toBe(expected);
    }
  });

  it.each([
    ['zero', '0'],
    ['negative', '-100000'],
    ['empty', ''],
    ['whitespace', '   '],
    ['letters', 'one hundred thousand'],
    ['a currency symbol', 'UGX 100000'],
    ['scientific notation', '1e6'],
    ['a hex literal', '0x186a0'],
  ])('rejects %s', (_label, input) => {
    expect(loanPrincipalSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an implausibly large amount', () => {
    expect(loanPrincipalSchema.safeParse('9'.repeat(30)).success).toBe(false);
  });
});

describe('the loan term', () => {
  it('accepts a whole number of months', () => {
    const parsed = loanTermSchema.safeParse('3');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(3);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(loanTermSchema.safeParse(input).success).toBe(false);
  });

  it('rejects a term beyond what the engine supports', () => {
    expect(loanTermSchema.safeParse('121').success).toBe(false);
  });
});

describe('the intended disbursement date', () => {
  it('accepts a real date', () => {
    expect(proposedDisbursementDateSchema.safeParse('2026-10-15').success).toBe(true);
  });

  it('accepts a past date, because a loan can be recorded late', () => {
    expect(proposedDisbursementDateSchema.safeParse('2026-01-01').success).toBe(true);
  });

  it.each([
    ['30 February', '2026-02-30'],
    ['31 April', '2026-04-31'],
    ['month 13', '2026-13-01'],
    ['day zero', '2026-01-00'],
  ])('rejects %s rather than rolling it over', (_label, input) => {
    // `Date.parse` would accept these and silently move them to another day.
    expect(proposedDisbursementDateSchema.safeParse(input).success, input).toBe(false);
  });

  it('accepts 29 February in a leap year', () => {
    expect(proposedDisbursementDateSchema.safeParse('2028-02-29').success).toBe(true);
  });

  it('rejects a mistyped year', () => {
    expect(proposedDisbursementDateSchema.safeParse('0226-10-15').success).toBe(false);
  });
});

describe('starting a loan', () => {
  it('accepts a complete submission', () => {
    expect(createLoanSchema.safeParse(VALID_LOAN).success).toBe(true);
  });

  it.each([
    'clientId',
    'principalAmount',
    'loanTermMonths',
    'repaymentFrequency',
    'proposedDisbursementDate',
  ])('requires %s', (field) => {
    const parsed = createLoanSchema.safeParse({ ...VALID_LOAN, [field]: '' });
    expect(parsed.success, field).toBe(false);
  });

  it('treats notes as optional', () => {
    const parsed = createLoanSchema.safeParse({ ...VALID_LOAN, notes: '' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.notes).toBeNull();
  });

  it('accepts no total of any kind', () => {
    // There is no field for a total in any schema. A schema that accepted one
    // would imply the browser's arithmetic mattered; the database computes
    // every figure at approval.
    const parsed = createLoanSchema.safeParse({
      ...VALID_LOAN,
      totalInterest: '1',
      totalExpectedRepayment: '1',
      interestRateBps: '0',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      for (const field of [
        'totalInterest',
        'totalExpectedRepayment',
        'interestRateBps',
      ]) {
        expect(field in parsed.data, field).toBe(false);
      }
    }
  });

  it('carries no status or attribution field', () => {
    const parsed = updateLoanDraftSchema.safeParse({
      ...VALID_LOAN,
      loanId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      status: 'approved',
      approvedBy: '0f8fad5b-d9cb-469f-a165-70867728950e',
      approvedAt: '2026-01-01T00:00:00Z',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      for (const field of ['status', 'approvedBy', 'approvedAt']) {
        expect(field in parsed.data, field).toBe(false);
      }
    }
  });
});

describe('cancelling and returning', () => {
  const loanId = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('requires a real reason to cancel', () => {
    for (const reason of ['', '   ', 'no']) {
      expect(
        cancelLoanSchema.safeParse({ loanId, reason }).success,
        JSON.stringify(reason),
      ).toBe(false);
    }
  });

  it('accepts a reason', () => {
    expect(
      cancelLoanSchema.safeParse({
        loanId,
        reason: 'The client withdrew the application.',
      }).success,
    ).toBe(true);
  });

  it('requires a note when returning a draft', () => {
    expect(returnLoanSchema.safeParse({ loanId, reviewNote: '' }).success).toBe(false);
    expect(
      returnLoanSchema.safeParse({ loanId, reviewNote: 'The amount is wrong.' }).success,
    ).toBe(true);
  });
});

describe('the loan status model', () => {
  it('declares exactly the six lifecycle states', () => {
    expect([...LOAN_STATUSES]).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'active',
      'cleared',
      'cancelled',
    ]);
  });

  it('declares no status nothing can set', () => {
    // `in_arrears`, `grace_period` and `overdue` belong to later phases. A
    // status nothing can set and nothing can read is a false promise about
    // what the system knows.
    for (const absent of ['in_arrears', 'grace_period', 'overdue', 'defaulted']) {
      expect(isLoanStatus(absent), absent).toBe(false);
    }
  });

  it('permits exactly the intended transitions', () => {
    expect(LOAN_TRANSITIONS).toEqual({
      draft: ['pending_approval', 'cancelled'],
      pending_approval: ['draft', 'approved', 'cancelled'],
      approved: ['active', 'cancelled'],
      active: ['cleared'],
      cleared: [],
      cancelled: [],
    });
  });

  it('makes cancelled and cleared terminal', () => {
    // A cancelled loan was never agreed; reviving one would make a loan
    // nobody approved become active.
    for (const to of LOAN_STATUSES) {
      expect(canTransition('cancelled', to), `cancelled -> ${to}`).toBe(false);
      expect(canTransition('cleared', to), `cleared -> ${to}`).toBe(false);
    }
  });

  it('refuses a draft jumping past approval', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'active')).toBe(false);
    expect(canTransition('pending_approval', 'active')).toBe(false);
  });

  it('names the capability each transition requires', () => {
    expect(capabilityForTransition('draft', 'pending_approval')).toBe('loans:submit');
    expect(capabilityForTransition('pending_approval', 'approved')).toBe('loans:approve');
    // Returning a draft is a decision about the loan, made by the person who
    // would otherwise have approved it.
    expect(capabilityForTransition('pending_approval', 'draft')).toBe('loans:approve');
    expect(capabilityForTransition('approved', 'active')).toBe('loans:disburse');
    expect(capabilityForTransition('draft', 'cancelled')).toBe('loans:cancel');
  });

  it('names no capability for an impossible transition', () => {
    expect(capabilityForTransition('draft', 'active')).toBeNull();
    expect(capabilityForTransition('cancelled', 'draft')).toBeNull();
  });

  it('makes terms editable only in draft', () => {
    expect(termsAreEditable('draft')).toBe(true);

    for (const status of [
      'pending_approval',
      'approved',
      'active',
      'cleared',
      'cancelled',
    ] as const) {
      expect(termsAreEditable(status), status).toBe(false);
    }
  });

  it('treats only an active loan as outstanding', () => {
    expect(isOutstanding('active')).toBe(true);
    for (const status of ['draft', 'approved', 'cleared', 'cancelled'] as const) {
      expect(isOutstanding(status), status).toBe(false);
    }
  });
});

describe('permitted terms by amount', () => {
  const SETTINGS = {
    minTermMonths: 1,
    maxTermMonths: 3,
    multiMonthMinAmount: 200_000,
  };

  it('offers one month below the threshold', () => {
    // The confirmed rule: a longer period becomes *available* at or above the
    // threshold, not automatic.
    expect(permittedTermMonths(toUgx(100_000), SETTINGS)).toEqual([1]);
    expect(permittedTermMonths(toUgx(199_999), SETTINGS)).toEqual([1]);
  });

  it('offers the full range at the threshold', () => {
    expect(permittedTermMonths(toUgx(200_000), SETTINGS)).toEqual([1, 2, 3]);
  });

  it('offers the full range above it', () => {
    expect(permittedTermMonths(toUgx(600_000), SETTINGS)).toEqual([1, 2, 3]);
  });

  it('does not force a longer term on a larger loan', () => {
    // One month stays available at every amount: the threshold gates the
    // choice, it does not make it.
    expect(permittedTermMonths(toUgx(5_000_000), SETTINGS)).toContain(1);
  });

  it('always offers at least one month, whatever the settings say', () => {
    // A misconfigured threshold must not leave a form with no options.
    expect(
      permittedTermMonths(toUgx(100_000), {
        minTermMonths: 5,
        maxTermMonths: 3,
        multiMonthMinAmount: 1,
      }),
    ).toEqual([1]);
  });
});

describe('approval failure messages', () => {
  it('recognises every code the database can return', () => {
    for (const code of [
      'loan_not_found',
      'client_not_active',
      'active_loan_exists',
      'below_minimum',
      'above_maximum',
      'term_not_permitted',
      'term_requires_higher_amount',
      'frequency_not_permitted',
      'insufficient_guarantors',
      'guarantor_incomplete',
    ]) {
      expect(isLoanApprovalFailure(code), code).toBe(true);
    }

    expect(isLoanApprovalFailure('something_else')).toBe(false);
  });

  it('says what is needed, not only that something is wrong', () => {
    // A staff member told "below the minimum" has to go and look it up; one
    // told the figure does not.
    expect(describeLoanApprovalFailure('below_minimum', '100000')).toMatch(/UGX 100,000/);
    expect(describeLoanApprovalFailure('term_requires_higher_amount', '200000')).toMatch(
      /UGX 200,000/,
    );
    expect(describeLoanApprovalFailure('insufficient_guarantors', '2')).toMatch(/2/);
  });

  it('copes with a missing detail', () => {
    for (const code of [
      'below_minimum',
      'above_maximum',
      'term_not_permitted',
      'insufficient_guarantors',
      'client_not_active',
    ] as const) {
      const message = describeLoanApprovalFailure(code, null);
      expect(message.length, code).toBeGreaterThan(10);
      expect(message, code).not.toContain('null');
      expect(message, code).not.toContain('undefined');
    }
  });

  it('names the client status when that is the problem', () => {
    expect(describeLoanApprovalFailure('client_not_active', 'blacklisted')).toMatch(
      /blacklisted/,
    );
  });

  it('exposes no SQL or internal detail', () => {
    for (const code of [
      'loan_not_found',
      'settings_unavailable',
      'client_not_found',
      'client_not_active',
      'active_loan_exists',
      'below_minimum',
      'above_maximum',
      'term_not_permitted',
      'term_requires_higher_amount',
      'frequency_not_permitted',
      'insufficient_guarantors',
      'guarantor_incomplete',
    ] as const) {
      const message = describeLoanApprovalFailure(code, '1');
      expect(message, code).not.toMatch(
        /\bselect\b|\bconstraint\b|pg_|\brelation\b|P0001|violates/i,
      );
    }
  });
});
