'use client';

import { PiggyBank, SearchX } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import {
  SAVINGS_ACCOUNT_STATUSES,
  SAVINGS_ACCOUNT_STATUS_LABELS,
} from '@/lib/domain/savings';
import type { SavingsAccountPage } from '@/lib/data/savings';
import { SavingsAccountStatusBadge } from './savings-badges';

/**
 * The savings register.
 *
 * The same three pieces every register here uses — `RegisterFilters`,
 * `DataTable`, `RegisterPagination` — so somebody who can read the client
 * register can read this one without learning anything. Filters live in the
 * URL, which is what makes a filtered view reloadable and, more importantly,
 * makes the filtering happen in the database: Row Level Security applies to
 * the filtered query rather than to a full list trimmed in the browser.
 *
 * Cards on a phone, a table from `md` up. A table at 390px either scrolls
 * sideways or crushes its columns, and neither is usable one-handed by
 * somebody standing at a counter.
 *
 * ## The balance is the most important column, so it is in the lead on a phone
 *
 * On the card layout the balance sits beside the member's name rather than
 * down in the detail grid. The question a counter asks of this screen is
 * almost always "what does this member hold", and on a phone the answer
 * should not need a second glance.
 */
export function SavingsRegister({
  page,
  filter,
}: {
  readonly page: SavingsAccountPage;
  readonly filter: { readonly query: string; readonly status: string };
}) {
  const filtered = filter.query !== '' || filter.status !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'savings-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Account number, membership number, member name or client number',
        }}
        selects={[
          {
            id: 'savings-status',
            label: 'Account',
            param: 'status',
            value: filter.status,
            options: [
              { value: '', label: 'All accounts' },
              ...SAVINGS_ACCOUNT_STATUSES.map((status) => ({
                value: status,
                label: SAVINGS_ACCOUNT_STATUS_LABELS[status],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.accounts.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="savings account"
          />
        }
      />

      {page.accounts.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : PiggyBank}
          title={
            filtered
              ? 'No savings account matches this search'
              : 'No savings accounts yet'
          }
          description={
            filtered
              ? 'Try a shorter search, or clear the account filter.'
              : 'A savings account is opened when a member is enrolled. Enrol a member from the membership register to start taking deposits.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.accounts.map((account) => (
              <li key={account.id}>
                <RowLink
                  href={`${ROUTES.savings}/${account.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {account.fullName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {account.accountNumber}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-text font-semibold tabular-nums">
                        <Money amount={account.balance} />
                      </p>
                      <SavingsAccountStatusBadge status={account.status} />
                    </div>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Membership</dt>
                      <dd className="text-text font-mono">{account.membershipNumber}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Phone</dt>
                      <dd className="text-text">
                        <PhoneValue value={account.phone} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Deposited</dt>
                      <dd className="text-text tabular-nums">
                        <Money amount={account.totalDeposited} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Last movement</dt>
                      <dd className="text-text">
                        <DateValue value={account.lastTransactionOn} />
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Savings register, newest account first">
              <thead>
                <tr>
                  <TableHead width="ref">Account</TableHead>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="ref" hideBelow="xl">
                    Membership
                  </TableHead>
                  <TableHead width="phone" hideBelow="lg">
                    Phone
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Balance
                  </TableHead>
                  <TableHead width="money" align="numeric" hideBelow="lg">
                    Deposited
                  </TableHead>
                  <TableHead width="date" hideBelow="lg">
                    Last movement
                  </TableHead>
                  <TableHead width="status">Account</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.accounts.map((account) => (
                  <TableRow key={account.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.savings}/${account.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {account.accountNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="name-wide" wrap="wrap">
                      <TableLead
                        primary={account.fullName}
                        secondary={account.clientNumber}
                      />
                    </TableCell>
                    <TableCell
                      width="ref"
                      hideBelow="xl"
                      className="text-text-muted font-mono"
                    >
                      {account.membershipNumber}
                    </TableCell>
                    <TableCell width="phone" hideBelow="lg" className="text-text-muted">
                      <PhoneValue value={account.phone} />
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      <Money amount={account.balance} weight="semibold" />
                    </TableCell>
                    <TableCell
                      width="money"
                      align="numeric"
                      hideBelow="lg"
                      className="text-text-muted"
                    >
                      <Money amount={account.totalDeposited} />
                    </TableCell>
                    <TableCell width="date" hideBelow="lg" className="text-text-muted">
                      <DateValue value={account.lastTransactionOn} />
                    </TableCell>
                    <TableCell width="status">
                      <SavingsAccountStatusBadge status={account.status} />
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
