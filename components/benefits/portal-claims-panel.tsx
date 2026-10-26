import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import type { PortalClaim } from '@/lib/data/benefits';
import {
  BENEFIT_CLAIM_STATUS_DESCRIPTIONS,
  BENEFIT_CLAIM_TYPE_LABELS,
} from '@/lib/domain/benefits';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { BenefitClaimStatusBadge } from './benefit-badges';

/**
 * A member's own benefit claims, in the portal.
 *
 * ## What it shows, and why that list is shorter than the staff screen's
 *
 * Read through `benefit_claim_portal_view`, whose **column list is the
 * disclosure policy**. `assessment_note` is not in it, because that is an
 * officer's reasoning about whether a member's documents looked genuine, and a
 * member reading it would learn what the business suspected rather than what
 * it decided.
 *
 * The refusal reason *is* in it. A member is entitled to be told why a claim
 * was refused — a refusal they cannot explain is worse than no answer, and it
 * is the sentence they will quote at the next monthly meeting.
 *
 * ## Why the status gets a sentence and not just a pill
 *
 * "Waiting for approval" means nothing to somebody who does not know the
 * stages. The description says what is actually happening and, where
 * something is wanted from them, exactly what.
 */
export function PortalClaimsPanel({
  claims,
}: {
  readonly claims: readonly PortalClaim[];
}) {
  if (claims.length === 0) return null;

  return (
    <section aria-labelledby="my-benefits-heading" className="min-w-0 space-y-4">
      <h2 id="my-benefits-heading" className="text-text text-lg font-semibold">
        My benefit claims
      </h2>

      <ul className="min-w-0 space-y-3">
        {claims.map((claim) => (
          <li key={claim.id}>
            <Card>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-text font-medium">
                    {BENEFIT_CLAIM_TYPE_LABELS[claim.claimType]}
                  </p>
                  <p className="text-text-muted font-mono text-sm">{claim.claimNumber}</p>
                </div>
                <BenefitClaimStatusBadge status={claim.status} />
              </div>

              <p className="text-text-muted mt-2 text-sm">
                {BENEFIT_CLAIM_STATUS_DESCRIPTIONS[claim.status]}
              </p>

              <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Line label="When it happened">
                  <DateValue value={claim.eventDate} />
                </Line>

                {claim.providerName === null ? null : (
                  <Line label="Hospital">
                    <span className="break-words">{claim.providerName}</span>
                  </Line>
                )}

                {claim.billAmount === null ? null : (
                  <Line label="The bill">
                    <Money amount={claim.billAmount} />
                  </Line>
                )}

                {claim.deceasedName === null ? null : (
                  <Line label="Who died">
                    <span className="break-words">{claim.deceasedName}</span>
                  </Line>
                )}

                {claim.approvedAmount === null ? null : (
                  <Line label="Approved">
                    <Money amount={claim.approvedAmount} weight="semibold" />
                  </Line>
                )}

                {claim.paidOn === null ? null : (
                  <Line label="Paid">
                    <DateValue value={claim.paidOn} />
                    <span className="text-text-muted block text-xs">
                      {claim.paidAmount === null ? null : (
                        <Money amount={claim.paidAmount} />
                      )}
                      {claim.paymentMethod === null
                        ? ''
                        : ` · ${PAYMENT_METHOD_LABELS[claim.paymentMethod]}`}
                      {claim.paymentNumber === null ? '' : ` · ${claim.paymentNumber}`}
                    </span>
                  </Line>
                )}
              </dl>

              {claim.informationRequiredNote === null ? null : (
                <p className="text-text mt-3 text-sm">
                  <span className="font-medium">We need something from you: </span>
                  {claim.informationRequiredNote}
                </p>
              )}

              {claim.rejectedReason === null ? null : (
                <p className="text-text mt-3 text-sm">
                  <span className="font-medium">Why this was refused: </span>
                  {claim.rejectedReason}
                </p>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </section>
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
