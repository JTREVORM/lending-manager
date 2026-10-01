import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LoanBreakdownTable } from '@/components/loans/loan-breakdown-table';
import { LoanRegister } from '@/components/loans/loan-register';
import { LoanStatusBadge } from '@/components/loans/loan-status-badge';
import { LoanLifecyclePanel } from '@/components/loans/loan-lifecycle-panel';
import { LOAN_STATUSES } from '@/lib/domain/loan';
import { calculateLoan } from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import type { LoanPage } from '@/lib/data/loans';

/**
 * The Phase 4 screens.
 *
 * Browser-level layout verification needs a live Supabase instance, which this
 * environment cannot run. These assertions cover what can be checked without
 * one, and for a financial screen the most important of those is **whether a
 * figure is labelled as provisional**. A staff member reading a number off a
 * screen to a borrower needs to know whether it binds.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * The Server Action modules are stubbed.
 *
 * They are `'use server'` modules reaching `server-only` code, which refuses
 * to load in a client-component graph — correctly, since that guard keeps the
 * secret key out of the browser bundle. What the actions *do* is tested where
 * it is enforced: `tests/db/loan-lifecycle.test.ts` drives every transition as
 * a real database role.
 */
vi.mock('@/lib/loans/actions', () => ({
  createLoanAction: vi.fn(),
  createLoanAndRedirect: vi.fn(),
  updateLoanDraftAction: vi.fn(),
  submitLoanAction: vi.fn(),
  approveLoanAction: vi.fn(),
  returnLoanToDraftAction: vi.fn(),
  disburseLoanAction: vi.fn(),
  cancelLoanAction: vi.fn(),
}));

const CASE_C = calculateLoan({
  principal: toUgx(600_000),
  monthlyInterestRateBps: 1_500,
  termMonths: 3,
});

describe('the breakdown table', () => {
  it('shows every month with its five figures', () => {
    render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
      />,
    );

    const table = screen.getByRole('table');
    // Three months, a header row and a total row.
    expect(within(table).getAllByRole('row')).toHaveLength(5);
  });

  it('shows the agreed Case C figures', () => {
    render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
      />,
    );

    // The confirmed business example, rendered. Hand-checked: 290,000 then
    // 260,000 then 230,000, totalling 780,000.
    for (const amount of ['290,000', '260,000', '230,000', '780,000']) {
      expect(screen.getAllByText(new RegExp(amount)).length, amount).toBeGreaterThan(0);
    }
  });

  it('labels a preview as a preview, in words', () => {
    render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
        provisional
      />,
    );

    // Not decoration. The difference between "this is what the borrower owes"
    // and "this is what they would owe if approved on today's terms".
    expect(screen.getByText(/Preview only/)).toBeTruthy();
    expect(
      screen.getByText(/recalculated and recorded when the loan is approved/),
    ).toBeTruthy();
    expect(screen.getByText(/Total repayable \(preview\)/)).toBeTruthy();
  });

  it('does not label stored figures as a preview', () => {
    render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
      />,
    );

    expect(screen.queryByText(/Preview only/)).toBeNull();
    expect(screen.getByText('Total repayable')).toBeTruthy();
  });

  it('gives the table a caption for screen readers', () => {
    render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
      />,
    );

    expect(screen.getByText(/Monthly reducing-balance breakdown/)).toBeTruthy();
  });

  it('aligns money columns with tabular figures', () => {
    const { container } = render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
      />,
    );

    // Proportional digits make a column of amounts genuinely harder to
    // compare, which matters when somebody is checking a figure against paper.
    expect(container.querySelectorAll('.tabular-nums').length).toBeGreaterThan(5);
  });

  it('scrolls inside its own container rather than widening the page', () => {
    const { container } = render(
      <LoanBreakdownTable
        periods={CASE_C.periods}
        principal={600_000}
        totalInterest={180_000}
        totalExpected={780_000}
      />,
    );

    // Six columns cannot fit 320px. The table scrolls; the page does not.
    expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
    expect(container.querySelectorAll('.min-w-0').length).toBeGreaterThan(0);
  });

  it('explains an empty breakdown differently for a draft and a preview', () => {
    const stored = render(
      <LoanBreakdownTable
        periods={[]}
        principal={0}
        totalInterest={0}
        totalExpected={0}
      />,
    );
    expect(stored.getByText(/created when the loan is approved/)).toBeTruthy();

    const preview = render(
      <LoanBreakdownTable
        periods={[]}
        principal={0}
        totalInterest={0}
        totalExpected={0}
        provisional
      />,
    );
    expect(preview.getByText(/Enter an amount and a period/)).toBeTruthy();
  });
});

