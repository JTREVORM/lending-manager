import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { ROUTES } from '@/config/app';
import { formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { MAX_EXPORT_ROWS } from '@/lib/domain/reporting';
import type { PortfolioReport, PortfolioRow } from '@/lib/data/reports';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';

/**
 * The loan portfolio report.
 *
 * ## Why one component serves the portfolio, active, cleared and grace reports
 *
 * They are the same rows under different filters, with the same columns and
 * the same totals. Four components would be four places for a figure to go
 * wrong and three chances to fix only some of them; the specification lists
 * them separately because they answer different questions, not because they
 * need different code. Each page sets its own filters, heading and empty-state
 * sentence, which is where the difference actually lies.
 *
 * ## Lifecycle and delinquency are separate columns
 *
 * `loan_status` is the lifecycle — draft, active, cleared. `delinquency_state`
 * is whether the borrower is behind. A penalised loan is `active` *and*
 * `penalty_due`, and showing one column that merged them would make the
 * portfolio impossible to reconcile against the dashboard's counts. §112.
 */
export function PortfolioReportView({
  report,
  emptyTitle,
  emptyDescription,
  timeZone,
  columns: extraColumns = [],
}: {
  readonly report: PortfolioReport;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly timeZone: string;
  /** Columns a particular report adds — grace dates, clearance dates. */
  readonly columns?: readonly ReportColumn<PortfolioRow>[];
}) {
  const { totals } = report;

  const columns: readonly ReportColumn<PortfolioRow>[] = [
    {
      key: 'loan',
      header: 'Loan',
      primary: true,
      cell: (row) => (
        <Link
          href={`${ROUTES.loans}/${row.loanId}`}
          className="text-brand-700 font-mono hover:underline"
        >
          {row.loanNumber}
        </Link>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      cell: (row) => (
        <Link
          href={`${ROUTES.clients}/${row.clientId}`}
          className="text-brand-700 hover:underline"
        >
          {row.clientName ?? row.clientNumber ?? 'Client'}
        </Link>
      ),
    },
    {
      key: 'principal',
      header: 'Principal',
      numeric: true,
      cell: (row) => formatUgx(row.principalAmount, { withCurrency: false }),
    },
    {
      key: 'interest',
      header: 'Interest',
      numeric: true,
      cell: (row) => formatUgx(row.contractualInterest, { withCurrency: false }),
    },
    {
      key: 'penalty',
      header: 'Charges',
      numeric: true,
      cell: (row) =>
        row.penaltyAssessed === 0
          ? '—'
          : formatUgx(row.penaltyAssessed, { withCurrency: false }),
    },
    {
      key: 'expected',
      header: 'Total expected',
      numeric: true,
      hideOnMobile: true,
      cell: (row) => formatUgx(row.totalExpectedRepayment, { withCurrency: false }),
    },
    {
      key: 'collected',
      header: 'Paid',
      numeric: true,
      cell: (row) => formatUgx(row.totalCollected, { withCurrency: false }),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      cell: (row) => formatUgx(row.totalOutstanding, { withCurrency: false }),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge
            tone={
              row.loanStatus === 'active'
                ? 'info'
                : row.loanStatus === 'cleared'
                  ? 'success'
                  : 'neutral'
            }
          >
            {row.loanStatus.replace(/_/g, ' ')}
          </Badge>
          {row.state === null ? null : <DelinquencyBadge state={row.state} />}
        </span>
      ),
    },
    {
      key: 'disbursed',
      header: 'Paid out',
      hideOnMobile: true,
      cell: (row) =>
        row.disbursedAt === null
          ? '—'
          : formatInstant(row.disbursedAt, { timeZone, withTime: false }),
    },
    {
      key: 'completion',
      header: 'Completion',
      hideOnMobile: true,
      cell: (row) =>
        row.scheduledCompletionDate === null ? (
          '—'
        ) : (
          <DateValue value={row.scheduledCompletionDate} />
        ),
    },
    ...extraColumns,
  ];

  return (
    <div className="min-w-0 space-y-5">
      {report.truncated ? (
        <Alert tone="warning" title="Too many loans for one report">
          More than {String(MAX_EXPORT_ROWS)} loans match, so the totals below cover only
          part of them. Add a filter and the figures will be complete again.
        </Alert>
      ) : null}

      <StatGrid>
        <StatCard
          label="Loans"
          value={String(totals.loanCount)}
          definition="Loans matching the filters on this page."
        />
        <StatCard
          label="Principal"
          value={<Money amount={totals.principal} />}
          definition="Total principal of the loans listed. Not restricted to disbursed loans unless the status filter says so."
        />
        <StatCard
          label="Collected"
          value={<Money amount={totals.collected} />}
          metric="total_collected"
          tone="success"
        />
        <StatCard
          label="Outstanding"
          value={<Money amount={totals.totalOutstanding} />}
          secondary={`${formatUgx(totals.contractualOutstanding)} contract · ${formatUgx(totals.penaltyOutstanding)} charges`}
          metric="total_outstanding"
        />
      </StatGrid>

      {report.page.rows.length === 0 ? (
        <ReportEmpty title={emptyTitle} description={emptyDescription} />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.page.rows}
          rowKey={(row) => row.loanId}
          caption="Loans with their contract, what has been paid, what is outstanding and their status"
        />
      )}
    </div>
  );
}
