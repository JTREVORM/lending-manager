import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import type { BenefitSummary } from '@/lib/data/benefits';

/**
 * The benefits position, for the top of the dashboard and the register.
 *
 * ## Three figures, and why these three
 *
 * **Waiting on somebody** is the one a supervisor opens this page for. It
 * adds up every claim that is neither finished nor refused — submitted, under
 * verification, waiting for information, assessed, approved — because a claim
 * sitting in any of those is a member who has brought in a hospital bill and
 * is waiting. Splitting it five ways on the dashboard would bury that; the
 * register's stage filter is where the five are separated.
 *
 * **Approved and not yet paid** is money the business has committed and not
 * released. It is the only forward-looking money figure here, and it is the
 * figure a Treasurer needs before deciding what cash to hold at a branch.
 *
 * **Paid in the period** is history, broken down by promise beneath. It comes
 * from `benefit_summary`, which derives it from `benefit_payments` — and
 * `tests/db/benefit-accounting.test.ts` asserts the same total against the
 * `5210`/`5220`/`5230` ledger balances, so this panel and the trial balance
 * cannot disagree.
 *
 * ## Members without a registered beneficiary is a warning, not a statistic
 *
 * A member with no verified next of kin is a bereavement benefit that cannot
 * be paid when it is needed — and nobody discovers that at a convenient
 * moment. So the panel reports the gap rather than the coverage: "41 of 120
 * members have none" is actionable where "66% covered" is a slide.
 *
 * ## It renders nothing when the caller may not see it
 *
 * `getBenefitSummary` returns `null` for a caller without `benefits:view`.
 * The panel is then absent rather than zeroed — a row of zeros would be a
 * lie — and the rest of the page, which they are entitled to, still renders.
 */
export function BenefitSummaryPanel({
  summary,
}: {
  readonly summary: BenefitSummary | null;
}) {
  if (summary === null) return null;

  const awaitingDecision =
    summary.claimsSubmitted +
    summary.claimsUnderVerification +
    summary.claimsInformationRequired +
    summary.claimsAssessed +
    summary.claimsApproved;

  const membersWithoutBeneficiary = Math.max(
    0,
    summary.liveMemberships - summary.membersWithBeneficiary,
  );

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">The benefits position</h2>

      <dl className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Waiting on somebody"
          hint={
            awaitingDecision === 0
              ? 'No claim is waiting'
              : `of ${String(summary.claimsTotal)} claims in all`
          }
        >
          <Count value={awaitingDecision} />
        </Figure>

        <Figure
          label="Approved, not yet paid"
          hint={
            summary.claimsApproved === 0
              ? 'Nothing is waiting to be paid'
              : `${String(summary.claimsApproved)} ${summary.claimsApproved === 1 ? 'claim' : 'claims'}`
          }
        >
          <Money amount={summary.approvedAwaitingPayment} weight="semibold" size="lg" />
        </Figure>

        <Figure label="Paid in the period" hint={`${String(summary.claimsPaid)} paid`}>
          <Money amount={summary.paidTotal} weight="semibold" size="lg" />
          <span className="text-text-muted mt-0.5 block text-xs tabular-nums">
            Medical <Money amount={summary.paidMedical} /> · Condolence{' '}
            <Money amount={summary.paidCondolence} /> · Bereavement{' '}
            <Money amount={summary.paidBereavement} />
          </span>
        </Figure>

        <Figure
          label="Members with no next of kin"
          hint={
            summary.beneficiariesAwaitingVerification === 0
              ? `of ${String(summary.liveMemberships)} live memberships`
              : `${String(summary.beneficiariesAwaitingVerification)} more are registered but unverified`
          }
        >
          <Count value={membersWithoutBeneficiary} />
        </Figure>
      </dl>

      {summary.paymentsReversed === 0 ? null : (
        // Reversals get their own line rather than a tile. A reversal is
        // money that went out and came back, and the dashboard should not
        // let it hide inside a net figure: the paid total above is net of
        // these, and this line says by how much.
        <p className="text-text-muted mt-3 text-xs">
          {summary.paymentsReversed}{' '}
          {summary.paymentsReversed === 1 ? 'payment has' : 'payments have'} been reversed
          in this period, <Money amount={summary.reversedTotal} /> in all. The paid total
          above is net of them.
        </p>
      )}
    </Card>
  );
}

function Count({ value }: { readonly value: number }) {
  return <span className="text-text text-lg font-semibold tabular-nums">{value}</span>;
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
