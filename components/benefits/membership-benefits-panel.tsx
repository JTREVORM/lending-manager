import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import type { BeneficiarySummary, BenefitClaimSummary } from '@/lib/data/benefits';
import { BENEFIT_CLAIM_TYPE_LABELS } from '@/lib/domain/benefits';
import { BeneficiaryVerificationBadge, BenefitClaimStatusBadge } from './benefit-badges';

/**
 * A member's next of kin and benefit claims, on their own profile.
 *
 * ## Why the beneficiary panel lives here as well as in its own register
 *
 * This answers "who is this member's next of kin", which is a fact about the
 * person in front of you; the register answers "which members have nobody
 * checked", which is a fact about the programme. Both are real questions and
 * neither screen answers the other one well.
 *
 * ## No names, for the same reason as everywhere else
 *
 * The register view carries none: a beneficiary's name is the business's
 * payment instruction, and it lives behind `membership:view_sensitive` in
 * another table. The record number, the relationship and the verification
 * state are what a counter needs, and the name is one click away for somebody
 * entitled to it.
 *
 * ## An unverified beneficiary is called out, not merely listed
 *
 * Because it is the one state with a consequence: a bereavement benefit that
 * cannot be paid on the day it is needed. The sentence says so rather than
 * leaving a reader to infer it from an amber pill.
 */
export function MembershipBenefitsPanel({
  membershipId,
  beneficiaries,
  claims,
  canManageBeneficiaries,
  canClaim,
}: {
  readonly membershipId: string;
  readonly beneficiaries: readonly BeneficiarySummary[];
  readonly claims: readonly BenefitClaimSummary[];
  readonly canManageBeneficiaries: boolean;
  readonly canClaim: boolean;
}) {
  const active = beneficiaries.filter((row) => row.status === 'active');
  const verified = active.filter((row) => row.verificationStatus === 'verified');
  const past = beneficiaries.filter((row) => row.status !== 'active');

  return (
    <>
      <Card>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h3 className="text-text text-sm font-semibold">Next of kin</h3>
          {canManageBeneficiaries ? (
            <Link
              href={`${ROUTES.beneficiaries}/new?membershipId=${membershipId}`}
              className="text-accent text-sm font-medium underline-offset-2 hover:underline"
            >
              Register a beneficiary
            </Link>
          ) : null}
        </div>

        {active.length === 0 ? (
          <p className="text-text-muted mt-2 text-sm">
            None registered. Until one is registered and checked by somebody other than
            whoever recorded it, this member&rsquo;s bereavement benefit cannot be paid —
            and that is discovered on the worst possible day.
          </p>
        ) : (
          <>
            <ul className="divide-border/60 mt-3 divide-y">
              {active.map((row) => (
                <li key={row.id} className="min-w-0 py-2.5">
                  <Link
                    href={`${ROUTES.beneficiaries}/${row.id}`}
                    className="flex min-w-0 items-center justify-between gap-3"
                  >
                    <span className="min-w-0">
                      <span className="text-text block text-sm">
                        {row.relationshipLabel}
                        {row.isPrimary ? ' · primary' : ''}
                      </span>
                      <span className="text-text-muted block font-mono text-xs">
                        {row.beneficiaryNumber}
                      </span>
                    </span>
                    <span className="shrink-0">
                      <BeneficiaryVerificationBadge status={row.verificationStatus} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            {verified.length === 0 ? (
              <p className="text-text mt-3 text-sm font-medium">
                Nobody has checked any of these records yet, so a bereavement benefit
                cannot be assessed. An unverified beneficiary is never paid automatically.
              </p>
            ) : null}
          </>
        )}

        {past.length === 0 ? null : (
          <p className="text-text-muted mt-3 text-xs">
            {past.length} earlier {past.length === 1 ? 'record is' : 'records are'} kept,
            superseded or withdrawn. A change is a new record rather than an edit, so a
            payment made against an old one stays explicable.
          </p>
        )}
      </Card>

      <Card>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h3 className="text-text text-sm font-semibold">Benefit claims</h3>
          {canClaim ? (
            <Link
              href={`${ROUTES.newBenefitClaim}?membershipId=${membershipId}`}
              className="text-accent text-sm font-medium underline-offset-2 hover:underline"
            >
              Open a claim
            </Link>
          ) : null}
        </div>

        {claims.length === 0 ? (
          <p className="text-text-muted mt-2 text-sm">This member has made no claim.</p>
        ) : (
          <ul className="divide-border/60 mt-3 divide-y">
            {claims.map((claim) => (
              <li key={claim.id} className="min-w-0 py-2.5">
                <Link
                  href={`${ROUTES.benefitClaims}/${claim.id}`}
                  className="flex min-w-0 items-start justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="text-text block text-sm">
                      {BENEFIT_CLAIM_TYPE_LABELS[claim.claimType]}
                    </span>
                    <span className="text-text-muted block text-xs">
                      <span className="font-mono">{claim.claimNumber}</span> ·{' '}
                      <DateValue value={claim.eventDate} />
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <BenefitClaimStatusBadge status={claim.status} />
                    {claim.approvedAmount === null ? null : (
                      <span className="text-text block text-xs tabular-nums">
                        <Money amount={claim.approvedAmount} />
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
