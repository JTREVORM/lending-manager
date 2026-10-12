/**
 * Payment input validation.
 *
 * The decimal-comma case is the one that matters most here, and it is the
 * reason the parser is shared with the loan principal rather than copied: a
 * payment of `4000,50` becoming UGX 400,050 would credit a borrower forty
 * times what they handed over, and a second implementation of that rule would
 * eventually disagree with the first.
 */

import { describe, expect, it } from 'vitest';

import {
  externalReferenceSchema,
  paymentAmountSchema,
  paymentMethodSchema,
  paymentSearchSchema,
  recordPaymentSchema,
  reversePaymentSchema,
} from '@/lib/validation/payment';
import { loanPrincipalSchema } from '@/lib/validation/loan';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('the payment amount parser', () => {
  it.each([
    ['4000', 4_000],
    ['4,000', 4_000],
    ['11,500', 11_500],
    ['115,000', 115_000],
    ['1,000,000', 1_000_000],
    ['  4000  ', 4_000],
    ['4 000', 4_000],
    [4_000, 4_000],
  ])('accepts %s as %i', (input, expected) => {
    const result = paymentAmountSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(expected);
  });

  it('rejects a decimal comma rather than treating it as a separator', () => {
    // The hundredfold error this rule exists to prevent. `4000,50` is four
    // thousand and fifty cents in much of the world; stripping the comma
    // would make it UGX 400,050.
    for (const input of ['4000,50', '11500,25', '1,5', '12,34', '100000,50']) {
      const result = paymentAmountSchema.safeParse(input);
      expect(result.success, input).toBe(false);
    }
  });

  it('rejects a decimal point', () => {
    // Ugandan shillings have no smaller unit, so a fractional amount is a
    // mistyping or a different currency — rejected rather than rounded, so
    // which one is visible.
    for (const input of ['4000.50', '4000.00', '0.5', '11500.99']) {
      const result = paymentAmountSchema.safeParse(input);
      expect(result.success, input).toBe(false);
    }
  });

  it.each(['', '   ', 'abc', '4e3', '4,00', '4,0000', ',400', '400,', '-4000', '0'])(
    'rejects %s',
    (input) => {
      expect(paymentAmountSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects scientific notation', () => {
    for (const input of ['1e5', '1E5', '4e+3']) {
      expect(paymentAmountSchema.safeParse(input).success, input).toBe(false);
    }
  });

  it('rejects an implausibly large amount', () => {
    expect(paymentAmountSchema.safeParse('9999999999999999').success).toBe(false);
  });

  it('applies exactly the same rules as the loan principal parser', () => {
    // The point of sharing the parser. If these ever diverged, one of the two
    // most important numbers in the system would be held to a weaker standard.
    const CASES = [
      '4000',
      '4,000',
      '4000,50',
      '4000.50',
      '1,5',
      '4 000',
      '',
      'abc',
      '0',
      '-1',
      '1e5',
      '1,000,000',
    ];

    for (const input of CASES) {
      const payment = paymentAmountSchema.safeParse(input);
      const principal = loanPrincipalSchema.safeParse(input);

      expect(payment.success, `acceptance of ${JSON.stringify(input)}`).toBe(
        principal.success,
      );

      if (payment.success && principal.success) {
        expect(payment.data, `value of ${JSON.stringify(input)}`).toBe(principal.data);
      }
    }
  });
});

describe('the payment method', () => {
  it.each(['cash', 'mtn_mobile_money', 'airtel_money'])('accepts %s', (method) => {
    expect(paymentMethodSchema.safeParse(method).success).toBe(true);
  });

  it.each(['Cash', 'MTN', 'momo', 'bank_transfer', '', 'CASH'])(
    'rejects %s',
    (method) => {
      expect(paymentMethodSchema.safeParse(method).success).toBe(false);
    },
  );
});

describe('the transaction reference', () => {
  it('trims and upper-cases', () => {
    const result = externalReferenceSchema.safeParse('  mtn-abc-123  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('MTN-ABC-123');
  });

  it('keeps internal characters a network put there', () => {
    // Nothing is stripped beyond surrounding whitespace: a dot or an
    // underscore inside the reference is part of it.
    for (const input of ['ABC.123.XYZ', 'ABC_123', 'AB-12.34_56']) {
      const result = externalReferenceSchema.safeParse(input);
      expect(result.success, input).toBe(true);
      if (result.success) expect(result.data).toBe(input);
    }
  });

  it.each(['ABC', 'AB', '', '   '])('rejects %s as too short', (input) => {
    expect(externalReferenceSchema.safeParse(input).success).toBe(false);
  });

  it('rejects characters a reference would not contain', () => {
    for (const input of ['ABC 123', 'ABC/123', "ABC'123", 'ABC;DROP', 'ABC<>']) {
      expect(externalReferenceSchema.safeParse(input).success, input).toBe(false);
    }
  });

  it('rejects one longer than the column allows', () => {
    expect(externalReferenceSchema.safeParse('A'.repeat(65)).success).toBe(false);
  });
});

describe('recording a payment', () => {
  const base = {
    loanId: VALID_UUID,
    amount: '11500',
    idempotencyKey: VALID_UUID,
  };

  it('accepts a cash payment with no reference', () => {
    const result = recordPaymentSchema.safeParse({
      ...base,
      paymentMethod: 'cash',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a cash payment with an empty reference', () => {
    const result = recordPaymentSchema.safeParse({
      ...base,
      paymentMethod: 'cash',
      externalReference: '',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalReference).toBeNull();
  });

  it('rejects a cash payment carrying a reference', () => {
    // Refused rather than ignored: silently dropping it would lose
    // information the staff member believed they had recorded.
    const result = recordPaymentSchema.safeParse({
      ...base,
      paymentMethod: 'cash',
      externalReference: 'RECEIPT-BOOK-42',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/no network reference/i);
    }
  });

  it('requires a reference for Mobile Money', () => {
    for (const method of ['mtn_mobile_money', 'airtel_money']) {
      const result = recordPaymentSchema.safeParse({
        ...base,
        paymentMethod: method,
      });

      expect(result.success, method).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toMatch(/recorded twice/i);
      }
    }
  });

  it('accepts Mobile Money with a reference, normalised', () => {
    const result = recordPaymentSchema.safeParse({
      ...base,
      paymentMethod: 'mtn_mobile_money',
      externalReference: ' mtn-xyz-999 ',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.externalReference).toBe('MTN-XYZ-999');
  });

  it('requires an idempotency key', () => {
    // Optional would make the protection depend on the caller remembering to
    // send one — and the caller that forgets is the one that double-submits.
    const { idempotencyKey: _omitted, ...withoutKey } = base;

    const result = recordPaymentSchema.safeParse({
      ...withoutKey,
      paymentMethod: 'cash',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed idempotency key', () => {
    const result = recordPaymentSchema.safeParse({
      ...base,
      idempotencyKey: 'not-a-uuid',
      paymentMethod: 'cash',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed loan identifier', () => {
    const result = recordPaymentSchema.safeParse({
      ...base,
      loanId: 'nonsense',
      paymentMethod: 'cash',
    });

    expect(result.success).toBe(false);
  });

  it('accepts no balance, allocation, payment number, actor or timestamp', () => {
    // A caller who could supply an allocation could credit a borrower's
    // principal while leaving the interest unpaid; one who could supply a
    // balance could print any receipt it liked.
    const result = recordPaymentSchema.safeParse({
      ...base,
      paymentMethod: 'cash',
      outstandingBefore: 1,
      outstandingAfter: 0,
      paymentNumber: 'PAY999999',
      recordedBy: VALID_UUID,
      receivedAt: '2020-01-01T00:00:00Z',
      allocations: [{ installmentId: VALID_UUID, amount: 1 }],
      status: 'reversed',
    });

    expect(result.success).toBe(true);

    if (result.success) {
      const keys = Object.keys(result.data);
      for (const forbidden of [
        'outstandingBefore',
        'outstandingAfter',
        'paymentNumber',
        'recordedBy',
        'receivedAt',
        'allocations',
        'status',
      ]) {
        expect(keys, forbidden).not.toContain(forbidden);
      }
    }
  });

  it('truncates nothing and rejects an over-long note', () => {
    const result = recordPaymentSchema.safeParse({
      ...base,
      paymentMethod: 'cash',
      notes: 'x'.repeat(1_001),
    });

    expect(result.success).toBe(false);
  });
});

describe('reversing a payment', () => {
  it('accepts a substantive reason', () => {
    const result = reversePaymentSchema.safeParse({
      paymentId: VALID_UUID,
      reason: 'the borrower disputed the receipt and the cash was returned',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a reason too short to mean anything', () => {
    // This is the only record of why money was withdrawn from a borrower's
    // account. "Error" tells a future reader nothing.
    for (const reason of ['', '   ', 'error', 'oops', 'mistake']) {
      const result = reversePaymentSchema.safeParse({
        paymentId: VALID_UUID,
        reason,
      });

      expect(result.success, JSON.stringify(reason)).toBe(false);
    }
  });

  it('rejects an over-long reason', () => {
    const result = reversePaymentSchema.safeParse({
      paymentId: VALID_UUID,
      reason: 'x'.repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed payment identifier', () => {
    const result = reversePaymentSchema.safeParse({
      paymentId: 'nonsense',
      reason: 'a perfectly good reason for the reversal',
    });

    expect(result.success).toBe(false);
  });
});

describe('the payment search filter', () => {
  it('defaults to everything', () => {
    const result = paymentSearchSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.method).toBe('all');
      expect(result.data.status).toBe('all');
      expect(result.data.page).toBe(1);
    }
  });

  it('accepts a method, a status and a date range', () => {
    const result = paymentSearchSchema.safeParse({
      method: 'mtn_mobile_money',
      status: 'reversed',
      from: '2026-10-01',
      to: '2026-10-31',
      page: '3',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.page).toBe(3);
  });

  it('rejects a malformed date', () => {
    for (const from of ['01/10/2026', '2026-13-01', 'yesterday']) {
      const result = paymentSearchSchema.safeParse({ from });
      expect(result.success, from).toBe(false);
    }
  });

  it('rejects an unknown method or status', () => {
    // `bank` was the example here until Phase 10 made it a real method, so
    // the case is restated with one that is still not: a cheque is not a
    // method this system records.
    expect(paymentSearchSchema.safeParse({ method: 'cheque' }).success).toBe(false);
    expect(paymentSearchSchema.safeParse({ method: 'bank_transfer' }).success).toBe(
      false,
    );
    expect(paymentSearchSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('accepts bank, which Phase 10 added', () => {
    expect(paymentSearchSchema.safeParse({ method: 'bank' }).success).toBe(true);
  });

  it('bounds the page number', () => {
    expect(paymentSearchSchema.safeParse({ page: '0' }).success).toBe(false);
    expect(paymentSearchSchema.safeParse({ page: '-1' }).success).toBe(false);
    expect(paymentSearchSchema.safeParse({ page: '99999' }).success).toBe(false);
  });

  it('normalises blank search text to null', () => {
    const result = paymentSearchSchema.safeParse({ query: '   ' });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.query).toBeNull();
  });

  it('rejects search text long enough to be an attack payload', () => {
    const result = paymentSearchSchema.safeParse({ query: 'x'.repeat(101) });
    expect(result.success).toBe(false);
  });
});
