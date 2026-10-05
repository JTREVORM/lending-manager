import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LoanBalanceSummary } from '@/components/payments/loan-balance-summary';
import { PaymentForm } from '@/components/payments/payment-form';
import { PaymentReceipt } from '@/components/payments/payment-receipt';
import { PaymentRegister } from '@/components/payments/payment-register';
import { PaymentReversalPanel } from '@/components/payments/payment-reversal-panel';
import { PortalPaymentHistory } from '@/components/payments/portal-payment-history';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import type { PaymentObligation } from '@/lib/domain/payment';
import { getByCompositeText } from '../helpers/text';

/**
 * The Phase 6 screens.
 *
 * Browser-level layout verification needs a live Supabase instance, which this
 * environment cannot run. These assertions cover what can be checked without
 * one, and for a payment screen the most important are:
 *
 *   - the **confirmation step** shows the figures before the money is
 *     committed, because a mistyped amount is far cheaper to catch than to
 *     reverse;
 *   - a **reversal** never reads as a deletion;
 *   - a **reversed receipt** still exists and says so;
 *   - and nothing anywhere shows a figure the ledger does not support.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/payments',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The Server Action module is stubbed.
 *
 * It is a `'use server'` module reaching `server-only` code, which refuses to
 * load in a client-component graph — correctly, since that guard keeps the
 * secret key out of the browser bundle. What the actions *do* is tested where
 * it is enforced: `tests/db/payment-posting.test.ts` drives every rule as a
 * real database role.
 */
vi.mock('@/lib/payments/actions', () => ({
  recordPaymentAction: vi.fn(),
  reversePaymentAction: vi.fn(),
  mintIdempotencyKey: vi.fn(),
}));

const TIMEZONE = 'Africa/Kampala';

/** Three UGX 4,000 collections — principal 3,000, interest 1,000. */
function obligations(): readonly PaymentObligation[] {
  return [1, 2, 3].map((number) => ({
    obligationId: `inst-${String(number)}`,
    kind: 'installment' as const,
    sequenceNumber: number,
    effectiveDate: toBusinessDate(`2026-11-0${String(number)}`),
    expectedAmount: toUgx(4_000),
    scheduledPrincipal: toUgx(3_000),
    scheduledInterest: toUgx(1_000),
    scheduledPenalty: toUgx(0),
    allocatedAmount: toUgx(0),
    allocatedPrincipal: toUgx(0),
    allocatedInterest: toUgx(0),
    allocatedPenalty: toUgx(0),
  }));
}

const FORM_PROPS = {
  loanId: '11111111-2222-4333-8444-555555555555',
  loanNumber: 'LN260001',
  clientName: 'Amina Nakato',
  clientNumber: 'CL26001',
  obligations: obligations(),
  outstanding: 12_000,
  unpaidDue: 4_000,
  minimumPayment: 4_000,
  idempotencyKey: '99999999-8888-4777-8666-555555555555',
} as const;

// ---------------------------------------------------------------------------
// The payment form
// ---------------------------------------------------------------------------

