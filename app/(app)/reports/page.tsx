import { RowLink } from '@/components/ui/row-link';
import {
  AlertTriangle,
  Banknote,
  ChartColumn,
  Clock,
  Receipt,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PageHeader, SectionHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardReportPage } from '@/lib/auth/guard';
import { getCollectionSummary, getPortfolioSummary } from '@/lib/data/dashboard';
import { cn } from '@/lib/utils/cn';
import type { Permission } from '@/lib/permissions';

export const metadata = { title: 'Reports' };

type ReportGroup = 'money-in' | 'behind' | 'book';

interface ReportLink {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly group: ReportGroup;
  /** Every capability the report needs. All of them, not any of them. */
  readonly needs: readonly Permission[];
  /**
   * Period shortcuts, where the report takes one. The report decides what a
   * period means; these only pre-set the filter it already has.
   */
  readonly periods?: readonly { readonly label: string; readonly value: string }[];
}

const PERIODS = [
  { label: 'Today', value: 'today' },
  { label: 'This week', value: 'week' },
  { label: 'This month', value: 'month' },
] as const;

const GROUPS: Readonly<Record<ReportGroup, { title: string; blurb: string }>> = {
  'money-in': {
    title: 'Money received',
    blurb: 'What has actually been collected, and by which method.',
  },
  behind: {
    title: 'Loans behind',
    blurb: 'Who is late, by how much, and what it has cost them.',
  },
  book: {
    title: 'The book',
    blurb: 'Every loan and every borrower, with what each one owes.',
  },
};

const REPORTS: readonly ReportLink[] = [
  {
    href: `${ROUTES.reports}/collections`,
    title: 'Collections',
    description:
      'Payments received over a date range, by day, week or month and by method. Reversed payments are listed and excluded from the totals.',
    icon: Receipt,
    group: 'money-in',
    needs: ['reports:view_operational', 'payments:view'],
    periods: PERIODS,
  },
  {
    href: `${ROUTES.reports}/arrears`,
    title: 'Arrears',
    description:
      'Every loan that is behind: what is overdue, how late, how many collections were missed, and the latest note on the client.',
    icon: AlertTriangle,
    group: 'behind',
    needs: ['reports:view_operational', 'delinquency:view'],
  },
  {
    href: `${ROUTES.reports}/grace`,
    title: 'Grace period',
    description:
      'Loans past their final collection date that can still settle with no charge, and the date each grace period ends.',
    icon: Clock,
    group: 'behind',
    needs: ['reports:view_operational', 'delinquency:view'],
  },
  {
    href: `${ROUTES.reports}/penalties`,
    title: 'Late-payment charges',
    description:
      'Every charge raised: what it was charged on, at what rate, what has been paid and what remains.',
    icon: AlertTriangle,
    group: 'behind',
    needs: ['reports:view_financial', 'penalties:view'],
  },
  {
    href: `${ROUTES.reports}/loans`,
    title: 'Loan portfolio',
    description:
      'Every loan with its contract, what has been paid, what is outstanding and its current status. Filter by status, state or disbursement date.',
    icon: Banknote,
    group: 'book',
    needs: ['reports:view_financial', 'loans:view'],
  },
  {
    href: `${ROUTES.reports}/clients`,
    title: 'Clients',
    description:
      'The client directory with each borrower’s outstanding balance and current status. No identification numbers.',
    icon: Users,
    group: 'book',
    needs: ['reports:view_operational', 'clients:view'],
  },
];

