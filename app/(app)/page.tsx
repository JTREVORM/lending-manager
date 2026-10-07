import { CirclePlus, LayoutDashboard, Search, UserPlus } from 'lucide-react';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { ActionLink } from '@/components/ui/page-header';
import { CollectionSheet } from '@/components/dashboard/collection-sheet';
import { ExecutiveCards } from '@/components/dashboard/executive-cards';
import { LoanActivity } from '@/components/dashboard/loan-activity';
import { PortfolioCards } from '@/components/dashboard/portfolio-cards';
import { RecentPayments } from '@/components/dashboard/recent-payments';
import { TodayCards } from '@/components/dashboard/today-cards';
import { UpcomingCollections } from '@/components/dashboard/upcoming-collections';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import {
  getCollectionSummary,
  getPortfolioSummary,
  listCollectionSheet,
  listRecentClearances,
  listRecentDisbursements,
  listRecentPayments,
  listRecentlyPenalised,
  listUpcomingCollections,
} from '@/lib/data/dashboard';
import { businessToday } from '@/lib/domain/datetime';
import { addBusinessDays } from '@/lib/domain/datetime';
import { getAppEnvironment, inspectPublicEnv } from '@/lib/env.public';
import { ROLES, effectiveRole } from '@/lib/permissions';
import { DateValue } from '@/components/ui/data-value';

export const metadata = { title: 'Dashboard' };

/** How many of today's collections the dashboard shows before linking onward. */
const SHEET_PREVIEW_ROWS = 8;

/**
 * The staff dashboard.
 *
 * ## One page, composed from the caller's capabilities
 *
 * There is no `OwnerDashboard`, `ManagerDashboard` and `SecretaryDashboard`
 * component. Three near-identical files would be three places to fix a wrong
 * figure, and the first one somebody forgot would quietly show the old number
 * to one role. Instead each section declares the capability it needs and the
 * page renders the sections the caller holds — so what each role sees is still
 * distinct, but there is exactly one definition of each card:
 *
 *   * **Owner/Administrator** — the business summary (what was lent, what came
 *     in, charged against collected), the loan book, today, the collection
 *     sheet, recent payments and recent lifecycle activity.
 *   * **Manager** — the loan book, today, the collection sheet, recent
 *     payments. No business income figures: `reports:view_sensitive` is the
 *     Owner's, and supervising lending does not require knowing what the
 *     business earns.
 *   * **Secretary/Treasurer** — today with the method split, the collection
 *     sheet, upcoming collections, recent payments. No portfolio-wide
 *     outstanding or interest figures (§42).
 *   * **A borrower** never reaches this page at all. They hold `portal:view`,
 *     not `dashboard:view`, and the route guard sends them to the portal.
 *
 * ## Every query is skipped when it is not needed
 *
 * A caller without `reports:view_financial` never triggers the portfolio
 * summary query. That is both faster and the honest shape of the code: the
 * data is not fetched and then hidden in the markup, which is the mistake that
 * turns a presentation decision into a leak the moment somebody reads the HTML.
 *
 * ## Nothing here writes
 *
 * Including no penalty. Loans past their grace deadline are counted as
 * "penalty pending" with a projected amount; the charge is written by the next
 * transaction that touches the loan. Phase 7 made reads side-effect free and
 * loading a dashboard is a read.
 */
