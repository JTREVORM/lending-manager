import { PiggyBank } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { businessToday } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { contributionProgressPercent, findContributionMonth } from '@/lib/domain/savings';
import type {
  ContributionRow,
  QualificationResult,
  SavingsAccountSummary,
  StatementLine,
} from '@/lib/data/savings';
import { SavingsKindBadge } from './savings-badges';

/**
 * A member's own savings, in the portal.
 *
 * ## It is written for the member, not for the counter
 *
 * The staff screens use the business's words — subledger, contribution month,
 * liability. This one says "your savings", "this month" and "what we hold for
 * you", because the reader is the person whose money it is and the only
 * questions they have are: how much is there, am I up to date this month, and
 * how far through the qualifying period am I.
 *
 * The figures are the same figures. They come from the same views, read as the
 * member through the identity clause on `clients.profile_id` — so the panel
 * contains no check about members, and a member who asked for somebody else's
 * account would get nothing from the database rather than nothing from a
 * conditional here.
 *
 * ## No deposit control, and that is deliberate
 *
 * A member cannot pay into their own account from here. The money has to
 * arrive at a counter before a record of it should exist, and a portal button
 * that created a deposit would be a record of money the business has not
 * received. There is no withdrawal control either: a withdrawal is prepared by
 * staff, decided by somebody else and then paid, and the portal cannot be any
 * of those three.
 *
 * ## What it does not say
 *
 * It never shows a member as "qualified" while the rule about consecutive
 * months is undecided. `blockedReason` carries that sentence from the
 * database, and repeating it is more honest than picking the lenient reading
 * and being wrong when a loan is refused.
 */
export function PortalSavingsPanel({
  account,
  qualification,
  months,
  recent,
}: {
  readonly account: SavingsAccountSummary;
  readonly qualification: QualificationResult | null;
  readonly months: readonly ContributionRow[];
  readonly recent: readonly StatementLine[];
}) {
  const thisMonth = findContributionMonth(months, businessToday());
  const contributed = thisMonth?.contributed ?? toUgx(0);
  const percent = contributionProgressPercent(
    contributed,
    toUgx(account.monthlySavingsMinimum),
  );

  return (
    <section aria-labelledby="portal-savings-heading" className="min-w-0 space-y-3">
      <h2 id="portal-savings-heading" className="text-base">
        Your savings
      </h2>

      <Card>
        <div className="flex items-start gap-3">
          <span className="bg-accent-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
            <PiggyBank aria-hidden="true" className="text-accent size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-text-muted text-xs">What we hold for you</p>
            <p className="text-text mt-0.5">
              <Money amount={account.balance} weight="semibold" size="lg" />
            </p>
            <p className="text-text-muted mt-0.5 text-xs">
              Savings account {account.accountNumber} · opened{' '}
              <DateValue value={account.openedOn} />
            </p>
          </div>
        </div>

        {/* --- This month ----------------------------------------------- */}
        <div className="border-border mt-4 border-t pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-text-muted text-xs">Saved this month</span>
            <span className="text-text text-sm tabular-nums">
              <Money amount={contributed} /> of{' '}
              <Money amount={toUgx(account.monthlySavingsMinimum)} />
            </span>
          </div>
          <div
            role="img"
            aria-label={
              thisMonth?.meetsMinimum === true
                ? 'You have met this month’s minimum.'
                : 'You have not yet met this month’s minimum.'
            }
            className="bg-surface-sunken mt-2 h-2 w-full overflow-hidden rounded-full"
          >
            <div
              className={percent >= 100 ? 'bg-success h-full' : 'bg-accent h-full'}
              style={{ width: `${String(percent)}%` }}
            />
          </div>
          <p className="text-text-muted mt-1.5 text-xs">
            {thisMonth?.meetsMinimum === true ? (
              <>This month counts towards your qualifying period.</>
            ) : (
              <>
                <Money
                  amount={thisMonth?.shortfall ?? toUgx(account.monthlySavingsMinimum)}
                />{' '}
                more this month for it to count.
              </>
            )}
          </p>
        </div>

        {/* --- The qualifying period ------------------------------------ */}
        {qualification === null ? null : (
          <div className="border-border mt-4 border-t pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-text-muted text-xs">Months saved</span>
              <span className="text-text text-sm tabular-nums">
                {qualification.qualifyingMonths} of {qualification.monthsRequired}
              </span>
            </div>
            <p className="text-text-muted mt-1.5 text-xs">
              {qualification.qualifies
                ? 'You have saved for long enough to be eligible for a member loan.'
                : qualification.blockedReason}
            </p>
          </div>
        )}
      </Card>

      {/* --- Recent movements ----------------------------------------- */}
      {recent.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            Nothing has been paid in yet. Deposits are recorded at the branch, and they
            appear here once a member of staff has taken them.
          </p>
        </Card>
      ) : (
        <Card>
          <h3 className="text-text text-sm font-semibold">Recent movements</h3>
          <ul className="divide-border mt-2 divide-y">
            {recent.map((line) => (
              <li
                key={line.transactionId}
                className="flex min-w-0 items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-text text-sm break-words">{line.description}</p>
                  <p className="text-text-muted text-xs">
                    <DateValue value={line.valueDate} /> ·{' '}
                    <span className="font-mono">{line.transactionNumber}</span>
                  </p>
                  {line.kind === 'deposit' || line.kind === 'withdrawal' ? null : (
                    <span className="mt-1 inline-block">
                      <SavingsKindBadge kind={line.kind} />
                    </span>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={
                      line.deposit > 0
                        ? 'text-success text-sm font-semibold tabular-nums'
                        : 'text-text text-sm font-semibold tabular-nums'
                    }
                  >
                    {line.deposit > 0 ? '+' : '−'}
                    <Money
                      amount={line.deposit > 0 ? line.deposit : line.withdrawal}
                      variant="bare"
                    />
                  </p>
                  <p className="text-text-muted text-xs tabular-nums">
                    <Money amount={line.runningBalance} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-text-muted mt-3 text-xs">
            To pay in, or to ask about taking money out, please speak to our staff at the
            branch.
          </p>
        </Card>
      )}
    </section>
  );
}
