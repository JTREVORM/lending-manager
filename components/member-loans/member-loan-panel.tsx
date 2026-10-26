import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { formatBps, toBps } from '@/lib/domain/rate';
import {
  MEMBER_INTEREST_BASIS_LABELS,
  MEMBER_INTEREST_METHOD_LABELS,
} from '@/lib/domain/membership';
import type { MemberLoanRow } from '@/lib/data/member-loans';

/**
 * The membership half of a member loan, on the loan's own screen.
 *
 * ## Why a panel and not a screen
 *
 * Because the loan detail screen already carries the approved terms, the
 * repayment schedule, the payment history, the approval trail and the arrears
 * position. A second detail screen for member loans would be a second set of
 * controls over one agreement, and the two would eventually disagree. What a
 * member loan adds is the evidence the business relied on — which member,
 * which policy version, how many months they had served, what their savings
 * supported — so that is what this adds.
 *
 * ## Every figure here is the frozen one
 *
 * Read from `member_loan_eligibility_snapshots`, which is append-only, not
 * re-derived from the member's savings today. A member who deposited more
 * since, withdrew since, was suspended since or was moved onto new terms since
 * has not changed what the business decided on — and an auditor needs to see
 * the decision rather than a recomputation of it, which would come back
 * different for a perfectly legitimate reason.
 *
 * ## The pledge, and what it is not
 *
 * A pledge restricts the member's savings; it does not move them. No journal
 * was posted, the `2100 Member Savings` liability did not change by a
 * shilling, and nothing is offset against the loan balance. It is said here in
 * so many words, because the figure sits beside loan amounts and would
 * otherwise read as a payment.
 */
export function MemberLoanPanel({
  loan,
  canSeeMembership,
}: {
  readonly loan: MemberLoanRow;
  readonly canSeeMembership: boolean;
}) {
  const released = loan.pledgeReleasedAt !== null;

  return (
    <div className="min-w-0 space-y-3">
      <Card>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-text text-sm font-semibold">Lent against a membership</h3>
            <p className="text-text-muted mt-0.5 text-xs">
              The assessment the business decided on, frozen at approval. It is not
              recomputed from this member&rsquo;s savings today.
            </p>
          </div>

          {loan.membershipStatus === null ? null : (
            <Badge tone={loan.membershipStatus === 'active' ? 'success' : 'warning'}>
              Membership {loan.membershipStatus}
            </Badge>
          )}
        </div>

        <dl className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Membership">
            {canSeeMembership && loan.membershipId !== null ? (
              <Link
                href={`${ROUTES.membership}/${loan.membershipId}`}
                className="text-accent font-mono underline-offset-2 hover:underline"
              >
                {loan.membershipNumber ?? '—'}
              </Link>
            ) : (
              <span className="font-mono">{loan.membershipNumber ?? '—'}</span>
            )}
          </Detail>

          <Detail label="Governed by">
            Policy version <span className="font-mono">{loan.policyVersion ?? '—'}</span>
          </Detail>

          <Detail label="Savings account">
            {canSeeMembership && loan.savingsAccountId !== null ? (
              <Link
                href={`${ROUTES.savings}/${loan.savingsAccountId}`}
                className="text-accent font-mono underline-offset-2 hover:underline"
              >
                {loan.savingsAccountNumber ?? '—'}
              </Link>
            ) : (
              <span className="font-mono">{loan.savingsAccountNumber ?? '—'}</span>
            )}
          </Detail>

          <Detail label="Qualifying months served" hint="As assessed at approval">
            <span className="tabular-nums">
              {loan.qualifyingMonths ?? '—'} of {loan.monthsRequired ?? '—'}
            </span>
          </Detail>

          <Detail label="Savings relied on" hint="The balance at approval">
            <Money amount={loan.eligibleSavings} />
          </Detail>

          <Detail
            label="Maximum the savings supported"
            hint={
              loan.multiplierBps === null
                ? undefined
                : `${String(loan.multiplierBps / 100)}% of the available savings`
            }
          >
            <Money amount={loan.maxEligibleLoan} />
          </Detail>
        </dl>
      </Card>

      <Card>
        <h3 className="text-text text-sm font-semibold">The agreed price</h3>
        <p className="text-text-muted mt-0.5 text-xs">
          Read from the member&rsquo;s own policy version at approval and frozen on the
          loan. A later policy version does not reprice it, and `loans_guard_member_terms`
          refuses the change for every caller.
        </p>

        <dl className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Rate">
            <span className="tabular-nums">{formatBps(toBps(loan.interestRateBps))}</span>
          </Detail>
          <Detail label="Charged">
            {loan.interestBasis === null
              ? '—'
              : MEMBER_INTEREST_BASIS_LABELS[loan.interestBasis]}
          </Detail>
          <Detail label="Method">
            {loan.interestMethod === null
              ? '—'
              : MEMBER_INTEREST_METHOD_LABELS[loan.interestMethod]}
          </Detail>
          <Detail label="Total interest">
            <Money amount={loan.totalInterest} />
          </Detail>
        </dl>
      </Card>

      <Card>
        <h3 className="text-text text-sm font-semibold">Savings securing this loan</h3>

        <dl className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail
            label="Pledged"
            hint="The principal divided by the approved multiplier, rounded up"
          >
            <Money amount={loan.pledgedAmount} weight="semibold" />
          </Detail>

          <Detail label="Released">
            {released ? (
              <DateValue value={loan.pledgeReleasedAt} />
            ) : (
              <span className="text-text-muted">Still securing this loan</span>
            )}
          </Detail>

          <Detail label="Returns to the member">
            {released
              ? 'Already returned.'
              : 'When this loan stops being a live obligation — a consequence of closure, not a step somebody performs.'}
          </Detail>
        </dl>

        <p className="text-text-muted mt-4 text-[13px]">
          A pledge restricts what the member may withdraw; it does not move money. Nothing
          was debited, nothing was credited, the business still owes this member every
          shilling they saved, and nothing here is offset against the loan balance. The{' '}
          <span className="font-mono">2100 Member Savings</span> liability is unchanged by
          it.
        </p>
      </Card>
    </div>
  );
}

function Detail({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm break-words">{children}</dd>
      {hint === undefined ? null : (
        <dd className="text-text-muted mt-0.5 text-xs">{hint}</dd>
      )}
    </div>
  );
}
