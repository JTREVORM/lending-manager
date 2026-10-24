import { Banknote } from 'lucide-react';

import { WithdrawalQueue } from '@/components/savings/withdrawal-queue';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { listWithdrawalRequests } from '@/lib/data/savings';
import { withdrawalSearchSchema } from '@/lib/validation/savings';

export const metadata = { title: 'Withdrawal requests' };

/**
 * The withdrawal queue.
 *
 * Guarded by `savings:approve_withdrawal` rather than `savings:view`, which is
 * why the route table lists `/savings/withdrawals` **before** `/savings`:
 * matched the other way round the longer path would inherit the shorter one's
 * requirement, and a Secretary — who holds `savings:view` and may prepare a
 * withdrawal but not decide one — would land on a screen of decisions they
 * cannot make.
 *
 * The decision itself is checked again by `decideWithdrawalAction` and refused
 * again by `decide_savings_withdrawal`, which additionally refuses a decision
 * from whoever prepared the request. Nothing on this screen is the control.
 */
export default async function WithdrawalsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.savingsWithdrawals, 'savings:approve_withdrawal');
  const params = await searchParams;

  const parsed = withdrawalSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : 'pending',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const filter = parsed.success
    ? parsed.data
    : { query: null, status: 'pending' as const, page: 1 };

  const page = await listWithdrawalRequests(filter);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Savings"
        icon={Banknote}
        back={{ href: ROUTES.savings, label: 'Savings' }}
        title="Withdrawal requests"
        description="Prepared withdrawals waiting for a decision, and what has already been decided. A withdrawal cannot be decided by the person who prepared it."
        secondaryActions={
          <ActionLink href={ROUTES.savings} variant="secondary">
            Savings register
          </ActionLink>
        }
      />

      <WithdrawalQueue
        page={page}
        filter={{
          query: filter.query ?? '',
          status: filter.status ?? 'pending',
        }}
      />
    </div>
  );
}
