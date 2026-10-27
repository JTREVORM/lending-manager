import { UserRoundPlus } from 'lucide-react';
import { notFound } from 'next/navigation';

import { BeneficiaryForm } from '@/components/benefits/beneficiary-form';
import { MemberChooser } from '@/components/benefits/member-chooser';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getBeneficiary,
  listBeneficiariesForMembership,
  listBeneficiaryRelationships,
} from '@/lib/data/benefits';
import { getMembership, listMemberships } from '@/lib/data/membership';
import { isLiveMembershipStatus } from '@/lib/domain/membership';

export const metadata = { title: 'Register a beneficiary' };

/**
 * Registering a next of kin, or replacing one.
 *
 * `?membershipId=` chooses the member; `?supersedes=` makes it a replacement.
 * Both in the query string, so the back button steps through the flow and a
 * half-finished registration can be handed over as a link.
 *
 * The replacement case is reached from the record being replaced, which is
 * why this page reads it rather than asking: a form that asked "which record
 * does this replace" would invite the wrong answer.
 */
export default async function NewBeneficiaryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(`${ROUTES.beneficiaries}/new`, 'beneficiaries:manage');
  const params = await searchParams;

  const membershipId = typeof params.membershipId === 'string' ? params.membershipId : '';
  const supersedesId = typeof params.supersedes === 'string' ? params.supersedes : '';
  const query = typeof params.q === 'string' ? params.q : '';

  const header = (
    <PageHeader
      eyebrow="Membership Benefits"
      icon={UserRoundPlus}
      title={supersedesId === '' ? 'Register a beneficiary' : 'Replace a beneficiary'}
      description="Who the business pays a member's bereavement benefit to. The record is saved unverified; somebody else checks it."
      back={{ href: ROUTES.beneficiaries, label: 'Next of kin' }}
    />
  );

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
          heading="Whose next of kin is this?"
          description="Live memberships only. A beneficiary belongs to a membership, and the bereavement benefit is paid against it."
          hrefs={Object.fromEntries(
            live.map((membership) => [
              membership.id,
              `${ROUTES.beneficiaries}/new?membershipId=${membership.id}`,
            ]),
          )}
        />
      </div>
    );
  }

  const [membership, relationships, existing, supersedes] = await Promise.all([
    getMembership(membershipId),
    listBeneficiaryRelationships(),
    listBeneficiariesForMembership(membershipId),
    supersedesId === '' ? Promise.resolve(null) : getBeneficiary(supersedesId),
  ]);

  if (membership === null) notFound();

  const hasPrimary = existing.some(
    (row) => row.status === 'active' && row.isPrimary && row.id !== supersedes?.id,
  );

  return (
    <div className="min-w-0 space-y-6">
      {header}
      <BeneficiaryForm
        membershipId={membership.id}
        memberName={membership.fullName}
        membershipNumber={membership.membershipNumber}
        relationships={relationships}
        supersedes={supersedes}
        hasPrimary={hasPrimary}
      />
    </div>
  );
}
