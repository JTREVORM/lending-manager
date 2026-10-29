import Link from 'next/link';
import { BadgeCheck } from 'lucide-react';

import { MembershipPolicyPanel } from '@/components/membership/membership-policy-panel';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listMembershipPolicies } from '@/lib/data/membership';
import { MEMBERSHIP_POLICY_STATUS_LABELS } from '@/lib/domain/membership';

export const metadata = { title: 'Membership policy' };

/**
 * The membership configuration, read-only.
 *
 * ## Why `membership:view` and not `membership:manage_policies`
 *
 * Reading the registration fee and the savings minimum is ordinary counter
 * work — a Secretary/Treasurer has to be able to answer "what does it cost
 * to join". Changing them is the Owner's, and the page offers no control
 * that would try: `membership:manage_policies` gates the write at the
 * database, and Polytos Phase 2 gives that write a screen.
 *
 * The holder of `membership:manage_policies` is told, in one line, that the
 * editing surface is coming — because the person who can answer the
 * outstanding questions is usually the person reading this, and they should
 * know the system is waiting on them rather than broken.
 *
 * ## Every version, not only the current one
 *
 * A member is held to the version they were enrolled under, so a superseded
 * version is not history to be hidden — it is the terms somebody is still
 * living under. The list shows all of them, newest effective date first,
 * with the one in force expanded.
 */
export default async function MembershipPoliciesPage() {
  const context = await guardPermission(ROUTES.membershipPolicies, 'membership:view');

  const policies = await listMembershipPolicies();
  const current = policies.find((policy) => policy.status === 'active') ?? policies[0];
  const others = policies.filter((policy) => policy.id !== current?.id);

  const canManage = contextCan(context, 'membership_policy:manage');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Policy"
        icon={BadgeCheck}
        back={{ href: ROUTES.membership, label: 'Membership' }}
        title="Membership policy"
        description="The registration fee, savings rules, lending terms and benefit amounts of the Polytos membership programme, as effective-dated versions."
      />

      {canManage ? (
        <Alert tone="info" title="Policy timing and controlled transitions">
          <Link className="underline" href="/membership/policies/transitions">Open policy transition management</Link>
          {' '}to preview qualification changes, record authorized draft timing and manage verified member transitions.
        </Alert>
      ) : null}

      {current === undefined ? (
        <EmptyState
          title="No membership policy has been published"
          description="Until a version exists and is approved, no member can be enrolled and no membership money can be recorded."
        />
      ) : (
        <section aria-labelledby="current-policy-heading" className="min-w-0 space-y-3">
          <h2 id="current-policy-heading" className="text-text text-lg font-semibold">
            {current.status === 'active' ? 'In force' : 'Latest version'}
          </h2>

          <MembershipPolicyPanel policy={current} />
        </section>
      )}

      {others.length === 0 ? null : (
        <section
          aria-labelledby="previous-policies-heading"
          className="min-w-0 space-y-3"
        >
          <h2 id="previous-policies-heading" className="text-text text-lg font-semibold">
            Other versions
          </h2>
          <p className="text-text-muted text-sm">
            A member is held to the version they were enrolled under, so a superseded
            version is still somebody&rsquo;s terms.
          </p>

          <div className="space-y-3">
            {others.map((policy) => (
              <Card key={policy.id}>
                <CardHeader
                  as="h3"
                  title={`Version ${policy.version} — ${policy.title}`}
                  description={
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge tone="neutral">
                        {MEMBERSHIP_POLICY_STATUS_LABELS[policy.status]}
                      </Badge>
                      <span>
                        {policy.effectiveFrom === null ? 'Activation date awaiting authorization' : <>Effective from <DateValue value={policy.effectiveFrom} /></>}
                      </span>
                    </span>
                  }
                />
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
