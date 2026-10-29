import { ArrowRightLeft } from 'lucide-react';
import Link from 'next/link';
import { z } from 'zod';

import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { PolicyAmount } from '@/components/policy-update/amount';
import { OperationForm } from '@/components/policy-update/operation-form';
import { guardPermission } from '@/lib/auth/guard';
import { mapDatabaseError } from '@/lib/db-errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Policy transitions' };

export default async function PolicyTransitionsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(
    '/membership/policies/transitions',
    'membership_policy:manage',
  );
  const params = await searchParams;
  const db = await createSupabaseServerClient();
  const [policies, batches, witnesses] = await Promise.all([
    db
      .from('membership_policy_versions')
      .select('id, version, title, status, approved_at, effective_from')
      .order('created_at', { ascending: false })
      .limit(50),
    db
      .from('membership_policy_transitions')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(25),
    db
      .from('profiles')
      .select('id, full_name')
      .eq('status', 'active')
      .neq('id', context.profileId)
      .order('full_name')
      .limit(100),
  ]);
  if (policies.error) throw mapDatabaseError(policies.error);
  if (batches.error) throw mapDatabaseError(batches.error);
  if (witnesses.error) throw mapDatabaseError(witnesses.error);
  const target = z.uuid().safeParse(params.target);
  const date = z.iso.date().safeParse(params.date);
  const selected = target.success
    ? policies.data?.find((p) => p.id === target.data)
    : undefined;
  const preview =
    target.success && date.success
      ? await db.rpc('preview_membership_policy_transition', {
          p_to_version_id: target.data,
          p_effective_on: date.data,
        })
      : null;
  if (preview?.error) throw mapDatabaseError(preview.error);
  const ready = Boolean(
    selected?.status === 'active' &&
    selected.approved_at &&
    selected.effective_from &&
    date.success &&
    selected.effective_from <= date.data,
  );
  const batch = batches.data?.find(
    (b) =>
      b.to_version_id === selected?.id && ['previewed', 'in_progress'].includes(b.status),
  );
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        icon={ArrowRightLeft}
        eyebrow="Membership Policy"
        title="Policy transitions"
        description="Preview changes, record verified acceptance, and apply dated assignments without rewriting financial history."
        back={{ href: '/membership/policies', label: 'Membership policies' }}
      />
      <Alert tone="info" title="Activation timing is an authorized decision">
        The official policy remains a draft until separately approved. A recorded date
        does not activate it or move a member. Profit sharing remains outside this update.
      </Alert>
      <Card>
        <h2 className="font-semibold">Record an authorized draft date</h2>
        <p>Use the date and authorization reference already agreed by management.</p>
        {(policies.data ?? [])
          .filter((p) => p.status === 'draft' && !p.approved_at)
          .map((p) => (
            <div key={p.id} className="mt-4 space-y-2">
              <h3 className="font-medium">
                Version {p.version}: {p.title}
              </h3>
              <p>
                {p.effective_from ? (
                  <>
                    Recorded date: <DateValue value={p.effective_from} />
                  </>
                ) : (
                  'Activation date awaiting authorization.'
                )}
              </p>
              <OperationForm
                operation="record_timing"
                values={{ policyId: p.id }}
                label="Record authorized date"
                fields={[
                  {
                    name: 'effectiveDate',
                    label: `Authorized effective date for version ${p.version}`,
                    type: 'date',
                    required: true,
                  },
                  {
                    name: 'reference',
                    label: `Authorization reference for version ${p.version}`,
                    required: true,
                  },
                ]}
              />
            </div>
          ))}
      </Card>
      <Card>
        <h2 className="mb-3 font-semibold">Preview a proposed transition</h2>
        <form method="get" className="space-y-3">
          <label className="block">
            Target policy
            <select
              name="target"
              required
              defaultValue={selected?.id ?? ''}
              className="border-border mt-1 block w-full rounded border p-2"
            >
              <option value="">Choose a policy…</option>
              {(policies.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  Version {p.version} · {p.status}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Proposed transition date
            <input
              name="date"
              type="date"
              required
              defaultValue={date.success ? date.data : ''}
              className="border-border mt-1 block w-full rounded border p-2"
            />
          </label>
          <button type="submit" className="text-accent underline">
            Preview transition
          </button>
        </form>
        {selected && preview ? (
          <div className="mt-4 space-y-4">
            <p>
              Target version {selected.version}.{' '}
              {ready
                ? 'Approved target; verified acceptance is required for every member.'
                : 'Preview only: this target is not approved and effective for the selected date.'}
            </p>
            {!batch && ready && date.success ? (
              <OperationForm
                operation="begin_transition"
                values={{ policyId: selected.id, effectiveDate: date.data }}
                label="Open controlled transition batch"
                fields={[
                  {
                    name: 'note',
                    label: 'Transition authorization and scope',
                    required: true,
                  },
                ]}
              />
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Policy transition preview and qualification impact
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Member</th>
                    <th scope="col">Current policy</th>
                    <th scope="col">Savings balance</th>
                    <th scope="col">Qualified before</th>
                    <th scope="col">Qualified after</th>
                    <th scope="col">Verified acceptance</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.data ?? []).map((m) => (
                    <tr key={m.membership_id}>
                      <th scope="row">
                        <Link
                          className="text-accent underline"
                          href={`/membership/${m.membership_id}`}
                        >
                          {m.membership_number} · {m.member_name}
                        </Link>
                      </th>
                      <td>{m.current_version}</td>
                      <td>
                        <PolicyAmount value={m.savings_balance} />
                      </td>
                      <td>{m.qualifies_before ? 'Yes' : 'No'}</td>
                      <td>{m.qualifies_after ? 'Yes' : 'No'}</td>
                      <td>{m.has_acceptance ? 'Recorded' : 'Required'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {ready
              ? (preview.data ?? [])
                  .filter((m) => !m.already_transitioned)
                  .map((m) => (
                    <details
                      key={m.membership_id}
                      className="border-border rounded border p-3"
                    >
                      <summary>{m.membership_number}: acceptance and transition</summary>
                      <p className="my-3">{m.advisory}</p>
                      {!m.has_acceptance && m.membership_id ? (
                        <OperationForm
                          operation="record_consent"
                          values={{
                            policyId: selected.id,
                            membershipId: m.membership_id,
                          }}
                          label="Record witnessed acceptance"
                          fields={[
                            {
                              name: 'signatureName',
                              label: 'Member name on the accepted terms',
                              required: true,
                            },
                            {
                              name: 'witnessId',
                              label: 'Witnessing member of staff',
                              required: true,
                              options: (witnesses.data ?? []).map((w) => ({
                                value: w.id,
                                label: w.full_name,
                              })),
                            },
                            { name: 'place', label: 'Place of acceptance' },
                          ]}
                        />
                      ) : null}
                      {batch && m.membership_id ? (
                        <div className="mt-3">
                          <OperationForm
                            operation="transition_member"
                            values={{
                              transitionId: batch.id,
                              membershipId: m.membership_id,
                            }}
                            disabled={!m.has_acceptance}
                            label="Apply this member's verified transition"
                          />
                        </div>
                      ) : null}
                    </details>
                  ))
              : null}
          </div>
        ) : null}
      </Card>
      <Card>
        <h2 className="font-semibold">Transition batches</h2>
        <ul className="mt-3 divide-y">
          {(batches.data ?? []).map((b) => (
            <li key={b.id} className="space-y-2 py-3">
              <p>
                {b.transition_number} · Version {b.to_version} · {b.status} ·{' '}
                {b.transitioned_count} memberships processed
              </p>
              <p>
                Effective <DateValue value={b.effective_on} />. Requested by{' '}
                {b.requested_by_label}. {b.note}
              </p>
              {['previewed', 'in_progress'].includes(b.status) ? (
                <>
                  <Link
                    className="text-accent underline"
                    href={`?target=${b.to_version_id}&date=${b.effective_on}`}
                  >
                    Resume this batch
                  </Link>
                  <OperationForm
                    operation="complete_transition"
                    values={{ transitionId: b.id }}
                    label="Close this transition batch"
                  />
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
