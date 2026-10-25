import { notFound } from 'next/navigation';
import { Banknote } from 'lucide-react';

import {
  SavingsAccountStatusBadge,
  WithdrawalStatusBadge,
} from '@/components/savings/savings-badges';
import { WithdrawalDecisionPanel } from '@/components/savings/withdrawal-decision-panel';
import { Card } from '@/components/ui/card';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getSavingsAccount, getWithdrawalRequest } from '@/lib/data/savings';
import { mintSavingsKey } from '@/lib/savings/actions';
import { uuidSchema } from '@/lib/validation/common';

export const metadata = { title: 'Withdrawal request' };

/**
 * One withdrawal request: what was asked for, what was decided, and what is
 * left to do.
 *
 * ## The idempotency key is minted here, for the payment that may follow
 *
 * Even though the payment form only appears once the request is approved. The
 * key belongs to the *render*, which is what makes it work: a Manager who taps
 * "Pay" twice sends the same key both times and the database returns the
 * payment that already exists. See ADR-030.
 *
 * ## Why the current balance is read separately
 *
 * `balance_at_request` is a record of what the account held when the request
 * was prepared. It is not what it holds now, and the gap between the two is
 * where a Manager gets caught out: a deposit reversed after the request would
 * leave an approval standing against money that has gone.
 * `post_savings_withdrawal` re-checks under a row lock and refuses, so nothing
 * incorrect can be posted — but a Manager should be told before they promise
 * the member, not after.
 */
export default async function WithdrawalRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly requestId: string }>;
}) {
  const { requestId } = await params;

  if (!uuidSchema.safeParse(requestId).success) notFound();

  const context = await guardPermission(
    ROUTES.savingsWithdrawals,
    'savings:approve_withdrawal',
  );

  const [request, idempotencyKey] = await Promise.all([
    getWithdrawalRequest(requestId),
    mintSavingsKey(),
  ]);

  // A missing request and an unauthorised one look the same, deliberately.
  if (request === null) notFound();

  const account = await getSavingsAccount(request.savingsAccountId);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Savings"
        icon={Banknote}
        back={{ href: ROUTES.savingsWithdrawals, label: 'Withdrawal requests' }}
        title={<Money amount={request.amount} />}
        description={`Request ${request.requestNumber}${
          account === null
            ? ''
            : ` · ${account.fullName} · account ${account.accountNumber}`
        }`}
        status={<WithdrawalStatusBadge status={request.status} />}
      />

      {/* --- What was asked for ---------------------------------------- */}
      <Card>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Amount requested</dt>
            <dd className="text-text mt-0.5">
              <Money amount={request.amount} weight="semibold" size="lg" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Balance when prepared</dt>
            <dd className="text-text mt-0.5 tabular-nums">
              <Money amount={request.balanceAtRequest} />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Balance now</dt>
            <dd className="text-text mt-0.5 tabular-nums">
              <Money amount={account?.balance ?? request.balanceAtRequest} />
            </dd>
            {account !== null && account.balance !== request.balanceAtRequest ? (
              <dd className="text-warning mt-0.5 text-xs">
                The account has moved since this was prepared.
              </dd>
            ) : null}
          </div>
          <div className="min-w-0">
            <dt className="text-text-muted text-xs">Prepared</dt>
            <dd className="text-text mt-0.5">
              <DateValue value={request.businessDate} />
            </dd>
            <dd className="text-text-muted mt-0.5 text-xs break-words">
              by {request.requestedByLabel}
            </dd>
          </div>
        </dl>

        <div className="border-border mt-4 border-t pt-4">
          <p className="text-text-muted text-xs">What it is for</p>
          <p className="text-text mt-0.5 text-sm break-words">{request.reason}</p>
        </div>

        {request.decidedAt === null ? null : (
          <div className="border-border mt-4 border-t pt-4">
            <p className="text-text-muted text-xs">
              {request.status === 'rejected' ? 'Rejected' : 'Approved'}
            </p>
            <p className="text-text mt-0.5 text-sm break-words">
              by {request.decidedByLabel} on{' '}
              <DateValue value={request.decidedAt} variant="datetime" />
            </p>
            {request.decisionNotes === null ? null : (
              <p className="text-text-muted mt-1 text-sm break-words">
                {request.decisionNotes}
              </p>
            )}
          </div>
        )}

        {request.paidAt === null ? null : (
          <div className="border-border mt-4 border-t pt-4">
            <p className="text-text-muted text-xs">Paid</p>
            <p className="text-text mt-0.5 text-sm">
              <DateValue value={request.paidAt} variant="datetime" />
            </p>
          </div>
        )}

        {request.cancelledAt === null ? null : (
          <div className="border-border mt-4 border-t pt-4">
            <p className="text-text-muted text-xs">Cancelled</p>
            <p className="text-text mt-0.5 text-sm break-words">
              <DateValue value={request.cancelledAt} variant="datetime" />
              {request.cancellationReason === null
                ? null
                : ` — ${request.cancellationReason}`}
            </p>
          </div>
        )}
      </Card>

      {/* --- The account it comes out of -------------------------------- */}
      {account === null ? null : (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-text text-sm font-semibold">The account</h2>
            <SavingsAccountStatusBadge status={account.status} />
          </div>
          <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-text-muted text-xs">Member</dt>
              <dd className="text-text mt-0.5 break-words">
                <RowLink
                  href={`${ROUTES.savings}/${account.id}`}
                  className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {account.fullName}
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
      )}

      {/* --- What is left to do ---------------------------------------- */}
      <WithdrawalDecisionPanel
        requestId={request.id}
        requestNumber={request.requestNumber}
        status={request.status}
        amount={request.amount}
        reason={request.reason}
        balanceAtRequest={request.balanceAtRequest}
        balanceNow={account?.balance ?? request.balanceAtRequest}
        requestedByLabel={request.requestedByLabel}
        canDecide={contextCan(context, 'savings:approve_withdrawal')}
        canPost={contextCan(context, 'savings:post_withdrawal')}
        canCancel={
          contextCan(context, 'savings:request_withdrawal') &&
          (request.status === 'pending' || request.status === 'approved')
        }
        idempotencyKey={idempotencyKey}
      />
    </div>
  );
}
