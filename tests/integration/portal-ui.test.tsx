import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PortalLoanCard } from '@/components/portal/portal-loan-card';
import { LoanStatementView } from '@/components/reports/loan-statement';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import type { LoanDelinquency } from '@/lib/data/delinquency';
import type {
  LoanStatement,
  PortfolioRow,
  StatementPaymentRow,
  StatementScheduleRow,
} from '@/lib/data/reports';

/**
 * The borrower's portal, after Phase 8.
 *
 * ## The two things that matter most here
 *
 * **Nothing internal reaches a borrower.** Not a staff name, not a note
 * written about them, not another borrower's anything, not a guarantor's
 * details. A note written for internal use appearing in a borrower's own
 * account would be the worst leak this system could have, so it is asserted
 * rather than assumed.
 *
 * **The language is the borrower's.** "Amount borrowed", not principal.
 * "Total to repay", not total expected repayment. No obligation, no
 * allocation, no basis points, no delinquency state, no `security_invoker`.
 * A borrower who cannot read their own statement cannot check it, and a
 * statement nobody checks is not evidence of anything.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/portal',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const TIMEZONE = 'Africa/Kampala';
const ZERO = toUgx(0);

const position = (overrides: Partial<LoanDelinquency> = {}): LoanDelinquency => ({
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  clientId: 'client-1',
  loanStatus: 'active',
  businessDate: toBusinessDate('2026-10-04'),
  installmentCount: 25,
  firstDueDate: toBusinessDate('2026-09-02'),
  scheduledCompletionDate: toBusinessDate('2026-10-01'),
  scheduledTotal: toUgx(600_000),
  scheduledDueToDate: toUgx(600_000),
  paidAgainstSchedule: toUgx(200_000),
  arrearsAmount: toUgx(24_000),
  dueToday: toUgx(4_000),
  currentDue: toUgx(28_000),
  missedInstallmentCount: 6,
  oldestUnpaidDueDate: toBusinessDate('2026-09-28'),
  oldestPastDueDate: toBusinessDate('2026-09-28'),
  daysPastDue: 6,
  graceDays: 3,
  graceEndDate: toBusinessDate('2026-10-04'),
  penaltyEffectiveDate: toBusinessDate('2026-10-05'),
  pastFinalDueDate: true,
  withinGracePeriod: true,
  contractualOutstanding: toUgx(400_000),
  penaltyAmount: ZERO,
  penaltyPaid: ZERO,
  penaltyRemaining: ZERO,
  totalOutstanding: toUgx(400_000),
  penaltyApplied: false,
  penaltyEligible: false,
  penaltyProjectedAmount: ZERO,
  penaltyId: null,
  penaltyBasisAmount: null,
  penaltyAppliedEffectiveDate: null,
  penaltyRateBps: 5_000,
  penaltyBasisAsOfGraceEnd: toUgx(400_000),
  state: 'in_arrears',
  reconciles: true,
  reconciliationProblem: null,
  ...overrides,
});

const contract = (overrides: Partial<PortfolioRow> = {}): PortfolioRow => ({
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  clientName: 'Nakimuli Zainabu',
  clientPhone: '+256700000001',
  clientNameAtOrigination: 'Nakimuli Zainabu',
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

const schedule: readonly StatementScheduleRow[] = [
  {
    installmentNumber: 1,
    dueDate: toBusinessDate('2026-09-02'),
    expectedAmount: toUgx(24_000),
    scheduledPrincipal: toUgx(20_000),
    scheduledInterest: toUgx(4_000),
    allocatedAmount: toUgx(24_000),
    remainingAmount: ZERO,
  },
  {
    installmentNumber: 2,
    dueDate: toBusinessDate('2026-09-03'),
    expectedAmount: toUgx(24_000),
    scheduledPrincipal: toUgx(20_000),
    scheduledInterest: toUgx(4_000),
    allocatedAmount: ZERO,
    remainingAmount: toUgx(24_000),
  },
];

const payments: readonly StatementPaymentRow[] = [
  {
    paymentId: 'p1',
    paymentNumber: 'RC-2026-00001',
    businessDate: toBusinessDate('2026-09-02'),
    receivedAt: '2026-09-02T07:30:00Z',
    amount: toUgx(24_000),
    effectiveAmount: toUgx(24_000),
    paymentMethod: 'cash',
    status: 'posted',
    isEffective: true,
    principalCollected: toUgx(20_000),
    interestCollected: toUgx(4_000),
    penaltyCollected: ZERO,
  },
  {
    paymentId: 'p2',
    paymentNumber: 'RC-2026-00002',
    businessDate: toBusinessDate('2026-09-05'),
    receivedAt: '2026-09-05T07:30:00Z',
    amount: toUgx(24_000),
    effectiveAmount: ZERO,
    paymentMethod: 'mtn_mobile_money',
    status: 'reversed',
    isEffective: false,
    principalCollected: ZERO,
    interestCollected: ZERO,
    penaltyCollected: ZERO,
  },
];

const statement = (overrides: Partial<LoanStatement> = {}): LoanStatement => ({
  loan: contract(),
  schedule,
  payments,
  penalty: null,
  ...overrides,
});

// ===========================================================================
describe("a borrower's loan card", () => {
  it('shows the agreement in business language', () => {
    render(<PortalLoanCard position={position()} loan={contract()} />);

    expect(screen.getByText('Amount borrowed')).toBeInTheDocument();
    expect(screen.getByText('Total interest')).toBeInTheDocument();
    expect(screen.getByText('Total to repay')).toBeInTheDocument();
    expect(screen.getByText('Amount paid so far')).toBeInTheDocument();
    expect(screen.getByText('Loan completion date')).toBeInTheDocument();
  });

  it('uses no internal vocabulary', () => {
    render(<PortalLoanCard position={position()} loan={contract()} />);

    // "In arrears" stays: it is the Phase 7 status label, and it is plain
    // English a borrower reads correctly. What must not appear is the
    // vocabulary of the implementation — the words that only mean something
    // if you have read the schema.
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const word of [
      'principal',
      'obligation',
      'allocation',
      'basis point',
      'bps',
      'delinquency',
      'security_invoker',
      'coverage',
      'ledger',
    ]) {
      expect(text, word).not.toContain(word);
    }
  });

  it('shows the figures it is given, unchanged', () => {
    render(<PortalLoanCard position={position()} loan={contract()} />);

    expect(screen.getByText('UGX 500,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 100,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 600,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 200,000')).toBeInTheDocument();
  });

  it('shows a late-payment charge only when there is one', () => {
    const { unmount } = render(
      <PortalLoanCard position={position()} loan={contract()} />,
    );
    expect(screen.queryByText('Late-payment charge')).toBeNull();
    unmount();

    render(
      <PortalLoanCard
        position={position({
          penaltyApplied: true,
          penaltyAmount: toUgx(200_000),
          penaltyRemaining: toUgx(200_000),
          penaltyAppliedEffectiveDate: toBusinessDate('2026-10-05'),
          totalOutstanding: toUgx(600_000),
          state: 'penalty_due',
        })}
        loan={contract({ penaltyAssessed: toUgx(200_000) })}
      />,
    );

    expect(screen.getByText('Late-payment charge')).toBeInTheDocument();
  });

  it('links to the full statement', () => {
    render(<PortalLoanCard position={position()} loan={contract()} />);

    expect(
      screen.getByRole('link', {
        name: /See the full statement, payment plan and receipts/,
      }),
    ).toHaveAttribute('href', '/portal/loans/loan-1');
  });

  it('survives a missing contract rather than breaking the page', () => {
    // Not expected, but a borrower's own account page failing outright because
    // one join came back empty is a worse outcome than a card with less on it.
    render(<PortalLoanCard position={position()} loan={undefined} />);

    expect(screen.getAllByText(/LN-2026-00001/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Amount borrowed')).toBeNull();
  });
});

// ===========================================================================
describe("a borrower's statement", () => {
  it('uses business language throughout', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Amount borrowed')).toBeInTheDocument();
    expect(screen.getByText('Total interest')).toBeInTheDocument();
    expect(screen.getByText('Amount paid')).toBeInTheDocument();
    expect(screen.getByText('Outstanding balance')).toBeInTheDocument();
    expect(screen.getByText('Current amount due')).toBeInTheDocument();
    expect(screen.getByText('Past unpaid amount')).toBeInTheDocument();
    expect(screen.getByText('Loan completion date')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Payment plan' })).toBeInTheDocument();
  });

  it('never shows who recorded a payment', () => {
    // Staff attribution is internal information about the business's own
    // people. The borrower needs the receipt number, the date and the amount.
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Recorded by');
    expect(document.body.textContent).not.toMatch(/recorded by/i);
  });

  it('does not link a borrower into the staff payment register', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    // queryAllByRole, not getAllByRole: a borrower's statement having no
    // links at all is the correct outcome, and `get*` would throw on it.
    const links = screen.queryAllByRole('link').map((link) => link.getAttribute('href'));

    expect(links.some((href) => href?.startsWith('/payments'))).toBe(false);
    expect(links.some((href) => href?.startsWith('/clients'))).toBe(false);
    expect(links.some((href) => href?.startsWith('/reports'))).toBe(false);
  });

  it('links a staff reader to the receipt it lists', () => {
    // §34: a statement's payment lines reach their receipts. For staff that is
    // the register; a borrower gets the receipt number to quote instead.
    render(
      <LoanStatementView
        statement={statement()}
        audience="staff"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getAllByRole('link', { name: 'RC-2026-00001' })[0]).toHaveAttribute(
      'href',
      '/payments/p1',
    );
  });

  it('keeps a withdrawn payment on the statement, marked', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getAllByText('RC-2026-00002').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Withdrawn').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/stays on this statement so the history is complete/i),
    ).toBeInTheDocument();
  });

  it('states the two relationships between its figures', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(
      screen.getByText(/Amount paid plus outstanding balance equals the total to repay/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/it is not the whole outstanding balance/i),
    ).toBeInTheDocument();
  });

  it('carries the borrower as they were when the loan was agreed', () => {
    // §33. A borrower who married in April did not change who signed in March,
    // and the statement must match the paperwork they hold.
    render(
      <LoanStatementView
        statement={statement({
          loan: contract({
            clientName: 'Nakimuli Zainabu Ssali',
            clientNameAtOrigination: 'Nakimuli Zainabu',
          }),
        })}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Nakimuli Zainabu')).toBeInTheDocument();
    expect(screen.getByText('Now known as')).toBeInTheDocument();
    expect(screen.getByText('Nakimuli Zainabu Ssali')).toBeInTheDocument();
    expect(
      screen.getByText(/the one recorded when this loan was agreed/i),
    ).toBeInTheDocument();
  });

  it('shows no "now known as" line when the name has not changed', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.queryByText('Now known as')).toBeNull();
  });

  it('explains a charge with its own arithmetic', () => {
    render(
      <LoanStatementView
        statement={statement({
          penalty: {
            penaltyId: 'pen-1',
            loanId: 'loan-1',
            loanNumber: 'LN-2026-00001',
            clientId: 'client-1',
            clientNumber: 'CL-2026-00001',
            clientName: 'Nakimuli Zainabu',
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
          },
        })}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    // The rule, in the borrower's own figures: 50% of the 400,000 still owed
    // when grace ended. Matched against the rendered text rather than one
    // node, because the sentence is assembled from several.
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/A charge of UGX 200,000 applies from 5 Oct 2026/);
    expect(text).toMatch(/50% of the UGX 400,000 that was still owed/);
    expect(text).toMatch(/grace period ended on 4 Oct 2026/);
    expect(text).toMatch(/UGX 200,000 of it is still to pay/);
    expect(text).toMatch(/charge for settling late/);
    expect(text).toMatch(/not interest, and it is charged\s+once/);
  });

  it('says plainly that the figures are today"s, not frozen', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText(/as at 4 Oct 2026/)).toBeInTheDocument();
    expect(
      screen.getByText(/These figures are what our records show today/i),
    ).toBeInTheDocument();
  });

  it('carries the company name, for a document that leaves the building', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Example Lending')).toBeInTheDocument();
  });

  it('shows no internal note, for either audience', () => {
    // §39 and §119. Internal remarks are not on this page for anybody; they
    // live on the client record behind `clients:remarks_view`.
    for (const audience of ['client', 'staff'] as const) {
      const { unmount } = render(
        <LoanStatementView
          statement={statement()}
          audience={audience}
          companyName="Example Lending"
          businessDate="2026-10-04"
          timeZone={TIMEZONE}
        />,
      );

      const text = (document.body.textContent ?? '').toLowerCase();
      expect(text, audience).not.toContain('remark');
      expect(text, audience).not.toContain('internal note');
      unmount();
    }
  });

  it('shows no guarantor details', () => {
    // §75. A guarantor's phone number and identity belong to the guarantor.
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect((document.body.textContent ?? '').toLowerCase()).not.toContain('guarantor');
  });

  it('shows no identification number', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    const text = (document.body.textContent ?? '').toLowerCase();
    expect(text).not.toContain('nin');
    expect(text).not.toContain('identification');
  });

  it('marks which scheduled payments are settled', () => {
    render(
      <LoanStatementView
        statement={statement()}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Payment 1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Payment 2').length).toBeGreaterThan(0);
  });

  it('explains a loan with no payments yet', () => {
    render(
      <LoanStatementView
        statement={statement({ payments: [] })}
        audience="client"
        companyName="Example Lending"
        businessDate="2026-10-04"
        timeZone={TIMEZONE}
      />,
    );

    expect(
      screen.getByText(/No payments have been recorded against this loan yet/i),
    ).toBeInTheDocument();
  });
});
