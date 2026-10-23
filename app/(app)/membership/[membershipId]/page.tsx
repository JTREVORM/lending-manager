import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MembershipHistory } from '@/components/membership/membership-history';
import { MembershipPolicyPanel } from '@/components/membership/membership-policy-panel';
import { MembershipStatusBadge } from '@/components/membership/membership-status-badge';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getMembership,
  getMembershipPolicy,
  listMembershipHistory,
} from '@/lib/data/membership';
import {
  MEMBERSHIP_STATUS_DESCRIPTIONS,
  membershipTransitionsFrom,
  MEMBERSHIP_STATUS_LABELS,
} from '@/lib/domain/membership';

export const metadata = { title: 'Membership' };

/**
 * One membership.
 *
 * ## What a given viewer sees
 *
 * Assembled from what the caller may actually read, and each absence is a
 * database decision rather than a conditional here:
 *
 *   - the status history comes back as an empty list without
 *     `membership:view`, because the policy on
 *     `membership_status_history` has no self-clause;
 *   - the membership itself comes back null for anybody the policy on
 *     `memberships` refuses, which renders as not-found.
 *
 * A missing membership and an unauthorised one both render the same
 * not-found page. That is deliberate: distinguishing them would confirm that
 * a record exists to somebody who may not see it, which is the thing the
 * policy is preventing.
 *
 * ## Read-only, on purpose
 *
 * There is no "Collect savings", no "Withdraw", no "Pay benefit" and no
 * status control. Every one of those is a financial or lifecycle write that
 * belongs to Polytos Phase 2 or 4, and the brief is explicit that this phase
 * must not show actions that appear operational before their workflow
 * exists. What the page does show is **what the lifecycle permits next**,
 * as a sentence rather than as buttons — a reader planning the work can see
 * where this membership can go without being offered a control that would
 * fail.
 */
