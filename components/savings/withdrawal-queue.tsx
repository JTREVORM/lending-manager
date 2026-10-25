'use client';

import { Banknote, SearchX } from 'lucide-react';

import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { WITHDRAWAL_STATUSES, WITHDRAWAL_STATUS_LABELS } from '@/lib/domain/savings';
import type { WithdrawalPage } from '@/lib/data/savings';
import { WithdrawalStatusBadge } from './savings-badges';

/**
 * The withdrawal queue: a Manager's list of decisions.
 *
 * Opens on `pending` rather than on everything, because this screen exists to
 * be worked through. A queue that opened on the full history would make the
 * common case — "what is waiting for me" — the one that needs a filter
 * applied first.
 *
 * ## The empty state is good news
 *
 * An empty pending queue means nothing is waiting, which is a finished day
 * rather than a missing feature. So the empty state says that, and offers no
 * action: there is nothing a Manager should do about it.
 */
export function WithdrawalQueue({
  page,
  filter,
}: {
  readonly page: WithdrawalPage;
  readonly filter: { readonly query: string; readonly status: string };
}) {
  const filtered = filter.query !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'withdrawal-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Request number',
        }}
        selects={[
          {
            id: 'withdrawal-status',
            label: 'Status',
            param: 'status',
            value: filter.status,
            options: [
              { value: 'all', label: 'Every request' },
              ...WITHDRAWAL_STATUSES.map((status) => ({
                value: status,
                label: WITHDRAWAL_STATUS_LABELS[status],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.requests.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="request"
          />
        }
      />

      {page.requests.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : Banknote}
          title={
            filtered
              ? 'No request matches this search'
              : filter.status === 'pending'
                ? 'Nothing is waiting for a decision'
                : 'No withdrawal requests'
          }
          description={
            filtered
              ? 'Search by request number, or clear the status filter.'
              : filter.status === 'pending'
                ? 'Every prepared withdrawal has been decided. Change the filter to see what has been approved, paid or rejected.'
                : 'A withdrawal is prepared from a member’s savings account, and appears here for a decision.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.requests.map((request) => (
              <li key={request.id}>
                <RowLink
                  href={`${ROUTES.savingsWithdrawals}/${request.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-mono font-medium">
                        {request.requestNumber}
                      </p>
                      <p className="text-text-muted text-sm">
                        prepared by {request.requestedByLabel}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-text font-semibold tabular-nums">
                        <Money amount={request.amount} />
                      </p>
                      <WithdrawalStatusBadge status={request.status} />
                    </div>
                  </div>
                  <p className="text-text mt-2 text-sm break-words">{request.reason}</p>
                  <p className="text-text-muted mt-1 text-xs">
                    <DateValue value={request.businessDate} /> · balance then{' '}
                    <Money amount={request.balanceAtRequest} />
                  </p>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Withdrawal requests, newest first">
              <thead>
                <tr>
                  <TableHead width="ref">Request</TableHead>
                  <TableHead width="date">Prepared</TableHead>
                  <TableHead width="name" hideBelow="lg">
                    Prepared by
                  </TableHead>
                  <TableHead width="prose">What for</TableHead>
                  <TableHead width="money" align="numeric">
                    Amount
                  </TableHead>
                  <TableHead width="money" align="numeric" hideBelow="xl">
                    Balance then
                  </TableHead>
                  <TableHead width="status">Status</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.requests.map((request) => (
                  <TableRow key={request.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.savingsWithdrawals}/${request.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {request.requestNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="date" className="text-text-muted">
                      <DateValue value={request.businessDate} />
                    </TableCell>
                    <TableCell
                      width="name"
                      wrap="clamp"
                      hideBelow="lg"
                      className="text-text-muted"
                    >
                      {request.requestedByLabel}
                    </TableCell>
                    <TableCell width="prose" wrap="wrap">
                      {request.reason}
                      {request.decisionNotes === null ? null : (
                        <span className="text-text-muted block text-xs">
                          {request.decisionNotes}
                        </span>
                      )}
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={request.amount} weight="semibold" />
                    </TableCell>
                    <TableCell
                      width="money"
                      align="numeric"
                      hideBelow="xl"
                      className="text-text-muted"
                    >
                      <Money amount={request.balanceAtRequest} />
                    </TableCell>
                    <TableCell width="status">
                      <WithdrawalStatusBadge status={request.status} />
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
