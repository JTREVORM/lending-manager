'use client';

import { HandCoins, SearchX } from 'lucide-react';

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
import { LOAN_STATUS_LABELS, type LoanStatus } from '@/lib/domain/loan';
import type { MemberLoanPage, MemberLoanRow } from '@/lib/data/member-loans';

/**
 * Member loans, with the membership beside each one.
 *
 * ## Why a member loan opens at `/loans/{id}` and not here
 *
 * Because it is a loan. The existing loan detail screen already carries the
 * approved terms, the repayment schedule, the payment history, the approval
 * trail and the arrears position, and a second detail screen would be a
 * second set of controls over one agreement — the thing this whole phase is
 * built to avoid. What the member loan adds is a panel on that screen, not a
 * screen of its own.
 *
 * So every row here links into the loan module, and the columns are the ones
 * that are *about the membership*: which member, which policy version, what
 * savings secure it. The rest of the loan is one tap away in the place it has
 * always been.
 *
 * ## Why the membership number and the pledge drop below `2xl`
 *
 * Nine columns do not fit the counter laptop. At 1440px the rail takes 256 of
 * it, and the status badge was clipped at the table's right edge — the column
 * was there, and the word in it was not readable without scrolling the table
 * sideways, which is the worst of both.
 *
 * The two that go are the two a reader can get elsewhere in one tap: the
 * membership number is on the loan's own screen beside everything else frozen
 * at approval, and the pledge is there too. What stays is what this register
 * is *for* — which loan, whose, how much, how long, how it is collected, what
 * is left, and what state it is in. Found by photographing the screen at the
 * width it is used at, not by reading the component.
 */
export function MemberLoanRegister({
  page,
  filter,
}: {
  readonly page: MemberLoanPage;
  readonly filter: { readonly query: string; readonly status: string };
}) {
  const filtered = filter.query !== '' || filter.status !== 'all';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'member-loan-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Loan number, member name or membership number',
        }}
        selects={[
          {
            id: 'member-loan-status',
            label: 'Status',
            param: 'status',
            value: filter.status,
            options: [
              { value: 'all', label: 'All member loans' },
              { value: 'approved', label: 'Approved, not paid out' },
              { value: 'active', label: 'Active' },
              { value: 'cleared', label: 'Cleared' },
              { value: 'cancelled', label: 'Cancelled' },
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.rows.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="member loan"
          />
        }
      />

      {page.rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : HandCoins}
          title={filtered ? 'No member loan matches this search' : 'No member loan yet'}
          description={
            filtered
              ? 'Try a shorter search, or clear the status filter.'
              : 'A member loan appears here once it is approved — approval is what freezes the membership onto the loan. Applications still waiting are counted above and listed in the loan register.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.rows.map((row) => (
              <li key={row.loanId}>
                <RowLink
                  href={`${ROUTES.loans}/${row.loanId}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-mono font-medium">{row.loanNumber}</p>
                      <p className="text-text-muted text-xs break-words">
                        {row.fullName}
                      </p>
                    </div>
                    <StatusBadge status={row.status} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Principal</dt>
                      <dd>
                        <Money amount={row.principalAmount} variant="bare" />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Outstanding</dt>
                      <dd>
                        <Money amount={row.totalOutstanding} variant="bare" />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Term and cadence</dt>
                      <dd className="text-text">
                        {row.loanTermMonths} months, {row.repaymentFrequency}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted text-xs">Savings pledged</dt>
                      <dd>
                        <Money amount={row.pledgedAmount} variant="bare" />
                      </dd>
                    </div>
                  </dl>

                  {row.arrearsAmount !== null && row.arrearsAmount > 0 ? (
                    <p className="text-danger mt-2 text-xs">
                      <Money amount={row.arrearsAmount} /> in arrears,{' '}
                      {row.daysPastDue ?? 0} days past due
                    </p>
                  ) : null}
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and desktop: a table. */}
          <div className="hidden md:block">
            <DataTable caption="Member loans, newest first">
              <thead>
                <tr>
                  <TableHead width="ref">Loan</TableHead>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="ref" hideBelow="2xl">
                    Membership
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Principal
                  </TableHead>
                  <TableHead width="count" align="numeric" hideBelow="lg">
                    Term
                  </TableHead>
                  <TableHead width="status" hideBelow="lg">
                    Cadence
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Outstanding
                  </TableHead>
                  <TableHead width="money" align="numeric" hideBelow="2xl">
                    Pledged
                  </TableHead>
                  <TableHead width="status">Status</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <TableRow key={row.loanId} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.loans}/${row.loanId}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {row.loanNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="name-wide">
                      <TableLead primary={row.fullName} secondary={row.clientNumber} />
                    </TableCell>
                    <TableCell width="ref" className="font-mono" hideBelow="2xl">
                      {row.membershipNumber ?? '—'}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={row.principalAmount} variant="bare" />
                    </TableCell>
                    <TableCell width="count" align="numeric" hideBelow="lg">
                      {row.loanTermMonths}
                    </TableCell>
                    <TableCell width="status" hideBelow="lg">
                      {row.repaymentFrequency}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={row.totalOutstanding} variant="bare" />
                    </TableCell>
                    <TableCell width="money" align="numeric" hideBelow="2xl">
                      <Money amount={row.pledgedAmount} variant="bare" />
                    </TableCell>
                    <TableCell width="status">
                      <StatusBadge status={row.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>

          <RegisterPagination page={page.page} hasMore={page.hasMore} />
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  const tone =
    status === 'active'
      ? 'success'
      : status === 'approved'
        ? 'info'
        : status === 'cleared'
          ? 'neutral'
          : status === 'cancelled'
            ? 'warning'
            : 'neutral';

  const label = LOAN_STATUS_LABELS[status as LoanStatus] ?? status;

  return <Badge tone={tone}>{label}</Badge>;
}

export type { MemberLoanRow };
