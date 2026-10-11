import { ShieldCheck } from 'lucide-react';

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
import { getCompanyBranding } from '@/lib/data/company';
import { getCollateralExport } from '@/lib/data/security';
import { COLLATERAL_STATUSES, COLLATERAL_STATUS_LABELS } from '@/lib/domain/security';
import { collateralFields } from '@/lib/reports/fields';
import {
  exportQuery,
  parseCollateralStatusFilter,
  type ParamRecord,
} from '@/lib/reports/filters';
import { REPORTS, reportHref } from '@/lib/reports/registry';

export const metadata = { title: 'Security held' };

/**
 * Every item taken as security against a loan.
 *
 * ## The valuation total is of what is still held
 *
 * An item that has been released is back with the borrower; an item that has
 * been sold is gone and its proceeds are a payment. Neither is cover any more,
 * so neither is in the valuation figure — a total that included them would say
 * the business is secured against things it has handed back. The counts beside
 * it make the exclusion visible: items, of which held, and of which sold.
 *
 * ## An item's identity freezes at disbursement
 *
 * Before the money moves, a pledged item is part of the application — a
 * description somebody types, corrects and re-values. From disbursement it is
 * evidence of what the business agreed to lend against, so its type,
 * description, valuation, valuation date, serial number and ownership document
 * freeze and a DELETE is refused. What stays open is the status, because
 * release and realisation are things that happen to a live loan by definition.
 *
 * That is why this report can be read as a record rather than as a snapshot of
 * whatever somebody last typed.
 */
export default async function CollateralReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(reportHref('collateral'), REPORTS.collateral.needs);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();

  const status = parseCollateralStatusFilter(params);
  const report = await getCollateralExport({ status });

  const fields = collateralFields(branding.timezone);
  const query = exportQuery(params, REPORTS.collateral.filterKeys);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Insights"
        icon={ShieldCheck}
        title={REPORTS.collateral.title}
        description="Every item taken as security, with its valuation, where it is kept and its ownership document. Once the loan is live an item's identity is frozen — only its status can change."
        secondaryActions={
          <>
            <PrintButton />
            <ExportActions report="collateral" filterQuery={query} />
          </>
        }
      />

      <p className="text-text-muted text-sm">
        To take in an item, release one or record a sale, open{' '}
        <RowLink
          href={ROUTES.recovery}
          className="text-brand-700 font-medium underline-offset-2 hover:underline"
        >
          Debt &amp; Security
        </RowLink>
        . Proceeds of a sale reach the loan as a payment, which is a separate act from
        recording the sale.
      </p>

      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'status',
            label: 'Status',
            options: COLLATERAL_STATUSES.map((value) => ({
              value,
              label: COLLATERAL_STATUS_LABELS[value],
            })),
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'item' : 'items'}`}
      />

      <StatGrid>
        <StatCard
          label="Items"
          value={String(report.totals.itemCount)}
          secondary={`${String(report.totals.heldCount)} still held`}
          icon={ShieldCheck}
        />
        <StatCard
          label="Held, valued at"
          value={<Money amount={report.totals.valuedAt} variant="full" />}
          secondary="Released and sold items excluded"
        />
        <StatCard
          label="Sold"
          value={String(report.totals.realisedCount)}
          secondary="Items realised against a loan"
        />
        <StatCard
          label="Sold for"
          value={<Money amount={report.totals.realised} variant="full" />}
          secondary="Proceeds reach a loan as a payment"
        />
      </StatGrid>

      {report.rows.length === 0 ? (
        <ReportEmpty
          title="No security matches"
          description="Nothing in the register matches this selection. If the filters are clear, no loan has an item recorded against it yet — which is normal for a book of unsecured lending."
        />
      ) : (
        <FieldTable
          fields={fields}
          rows={report.rows}
          rowKey={(row) => row.id}
          caption="Items taken as security, with their valuations and status"
          rowTone={(row) => (row.status === 'held' ? undefined : 'muted')}
          compactFor={[
            'Loan number',
            'Client',
            'Item type',
            'Description',
            'Valued at (UGX)',
            'Status',
          ]}
        />
      )}
    </div>
  );
}
