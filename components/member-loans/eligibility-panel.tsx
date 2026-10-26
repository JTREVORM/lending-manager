import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { ActionLink } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { formatBps, toBps } from '@/lib/domain/rate';
import {
  MEMBER_INTEREST_BASIS_LABELS,
  MEMBER_INTEREST_METHOD_LABELS,
} from '@/lib/domain/membership';
import type { MemberLoanEligibility } from '@/lib/domain/member-loan';
import type { MemberLendingState } from '@/lib/data/member-loans';

/**
 * Whether this member may borrow, and how much — on their own record.
 *
 * ## The verdict and the reasons are both shown, always
 *
 * A panel that said only "not eligible" would send the member to the counter
 * and the counter to the office. So the blocking reasons are listed in full,
 * and they come from the database rather than being reconstructed here: the
 * same sentences `validate_loan_for_approval` would refuse the approval with,
 * so a member is never told one thing by a screen and another by a decision.
 *
 * ## Why the ceiling can be absent on an otherwise complete panel
 *
 * Because the savings-to-loan multiplier is undecided, and no figure is
 * invented in its place. The months served, the balance and the qualification
 * verdict are all real and all shown — a member who has saved for six months
 * is told so. What cannot be shown is how much that supports, because nobody
 * has set the multiple.
 *
 * ## Why the interest terms appear even when lending is shut
 *
 * The 5% is confirmed in the client's own documents. What is undecided is
 * whether it is charged per month or once over the loan, and whether it is
 * flat or on a reducing balance — so the rate is stated and the two open
 * questions are named beside it, rather than the whole price being hidden.
 * A reader comparing this panel with the policy screen sees the same thing in
 * both places.
 */
export function MemberLoanEligibilityPanel({
  eligibility,
  lending,
  canApply,
}: {
  /** `null` when the caller may not read an assessment. */
  readonly eligibility: MemberLoanEligibility | null;
  readonly lending: MemberLendingState;
  readonly canApply: boolean;
}) {
  if (eligibility === null) {
    return (
      <Card>
        <h2 className="text-text text-sm font-semibold">Member loan eligibility</h2>
        <p className="text-text-muted mt-2 text-sm">
          Reading a member&rsquo;s loan eligibility needs its own capability, because it
          is a lending offer rather than a view of their savings. Ask somebody holding it
          to check.
        </p>
      </Card>
    );
  }

  const qualified = eligibility.savingsQualifies === true;
  const months = eligibility.qualifyingMonths ?? 0;
  const required = eligibility.monthsRequired ?? 0;

  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-text text-sm font-semibold">Member loan eligibility</h2>
          <p className="text-text-muted mt-0.5 text-xs">
            As at <span className="tabular-nums">{eligibility.asOf}</span>, under policy
            version <span className="font-mono">{eligibility.policyVersion ?? '—'}</span>.
            A deposit made after this date does not change an assessment already made.
          </p>
        </div>

        <Badge
          tone={eligibility.mayProceed || eligibility.isEligible ? 'success' : 'neutral'}
        >
          {eligibility.isEligible ? 'May borrow' : 'Cannot borrow yet'}
        </Badge>
      </div>

      {/* --- The savings evidence ------------------------------------------ */}
      <dl className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Qualifying months"
          hint={
            eligibility.mustBeConsecutive === null
              ? 'Whether they must be consecutive is undecided'
              : eligibility.mustBeConsecutive
                ? `Longest unbroken run: ${String(eligibility.consecutiveQualifyingMonths ?? 0)}`
                : 'They need not be consecutive'
          }
        >
          <span
            className={`text-lg font-semibold tabular-nums ${
              qualified ? 'text-success' : 'text-text'
            }`}
          >
            {months} of {required}
          </span>
        </Figure>

        <Figure label="Savings balance" hint="What the business holds for them today">
          <Money amount={eligibility.eligibleSavings} weight="semibold" size="lg" />
        </Figure>

        <Figure
          label="Available to secure a loan"
          hint={
            (eligibility.pledgedSavings ?? 0) === 0 &&
            (eligibility.pendingWithdrawals ?? 0) === 0
              ? 'Nothing is pledged or awaiting payment'
              : 'Balance less what secures a live loan and what is awaiting payment'
          }
        >
          <Money amount={eligibility.availableSavings} weight="semibold" size="lg" />
        </Figure>

        <Figure
          label="Maximum loan"
          hint={
            eligibility.maxEligibleLoan === null
              ? 'The multiple of savings a member may borrow is undecided, so no ceiling can be shown'
              : `${String((eligibility.multiplierBps ?? 0) / 100)}% of the available savings`
          }
        >
          <Money
            amount={eligibility.maxEligibleLoan}
            weight="semibold"
            size="lg"
            placeholder="Not yet decided"
          />
        </Figure>
      </dl>

      {/* --- The terms a loan would carry ---------------------------------- */}
      <dl className="border-border mt-4 grid min-w-0 gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Member interest rate" hint="Confirmed in the programme documents">
          <span className="text-text text-lg font-semibold tabular-nums">
            {lending.interestRateBps === null
              ? '—'
              : formatBps(toBps(lending.interestRateBps))}
          </span>
        </Figure>

        <Figure
          label="Charged"
          hint={
            lending.interestBasis === null
              ? 'Per month, or once over the loan? Undecided'
              : undefined
          }
        >
          <span className="text-text text-sm font-semibold">
            {lending.interestBasis === null
              ? 'Not yet decided'
              : MEMBER_INTEREST_BASIS_LABELS[lending.interestBasis]}
          </span>
        </Figure>

        <Figure
          label="Method"
          hint={
            lending.interestMethod === null
              ? 'Flat, or on a reducing balance? Undecided'
              : undefined
          }
        >
          <span className="text-text text-sm font-semibold">
            {lending.interestMethod === null
              ? 'Not yet decided'
              : MEMBER_INTEREST_METHOD_LABELS[lending.interestMethod]}
          </span>
        </Figure>

        <Figure
          label="Longest term"
          hint={
            lending.weeklyCadenceMaxMonths === null
              ? undefined
              : `Weekly collection up to ${String(lending.weeklyCadenceMaxMonths)} months, calendar-monthly beyond`
          }
        >
          <span className="text-text text-lg font-semibold tabular-nums">
            {lending.maxTermMonths === null
              ? '—'
              : `${String(lending.maxTermMonths)} months`}
          </span>
        </Figure>
      </dl>

      {/* --- Why not, in the words the approval would use ------------------ */}
      {eligibility.blockingReasons.length > 0 ? (
        <div className="mt-4">
          <Alert
            tone="info"
            title={
              eligibility.blockingReasons.length === 1
                ? 'One thing stands in the way'
                : `${String(eligibility.blockingReasons.length)} things stand in the way`
            }
          >
            <ul className="min-w-0 list-disc space-y-1 pl-5">
              {eligibility.blockingReasons.map((reason) => (
                <li key={reason} className="min-w-0 break-words">
                  {reason}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      {/* --- The one action this panel offers ------------------------------ */}
      {canApply && eligibility.isEligible && eligibility.maxEligibleLoan !== null ? (
        <div className="mt-4">
          <ActionLink
            href={`${ROUTES.newMemberLoan}?client=${eligibility.clientId}`}
            variant="primary"
          >
            Open a member loan application
          </ActionLink>
        </div>
      ) : null}
    </Card>
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
