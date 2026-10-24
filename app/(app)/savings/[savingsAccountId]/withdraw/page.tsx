import { notFound } from 'next/navigation';
import { Banknote } from 'lucide-react';

import { WithdrawalRequestForm } from '@/components/savings/withdrawal-request-form';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getActiveMembershipPolicy } from '@/lib/data/membership';
import {
  clientHasLiveLoan,
  getLiveWithdrawal,
  getSavingsAccount,
} from '@/lib/data/savings';
import { isSavingsAccountStatus, withdrawalBlockedReason } from '@/lib/domain/savings';
import { uuidSchema } from '@/lib/validation/common';

export const metadata = { title: 'Request a withdrawal' };

/**
 * Preparing a withdrawal.
 *
 * Every reason a withdrawal cannot be prepared is checked here and stated as a
 * sentence, and every one is checked again by
 * `request_savings_withdrawal` — so this page is a courtesy, not the control.
 * The courtesy matters because the member is standing there: being told "this
 * cannot be done, and here is why" before the form is filled in is a different
 * conversation from being refused after it.
 *
 * The one that is worth the trouble is the live loan. Where the policy says
 * savings may only be withdrawn above what secures a loan, the amount that
 * secures it is undefined — it depends on the savings-to-loan multiplier,
 * which the client has not settled. So the operation is refused rather than a
 * figure invented, and the sentence says what has to be decided.
 */
export default async function RequestWithdrawalPage({
  params,
}: {
  readonly params: Promise<{ readonly savingsAccountId: string }>;
}) {
  const { savingsAccountId } = await params;

  if (!uuidSchema.safeParse(savingsAccountId).success) notFound();

  await guardPermission(
    `${ROUTES.savings}/${savingsAccountId}/withdraw`,
    'savings:request_withdrawal',
  );

  const account = await getSavingsAccount(savingsAccountId);
  if (account === null) notFound();

  const [liveWithdrawal, hasLiveLoan, policy] = await Promise.all([
    getLiveWithdrawal(savingsAccountId),
    clientHasLiveLoan(account.clientId),
    getActiveMembershipPolicy(),
  ]);

  const blocked = withdrawalBlockedReason({
    accountStatus: isSavingsAccountStatus(account.status) ? account.status : 'dormant',
    membershipIsActive: account.membershipStatus === 'active',
    balance: account.balance,
    hasLiveWithdrawal: liveWithdrawal !== null,
    hasLiveLoan,
    withdrawalRule: policy?.savingsWithdrawalWithActiveLoan ?? null,
  });

  const header = (
    <PageHeader
      eyebrow="Member Savings"
      icon={Banknote}
      back={{
        href: `${ROUTES.savings}/${savingsAccountId}`,
        label: account.fullName,
      }}
      title="Request a withdrawal"
      description={`Account ${account.accountNumber} · membership ${account.membershipNumber}`}
    />
  );

  if (blocked !== null) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <Alert tone="warning" title="This withdrawal cannot be prepared">
          {blocked}
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {header}
      <WithdrawalRequestForm
        savingsAccountId={account.id}
        accountNumber={account.accountNumber}
        fullName={account.fullName}
        clientNumber={account.clientNumber}
        balance={account.balance}
      />
    </div>
  );
}
