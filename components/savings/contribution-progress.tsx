import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { businessToday } from '@/lib/domain/datetime';
import { contributionProgressPercent, findContributionMonth } from '@/lib/domain/savings';
import type { ContributionRow, QualificationResult } from '@/lib/data/savings';

/**
 * How a member is doing against the monthly minimum and the qualifying
 * period.
 *
 * ## The bar is capped, and the number beside it is not
 *
 * A member who saved UGX 80,000 against a UGX 50,000 minimum has met the
 * month. The bar reads full; the figure beside it still says UGX 80,000. A bar
 * at 160% would invite the reading that they have banked three months, and
 * they have not: the engine counts *months*, not shillings, which is the whole
 * point of a monthly minimum rather than a target.
 *
 * ## Qualification comes from the database, not from this component
 *
 * `qualifies` and `blockedReason` are `member_savings_qualification`'s answer,
 * computed against the subledger. The domain module has its own version of the
 * same arithmetic for a screen that already holds the months, and the unit
 * tests check the two agree — but what is rendered here is the database's,
 * because that is the one Phase 3 will approve member loans against. A screen
 * that said "qualified" where the loan screen said "not yet" would be a
 * support call and a disappointed member.
 *
 * ## It refuses to answer while the rule is undecided
 *
 * Whether the six months must run consecutively is one of the questions the
 * client has not settled. Where it is open, `blockedReason` says so and this
 * panel repeats it rather than picking the lenient reading — because a member
 * shown as qualified under a rule nobody approved is a loan approved on a
 * guess.
 */
export function ContributionProgress({
  qualification,
  months,
  monthlyMinimum,
}: {
  readonly qualification: QualificationResult | null;
  readonly months: readonly ContributionRow[];
  readonly monthlyMinimum: number;
}) {
  // Found by date, not taken as the newest row. The contribution view holds
  // only the months a member actually paid into, so a member whose last
  // deposit was in March would — read in June — have March's figure shown as
  // June's, and a counter would be told the month was already met.
  //
  // Absent means nothing has been paid in this month, which is a contribution
  // of zero rather than a missing record.
  const thisMonth = findContributionMonth(months, businessToday());
  const contributed = thisMonth?.contributed ?? toUgx(0);
  const percent = contributionProgressPercent(contributed, toUgx(monthlyMinimum));

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">Saving towards qualification</h2>

      {/* --- This month ------------------------------------------------- */}
      <div className="mt-3 min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-text-muted text-xs">This month</span>
          <span className="text-text text-sm tabular-nums">
            <Money amount={contributed} /> of <Money amount={toUgx(monthlyMinimum)} />
          </span>
        </div>

        {/* `role="img"` with a label rather than a bare div: a screen reader
            gets the sentence, not a decorative box. The figures above are the
            real answer; this is the glance. */}
        <div
          role="img"
          aria-label={`${formatUgx(contributed)} saved this month, of a ${formatUgx(toUgx(monthlyMinimum))} minimum.`}
          className="bg-surface-sunken mt-2 h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className={percent >= 100 ? 'bg-success h-full' : 'bg-accent h-full'}
            style={{ width: `${String(percent)}%` }}
          />
        </div>

        <p className="text-text-muted mt-1.5 text-xs">
          {thisMonth?.meetsMinimum === true ? (
            <>This month counts towards qualification.</>
          ) : (
            <>
              <Money amount={thisMonth?.shortfall ?? toUgx(monthlyMinimum)} /> still to
              pay in for this month to count.
            </>
          )}
        </p>
      </div>

      {/* --- The qualifying period -------------------------------------- */}
      {qualification === null ? null : (
        <div className="border-border mt-4 border-t pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-text-muted text-xs">Qualifying months</span>
            <span className="text-text text-sm tabular-nums">
              {qualification.qualifyingMonths} of {qualification.monthsRequired}
            </span>
          </div>

          <ol
            className="mt-2 flex min-w-0 flex-wrap gap-1.5"
            aria-label="Qualifying months"
          >
            {Array.from({ length: qualification.monthsRequired }, (_, index) => (
              <li
                key={index}
                className={
                  index < qualification.qualifyingMonths
                    ? 'bg-success h-2 w-8 rounded-full'
                    : 'bg-surface-sunken h-2 w-8 rounded-full'
                }
              />
            ))}
          </ol>

          <p className="text-text-muted mt-2 text-xs">
            {qualification.qualifies
              ? 'This member has served the qualifying period.'
              : qualification.blockedReason}
          </p>

          {qualification.mustBeConsecutive ? (
            <p className="text-text-muted mt-1 text-xs">
              The months have to run unbroken, so a month missed starts the count again.
              Longest unbroken run so far: {qualification.longestConsecutiveMonths}.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
