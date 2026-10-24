import { Banknote, PiggyBank, Users } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import type { SavingsSummary } from '@/lib/data/savings';

/**
 * The savings position, on the dashboard.
 *
 * Three cards, chosen because they are the three questions somebody opening
 * this page in the morning actually has about savings:
 *
 *   - **what the business owes its savers**, which is the figure that must
 *     equal the `2100 Member Savings` ledger balance;
 *   - **who is up to date this month**, because the monthly minimum is the
 *     thing the programme runs on and a member who misses a month restarts
 *     their qualifying run where the policy says the months must be
 *     consecutive;
 *   - **what is waiting for a decision**, because an approved-and-unpaid
 *     withdrawal is a promise the business has made and not kept.
 *
 * ## "Owed to members", not "savings held"
 *
 * A deposit increases a liability. It is not revenue and not money the
 * business owns, and a card reading "savings held" beside a cash figure would
 * invite exactly the reading that ends with a profit share paid out of
 * deposits. The ledger says it is a liability; so does this card.
 *
 * ## It is absent, not zeroed, for a caller who may not see it
 *
 * `getSavingsSummary` returns `null` without `savings:view_reports`. A
 * Secretary takes deposits all day and does not read the business-wide
 * position, and a row of zeros would be a lie about the business rather than
 * a statement about their permissions.
 */
export function SavingsCards({ summary }: { readonly summary: SavingsSummary }) {
  return (
    <section aria-labelledby="dashboard-savings-heading" className="min-w-0 space-y-3">
      <h2 id="dashboard-savings-heading" className="text-base">
        Member savings
      </h2>

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Card>
          <div className="flex items-start gap-3">
            <span className="bg-accent-surface flex size-9 shrink-0 items-center justify-center rounded-lg">
              <PiggyBank aria-hidden="true" className="text-accent size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-text-muted text-xs">Owed to members</p>
              <p className="text-text mt-0.5">
                <Money amount={summary.totalLiability} weight="semibold" size="lg" />
              </p>
              <p className="text-text-muted mt-0.5 text-xs">
                Across{' '}
                <RowLink
                  href={ROUTES.savings}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {summary.accountsOpen === 1
                    ? '1 account'
                    : `${String(summary.accountsOpen)} accounts`}
                </RowLink>
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span className="bg-success-surface flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Users aria-hidden="true" className="text-success size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-text-muted text-xs">Met this month&rsquo;s minimum</p>
              <p className="text-text mt-0.5 text-lg font-semibold tabular-nums">
                {summary.membersMeetingMinimum}
                <span className="text-text-muted text-sm font-normal">
                  {' '}
                  of {summary.membersSaving}
                </span>
              </p>
              <p className="text-text-muted mt-0.5 text-xs">
                Counted from what has been paid in, not from what is expected
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-start gap-3">
            <span
              className={
                summary.pendingWithdrawalRequests > 0
                  ? 'bg-warning-surface flex size-9 shrink-0 items-center justify-center rounded-lg'
                  : 'bg-surface-sunken flex size-9 shrink-0 items-center justify-center rounded-lg'
              }
            >
              <Banknote
                aria-hidden="true"
                className={
                  summary.pendingWithdrawalRequests > 0
                    ? 'text-warning size-4'
                    : 'text-text-muted size-4'
                }
              />
            </span>
            <div className="min-w-0">
              <p className="text-text-muted text-xs">Withdrawals to decide</p>
              <p className="text-text mt-0.5 text-lg font-semibold tabular-nums">
                {summary.pendingWithdrawalRequests}
              </p>
              <p className="text-text-muted mt-0.5 text-xs">
                {summary.pendingWithdrawalRequests === 0 ? (
                  'Nothing is waiting'
                ) : (
                  <RowLink
                    href={ROUTES.savingsWithdrawals}
                    className="text-accent underline-offset-2 hover:underline"
                  >
                    <Money amount={summary.pendingWithdrawalValue} /> requested
                  </RowLink>
                )}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
