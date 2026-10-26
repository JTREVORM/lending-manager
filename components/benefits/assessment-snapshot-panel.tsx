import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import type { AssessmentSnapshot } from '@/lib/data/benefits';
import { BENEFIT_YEAR_BASIS_LABELS } from '@/lib/domain/benefits';

/**
 * The frozen assessment.
 *
 * ## Why a snapshot exists at all
 *
 * Because "why was this paid" has to be answerable years later, after the
 * policy version has been superseded, the beneficiary record has been changed
 * and the member's savings have moved. Recomputing the answer from today's
 * data would give a different one, which is not an audit trail — it is a
 * guess with a date on it.
 *
 * So `benefit_assessment_snapshots` is append-only and holds every input the
 * figure came from: the rate, the ceiling, the period it was measured over,
 * what had already been claimed inside it, the admission as three readings,
 * the payee and their verification, and the member's loan and savings position
 * at that moment. Its constraints restate the arithmetic, so a row that does
 * not add up cannot be written.
 *
 * ## The payee shown here is the payee who gets paid
 *
 * `post_benefit_payment` reads the recipient from this row, not from the
 * beneficiary table. A beneficiary record changed between approval and payment
 * therefore cannot move the money — and the database refuses that change
 * outright while a bereavement claim is live. This panel is where an approver
 * sees the name they are agreeing to.
 *
 * ## It renders nothing when the caller may not read it
 *
 * `getAssessmentSnapshot` returns `null` both when no assessment exists and
 * when the caller is not entitled to it, and the two are deliberately
 * indistinguishable: a panel saying "restricted" on a bereavement claim would
 * confirm the business had identified a payee.
 */
export function AssessmentSnapshotPanel({
  snapshot,
}: {
  readonly snapshot: AssessmentSnapshot | null;
}) {
  if (snapshot === null) return null;

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">
        The assessment, as it was frozen
      </h2>
      <p className="text-text-muted mt-1 text-sm">
        Written once and never updated. Every figure the amount came from is here, so the
        decision can be read back without recomputing it.
      </p>

      <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Line label="Assessed amount">
          <Money amount={snapshot.assessedAmount} weight="semibold" size="lg" />
        </Line>
        <Line label="Assessed by">
          {snapshot.assessedByLabel}
          <span className="text-text-muted block text-xs">
            on <DateValue value={snapshot.assessedOn} />
          </span>
        </Line>
        <Line label="Policy version read">
          <span className="font-mono">{snapshot.policyVersion}</span>
        </Line>

        {snapshot.benefitRateBps === null ? null : (
          <Line label="Rate applied">
            {String(snapshot.benefitRateBps / 100)}% of the eligible bill
          </Line>
        )}
        {snapshot.billAmount === null ? null : (
          <Line label="Bill assessed">
            <Money amount={snapshot.billAmount} />
          </Line>
        )}
        {snapshot.fixedBenefitAmount === null ? null : (
          <Line label="Fixed benefit in that version">
            <Money amount={snapshot.fixedBenefitAmount} />
          </Line>
        )}

        {snapshot.admissionNights === null ? null : (
          <Line label="Admission, as read then">
            <span className="tabular-nums">
              {snapshot.admissionNights} nights · {snapshot.admissionInclusiveDays ?? 0}{' '}
              ward days · {snapshot.admissionElapsedDays ?? 0} clock days
            </span>
            {snapshot.minAdmissionDays === null ? null : (
              <span className="text-text-muted block text-xs">
                against a threshold of {snapshot.minAdmissionDays}
              </span>
            )}
          </Line>
        )}

        {snapshot.yearBasis === null ? null : (
          <Line label="Benefit year">
            {BENEFIT_YEAR_BASIS_LABELS[snapshot.yearBasis]}
            {snapshot.periodFrom === null || snapshot.periodTo === null ? null : (
              <span className="text-text-muted block text-xs">
                <DateValue value={snapshot.periodFrom} /> to{' '}
                <DateValue value={snapshot.periodTo} />
              </span>
            )}
          </Line>
        )}
        {snapshot.annualCap === null ? null : (
          <Line label="Annual ceiling then">
            <Money amount={snapshot.annualCap} />
            {snapshot.remainingCapBefore === null ? null : (
              <span className="text-text-muted block text-xs">
                <Money amount={snapshot.remainingCapBefore} /> of it was left before this
                claim
              </span>
            )}
          </Line>
        )}
        {snapshot.priorClaimsInPeriod === null ? null : (
          <Line label="Already claimed in that period">
            <span className="tabular-nums">
              {snapshot.priorClaimsInPeriod}{' '}
              {snapshot.priorClaimsInPeriod === 1 ? 'claim' : 'claims'}
            </span>
            {snapshot.priorAmountInPeriod === null ? null : (
              <span className="text-text-muted block text-xs">
                <Money amount={snapshot.priorAmountInPeriod} /> in all
              </span>
            )}
          </Line>
        )}

        {snapshot.deceasedRelationship === null ? null : (
          <Line label="Relationship assessed">
            {snapshot.deceasedRelationship}
            <span className="text-text-muted block text-xs">
              {snapshot.relationshipEligible === null
                ? 'Eligibility was undecided at the time.'
                : snapshot.relationshipEligible
                  ? 'Eligible under the version read.'
                  : 'Not eligible under the version read.'}
            </span>
          </Line>
        )}

        {snapshot.beneficiaryNumber === null ? null : (
          <Line label="Payee frozen here">
            <span className="break-words">
              {snapshot.beneficiaryName ?? 'name not disclosed'}
            </span>
            <span className="text-text-muted block font-mono text-xs">
              {snapshot.beneficiaryNumber}
              {snapshot.beneficiaryRelationship === null
                ? ''
                : ` · ${snapshot.beneficiaryRelationship}`}
            </span>
            {snapshot.beneficiaryVerifiedByLabel === null ? null : (
              <span className="text-text-muted block text-xs">
                verified by {snapshot.beneficiaryVerifiedByLabel}
              </span>
            )}
          </Line>
        )}

        <Line label="Member's loans then">
          <span className="tabular-nums">
            {snapshot.activeMemberLoanCount}{' '}
            {snapshot.activeMemberLoanCount === 1 ? 'active loan' : 'active loans'}
          </span>
          <span className="text-text-muted block text-xs">
            <Money amount={snapshot.outstandingMemberLoanPrincipal} /> outstanding
          </span>
        </Line>
        <Line label="Member's savings then">
          <Money amount={snapshot.savingsBalance} />
          <span className="text-text-muted block text-xs">
            <Money amount={snapshot.pledgedSavings} /> of it pledged
          </span>
        </Line>
        <Line label="Evidence counted">
          <span className="tabular-nums">
            {snapshot.verifiedDocumentCount} checked{' '}
            {snapshot.verifiedDocumentCount === 1 ? 'document' : 'documents'}
          </span>
          {snapshot.verifiedDocumentKinds.length === 0 ? null : (
            <span className="text-text-muted block text-xs break-words">
              {snapshot.verifiedDocumentKinds.join(', ')}
            </span>
          )}
        </Line>
      </dl>

      {snapshot.assessmentNote === null ? null : (
        <p className="text-text mt-4 text-sm">
          <span className="font-medium">The assessor&rsquo;s note: </span>
          {snapshot.assessmentNote}
        </p>
      )}

      <p className="text-text-muted mt-4 text-xs">
        Waiting period applied: {snapshot.waitingPeriodDays} days. A payment reads its
        recipient from this row, never from the beneficiary record as it stands today.
      </p>
    </Card>
  );
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
