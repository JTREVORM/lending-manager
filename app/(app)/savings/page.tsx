import { PiggyBank } from 'lucide-react';

import { SavingsRegister } from '@/components/savings/savings-register';
import { SavingsSummaryPanel } from '@/components/savings/savings-summary-panel';
import { Alert } from '@/components/ui/alert';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getActiveMembershipPolicy } from '@/lib/data/membership';
import { getSavingsSummary, listSavingsAccounts } from '@/lib/data/savings';
import { activityBlockedReason } from '@/lib/domain/membership';
import { savingsSearchSchema } from '@/lib/validation/savings';

export const metadata = { title: 'Savings' };

/**
 * The savings register.
 *
 * Guarded three times, in the shape every register here uses: the proxy
 * refuses an anonymous request, the layout applies the route requirement, and
 * this page states `savings:view` again explicitly so the requirement stays
 * visible at the surface that depends on it. Beneath all of it, Row Level
 * Security means a caller without the capability gets no rows however they
 * ask — and a member gets their own account, through the identity clause on
 * `clients.profile_id` rather than through a capability.
 *
 * ## The banner is about savings, and only about savings
 *
 * Savings open when the qualification rule and the withdrawal rule are
 * decided, and on nothing else. Phase 1 learned this the hard way: a banner
 * that announced the whole membership programme was paralysed while any of
 * nine questions was open was both untrue and counter-productive, because a
 * warning that overstates its own scope teaches the reader to scroll past it.
 *
 * So this one asks one question — is the savings activity open — and the
 * answer is read from the policy row rather than hard-coded, so it stops
 * appearing the moment those two rules are approved.
 *
 * ## Why the withdrawal queue is a secondary action rather than a tab
 *
 * It is a different person's work. A Secretary spends the day on this
 * register; a Manager opens the queue to decide. Making it a tab here would
 * put a Secretary one tap from a screen they cannot act on — the route is
 * guarded by `savings:approve_withdrawal`, so it would refuse them — so it is
 * offered only to the people who hold that capability.
 */
export default async function SavingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.savings, 'savings:view');
  const params = await searchParams;

  const parsed = savingsSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : 'all',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  // A malformed filter in the URL falls back to the default view rather than
  // erroring: the filter is a convenience, not a control.
  const filter = parsed.success
    ? parsed.data
    : { query: null, status: 'all' as const, compliance: 'all' as const, page: 1 };

  const [page, summary, policy] = await Promise.all([
    listSavingsAccounts(filter),
    getSavingsSummary(),
    getActiveMembershipPolicy(),
  ]);

  const savingsBlocked =
    policy === null
      ? 'No membership policy version is in force yet, so no savings account can be opened.'
      : activityBlockedReason(policy, 'savings');

  const canDecide = contextCan(context, 'savings:approve_withdrawal');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Savings"
        icon={PiggyBank}
        title="Savings"
        description="Member savings accounts and what each holds. Search by account number, membership number, member name or client number."
        secondaryActions={
          canDecide ? (
            <ActionLink href={ROUTES.savingsWithdrawals} variant="secondary">
              Withdrawal requests
            </ActionLink>
          ) : undefined
        }
      />

      {savingsBlocked === null ? null : (
        <Alert tone="warning" title="Savings are not open yet">
          {savingsBlocked} Existing accounts and balances below are unaffected — what is
          held up is opening a new account and moving money.
        </Alert>
      )}

      <SavingsSummaryPanel summary={summary} />

      <SavingsRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          status: filter.status === 'all' ? '' : (filter.status ?? ''),
        }}
      />
    </div>
  );
}
