import { ChartColumn } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PageHeader, SectionHeader } from '@/components/ui/page-header';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardReportPage } from '@/lib/auth/guard';
import { getCollectionSummary, getPortfolioSummary } from '@/lib/data/dashboard';
import {
  PERIOD_SHORTCUTS,
  REPORTS,
  REPORT_GROUPS,
  REPORT_GROUP_LABELS,
  REPORT_IDS,
  isReportGroup,
  reportHref,
  type ReportGroup,
} from '@/lib/reports/registry';
import { singleParam, type ParamRecord } from '@/lib/reports/filters';
import { cn } from '@/lib/utils/cn';

export const metadata = { title: 'Reports' };

/**
 * The reporting hub.
 *
 * ## It is now a rendering of the registry
 *
 * This page used to hold its own array of reports — title, description, icon,
 * capabilities, period chips — beside the array in each page's guard and the
 * list in each export route. Four copies of the same facts, and the failure was
 * never loud: a report added without an entry here simply did not appear in the
 * hub, so nobody could find it, and a capability list that drifted from a
 * page's was a security defect that looked like a typo.
 *
 * `lib/reports/registry.ts` is the one declaration now. This page maps over it.
 * Adding a report is adding an entry, and `tests/integration/report-routes.test.ts`
 * fails if an entry has no page, no export, or capabilities that differ from
 * what that test pins.
 *
 * ## It is a module's front door, not a line in a menu
 *
 * The rail shows Reports as one of the business's modules, and its entries
 * are these four **groups** — not the ten report definitions, which stay
 * here, because this is where a report is chosen, pointed at a period and
 * exported from. `?group=` narrows the listing to one of them, which is what
 * each rail entry opens; an unrecognised value shows everything rather than
 * nothing, because a hand-edited query string should not look like a
 * reporting module with no reports in it.
 *
 * ## The three figures at the top
 *
 * Collected today, outstanding and arrears — read from the **same dashboard
 * summaries the dashboard itself reads**, not recomputed here. They answer "is
 * there anything to look at" before somebody opens three reports to find out. A
 * hub that disagreed with the dashboard about today's takings would be worse
 * than one with no figures at all.
 *
 * ## Why a report is listed only when every capability is held
 *
 * `needs` is a conjunction, not a disjunction. The arrears report is a
 * rendering of delinquency data, so a holder of `reports:view_operational` who
 * somehow lacked `delinquency:view` would open it and see nothing — Row Level
 * Security would refuse the rows. Listing it would be an invitation to a blank
 * page, and a blank page is how somebody concludes the system is broken rather
 * than that they are not entitled.
 *
 * The listing is a courtesy either way. Each page performs its own
 * `guardReportPage`, and the export routes check again, because a URL can be
 * typed and a hidden link protects nothing.
 */
