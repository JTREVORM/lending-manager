import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import type { MemberLoanSummary } from '@/lib/data/member-loans';

/**
 * The member loan position, for the top of the Member Loans section.
 *
 * Every figure comes from `member_loan_summary`, one round trip, and every one
 * is derived from the payment ledger rather than stored — so a reversal moves
 * these numbers the instant it commits, and this panel and the loan register
 * cannot disagree.
 *
 * ## Why "secured against savings" is here and not on the savings screen
 *
 * Because it is a fact about the loan book. It is how much of the members'
 * savings is restricted *because* of lending, and the person reading this
 * screen is the one deciding whether to lend more. The savings screen reports
 * the liability — what the business owes — which is a different figure and
 * does not move when a pledge is taken: a pledge restricts a liability rather
 * than reducing one.
 *
 * ## Why there is no total ceiling
 *
 * Summing what the business *could* lend across every member would be read as
 * a commitment nobody made, and while the savings multiplier is undecided
 * every one of its terms is absent anyway. The counts — qualified, and not yet
 * — are the useful version of the same question.
 *
 * ## It renders nothing when the caller may not see it
 *
 * `getMemberLoanSummary` returns `null` for a caller without `loans:view`,
 * and the panel is absent rather than zeroed: a row of zeros would be a lie.
 */
export function MemberLoanSummaryPanel({
  summary,
}: {
  readonly summary: MemberLoanSummary | null;
}) {
  if (summary === null) return null;

  const inPipeline = summary.applicationsDraft + summary.applicationsPending;

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <h2 className="text-text text-sm font-semibold">The member loan book</h2>
        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Outstanding principal"
            hint={
              summary.loansActive === 0
                ? 'No member loan is running'
                : `across ${String(summary.loansActive)} active member loan${summary.loansActive === 1 ? '' : 's'}`
            }
          >
            <Money amount={summary.principalOutstanding} weight="semibold" size="lg" />
          </Figure>

          <Figure label="Interest outstanding" hint="Contractual, not accrued daily">
            <Money amount={summary.interestOutstanding} weight="semibold" size="lg" />
          </Figure>

          <Figure label="Collected to date" hint="Reversed payments excluded">
            <Money amount={summary.totalCollected} weight="semibold" size="lg" />
          </Figure>

          <Figure
            label="Secured against savings"
            hint="Members' savings restricted by a live member loan"
          >
            <Money amount={summary.savingsPledged} weight="semibold" size="lg" />
          </Figure>
        </dl>
      </Card>

      <Card>
        <h2 className="text-text text-sm font-semibold">
          The pipeline and the collection position
        </h2>
        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Awaiting approval"
            hint={
              inPipeline === 0
                ? 'Nothing is waiting'
                : `${String(summary.applicationsDraft)} still a draft`
            }
          >
            <Count value={summary.applicationsPending} />
          </Figure>

          <Figure
            label="Approved, not yet paid out"
            hint="Savings are already pledged against these"
          >
            <Count value={summary.loansApproved} />
          </Figure>

          <Figure
            label="Due today"
            hint={summary.dueToday === 0 ? 'Nothing falls due today' : undefined}
          >
            <Money amount={summary.dueToday} weight="semibold" size="lg" />
          </Figure>

          <Figure
            label="Overdue"
            hint={
              summary.overdueLoans === 0
                ? 'Every member loan is current'
                : 'member loans past a collection date'
            }
          >
            <Count
              value={summary.overdueLoans}
              tone={summary.overdueLoans > 0 ? 'danger' : 'default'}
            />
            {summary.arrearsAmount > 0 ? (
              <span className="text-text-muted block text-xs tabular-nums">
                <Money amount={summary.arrearsAmount} /> in arrears
              </span>
            ) : null}
          </Figure>
        </dl>
      </Card>

      <Card>
        <h2 className="text-text text-sm font-semibold">Who can borrow</h2>
        <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="Live memberships" hint="Pending, active or suspended">
            <Count value={summary.liveMemberships} />
          </Figure>

          <Figure
            label="Qualified on savings"
            hint="Active members who have served the qualifying months"
          >
            <Count value={summary.membersQualified} />
          </Figure>

          <Figure label="Not yet qualified" hint="Still saving, or not in good standing">
            <Count value={summary.membersNotYetQualified} />
          </Figure>

          <Figure label="Holding a member loan" hint="Approved or active">
            <Count value={summary.membersWithMemberLoan} />
          </Figure>
        </dl>
      </Card>
    </div>
  );
}

function Count({
  value,
  tone = 'default',
}: {
  readonly value: number;
  readonly tone?: 'default' | 'danger';
}) {
  return (
    <span
      className={`text-lg font-semibold tabular-nums ${
        tone === 'danger' && value > 0 ? 'text-danger' : 'text-text'
      }`}
    >
      {value}
    </span>
  );
}

function Figure({
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
      <dd className="text-text mt-0.5">{children}</dd>
      {hint === undefined ? null : (
        <dd className="text-text-muted mt-0.5 text-xs">{hint}</dd>
      )}
    </div>
  );
}