/**
 * The reporting hub.
 *
 * ## What it replaced
 *
 * Six text-only cards in the top third of the page and nothing in the rest of
 * it. No indication which report answers which question, no way to open one at
 * a useful date range, and nothing to say whether it was worth opening today.
 *
 * ## The three figures at the top
 *
 * Collected today, outstanding and arrears — read from the **same dashboard
 * summaries the dashboard itself reads**, not recomputed here. They exist to
 * answer "is there anything to look at" before somebody opens three reports to
 * find out. Each is shown only when the viewer may see it: the portfolio
 * figures need `reports:view_financial`, which a Secretary/Treasurer does not
 * hold, so they see the collections figure alone.
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
export default async function ReportsPage() {
  const context = await guardReportPage(ROUTES.reports, ['reports:view_operational']);

  const available = REPORTS.filter((report) =>
    report.needs.every((permission) => contextCan(context, permission)),
  );

  const canSeeFinancial = contextCan(context, 'reports:view_financial');

  // The same reads the dashboard performs. Not a second query with its own
  // interpretation: a hub that disagreed with the dashboard about today's
  // takings would be worse than one with no figures at all.
  const [collections, portfolio] = await Promise.all([
    contextCan(context, 'payments:view') ? getCollectionSummary() : Promise.resolve(null),
    canSeeFinancial ? getPortfolioSummary() : Promise.resolve(null),
  ]);

  const groups = (Object.keys(GROUPS) as ReportGroup[])
    .map((group) => ({ group, reports: available.filter((r) => r.group === group) }))
    .filter((block) => block.reports.length > 0);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Insights"
        icon={ChartColumn}
        title="Reports"
        description="Every figure here is read from the ledger and the schedules. Nothing on these pages changes a record."
      />

      {collections === null && portfolio === null ? null : (
        <section aria-labelledby="highlights-heading">
          <SectionHeader
            id="highlights-heading"
            title="Where things stand"
            description="The same figures the dashboard shows, so there is no need to open a report to find out whether there is one worth opening."
          />

          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            {collections === null ? null : (
              <Highlight
                label="Collected today"
                amount={collections.collectedToday}
                note={`${String(collections.paymentsToday)} ${collections.paymentsToday === 1 ? 'payment' : 'payments'}`}
                href={`${ROUTES.reports}/collections?period=today`}
              />
            )}
            {portfolio === null ? null : (
              <>
                <Highlight
                  label="Outstanding"
                  amount={portfolio.totalOutstanding}
                  note="Contract plus unpaid charges"
                  href={`${ROUTES.reports}/loans`}
                />
                <Highlight
                  label="In arrears"
                  amount={portfolio.arrearsTotal}
                  note={`${String(portfolio.loansWithArrears)} ${portfolio.loansWithArrears === 1 ? 'loan' : 'loans'} behind`}
                  href={`${ROUTES.reports}/arrears`}
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
              title={GROUPS[block.group].title}
              description={GROUPS[block.group].blurb}
            />

            <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
              {block.reports.map((report) => {
                const Icon = report.icon;

                return (
                  <li key={report.href} className="min-w-0">
                    <Card className="lift flex h-full min-w-0 flex-col">
                      {/* RowLink, not Link: one of these is rendered per
                          report and per period chip, and prefetching all
                          thirteen cost a field officer thirteen report pages
                          of airtime for the one they open. Measured: 65
                          requests on this screen, of which 24 were prefetches
                          nobody asked for. */}
                      <RowLink
                        href={report.href}
                        className="focus-visible:outline-accent -m-1 flex min-w-0 items-start gap-3 rounded-lg p-1 focus-visible:outline-2"
                      >
                        <span className="bg-accent text-accent-contrast flex size-10 shrink-0 items-center justify-center rounded-md [box-shadow:var(--elevate-2)]">
                          <Icon aria-hidden="true" className="size-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-text block text-base font-semibold">
                            {report.title}
                          </span>
                          <span className="text-text-muted mt-1 block text-sm">
                            {report.description}
                          </span>
                        </span>
                      </RowLink>

                      {report.periods === undefined ? null : (
                        <div className="mt-3 flex flex-wrap gap-1.5 pl-12">
                          {report.periods.map((period) => (
                            <RowLink
                              key={period.value}
                              href={`${report.href}?period=${period.value}`}
                              className="border-border text-text-muted hover:border-accent hover:text-accent rounded-full border px-2.5 py-1 text-xs"
                            >
                              {period.label}
                            </RowLink>
                          ))}
                        </div>
                      )}
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