export default async function ReportsPage({
  searchParams,
}: {
  readonly searchParams: Promise<ParamRecord>;
}) {
  const context = await guardReportPage(ROUTES.reports, ['reports:view_operational']);

  const raw = singleParam(await searchParams, 'group');
  const selected: ReportGroup | null = isReportGroup(raw) ? raw : null;

  // Kept as ids rather than definitions, so `reportHref` and the lookup both
  // stay typed: `REPORTS` is heterogeneous — each entry is written against its
  // own row type — and mapping it to values first collapses that.
  const available = REPORT_IDS.filter((id) =>
    REPORTS[id].needs.every((permission) => contextCan(context, permission)),
  );

  const canSeeFinancial = contextCan(context, 'reports:view_financial');

  // The same reads the dashboard performs. Not a second query with its own
  // interpretation of the same question.
  const [collections, portfolio] = await Promise.all([
    contextCan(context, 'payments:view') ? getCollectionSummary() : Promise.resolve(null),
    canSeeFinancial ? getPortfolioSummary() : Promise.resolve(null),
  ]);

  // Only groups this person has a report in, so a chip never opens onto an
  // empty list.
  const offered = REPORT_GROUPS.filter((group) =>
    available.some((id) => REPORTS[id].group === group),
  );

  const groups = (selected === null ? offered : [selected])
    .map((group) => ({
      group,
      reports: available.filter((id) => REPORTS[id].group === group),
    }))
    .filter((block) => block.reports.length > 0);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Reports"
        icon={ChartColumn}
        title={selected === null ? 'Reports' : REPORT_GROUP_LABELS[selected].title}
        description="Read from the ledger and the schedules. Nothing here changes a record; every report downloads as a spreadsheet and as a letterheaded document."
      />

      {offered.length < 2 ? null : (
        <nav
          aria-label="Report groups"
          className="chip-row border-border bg-surface rounded-lg border p-1.5 shadow-xs print:hidden"
        >
          <RowLink
            href={ROUTES.reports}
            aria-current={selected === null ? 'true' : undefined}
            className={cn(
              'chip',
              selected === null
                ? 'bg-accent text-accent-contrast shadow-xs'
                : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            All
          </RowLink>
          {offered.map((group) => (
            <RowLink
              key={group}
              href={`${ROUTES.reports}?group=${group}`}
              aria-current={selected === group ? 'true' : undefined}
              className={cn(
                'chip',
                selected === group
                  ? 'bg-accent text-accent-contrast shadow-xs'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text',
              )}
            >
              {REPORT_GROUP_LABELS[group].title}
            </RowLink>
          ))}
        </nav>
      )}

      {collections === null && portfolio === null ? null : (
        <section aria-labelledby="highlights-heading">
          <SectionHeader id="highlights-heading" title="Where things stand" />

          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            {collections === null ? null : (
              <Highlight
                label="Collected today"
                amount={collections.collectedToday}
                note={`${String(collections.paymentsToday)} ${collections.paymentsToday === 1 ? 'payment' : 'payments'}`}
                href={`${reportHref('collections')}?period=today`}
              />
            )}
            {portfolio === null ? null : (
              <>
                <Highlight
                  label="Outstanding"
                  amount={portfolio.totalOutstanding}
                  note="Contract plus unpaid charges"
                  href={reportHref('loans')}
                />
                <Highlight
                  label="In arrears"
                  amount={portfolio.arrearsTotal}
                  note={`${String(portfolio.loansWithArrears)} ${portfolio.loansWithArrears === 1 ? 'loan' : 'loans'} behind`}
                  href={reportHref('arrears')}
                  tone={portfolio.arrearsTotal > 0 ? 'warning' : 'neutral'}
                />
              </>
            )}
          </div>
        </section>
      )}

      {groups.length === 0 ? (
        <EmptyState
          icon={ChartColumn}
          title="No reports are available to you"
          description="Your role does not include any reporting capability. Speak to the Owner / Administrator if you need one."
        />
      ) : (
        groups.map((block) => (
          <section key={block.group} aria-labelledby={`${block.group}-heading`}>
            <SectionHeader
              id={`${block.group}-heading`}
              title={REPORT_GROUP_LABELS[block.group].title}
            />

            <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
              {block.reports.map((id) => {
                const report = REPORTS[id];
                const Icon = report.icon;
                const href = reportHref(id);

                return (
                  <li key={id} className="min-w-0">
                    <Card className="lift flex h-full min-w-0 flex-col">
                      {/* RowLink, not Link: one of these is rendered per
                          report and per period chip, and prefetching all of
                          them cost a field officer a dozen report pages of
                          airtime for the one they open. Measured in Phase 9:
                          65 requests on this screen, of which 24 were
                          prefetches nobody asked for. */}
                      <RowLink
                        href={href}
                        className="focus-visible:outline-accent -m-1 flex min-w-0 items-start gap-3 rounded-lg p-1 focus-visible:outline-2"
                      >
                        <span className="bg-accent text-accent-contrast flex size-10 shrink-0 items-center justify-center rounded-md [box-shadow:var(--elevate-2)]">
                          <Icon aria-hidden="true" className="size-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-text block text-base font-semibold">
                            {report.title}
                          </span>
                          <span className="text-text-muted mt-0.5 block text-xs">
                            {report.description}
                          </span>
                        </span>
                      </RowLink>

                      <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-12">
                        {report.defaultPeriod === undefined
                          ? null
                          : PERIOD_SHORTCUTS.map((period) => (
                              <RowLink
                                key={period.value}
                                href={`${href}?period=${period.value}`}
                                className="border-border text-text-muted hover:border-accent hover:text-accent rounded-full border px-2.5 py-1 text-xs"
                              >
                                {period.label}
                              </RowLink>
                            ))}

                        {/* Where the same rows have an operational screen,
                            say so. A report is for accounting — totalled,
                            printable, exportable — and the operational screen
                            is for doing. They are not the same job, and
                            leaving somebody to work out which of two similar
                            screens they wanted is how a collections officer
                            ends up printing the arrears report to work from. */}
                        {report.actOn === undefined ? null : (
                          <RowLink
                            href={report.actOn.href}
                            className="text-text-muted hover:text-accent text-xs underline-offset-2 hover:underline"
                          >
                            To act on these, open {report.actOn.label}
                          </RowLink>
                        )}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function Highlight({
  label,
  amount,
  note,
  href,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly amount: number;
  readonly note: string;
  readonly href: string;
  readonly tone?: 'neutral' | 'warning';
}) {
  return (
    <RowLink
      href={href}
      className={cn(
        'surface-raised-soft lift focus-visible:outline-accent block min-w-0 rounded-lg border p-4 focus-visible:outline-2 focus-visible:outline-offset-2',
        tone === 'warning' ? 'border-warning/40' : 'border-border',
      )}
    >
      <span className="t-label">{label}</span>
      <p className="t-metric-sm text-text mt-2 break-words">
        <Money amount={amount} variant="full" />
      </p>
      <span className="t-caption mt-1 block">{note}</span>
    </RowLink>
  );
}
