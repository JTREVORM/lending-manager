import { Alert } from '@/components/ui/alert';
import { MEMBER_LENDING_DECISIONS } from '@/lib/domain/member-loan';
import { memberLendingReadiness } from '@/lib/domain/member-loan';
import type { MemberLendingState } from '@/lib/data/member-loans';

/**
 * What member lending is waiting for, named decision by decision.
 *
 * ## Why this is a list and not a sentence
 *
 * Because four separate people have to answer four separate questions, and a
 * banner saying "member lending is not configured" tells none of them which
 * one is theirs. Phase 1 learned the lesson from the other direction: a single
 * "the programme is paralysed" banner that overstated its own scope taught
 * readers to scroll past it. So this names each open decision, where it lives,
 * and what it costs to leave it open.
 *
 * ## Why four and not three
 *
 * Three are the policy questions
 * `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md` records as nullable columns:
 * the interest basis, the interest method and the savings multiplier. The
 * fourth — what a monthly collection does in a month that has no such day — is
 * **not** one of the nine, and deliberately so: it is a property of the
 * cadence rather than of the membership programme, so it lives on
 * `repayment_frequencies.month_anchor`. See ADR-059.
 *
 * It is listed here anyway, because a reader planning the work needs all four
 * in one place and because its consequence is the one nobody would guess:
 * answering only the three policy questions opens **weekly** member loans of
 * one and two months and leaves three-, four- and five-month loans refused.
 *
 * ## It renders nothing when everything is decided
 *
 * Not a green "all clear" panel. A banner that persists after its reason has
 * gone is a banner people stop reading.
 */
export function MemberLendingStatus({
  state,
  blockedReason,
}: {
  readonly state: MemberLendingState;
  /** The reason `member_loan_summary` gave, where it has one. */
  readonly blockedReason?: string | null;
}) {
  if (state.policyVersionId === null) {
    return (
      <Alert tone="warning" title="There are no member lending terms at all">
        No membership policy version is in force, so there is nothing to price a member
        loan from and nobody to hold to it. Publish and approve a version on the
        Membership Policy screen first.
      </Alert>
    );
  }

  const readiness = memberLendingReadiness({
    interestBasis: state.interestBasis,
    interestMethod: state.interestMethod,
    savingsToLoanMultiplierBps: state.savingsToLoanMultiplierBps,
    monthAnchor: state.monthAnchor,
  });

  if (readiness.isReady && state.productActive) return null;

  const open = MEMBER_LENDING_DECISIONS.filter((decision) =>
    readiness.outstanding.includes(decision.key),
  );

  return (
    <Alert
      tone="warning"
      title={
        open.length === 0
          ? 'Member lending is decided but not yet open'
          : open.length === 1
            ? 'One decision is holding member lending up'
            : `${String(open.length)} decisions are holding member lending up`
      }
    >
      <div className="min-w-0 space-y-3">
        {readiness.pricingReady ? (
          <p>
            A member loan can be priced and approved, but only where it is collected
            weekly — the programme&rsquo;s shorter terms. A longer loan is collected
            calendar-monthly, which cannot be scheduled until the decision below is made,
            and the database refuses it rather than guessing a date.
          </p>
        ) : (
          <p>
            Applications can be prepared and eligibility can be read. Nothing can be
            approved: the database refuses it, so there is no risk of a loan being written
            on terms nobody settled.
          </p>
        )}

        {open.length > 0 ? (
          <ul className="min-w-0 space-y-2">
            {open.map((decision) => (
              <li key={decision.key} className="min-w-0">
                <p className="font-medium">{decision.question}</p>
                <p className="text-xs">{decision.consequence}</p>
                <p className="mt-0.5 font-mono text-[11px] opacity-80">{decision.home}</p>
              </li>
            ))}
          </ul>
        ) : null}

        {readiness.isReady && !state.productActive ? (
          <p>
            Every policy decision is made. The member loan product is still inactive, so
            it cannot be applied for — activating it on the Loan Products screen is the
            last step.
          </p>
        ) : null}

        {blockedReason !== undefined && blockedReason !== null && open.length === 0 ? (
          <p className="text-xs">{blockedReason}</p>
        ) : null}
      </div>
    </Alert>
  );
}
