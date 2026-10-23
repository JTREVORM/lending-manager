import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { ROUTES } from '@/config/app';
import type { MembershipSummary } from '@/lib/data/membership';
import { MembershipStatusBadge } from './membership-status-badge';

/**
 * Whether this client is a member, on the client record.
 *
 * ## A non-member is not a problem
 *
 * The most important thing this panel does is say "not a member" in a tone
 * that reads as a fact rather than as something missing. Most clients of this
 * business will never join the programme, and they remain perfectly valid
 * clients — the brief is explicit about that, and a panel that showed an
 * empty state with a call to action would quietly reframe non-membership as
 * an omission to be corrected.
 *
 * ## Usually one row, sometimes more
 *
 * The schema allows a client to hold one *live* membership and any number of
 * ended ones — somebody who withdrew in 2026 and rejoined in 2028 has two,
 * with different numbers, because the savings qualification clock restarts.
 * So this renders a list rather than a single record, and does not collapse
 * the history into "member: yes".
 */
export function ClientMembershipPanel({
  memberships,
}: {
  readonly memberships: readonly MembershipSummary[];
}) {
  if (memberships.length === 0) {
    return (
      <Card>
        <p className="text-text text-sm">
          This client is not a member of the savings and benefits programme.
        </p>
        <p className="text-text-muted mt-1 text-[13px]">
          Membership is optional. A non-member borrows on the ordinary product terms and
          nothing about their client record depends on it.
        </p>
      </Card>
    );
  }

  return (
    <DataTable caption="Memberships held by this client, newest first">
      <thead>
        <tr>
          <TableHead width="ref">Membership number</TableHead>
          <TableHead width="date">Applied</TableHead>
          <TableHead width="date">Joined</TableHead>
          <TableHead width="date" hideBelow="lg">
            Ended
          </TableHead>
          <TableHead width="status">Status</TableHead>
        </tr>
      </thead>
      <tbody>
        {memberships.map((membership) => (
          <TableRow key={membership.id} interactive>
            <TableCell width="ref" className="font-mono">
              <Link
                href={`${ROUTES.membership}/${membership.id}`}
                className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {membership.membershipNumber}
              </Link>
            </TableCell>
            <TableCell width="date" className="text-text-muted">
              <DateValue value={membership.appliedOn} />
            </TableCell>
            <TableCell width="date" className="text-text-muted">
              <DateValue value={membership.activatedOn} />
            </TableCell>
            <TableCell width="date" hideBelow="lg" className="text-text-muted">
              <DateValue value={membership.endedOn} />
            </TableCell>
            <TableCell width="status">
              <MembershipStatusBadge status={membership.status} />
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </DataTable>
  );
}