describe('the payment form', () => {
  it('shows the borrower, the loan, what is due and the balance', () => {
    render(<PaymentForm {...FORM_PROPS} />);

    expect(screen.getByText('Amina Nakato')).toBeInTheDocument();
    expect(screen.getByText('CL26001')).toBeInTheDocument();
    expect(screen.getByText('LN260001')).toBeInTheDocument();
    // Both figures appear twice — in the summary and in the amount hint.
    expect(screen.getAllByText(/UGX\s*4,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/UGX\s*12,000/).length).toBeGreaterThan(0);
  });

  it('prefills the amount with what is due now', () => {
    // The fast collection flow: the borrower has almost certainly come to pay
    // what is due, so the staff member should not have to type it.
    render(<PaymentForm {...FORM_PROPS} />);

    const amount = screen.getByLabelText(/Amount received/i);
    expect(amount).toHaveValue('4000');
  });

  it('carries the idempotency key as a hidden field', () => {
    // Minted when the form rendered, so a double tap sends the same key and
    // the database returns the payment that already exists.
    const { container } = render(<PaymentForm {...FORM_PROPS} />);

    const hidden = container.querySelector('input[name="idempotencyKey"]');

    expect(hidden).not.toBeNull();
    expect(hidden).toHaveValue(FORM_PROPS.idempotencyKey);
  });

  it('states the minimum and the maximum it will accept', () => {
    render(<PaymentForm {...FORM_PROPS} />);

    expect(screen.getByText(/At least UGX\s*4,000/)).toBeInTheDocument();
    expect(screen.getByText(/at most UGX\s*12,000/)).toBeInTheDocument();
  });

  it('previews how the payment would be applied', async () => {
    const user = userEvent.setup();
    render(<PaymentForm {...FORM_PROPS} />);

    const amount = screen.getByLabelText(/Amount received/i);
    await user.clear(amount);
    await user.type(amount, '10000');

    // 4,000 + 4,000 + 2,000 across three collections.
    expect(screen.getByText(/would cover 3 collections/i)).toBeInTheDocument();
    // Interest-first: 3,000 principal twice plus 1,000 on the third = 7,000
    // principal; 1,000 interest three times = 3,000.
    expect(getByCompositeText(/UGX\s*7,000 principal/)).toBeInTheDocument();
    expect(getByCompositeText(/UGX\s*3,000 interest/)).toBeInTheDocument();
    expect(getByCompositeText(/Balance afterwards UGX\s*2,000/)).toBeInTheDocument();
  });

  it('says plainly when a payment would settle the loan', async () => {
    const user = userEvent.setup();
    render(<PaymentForm {...FORM_PROPS} />);

    const amount = screen.getByLabelText(/Amount received/i);
    await user.clear(amount);
    await user.type(amount, '12000');

    expect(screen.getByText(/settles the loan in full/i)).toBeInTheDocument();
  });

  it('warns before the staff member commits, when the amount is below the minimum', async () => {
    const user = userEvent.setup();
    render(<PaymentForm {...FORM_PROPS} />);

    const amount = screen.getByLabelText(/Amount received/i);
    await user.clear(amount);
    await user.type(amount, '2000');

    expect(screen.getByText(/smallest payment accepted now/i)).toBeInTheDocument();
    // And there is no way forward.
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();
  });

  it('warns when the amount is above the outstanding balance', async () => {
    const user = userEvent.setup();
    render(<PaymentForm {...FORM_PROPS} />);

    const amount = screen.getByLabelText(/Amount received/i);
    await user.clear(amount);
    await user.type(amount, '20000');

    expect(screen.getByText(/more than this loan still owes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();
  });

  it('asks for a transaction reference only for Mobile Money', async () => {
    const user = userEvent.setup();
    render(<PaymentForm {...FORM_PROPS} />);

    // Cash: no field at all, rather than a field that would be refused.
    expect(screen.queryByLabelText(/Transaction reference/i)).toBeNull();
    expect(
      screen.getByText(/cash payment has no network reference/i),
    ).toBeInTheDocument();

    await user.click(screen.getByText('MTN Mobile Money'));

    expect(screen.getByLabelText(/Transaction reference/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Transaction reference/i)).toBeRequired();
  });

  it('will not go forward on Mobile Money until the reference is entered', async () => {
    // Found by recording a payment in a browser. `Continue` is a
    // `type="button"`, so the browser's own `required` validation never runs
    // — a cashier could select MTN, leave the reference blank, read the whole
    // allocation on the confirmation screen, press "Record UGX …" and only
    // then be told what was missing. The reference is also what stops the
    // same transfer being recorded twice, so it is not a detail to collect
    // after the figures have been agreed.
    const user = userEvent.setup();
    render(<PaymentForm {...FORM_PROPS} />);

    // Cash is complete without one.
    expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled();

    await user.click(screen.getByText('MTN Mobile Money'));
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();

    // Whitespace is not a reference.
    await user.type(screen.getByLabelText(/Transaction reference/i), '   ');
    expect(screen.getByRole('button', { name: /Continue/i })).toBeDisabled();

    await user.clear(screen.getByLabelText(/Transaction reference/i));
    await user.type(screen.getByLabelText(/Transaction reference/i), 'MP260104.1234');
    expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled();

    // And switching back to cash does not strand the form.
    await user.click(screen.getByText('Cash'));
    expect(screen.getByRole('button', { name: /Continue/i })).toBeEnabled();
  });

  it('offers exactly the three confirmed methods', () => {
    render(<PaymentForm {...FORM_PROPS} />);

    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('MTN Mobile Money')).toBeInTheDocument();
    expect(screen.getByText('Airtel Money')).toBeInTheDocument();
    expect(screen.queryByText(/Bank/i)).toBeNull();
  });

  // =======================================================================
  describe('the confirmation step', () => {
    it('shows every figure the specification requires before posting', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      const amount = screen.getByLabelText(/Amount received/i);
      await user.clear(amount);
      await user.type(amount, '10000');
      await user.click(screen.getByRole('button', { name: /Continue/i }));

      expect(screen.getByText(/Confirm this payment/i)).toBeInTheDocument();

      // Client, loan, amount, method, balance before and after.
      expect(screen.getByText('Borrower')).toBeInTheDocument();
      expect(screen.getByText('Loan')).toBeInTheDocument();
      expect(screen.getByText('Amount')).toBeInTheDocument();
      expect(screen.getByText('Method')).toBeInTheDocument();
      expect(screen.getByText('Balance before')).toBeInTheDocument();
      expect(screen.getByText('Balance after')).toBeInTheDocument();

      expect(screen.getAllByText(/UGX\s*10,000/).length).toBeGreaterThan(0);
    });

    it('shows the allocation, collection by collection', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      const amount = screen.getByLabelText(/Amount received/i);
      await user.clear(amount);
      await user.type(amount, '10000');
      await user.click(screen.getByRole('button', { name: /Continue/i }));

      const table = screen.getByRole('table');
      // Header plus three allocations.
      expect(within(table).getAllByRole('row')).toHaveLength(4);
      expect(within(table).getByText(/^Collection$/)).toBeInTheDocument();
    });

    it('explains that interest is covered before principal', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      await user.click(screen.getByRole('button', { name: /Continue/i }));

      expect(
        screen.getByText(/interest on each collection is covered before its principal/i),
      ).toBeInTheDocument();
    });

    it('promises the schedule will not change', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      await user.click(screen.getByRole('button', { name: /Continue/i }));

      expect(screen.getByText(/schedule itself does not change/i)).toBeInTheDocument();
    });

    it('warns that only the Owner can undo it', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      await user.click(screen.getByRole('button', { name: /Continue/i }));

      expect(screen.getByText(/withdrawn by the Owner/i)).toBeInTheDocument();
    });

    it('lets the staff member go back and change the amount', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      await user.click(screen.getByRole('button', { name: /Continue/i }));
      expect(screen.getByText(/Confirm this payment/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Back/i }));
      expect(screen.queryByText(/Confirm this payment/i)).toBeNull();
      expect(screen.getByLabelText(/Amount received/i)).toBeInTheDocument();
    });

    /**
     * The regression this exists for: step one is unmounted while step two is
     * shown, and an unmounted input is not part of the form. When the amount,
     * method, reference and note lived only in step one, the submission
     * carried the loan id and the idempotency key alone — so every payment was
     * rejected for fields the staff member could no longer see, and nothing
     * could be recorded through the interface at all.
     *
     * Asserting on the FormData the browser would build, rather than on what
     * is painted, is the point: a confirmation step that *shows* the right
     * figures while *submitting* none of them is exactly the failure that got
     * through.
     */
    it('submits the figures it is confirming, not just the hidden ids', async () => {
      const user = userEvent.setup();
      const { container } = render(<PaymentForm {...FORM_PROPS} />);

      const amount = screen.getByLabelText(/Amount received/i);
      await user.clear(amount);
      await user.type(amount, '10000');
      await user.click(screen.getByRole('radio', { name: /MTN Mobile Money/i }));
      await user.type(screen.getByLabelText(/Transaction reference/i), 'MP250101ABC');
      await user.type(screen.getByLabelText(/Note/i), 'Paid at the shop');
      await user.click(screen.getByRole('button', { name: /Continue/i }));

      const form = container.querySelector('form');
      expect(form).not.toBeNull();

      const data = new FormData(form!);
      expect(data.get('loanId')).toBe(FORM_PROPS.loanId);
      expect(data.get('idempotencyKey')).toBe(FORM_PROPS.idempotencyKey);
      expect(data.get('amount')).toBe('10000');
      expect(data.get('paymentMethod')).toBe('mtn_mobile_money');
      expect(data.get('externalReference')).toBe('MP250101ABC');
      expect(data.get('notes')).toBe('Paid at the shop');
    });

    it('carries no reference for a cash payment, which the database refuses', async () => {
      const user = userEvent.setup();
      const { container } = render(<PaymentForm {...FORM_PROPS} />);

      await user.click(screen.getByRole('button', { name: /Continue/i }));

      const data = new FormData(container.querySelector('form')!);
      expect(data.get('paymentMethod')).toBe('cash');
      expect(data.get('externalReference')).toBeNull();
    });

    it('names the amount on the submit button, so it cannot be tapped blind', async () => {
      const user = userEvent.setup();
      render(<PaymentForm {...FORM_PROPS} />);

      const amount = screen.getByLabelText(/Amount received/i);
      await user.clear(amount);
      await user.type(amount, '12000');
      await user.click(screen.getByRole('button', { name: /Continue/i }));

      expect(
        screen.getByRole('button', { name: /Record UGX\s*12,000/ }),
      ).toBeInTheDocument();
    });
  });

  it('uses a numeric keypad but a text field, so decimals are rejected not offered', () => {
    render(<PaymentForm {...FORM_PROPS} />);

    const amount = screen.getByLabelText(/Amount received/i);

    expect(amount).toHaveAttribute('type', 'text');
    expect(amount).toHaveAttribute('inputmode', 'numeric');
  });
});

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

