import { FilterChips } from '@/components/agency/filter-chips';
import { Card, CardHeader } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { REPORT_PERIOD_LABELS, REPORT_PERIODS } from '@/lib/domain/reporting';
import {
  AGENCY_REPORT_SECTIONS,
  AGENCY_REPORT_SECTION_META,
  AGENCY_SCOPE_LABELS,
  AGENCY_REPORT_SCOPES,
  agencyReportHref,
  agencyReportQuery,
  type AgencyReportFilter,
} from '@/lib/agency/reporting';
import type { AgencyProviderRow } from '@/lib/domain/agency';

/**
 * The reporting hub's section list and its filters.
 *
 * ## Why links rather than a form
 *
 * Every filter is a link carrying the whole filter forward, so the back
 * button works, a report can be bookmarked and shared, and the page needs no
 * JavaScript to be usable. The custom date range is the one exception — two
 * dates cannot be a chip — and it is a GET form whose inputs are the same
 * parameters the links carry.
 *
 * ## Why the section list is here and not a tab strip
 *
 * The rail already carries the nine sections, and this is the same list for a
 * reader who arrived at the hub rather than at a section. Both are links to
 * `?section=`, so neither can drift from the other: there is one set of
 * section ids, declared in `lib/agency/reporting.ts`.
 */
export function AgencyReportFilters({
  filter,
  providers,
}: {
  readonly filter: AgencyReportFilter;
  readonly providers: readonly AgencyProviderRow[];
}) {
  return (
    <Card>
      <CardHeader
        title="Reports"
        description="Choose a report, then narrow it. Every link carries the whole filter, so a report can be bookmarked and shared."
      />

      <div className="min-w-0 space-y-4">
        <FilterChips
          label="Report"
          options={AGENCY_REPORT_SECTIONS.map((section) => ({
            href: agencyReportHref(filter, section),
            label: AGENCY_REPORT_SECTION_META[section].label,
            active: filter.section === section,
          }))}
        />

        <FilterChips
          label="Business"
          options={AGENCY_REPORT_SCOPES.map((scope) => ({
            href: `${ROUTES.agencyReports}${agencyReportQuery(filter, { scope, provider: null })}`,
            label: AGENCY_SCOPE_LABELS[scope],
            active: filter.providerCode === null && filter.scope === scope,
          }))}
        />

        {providers.length === 0 ? null : (
          <FilterChips
            label="Provider"
            options={[
              {
                href: `${ROUTES.agencyReports}${agencyReportQuery(filter, { provider: null })}`,
                label: 'Every provider',
                active: filter.providerCode === null,
              },
              ...providers.map((provider) => ({
                href: `${ROUTES.agencyReports}${agencyReportQuery(filter, { provider: provider.code })}`,
                label: provider.name,
                active: filter.providerCode === provider.code,
              })),
            ]}
          />
        )}

        <FilterChips
          label="Period"
          options={REPORT_PERIODS.filter((period) => period !== 'custom').map(
            (period) => ({
              href: `${ROUTES.agencyReports}?${new URLSearchParams({
                ...(filter.section === 'overview' ? {} : { section: filter.section }),
                ...(filter.scope === 'all' ? {} : { scope: filter.scope }),
                ...(filter.providerCode === null
                  ? {}
                  : { provider: filter.providerCode }),
                period,
              }).toString()}`,
              label: REPORT_PERIOD_LABELS[period],
              active: filter.period === period,
            }),
          )}
        />

        {/* The one filter that cannot be a chip. A GET form, so it carries the
            same parameters the links do and leaves a shareable URL behind. */}
        <form
          method="get"
          action={ROUTES.agencyReports}
          aria-label="A custom date range"
          className="flex min-w-0 flex-wrap items-end gap-2"
        >
          <input type="hidden" name="period" value="custom" />
          {filter.section === 'overview' ? null : (
            <input type="hidden" name="section" value={filter.section} />
          )}
          {filter.scope === 'all' ? null : (
            <input type="hidden" name="scope" value={filter.scope} />
          )}
          {filter.providerCode === null ? null : (
            <input type="hidden" name="provider" value={filter.providerCode} />
          )}

          <label className="min-w-0 text-xs font-semibold">
            <span className="text-text-muted mb-1 block text-[11px] font-bold tracking-wide uppercase">
              From
            </span>
            <input
              type="date"
              name="from"
              defaultValue={filter.range.from}
              className="border-border bg-surface focus-visible:ring-brand h-11 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </label>
          <label className="min-w-0 text-xs font-semibold">
            <span className="text-text-muted mb-1 block text-[11px] font-bold tracking-wide uppercase">
              To
            </span>
            <input
              type="date"
              name="to"
              defaultValue={filter.range.to}
              className="border-border bg-surface focus-visible:ring-brand h-11 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            />
          </label>
          <button
            type="submit"
            className="bg-brand min-h-touch rounded-lg px-4 text-xs font-bold text-white md:min-h-9"
          >
            Apply range
          </button>
        </form>
      </div>
    </Card>
  );
}
