import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ArrearsReportView } from '@/components/reports/arrears-report-view';
import { CollectionReportView } from '@/components/reports/collection-report-view';
import { ExportLink } from '@/components/reports/export-link';
import { PortfolioReportView } from '@/components/reports/portfolio-report-view';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ReportTable } from '@/components/reports/report-table';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { MAX_EXPORT_ROWS } from '@/lib/domain/reporting';
import type {
  ArrearsReport,
  ArrearsReportRow,
  CollectionReport,
  CollectionRow,
  PortfolioReport,
  PortfolioRow,
} from '@/lib/data/reports';

/**
 * The Phase 8 reports.
 *
 * ## What is asserted, and why these things
 *
 * A report's job is to be trustworthy, and the ways a report stops being
 * trustworthy are specific and well known by now:
 *
 *   - a reversed payment hidden, so a withdrawal looks like it never happened,
 *     or counted, so withdrawn money looks collected;
 *   - a total that describes different rows from the table under it;
 *   - a partial total shown as if it were complete;
 *   - an identification number in a file somebody then emails;
 *   - an unlabelled filter control;
 *   - a blank table where there is simply no data.
 *
 * The totals here are passed in rather than computed: the data layer runs one
 * query, sums it and slices the page out of it, so parity is structural and the
 * database suite is where it is proven. These tests are about presentation.
 */

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/reports/collections',
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('period=month&method=cash'),
}));

const TIMEZONE = 'Africa/Kampala';
const ZERO = toUgx(0);

