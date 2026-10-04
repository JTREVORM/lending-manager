import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { ExportLink } from '@/components/reports/export-link';
import { PrintButton } from '@/components/reports/print-button';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { ROUTES } from '@/config/app';
import { guardReportPage } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getPenaltyReport, type PenaltyReportRow } from '@/lib/data/reports';
import { formatUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import { MAX_EXPORT_ROWS } from '@/lib/domain/reporting';
import { singleParam, type ParamRecord } from '@/lib/reports/filters';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';

export const metadata = { title: 'Late-payment charges' };

/**
 * Every recorded late-payment charge.
 *
 * ## Read-only, and not merely by omission
 *
 * There is no edit control, no waiver button and no amount field — and there
 * could not be. `loan_penalties` refuses UPDATE and DELETE for every caller
 * including `service_role`, the amount is re-derived from the stored basis and
 * rate by a CHECK constraint, and no capability to change a charge exists in
 * the permission matrix. §30 asks for a report that does not allow editing;
 * the database already guarantees it.
 *
 * ## Only charges that exist
 *
 * A loan past its grace deadline whose charge has not been written yet is
 * *not* here. It is not a charge until it is on the ledger, and a report that
 * listed projected amounts among recorded ones would invite somebody to total
 * the column. Pending charges appear on the dashboard and the arrears report,
 * labelled as pending. Loading this page materialises nothing — Phase 7 made
 * reads side-effect free and §108 requires it to stay that way.
 *
 * ## Each row shows its own arithmetic
 *
 * What the charge was calculated on, at what rate, and what came out. A
 * borrower disputing a charge, or a Manager checking one, can verify it from
 * the row without anybody explaining the rule.
 */
export default async function PenaltyReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(`${ROUTES.reports}/penalties`, [
    'reports:view_financial',
    'penalties:view',
  ]);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();

  const report = await getPenaltyReport({ page: singleParam(params, 'page') });
  const { totals } = report;

  const columns: readonly ReportColumn<PenaltyReportRow>[] = [
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
      key: 'basis',
      header: 'Charged on',
      numeric: true,
      cell: (row) => formatUgx(row.basisAmount, { withCurrency: false }),
    },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      cell: (row) => formatBps(toBps(row.penaltyRateBps)),
    },
    {
      key: 'amount',
      header: 'Charge',
      numeric: true,
      cell: (row) => formatUgx(row.penaltyAmount, { withCurrency: false }),
    },
    {
      key: 'paid',
      header: 'Paid',
      numeric: true,
      cell: (row) => formatUgx(row.penaltyPaid, { withCurrency: false }),
    },
    {
      key: 'remaining',
      header: 'Remaining',
      numeric: true,
      cell: (row) => formatUgx(row.penaltyRemaining, { withCurrency: false }),
    },
    {
      key: 'finalDue',
      header: 'Final collection',
      hideOnMobile: true,
      cell: (row) => <DateValue value={row.finalDueDate} />,
    },
    {
      key: 'effective',
      header: 'Applies from',
      cell: (row) => <DateValue value={row.effectiveDate} />,
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      <header className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-text text-2xl font-semibold">Late-payment charges</h1>
            <p className="text-text-muted mt-1 text-sm">{branding.companyName}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <PrintButton />
            <ExportLink href={`${ROUTES.reports}/penalties/export`} />
          </div>
        </div>
        <p className="text-text-muted text-sm">
          Each charge is a percentage of what the loan owed when its grace period ran out.
          Charges cannot be edited, deleted or waived by anyone, and this report lists
          only charges already on the ledger.
        </p>
      </header>

      {report.truncated ? (
        <Alert tone="warning" title="Too many charges for one report">
          More than {String(MAX_EXPORT_ROWS)} charges match, so the totals cover only part
          of them.
        </Alert>
      ) : null}

      <StatGrid>
        <StatCard
          label="Charges"
          value={String(totals.penaltyCount)}
          definition="Late-payment charges recorded on the ledger. Pending charges are not counted."
        />
        <StatCard
          label="Charged"
          value={<Money amount={totals.assessed} />}
          metric="penalty_assessed"
        />
        <StatCard
          label="Collected"
          value={<Money amount={totals.collected} />}
          metric="penalty_collected"
          tone="success"
        />
        <StatCard
          label="Unpaid"
          value={<Money amount={totals.outstanding} />}
          metric="penalty_outstanding"
          tone={totals.outstanding > 0 ? 'warning' : 'neutral'}
        />
      </StatGrid>

      <p className="text-text-muted text-sm">
        Charged is money owed to the business, not money received. Collected is the
        penalty component of posted payments.
      </p>

      {report.page.rows.length === 0 ? (
        <ReportEmpty
          title="No late-payment charges"
          description="No loan has passed its grace period still unpaid, so nothing has been charged."
        />
      ) : (
        <ReportTable
          columns={columns}
          rows={report.page.rows}
          rowKey={(row) => row.penaltyId}
          caption="Late-payment charges with what each was charged on, at what rate, and what remains"
        />
      )}

      <ReportPagination
        page={report.page.page}
        hasMore={report.page.hasMore}
        rowsShown={report.page.rows.length}
      />
    </div>
  );
}
