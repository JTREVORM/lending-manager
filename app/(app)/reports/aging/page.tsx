import { Layers } from 'lucide-react';

import { ExportActions } from '@/components/reports/export-actions';
import { FieldTable } from '@/components/reports/field-table';
import { PrintButton } from '@/components/reports/print-button';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportFilters } from '@/components/reports/report-filters';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import { guardReportPage } from '@/lib/auth/guard';
import { getAgingExport } from '@/lib/data/security';
import { AGING_BUCKETS, AGING_BUCKET_LABELS } from '@/lib/domain/risk';
import { agingFields } from '@/lib/reports/fields';
import {
  exportQuery,
  parseAgingBucket,
  parseUuid,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';
import { REPORTS, reportHref } from '@/lib/reports/registry';

export const metadata = { title: 'Aging and portfolio at risk' };

/**
 * The live book, bucketed by how late it is.
 *
 * ## Why this is a report and `/recovery` is not
 *
 * Phase 14 built the aging view and put it on the Debt & Security screen,
 * where it belongs: that screen is a worklist, ordered worst-first, with the
 * controls to record a call or take a promise beside each row.
 *
 * This is the same rows as a *document*. It totals, it exports, it prints on
 * the company's letterhead, and it says which filters produced it — which is
 * what a figure needs before it can be quoted in a meeting. Neither page is a
 * near-copy of the other, because they answer different questions: "who do I
 * chase today" and "what does the book look like".
 *
 * The header says so, and links across, so nobody has to work out which of
 * two similar screens they wanted.
 *
 * ## Every bucket is derived on the read
 *
 * `loan_aging` computes the bucket from `days_past_due` in one `case`, on
 * every read. Nothing is stored, so nothing can go stale: this report is
 * correct on the day it is run rather than on the day somebody last ran a
 * job. That is also why there is no "as at" date to choose — the figures are
 * as at now, and the document says so.
 */
export default async function AgingReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(reportHref('aging'), REPORTS.aging.needs);

  const params = await searchParams;
  const bucket = parseAgingBucket(params);

  const report = await getAgingExport({
    bucket,
    productId: parseUuid(params, 'productId'),
    branchId: parseUuid(params, 'branchId'),
    query: singleParam(params, 'query'),
  });

  const fields = agingFields();
  const query = exportQuery(params, REPORTS.aging.filterKeys);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Insights"
        icon={Layers}
        title={REPORTS.aging.title}
        description="The live book by how late each loan is. Figures are as at the moment the page is read — the bucket is derived from the days past due every time, so nothing here can go stale."
        secondaryActions={
          <>
            <PrintButton />
            <ExportActions report="aging" filterQuery={query} />
          </>
        }
      />

      <p className="text-text-muted text-sm">
        To work down this list rather than account for it — recording a call, a visit or a
        promise against each loan —{' '}
        <RowLink
          href={ROUTES.recovery}
          className="text-brand-700 font-medium underline-offset-2 hover:underline"
        >
          open Debt &amp; Security
        </RowLink>
        , where the PAR1 / PAR7 / PAR30 / PAR60 / PAR90 ratios these buckets produce are
        shown as well.
      </p>

      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'bucket',
            label: 'Aging bucket',
            options: AGING_BUCKETS.map((value) => ({
              value,
              label: AGING_BUCKET_LABELS[value],
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Loan, client number or name',
            placeholder: 'LN260014, CL2600007, Nakato',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'loan' : 'loans'}`}
      />

      <StatGrid>
        <StatCard
          label="Loans"
          value={String(report.totals.loanCount)}
          secondary={
            bucket === undefined
              ? 'Every loan with a balance'
              : AGING_BUCKET_LABELS[bucket]
          }
          icon={Layers}
        />
        <StatCard
          label="Principal outstanding"
          value={<Money amount={report.totals.principalOutstanding} variant="full" />}
          secondary="Principal only, charges excluded"
        />
        <StatCard
          label="Total outstanding"
          value={<Money amount={report.totals.totalOutstanding} variant="full" />}
          secondary="Contract plus unpaid charges"
        />
        <StatCard
          label="Arrears"
          value={<Money amount={report.totals.arrears} variant="full" />}
          secondary="What is overdue now"
          tone={report.totals.arrears > 0 ? 'warning' : 'neutral'}
        />
      </StatGrid>

      {report.rows.length === 0 ? (
        <ReportEmpty
          title="Nothing is in this bucket"
          description="No loan with a balance falls in the selection you asked for. That is a good answer, not a missing one — try clearing the filters to see the whole book."
        />
      ) : (
        <FieldTable
          fields={fields}
          rows={report.rows}
          rowKey={(row) => row.loanId}
          caption="Loans with a balance, by how late they are, worst first"
          compactFor={[
            'Loan number',
            'Client',
            'Aging bucket',
            'Days past due',
            'Arrears (UGX)',
            'Total outstanding (UGX)',
          ]}
        />
      )}
    </div>
  );
}
