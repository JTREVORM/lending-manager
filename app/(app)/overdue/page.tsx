import { AlertTriangle } from 'lucide-react';
import { OverdueList } from '@/components/delinquency/overdue-list';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { countByDelinquencyState, listDelinquentLoans } from '@/lib/data/delinquency';
import { businessToday } from '@/lib/domain/datetime';
import { isDelinquencyState, type DelinquencyState } from '@/lib/domain/delinquency';

export const metadata = { title: 'Overdue' };

/**
 * The overdue list.
 *
 * ## Why this route has its own capability
 *
 * `delinquency:view`, checked by `guardPermission` against the route map.
 * Phase 3 shipped `/clients` behind `dashboard:view` and Phase 6 found the
 * same defect on `/payments`; a route that lists every borrower who is behind
 * on a payment is not a route to make that mistake on a third time.
 *
 * The guard is not the only control — the policies on `loans`, `clients` and
 * `loan_penalties` decide which rows the view returns, and they would refuse a
 * caller who reached the data another way. But a borrower who followed a link
 * here should be turned away at the door rather than shown an empty table.
 *
 * ## Nothing is materialised by loading this page
 *
 * A loan past its grace deadline shows its pending penalty as pending. The
 * charge is written to the ledger by the next transaction that touches the
 * loan — `post_payment` materialises it before reading any balance — because a
 * page load is a read, and a read that wrote financial records would be a
 * surprise nobody asked for. The figures here are honest about which charges
 * exist and which are due to be made.
 */
export default async function OverduePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.overdue, 'delinquency:view');

  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const rawState = single('state');
  const states: readonly DelinquencyState[] | undefined =
    rawState !== undefined && rawState !== 'all' && isDelinquencyState(rawState)
      ? [rawState]
      : undefined;

  const rawDays = Number(single('days'));
  const minDaysPastDue = Number.isInteger(rawDays) && rawDays > 0 ? rawDays : undefined;

  const rawPage = Number(single('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const [{ loans, hasMore }, counts, { branding }] = await Promise.all([
    listDelinquentLoans({
      states,
      minDaysPastDue,
      query: single('query'),
      page,
    }),
    countByDelinquencyState(),
    getCompanyBranding(),
  ]);

  const today = businessToday(new Date(), branding.timezone);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Delinquency"
        icon={AlertTriangle}
        title="Overdue"
        description="Loans with something uncovered: what is due now, how late it is, and whether a late-payment charge applies. Settled loans are not listed."
      />

      <OverdueList
        loans={loans}
        page={page}
        hasMore={hasMore}
        counts={counts}
        businessDate={today}
      />
    </div>
  );
}
