import { notFound } from 'next/navigation';
import { PiggyBank } from 'lucide-react';

import { ContributionProgress } from '@/components/savings/contribution-progress';
import {
  SavingsAccountStatusBadge,
  WithdrawalStatusBadge,
} from '@/components/savings/savings-badges';
import { SavingsStatementTable } from '@/components/savings/savings-statement';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  clientHasLiveLoan,
  getLiveWithdrawal,
  getSavingsAccount,
  getSavingsQualification,
  getSavingsStatement,
  listContributionMonths,
} from '@/lib/data/savings';
import { getActiveMembershipPolicy } from '@/lib/data/membership';
import { isSavingsAccountStatus, withdrawalBlockedReason } from '@/lib/domain/savings';
import { toUgx } from '@/lib/domain/money';
import { uuidSchema } from '@/lib/validation/common';

export const metadata = { title: 'Savings account' };

/**
 * One member's savings account.
 *
 * ## Why a missing account and an unauthorised one look the same
 *
 * `getSavingsAccount` runs as the caller, so an account the policies hide
 * comes back as `null` — exactly as a non-existent one does. Both reach
 * `notFound()`. Distinguishing them would confirm to somebody who may not see
 * a member that the member exists, which is the one thing a 404 is for.
 *
 * ## The two actions are offered on what the caller holds *and* what the
 * account allows
 *
 * A deposit button for a closed account, or a withdrawal button for a member
 * whose live loan blocks one, would be an invitation to be refused. So each is
 * offered only when the capability is held and the operation would actually
 * be accepted — and where a withdrawal is blocked, the reason is stated rather
 * than the button simply being absent, because "why can I not do this" is the
 * question a counter will be asked by the member standing in front of them.
 *
 * Both are re-checked by the action and refused again by the posting function.
 * Nothing on this page is the control.
 */
