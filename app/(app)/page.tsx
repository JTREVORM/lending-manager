import { CirclePlus, LayoutDashboard, Search, UserPlus } from 'lucide-react';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { RetryButton } from '@/components/ui/retry-button';
import { Card, CardHeader } from '@/components/ui/card';
import { ActionLink } from '@/components/ui/page-header';
import { AwaitingDecision } from '@/components/dashboard/awaiting-decision';
import { CollectionSheet } from '@/components/dashboard/collection-sheet';
import { ExecutiveCards } from '@/components/dashboard/executive-cards';
import { LoanActivity } from '@/components/dashboard/loan-activity';
import { PortfolioCards } from '@/components/dashboard/portfolio-cards';
import { RecentPayments } from '@/components/dashboard/recent-payments';
import { RecoveryWorkloadCards } from '@/components/dashboard/recovery-workload';
import { RiskHeadline } from '@/components/dashboard/risk-headline';
import { SavingsCards } from '@/components/dashboard/savings-cards';
import { TodayCards } from '@/components/dashboard/today-cards';
import { UpcomingCollections } from '@/components/dashboard/upcoming-collections';
import { allWithLimit } from '@/lib/async/with-limit';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getPortfolioAtRisk } from '@/lib/data/security';
import { getSavingsSummary } from '@/lib/data/savings';
import {
  getCollectionSummary,
  getPendingApprovals,
  getPortfolioSummary,
  getRecoveryWorkload,
  listCollectionSheet,
  listRecentLoanActivity,
  listRecentPayments,
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
 * How many dashboard reads may be in flight at once.
 *
 * Two, not eleven. `lib/async/with-limit.ts` carries the measurement: when
 * the database is the constraint, wall clock does not improve with
 * parallelism, but the slowest individual statement grows with it — and
 * PostgreSQL cancels on a per-statement budget. Eleven concurrent reads made
 * every one of them six times slower than it needed to be, burned nearly ten
 * times the database's work-time, and got them cancelled with `57014` — and
 * the page was 52% *slower* for it.
 *
 * Two rather than one because the Free tier has about two vCPU: two keeps
 * both busy without oversubscribing either, and the measurement puts it within
 * 10% of serial on wall clock (285 ms against 260 ms) while holding the worst
 * statement to twice its uncontended cost instead of six times. One would
 * under-use a provisioned instance; three already triples the worst statement.
 */
const DASHBOARD_READ_LIMIT = 2;

/** "a", "a and b", "a, b and c" — an English list, for the notice below. */
function listSections(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${String(names[names.length - 1])}`;
}

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

  // Phase 17. Three capabilities the dashboard had no use for until the
  // modules behind them existed.
  const seeRecovery = contextCan(context, 'recovery:view');
  const mayApproveTransfers = contextCan(context, 'transfers:approve');
  const mayApproveExpenses = contextCan(context, 'expenses:approve');
  const mayApproveCounts = contextCan(context, 'reconciliation:approve');
  const mayApproveAnything =
    mayApproveTransfers || mayApproveExpenses || mayApproveCounts;

  // Polytos Phase 2. `savings:view_reports` rather than `savings:view`: a
  // Secretary takes deposits all day and does not read the business-wide
  // position, and `savings_summary` refuses them anyway.
  const seeSavingsReports = contextCan(context, 'savings:view_reports');

  const today = businessToday(new Date(), branding.timezone);

  const [
    portfolio,
    collections,
    sheet,
    recentPayments,
    upcoming,
    activity,
    risk,
    recoveryWorkload,
    pendingApprovals,
    savingsSummary,
  ] = await allWithLimit(
    [
      // ---- Critical: the figures the page is read for. -------------------
      // Ordered first deliberately. With a ceiling, order decides who runs
      // while the budget is tightest, so the headline figures are the ones
      // that get the quiet database.
      () =>
        seeFinancial || seeSensitive ? getPortfolioSummary() : Promise.resolve(null),
      () => (seeOperational ? getCollectionSummary() : Promise.resolve(null)),

      // ---- Secondary: the activity panels. -------------------------------
      () =>
        seeDelinquency
          ? listCollectionSheet({ pageSize: SHEET_PREVIEW_ROWS })
          : Promise.resolve(null),
      () => (seePayments ? listRecentPayments(6) : Promise.resolve(null)),
      () =>
        seeDelinquency
          ? listUpcomingCollections({ after: today, through: addBusinessDays(today, 7) })
          : Promise.resolve(null),

      // One read for all three lifecycle cards. Three separate reads each cost
      // a scan of the whole loan book, which is what tipped them past the
      // database's statement budget in production.
      () => (seeSensitive ? listRecentLoanActivity(4) : Promise.resolve(null)),

      // Portfolio at risk is a reading of the live book, so it needs both the
      // delinquency data and the entitlement to portfolio-wide figures — the
      // same pair the aging report is behind.
      () =>
        seeFinancial && seeDelinquency ? getPortfolioAtRisk() : Promise.resolve(null),

      () => (seeRecovery ? getRecoveryWorkload(today) : Promise.resolve(null)),

      // Each count is skipped for a caller who could not act on it, so the
      // figure is absent from the page rather than hidden in its markup.
      () =>
        mayApproveAnything
          ? getPendingApprovals({
              transfers: mayApproveTransfers,
              expenses: mayApproveExpenses,
              reconciliations: mayApproveCounts,
            })
          : Promise.resolve(null),

      // Polytos Phase 2. Last in the list, which is where the ceiling puts
      // the least urgent read: the savings position is a figure somebody
      // glances at, not the one the page is opened for.
      () => (seeSavingsReports ? getSavingsSummary() : Promise.resolve(null)),
    ],
    DASHBOARD_READ_LIMIT,
  );

  /**
   * Which sections the caller is entitled to but could not be read.
   *
   * Every reader above returns `null` for "the query failed", and the page
   * only asks for a section the caller holds the capability for — so
   * "entitled and null" is exactly a failed read, and the two cases cannot be
   * confused. Phase 19: these sections used to return an empty list or a zero
   * on failure, which a reader cannot tell from a quiet day. An empty
   * collection sheet means nobody owes anything today; zero portfolio-at-risk
   * means a book with no arrears in it. Both are statements about the
   * business, and neither was true — the database had cancelled the query
   * (57014) after its eight-second budget.
   *
   * So a section that could not be read is named here and not drawn at all.
   */
  const unreadable: string[] = [];
  if ((seeFinancial || seeSensitive) && portfolio === null)
    unreadable.push('the portfolio summary');
  if (seeOperational && collections === null)
    unreadable.push("today's collection summary");
  if (seeDelinquency && sheet === null) unreadable.push("today's collection sheet");
  if (seePayments && recentPayments === null) unreadable.push('recent payments');
  if (seeDelinquency && upcoming === null) unreadable.push('upcoming collections');
  if (seeSensitive && activity === null) unreadable.push('recent loan activity');
  if (seeFinancial && seeDelinquency && risk === null)
    unreadable.push('portfolio at risk');
  if (seeRecovery && recoveryWorkload === null) unreadable.push('the recovery workload');
  if (mayApproveAnything && pendingApprovals === null)
    unreadable.push('approvals awaiting a decision');
  if (seeSavingsReports && savingsSummary === null)
    unreadable.push('the savings position');

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

      {unreadable.length > 0 ? (
        <Alert tone="warning" title="Some figures could not be read">
          {/*
            Named, not summarised. "Something went wrong" leaves a reader
            guessing which card to distrust, and the cards that failed are not
            drawn — so without the list, a missing section is indistinguishable
            from one this role never sees.
          */}
          <p>
            {`This dashboard could not read ${listSections(unreadable)}. Those sections are left out rather than shown as nil — every figure is derived from the ledger, so nothing is lost.`}
          </p>
          <p className="mt-3">
            <RetryButton label="Read the figures again" />
          </p>
        </Alert>
      ) : null}

      {seeSensitive && portfolio !== null ? <ExecutiveCards summary={portfolio} /> : null}

      {seeOperational && collections !== null ? (
        <TodayCards summary={collections} canSeeMethods={seePayments} />
      ) : null}

      {seeFinancial && portfolio !== null ? (
        <PortfolioCards summary={portfolio} canSeeReports={seeOperational} />
      ) : null}

      {/*
        Phase 17. Everything below here is a read of a module built after the
        dashboard was written — risk monitoring, the recovery file, and the
        money movements that wait for a decision. Each was reachable only by
        opening the screen it lives on, which meant the page a person opens
        first said nothing about any of it.
      */}
      {risk === null ? null : <RiskHeadline slice={risk.portfolio} />}

      {savingsSummary === null ? null : <SavingsCards summary={savingsSummary} />}

      {recoveryWorkload === null ? null : (
        <RecoveryWorkloadCards workload={recoveryWorkload} />
      )}

      {pendingApprovals === null ? null : <AwaitingDecision pending={pendingApprovals} />}

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
        {seePayments && recentPayments !== null ? (
          <section aria-labelledby="recent-heading" className="min-w-0 space-y-3">
            <h2 id="recent-heading" className="text-base">
              Recent payments
            </h2>
            <RecentPayments payments={recentPayments} timeZone={branding.timezone} />
          </section>
        ) : null}

        {seeDelinquency && upcoming !== null ? (
          <section aria-labelledby="upcoming-heading" className="min-w-0 space-y-3">
            <h2 id="upcoming-heading" className="text-base">
              Next seven days
            </h2>
            <UpcomingCollections collections={upcoming} />
          </section>
        ) : null}
      </div>

      {seeSensitive && activity !== null ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-3">
          <section aria-labelledby="disbursed-heading" className="min-w-0 space-y-3">
            <h2 id="disbursed-heading" className="text-base">
              Recently paid out
            </h2>
            <LoanActivity
              rows={activity.disbursements}
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
              rows={activity.clearances}
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
              rows={activity.penalised}
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
