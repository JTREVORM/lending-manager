import { UserCheck } from 'lucide-react';

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
import { getGuarantorExposureExport } from '@/lib/data/security';
import { GUARANTEE_STATUSES, GUARANTEE_STATUS_LABELS } from '@/lib/domain/security';
import { guarantorFields } from '@/lib/reports/fields';
import {
  exportQuery,
  parseGuaranteeStatus,
  parseSubjectKind,
  parseUuid,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';
import { REPORTS, reportHref } from '@/lib/reports/registry';

export const metadata = { title: 'Guarantor exposure' };

/**
 * Every guarantee given, and what stands behind it.
 *
 * ## What the business asked for, column by column
 *
 * The brief names this report's columns: the guarantor, whether they are an
 * existing client or external, their phone, the borrower, the loan, the
 * product, the guaranteed amount and the guarantor's total exposure, the
 * outstanding balance, the guarantee date, the loan status, the guarantee
 * status, and the release status and date. All of them are here, in that
 * order, and they are the same columns the spreadsheet and the document carry
 * because all three read one field set.
 *
 * ## Why the live cover total excludes released guarantees
 *
 * A released guarantee is history. The guarantor was told they are out, and a
 * total that counted their amount among what the business is covered for would
 * overstate the cover by every guarantee ever let go — which is the kind of
 * figure that gets quoted in a lending decision. So the released ones stay in
 * the rows, where somebody can see them and see why, and the cover total
 * counts only what is still live. The released count is shown beside it, so
 * the exclusion is visible rather than silent.
 */
export default async function GuarantorExposureReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(reportHref('guarantors'), REPORTS.guarantors.needs);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();

  const report = await getGuarantorExposureExport({
    subjectKind: parseSubjectKind(params),
    guaranteeStatus: parseGuaranteeStatus(params),
    productId: parseUuid(params, 'productId'),
    query: singleParam(params, 'query'),
  });

  const fields = guarantorFields(branding.timezone);
  const query = exportQuery(params, REPORTS.guarantors.filterKeys);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Insights"
        icon={UserCheck}
        title={REPORTS.guarantors.title}
        description="Every guarantee given, with what the guarantor stood behind and what that loan still owes. A released guarantee stays in the list, so the decision to let somebody out is visible rather than absent."
        secondaryActions={
          <>
            <PrintButton />
            <ExportActions report="guarantors" filterQuery={query} />
          </>
        }
      />

      <p className="text-text-muted text-sm">
        To release a guarantee, or to read one guarantor&rsquo;s own record, open{' '}
        <RowLink
          href={ROUTES.guarantorRegister}
          className="text-brand-700 font-medium underline-offset-2 hover:underline"
        >
          the guarantor register
        </RowLink>
        .
      </p>

      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'subjectKind',
            label: 'Guarantor',
            options: [
              { value: 'client', label: 'Existing client' },
              { value: 'external', label: 'External' },
            ],
          },
          {
            kind: 'select',
            name: 'guaranteeStatus',
            label: 'Guarantee status',
            options: GUARANTEE_STATUSES.map((value) => ({
              value,
              label: GUARANTEE_STATUS_LABELS[value],
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Guarantor, borrower or loan',
            placeholder: 'Ssemakula, LN260014',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'guarantee' : 'guarantees'}`}
      />

      <StatGrid>
        <StatCard
          label="Guarantees"
          value={String(report.totals.guaranteeCount)}
          secondary={`${String(report.totals.releasedCount)} released`}
          icon={UserCheck}
        />
        <StatCard
          label="Live cover"
          value={<Money amount={report.totals.guaranteed} variant="full" />}
          secondary="Released guarantees excluded"
        />
        <StatCard
          label="Outstanding behind it"
          value={<Money amount={report.totals.outstanding} variant="full" />}
          secondary="What the guaranteed loans still owe"
        />
        <StatCard
          label="Of which in arrears"
          value={<Money amount={report.totals.arrears} variant="full" />}
          secondary="Where a guarantor may be called on"
          tone={report.totals.arrears > 0 ? 'warning' : 'neutral'}
        />
      </StatGrid>

      {report.rows.length === 0 ? (
        <ReportEmpty
          title="No guarantee matches"
          description="Nothing in the register matches this selection. If the filters are clear, no loan has a guarantor attached yet."
        />
      ) : (
        <FieldTable
          fields={fields}
          rows={report.rows}
          rowKey={(row) => row.loanGuarantorId}
          caption="Guarantees given, with the exposure behind each"
          rowTone={(row) => (row.isReleased ? 'muted' : undefined)}
          compactFor={[
            'Guarantor',
            'Existing client or external',
            'Borrower',
            'Loan number',
            'Guaranteed amount (UGX)',
            'Outstanding balance (UGX)',
            'Guarantee status',
          ]}
        />
      )}
    </div>
  );
}
