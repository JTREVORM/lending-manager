'use client';

import { SearchX, Users } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Money } from '@/components/ui/money';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import type { MemberEligibilityPage } from '@/lib/data/member-loans';

/**
 * Who qualifies, and what their savings support.
 *
 * The same three pieces every register here uses — `RegisterFilters`,
 * `DataTable`, `RegisterPagination` — so somebody who can read the savings
 * register can read this one without learning anything. Filters live in the
 * URL, which makes a filtered view reloadable and, more importantly, makes
 * the filtering happen in the database: Row Level Security applies to the
 * filtered query rather than to a full list trimmed in the browser.
 *
 * Cards on a phone, a table from `md` up — a table at 390px either scrolls
 * sideways or crushes its columns, and neither is usable one-handed.
 *
 * ## The ceiling column reads "not yet decided", not a dash
 *
 * A dash would be indistinguishable from "zero" and from "we did not look".
 * The multiplier is undecided, so the honest cell says so — and a reader who
 * sees it on every row learns the right thing about the programme rather than
 * the wrong thing about the member.
 *
 * ## Qualifying months lead on a phone, not the balance
 *
 * The question this screen is opened with is "who can borrow yet", and the
 * answer is a count of months rather than a balance. The savings register
 * leads with the balance, because it is opened with the other question.
 */
export function MemberEligibilityRegister({
  page,
  filter,
  canApply,
}: {
  readonly page: MemberEligibilityPage;
  readonly filter: {
    readonly query: string;
    readonly qualified: string;
    readonly sort: string;
  };
  readonly canApply: boolean;
}) {
  const filtered = filter.query !== '' || filter.qualified !== 'all';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'eligibility-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Member name, membership number or client number',
        }}
        selects={[
          {
            id: 'eligibility-qualified',
            label: 'Qualification',
            param: 'qualified',
            value: filter.qualified,
            options: [
              { value: 'all', label: 'All members' },
              { value: 'qualified', label: 'Qualified on savings' },
              { value: 'not_qualified', label: 'Not yet qualified' },
            ],
          },
          {
            id: 'eligibility-sort',
            label: 'Order',
            param: 'sort',
            value: filter.sort,
            options: [
              { value: 'savings', label: 'Largest savings first' },
              { value: 'months', label: 'Most months served first' },
              { value: 'name', label: 'Member name' },
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.rows.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="member"
          />
        }
      />

      {page.rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : Users}
          title={filtered ? 'No member matches this search' : 'No live memberships yet'}
          description={
            filtered
              ? 'Try a shorter search, or clear the qualification filter.'
              : 'Member loan eligibility is assessed against a live membership and its savings account. Enrol a member from the membership register to start the qualifying clock.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.rows.map((row) => (
              <li key={row.membershipId}>
                <RowLink
                  href={`${ROUTES.membership}/${row.membershipId}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">{row.fullName}</p>
                      <p className="text-text-muted font-mono text-xs">
                        {row.membershipNumber}
                      </p>
                    </div>
                    <QualificationBadge row={row} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Months served</dt>
                      <dd className="text-text tabular-nums">
                        {row.qualifyingMonths} of {row.monthsRequired}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Savings balance</dt>
                      <dd>
                        <Money amount={row.eligibleSavings} variant="bare" />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Available</dt>
                      <dd>
                        <Money amount={row.availableSavings} variant="bare" />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Maximum loan</dt>
                      <dd>
                        <Ceiling row={row} />
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and desktop: a table. */}
          <div className="hidden md:block">
            <DataTable caption="Members, their qualifying months and what their savings support">
              <thead>
                <tr>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="status">Qualification</TableHead>
                  <TableHead width="count" align="numeric">
                    Months
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Savings
                  </TableHead>
                  <TableHead width="money" align="numeric" hideBelow="xl">
                    Pledged
                  </TableHead>
                  <TableHead width="money" align="numeric" hideBelow="lg">
                    Available
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Maximum loan
                  </TableHead>
                  <TableHead width="count" align="numeric" hideBelow="lg">
                    Loans
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <TableRow key={row.membershipId} interactive>
                    <TableCell width="name-wide">
                      <RowLink
                        href={`${ROUTES.membership}/${row.membershipId}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        <TableLead
                          primary={row.fullName}
                          secondary={row.membershipNumber}
                        />
                      </RowLink>
                    </TableCell>
                    <TableCell width="status">
                      <QualificationBadge row={row} />
                    </TableCell>
                    <TableCell width="count" align="numeric">
                      {row.qualifyingMonths} / {row.monthsRequired}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={row.eligibleSavings} variant="bare" />
                    </TableCell>
                    <TableCell width="money" align="numeric" hideBelow="xl">
                      <Money amount={row.pledgedSavings} variant="bare" />
                    </TableCell>
                    <TableCell width="money" align="numeric" hideBelow="lg">
                      <Money amount={row.availableSavings} variant="bare" />
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Ceiling row={row} />
                    </TableCell>
                    <TableCell width="count" align="numeric" hideBelow="lg">
                      {row.activeLoanCount} / {row.activeLoanLimit}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>

          <RegisterPagination page={page.page} hasMore={page.hasMore} />
        </>
      )}

      {canApply ? null : (
        <p className="text-text-muted text-xs">
          Opening a member loan application needs its own capability, because it commits
          the business to lending against member savings. This register is read-only for
          you.
        </p>
      )}
    </div>
  );
}

function QualificationBadge({
  row,
}: {
  readonly row: MemberEligibilityPage['rows'][number];
}) {
  if (row.membershipStatus !== 'active') {
    return <Badge tone="warning">{row.membershipStatus}</Badge>;
  }

  if (!row.savingsMonthsMet) {
    return <Badge tone="neutral">Still saving</Badge>;
  }

  if (row.activeLoanCount >= row.activeLoanLimit) {
    return <Badge tone="warning">At the loan limit</Badge>;
  }

  if (!row.policyLendingOpen) {
    return <Badge tone="neutral">Policy not open</Badge>;
  }

  return <Badge tone="success">Qualified</Badge>;
}

/**
 * The ceiling, or the reason there is not one.
 *
 * `Money` with a placeholder would render a dash, which reads as zero. The
 * multiplier being undecided is a fact about the programme and worth saying in
 * words on every row it applies to.
 */
function Ceiling({ row }: { readonly row: MemberEligibilityPage['rows'][number] }) {
  if (row.maxEligibleLoan === null) {
    return <span className="text-text-muted text-xs">Multiplier not&nbsp;decided</span>;
  }

  return <Money amount={row.maxEligibleLoan} variant="bare" weight="medium" />;
}
