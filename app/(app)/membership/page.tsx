import { BadgeCheck } from 'lucide-react';

import { MembershipRegister } from '@/components/membership/membership-register';
import { Alert } from '@/components/ui/alert';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getActiveMembershipPolicy, listMemberships } from '@/lib/data/membership';
import {
  MEMBERSHIP_ACTIVITY_LABELS,
  activityBlockedReason,
  membershipActivityReadiness,
} from '@/lib/domain/membership';
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
 * ## The "Enrol member" action appears when enrolment can actually complete
 *
 * Phase 1 shipped this register with no primary action, because enrolment did
 * not exist and an action leading to a form that could not complete would
 * have been the system telling a clerk that members could be taken on.
 *
 * Phase 2 built it, so the action is here — but only when the caller holds
 * `membership:create` **and** the policy version in force actually opens
 * enrolment. Where it does not, the banner says why instead, read from the
 * policy row rather than hard-coded, so it stops appearing the moment the
 * policy is approved.
 *
 * ## The banner is about enrolment, and says so
 *
 * It used to say that no membership transaction could run while any of the
 * nine rules was undecided. That is not true and was never going to be:
 * enrolment and the registration fee wait on none of them. So this banner
 * asks only whether *enrolment* is open, and a second line names the
 * activities that are still held up — because a register that overstates its
 * own paralysis teaches the reader to scroll past the warning.
 */
export default async function MembershipPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.membership, 'membership:view');
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
  const enrolmentBlocked =
    policy === null
      ? 'No membership policy version is in force yet. Enrolment, savings and benefits all wait on one being approved.'
      : activityBlockedReason(policy, 'enrolment');

  // Everything else that is not open, named. Enrolment is excluded because
  // the banner above is about exactly that.
  const heldUp =
    policy === null
      ? []
      : membershipActivityReadiness(policy).filter(
          (row) => row.activity !== 'enrolment' && !row.ready,
        );

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Register"
        icon={BadgeCheck}
        title="Membership"
        description="Members of the Polytos savings and benefits programme. Search by member name, membership number or client number."
        primaryAction={
          enrolmentBlocked === null && contextCan(context, 'membership:create') ? (
            <ActionLink href={ROUTES.enrolMember}>Enrol a member</ActionLink>
          ) : undefined
        }
        secondaryActions={
          <ActionLink href={ROUTES.membershipPolicies} variant="secondary">
            Membership policy
          </ActionLink>
        }
      />

      {enrolmentBlocked === null ? (
        heldUp.length === 0 ? null : (
          <Alert tone="info" title="Enrolment is open">
            {heldUp.length === 1
              ? 'One activity is'
              : `${String(heldUp.length)} activities are`}{' '}
            still waiting on decisions the client has not made:{' '}
            {heldUp.map((row) => MEMBERSHIP_ACTIVITY_LABELS[row.activity]).join(', ')}.
          </Alert>
        )
      ) : (
        <Alert tone="warning" title="Enrolment is not open yet">
          {enrolmentBlocked} The register below is live and will fill as members are
          enrolled.
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