export default async function MembershipDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly membershipId: string }>;
}) {
  const { membershipId } = await params;
  const context = await guardPermission(
    `${ROUTES.membership}/${membershipId}`,
    'membership:view',
  );

  const membership = await getMembership(membershipId);

  if (membership === null) notFound();

  const [history, policy] = await Promise.all([
    listMembershipHistory(membership.id),
    getMembershipPolicy(membership.policyVersionId),
  ]);

  const canSeeClient = contextCan(context, 'clients:view');
  const next = membershipTransitionsFrom(membership.status);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Register"
        icon={BadgeCheck}
        back={{ href: ROUTES.membership, label: 'Membership' }}
        title={membership.fullName}
        status={<MembershipStatusBadge status={membership.status} />}
        description={<span className="font-mono">{membership.membershipNumber}</span>}
      />

      {membership.status === 'suspended' || membership.status === 'withdrawn' ? (
        <Alert tone={membership.status === 'suspended' ? 'warning' : 'info'}>
          <span className="font-medium">
            {membership.status === 'suspended'
              ? 'This membership is suspended.'
              : 'This membership has ended.'}
          </span>{' '}
          {membership.statusReason ?? 'No reason was recorded.'}
        </Alert>
      ) : null}

      <SectionTabs
        label="Membership sections"
        tabs={[
          { id: 'membership-profile-heading', label: 'Membership' },
          { id: 'membership-lifecycle-heading', label: 'Lifecycle' },
          { id: 'membership-terms-heading', label: 'Terms' },
        ]}
      />

      {/* --- The membership ------------------------------------------- */}
      <section aria-labelledby="membership-profile-heading" className="min-w-0 space-y-3">
        <h2 id="membership-profile-heading" className="text-text text-lg font-semibold">
          Membership
        </h2>

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Detail label="Membership number">
              <span className="font-mono">{membership.membershipNumber}</span>
            </Detail>
            <Detail label="Status">
              {MEMBERSHIP_STATUS_LABELS[membership.status]} —{' '}
              {MEMBERSHIP_STATUS_DESCRIPTIONS[membership.status]}
            </Detail>
            <Detail label="Client">
              {canSeeClient ? (
                <Link
                  href={`${ROUTES.clients}/${membership.clientId}`}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  {membership.fullName}{' '}
                  <span className="font-mono">({membership.clientNumber})</span>
                </Link>
              ) : (
                <>
                  {membership.fullName}{' '}
                  <span className="font-mono">({membership.clientNumber})</span>
                </>
              )}
            </Detail>
            <Detail label="Phone">
              <PhoneValue value={membership.phone} />
            </Detail>
            <Detail label="Branch">{membership.branchName ?? '—'}</Detail>
            <Detail label="Location">
              {membership.villageArea}, {membership.district}
            </Detail>
            <Detail label="Applied on">
              <DateValue value={membership.appliedOn} />
            </Detail>
            <Detail label="Joined on">
              <DateValue value={membership.activatedOn} />
            </Detail>
            <Detail label="Ended on">
              <DateValue value={membership.endedOn} />
            </Detail>
            <Detail label="Governed by">Policy version {membership.policyVersion}</Detail>

            {membership.notes === null ? null : (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-text-muted text-sm">Notes</dt>
                <dd className="text-text mt-1 break-words whitespace-pre-wrap">
                  {membership.notes}
                </dd>
              </div>
            )}
          </dl>
        </Card>
      </section>

      {/* --- Savings, fees and benefits: deliberately absent ------------- */}
      <section aria-labelledby="membership-money-heading" className="min-w-0 space-y-3">
        <h2 id="membership-money-heading" className="text-text text-lg font-semibold">
          Savings, fees and benefits
        </h2>

        <Card>
          <p className="text-text text-sm">
            Nothing is recorded here yet. Savings accounts, the registration fee receipt,
            benefit claims and the year-end profit share are built in later phases of the
            Polytos programme, and this system records no membership money until they are.
          </p>
          <p className="text-text-muted mt-2 text-[13px]">
            No figure on this page is a balance. A member&rsquo;s savings are not held
            anywhere in the current schema, so a zero here would be a statement about the
            software rather than about the member.
          </p>
        </Card>
      </section>

      {/* --- Lifecycle --------------------------------------------------- */}
      <section
        aria-labelledby="membership-lifecycle-heading"
        className="min-w-0 space-y-3"
      >
        <h2 id="membership-lifecycle-heading" className="text-text text-lg font-semibold">
          Lifecycle
        </h2>

        <Card>
          <p className="text-text text-sm">
            {next.length === 0 ? (
              <>
                This is a final state. A client who rejoins is enrolled afresh, with a new
                membership number, because the savings qualification period and the
                benefit waiting period both start again.
              </>
            ) : (
              <>
                From {MEMBERSHIP_STATUS_LABELS[membership.status].toLowerCase()}, this
                membership may move to{' '}
                {next
                  .map((status) => MEMBERSHIP_STATUS_LABELS[status].toLowerCase())
                  .join(', ')}
                . Making any of those changes needs the membership status capability, and
                is built in a later phase.
              </>
            )}
          </p>
        </Card>

        <MembershipHistory events={history} />
      </section>

      {/* --- Terms ------------------------------------------------------- */}
      <section aria-labelledby="membership-terms-heading" className="min-w-0 space-y-3">
        <h2 id="membership-terms-heading" className="text-text text-lg font-semibold">
          Terms
        </h2>
        <p className="text-text-muted text-sm">
          The policy version this member was enrolled under. Its figures are frozen:
          changing the programme publishes a new version and cannot vary what this member
          was promised.
        </p>

        {policy === null ? (
          <Card>
            <p className="text-text-muted text-sm">
              The policy version governing this membership could not be read.
            </p>
          </Card>
        ) : (
          <MembershipPolicyPanel policy={policy} />
        )}
      </section>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