describe('the payment register', () => {
  const ROWS = [
    {
      id: 'p1',
      paymentNumber: 'PAY260001',
      loanId: 'l1',
      loanNumber: 'LN260001',
      clientName: 'Amina Nakato',
      clientNumber: 'CL26001',
      amount: 4_000,
      paymentMethod: 'cash' as const,
      status: 'posted' as const,
      receivedAt: '2026-11-01T09:00:00Z',
      recordedByLabel: 'Sarah Treasurer',
    },
    {
      id: 'p2',
      paymentNumber: 'PAY260002',
      loanId: 'l1',
      loanNumber: 'LN260001',
      clientName: 'Amina Nakato',
      clientNumber: 'CL26001',
      amount: 8_000,
      paymentMethod: 'mtn_mobile_money' as const,
      status: 'reversed' as const,
      receivedAt: '2026-11-02T09:00:00Z',
      recordedByLabel: 'Sarah Treasurer',
    },
  ];

  it('lists every payment with its receipt number and method', () => {
    render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    expect(screen.getAllByText('PAY260001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PAY260002').length).toBeGreaterThan(0);
    expect(screen.getAllByText('MTN Mobile Money').length).toBeGreaterThan(0);
  });

  it('keeps a reversed payment listed rather than hiding it', () => {
    // A register that dropped reversed payments would be impossible to
    // reconcile against a cash drawer, and would hide the one event a
    // reviewer most wants to see.
    render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    expect(screen.getAllByText('PAY260002').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reversed').length).toBeGreaterThan(0);
  });

  it('strikes through a reversed amount and says so for a screen reader', () => {
    const { container } = render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    const struck = container.querySelectorAll('.line-through');
    expect(struck.length).toBeGreaterThan(0);

    expect(screen.getAllByText(/reversed, no longer counted/i).length).toBeGreaterThan(0);
  });

  it('never describes a reversal as a deletion', () => {
    render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\bdeleted\b|\bremoved\b|\bvoid(ed)?\b/i);
  });

  it('offers filters by method, status and date', () => {
    render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    expect(screen.getByLabelText(/Method/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Status$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^From$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^To$/i)).toBeInTheDocument();
  });

  it('offers a search by receipt number or transaction reference', () => {
    render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    expect(
      screen.getByLabelText(/Search payments by receipt number/i),
    ).toBeInTheDocument();
  });

  it('hides the filters when embedded on a loan', () => {
    render(
      <PaymentRegister
        payments={ROWS}
        page={1}
        hasMore={false}
        timeZone={TIMEZONE}
        showFilters={false}
      />,
    );

    expect(screen.queryByLabelText(/Method/i)).toBeNull();
  });

  it('distinguishes an empty filter result from an empty ledger', () => {
    render(
      <PaymentRegister payments={[]} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    expect(screen.getByText(/not the same as no payments existing/i)).toBeInTheDocument();
  });

  it('renders cards as well as a table, for narrow screens', () => {
    const { container } = render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    const list = container.querySelector('ul');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('li')).toHaveLength(2);
    expect(list?.className).toContain('md:hidden');
  });

  it('gives the table a caption describing its columns', () => {
    render(
      <PaymentRegister payments={ROWS} page={1} hasMore={false} timeZone={TIMEZONE} />,
    );

    const caption = screen.getByText(/Payment register:/i);
    expect(caption.tagName.toLowerCase()).toBe('caption');
  });
});

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

