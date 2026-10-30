import { HeartHandshake } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BereavementClaimForm } from '@/components/benefits/bereavement-claim-form';
import { CondolenceClaimForm } from '@/components/benefits/condolence-claim-form';
import { MedicalClaimForm } from '@/components/benefits/medical-claim-form';
import { MemberChooser } from '@/components/benefits/member-chooser';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  listBeneficiariesForMembership,
  listBeneficiaryRelationships,
} from '@/lib/data/benefits';
import {
  getMembership,
  getMembershipPolicy,
  listMemberships,
} from '@/lib/data/membership';
import {
  BENEFIT_CLAIM_TYPES,
  BENEFIT_CLAIM_TYPE_DESCRIPTIONS,
  BENEFIT_CLAIM_TYPE_LABELS,
  isBenefitClaimType,
} from '@/lib/domain/benefits';
import { isLiveMembershipStatus } from '@/lib/domain/membership';

export const metadata = { title: 'Open a benefit claim' };

/**
 * Opening a claim, in two questions: which member, and which benefit.
 *
 * Both answers live in the query string rather than in component state, so
 * the back button steps back through the flow, a half-finished claim can be
 * handed to a colleague as a link, and a refresh does not drop the member
 * somebody has just searched for.
 *
 * ## Why the member comes first
 *
 * Because the second question's form depends on it. A bereavement form needs
 * the member's registered beneficiaries; a medical form needs the rate from
 * the policy version governing *that* membership, which is not necessarily
 * the one in force today. Asking for the benefit first would mean rendering a
 * form and then changing it underneath the person filling it in.
 *
 * ## The policy read is the membership's version, not today's
 *
 * `getMembershipPolicy(membership.policyVersionId)` rather than
 * `getActiveMembershipPolicy()`. A member enrolled under version 1.0 is
 * governed by version 1.0, and a preview computed from a newer version would
 * quote a figure the assessment will not produce.
 */
export default async function NewBenefitClaimPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.newBenefitClaim, 'benefits:claim');
  const params = await searchParams;

  const membershipId = typeof params.membershipId === 'string' ? params.membershipId : '';
  const typeParam = typeof params.type === 'string' ? params.type : '';
  const query = typeof params.q === 'string' ? params.q : '';

  const header = (
    <PageHeader
      eyebrow="Membership Benefits"
      icon={HeartHandshake}
      title="Open a benefit claim"
      description="A claim is recorded first and decided afterwards. Nothing here commits the business to paying anything."
      back={{ href: ROUTES.benefitClaims, label: 'Benefit claims' }}
    />
  );

  // --- Question one: which member ------------------------------------------
  if (membershipId === '') {
    const page = await listMemberships({
      query: query === '' ? null : query,
      status: null,
      page: 1,
    });

    const live = page.memberships.filter((membership) =>
      isLiveMembershipStatus(membership.status),
    );

    return (
      <div className="min-w-0 space-y-6">
        {header}
        <MemberChooser
          memberships={live}
          query={query}
          heading="Which member is this claim for?"
          description="Live memberships only. A claim is opened against the membership, and its rules read the membership's own policy version."
          hrefs={Object.fromEntries(
            live.map((membership) => [
              membership.id,
              `${ROUTES.newBenefitClaim}?membershipId=${membership.id}${
                typeParam === '' ? '' : `&type=${typeParam}`
              }`,
            ]),
          )}
        />
      </div>
    );
  }

  const membership = await getMembership(membershipId);

  if (membership === null) notFound();

  const policy = await getMembershipPolicy(membership.policyVersionId);

  // --- Question two: which benefit -----------------------------------------
  if (!isBenefitClaimType(typeParam)) {
    return (
      <div className="min-w-0 space-y-6">
        {header}

        <Card>
          <h2 className="text-text text-sm font-semibold">
            Which benefit is being claimed?
          </h2>
          <p className="text-text-muted mt-1 text-sm">
            For {membership.fullName}{' '}
            <span className="font-mono">{membership.membershipNumber}</span>.{' '}
            <Link
              href={`${ROUTES.newBenefitClaim}${query === '' ? '' : `?q=${encodeURIComponent(query)}`}`}
              className="text-accent underline-offset-2 hover:underline"
            >
              Choose a different member
            </Link>
            .
          </p>

          <ul className="mt-4 space-y-2">
            {BENEFIT_CLAIM_TYPES.map((claimType) => (
              <li key={claimType}>
                <Link
                  href={`${ROUTES.newBenefitClaim}?membershipId=${membership.id}&type=${claimType}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <p className="text-text font-medium">
                    {BENEFIT_CLAIM_TYPE_LABELS[claimType]}
                  </p>
                  <p className="text-text-muted mt-0.5 text-sm">
                    {BENEFIT_CLAIM_TYPE_DESCRIPTIONS[claimType]}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    );
  }

  if (policy === null) {
    return (
      <div className="min-w-0 space-y-6">
        {header}
        <Alert tone="danger" title="This membership's policy version cannot be read">
          A claim cannot be previewed without the policy version governing the membership.
          Report this — it means the membership points at a version that is not readable.
        </Alert>
      </div>
    );
  }

  const [relationships, beneficiaries] = await Promise.all([
    typeParam === 'family_condolence'
      ? listBeneficiaryRelationships()
      : Promise.resolve([]),
    typeParam === 'member_bereavement' || typeParam === 'family_condolence'
      ? listBeneficiariesForMembership(membership.id)
      : Promise.resolve([]),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      {header}

      {membership.status === 'suspended' ? (
        // Said once, here, rather than discovered at assessment. What a
        // suspension does to a benefit claim is itself undecided — it is on
        // the open list — so the notice states the position and claims nothing.
        <Alert tone="warning" title="This membership is suspended">
          Whether a suspended member may claim is one of the rules the client has not
          decided. The claim is recordable; the assessment will hold it with that reason
          rather than guess.
        </Alert>
      ) : null}

      {typeParam === 'medical' ? (
        <MedicalClaimForm
          membershipId={membership.id}
          memberName={membership.fullName}
          membershipNumber={membership.membershipNumber}
          medicalRateBps={policy.medicalBenefitRateBps}
          minimumAdmissionDays={policy.medicalBenefitMinAdmissionDays}
        />
      ) : null}

      {typeParam === 'family_condolence' ? (
        <CondolenceClaimForm
          membershipId={membership.id}
          memberName={membership.fullName}
          membershipNumber={membership.membershipNumber}
          relationships={relationships}
          benefitAmount={policy.familyCondolenceBenefit}
          nextOfKin={beneficiaries.filter((b) => b.status === 'active')}
        />
      ) : null}

      {typeParam === 'member_bereavement' ? (
        <BereavementClaimForm
          membershipId={membership.id}
          memberName={membership.fullName}
          membershipNumber={membership.membershipNumber}
          beneficiaries={beneficiaries}
          benefitAmount={policy.memberBereavementBenefit}
        />
      ) : null}
    </div>
  );
}
