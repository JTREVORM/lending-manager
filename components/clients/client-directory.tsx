'use client';

import { RowLink } from '@/components/ui/row-link';
import { SearchX, UserPlus } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { EmptyState } from '@/components/ui/states';
import { ClientStatusBadge } from './client-status-badge';
import { CLIENT_STATUSES, CLIENT_STATUS_LABELS } from '@/lib/domain/client';
import type { ClientPage } from '@/lib/data/clients';
import { DateValue, PhoneValue } from '@/components/ui/data-value';

/**
 * The client directory.
 *
 * Filters live in the URL, not in component state, for three reasons that all
 * matter at a counter: a filtered view can be reloaded or shared, the back
 * button behaves, and the filtering happens server-side — so Row Level
 * Security applies to the filtered query rather than to a full list trimmed in
 * the browser.
 *
 * Cards on a phone, a table from `md` up. A table at 320px either scrolls
 * sideways or crushes its columns, and neither is usable one-handed.
 *
 * Note what the rows do not contain: no National Identification Number. That
 * is not a display decision — the column is in a different table behind a
 * different policy, so this component could not show one if it tried.
 */
export function ClientDirectory({
  page,
  filter,
}: {
  readonly page: ClientPage;
  readonly filter: { readonly query: string; readonly status: string };
}) {
  const filtered = filter.query !== '' || filter.status !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'client-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Name, client number or phone',
        }}
        selects={[
          {
            id: 'client-status',
            label: 'Status',
            param: 'status',
            value: filter.status,
            options: [
              { value: '', label: 'Active and inactive' },
              ...CLIENT_STATUSES.map((status) => ({
                value: status,
                label: CLIENT_STATUS_LABELS[status],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.clients.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="client"
          />
        }
      />

      {page.clients.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : UserPlus}
          title={filtered ? 'No clients match this search' : 'No clients registered yet'}
          description={
            filtered
              ? 'Try a shorter search, or clear the status filter.'
              : 'Register the first client to get started.'
          }
          {...(filtered ? {} : { action: { href: '/clients/new', label: 'Register a client' } })}
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.clients.map((client) => (
              <li key={client.id}>
                <RowLink
                  href={`/clients/${client.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {client.fullName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {client.clientNumber}
                      </p>
                    </div>
                    <ClientStatusBadge status={client.status} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Phone</dt>
                      <dd className="text-text">
                        <PhoneValue value={client.phone} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Location</dt>
                      <dd className="text-text break-words">
                        {client.villageArea}, {client.district}
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Client directory, newest registration first">
              <thead>
                <tr>
                  <TableHead width="ref">Client number</TableHead>
                  <TableHead width="name-wide">Name</TableHead>
                  <TableHead width="phone">Phone</TableHead>
                  <TableHead width="place" hideBelow="lg">
                    Location
                  </TableHead>
                  <TableHead width="date" hideBelow="lg">
                    Registered
                  </TableHead>
                  <TableHead width="status">Status</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.clients.map((client) => (
                  <TableRow key={client.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`/clients/${client.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {client.clientNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="name-wide" wrap="clamp">
                      <TableLead primary={client.fullName} />
                    </TableCell>
                    <TableCell width="phone" className="text-text-muted">
                      <PhoneValue value={client.phone} />
                    </TableCell>
                    <TableCell
                      width="place"
                      wrap="clamp"
                      hideBelow="lg"
                      title={`${client.villageArea}, ${client.district}`}
                      className="text-text-muted"
                    >
                      {client.villageArea}, {client.district}
                    </TableCell>
                    <TableCell width="date" hideBelow="lg" className="text-text-muted">
                      <DateValue value={client.registeredAt} />
                    </TableCell>
                    <TableCell width="status">
                      <ClientStatusBadge status={client.status} />
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
