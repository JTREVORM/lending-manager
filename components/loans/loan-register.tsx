'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoanStatusBadge } from './loan-status-badge';
import { LOAN_STATUSES, LOAN_STATUS_LABELS } from '@/lib/domain/loan';
import { formatRecordedDate } from '@/lib/domain/client';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import type { LoanPage } from '@/lib/data/loans';

/**
 * The loan register.
 *
 * Filters live in the URL rather than component state, so a filtered view can
 * be reloaded or shared and the filtering happens server-side — which means
 * Row Level Security applies to the filtered query rather than to a full list
 * trimmed in the browser.
 *
 * Cards on a phone, a table from `md` up. The money columns use
 * `tabular-nums` so figures line up vertically; proportional digits make a
 * column of amounts genuinely harder to compare.
 */
export function LoanRegister({
  page,
  filter,
}: {
  readonly page: LoanPage;
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

    // Any filter change returns to the first page: staying on page four of a
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
    <div className="min-w-0 space-y-4">
      <Card className="min-w-0 space-y-4">
        <div className="grid min-w-0 gap-4 sm:grid-cols-[2fr_1fr]">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="loan-search">Search</Label>
            <Input
              id="loan-search"
              type="search"
              inputMode="search"
              defaultValue={filter.query}
              placeholder="Loan number, client name or client number"
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
            <Label htmlFor="loan-status">Status</Label>
            <select
              id="loan-status"
              defaultValue={filter.status}
              onChange={(event) => {
                apply('status', event.target.value);
              }}
              className="border-border bg-surface text-text focus-visible:outline-accent h-11 w-full rounded-lg border px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <option value="">All statuses</option>
              {LOAN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {LOAN_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p aria-live="polite" className="text-text-muted text-sm">
          {isPending
            ? 'Searching…'
            : `${String(page.loans.length)} loan${page.loans.length === 1 ? '' : 's'}`}
        </p>
      </Card>

      {page.loans.length === 0 ? (
        <Card>
          <p className="text-text-muted">
            {filter.query === '' && filter.status === ''
              ? 'No loans have been recorded yet.'
              : 'No loans match that search.'}
          </p>
        </Card>
      ) : (
        <>
          <ul className="space-y-3 md:hidden">
            {page.loans.map((loan) => (
              <li key={loan.id}>
                <Link
                  href={`/loans/${loan.id}`}
                  className="border-border bg-surface focus-visible:outline-accent block rounded-xl border p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text truncate font-medium">{loan.clientName}</p>
                      <p className="text-text-muted font-mono text-sm">
                        {loan.loanNumber}
                      </p>
                    </div>
                    <LoanStatusBadge status={loan.status} />
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Principal</dt>
                      <dd className="text-text tabular-nums">
                        {formatUgx(toUgx(loan.principalAmount))}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Repayable</dt>
                      <dd className="text-text tabular-nums">
                        {loan.totalExpectedRepayment === 0
                          ? '—'
                          : formatUgx(toUgx(loan.totalExpectedRepayment))}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Period</dt>
                      <dd className="text-text">
                        {String(loan.loanTermMonths)}{' '}
                        {loan.loanTermMonths === 1 ? 'month' : 'months'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Started</dt>
                      <dd className="text-text">{formatRecordedDate(loan.createdAt)}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>

          <Card className="hidden min-w-0 overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Loan register, most recently started first
              </caption>
              <thead>
                <tr className="border-border text-text-muted border-b">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Loan
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Client
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Principal
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Period
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Rate
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Repayable
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Started
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.loans.map((loan) => (
                  <tr key={loan.id} className="border-border border-b last:border-0">
                    <td className="py-3 pr-4 font-mono">
                      <Link
                        href={`/loans/${loan.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {loan.loanNumber}
                      </Link>
                    </td>
                    <td className="text-text py-3 pr-4">
                      {loan.clientName}
                      <span className="text-text-muted block font-mono text-xs">
                        {loan.clientNumber}
                      </span>
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      {formatUgx(toUgx(loan.principalAmount))}
                    </td>
                    <td className="text-text-muted py-3 pr-4">
                      {String(loan.loanTermMonths)} mo
                    </td>
                    <td className="text-text-muted py-3 pr-4 tabular-nums">
                      {formatBps(toBps(loan.interestRateBps))}
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      {loan.totalExpectedRepayment === 0
                        ? '—'
                        : formatUgx(toUgx(loan.totalExpectedRepayment))}
                    </td>
                    <td className="text-text-muted py-3 pr-4">
                      {formatRecordedDate(loan.createdAt)}
                    </td>
                    <td className="py-3">
                      <LoanStatusBadge status={loan.status} />
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
