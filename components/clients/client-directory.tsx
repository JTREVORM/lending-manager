'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ClientStatusBadge } from './client-status-badge';
import {
  CLIENT_STATUSES,
  CLIENT_STATUS_LABELS,
  formatRecordedDate,
} from '@/lib/domain/client';
import type { ClientPage } from '@/lib/data/clients';
import { PhoneValue } from '@/components/ui/data-value';

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function apply(key: string, value: string): void {
    const next = new URLSearchParams(searchParams.toString());

    if (value === '') next.delete(key);
    else next.set(key, value);

    // Any filter change returns to the first page. Staying on page four of a
    // different result set shows an empty screen for no visible reason.
    next.delete('page');

    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  }

  function goToPage(target: number): void {
    const next = new URLSearchParams(searchParams.toString());
    next.set('page', String(target));
    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="client-search">Search</Label>
            <Input
              id="client-search"
              type="search"
              inputMode="search"
              defaultValue={filter.query}
              placeholder="Name, client number or phone"
              // Searching on every keystroke would issue a query per
              // character. Committing on blur or Enter is both cheaper and
              // calmer to use on a phone keyboard.
              onBlur={(event) => {
                apply('q', event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  apply('q', event.currentTarget.value.trim());
                }
              }}
            />
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="client-status">Status</Label>
            <select
              id="client-status"
              defaultValue={filter.status}
              onChange={(event) => {
                apply('status', event.target.value);
              }}
              className="border-border bg-surface text-text focus-visible:outline-accent h-11 w-full rounded-lg border px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <option value="">Active and inactive</option>
              {CLIENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CLIENT_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p aria-live="polite" className="text-text-muted text-sm">
          {isPending
            ? 'Searching…'
            : `${String(page.clients.length)} client${page.clients.length === 1 ? '' : 's'}${page.hasMore ? ' on this page' : ''}`}
        </p>
      </Card>

      {page.clients.length === 0 ? (
        <Card>
          <p className="text-text-muted">
            No clients match that search.{' '}
            {filter.query === '' && filter.status === ''
              ? 'Register the first one to get started.'
              : 'Try a shorter search, or clear the status filter.'}
          </p>
        </Card>
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.clients.map((client) => (
              <li key={client.id}>
                <Link
                  href={`/clients/${client.id}`}
                  className="border-border bg-surface focus-visible:outline-accent block rounded-xl border p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text truncate font-medium">{client.fullName}</p>
                      <p className="text-text-muted font-mono text-sm">
                        {client.clientNumber}
                      </p>
                    </div>
                    <ClientStatusBadge status={client.status} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Phone</dt>
                      <dd className="text-text truncate">
                        <PhoneValue value={client.phone} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Location</dt>
                      <dd className="text-text truncate">
                        {client.villageArea}, {client.district}
                      </dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Client directory, newest registration first
              </caption>
              <thead>
                <tr className="border-border text-text-muted border-b">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Client number
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Phone
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Location
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Registered
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.clients.map((client) => (
                  <tr key={client.id} className="border-border border-b last:border-0">
                    <td className="py-3 pr-4 font-mono">
                      <Link
                        href={`/clients/${client.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {client.clientNumber}
                      </Link>
                    </td>
                    <td className="text-text py-3 pr-4">{client.fullName}</td>
                    <td className="text-text-muted py-3 pr-4">
                      <PhoneValue value={client.phone} />
                    </td>
                    <td className="text-text-muted py-3 pr-4">
                      {client.villageArea}, {client.district}
                    </td>
                    <td className="text-text-muted py-3 pr-4">
                      {formatRecordedDate(client.registeredAt)}
                    </td>
                    <td className="py-3">
                      <ClientStatusBadge status={client.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {(page.hasMore || page.page > 1) && (
        <nav className="flex items-center justify-between gap-3" aria-label="Pagination">
          <button
            type="button"
            disabled={page.page <= 1}
            onClick={() => {
              goToPage(page.page - 1);
            }}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            Previous
          </button>

          <span className="text-text-muted text-sm">Page {String(page.page)}</span>

          <button
            type="button"
            disabled={!page.hasMore}
            onClick={() => {
              goToPage(page.page + 1);
            }}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