export default async function DashboardPage() {
  const context = await guardPermission(ROUTES.dashboard, 'dashboard:view');

  const { branding, fallbackReason } = await getCompanyBranding();
  const envStatus = inspectPublicEnv();
  const environment = getAppEnvironment();

  const role = effectiveRole(context.roles);
  const roleLabel = role === null ? 'No role' : ROLES[role].label;

  const seeOperational = contextCan(context, 'reports:view_operational');
  const seeFinancial = contextCan(context, 'reports:view_financial');
  const seeSensitive = contextCan(context, 'reports:view_sensitive');
  const seeDelinquency = contextCan(context, 'delinquency:view');
  const seePayments = contextCan(context, 'payments:view');
  const mayCollect = contextCan(context, 'payments:create');

  const today = businessToday(new Date(), branding.timezone);

  const [
    portfolio,
    collections,
    sheet,
    recentPayments,
    upcoming,
    disbursements,
    clearances,
    penalised,
  ] = await Promise.all([
    seeFinancial || seeSensitive ? getPortfolioSummary() : Promise.resolve(null),
    seeOperational ? getCollectionSummary() : Promise.resolve(null),
    seeDelinquency
      ? listCollectionSheet({ pageSize: SHEET_PREVIEW_ROWS })
      : Promise.resolve(null),
    seePayments ? listRecentPayments(6) : Promise.resolve([]),
    seeDelinquency
      ? listUpcomingCollections({ after: today, through: addBusinessDays(today, 7) })
      : Promise.resolve([]),
    seeSensitive ? listRecentDisbursements(4) : Promise.resolve([]),
    seeSensitive ? listRecentClearances(4) : Promise.resolve([]),
    seeSensitive ? listRecentlyPenalised(4) : Promise.resolve([]),
  ]);

  const summaryUnavailable =
    (seeFinancial || seeSensitive) && portfolio === null
      ? 'The portfolio figures could not be read just now. They are derived from the ledger, so nothing is lost — reload in a moment.'
      : null;

  // The hero's greeting and attention line, built from figures already read
  // above — no extra query, and no invented metric.
  const nowHour = Number(
    new Date().toLocaleString('en-GB', {
      timeZone: branding.timezone,
      hour: '2-digit',
      hour12: false,
    }),
  );
  const greeting =
    nowHour < 12 ? 'Good morning' : nowHour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = context.fullName.trim().split(/\s+/)[0] ?? context.fullName;
  const attentionParts: string[] = [];
  if (collections !== null) {
    attentionParts.push(
      `${String(collections.clientsDueToday)} ${collections.clientsDueToday === 1 ? 'client' : 'clients'} due today`,
    );
  }
  if (portfolio !== null) {
    attentionParts.push(
      `${String(portfolio.loansWithArrears)} ${portfolio.loansWithArrears === 1 ? 'loan' : 'loans'} in arrears`,
    );
  }
  const attention =
    attentionParts.length > 0
      ? `You have ${attentionParts.join(' and ')}.`
      : `Welcome back to ${branding.companyName}.`;

  return (
    <div className="min-w-0 space-y-6">
      {/*
        The dashboard's banner.

        The same `.page-banner` every other screen opens with, rather than the
        bespoke navy gradient this page used to carry — one product does not
        have two hero treatments, and the dashboard is the screen a reader sees
        first, so a private gradient here made every page after it look like a
        different system.

        The reference's eyebrow / title / description arrangement holds, with
        the screen's name in the eyebrow and the person greeted in the
        heading, which is what this screen is actually for.
      */}
      <section aria-labelledby="dash-greeting" className="page-banner p-5 sm:p-6">
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {/* The eyebrow names the screen and the heading greets the
                person — the arrangement this page already had, and the one
                the reference's banner expects. The eyebrow is also how a
                reader (and the browser suite) knows which page this is: the
                heading is a first name, which identifies nothing on its
                own. */}
            <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold text-blue-100">
              <LayoutDashboard aria-hidden="true" className="size-3.5 text-amber-400" />
              Dashboard
            </p>
            <p className="text-[13px] text-blue-100">{greeting},</p>
            <h1 id="dash-greeting" className="t-page-title text-white">
              {firstName}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-blue-100">
              {attention}
            </p>
          </div>

          {/*
            On its own translucent panel, and in white rather than `blue-100`.

            This block sits at the right-hand end of the banner, which is where
            the gradient warms towards amber — pale blue text on that stretch
            fails contrast, and the panel keeps the whole group legible wherever
            the gradient happens to land behind it at a given width.
          */}
          <div className="shrink-0 rounded-lg bg-black/15 px-3 py-2 text-right text-[12px] text-white">
            <p className="text-[12px] font-bold">{roleLabel}</p>
            <p className="max-w-[12rem] truncate">{branding.companyName}</p>
            <p className="mt-0.5 text-white/90">
              <DateValue value={today} />
            </p>
            {environment !== 'production' ? (
              <span className="mt-2 inline-flex rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white">
                {environment}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      {!envStatus.ok ? (
        <Alert tone="warning" title="Supabase is not configured">
          <ul className="list-disc space-y-0.5 pl-5">
            {envStatus.problems.map((problem) => (
              <li key={problem} className="font-mono text-xs">
                {problem}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {fallbackReason !== undefined ? (
        <Alert tone="warning" title="Company details are not set up">
          {fallbackReason}
        </Alert>
      ) : null}

      {summaryUnavailable !== null ? (
        <Alert tone="warning" title="Figures unavailable">
          {summaryUnavailable}
        </Alert>
      ) : null}

      {seeSensitive && portfolio !== null ? <ExecutiveCards summary={portfolio} /> : null}

      {seeOperational && collections !== null ? (
        <TodayCards summary={collections} canSeeMethods={seePayments} />
      ) : null}

      {seeFinancial && portfolio !== null ? (
        <PortfolioCards summary={portfolio} canSeeReports={seeOperational} />
      ) : null}

      {seeDelinquency && sheet !== null ? (
        <section aria-labelledby="sheet-heading" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="sheet-heading" className="text-base">
              Due today
            </h2>
            <Link
              href={`${ROUTES.reports}/collections`}
              className="text-brand-700 text-sm hover:underline"
            >
              Collection report
            </Link>
          </div>

          <CollectionSheet rows={sheet.rows} canCollect={mayCollect} />

          {sheet.hasMore ? (
            <p className="text-text-muted text-sm">
              Showing the first {String(SHEET_PREVIEW_ROWS)}.{' '}
              <Link href={ROUTES.overdue} className="text-brand-700 hover:underline">
                See every loan that is behind
              </Link>
              .
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {seePayments ? (
          <section aria-labelledby="recent-heading" className="min-w-0 space-y-3">
            <h2 id="recent-heading" className="text-base">
              Recent payments
            </h2>
            <RecentPayments payments={recentPayments} timeZone={branding.timezone} />
          </section>
        ) : null}

        {seeDelinquency ? (
          <section aria-labelledby="upcoming-heading" className="min-w-0 space-y-3">
            <h2 id="upcoming-heading" className="text-base">
              Next seven days
            </h2>
            <UpcomingCollections collections={upcoming} />
          </section>
        ) : null}
      </div>

      {seeSensitive ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          <section aria-labelledby="disbursed-heading" className="min-w-0 space-y-3">
            <h2 id="disbursed-heading" className="text-base">
              Recently paid out
            </h2>
            <LoanActivity
              rows={disbursements}
              kind="disbursed"
              timeZone={branding.timezone}
              emptyTitle="No loans paid out yet"
              emptyDescription="A loan appears here once it has been disbursed."
            />
          </section>

          <section aria-labelledby="cleared-heading" className="min-w-0 space-y-3">
            <h2 id="cleared-heading" className="text-base">
              Recently settled
            </h2>
            <LoanActivity
              rows={clearances}
              kind="cleared"
              timeZone={branding.timezone}
              emptyTitle="No loans settled yet"
              emptyDescription="A loan appears here once its contract and any charge are fully paid."
            />
          </section>

          <section aria-labelledby="penalised-heading" className="min-w-0 space-y-3">
            <h2 id="penalised-heading" className="text-base">
              Recently charged
            </h2>
            <LoanActivity
              rows={penalised}
              kind="penalised"
              timeZone={branding.timezone}
              emptyTitle="No late-payment charges"
              emptyDescription="A charge appears here once a loan has passed its grace period still unpaid."
            />
          </section>
        </div>
      ) : null}

      <Card>
        <CardHeader title="Quick actions" as="h2" />
        <ul className="flex flex-wrap gap-2">
          {mayCollect ? (
            <li>
              <ActionLink href={`${ROUTES.payments}/new`}>
                <CirclePlus aria-hidden="true" className="size-4" />
                Record a payment
              </ActionLink>
            </li>
          ) : null}
          {contextCan(context, 'clients:view') ? (
            <li>
              <ActionLink href={ROUTES.clients} variant="secondary">
                <Search aria-hidden="true" className="size-4" />
                Find a client
              </ActionLink>
            </li>
          ) : null}
          {contextCan(context, 'clients:create') ? (
            <li>
              <ActionLink href={`${ROUTES.clients}/new`} variant="secondary">
                <UserPlus aria-hidden="true" className="size-4" />
                Register a client
              </ActionLink>
            </li>
          ) : null}
          {seeOperational ? (
            <li>
              <ActionLink href={ROUTES.reports} variant="secondary">
                Reports
              </ActionLink>
            </li>
          ) : null}
        </ul>
      </Card>
    </div>
  );
}