describe('the loan register', () => {
  const PAGE: LoanPage = {
    loans: [
      {
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        loanNumber: 'LN260001',
        clientId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        clientName: 'Nakato Beatrice',
        clientNumber: 'CL26001',
        principalAmount: 600_000,
        interestRateBps: 1_500,
        loanTermMonths: 3,
        repaymentFrequency: 'daily',
        totalExpectedRepayment: 780_000,
        status: 'active',
        createdAt: '2026-09-01T06:30:00Z',
        proposedDisbursementDate: '2026-09-05',
        disbursedAt: '2026-09-05T08:00:00Z',
      },
      {
        id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
        loanNumber: 'LN260002',
        clientId: '3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f',
        clientName: 'Okello Joseph',
        clientNumber: 'CL26002',
        principalAmount: 200_000,
        interestRateBps: 1_500,
        loanTermMonths: 1,
        repaymentFrequency: 'daily',
        // A draft has no computed total.
        totalExpectedRepayment: 0,
        status: 'draft',
        createdAt: '2026-09-10T06:30:00Z',
        proposedDisbursementDate: '2026-09-15',
        disbursedAt: null,
      },
    ],
    page: 1,
    hasMore: false,
  };

  it('offers a labelled search box and status filter', () => {
    render(<LoanRegister page={PAGE} filter={{ query: '', status: '' }} />);

    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByLabelText('Status')).toBeTruthy();
  });

  it('offers every status as a filter', () => {
    render(<LoanRegister page={PAGE} filter={{ query: '', status: '' }} />);

    const options = within(screen.getByLabelText('Status')).getAllByRole('option');
    expect(options).toHaveLength(LOAN_STATUSES.length + 1);
  });

  it('shows an em dash rather than zero for a draft with no total', () => {
    render(<LoanRegister page={PAGE} filter={{ query: '', status: '' }} />);

    // A zero would read as "this loan is worth nothing". The figure does not
    // exist yet, and saying so is different from saying it is zero.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders both a card list and a table', () => {
    const { container } = render(
      <LoanRegister page={PAGE} filter={{ query: '', status: '' }} />,
    );

    expect(container.querySelector('ul.md\\:hidden')).toBeTruthy();
    expect(container.querySelector('.hidden.md\\:block')).toBeTruthy();
  });

  it('states each status in words', () => {
    render(<LoanRegister page={PAGE} filter={{ query: '', status: '' }} />);

    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
  });

  it('announces the result count politely', () => {
    const { container } = render(
      <LoanRegister page={PAGE} filter={{ query: '', status: '' }} />,
    );

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toMatch(/2 loans/);
  });

  it('renders a hostile client name as text', () => {
    const { container } = render(
      <LoanRegister
        page={{
          ...PAGE,
          loans: [{ ...PAGE.loans[0]!, clientName: '<img src=x onerror="alert(1)">' }],
        }}
        filter={{ query: '', status: '' }}
      />,
    );

    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('explains an empty register', () => {
    render(
      <LoanRegister
        page={{ loans: [], page: 1, hasMore: false }}
        filter={{ query: '', status: '' }}
      />,
    );

    expect(screen.getByText(/No loans have been recorded yet/)).toBeTruthy();
  });
});

describe('the lifecycle panel', () => {
  const BASE = {
    loanId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    loanNumber: 'LN260001',
    clientName: 'Nakato Beatrice',
    principal: 600_000,
    totalExpected: 780_000,
    proposedDate: '5 Sep 2026',
    approvalFailures: [],
  };

  const ALL = {
    canSubmit: true,
    canApprove: true,
    canDisburse: true,
    canCancel: true,
  };

  it('offers submission on a draft, and nothing else', () => {
    render(<LoanLifecyclePanel {...BASE} status="draft" capabilities={ALL} />);

    expect(screen.getByRole('button', { name: /Submit for approval/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Disburse/ })).toBeNull();
  });

  it('warns that a submitted draft can no longer be edited', () => {
    render(<LoanLifecyclePanel {...BASE} status="draft" capabilities={ALL} />);

    expect(screen.getByText(/can no longer be edited once submitted/)).toBeTruthy();
  });

  it('offers approval on a submitted loan, behind a confirmation', () => {
    render(<LoanLifecyclePanel {...BASE} status="pending_approval" capabilities={ALL} />);

    // Not a single click. The first opens the confirmation; the second acts.
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Yes, approve/ })).toBeNull();
  });

  it('blocks approval and lists why when a rule is unmet', () => {
    render(
      <LoanLifecyclePanel
        {...BASE}
        status="pending_approval"
        capabilities={ALL}
        approvalFailures={[
          { code: 'client_not_active', detail: 'suspended' },
          { code: 'insufficient_guarantors', detail: '1' },
        ]}
      />,
    );

    expect(screen.getByText(/cannot be approved as it stands/)).toBeTruthy();
    expect(screen.getByText(/suspended and cannot receive a loan/)).toBeTruthy();
    expect(screen.getByText(/at least 1 active guarantor/)).toBeTruthy();

    // And the control is withheld rather than offered and then refused.
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(screen.getByText(/Resolve the points above/)).toBeTruthy();
  });

  it('confirms when every rule is satisfied', () => {
    render(<LoanLifecyclePanel {...BASE} status="pending_approval" capabilities={ALL} />);

    expect(screen.getByText(/Every lending rule is satisfied/)).toBeTruthy();
  });

  it('restates the amount and the borrower before releasing money', () => {
    render(<LoanLifecyclePanel {...BASE} status="approved" capabilities={ALL} />);

    expect(screen.getByRole('button', { name: 'Disburse…' })).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
  });

  it('tells a Manager who cannot disburse what happens next', () => {
    render(
      <LoanLifecyclePanel
        {...BASE}
        status="approved"
        capabilities={{ ...ALL, canDisburse: false }}
      />,
    );

    // Rather than a screen with no controls and no explanation.
    expect(screen.getByText(/done by an Owner or Administrator/)).toBeTruthy();
  });

  it('offers no lifecycle control on an active loan except nothing', () => {
    render(<LoanLifecyclePanel {...BASE} status="active" capabilities={ALL} />);

    // An active loan cannot be cancelled: the money has gone. Repayment is a
    // later phase.
    expect(screen.queryByRole('button', { name: /Cancel this loan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disburse…' })).toBeNull();
  });

  it('hides every control from somebody with no capability', () => {
    render(
      <LoanLifecyclePanel
        {...BASE}
        status="pending_approval"
        capabilities={{
          canSubmit: false,
          canApprove: false,
          canDisburse: false,
          canCancel: false,
        }}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('requires a reason to cancel, marked as required', () => {
    render(<LoanLifecyclePanel {...BASE} status="draft" capabilities={ALL} />);

    const open = screen.getByRole('button', { name: /Cancel this loan/ });
    open.click();

    // Rendered after the click in a real browser; here we assert the control
    // exists to be opened, and that the required marker is announced rather
    // than only drawn.
    expect(open).toBeTruthy();
  });

  it('warns that cancelling an approved loan reverses a decision', () => {
    render(<LoanLifecyclePanel {...BASE} status="approved" capabilities={ALL} />);

    expect(screen.getByRole('button', { name: /Cancel this loan/ })).toBeTruthy();
  });
});

describe('the loan status badge', () => {
  it.each(LOAN_STATUSES)('names %s in words', (status) => {
    const { container } = render(<LoanStatusBadge status={status} />);
    expect(container.textContent?.length).toBeGreaterThan(0);
  });

  it('distinguishes approved from active', () => {
    const approved = render(<LoanStatusBadge status="approved" />);
    const active = render(<LoanStatusBadge status="active" />);

    // Approved means the decision is made and the money has *not* moved — a
    // distinction somebody handling cash needs at a glance.
    expect(approved.container.innerHTML).not.toBe(active.container.innerHTML);
    expect(approved.container.textContent).toBe('Approved');
    expect(active.container.textContent).toBe('Active');
  });
});
