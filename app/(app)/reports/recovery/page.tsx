import { HandCoins } from 'lucide-react';

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
import { getRecoveryExport } from '@/lib/data/security';
import {
  PROMISE_STATUSES,
  PROMISE_STATUS_LABELS,
  RECOVERY_ACTION_KINDS,
  RECOVERY_ACTION_KIND_LABELS,
} from '@/lib/domain/security';
import { recoveryFields } from '@/lib/reports/fields';
import {
  exportQuery,
  parsePromiseStatus,
  parseRecoveryKind,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';
import { REPORTS, reportHref } from '@/lib/reports/registry';

export const metadata = { title: 'Recovery file' };

/**
 * Everything recorded against a loan in recovery.
 *
 * ## Append-only, and the report says so
 *
 * `loan_recovery_actions` refuses UPDATE and DELETE outright. A mistake is
 * corrected by recording a correction that points at the action it corrects,
 * and both stay in the file — which is why there is a `Corrected` column
 * rather than a quietly amended row. A chase file that could be edited after
 * the fact is a chase file nobody can rely on in a dispute.
 *
 * ## A promise's verdict is read, never stored
 *
 * `kept`, `pending` or `broken` is derived from the posted payments against
 * the loan each time the view is read. So a promise made on Monday for Friday
 * reads as pending on Tuesday and as kept or broken from Friday, with nothing
 * running in between. A stored verdict would have been right on the day it was
 * written and wrong from the next payment onwards.
 */
export default async function RecoveryReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardReportPage(reportHref('recovery'), REPORTS.recovery.needs);

  const params = await searchParams;
  const { branding } = await getCompanyBranding();

  const report = await getRecoveryExport({
    kind: parseRecoveryKind(params),
    promiseStatus: parsePromiseStatus(params),
    query: singleParam(params, 'query'),
  });

  const fields = recoveryFields(branding.timezone);
  const query = exportQuery(params, REPORTS.recovery.filterKeys);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Insights"
        icon={HandCoins}
        title={REPORTS.recovery.title}
        description="Every call, visit, message, notice, note and promise recorded against a loan, newest first. Nothing here can be edited — a mistake is corrected by a correction, and both stay in the file."
        secondaryActions={
          <>
            <PrintButton />
            <ExportActions report="recovery" filterQuery={query} />
          </>
        }
      />

      <p className="text-text-muted text-sm">
        To record a call, a visit or a promise, open{' '}
        <RowLink
          href={ROUTES.recovery}
          className="text-brand-700 font-medium underline-offset-2 hover:underline"
        >
          Debt &amp; Security
        </RowLink>
        . This page is the file itself: totalled, printable and exportable.
      </p>

      <ReportFilters
        filters={[
          {
            kind: 'select',
            name: 'kind',
            label: 'What was done',
            options: RECOVERY_ACTION_KINDS.map((value) => ({
              value,
              label: RECOVERY_ACTION_KIND_LABELS[value],
            })),
          },
          {
            kind: 'select',
            name: 'promiseStatus',
            label: 'Promise verdict',
            options: PROMISE_STATUSES.map((value) => ({
              value,
              label: PROMISE_STATUS_LABELS[value],
            })),
          },
          {
            kind: 'search',
            name: 'query',
            label: 'Loan number or client name',
            placeholder: 'LN260014, Nakato',
          },
        ]}
        resultSummary={`${String(report.matchedRows)} ${report.matchedRows === 1 ? 'entry' : 'entries'}`}
      />

      <StatGrid>
        <StatCard
          label="Entries"
          value={String(report.totals.actionCount)}
          secondary={`${String(report.totals.promiseCount)} of them a promise`}
          icon={HandCoins}
        />
        <StatCard
          label="Promised"
          value={<Money amount={report.totals.promised} variant="full" />}
          secondary="What borrowers undertook to pay"
        />
        <StatCard
          label="Paid against promises"
          value={<Money amount={report.totals.promisePaid} variant="full" />}
          secondary="Read from the posted payments"
        />
        <StatCard
          label="Kept / broken"
          value={`${String(report.totals.keptCount)} / ${String(report.totals.brokenCount)}`}
          secondary="A promise still in date counts as neither"
          tone={report.totals.brokenCount > 0 ? 'warning' : 'neutral'}
        />
      </StatGrid>

      {report.rows.length === 0 ? (
        <ReportEmpty
          title="Nothing has been recorded"
          description="No recovery action matches this selection. If the filters are clear, nothing has been recorded against any loan yet — which is what a book with nobody in recovery looks like."
        />
      ) : (
        <FieldTable
          fields={fields}
          rows={report.rows}
          rowKey={(row) => row.id}
          caption="Recovery actions recorded against loans, newest first"
          rowTone={(row) => (row.isCorrected ? 'muted' : undefined)}
          compactFor={[
            'Action date',
            'Loan number',
            'Client',
            'What was done',
            'Outcome',
            'Promised (UGX)',
            'Promise verdict',
          ]}
        />
      )}
    </div>
  );
}