const collectionRow = (overrides: Partial<CollectionRow> = {}): CollectionRow => ({
  paymentId: 'p1',
  paymentNumber: 'RC-2026-00001',
  businessDate: toBusinessDate('2026-10-04'),
  receivedAt: '2026-10-04T07:30:00Z',
  loanId: 'loan-1',
  loanNumber: 'LN-2026-00001',
  clientId: 'client-1',
  clientNumber: 'CL-2026-00001',
  clientName: 'Nakimuli Zainabu',
  clientNameAtPayment: 'Nakimuli Zainabu',
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

const collectionReport = (
  rows: readonly CollectionRow[],
  overrides: Partial<CollectionReport> = {},
): CollectionReport => {
  const effective = rows.filter((row) => row.isEffective);
  const reversed = rows.filter((row) => !row.isEffective);
  const sum = (pick: (row: CollectionRow) => number) =>
    toUgx(effective.reduce((total, row) => total + pick(row), 0));

  return {
    page: { rows, page: 1, pageSize: 25, hasMore: false },
    totals: {
      collected: sum((row) => row.effectiveAmount),
      paymentCount: effective.length,
      byMethod: {
        cash: sum((row) => (row.paymentMethod === 'cash' ? row.effectiveAmount : 0)),
        mtn_mobile_money: sum((row) =>
          row.paymentMethod === 'mtn_mobile_money' ? row.effectiveAmount : 0,
        ),
        airtel_money: sum((row) =>
          row.paymentMethod === 'airtel_money' ? row.effectiveAmount : 0,
        ),
      },
      countByMethod: {
        cash: effective.filter((row) => row.paymentMethod === 'cash').length,
        mtn_mobile_money: effective.filter(
          (row) => row.paymentMethod === 'mtn_mobile_money',
        ).length,
        airtel_money: effective.filter((row) => row.paymentMethod === 'airtel_money')
          .length,
      },
      principalCollected: sum((row) => row.principalCollected),
      interestCollected: sum((row) => row.interestCollected),
      penaltyCollected: sum((row) => row.penaltyCollected),
      reversedAmount: toUgx(reversed.reduce((total, row) => total + row.amount, 0)),
      reversedCount: reversed.length,
      grossAmount: toUgx(rows.reduce((total, row) => total + row.amount, 0)),
    },
    byDay: [],
    byWeek: [],
    byMonth: [],
    truncated: false,
    matchedRows: rows.length,
    exportRows: rows,
    ...overrides,
  };
};

const portfolioRow = (overrides: Partial<PortfolioRow> = {}): PortfolioRow => ({
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

const portfolioReport = (rows: readonly PortfolioRow[]): PortfolioReport => ({
  page: { rows, page: 1, pageSize: 25, hasMore: false },
  totals: {
    loanCount: rows.length,
    principal: toUgx(rows.reduce((t, r) => t + r.principalAmount, 0)),
    contractualInterest: toUgx(rows.reduce((t, r) => t + r.contractualInterest, 0)),
    penaltyAssessed: toUgx(rows.reduce((t, r) => t + r.penaltyAssessed, 0)),
    totalExpected: toUgx(rows.reduce((t, r) => t + r.totalExpectedRepayment, 0)),
    collected: toUgx(rows.reduce((t, r) => t + r.totalCollected, 0)),
    contractualOutstanding: toUgx(rows.reduce((t, r) => t + r.contractualOutstanding, 0)),
    penaltyOutstanding: toUgx(rows.reduce((t, r) => t + r.penaltyRemaining, 0)),
    totalOutstanding: toUgx(rows.reduce((t, r) => t + r.totalOutstanding, 0)),
    arrears: toUgx(rows.reduce((t, r) => t + r.arrearsAmount, 0)),
  },
  truncated: false,
  matchedRows: rows.length,
  exportRows: rows,
});

const arrearsReport = (rows: readonly ArrearsReportRow[]): ArrearsReport => {
  const base = portfolioReport(rows);
  return {
    page: { rows, page: 1, pageSize: 25, hasMore: false },
    totals: base.totals,
    truncated: false,
    matchedRows: rows.length,
    exportRows: rows,
  };
};

// ===========================================================================
describe('the report table', () => {
  it('renders a table with a caption and real column headers', () => {
    render(
      <ReportTable
        columns={[
          { key: 'a', header: 'Client', cell: (row: { name: string }) => row.name },
          { key: 'b', header: 'Amount', numeric: true, cell: () => '4,000' },
        ]}
        rows={[{ name: 'Nakimuli' }]}
        rowKey={(row) => row.name}
        caption="Payments received in the selected range"
      />,
    );

    const table = screen.getByRole('table');
    expect(
      within(table).getByText('Payments received in the selected range'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('columnheader').map((header) => header.textContent),
    ).toEqual(['Client', 'Amount']);
  });

  it('renders the same rows as cards as well, for a phone', () => {
    // Nine columns at 320px is unreadable however it is squeezed, and a
    // horizontally scrolling table hides the right-hand columns from somebody
    // who does not think to swipe. Both renderings come from one `rows`.
    render(
      <ReportTable
        columns={[
          {
            key: 'a',
            header: 'Client',
            primary: true,
            cell: (row: { name: string }) => row.name,
          },
          { key: 'b', header: 'Amount', numeric: true, cell: () => '4,000' },
        ]}
        rows={[{ name: 'Nakimuli' }]}
        rowKey={(row) => row.name}
        caption="x"
      />,
    );

    // Once in the table, once in the card: the same value from the same row.
    expect(screen.getAllByText('Nakimuli')).toHaveLength(2);
    expect(screen.getAllByText('4,000')).toHaveLength(2);
  });
});

// ===========================================================================
describe('the collection report', () => {
  it('shows the totals it is given', () => {
    render(
      <CollectionReportView
        report={collectionReport([collectionRow()])}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getAllByText('UGX 4,000').length).toBeGreaterThan(0);
    expect(screen.getByText('1 payment')).toBeInTheDocument();
  });

  it('lists a reversed payment, strikes it through, and leaves it out of the total', () => {
    // §107 and §131. Hiding the row would make a reversal look like a payment
    // that never happened; counting it would make withdrawn money look
    // collected. Both are wrong in opposite directions.
    const report = collectionReport([
      collectionRow(),
      collectionRow({
        paymentId: 'p2',
        paymentNumber: 'RC-2026-00002',
        status: 'reversed',
        isEffective: false,
        effectiveAmount: ZERO,
        principalCollected: ZERO,
        interestCollected: ZERO,
        reversalReason: 'Credited to the wrong borrower',
      }),
    ]);

    render(<CollectionReportView report={report} timeZone={TIMEZONE} />);

    // The reversed payment is on the page…
    expect(screen.getAllByText('RC-2026-00002').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reversed').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Credited to the wrong borrower/).length).toBeGreaterThan(
      0,
    );

    // …and the collected total is one payment, not two.
    expect(screen.getByText('1 payment')).toBeInTheDocument();
    expect(report.totals.collected).toBe(4_000);
    expect(report.totals.grossAmount).toBe(8_000);
  });

  it('labels the gross figure as including reversals, never as takings', () => {
    const report = collectionReport([
      collectionRow(),
      collectionRow({
        paymentId: 'p2',
        status: 'reversed',
        isEffective: false,
        effectiveAmount: ZERO,
      }),
    ]);

    render(<CollectionReportView report={report} timeZone={TIMEZONE} />);

    expect(
      screen.getByText(/UGX 8,000 recorded, including reversed/),
    ).toBeInTheDocument();
  });

  it('shows no reversal card when nothing was reversed', () => {
    render(
      <CollectionReportView
        report={collectionReport([collectionRow()])}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.queryByText('Reversed')).toBeNull();
  });

  it('states the two identities the figures satisfy', () => {
    render(
      <CollectionReportView
        report={collectionReport([collectionRow()])}
        timeZone={TIMEZONE}
      />,
    );

    expect(
      screen.getByText(/Cash, MTN and Airtel add up to the collected total/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Principal, interest and penalty collected also add up to it/i),
    ).toBeInTheDocument();
  });

  it('refuses to show totals for a set it could only partly read', () => {
    // §136. A partial sum presented as a total is worse than no total: it is a
    // figure somebody would circulate.
    render(
      <CollectionReportView
        report={collectionReport([collectionRow()], { truncated: true })}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Too many payments for one report')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`more than ${String(MAX_EXPORT_ROWS)}`, 'i')),
    ).toBeInTheDocument();
  });

  it('shows the name recorded on the receipt, not the current one', () => {
    // §33. A statement or a historical report should read the way the receipt
    // does; a borrower who changed their name has not changed what happened.
    render(
      <CollectionReportView
        report={collectionReport([
          collectionRow({
            clientName: 'Renamed Later',
            clientNameAtPayment: 'Nakimuli Zainabu',
          }),
        ])}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getAllByText('Nakimuli Zainabu').length).toBeGreaterThan(0);
    expect(screen.queryByText('Renamed Later')).toBeNull();
  });

  it('explains an empty range instead of showing a blank table', () => {
    render(<CollectionReportView report={collectionReport([])} timeZone={TIMEZONE} />);

    expect(screen.getByText('No payments in this range')).toBeInTheDocument();
  });

  it('shows the breakdowns only when there is more than one bucket', () => {
    const single = collectionReport([collectionRow()], {
      byDay: [
        {
          key: '2026-10-04',
          collected: toUgx(4_000),
          paymentCount: 1,
          cash: toUgx(4_000),
          mtn: ZERO,
          airtel: ZERO,
          reversedAmount: ZERO,
          reversedCount: 0,
        },
      ],
    });

    const { unmount } = render(
      <CollectionReportView report={single} timeZone={TIMEZONE} />,
    );
    // One day repeating the summary card is noise, and noise on a financial
    // screen makes the real figures harder to find.
    expect(screen.queryByRole('heading', { name: 'By day' })).toBeNull();
    unmount();

    render(
      <CollectionReportView
        report={collectionReport([collectionRow()], {
          byDay: [
            ...single.byDay,
            {
              key: '2026-10-05',
              collected: toUgx(8_000),
              paymentCount: 2,
              cash: toUgx(8_000),
              mtn: ZERO,
              airtel: ZERO,
              reversedAmount: ZERO,
              reversedCount: 0,
            },
          ],
        })}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByRole('heading', { name: 'By day' })).toBeInTheDocument();
    expect(screen.getAllByText('4 Oct 2026').length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe('the loan portfolio report', () => {
  it('shows lifecycle status and delinquency status as separate values', () => {
    // §112. One merged column would make the portfolio impossible to
    // reconcile against the dashboard's counts.
    render(
      <PortfolioReportView
        report={portfolioReport([portfolioRow()])}
        timeZone={TIMEZONE}
        emptyTitle="none"
        emptyDescription="none"
      />,
    );

    expect(screen.getAllByText('active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('In arrears').length).toBeGreaterThan(0);
  });

  it('shows the contract, what was paid and what is outstanding', () => {
    render(
      <PortfolioReportView
        report={portfolioReport([portfolioRow()])}
        timeZone={TIMEZONE}
        emptyTitle="none"
        emptyDescription="none"
      />,
    );

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('Principal');
    expect(headers).toContain('Interest');
    expect(headers).toContain('Charges');
    expect(headers).toContain('Paid');
    expect(headers).toContain('Outstanding');
    expect(headers).toContain('Completion');
  });

  it('accepts extra columns for the report that needs them', () => {
    render(
      <PortfolioReportView
        report={portfolioReport([portfolioRow()])}
        timeZone={TIMEZONE}
        emptyTitle="none"
        emptyDescription="none"
        columns={[{ key: 'graceEnd', header: 'Grace ends', cell: () => '4 Oct 2026' }]}
      />,
    );

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain(
      'Grace ends',
    );
  });

  it('explains an empty result in the words the page chose', () => {
    render(
      <PortfolioReportView
        report={portfolioReport([])}
        timeZone={TIMEZONE}
        emptyTitle="No loans are in their grace period"
        emptyDescription="Every loan is within its schedule, charged, or settled."
      />,
    );

    expect(screen.getByText('No loans are in their grace period')).toBeInTheDocument();
  });
});

// ===========================================================================
describe('the arrears report', () => {
  const row = (overrides: Partial<ArrearsReportRow> = {}): ArrearsReportRow => ({
    ...portfolioRow(),
    latestRemark: null,
    ...overrides,
  });

  it('keeps past unpaid, due today and current due as three columns', () => {
    render(
      <ArrearsReportView
        report={arrearsReport([row()])}
        timeZone={TIMEZONE}
        showRemarks
        canAddRemark
      />,
    );

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('Past unpaid');
    expect(headers).toContain('Due today');
    expect(headers).toContain('Current due');
  });

  it('reports missed collections and days late as separate columns', () => {
    render(
      <ArrearsReportView
        report={arrearsReport([row()])}
        timeZone={TIMEZONE}
        showRemarks={false}
        canAddRemark={false}
      />,
    );

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('Missed');
    expect(headers).toContain('Days late');
  });

  it('shows the existing remark, who wrote it and when', () => {
    render(
      <ArrearsReportView
        report={arrearsReport([
          row({
            latestRemark: {
              id: 'r1',
              body: 'Promised to pay on Friday after market day.',
              category: 'payment_concern',
              createdByLabel: 'A Manager',
              createdAt: '2026-10-02T09:00:00Z',
            },
          }),
        ])}
        timeZone={TIMEZONE}
        showRemarks
        canAddRemark
      />,
    );

    expect(
      screen.getAllByText('Promised to pay on Friday after market day.').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/A Manager/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Payment concern/).length).toBeGreaterThan(0);
  });

  it('links to the existing remarks form rather than offering its own', () => {
    // §104 and §35: there is one place a note is written, with its own
    // permission check and its own append-only guarantees.
    render(
      <ArrearsReportView
        report={arrearsReport([row()])}
        timeZone={TIMEZONE}
        showRemarks
        canAddRemark
      />,
    );

    const link = screen.getAllByRole('link', { name: 'Add a note' })[0];
    expect(link).toHaveAttribute('href', '/clients/client-1#remarks');
    // No form, no textarea, no submit control anywhere on the report.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /add|save|post/i })).toBeNull();
  });

  it('omits the remark column entirely for a caller who may not read notes', () => {
    // A header with every cell blank would imply there were no notes, which is
    // a different and misleading claim.
    render(
      <ArrearsReportView
        report={arrearsReport([
          row({
            latestRemark: {
              id: 'r1',
              body: 'Internal note nobody else should see',
              category: 'general',
              createdByLabel: 'A Manager',
              createdAt: '2026-10-02T09:00:00Z',
            },
          }),
        ])}
        timeZone={TIMEZONE}
        showRemarks={false}
        canAddRemark={false}
      />,
    );

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).not.toContain('Latest note');
    expect(screen.queryByText('Internal note nobody else should see')).toBeNull();
  });

  it('says "No notes" rather than offering a link somebody cannot use', () => {
    render(
      <ArrearsReportView
        report={arrearsReport([row()])}
        timeZone={TIMEZONE}
        showRemarks
        canAddRemark={false}
      />,
    );

    expect(screen.getAllByText('No notes').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Add a note' })).toBeNull();
  });

  it('explains a clean book rather than showing an empty table', () => {
    render(
      <ArrearsReportView
        report={arrearsReport([])}
        timeZone={TIMEZONE}
        showRemarks
        canAddRemark
      />,
    );

    expect(screen.getByText('No loan is behind')).toBeInTheDocument();
  });
});

// ===========================================================================
describe('the filter bar', () => {
  it('gives every control a visible label', () => {
    // A placeholder is not a label: it disappears when typing starts and is
    // not announced, which leaves a screen-reader user with an unnamed box.
    render(
      <ReportFilters
        filters={[
          { kind: 'period' },
          {
            kind: 'select',
            name: 'method',
            label: 'Method',
            options: [{ value: 'cash', label: 'Cash' }],
          },
          { kind: 'search', name: 'query', label: 'Search', placeholder: 'Receipt' },
        ]}
        resultSummary="12 payments in October"
      />,
    );

    expect(screen.getByLabelText('Period')).toBeInTheDocument();
    expect(screen.getByLabelText('Method')).toBeInTheDocument();
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
  });

  it('reads its initial values from the query string', () => {
    render(
      <ReportFilters
        filters={[
          { kind: 'period' },
          {
            kind: 'select',
            name: 'method',
            label: 'Method',
            options: [{ value: 'cash', label: 'Cash' }],
          },
        ]}
      />,
    );

    expect(screen.getByLabelText('Period')).toHaveValue('month');
    expect(screen.getByLabelText('Method')).toHaveValue('cash');
  });

  it('offers an All option on every select, so a filter can be cleared', () => {
    render(
      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'status',
            label: 'Loan status',
            options: [{ value: 'active', label: 'active' }],
          },
        ]}
      />,
    );

    expect(
      within(screen.getByLabelText('Loan status')).getByRole('option', { name: 'All' }),
    ).toBeInTheDocument();
  });

  it('reveals the date inputs only for a custom range', async () => {
    const user = userEvent.setup();
    render(<ReportFilters filters={[{ kind: 'period' }]} />);

    expect(screen.queryByLabelText('From')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Period'), 'custom');

    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('applies on submit, not on every keystroke', async () => {
    // A report query is not free, and a filter that re-ran it per character
    // makes the page unusable on the connection this office has.
    replace.mockClear();
    const user = userEvent.setup();

    render(
      <ReportFilters filters={[{ kind: 'search', name: 'query', label: 'Search' }]} />,
    );

    await user.type(screen.getByLabelText('Search'), 'Nakimuli');
    expect(replace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[0]).toContain('query=Nakimuli');
  });

  it('announces what is currently shown', () => {
    render(
      <ReportFilters
        filters={[{ kind: 'period' }]}
        resultSummary="12 payments in October"
      />,
    );

    const summary = screen.getByText('12 payments in October');
    expect(summary).toHaveAttribute('aria-live', 'polite');
  });
});

// ===========================================================================
describe('pagination', () => {
  it('disables Previous on the first page and Next on the last', () => {
    render(<ReportPagination page={1} hasMore={false} rowsShown={3} />);
    // Neither control is needed at all on a single page.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('offers Next when there is more, and says what is shown', () => {
    render(<ReportPagination page={2} hasMore rowsShown={25} />);

    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(screen.getByText('Page 2 · 25 rows shown')).toBeInTheDocument();
  });

  it('has an accessible name on the navigation itself', () => {
    render(<ReportPagination page={2} hasMore rowsShown={25} />);

    expect(screen.getByRole('navigation', { name: 'Report pages' })).toBeInTheDocument();
  });

  it('moves a page without losing the filters', async () => {
    replace.mockClear();
    const user = userEvent.setup();

    render(<ReportPagination page={2} hasMore rowsShown={25} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const target = String(replace.mock.calls[0]?.[0]);
    expect(target).toContain('page=3');
    expect(target).toContain('period=month');
    expect(target).toContain('method=cash');
  });
});

// ===========================================================================
describe('the export link', () => {
  it('is a link that carries the current filters', () => {
    render(<ExportLink href="/reports/collections/export?period=month&method=cash" />);

    const link = screen.getByRole('link', { name: /Download CSV/ });
    expect(link).toHaveAttribute(
      'href',
      '/reports/collections/export?period=month&method=cash',
    );
  });

  it('is hidden from a printout, where a download link means nothing', () => {
    render(<ExportLink href="/x" />);

    expect(screen.getByRole('link').className).toContain('print:hidden');
  });
});

// ===========================================================================
describe('empty states', () => {
  it('always says why, never just that there is nothing', () => {
    render(
      <ReportEmpty
        title="No payments today"
        description="Nothing has been recorded at the counter yet today."
      />,
    );

    expect(screen.getByText('No payments today')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing has been recorded at the counter yet today.'),
    ).toBeInTheDocument();
  });
});
