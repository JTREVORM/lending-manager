import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgingRegister } from '@/components/delinquency/aging-register';
import { RecoveryTabs } from '@/components/delinquency/recovery-tabs';
import { RiskBreakdown, RiskSummary } from '@/components/delinquency/risk-summary';
import {
  CollateralRegister,
  FollowUpWorklist,
  PromiseRegister,
} from '@/components/delinquency/recovery-worklist';
import { GuarantorExposureRegister } from '@/components/guarantors/guarantor-exposure-register';
import { LoanCollateralPanel } from '@/components/loans/loan-collateral-panel';
import { LoanGuaranteePanel } from '@/components/loans/loan-guarantee-panel';
import { LoanRecoveryPanel } from '@/components/loans/loan-recovery-panel';
import { CollectionSummaryView } from '@/components/payments/collection-summary-view';
import { toUgx } from '@/lib/domain/money';
import { toBusinessDate } from '@/lib/domain/datetime';
import type {
  AgingRow,
  CollateralItem,
  GuarantorExposureRow,
  ParSlice,
  RecoveryAction,
  RecoveryStatusRow,
} from '@/lib/data/security';
import type { CollectionSummary } from '@/lib/data/collections';

/**
 * The Phase 14 screens.
 *
 * What these can check without a database is what the screens *claim*, which
 * on this part of the system is the whole risk. Four claims in particular:
 *
 *   - a PAR of nothing shows as a dash, never as 0.0%;
 *   - a promise is never presented as a change to what is owed;
 *   - a corrected recovery note is shown struck through with its correction,
 *     not replaced by it;
 *   - a guarantee's exposure is stated as the loan's whole balance, with the
 *     reason, so nobody adds the column up and concludes the register is wrong.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/recovery',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/recovery/actions', () => ({
  recordCollateralAction: vi.fn(),
  updateCollateralAction: vi.fn(),
  removeCollateralAction: vi.fn(),
  releaseCollateralAction: vi.fn(),
  realiseCollateralAction: vi.fn(),
  releaseGuarantorAction: vi.fn(),
  recordRecoveryActionAction: vi.fn(),
  correctRecoveryActionAction: vi.fn(),
}));

const LOAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function item(overrides: Partial<CollateralItem> = {}): CollateralItem {
  return {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    loanId: LOAN_ID,
    loanNumber: 'LN260001',
    loanStatus: 'active',
    clientId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
    clientNumber: 'CL26001',
    clientName: 'Nakato Joan',
    clientPhone: '+256771234567',
    productCode: 'BL',
    productName: 'Business Loan',
    itemType: 'motorcycle',
    description: 'Red Bajaj Boxer, fair condition',
    estimatedValue: toUgx(1_500_000),
    valuedOn: toBusinessDate('2026-10-01'),
    serialNumber: 'MD2A11CZ8RWF12345',
    ownershipDocument: null,
    location: null,
    status: 'held',
    releasedAt: null,
    releaseReason: null,
    realisedAmount: null,
    realisedAt: null,
    createdAt: '2026-10-01T09:00:00Z',
    totalOutstanding: toUgx(1_200_000),
    ...overrides,
  };
}

function action(overrides: Partial<RecoveryAction> = {}): RecoveryAction {
  return {
    id: '3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f',
    loanId: LOAN_ID,
    loanNumber: 'LN260001',
    clientName: 'Nakato Joan',
    clientPhone: '+256771234567',
    actionKind: 'call',
    outcome: 'no_answer',
    notes: 'Phone off all morning',
    actionDate: toBusinessDate('2026-10-08'),
    followUpOn: null,
    promisedAmount: null,
    promisedOn: null,
    promisePaidAmount: null,
    promiseStatus: null,
    correctsActionId: null,
    isCorrected: false,
    createdByLabel: 'Aisha Nakimuli',
    createdAt: '2026-10-08T09:00:00Z',
    ...overrides,
  };
}

function guarantee(overrides: Partial<GuarantorExposureRow> = {}): GuarantorExposureRow {
  return {
    loanGuarantorId: '4d5e6f7a-8b9c-4d0e-8f1a-3b4c5d6e7f80',
    loanId: LOAN_ID,
    loanNumber: 'LN260001',
    loanStatus: 'active',
    branchId: '5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8091',
    productId: '6f7a8b9c-0d1e-4f2a-8b3c-5d6e7f809102',
    productCode: 'BL',
    productName: 'Business Loan',
    subjectKind: 'external',
    guarantorName: 'Nabirye Sarah',
    guarantorPhone: '+256771234567',
    guarantorClientNumber: null,
    guarantorClientId: null,
    relationshipToClient: 'Sister',
    clientId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
    clientNumber: 'CL26001',
    clientName: 'Nakato Joan',
    clientPhone: '+256701234567',
    guaranteedAmount: toUgx(2_000_000),
    guaranteedTotal: toUgx(2_400_000),
    outstandingBalance: toUgx(1_200_000),
    arrearsAmount: toUgx(150_000),
    daysPastDue: 12,
    guaranteeDate: '2026-09-28T10:00:00Z',
    consentVersion: '1.0',
    consentSigned: true,
    evidenceFrozenAt: '2026-09-29T08:00:00Z',
    releasedAt: null,
    releaseReason: null,
    isReleased: false,
    guaranteeStatus: 'binding',
    ...overrides,
  };
}

const EMPTY_PAR: ParSlice = {
  scope: 'portfolio',
  branchId: null,
  branchName: null,
  productId: null,
  productCode: null,
  productName: null,
  loanCount: 0,
  principalOutstanding: toUgx(0),
  totalOutstanding: toUgx(0),
  arrearsAmount: toUgx(0),
  loansAtRisk: { 1: 0, 7: 0, 30: 0, 60: 0, 90: 0 },
  principalAtRisk: { 1: toUgx(0), 7: toUgx(0), 30: toUgx(0), 60: toUgx(0), 90: toUgx(0) },
  parBps: { 1: null, 7: null, 30: null, 60: null, 90: null },
  loansByBucket: {
    current: 0,
    '1_7': 0,
    '8_30': 0,
    '31_60': 0,
    '61_90': 0,
    '90_plus': 0,
  },
  principalByBucket: {
    current: toUgx(0),
    '1_7': toUgx(0),
    '8_30': toUgx(0),
    '31_60': toUgx(0),
    '61_90': toUgx(0),
    '90_plus': toUgx(0),
  },
};

const LIVE_PAR: ParSlice = {
  ...EMPTY_PAR,
  loanCount: 20,
  principalOutstanding: toUgx(10_000_000),
  totalOutstanding: toUgx(12_000_000),
  arrearsAmount: toUgx(900_000),
  loansAtRisk: { 1: 8, 7: 6, 30: 4, 60: 2, 90: 1 },
  principalAtRisk: {
    1: toUgx(4_000_000),
    7: toUgx(3_000_000),
    30: toUgx(2_000_000),
    60: toUgx(1_000_000),
    90: toUgx(400_000),
  },
  parBps: { 1: 4000, 7: 3000, 30: 2000, 60: 1000, 90: 400 },
  loansByBucket: {
    current: 12,
    '1_7': 2,
    '8_30': 2,
    '31_60': 2,
    '61_90': 1,
    '90_plus': 1,
  },
  principalByBucket: {
    current: toUgx(6_000_000),
    '1_7': toUgx(1_000_000),
    '8_30': toUgx(1_000_000),
    '31_60': toUgx(1_000_000),
    '61_90': toUgx(600_000),
    '90_plus': toUgx(400_000),
  },
};

// ---------------------------------------------------------------------------
describe('risk monitoring', () => {
  it('states PAR with the principal behind each ratio', () => {
    render(<RiskSummary slice={LIVE_PAR} />);

    expect(screen.getByText('PAR 1')).toBeInTheDocument();
    expect(screen.getByText('PAR 90')).toBeInTheDocument();
    expect(screen.getByText('40.0%')).toBeInTheDocument();
    expect(screen.getByText('4.0%')).toBeInTheDocument();
  });

  it('says what the ratio divides by, in words', () => {
    render(<RiskSummary slice={LIVE_PAR} />);

    // Principal only. Using total outstanding or the arrears figure are the
    // two substitutions that quietly turn PAR into a different ratio that
    // happens to share its name.
    expect(screen.getByText(/over total\s+outstanding principal/i)).toBeInTheDocument();
  });

  it('shows no PAR at all for a book with no active loans', () => {
    render(<RiskSummary slice={EMPTY_PAR} />);

    expect(
      screen.getByText(/no active loans, so there is no portfolio/i),
    ).toBeInTheDocument();
    // And no percentage anywhere, because 0.0% would read as perfect health.
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('leaves the current bucket out of the chart and says why', () => {
    render(<RiskSummary slice={LIVE_PAR} />);

    expect(screen.getByText(/leaves out loans that are current/i)).toBeInTheDocument();
  });

  it('renders no breakdown table for a single slice', () => {
    const { container } = render(
      <RiskBreakdown
        heading="By branch"
        caption="Portfolio at risk by branch"
        slices={[{ ...LIVE_PAR, scope: 'branch', branchName: 'Head office' }]}
        nameOf={(slice) => slice.branchName ?? 'No branch'}
      />,
    );

    // One slice is the whole portfolio under another name, and a table with a
    // single row says nothing the summary above it did not.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a breakdown once there is more than one slice', () => {
    render(
      <RiskBreakdown
        heading="By branch"
        caption="Portfolio at risk by branch"
        slices={[
          { ...LIVE_PAR, scope: 'branch', branchName: 'Head office' },
          { ...LIVE_PAR, scope: 'branch', branchName: 'Nsumbi' },
        ]}
        nameOf={(slice) => slice.branchName ?? 'No branch'}
      />,
    );

    expect(screen.getByText('Head office')).toBeInTheDocument();
    expect(screen.getByText('Nsumbi')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('the aging register', () => {
  const ROWS: readonly AgingRow[] = [
    {
      loanId: LOAN_ID,
      loanNumber: 'LN260001',
      loanStatus: 'arrears',
      branchId: null,
      branchName: 'Head office',
      productId: '6f7a8b9c-0d1e-4f2a-8b3c-5d6e7f809102',
      productCode: 'BL',
      productName: 'Business Loan',
      clientId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
      clientNumber: 'CL26001',
      clientName: 'Nakato Joan',
      clientPhone: '+256771234567',
      principalAmount: toUgx(2_000_000),
      principalRemaining: toUgx(1_000_000),
      penaltyRemaining: toUgx(0),
      totalOutstanding: toUgx(1_200_000),
      arrearsAmount: toUgx(150_000),
      missedInstallmentCount: 3,
      daysPastDue: 45,
      oldestPastDueDate: toBusinessDate('2026-08-26'),
      delinquencyState: 'in_arrears',
      penaltyApplied: false,
      agingBucket: '31_60',
      agingRank: 3,
      lastPaymentDate: toBusinessDate('2026-09-01'),
    },
  ];

  it('puts a count on every bucket chip', () => {
    render(
      <AgingRegister
        rows={ROWS}
        page={1}
        hasMore={false}
        slice={LIVE_PAR}
        businessDate="2026-10-10"
      />,
    );

    expect(screen.getByRole('button', { name: 'All active (20)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '31–60 days (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Over 90 days (1)' })).toBeInTheDocument();
  });

  it('names the bucket a loan is in rather than leaving the reader to count days', () => {
    render(
      <AgingRegister
        rows={ROWS}
        page={1}
        hasMore={false}
        slice={LIVE_PAR}
        businessDate="2026-10-10"
      />,
    );

    const table = screen.getByRole('table');
    expect(within(table).getByText('31–60 days')).toBeInTheDocument();
    expect(within(table).getByText('45')).toBeInTheDocument();
  });

  it('says the grace period is already taken off the days it shows', () => {
    render(
      <AgingRegister
        rows={ROWS}
        page={1}
        hasMore={false}
        slice={LIVE_PAR}
        businessDate="2026-10-10"
      />,
    );

    expect(screen.getByText(/net of each product's grace period/i)).toBeInTheDocument();
  });

  it('distinguishes an empty filter from an empty book', () => {
    render(
      <AgingRegister
        rows={[]}
        page={1}
        hasMore={false}
        slice={LIVE_PAR}
        businessDate="2026-10-10"
      />,
    );

    expect(screen.getByText(/not the same as nothing being late/i)).toBeInTheDocument();
  });

  it('offers the five views of Debt & Security as links', () => {
    render(<RecoveryTabs view="" />);

    expect(screen.getByRole('button', { name: 'Aging' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'Risk monitoring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Promises to pay' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Security held' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('security on a loan', () => {
  it('shows cover and exposure side by side, and refuses to imply one pays the other', () => {
    render(
      <LoanCollateralPanel
        loanId={LOAN_ID}
        items={[item()]}
        editable={false}
        canManage={false}
        collateralRequired
      />,
    );

    expect(screen.getByText('Items held')).toBeInTheDocument();
    expect(screen.getByText('Loan outstanding')).toBeInTheDocument();
    expect(
      screen.getByText(/not a figure any balance is computed from/i),
    ).toBeInTheDocument();
  });

  it('warns when a product expects security and none is held', () => {
    render(
      <LoanCollateralPanel
        loanId={LOAN_ID}
        items={[]}
        editable
        canManage
        collateralRequired
      />,
    );

    expect(screen.getByText(/This product expects security/i)).toBeInTheDocument();
  });

  it('keeps a released item on the list rather than hiding it', () => {
    render(
      <LoanCollateralPanel
        loanId={LOAN_ID}
        items={[
          item({
            status: 'released',
            releasedAt: '2026-10-05T10:00:00Z',
            releaseReason: 'Secured on land instead',
          }),
        ]}
        editable={false}
        canManage={false}
        collateralRequired={false}
      />,
    );

    // A loan whose security was handed back in March and which went into
    // arrears in June is a specific story; hiding the release tells another.
    expect(screen.getByText('Released')).toBeInTheDocument();
    expect(screen.getByText(/Secured on land instead/)).toBeInTheDocument();
  });

  it('offers release and sale on a live loan, and removal only on an application', () => {
    const { unmount } = render(
      <LoanCollateralPanel
        loanId={LOAN_ID}
        items={[item()]}
        editable={false}
        canManage
        collateralRequired={false}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Release to the borrower/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record a sale/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove from the application/i }),
    ).toBeNull();

    unmount();

    render(
      <LoanCollateralPanel
        loanId={LOAN_ID}
        items={[item({ loanStatus: 'draft' })]}
        editable
        canManage
        collateralRequired={false}
      />,
    );

    expect(
      screen.getByRole('button', { name: /Remove from the application/i }),
    ).toBeInTheDocument();
  });

  it('offers nothing at all without collateral:manage', () => {
    render(
      <LoanCollateralPanel
        loanId={LOAN_ID}
        items={[item()]}
        editable
        canManage={false}
        collateralRequired={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /Release to the borrower/i })).toBeNull();
    expect(screen.queryByText('Record security')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the recovery panel', () => {
  const STATUS: RecoveryStatusRow = {
    loanId: LOAN_ID,
    loanNumber: 'LN260001',
    loanStatus: 'arrears',
    branchId: null,
    clientId: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e',
    clientNumber: 'CL26001',
    clientName: 'Nakato Joan',
    clientPhone: '+256771234567',
    productCode: 'BL',
    productName: 'Business Loan',
    arrearsAmount: toUgx(150_000),
    daysPastDue: 45,
    delinquencyState: 'in_arrears',
    totalOutstanding: toUgx(1_200_000),
    actionCount: 3,
    lastActionDate: toBusinessDate('2026-10-08'),
    lastActionKind: 'call',
    lastActionNotes: 'Phone off all morning',
    lastActionBy: 'Aisha Nakimuli',
    nextFollowUpOn: null,
    overdueFollowUpOn: toBusinessDate('2026-10-02'),
    openPromiseAmount: toUgx(200_000),
    openPromiseOn: toBusinessDate('2026-10-12'),
    openPromiseStatus: 'pending',
  };

  it('says when a loan was last worked, and by whom', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[action()]}
        canRecord
        today="2026-10-10"
      />,
    );

    expect(screen.getByText('Last worked')).toBeInTheDocument();
    expect(screen.getByText('Actions recorded')).toBeInTheDocument();
  });

  it('flags a follow-up that was missed', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[action()]}
        canRecord
        today="2026-10-10"
      />,
    );

    expect(screen.getByText(/A follow-up was due on/i)).toBeInTheDocument();
  });

  it('never presents a promise as a change to what is owed', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[action()]}
        canRecord
        today="2026-10-10"
      />,
    );

    // The arrears figure and the promise are both on screen, and the promise
    // is explicitly described as awaiting rather than as a rescheduling.
    // Matched on the container's text because the sentence is assembled from
    // several nodes — the amount and the date are their own elements.
    expect(
      screen.getAllByText((_content, element) =>
        (element?.textContent ?? '').includes('awaiting'),
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/The date has not passed yet/i)).toBeInTheDocument();
    expect(screen.getByText('In arrears')).toBeInTheDocument();
  });

  it('shows a corrected note struck through, with the correction beneath it', () => {
    const original = action({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      notes: 'Promised 300,000 — wrong loan, this was the brother',
      isCorrected: true,
    });

    const correction = action({
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      actionKind: 'correction',
      outcome: null,
      notes: 'The call above was about a different borrower.',
      correctsActionId: original.id,
    });

    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[original, correction]}
        canRecord
        today="2026-10-10"
      />,
    );

    const struck = screen.getByText(/wrong loan, this was the brother/);
    expect(struck.className).toContain('line-through');

    expect(screen.getByText('Correction')).toBeInTheDocument();
    expect(
      screen.getByText('The call above was about a different borrower.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Corrected')).toBeInTheDocument();
  });

  it('does not offer to correct an entry that was already corrected', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[action({ isCorrected: true })]}
        canRecord
        today="2026-10-10"
      />,
    );

    expect(screen.queryByRole('button', { name: /Correct this entry/i })).toBeNull();
  });

  it('shows what was paid against a promise, so the verdict is checkable', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[
          action({
            actionKind: 'promise',
            outcome: 'promised_to_pay',
            notes: 'Will pay on Friday',
            promisedAmount: toUgx(200_000),
            promisedOn: toBusinessDate('2026-10-12'),
            promisePaidAmount: toUgx(50_000),
            promiseStatus: 'pending',
          }),
        ]}
        canRecord
        today="2026-10-10"
      />,
    );

    expect(screen.getByText(/paid in that window/i)).toBeInTheDocument();
  });

  it('offers no form at all without recovery:record', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={STATUS}
        actions={[action()]}
        canRecord={false}
        today="2026-10-10"
      />,
    );

    expect(screen.queryByText('Record what was done')).toBeNull();
    expect(screen.queryByRole('button', { name: /Correct this entry/i })).toBeNull();
  });

  it('says plainly that nothing has been recorded, rather than showing an empty list', () => {
    render(
      <LoanRecoveryPanel
        loanId={LOAN_ID}
        status={null}
        actions={[]}
        canRecord={false}
        today="2026-10-10"
      />,
    );

    expect(
      screen.getByText(/Nothing has been recorded against this loan/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('guarantees on a loan', () => {
  it('explains that two guarantors each carry the whole exposure', () => {
    render(
      <LoanGuaranteePanel
        loanId={LOAN_ID}
        guarantees={[
          guarantee(),
          guarantee({
            loanGuarantorId: 'bbbbbbbb-0000-4000-8000-000000000002',
            guarantorName: 'Okello Peter',
          }),
        ]}
        canRelease={false}
      />,
    );

    expect(screen.getByText(/stand for this loan jointly/i)).toBeInTheDocument();
    expect(screen.getByText(/not a division of the debt/i)).toBeInTheDocument();
  });

  it('distinguishes a discharged guarantee from a released one', () => {
    const { unmount } = render(
      <LoanGuaranteePanel
        loanId={LOAN_ID}
        guarantees={[guarantee({ guaranteeStatus: 'discharged' })]}
        canRelease={false}
      />,
    );

    expect(
      screen.getByText(/Ended when the borrower cleared the loan/i),
    ).toBeInTheDocument();
    unmount();

    render(
      <LoanGuaranteePanel
        loanId={LOAN_ID}
        guarantees={[
          guarantee({
            guaranteeStatus: 'released',
            isReleased: true,
            releasedAt: '2026-10-05T10:00:00Z',
            releaseReason: 'Replaced by the borrower’s sister',
          }),
        ]}
        canRelease={false}
      />,
    );

    expect(
      screen.getByText(/Let out of the guarantee by the business/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Replaced by the borrower/)).toBeInTheDocument();
  });

  it('offers the release only to a holder of the capability', () => {
    const { unmount } = render(
      <LoanGuaranteePanel
        loanId={LOAN_ID}
        guarantees={[guarantee()]}
        canRelease={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /Release this guarantor/i })).toBeNull();
    unmount();

    render(<LoanGuaranteePanel loanId={LOAN_ID} guarantees={[guarantee()]} canRelease />);

    expect(
      screen.getByRole('button', { name: /Release this guarantor/i }),
    ).toBeInTheDocument();
  });

  it('does not offer a release on an already released guarantee', () => {
    render(
      <LoanGuaranteePanel
        loanId={LOAN_ID}
        guarantees={[
          guarantee({ isReleased: true, guaranteeStatus: 'released', releasedAt: 'x' }),
        ]}
        canRelease
      />,
    );

    expect(screen.queryByRole('button', { name: /Release this guarantor/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the registers across the book', () => {
  it('says why a promise register column reads as it does', () => {
    render(
      <PromiseRegister
        promises={[
          action({
            actionKind: 'promise',
            promisedAmount: toUgx(200_000),
            promisedOn: toBusinessDate('2026-10-12'),
            promisePaidAmount: toUgx(0),
            promiseStatus: 'pending',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Paid in the window')).toBeInTheDocument();
    expect(screen.getByText(/a reversal un-keeps one on its own/i)).toBeInTheDocument();
  });

  it('calls an unmet promise "not kept" rather than characterising the borrower', () => {
    render(
      <PromiseRegister
        promises={[
          action({
            actionKind: 'promise',
            promisedAmount: toUgx(200_000),
            promisedOn: toBusinessDate('2026-10-01'),
            promisePaidAmount: toUgx(0),
            promiseStatus: 'broken',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Not kept')).toBeInTheDocument();
  });

  it('explains that a follow-up comes from a recorded action, not from arrears', () => {
    render(<FollowUpWorklist rows={[]} />);

    expect(screen.getByText(/No follow-up is outstanding/i)).toBeInTheDocument();
  });

  it('shows the security register with the loan it secures', () => {
    render(
      <CollateralRegister
        items={[
          {
            id: item().id,
            loanId: LOAN_ID,
            loanNumber: 'LN260001',
            clientName: 'Nakato Joan',
            productCode: 'BL',
            itemTypeLabel: 'Motorcycle',
            description: 'Red Bajaj Boxer',
            estimatedValue: 1_500_000,
            valuedOn: '2026-10-01',
            statusLabel: 'Held',
            totalOutstanding: 1_200_000,
          },
        ]}
      />,
    );

    expect(screen.getByText('Motorcycle')).toBeInTheDocument();
    expect(screen.getByText('Loan owes')).toBeInTheDocument();
    expect(
      screen.getByText(/Realising an item reduces a loan only through the payment/i),
    ).toBeInTheDocument();
  });

  it('states the guarantor register’s exposure rule under the table', () => {
    render(
      <GuarantorExposureRegister
        rows={[guarantee()]}
        page={1}
        hasMore={false}
        products={[{ id: guarantee().productId, label: 'BL — Business Loan' }]}
      />,
    );

    expect(screen.getByText(/does not\s+sum to the loan book/i)).toBeInTheDocument();
  });

  it('offers the guarantor register’s three filters', () => {
    render(
      <GuarantorExposureRegister
        rows={[guarantee()]}
        page={1}
        hasMore={false}
        products={[{ id: guarantee().productId, label: 'BL — Business Loan' }]}
      />,
    );

    expect(screen.getByLabelText('Guarantor type')).toBeInTheDocument();
    expect(screen.getByLabelText('Guarantee status')).toBeInTheDocument();
    expect(screen.getByLabelText('Loan product')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('the collection summary', () => {
  const SUMMARY: CollectionSummary = {
    from: toBusinessDate('2026-09-11'),
    to: toBusinessDate('2026-10-10'),
    paymentCount: 9,
    reversedCount: 1,
    totalCollected: toUgx(450_000),
    principalCollected: toUgx(300_000),
    interestCollected: toUgx(140_000),
    penaltyCollected: toUgx(10_000),
    byMethod: [
      {
        key: 'cash',
        label: 'cash',
        paymentCount: 6,
        reversedCount: 1,
        totalCollected: toUgx(300_000),
        principalCollected: toUgx(200_000),
        interestCollected: toUgx(95_000),
        penaltyCollected: toUgx(5_000),
      },
      {
        key: 'mtn_mobile_money',
        label: 'mtn_mobile_money',
        paymentCount: 3,
        reversedCount: 0,
        totalCollected: toUgx(150_000),
        principalCollected: toUgx(100_000),
        interestCollected: toUgx(45_000),
        penaltyCollected: toUgx(5_000),
      },
    ],
    byStaff: [
      {
        key: 'aaaaaaaa-0000-4000-8000-000000000001',
        label: 'Aisha Nakimuli',
        paymentCount: 9,
        reversedCount: 1,
        totalCollected: toUgx(450_000),
        principalCollected: toUgx(300_000),
        interestCollected: toUgx(140_000),
        penaltyCollected: toUgx(10_000),
      },
    ],
    byBranch: [],
    byProduct: [],
    byDay: [],
    complete: true,
  };

  it('names the payment methods rather than their database values', () => {
    render(<CollectionSummaryView summary={SUMMARY} />);

    // Once in the table and once in the chart beside it.
    expect(screen.getAllByText('MTN Mobile Money').length).toBeGreaterThan(0);
    expect(screen.queryByText('mtn_mobile_money')).toBeNull();
  });

  it('reports reversals beside the receipts rather than netting them away', () => {
    render(<CollectionSummaryView summary={SUMMARY} />);

    expect(screen.getByText(/9 receipts · 1 reversed/)).toBeInTheDocument();
  });

  it('says principal collected is not revenue', () => {
    render(<CollectionSummaryView summary={SUMMARY} />);

    expect(
      screen.getByText(
        /Principal collected is a reduction of what is owed, not revenue/i,
      ),
    ).toBeInTheDocument();
  });

  it('refuses to be trusted when it could not read the whole period', () => {
    render(<CollectionSummaryView summary={{ ...SUMMARY, complete: false }} />);

    expect(screen.getByText(/every figure\s+below is understated/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not bank from this\s+screen/i)).toBeInTheDocument();
  });

  it('says plainly when a slice collected nothing', () => {
    render(<CollectionSummaryView summary={SUMMARY} />);

    // byBranch and byProduct are empty here.
    expect(
      screen.getAllByText(/Nothing was collected in this period/i).length,
    ).toBeGreaterThan(0);
  });
});
