import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { ROUTES } from '@/config/app';
import { formatBusinessDate, formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';
import { MAX_EXPORT_ROWS } from '@/lib/domain/reporting';
import { REMARK_CATEGORY_LABELS, isRemarkCategory } from '@/lib/domain/client';
import type { ArrearsReport, ArrearsReportRow } from '@/lib/data/reports';

/**
 * The arrears report.
 *
 * ## It is Phase 7's data, not a second definition of overdue
 *
 * Every figure — arrears, due today, current due, missed collections, days
 * past due, oldest missed date, the status badge — comes from
 * `loan_delinquency` through `loan_portfolio_report`. There is no second
 * arrears rule anywhere in Phase 8, which is why this report and the overdue
 * screen can never disagree about whether somebody is behind. §15.
 *
 * ## The remark is the existing one
 *
 * `client_remarks`, the Phase 3 table, newest first. The column appears only
 * for a caller who may read remarks — the policy decides, so a caller without
 * `clients:remarks_view` gets no remarks back and the column is omitted rather
 * than rendered empty, which would imply there were no notes.
 *
 * There is no remark form here. "Add a note" links to the client page, where
 * the Phase 3 component lives with its own permission check and its
 * append-only guarantees. A second write path for remarks is exactly what §35
 * forbids.
 */
export function ArrearsReportView({
  report,
  timeZone,
  showRemarks,
  canAddRemark,
}: {
  readonly report: ArrearsReport;
  readonly timeZone: string;
  readonly showRemarks: boolean;
  readonly canAddRemark: boolean;
}) {
  const { totals } = report;

  const columns: readonly ReportColumn<ArrearsReportRow>[] = [
    {
      key: 'client',
      header: 'Client',
      primary: true,
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
      key: 'phone',
      header: 'Phone',
      cell: (row) =>
        row.clientPhone === null ? '—' : formatUgandanPhoneLocal(row.clientPhone),
    },
    {
      key: 'loan',
      header: 'Loan',
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
      key: 'arrears',
      header: 'Past unpaid',
      numeric: true,
      cell: (row) => formatUgx(row.arrearsAmount, { withCurrency: false }),
    },
    {
      key: 'dueToday',
      header: 'Due today',
      numeric: true,
      cell: (row) => formatUgx(row.dueTodayAmount, { withCurrency: false }),
    },
    {
      key: 'currentDue',
      header: 'Current due',
      numeric: true,
      cell: (row) => formatUgx(row.currentDue, { withCurrency: false }),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      cell: (row) => formatUgx(row.totalOutstanding, { withCurrency: false }),
    },
    {
      key: 'missed',
      header: 'Missed',
      numeric: true,
      cell: (row) => String(row.missedInstallmentCount),
    },
    {
      key: 'days',
      header: 'Days late',
      numeric: true,
      cell: (row) => String(row.daysPastDue),
    },
    {
      key: 'oldest',
      header: 'Oldest missed',
      hideOnMobile: true,
      cell: (row) =>
        row.oldestPastDueDate === null ? '—' : formatBusinessDate(row.oldestPastDueDate),
    },
    {
      key: 'completion',
      header: 'Completion',
      hideOnMobile: true,
      cell: (row) =>
        row.scheduledCompletionDate === null
          ? '—'
          : formatBusinessDate(row.scheduledCompletionDate),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (row.state === null ? '—' : <DelinquencyBadge state={row.state} />),
    },
    ...(showRemarks
      ? [
          {
            key: 'remark',
            header: 'Latest note',
            cell: (row: ArrearsReportRow) =>
              row.latestRemark === null ? (
                canAddRemark ? (
                  <Link
                    href={`${ROUTES.clients}/${row.clientId}#remarks`}
                    className="text-brand-700 text-sm hover:underline"
                  >
                    Add a note
                  </Link>
                ) : (
                  <span className="text-text-muted text-sm">No notes</span>
                )
              ) : (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-text min-w-0 text-sm break-words">
                    {row.latestRemark.body}
                  </span>
                  <span className="text-text-muted text-xs">
                    {isRemarkCategory(row.latestRemark.category)
                      ? REMARK_CATEGORY_LABELS[row.latestRemark.category]
                      : row.latestRemark.category}{' '}
                    · {row.latestRemark.createdByLabel} ·{' '}
                    {formatInstant(row.latestRemark.createdAt, { timeZone })}
                  </span>
                  <Link
                    href={`${ROUTES.clients}/${row.clientId}#remarks`}
                    className="text-brand-700 text-xs hover:underline"
                  >
                    All notes
                  </Link>
                </span>
              ),
          },
        ]
      : []),
  ];

  return (
    <div className="min-w-0 space-y-5">
      {report.truncated ? (
        <Alert tone="warning" title="Too many loans for one report">
          More than {String(MAX_EXPORT_ROWS)} loans are behind, so the totals cover only
          part of them. Filter by status or lateness.
        </Alert>
      ) : null}

      <StatGrid>
        <StatCard
          label="Loans behind"
          value={String(totals.loanCount)}
          definition="Loans in arrears, in their grace period, past the charge date, or already charged. Phase 7's statuses, unchanged."
          tone={totals.loanCount > 0 ? 'warning' : 'success'}
        />
        <StatCard
          label="Arrears"
          value={formatUgx(totals.arrears)}
          metric="arrears_total"
        />
        <StatCard
          label="Outstanding"
          value={formatUgx(totals.totalOutstanding)}
          metric="total_outstanding"
        />
        <StatCard
          label="Charges unpaid"
          value={formatUgx(totals.penaltyOutstanding)}
          metric="penalty_outstanding"
        />
      </StatGrid>

      {report.page.rows.length === 0 ? (
        <ReportEmpty
          title="No loan is behind"
          description="Every disbursed loan is either up to date or settled. Nothing here needs chasing."
        />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.page.rows}
          rowKey={(row) => row.loanId}
          caption="Loans that are behind, with what is overdue, how late it is and the latest note on the client"
        />
      )}
    </div>
  );
}
