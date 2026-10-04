import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CollectionSheet } from '@/components/dashboard/collection-sheet';
import { ExecutiveCards } from '@/components/dashboard/executive-cards';
import { LoanActivity } from '@/components/dashboard/loan-activity';
import { PortfolioCards } from '@/components/dashboard/portfolio-cards';
import { RecentPayments } from '@/components/dashboard/recent-payments';
import { TodayCards } from '@/components/dashboard/today-cards';
import { UpcomingCollections } from '@/components/dashboard/upcoming-collections';
import { StatCard } from '@/components/reports/stat-card';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { METRIC_DEFINITIONS } from '@/lib/domain/reporting';
import type {
  CollectionSheetRow,
  CollectionSummary,
  LoanActivityRow,
  PortfolioSummary,
  RecentPayment,
  UpcomingCollection,
} from '@/lib/data/dashboard';

/**
 * The Phase 8 dashboards.
 *
 * ## What these assertions are for
 *
 * A dashboard that looks good and shows the wrong financial number is a
 * financial defect, and the ways that happens are specific:
 *
 *   - a figure with a three-word label and no stated meaning, which two people
 *     then act on for different reasons;
 *   - "expected minus collected" presented as what remains, which it is not;
 *   - a method split described as a cash position the system cannot support;
 *   - interest called profit;
 *   - a reversed payment shown as money in hand;
 *   - a prepaid collection listed as due;
 *   - a blank card where a query failed, indistinguishable from a true zero.
 *
 * Each has a test below. Where a figure is rendered, the value asserted is the
 * one passed in — these components display, they do not compute, and a test
 * that recomputed the expectation would be checking the wrong thing.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const TIMEZONE = 'Africa/Kampala';

const collectionSummary: CollectionSummary = {
  businessDate: toBusinessDate('2026-10-04'),
  expectedToday: toUgx(120_000),
  remainingToday: toUgx(40_000),
  loansDueToday: 30,
  clientsDueToday: 28,
  loansSettledToday: 20,
  collectedToday: toUgx(95_000),
  paymentsToday: 22,
  clientsPayingToday: 21,
  cashReceived: toUgx(60_000),
  mtnReceived: toUgx(25_000),
  airtelReceived: toUgx(10_000),
  principalCollected: toUgx(76_000),
  interestCollected: toUgx(15_000),
  penaltyCollected: toUgx(4_000),
  reversedTodayAmount: toUgx(8_000),
  reversedTodayCount: 1,
};

const portfolioSummary: PortfolioSummary = {
  businessDate: toBusinessDate('2026-10-04'),
  totalClients: 140,
  activeClients: 120,
  inactiveClients: 10,
  suspendedClients: 4,
  blacklistedClients: 3,
  archivedClients: 3,
  clientsWithActiveLoan: 90,
  loansTotal: 210,
  loansDraft: 4,
  loansPendingApproval: 2,
  loansApproved: 1,
  loansActive: 95,
  loansCleared: 100,
  loansCancelled: 8,
  principalDisbursed: toUgx(180_000_000),
  contractualInterest: toUgx(45_000_000),
  contractualExpected: toUgx(225_000_000),
  contractCollected: toUgx(150_000_000),
  principalCollected: toUgx(120_000_000),
  interestCollected: toUgx(30_000_000),
  penaltyCollected: toUgx(1_500_000),
  totalCollected: toUgx(151_500_000),
  postedPaymentTotal: toUgx(151_500_000),
  contractualOutstanding: toUgx(75_000_000),
  principalOutstanding: toUgx(60_000_000),
  interestOutstanding: toUgx(15_000_000),
  penaltyAssessed: toUgx(4_000_000),
  penaltyOutstanding: toUgx(2_500_000),
  totalOutstanding: toUgx(77_500_000),
  byState: {
    current: 60,
    due_today: 8,
    in_arrears: 14,
    grace_period: 5,
    expired_unpaid: 3,
    penalty_due: 5,
    cleared: 100,
  },
  loansWithSchedule: 195,
  loansWithArrears: 27,
  loansPenalised: 5,
  loansPenaltyPending: 3,
  arrearsTotal: toUgx(6_400_000),
  dueTodayTotal: toUgx(40_000),
  currentDueTotal: toUgx(6_440_000),
};

const sheetRow = (overrides: Partial<CollectionSheetRow> = {}): CollectionSheetRow => ({
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  loanStatus: 'active',
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  clientName: 'Nakimuli Zainabu',
  clientPhone: '+256700000001',
  installmentNumber: 7,
  scheduledAmount: toUgx(4_000),
  expectedToday: toUgx(4_000),
  collectedToday: toUgx(0),
  paymentsToday: 0,
  remainingToday: toUgx(4_000),
  arrearsAmount: toUgx(8_000),
  currentDue: toUgx(12_000),
  totalOutstanding: toUgx(96_000),
  daysPastDue: 6,
  missedInstallmentCount: 2,
  state: 'in_arrears',
  collectionStatus: 'unpaid',
  ...overrides,
});

// ===========================================================================
describe('a stat card', () => {
  it('shows the value it is given, unchanged', () => {
    render(
      <StatCard label="Collected today" value="UGX 95,000" metric="collected_today" />,
    );

    expect(screen.getByText('UGX 95,000')).toBeInTheDocument();
  });

  it('renders the definition rather than hiding it in a tooltip', () => {
    // A definition nobody can see is a definition nobody agrees on.
    render(<StatCard label="Total collected" value="UGX 10" metric="total_collected" />);

    expect(
      screen.getByText(METRIC_DEFINITIONS.total_collected.definition),
    ).toBeInTheDocument();
  });

  it('becomes a real link when it leads somewhere', () => {
    // A div with an onClick would look identical and be unusable by keyboard.
    render(<StatCard label="Arrears" value="UGX 1" definition="x" href="/overdue" />);

    expect(screen.getByRole('link')).toHaveAttribute('href', '/overdue');
  });

  it('is not a link when it leads nowhere', () => {
    render(<StatCard label="Arrears" value="UGX 1" definition="x" />);

    expect(screen.queryByRole('link')).toBeNull();
  });
});

// ===========================================================================
describe("today's figures", () => {
  it('shows the three figures it is given', () => {
    render(<TodayCards summary={collectionSummary} canSeeMethods />);

    expect(screen.getAllByText('UGX 120,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('UGX 95,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('UGX 40,000').length).toBeGreaterThan(0);
  });

  it('says in words that expected minus collected is not what remains', () => {
    // 120,000 − 95,000 is 25,000, and what remains is 40,000, because money
    // taken today may have settled an older collection. A screen that implied
    // the subtraction would be inventing a relationship the ledger has not.
    render(<TodayCards summary={collectionSummary} canSeeMethods />);

    expect(
      screen.getByText(/expected minus collected is not the same as still due today/i),
    ).toBeInTheDocument();
  });

  it('labels the method figures as received, never as a position', () => {
    render(<TodayCards summary={collectionSummary} canSeeMethods />);

    expect(screen.getByText('Cash received')).toBeInTheDocument();
    expect(screen.getByText('MTN received')).toBeInTheDocument();
    expect(screen.getByText('Airtel received')).toBeInTheDocument();

    // The phrases a dashboard must never *assert*. Where they appear at all
    // they appear denied — "not cash at hand" — which is the honest way to
    // head off the reading somebody would otherwise bring to the figure.
    const text = document.body.textContent ?? '';
    for (const claim of ['cash at hand', 'cash balance', 'wallet balance']) {
      if (!text.toLowerCase().includes(claim)) continue;
      expect(text).toMatch(new RegExp(`not\\s+(a\\s+)?${claim}`, 'i'));
    }
    expect(text).not.toMatch(/\bfloat\b/i);
  });

  it('withholds the method split from a role that may not see it', () => {
    // Not hidden in the markup — the page does not fetch it and does not
    // render it, which is the difference between a presentation decision and
    // a leak somebody finds by reading the HTML.
    render(<TodayCards summary={collectionSummary} canSeeMethods={false} />);

    expect(screen.queryByText('Cash received')).toBeNull();
    expect(screen.queryByText('MTN received')).toBeNull();
  });

  it('shows reversals as their own figure when there are any', () => {
    render(<TodayCards summary={collectionSummary} canSeeMethods />);

    expect(screen.getByText('Reversed today')).toBeInTheDocument();
    expect(screen.getByText('UGX 8,000')).toBeInTheDocument();
  });

  it('does not show a reversal card on a day with none', () => {
    render(
      <TodayCards
        summary={{
          ...collectionSummary,
          reversedTodayCount: 0,
          reversedTodayAmount: toUgx(0),
        }}
        canSeeMethods
      />,
    );

    expect(screen.queryByText('Reversed today')).toBeNull();
  });
});

// ===========================================================================
describe('the loan book', () => {
  it('keeps the delinquency breakdown summing to the disbursed book', () => {
    // The seven states are mutually exclusive, and the screen states the
    // arithmetic so a reader can check it rather than trust it.
    render(<PortfolioCards summary={portfolioSummary} canSeeReports />);

    const sum = Object.values(portfolioSummary.byState).reduce((a, b) => a + b, 0);
    expect(sum).toBe(portfolioSummary.loansWithSchedule);
    expect(screen.getByText(/add up to the 195 disbursed loans/i)).toBeInTheDocument();
  });

  it('shows lifecycle counts and delinquency counts under separate headings', () => {
    // A penalised loan is active *and* penalty_due. Adding the families
    // together double-counts, so they never appear in one list.
    render(<PortfolioCards summary={portfolioSummary} canSeeReports />);

    expect(screen.getByRole('heading', { name: 'The loan book' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /disbursed loans by status/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Active loans')).toBeInTheDocument();
  });

  it('says that a penalised loan is still an active loan', () => {
    render(<PortfolioCards summary={portfolioSummary} canSeeReports />);

    expect(
      screen.getByText(METRIC_DEFINITIONS.loans_active.definition),
    ).toBeInTheDocument();
  });

  it('says which arrears count overlaps the others', () => {
    // 14 loans are in the `in_arrears` state but 27 have a past-due amount,
    // because a loan in grace or already charged usually has arrears too.
    // Adding the two would claim 41 loans out of 195.
    render(<PortfolioCards summary={portfolioSummary} canSeeReports />);

    expect(screen.getByText(/27 loans have a past-due amount/i)).toBeInTheDocument();
    expect(screen.getByText(/overlaps/i)).toBeInTheDocument();
  });

  it('separates charges raised from charges unpaid', () => {
    render(<PortfolioCards summary={portfolioSummary} canSeeReports />);

    expect(screen.getByText('Penalties charged')).toBeInTheDocument();
    expect(screen.getByText('Penalties unpaid')).toBeInTheDocument();
    expect(screen.getByText('UGX 4,000,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 2,500,000')).toBeInTheDocument();
  });

  it('links a state to the report filtered on it, when reports are available', () => {
    render(<PortfolioCards summary={portfolioSummary} canSeeReports />);

    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links).toContain('/reports/loans?state=penalty_due');
    expect(links).toContain('/reports/loans?status=active');
  });

  it('drops the report links for a role that cannot open them', () => {
    render(<PortfolioCards summary={portfolioSummary} canSeeReports={false} />);

    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links.some((href) => href?.startsWith('/reports'))).toBe(false);
  });
});

// ===========================================================================
describe('the business summary', () => {
  it('never calls interest profit', () => {
    render(<ExecutiveCards summary={portfolioSummary} />);

    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Interest collected/);
    expect(text).not.toMatch(/\brevenue\b/i);
    expect(text).not.toMatch(/\bearnings\b/i);

    // "Profit" appears only to deny it: every occurrence is negated.
    for (const match of text.matchAll(/.{0,40}profit/gi)) {
      expect(match[0]).toMatch(/\bnot\b|\bneither\b|\bnever\b|\bno\b/i);
    }
  });

  it('says plainly that the figures are not profit', () => {
    render(<ExecutiveCards summary={portfolioSummary} />);

    expect(
      screen.getByText(/Neither is profit — this system records no costs/i),
    ).toBeInTheDocument();
  });

  it('shows interest charged beside interest collected', () => {
    // They are rarely equal and the difference is meaningful, so neither
    // stands in for the other.
    render(<ExecutiveCards summary={portfolioSummary} />);

    expect(screen.getByText('Interest charged')).toBeInTheDocument();
    expect(screen.getByText('Interest collected')).toBeInTheDocument();
    expect(screen.getByText('UGX 45,000,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 30,000,000')).toBeInTheDocument();
  });

  it('shows penalty charged beside penalty collected', () => {
    render(<ExecutiveCards summary={portfolioSummary} />);

    expect(screen.getByText('Penalty collected')).toBeInTheDocument();
    expect(screen.getByText(/UGX 4,000,000 charged/)).toBeInTheDocument();
  });

  it('says that reversed payments are excluded from what was collected', () => {
    render(<ExecutiveCards summary={portfolioSummary} />);

    expect(screen.getByText('Reversed payments excluded')).toBeInTheDocument();
  });
});

// ===========================================================================
describe("today's collection sheet", () => {
  it('shows who to call and what to ask for', () => {
    render(<CollectionSheet rows={[sheetRow()]} canCollect />);

    expect(screen.getAllByText('Nakimuli Zainabu').length).toBeGreaterThan(0);
    expect(screen.getAllByText('070 000 0001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LN-2026-00001').length).toBeGreaterThan(0);
  });

  it('keeps past unpaid, due today and current due as three columns', () => {
    render(<CollectionSheet rows={[sheetRow()]} canCollect />);

    expect(screen.getAllByText('Due today').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Past unpaid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Current due').length).toBeGreaterThan(0);
    // 4,000 due today plus 8,000 past unpaid is 12,000 current due.
    expect(screen.getAllByText('12,000').length).toBeGreaterThan(0);
  });

  it('never presents missed collections as days', () => {
    // Two missed collections six days ago. On a three-day cadence those are
    // different numbers, and conflating them overstates lateness threefold.
    render(<CollectionSheet rows={[sheetRow()]} canCollect />);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/2 days/);
  });

  it('states the payment status in words, never only in colour', () => {
    render(
      <CollectionSheet
        rows={[
          sheetRow({ loanId: 'a', collectionStatus: 'unpaid' }),
          sheetRow({ loanId: 'b', collectionStatus: 'part_paid' }),
          sheetRow({ loanId: 'c', collectionStatus: 'paid', remainingToday: toUgx(0) }),
        ]}
        canCollect
      />,
    );

    expect(screen.getAllByText('Not paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Part paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Settled').length).toBeGreaterThan(0);
  });

  it('links to the existing payment form rather than offering its own', () => {
    // A report may start a workflow; it may not reimplement one.
    render(<CollectionSheet rows={[sheetRow()]} canCollect />);

    const collect = screen.getAllByRole('link', { name: 'Collect' })[0];
    expect(collect).toHaveAttribute('href', '/payments/new?loanId=loan-1');
  });

  it('offers no collect link to somebody who may not record a payment', () => {
    render(<CollectionSheet rows={[sheetRow()]} canCollect={false} />);

    expect(screen.queryByRole('link', { name: 'Collect' })).toBeNull();
  });

  it('explains an empty sheet instead of showing a blank table', () => {
    render(<CollectionSheet rows={[]} canCollect />);

    expect(screen.getByText('Nothing is due today')).toBeInTheDocument();
    // And says why, including that prepaid collections are not listed.
    expect(screen.getByText(/paid ahead are not listed/i)).toBeInTheDocument();
  });

  it('gives the table a caption so a screen reader knows what it lists', () => {
    render(<CollectionSheet rows={[sheetRow()]} canCollect />);

    const table = screen.getByRole('table');
    expect(
      within(table).getByText(/Loans with a collection due today/i),
    ).toBeInTheDocument();
  });

  it('labels every column header', () => {
    render(<CollectionSheet rows={[sheetRow()]} canCollect />);

    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent);

    expect(headers).toContain('Client');
    expect(headers).toContain('Phone');
    expect(headers).toContain('Payment status');
  });
});

// ===========================================================================
describe('recent payments', () => {
  const payment = (overrides: Partial<RecentPayment> = {}): RecentPayment => ({
    paymentId: 'p1',
    paymentNumber: 'RC-2026-00001',
    loanId: 'loan-1',
    loanNumber: 'LN-2026-00001',
    clientId: 'client-1',
    clientName: 'Nakimuli Zainabu',
    amount: toUgx(4_000),
    paymentMethod: 'cash',
    status: 'posted',
    isEffective: true,
    receivedAt: '2026-10-04T07:30:00Z',
    businessDate: toBusinessDate('2026-10-04'),
    recordedByLabel: 'A Secretary',
    ...overrides,
  });

  it('marks a reversed payment and strikes its amount through', () => {
    // Somebody glancing at this panel most needs to know that this morning's
    // payment has since been withdrawn.
    render(
      <RecentPayments
        payments={[payment({ status: 'reversed', isEffective: false })]}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Reversed')).toBeInTheDocument();
    expect(screen.getByText('UGX 4,000').className).toContain('line-through');
  });

  it('does not strike through a posted payment', () => {
    render(<RecentPayments payments={[payment()]} timeZone={TIMEZONE} />);

    expect(screen.queryByText('Reversed')).toBeNull();
    expect(screen.getByText('UGX 4,000').className).not.toContain('line-through');
  });

  it('explains an empty panel', () => {
    render(<RecentPayments payments={[]} timeZone={TIMEZONE} />);

    expect(screen.getByText('No payments recorded yet')).toBeInTheDocument();
  });
});

// ===========================================================================
describe('upcoming collections', () => {
  const upcoming = (overrides: Partial<UpcomingCollection> = {}): UpcomingCollection => ({
    loanId: 'loan-1',
    loanNumber: 'LN-2026-00001',
    installmentNumber: 8,
    dueDate: toBusinessDate('2026-10-05'),
    expectedAmount: toUgx(4_000),
    remainingAmount: toUgx(4_000),
    ...overrides,
  });

  it('groups by day and totals what is uncovered', () => {
    render(
      <UpcomingCollections
        collections={[
          upcoming(),
          upcoming({ loanId: 'loan-2', loanNumber: 'LN-2026-00002' }),
          upcoming({
            loanId: 'loan-3',
            loanNumber: 'LN-2026-00003',
            dueDate: toBusinessDate('2026-10-06'),
          }),
        ]}
      />,
    );

    expect(screen.getByText('5 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('6 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText(/UGX 8,000 · 2 loans/)).toBeInTheDocument();
    expect(screen.getByText(/UGX 4,000 · 1 loan/)).toBeInTheDocument();
  });

  it('says that prepaid collections are not listed', () => {
    render(<UpcomingCollections collections={[]} />);

    expect(
      screen.getByText(/already been paid ahead are not listed/i),
    ).toBeInTheDocument();
  });
});

// ===========================================================================
describe('recent loan activity', () => {
  const row = (overrides: Partial<LoanActivityRow> = {}): LoanActivityRow => ({
    loanId: 'loan-1',
    loanNumber: 'LN-2026-00001',
    clientId: 'client-1',
    clientName: 'Nakimuli Zainabu',
    principalAmount: toUgx(500_000),
    totalOutstanding: toUgx(0),
    disbursedAt: '2026-09-01T07:00:00Z',
    clearedAt: '2026-10-01T07:00:00Z',
    penaltyEffectiveDate: null,
    ...overrides,
  });

  it('describes a disbursement by its date and principal', () => {
    render(
      <LoanActivity
        rows={[row()]}
        kind="disbursed"
        timeZone={TIMEZONE}
        emptyTitle="none"
        emptyDescription="none"
      />,
    );

    // en-UG abbreviates September as "Sept".
    expect(screen.getByText(/Paid out 1 Sept 2026/)).toBeInTheDocument();
    expect(screen.getByText('UGX 500,000')).toBeInTheDocument();
  });

  it('describes a charge by the date it applies from', () => {
    render(
      <LoanActivity
        rows={[
          row({
            penaltyEffectiveDate: toBusinessDate('2026-10-14'),
            totalOutstanding: toUgx(150_000),
          }),
        ]}
        kind="penalised"
        timeZone={TIMEZONE}
        emptyTitle="none"
        emptyDescription="none"
      />,
    );

    expect(screen.getByText(/Charge from 14 Oct 2026/)).toBeInTheDocument();
  });

  it('explains an empty panel in its own words', () => {
    render(
      <LoanActivity
        rows={[]}
        kind="cleared"
        timeZone={TIMEZONE}
        emptyTitle="No loans settled yet"
        emptyDescription="A loan appears here once it is fully paid."
      />,
    );

    expect(screen.getByText('No loans settled yet')).toBeInTheDocument();
  });
});

// ===========================================================================
describe('money formatting across the dashboard', () => {
  it('groups thousands and shows no decimals anywhere', () => {
    render(
      <>
        <TodayCards summary={collectionSummary} canSeeMethods />
        <ExecutiveCards summary={portfolioSummary} />
      </>,
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('UGX 180,000,000');
    // A decimal point in a shilling figure would mean a fractional shilling.
    expect(text).not.toMatch(/UGX [\d,]+\.\d/);
  });
});
