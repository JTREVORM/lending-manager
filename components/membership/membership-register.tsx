'use client';

import { BadgeCheck, SearchX } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { MEMBERSHIP_STATUSES, MEMBERSHIP_STATUS_LABELS } from '@/lib/domain/membership';
import type { MembershipPage } from '@/lib/data/membership';
import { MembershipStatusBadge } from './membership-status-badge';

/**
 * The membership register.
 *
 * Built on the same three pieces every other register in this system uses —
 * `RegisterFilters`, `DataTable` and `RegisterPagination` — so that a person
 * who can read the client register can read this one without learning
 * anything. Filters live in the URL rather than in component state, which is
 * what makes a filtered view reloadable and, more importantly, makes the
 * filtering happen in the database: Row Level Security applies to the
 * filtered query rather than to a full list trimmed in the browser.
 *
 * Cards on a phone, a table from `md` up. A table at 390px either scrolls
 * sideways or crushes its columns, and neither is usable one-handed by
 * somebody standing at a counter.
 *
 * ## The empty state is honest, and it offers nothing
 *
 * No member has been enrolled, because enrolment is Polytos Phase 2. So the
 * empty state says that, and — unlike the client register's, which offers
 * "Register a client" — it offers no action at all. A button leading to a
 * form that cannot complete would be a worse lie than an empty table.
 */
export function MembershipRegister({
  page,
  filter,
}: {
  readonly page: MembershipPage;
  readonly filter: { readonly query: string; readonly status: string };
}) {
  const filtered = filter.query !== '' || filter.status !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'membership-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Member name, membership number or client number',
        }}
        selects={[
          {
            id: 'membership-status',
            label: 'Status',
            param: 'status',
            value: filter.status,
            options: [
              { value: '', label: 'All memberships' },
              ...MEMBERSHIP_STATUSES.map((status) => ({
                value: status,
                label: MEMBERSHIP_STATUS_LABELS[status],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.memberships.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="membership"
          />
        }
      />

      {page.memberships.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : BadgeCheck}
          title={
            filtered
              ? 'No memberships match this search'
              : 'No members have been enrolled yet'
          }
          description={
            filtered
              ? 'Try a shorter search, or clear the status filter.'
              : 'Enrolment opens once the membership policy has been approved. Until then this register is empty, and no savings, fees or benefits can be recorded.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.memberships.map((membership) => (
              <li key={membership.id}>
                <RowLink
                  href={`${ROUTES.membership}/${membership.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {membership.fullName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {membership.membershipNumber}
                      </p>
                    </div>
                    <MembershipStatusBadge status={membership.status} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Client number</dt>
                      <dd className="text-text font-mono">{membership.clientNumber}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Phone</dt>
                      <dd className="text-text">
                        <PhoneValue value={membership.phone} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Applied</dt>
                      <dd className="text-text">
                        <DateValue value={membership.appliedOn} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Joined</dt>
                      <dd className="text-text">
                        <DateValue value={membership.activatedOn} />
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Membership register, newest application first">
              <thead>
                <tr>
                  <TableHead width="ref">Membership number</TableHead>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="phone" hideBelow="lg">
                    Phone
                  </TableHead>
                  <TableHead width="place" hideBelow="xl">
                    Branch
                  </TableHead>
                  <TableHead width="date" hideBelow="lg">
                    Applied
                  </TableHead>
                  <TableHead width="date">Joined</TableHead>
                  <TableHead width="status">Status</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.memberships.map((membership) => (
                  <TableRow key={membership.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.membership}/${membership.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {membership.membershipNumber}
                      </RowLink>
                    </TableCell>
                    {/* The member's name over their client number: the pair
                        that says which person this is, in the shared shape
                        every other register uses for it. */}
                    <TableCell width="name-wide" wrap="wrap">
                      <TableLead
                        primary={membership.fullName}
                        secondary={membership.clientNumber}
                      />
                    </TableCell>
                    <TableCell width="phone" hideBelow="lg" className="text-text-muted">
                      <PhoneValue value={membership.phone} />
                    </TableCell>
                    <TableCell
                      width="place"
                      wrap="clamp"
                      hideBelow="xl"
                      title={membership.branchName ?? undefined}
                      className="text-text-muted"
                    >
                      {membership.branchName ?? '—'}
                    </TableCell>
                    <TableCell width="date" hideBelow="lg" className="text-text-muted">
                      <DateValue value={membership.appliedOn} />
                    </TableCell>
                    <TableCell width="date" className="text-text-muted">
                      <DateValue value={membership.activatedOn} />
                    </TableCell>
                    <TableCell width="status">
                      <MembershipStatusBadge status={membership.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}

      <RegisterPagination page={page.page} hasMore={page.hasMore} />
    </div>
  );
}
