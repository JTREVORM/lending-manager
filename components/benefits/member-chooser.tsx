'use client';

import { SearchX, Users } from 'lucide-react';

import { RegisterFilters } from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import type { MembershipSummary } from '@/lib/data/membership';

/**
 * Choosing which member a claim or a beneficiary record is for.
 *
 * A search box and a list, rather than a `<select>` of every member. A select
 * is unusable past a few dozen options on a phone, and this system is built
 * for a membership that grows — the client register already made this choice,
 * and copying it means staff search for a member the same way everywhere.
 *
 * ## Why it lists live memberships only
 *
 * A claim is opened against a membership, and the claim's own rules read the
 * membership's status. Listing ended memberships would offer a choice that
 * `open_benefit_claim` refuses, and a bereavement claim is opened against the
 * membership of somebody who has died — which is `active` or `suspended` at
 * the moment the claim is made, never `ended`, because ending it is what the
 * claim leads to.
 *
 * The search is the page's own `q` parameter, so the chosen member lands in
 * the URL and the back button works through the whole flow.
 */
export function MemberChooser({
  memberships,
  query,
  hrefFor,
  heading,
  description,
}: {
  readonly memberships: readonly MembershipSummary[];
  readonly query: string;
  /** Where picking this membership goes. */
  readonly hrefFor: (membership: MembershipSummary) => string;
  readonly heading: string;
  readonly description: string;
}) {
  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h2 className="text-text text-sm font-semibold">{heading}</h2>
        <p className="text-text-muted mt-1 text-sm">{description}</p>
      </div>

      <RegisterFilters
        search={{
          id: 'member-chooser-search',
          label: 'Find the member',
          param: 'q',
          value: query,
          placeholder: 'Membership number, member name or client number',
        }}
      />

      {memberships.length === 0 ? (
        <EmptyState
          icon={query === '' ? Users : SearchX}
          title={query === '' ? 'No live memberships yet' : 'No member matches that'}
          description={
            query === ''
              ? 'A claim is opened against a live membership. Enrol the member first.'
              : 'Try the membership number, or a shorter part of the name.'
          }
        />
      ) : (
        <ul className="space-y-2">
          {memberships.map((membership) => (
            <li key={membership.id}>
              <RowLink
                href={hrefFor(membership)}
                className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-text font-medium break-words">
                      {membership.fullName}
                    </p>
                    <p className="text-text-muted font-mono text-sm">
                      {membership.membershipNumber} · {membership.clientNumber}
                    </p>
                  </div>
                  <p className="text-text-muted shrink-0 text-right text-xs">
                    {membership.branchName ?? 'No branch'}
                    <span className="block">{membership.district}</span>
                  </p>
                </div>
              </RowLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
