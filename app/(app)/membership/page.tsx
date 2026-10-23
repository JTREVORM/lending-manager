import { BadgeCheck } from 'lucide-react';

import { MembershipRegister } from '@/components/membership/membership-register';
import { Alert } from '@/components/ui/alert';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getActiveMembershipPolicy, listMemberships } from '@/lib/data/membership';
import { policyBlockedReason } from '@/lib/domain/membership';
import { membershipSearchSchema } from '@/lib/validation/membership';

export const metadata = { title: 'Membership' };

/**
 * The membership register.
 *
 * Guarded three times, in the shape every register here uses: the proxy
 * refuses an anonymous request, the layout applies the route requirement, and
 * this page states `membership:view` again explicitly so the requirement
 * stays visible at the surface that depends on it. Beneath all of it, Row
 * Level Security means a caller without the capability gets no rows however
 * they ask — and a borrower gets at most their own, through the identity
 * clause on `clients.profile_id` rather than through a capability.
 *
 * ## There is no "Enrol member" action, and that is the point
 *
 * Enrolment is Polytos Phase 2. A primary action leading to a form that
 * cannot complete, or that could write a membership with no registration fee
 * and no signed terms behind it, would be worse than no action — it would be
 * the system telling a clerk that members can be taken on today.
 *
 * What the page does say, at the top, is *why*: the policy version is a
 * draft with nine rules still undecided, and until the client settles them
 * nothing can be enrolled, saved or paid out. That sentence is read from the
 * policy row rather than hard-coded, so it stops appearing the moment the
 * policy is approved.
 */
export default async function MembershipPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.membership, 'membership:view');
  const params = await searchParams;

  const parsed = membershipSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : '',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  // A malformed filter in the URL falls back to the default view rather than
  // erroring: the filter is a convenience, not a control.
  const filter = parsed.success ? parsed.data : { query: null, status: null, page: 1 };

  const [page, policy] = await Promise.all([
    listMemberships(filter),
    getActiveMembershipPolicy(),
  ]);

  // `null` means no version has been activated at all, which is the state
  // today and a different sentence from "a version is in force but
  // incomplete".
  const blocked =
    policy === null
      ? 'No membership policy version is in force yet. Enrolment, savings and benefits all wait on one being approved.'
      : policyBlockedReason(policy);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Register"
        icon={BadgeCheck}
        title="Membership"
        description="Members of the Polytos savings and benefits programme. Search by member name, membership number or client number."
        secondaryActions={
          <ActionLink href={ROUTES.membershipPolicies} variant="secondary">
            Membership policy
          </ActionLink>
        }
      />

      {blocked === null ? null : (
        <Alert tone="warning" title="Enrolment is not open yet">
          {blocked} The register below is live and will fill as members are enrolled.
        </Alert>
      )}

      <MembershipRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          status: filter.status ?? '',
        }}
      />
    </div>
  );
}