describe('the receipt', () => {
  const RECEIPT = {
    companyName: 'Kampala Credit Ltd',
    companyPhone: '+256700000000',
    receiptHeader: 'Thank you for your business',
    receiptFooter: 'Keep this receipt safe',
    paymentNumber: 'PAY260001',
    receivedAt: '2026-11-01T09:00:00Z',
    clientName: 'Amina Nakato',
    clientNumber: 'CL26001',
    loanNumber: 'LN260001',
    amount: 4_000,
    paymentMethod: 'cash' as const,
    externalReference: null,
    outstandingBefore: 12_000,
    outstandingAfter: 8_000,
    recordedByLabel: 'Sarah Treasurer',
    timeZone: TIMEZONE,
    reversedAt: null,
    reversalReason: null,
  };

  it('shows everything the specification requires', () => {
    render(<PaymentReceipt {...RECEIPT} />);

    expect(screen.getByText('Kampala Credit Ltd')).toBeInTheDocument();
    expect(screen.getByText('+256700000000')).toBeInTheDocument();
    expect(screen.getByText('PAY260001')).toBeInTheDocument();
    expect(screen.getByText('Amina Nakato')).toBeInTheDocument();
    expect(screen.getByText('CL26001')).toBeInTheDocument();
    expect(screen.getByText('LN260001')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Sarah Treasurer')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*12,000/)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*4,000/)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*8,000/)).toBeInTheDocument();
  });

  it('satisfies the receipt balance invariant it displays', () => {
    // before − amount = after. Enforced by a CHECK constraint in the
    // database; asserted here because this is where a borrower reads it.
    expect(RECEIPT.outstandingBefore - RECEIPT.amount).toBe(RECEIPT.outstandingAfter);

    render(<PaymentReceipt {...RECEIPT} />);

    expect(screen.getByText('Balance before')).toBeInTheDocument();
    expect(screen.getByText('Amount paid')).toBeInTheDocument();
    expect(screen.getByText('Balance after')).toBeInTheDocument();
  });

  it('shows a Mobile Money reference when there is one', () => {
    render(
      <PaymentReceipt
        {...RECEIPT}
        paymentMethod="mtn_mobile_money"
        externalReference="MTN-ABC-123"
      />,
    );

    expect(screen.getByText('MTN-ABC-123')).toBeInTheDocument();
    expect(screen.getByText('Transaction reference')).toBeInTheDocument();
  });

  it('omits the reference row entirely for cash', () => {
    render(<PaymentReceipt {...RECEIPT} />);

    expect(screen.queryByText('Transaction reference')).toBeNull();
  });

  it('marks a reversed receipt loudly and still shows every figure', () => {
    render(
      <PaymentReceipt
        {...RECEIPT}
        reversedAt="2026-11-03T10:00:00Z"
        reversalReason="posted against the wrong loan"
      />,
    );

    expect(screen.getByText('REVERSED')).toBeInTheDocument();
    expect(
      screen.getByText(/no longer counts toward the loan balance/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/posted against the wrong loan/i)).toBeInTheDocument();

    // The original figures are still there — a borrower holding the printed
    // slip must be able to find the record it refers to.
    expect(screen.getByText('PAY260001')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*4,000/)).toBeInTheDocument();
  });

  it('explains that the figures are what the receipt said, not the live balance', () => {
    render(
      <PaymentReceipt
        {...RECEIPT}
        reversedAt="2026-11-03T10:00:00Z"
        reversalReason="posted against the wrong loan"
      />,
    );

    expect(
      screen.getByText(/what this receipt said when it was issued/i),
    ).toBeInTheDocument();
  });

  it('lists the allocation when it is supplied', () => {
    render(
      <PaymentReceipt
        {...RECEIPT}
        allocations={[
          {
            id: 'a1',
            installmentNumber: 1,
            dueDate: toBusinessDate('2026-11-01'),
            allocatedAmount: 4_000,
            allocatedPrincipal: 3_000,
            allocatedInterest: 1_000,
          },
        ]}
      />,
    );

    expect(screen.getByText(/Applied to collection/i)).toBeInTheDocument();
    expect(screen.getByText(/#1 due/)).toBeInTheDocument();
  });

  it('tells the borrower to keep it and quotes the number to use', () => {
    render(<PaymentReceipt {...RECEIPT} />);

    expect(
      screen.getByText(/PAY260001 identifies this payment in any query/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The reversal panel
// ---------------------------------------------------------------------------

describe('the reversal panel', () => {
  const PANEL = {
    paymentId: 'p1',
    paymentNumber: 'PAY260001',
    amount: 10_000,
    loanNumber: 'LN260001',
    willReopenLoan: false,
    alreadyReversed: false,
  };

  it('never calls itself a delete', () => {
    render(<PaymentReversalPanel {...PANEL} />);

    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/\bdelete\b|\bremove\b|\bvoid\b/i);
    expect(screen.getByRole('button', { name: /Reverse/i })).toBeInTheDocument();
  });

  it('says the record is kept', () => {
    render(<PaymentReversalPanel {...PANEL} />);

    expect(screen.getByText(/record is kept and marked reversed/i)).toBeInTheDocument();
  });

  it('spells out the consequence in money before confirming', async () => {
    const user = userEvent.setup();
    render(<PaymentReversalPanel {...PANEL} />);

    await user.click(screen.getByRole('button', { name: /Reverse…/i }));

    expect(screen.getByText(/This changes what the borrower owes/i)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*10,000/)).toBeInTheDocument();
    expect(screen.getByText(/more than it does now/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/i)).toBeInTheDocument();
  });

  it('warns when the loan would reopen', async () => {
    const user = userEvent.setup();
    render(<PaymentReversalPanel {...PANEL} willReopenLoan />);

    await user.click(screen.getByRole('button', { name: /Reverse…/i }));

    expect(screen.getByText(/currently settled/i)).toBeInTheDocument();
    expect(screen.getByText(/reopen it as active/i)).toBeInTheDocument();
  });

  it('requires a reason and explains why', async () => {
    const user = userEvent.setup();
    render(<PaymentReversalPanel {...PANEL} />);

    await user.click(screen.getByRole('button', { name: /Reverse…/i }));

    const reason = screen.getByLabelText(/Reason for this reversal/i);

    expect(reason).toBeRequired();
    expect(
      screen.getByText(/only record of why the money was withdrawn/i),
    ).toBeInTheDocument();
  });

  it('promises the schedule will not change', async () => {
    const user = userEvent.setup();
    render(<PaymentReversalPanel {...PANEL} />);

    await user.click(screen.getByRole('button', { name: /Reverse…/i }));

    expect(screen.getByText(/schedule itself does not change/i)).toBeInTheDocument();
  });

  it('offers nothing on a payment already reversed', () => {
    render(<PaymentReversalPanel {...PANEL} alreadyReversed />);

    expect(screen.getByText(/already been reversed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reverse/i })).toBeNull();
  });

  it('says a reversal cannot itself be undone', () => {
    render(<PaymentReversalPanel {...PANEL} alreadyReversed />);

    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The balance summary
// ---------------------------------------------------------------------------

describe('the loan balance summary', () => {
  const BALANCE = {
    totalExpectedRepayment: 115_000,
    totalPaid: 23_000,
    outstanding: 92_000,
    principalPaid: 20_000,
    principalRemaining: 80_000,
    interestPaid: 3_000,
    interestRemaining: 12_000,
    unpaidScheduledDue: 11_500,
    // Phase 7. No penalty on this loan, which is the ordinary case: the
    // penalty-bearing variants are asserted separately below.
    penaltyAssessed: 0,
    penaltyPaid: 0,
    penaltyRemaining: 0,
    totalOutstanding: 92_000,
    postedPaymentCount: 2,
    reversedPaymentCount: 1,
    fullyRepaid: false,
    reconciles: true,
    reconciliationProblem: null,
  };

  it('shows every figure the specification requires', () => {
    render(<LoanBalanceSummary {...BALANCE} />);

    expect(screen.getByText(/UGX\s*92,000/)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*23,000/)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*11,500/)).toBeInTheDocument();
    expect(getByCompositeText(/20,000 paid/)).toBeInTheDocument();
    expect(screen.getByText(/80,000/)).toBeInTheDocument();
    expect(getByCompositeText(/3,000 paid/)).toBeInTheDocument();
    expect(screen.getByText(/12,000/)).toBeInTheDocument();
  });

  it('calls what is due "due now" and never arrears', () => {
    // Whether an unpaid collection is *arrears* depends on a grace period and
    // carries a penalty, both of which are Phase 7's.
    render(<LoanBalanceSummary {...BALANCE} />);

    expect(screen.getByText('Due now')).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\barrears\b|\boverdue\b|\bmissed\b|\bpenalt/i);
  });

  it('notes reversed payments without counting them', () => {
    render(<LoanBalanceSummary {...BALANCE} />);

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/1 reversed, not counted/i)).toBeInTheDocument();
  });

  it('says plainly when a loan is settled', () => {
    render(
      <LoanBalanceSummary
        {...BALANCE}
        outstanding={0}
        totalPaid={115_000}
        principalPaid={100_000}
        principalRemaining={0}
        interestPaid={15_000}
        interestRemaining={0}
        unpaidScheduledDue={0}
        fullyRepaid
      />,
    );

    expect(screen.getByText(/Fully repaid/i)).toBeInTheDocument();
  });

  it('warns loudly, and tells staff not to quote the figure, when it does not reconcile', () => {
    // Unreachable — the posting function reconciles before it commits — which
    // is exactly why it must announce itself if it ever appears.
    render(
      <LoanBalanceSummary
        {...BALANCE}
        reconciles={false}
        reconciliationProblem="paid plus outstanding is not the contractual total."
      />,
    );

    expect(screen.getByText(/does not reconcile/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not take a payment/i)).toBeInTheDocument();
    expect(screen.getByText(/Report it immediately/i)).toBeInTheDocument();
  });

  it('uses a description list, so each figure is labelled for a screen reader', () => {
    const { container } = render(<LoanBalanceSummary {...BALANCE} />);

    const lists = container.querySelectorAll('dl');
    expect(lists.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The client portal
// ---------------------------------------------------------------------------

describe('the client portal payment history', () => {
  const PAYMENTS = [
    {
      id: 'p1',
      paymentNumber: 'PAY260001',
      loanNumber: 'LN260001',
      amount: 4_000,
      paymentMethod: 'cash' as const,
      status: 'posted' as const,
      receivedAt: '2026-11-01T09:00:00Z',
    },
    {
      id: 'p2',
      paymentNumber: 'PAY260002',
      loanNumber: 'LN260001',
      amount: 8_000,
      paymentMethod: 'mtn_mobile_money' as const,
      status: 'reversed' as const,
      receivedAt: '2026-11-02T09:00:00Z',
    },
  ];

  it('shows what the borrower paid, with the receipt number to quote', () => {
    render(<PortalPaymentHistory payments={PAYMENTS} timeZone={TIMEZONE} />);

    expect(screen.getByText('PAY260001')).toBeInTheDocument();
    // Twice: the row, and the total, which this one payment makes up.
    expect(screen.getAllByText(/UGX\s*4,000/)).toHaveLength(2);
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('totals only the posted payments', () => {
    render(<PortalPaymentHistory payments={PAYMENTS} timeZone={TIMEZONE} />);

    // 4,000 posted; the 8,000 reversal does not count.
    expect(screen.getByText('Total you have paid')).toBeInTheDocument();
    expect(screen.getByText(/Across 1 payment$/)).toBeInTheDocument();
  });

  it('shows a reversed payment rather than hiding it, and explains it', () => {
    // The worst outcome for a borrower holding a withdrawn receipt is a portal
    // showing no trace of it.
    render(<PortalPaymentHistory payments={PAYMENTS} timeZone={TIMEZONE} />);

    expect(screen.getByText('PAY260002')).toBeInTheDocument();
    expect(screen.getByText('Reversed')).toBeInTheDocument();
    expect(
      screen.getByText(/ask our staff if you were not expecting/i),
    ).toBeInTheDocument();
  });

  it('shows no staff attribution or internal note', () => {
    // Operational records about the business's own handling are not facts
    // about the borrower's payment.
    render(<PortalPaymentHistory payments={PAYMENTS} timeZone={TIMEZONE} />);

    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/received by|recorded by|treasurer|note/i);
  });

  it('shows no balance, because a single figure would read as a settlement quote', () => {
    render(<PortalPaymentHistory payments={PAYMENTS} timeZone={TIMEZONE} />);

    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/outstanding|balance remaining|you owe/i);
  });

  it('is a card list at every width, for a phone held one-handed', () => {
    const { container } = render(
      <PortalPaymentHistory payments={PAYMENTS} timeZone={TIMEZONE} />,
    );

    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('ul')?.querySelectorAll('li')).toHaveLength(2);
  });
});
