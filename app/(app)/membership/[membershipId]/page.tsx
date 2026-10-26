import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MemberLoanEligibilityPanel } from '@/components/member-loans/eligibility-panel';
import { MembershipCardPanel } from '@/components/membership/membership-card-panel';
import { MembershipHistory } from '@/components/membership/membership-history';
import { MembershipMoneyPanel } from '@/components/membership/membership-money-panel';
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
  getMembershipFeeReceipt,
  getSavingsAccountForMembership,
  listMembershipCards,
  listMembershipConsent,
} from '@/lib/data/savings';
import {
  assessMemberLoanEligibility,
  getMemberLendingState,
} from '@/lib/data/member-loans';
import {
  MEMBERSHIP_ACTIVITY_LABELS,
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
 * ## What this page can now do, and what it still cannot
 *
 * Polytos Phase 2 added the fee, the consent evidence, the savings account
 * and the card, so each is shown and the card can be issued from here.
 *
 * What is still absent is a status control: suspending or withdrawing a
 * membership is a lifecycle write whose screen belongs to a later phase, so
 * the page states **what the lifecycle permits next** as a sentence rather
 * than as buttons. A reader planning the work can see where this membership
 * can go without being offered a control that would fail.
 *
 * Benefit claims and the year-end profit share are likewise absent, and the
 * rules behind both are among the questions the client has not answered.
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

  const [history, policy, receipt, consent, savingsAccount, cards, eligibility, lending] =
    await Promise.all([
      listMembershipHistory(membership.id),
      getMembershipPolicy(membership.policyVersionId),
      // Each of these comes back empty or null for a caller the policies refuse,
      // so an absence on this page is a database decision rather than a
      // conditional written here.
      getMembershipFeeReceipt(membership.id),
      listMembershipConsent(membership.id),
      getSavingsAccountForMembership(membership.id),
      listMembershipCards(membership.id),
      // Polytos Phase 3. Null for a caller without
      // `member_loans:view_eligibility`, which is its own capability because an
      // assessment is a lending offer rather than a view of savings — so the
      // panel is absent for a reader entitled to the rest of this page.
      assessMemberLoanEligibility(membership.clientId),
      getMemberLendingState(),
    ]);

  const canSeeClient = contextCan(context, 'clients:view');
  const next = membershipTransitionsFrom(membership.status);

  // What the version *this member is held to* opens — not the programme in
  // general. A member on a superseded version is authorised for nothing, and
  // saying so here is more honest than a single "financially enabled" flag
  // that collapses five different activities into one word.
  const authorised = (
    [
      [membership.policyEnrolmentEnabled, MEMBERSHIP_ACTIVITY_LABELS.enrolment],
      [membership.policySavingsEnabled, MEMBERSHIP_ACTIVITY_LABELS.savings],
      [membership.policyMemberLendingEnabled, MEMBERSHIP_ACTIVITY_LABELS.lending],
      [membership.policyBenefitsEnabled, MEMBERSHIP_ACTIVITY_LABELS.benefits],
      [membership.policyProfitSharingEnabled, MEMBERSHIP_ACTIVITY_LABELS.profit_sharing],
    ] as const
  )
    .filter(([open]) => open)
    .map(([, label]) => label);

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
          { id: 'membership-money-heading', label: 'Fee and savings' },
          { id: 'membership-lending-heading', label: 'Member loan' },
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
            <Detail label="Those terms authorise">
              {authorised.length === 0 ? (
                <span className="text-warning font-medium">
                  Nothing yet — the version is not approved and in force
                </span>
              ) : (
                authorised.map((label) => label).join(', ')
              )}
            </Detail>

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

      {/* --- The fee, the acceptance and the savings --------------------- */}
      <section aria-labelledby="membership-money-heading" className="min-w-0 space-y-3">
        <h2 id="membership-money-heading" className="text-text text-lg font-semibold">
          Fee, acceptance and savings
        </h2>

        <MembershipMoneyPanel
          receipt={receipt}
          consent={consent}
          savingsAccount={savingsAccount}
          policyVersion={membership.policyVersion}
          membershipStatus={membership.status}
          registrationFee={policy?.registrationFee ?? 0}
        />

        <MembershipCardPanel
          membershipId={membership.id}
          membershipStatus={membership.status}
          cards={cards}
          canIssue={contextCan(context, 'membership:update')}
        />

        <Card>
          <p className="text-text-muted text-[13px]">
            Benefit claims and the year-end profit share are not recorded here. The
            medical benefit&rsquo;s annual cap, how many claims a year it allows, any
            waiting period and the profit distribution formula are all still to be
            decided, and this system records nothing against a rule nobody has approved.
          </p>
        </Card>
      </section>

      {/* --- Polytos Phase 3: may this member borrow ------------------ */}
      <section aria-labelledby="membership-lending-heading" className="min-w-0 space-y-3">
        <h2 id="membership-lending-heading" className="text-text text-lg font-semibold">
          Member loan eligibility
        </h2>

        <MemberLoanEligibilityPanel
          eligibility={eligibility}
          lending={lending}
          canApply={contextCan(context, 'member_loans:create')}
        />
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
