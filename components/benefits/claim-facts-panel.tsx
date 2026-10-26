import { BenefitClaimStatusBadge, BenefitClaimTypeBadge } from './benefit-badges';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { NotRecorded } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import type { BenefitClaimSummary } from '@/lib/data/benefits';
import {
  BENEFIT_CLAIM_STATUS_DESCRIPTIONS,
  admissionVerdict,
} from '@/lib/domain/benefits';

/**
 * A claim's facts, as recorded.
 *
 * ## Why these are called facts and not details
 *
 * Everything in this panel froze when the claim was submitted:
 * `benefit_claims_guard` refuses a change to the hospital, the bill, the
 * admission times, the deceased or the date of the event once the claim has
 * left `draft`. That is what makes an assessment reviewable — an assessor's
 * figure can be recomputed from the facts, and nobody can move the facts
 * under a decision that has already been taken.
 *
 * The panel says so, because a reader who does not know it would reasonably
 * assume a typo could be corrected.
 *
 * ## The three admission readings again
 *
 * Shown on the claim, not only on the form, because the assessment will turn
 * on them and the person reading the claim a week later needs to see why it is
 * being held. They are stored on the row — `admission_nights`,
 * `admission_inclusive_days`, `admission_elapsed_days` — rather than
 * recomputed, so a change in how the code counts can never alter what was
 * assessed.
 */
