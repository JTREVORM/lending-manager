import { notFound } from 'next/navigation';
import { PiggyBank } from 'lucide-react';

import { DepositForm } from '@/components/savings/deposit-form';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getActiveMembershipPolicy } from '@/lib/data/membership';
import { getSavingsAccount, listContributionMonths } from '@/lib/data/savings';
import { activityBlockedReason } from '@/lib/domain/membership';
import { businessToday } from '@/lib/domain/datetime';
import { findContributionMonth } from '@/lib/domain/savings';
import { mintSavingsKey } from '@/lib/savings/actions';
import { uuidSchema } from '@/lib/validation/common';

export const metadata = { title: 'Record a deposit' };

/**
 * Recording a savings deposit.
 *
 * ## Why the idempotency key is minted here
 *
 * Server-side, when this page renders, and carried into the form as a hidden
 * field. That is what makes a double tap safe: both submissions carry the same
 * key, and the database returns the deposit that already exists. A key minted
 * at submit time would be a different key per tap and would protect nothing.
 * See ADR-030.
 *
 * ## The four refusals are stated here rather than discovered at the counter
 *
 * A closed account, an ended membership, savings not yet open under the
 * governing policy version, and an account the caller may not see. Each is
 * refused again by `post_savings_deposit`, so none of these panels is the
 * control — but a staff member who reaches a form, takes the money and *then*
 * learns it cannot be recorded is in a far worse position than one who was
 * told before the member reached into their pocket.
 */
export default async function DepositPage({
  params,
}: {
  readonly params: Promise<{ readonly savingsAccountId: string }>;
}) {
  const { savingsAccountId } = await params;

  if (!uuidSchema.safeParse(savingsAccountId).success) notFound();

  await guardPermission(
    `${ROUTES.savings}/${savingsAccountId}/deposit`,
    'savings:deposit',
  );

  const [account, months, idempotencyKey, policy] = await Promise.all([
    getSavingsAccount(savingsAccountId),
    listContributionMonths(savingsAccountId),
    mintSavingsKey(),
    getActiveMembershipPolicy(),
  ]);

  // A missing account and an unauthorised one look the same, deliberately:
  // distinguishing them would confirm a member exists to somebody who may not
  // see them.
  if (account === null) notFound();

  const header = (
    <PageHeader
      eyebrow="Member Savings"
      icon={PiggyBank}
      back={{
        href: `${ROUTES.savings}/${savingsAccountId}`,
        label: account.fullName,
      }}
      title="Record a deposit"
      description={`Account ${account.accountNumber} · membership ${account.membershipNumber}`}
    />
  );

  if (account.status === 'closed') {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <Alert tone="warning">
          Savings account {account.accountNumber} is closed. A closed account takes no
          further deposits, and closing is final.
        </Alert>
      </div>
    );
  }

  if (!['pending', 'active', 'suspended'].includes(account.membershipStatus)) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <Alert tone="warning">
          Membership {account.membershipNumber} has ended, so its savings account takes no
          further deposits. The balance it holds is still owed to the member or their next
          of kin.
        </Alert>
      </div>
    );
  }

  const savingsBlocked =
    policy === null
      ? 'No membership policy version is in force.'
      : activityBlockedReason(policy, 'savings');

  if (savingsBlocked !== null) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <Alert tone="warning" title="Savings are not open">
          {savingsBlocked} No deposit can be recorded until that is settled.
        </Alert>
      </div>
    );
  }

  // *This* month, found by date rather than taken as the newest row. A member
  // whose last deposit was in March, read in June, would otherwise have
  // March's figure presented as June's — and the counter would be told the
  // month was already met.
  //
  // Absent means nothing has been paid in this month, which is a contribution
  // of zero rather than a missing record.
  const thisMonth = findContributionMonth(months, businessToday());
  const contributedThisMonth = thisMonth === null ? 0 : thisMonth.contributed;

  return (
    <div className="min-w-0 space-y-4">
      {header}
      <DepositForm
        savingsAccountId={account.id}
        accountNumber={account.accountNumber}
        fullName={account.fullName}
        clientNumber={account.clientNumber}
        balance={account.balance}
        monthlyMinimum={account.monthlySavingsMinimum}
        contributedThisMonth={contributedThisMonth}
        idempotencyKey={idempotencyKey}
      />
    </div>
  );
}
