import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportFilters } from '@/components/reports/report-filters';
import { ReportPagination } from '@/components/reports/report-pagination';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPES,
  auditActions,
  listAuditPage,
} from '@/lib/data/audit';
import { getCompanyBranding } from '@/lib/data/company';
import { describeRange } from '@/lib/domain/reporting';
import { formatBusinessDate } from '@/lib/domain/datetime';
import { resolveReportRange, singleParam, type ParamRecord } from '@/lib/reports/filters';
import { DateValue } from '@/components/ui/data-value';

export const metadata = { title: 'Audit trail' };

/**
 * The audit trail.
 *
 * Read-only by construction, not by convention: the table has no UPDATE or
 * DELETE policy, those privileges are revoked from every role including
 * `service_role`, and statement-level triggers reject the attempt anyway.
 *
 * ## What Phase 8 changed
 *
 * Filters — date, action, entity, actor — and paging, because a trail that
 * only ever shows the most recent hundred records is not a trail anybody can
 * answer a question with. And the action labels, which had not been updated
 * since Phase 2: until now the viewer showed `loan.disbursed` as raw text for
 * most of what it held.
 *
 * ## It stays apart from the financial reports
 *
 * No money column, no total, no export. §78: the trail records who did what,
 * the reports record what the money did, and a reader able to total an audit
 * listing would try to reconcile two records of different things. There is no
 * link from here into the reporting section and none from there into here.
 *
 * ## Timestamps are shown in the configured timezone
 *
 * Explicitly, from `company_settings`, not from the server's zone or the
 * viewer's browser. The same record must read the same way to everybody who
 * opens it, which is the point of an audit trail. §81.
 */
export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  await guardPermission(ROUTES.audit, 'audit:view');

  const params = await searchParams;
  const { branding } = await getCompanyBranding();

  // No range unless one is asked for: the default view is "the latest
  // records", which is what somebody opening an audit trail wants.
  const hasRange = singleParam(params, 'period') !== undefined;
  const resolved = hasRange
    ? resolveReportRange(params, branding.timezone, 'month')
    : null;

  const action = singleParam(params, 'action');
  const entityType = singleParam(params, 'entity');

  const page = await listAuditPage(
    {
      range: resolved?.range,
      // Whitelisted against the vocabularies, so a hand-edited URL filters on
      // nothing rather than on something unexpected.
      action: action !== undefined && action in AUDIT_ACTION_LABELS ? action : undefined,
      entityType: (AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType ?? '')
        ? entityType
        : undefined,
      actor: singleParam(params, 'actor'),
      page: singleParam(params, 'page'),
    },
    branding.timezone,
  );

  return (
    <div className="min-w-0 space-y-5">
      <header className="min-w-0">
        <h1>Audit trail</h1>
        <p className="text-text-muted mt-1 text-sm">
          Who did what, and when. Records cannot be edited or deleted by anyone, including
          the Owner.{' '}
          {resolved === null
            ? 'Showing the most recent first.'
            : `Showing ${describeRange(resolved.range, formatBusinessDate)}.`}
        </p>
      </header>

      {resolved?.error !== undefined && resolved.error !== null ? (
        <Alert tone="warning" title="That range could not be used">
          {resolved.error}
        </Alert>
      ) : null}

      <ReportFilters
        filters={[
          { kind: 'period' },
          {
            kind: 'select',
            name: 'action',
            label: 'Action',
            options: auditActions().map((value) => ({
              value,
              label: AUDIT_ACTION_LABELS[value] ?? value,
            })),
          },
          {
            kind: 'select',
            name: 'entity',
            label: 'Record type',
            options: AUDIT_ENTITY_TYPES.map((value) => ({
              value,
              label: value.replace(/_/g, ' '),
            })),
          },
          { kind: 'search', name: 'actor', label: 'Done by', placeholder: 'Name' },
        ]}
        resultSummary={`${String(page.rows.length)} ${page.rows.length === 1 ? 'record' : 'records'} shown`}
      />

      {page.rows.length === 0 ? (
        <ReportEmpty
          title="No audit records match"
          description="Nothing was recorded with these filters. Try clearing the action or widening the dates."
        />
      ) : (
        <ul className="min-w-0 space-y-2">
          {page.rows.map((entry) => (
            <li key={entry.id}>
              <Card className="min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">
                      {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                    </p>
                    <p className="text-text-muted mt-0.5 text-sm break-words">
                      by {entry.actorLabel}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge>{entry.entityType.replace(/_/g, ' ')}</Badge>
                    <time dateTime={entry.occurredAt} className="text-text-muted text-xs">
                      <DateValue
                        value={entry.occurredAt}
                        variant="datetime"
                        timeZone={branding.timezone}
                      />
                    </time>
                  </div>
                </div>

                {entry.newValues !== null || entry.oldValues !== null ? (
                  <details className="mt-3">
                    <summary className="text-text-muted min-h-touch flex cursor-pointer items-center text-xs">
                      What changed
                    </summary>
                    <pre className="bg-surface-raised mt-2 overflow-x-auto rounded-lg p-3 text-xs">
                      {JSON.stringify(
                        { before: entry.oldValues, after: entry.newValues },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ReportPagination
        page={page.page}
        hasMore={page.hasMore}
        rowsShown={page.rows.length}
      />
    </div>
  );
}