export function ClaimFactsPanel({
  claim,
  minimumAdmissionDays,
}: {
  readonly claim: BenefitClaimSummary;
  /** From the claim's own policy version, for reading the admission against. */
  readonly minimumAdmissionDays: number | null;
}) {
  const readings =
    claim.admissionNights !== null &&
    claim.admissionInclusiveDays !== null &&
    claim.admissionElapsedDays !== null
      ? {
          nights: claim.admissionNights,
          inclusiveDays: claim.admissionInclusiveDays,
          elapsedDays: claim.admissionElapsedDays,
        }
      : null;

  const verdict =
    readings === null || minimumAdmissionDays === null
      ? null
      : admissionVerdict(readings, minimumAdmissionDays);

  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="text-text mr-auto text-sm font-semibold">The claim</h2>
        <BenefitClaimTypeBadge type={claim.claimType} />
        <BenefitClaimStatusBadge status={claim.status} />
      </div>

      <p className="text-text-muted mt-1 text-sm">
        {BENEFIT_CLAIM_STATUS_DESCRIPTIONS[claim.status]}
      </p>

      <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Claim">
          <span className="font-mono">{claim.claimNumber}</span>
        </Fact>
        <Fact label="Member">
          <span className="break-words">{claim.memberName}</span>
          <span className="text-text-muted block font-mono text-xs">
            {claim.membershipNumber} · {claim.clientNumber}
          </span>
        </Fact>
        <Fact label="Branch">{claim.branchName}</Fact>
        <Fact label="Event date">
          <DateValue value={claim.eventDate} />
        </Fact>
        <Fact label="Policy version">
          <span className="font-mono">{claim.policyVersion}</span>
          <span className="text-text-muted block text-xs">
            The version governing this membership, which is what the assessment reads.
          </span>
        </Fact>
        <Fact label="Membership status when read">{claim.membershipStatus}</Fact>

        {claim.claimType === 'medical' ? (
          <>
            <Fact label="Hospital or clinic">
              <span className="break-words">{claim.providerName ?? '—'}</span>
            </Fact>
            <Fact label="Hospital bill">
              {claim.billAmount === null ? (
                <NotRecorded />
              ) : (
                <Money amount={claim.billAmount} weight="semibold" />
              )}
            </Fact>
            <Fact label="Admission, on three readings">
              {readings === null ? (
                <span className="text-text-muted">
                  Not yet — the member has not been discharged.
                </span>
              ) : (
                <>
                  <span className="tabular-nums">
                    {readings.nights} {readings.nights === 1 ? 'night' : 'nights'} ·{' '}
                    {readings.inclusiveDays} ward days · {readings.elapsedDays} clock{' '}
                    {readings.elapsedDays === 1 ? 'day' : 'days'}
                  </span>
                  {verdict === null ? null : (
                    <span
                      className={
                        verdict.qualifies
                          ? 'text-success block text-xs font-medium'
                          : verdict.undecided
                            ? 'text-warning block text-xs font-medium'
                            : 'text-text-muted block text-xs'
                      }
                    >
                      {verdict.qualifies
                        ? `Longer than ${String(minimumAdmissionDays)} on every reading.`
                        : verdict.undecided
                          ? 'The readings disagree, so the assessment is held until the client says what is counted.'
                          : `Shorter than ${String(minimumAdmissionDays)} on every reading.`}
                    </span>
                  )}
                </>
              )}
            </Fact>
          </>
        ) : null}

        {claim.claimType === 'family_condolence' ? (
          <>
            <Fact label="Who died">
              <span className="break-words">{claim.deceasedName ?? '—'}</span>
            </Fact>
            <Fact label="Relationship to the member">
              {claim.deceasedRelationshipLabel ?? '—'}
            </Fact>
          </>
        ) : null}

        {claim.claimType === 'member_bereavement' ? (
          <>
            <Fact label="The member, as named on the evidence">
              <span className="break-words">{claim.deceasedName ?? '—'}</span>
            </Fact>
            <Fact label="Proposed payee">
              {claim.beneficiaryNumber === null ? (
                <span className="text-text-muted">None chosen yet</span>
              ) : (
                <>
                  <span className="font-mono">{claim.beneficiaryNumber}</span>
                  <span className="text-text-muted block text-xs">
                    {claim.beneficiaryVerificationStatus === 'verified'
                      ? 'Verified. The payee the assessment will freeze.'
                      : 'Not verified, so the claim cannot be assessed yet.'}
                  </span>
                </>
              )}
            </Fact>
          </>
        ) : null}

        <Fact label="Claimed">
          {claim.claimedAmount === null ? (
            <NotRecorded />
          ) : (
            <Money amount={claim.claimedAmount} />
          )}
        </Fact>
        <Fact label="Assessed">
          {claim.assessedAmount === null ? (
            <NotRecorded />
          ) : (
            <Money amount={claim.assessedAmount} />
          )}
        </Fact>
        <Fact label="Approved">
          {claim.approvedAmount === null ? (
            <NotRecorded />
          ) : (
            <Money amount={claim.approvedAmount} weight="semibold" />
          )}
        </Fact>
      </dl>

      <dl className="border-border mt-4 grid min-w-0 gap-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Submitted">
          {claim.submittedAt === null ? (
            <NotRecorded />
          ) : (
            <>
              <DateValue value={claim.submittedAt} variant="datetime" />
              <span className="text-text-muted block text-xs">
                by {claim.submittedByLabel ?? 'an archived account'}
              </span>
            </>
          )}
        </Fact>
        <Fact label="Assessed by">
          {claim.assessedAt === null ? (
            <NotRecorded />
          ) : (
            <>
              <DateValue value={claim.assessedAt} variant="datetime" />
              <span className="text-text-muted block text-xs">
                by {claim.assessedByLabel ?? 'an archived account'}
              </span>
            </>
          )}
        </Fact>
        <Fact label="Decided by">
          {claim.decidedAt === null ? (
            <NotRecorded />
          ) : (
            <>
              <DateValue value={claim.decidedAt} variant="datetime" />
              <span className="text-text-muted block text-xs">
                by {claim.decidedByLabel ?? 'an archived account'}
              </span>
            </>
          )}
        </Fact>
      </dl>

      {claim.informationRequiredNote === null ? null : (
        <p className="text-text mt-4 text-sm">
          <span className="font-medium">What was asked for: </span>
          {claim.informationRequiredNote}
        </p>
      )}

      {claim.rejectedReason === null ? null : (
        <p className="text-text mt-4 text-sm">
          <span className="font-medium">Why it was refused: </span>
          {claim.rejectedReason}
        </p>
      )}

      {claim.cancelledReason === null ? null : (
        <p className="text-text mt-4 text-sm">
          <span className="font-medium">Why it was withdrawn: </span>
          {claim.cancelledReason}
        </p>
      )}

      {claim.status === 'draft' ? (
        <p className="text-text-muted mt-4 text-xs">
          These facts can still be changed while the claim is a draft. Submitting freezes
          them: the hospital, the bill, the admission times and the event date cannot be
          edited afterwards, which is what makes the assessment reviewable.
        </p>
      ) : (
        <p className="text-text-muted mt-4 text-xs">
          These facts froze when the claim was submitted and cannot be edited. A claim
          recorded wrongly is withdrawn with a reason and opened again.
        </p>
      )}
    </Card>
  );
}

function Fact({
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