export default async function SavingsAccountPage({
  params,
}: {
  readonly params: Promise<{ readonly savingsAccountId: string }>;
}) {
  const context = await guardPermission(ROUTES.savings, 'savings:view');
  const { savingsAccountId } = await params;

  // A route segment that is not a uuid is not a 500: PostgREST would refuse
  // the filter, and the page would report a database fault for what is a bad
  // link.
  if (!uuidSchema.safeParse(savingsAccountId).success) notFound();

  const account = await getSavingsAccount(savingsAccountId);
  if (account === null) notFound();

  const [qualification, months, statement, liveWithdrawal, hasLiveLoan, policy] =
    await Promise.all([
      getSavingsQualification(savingsAccountId),
      listContributionMonths(savingsAccountId),
      getSavingsStatement({ savingsAccountId, from: '', to: '' }),
      getLiveWithdrawal(savingsAccountId),
      clientHasLiveLoan(account.clientId),
      getActiveMembershipPolicy(),
    ]);

  const canDeposit = contextCan(context, 'savings:deposit');
  const canRequest = contextCan(context, 'savings:request_withdrawal');

  const withdrawalBlocked = withdrawalBlockedReason({
    accountStatus: isSavingsAccountStatus(account.status) ? account.status : 'dormant',
    membershipIsActive: account.membershipStatus === 'active',
    balance: account.balance,
    hasLiveWithdrawal: liveWithdrawal !== null,
    hasLiveLoan,
    withdrawalRule: policy?.savingsWithdrawalWithActiveLoan ?? null,
  });

  const depositBlocked = account.status === 'closed';

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Savings"
        icon={PiggyBank}
        back={{ href: ROUTES.savings, label: 'Savings' }}
        title={account.fullName}
        description={`Account ${account.accountNumber} · membership ${account.membershipNumber}`}
        status={<SavingsAccountStatusBadge status={account.status} />}
        primaryAction={
          canDeposit && !depositBlocked ? (
            <ActionLink href={`${ROUTES.savings}/${account.id}/deposit`}>
              Record a deposit
            </ActionLink>
          ) : undefined
        }
        secondaryActions={
          <>
            <ActionLink
              href={`${ROUTES.savings}/${account.id}/statement`}
              variant="secondary"
            >
              Statement
            </ActionLink>
            {canRequest && withdrawalBlocked === null ? (
              <ActionLink
                href={`${ROUTES.savings}/${account.id}/withdraw`}
                variant="secondary"
              >
                Request a withdrawal
              </ActionLink>
            ) : null}
          </>
        }
      />

      {/* --- What the account holds ------------------------------------- */}
      <Card>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Balance</dt>
            <dd className="text-text mt-0.5">
              {/* The one figure this screen exists to show. It is
                  `sum(signed_amount)` over the subledger — there is no stored
                  balance anywhere in this schema for it to disagree with. */}
              <Money amount={account.balance} weight="semibold" size="lg" />
            </dd>
            <dd className="text-text-muted mt-0.5 text-xs">
              What the business owes this member
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Paid in, all time</dt>
            <dd className="text-text mt-0.5 tabular-nums">
              <Money amount={account.totalDeposited} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Taken out, all time</dt>
            <dd className="text-text mt-0.5 tabular-nums">
              <Money amount={account.totalWithdrawn} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Opened</dt>
            <dd className="text-text mt-0.5">
              <DateValue value={account.openedOn} />
            </dd>
            <dd className="text-text-muted mt-0.5 text-xs">
              {account.transactionCount === 1
                ? '1 movement'
                : `${String(account.transactionCount)} movements`}
            </dd>
          </div>
        </dl>

        <dl className="border-border mt-4 grid min-w-0 gap-4 border-t pt-4 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Member</dt>
            <dd className="text-text mt-0.5">
              <RowLink
                href={`${ROUTES.membership}/${account.membershipId}`}
                className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {account.membershipNumber}
              </RowLink>
              <span className="text-text-muted ml-2 font-mono text-xs">
                {account.clientNumber}
              </span>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Phone</dt>
            <dd className="text-text mt-0.5">
              <PhoneValue value={account.phone} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Branch</dt>
            <dd className="text-text mt-0.5">{account.branchName ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      {/* --- Why an action is not on offer ------------------------------ */}
      {canRequest && withdrawalBlocked !== null ? (
        <Alert tone="info" title="A withdrawal cannot be prepared right now">
          {withdrawalBlocked}
          {liveWithdrawal === null ? null : (
            <>
              {' '}
              <RowLink
                href={`${ROUTES.savingsWithdrawals}/${liveWithdrawal.id}`}
                className="underline underline-offset-2"
              >
                {liveWithdrawal.requestNumber}
              </RowLink>
            </>
          )}
        </Alert>
      ) : null}

      {depositBlocked ? (
        <Alert tone="info" title="This account is closed">
          A closed account takes no further deposits. Its history stays as it is.
        </Alert>
      ) : null}

      {/* --- Progress --------------------------------------------------- */}
      <ContributionProgress
        qualification={qualification}
        months={months}
        monthlyMinimum={account.monthlySavingsMinimum}
      />

      {/* --- The live withdrawal, if there is one ----------------------- */}
      {liveWithdrawal === null ? null : (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-text text-sm font-semibold">
              A withdrawal is in progress
            </h2>
            <WithdrawalStatusBadge status={liveWithdrawal.status} />
          </div>
          <p className="text-text-muted mt-2 text-sm">
            <span className="font-mono">{liveWithdrawal.requestNumber}</span> ·{' '}
            <Money amount={liveWithdrawal.amount} /> · prepared by{' '}
            {liveWithdrawal.requestedByLabel} on{' '}
            <DateValue value={liveWithdrawal.businessDate} />.
          </p>
          <p className="text-text mt-1 text-sm break-words">{liveWithdrawal.reason}</p>
        </Card>
      )}

      {/* --- The statement ---------------------------------------------- */}
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-text text-sm font-semibold">Every movement</h2>
          <RowLink
            href={`${ROUTES.savings}/${account.id}/statement`}
            className="text-accent text-xs underline-offset-2 hover:underline"
          >
            Statement for a period
          </RowLink>
        </div>
        <SavingsStatementTable lines={statement} accountNumber={account.accountNumber} />
      </div>

      {/* The balance restated under the statement, so a printed page carries
          it at the bottom where a reader looks for a total. */}
      {statement.length === 0 ? null : (
        <p className="text-text-muted text-right text-sm tabular-nums">
          Balance <Money amount={toUgx(account.balance)} weight="semibold" />
        </p>
      )}
    </div>
  );
}
