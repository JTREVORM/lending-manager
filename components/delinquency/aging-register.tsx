'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { ROUTES } from '@/config/app';
import { AGING_BUCKETS, AGING_BUCKET_LABELS } from '@/lib/domain/risk';
import { cn } from '@/lib/utils/cn';
import type { AgingRow } from '@/lib/data/security';
import type { ParSlice } from '@/lib/data/security';

/**
 * The aging register: the active book by how late it is.
 *
 * ## The bucket chips carry counts, and can afford to
 *
 * The loan register's stage tabs deliberately do not, because twelve badges
 * would mean twelve aggregate queries on every render. Here the counts come
 * from `portfolio_at_risk`, which the page above already reads for the PAR
 * tiles — so they are free, and a worklist whose chips say "9" and "3" is a
 * worklist somebody can plan a morning from.
 *
 * ## Worst first
 *
 * The server orders by bucket descending. A list that opened on the loans one
 * day late would bury the ones three months late beneath them, which is the
 * opposite of what this screen is for.
 */
export function AgingRegister({
  rows,
  page,
  hasMore,
  slice,
  businessDate,
}: {
  readonly rows: readonly AgingRow[];
  readonly page: number;
  readonly hasMore: boolean;
  readonly slice: ParSlice;
  readonly businessDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [query, setQuery] = useState(params.get('query') ?? '');

  const bucket = params.get('bucket') ?? '';

  const apply = (updates: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }

    // Any change of filter returns to the first page: staying on page four of
    // a different result set shows an empty screen for no visible reason.
    next.delete('page');

    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  };

  const pageParams = (target: number): string => {
    const next = new URLSearchParams(params.toString());
    next.set('page', String(target));
    return next.toString();
  };

  return (
    <div className="min-w-0 space-y-4">
      {/* --- Bucket chips ------------------------------------------------ */}
      <nav
        aria-label="Aging buckets"
        aria-busy={isPending}
        className="chip-row border-border bg-surface rounded-lg border p-1.5 shadow-xs"
      >
        <button
          type="button"
          aria-current={bucket === '' ? 'page' : undefined}
          onClick={() => {
            apply({ bucket: null });
          }}
          className={cn(
            'chip',
            bucket === ''
              ? 'bg-accent text-accent-contrast shadow-xs'
              : 'text-text-muted hover:bg-surface-hover hover:text-text',
          )}
        >
          All active ({slice.loanCount})
        </button>

        {AGING_BUCKETS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={bucket === value ? 'page' : undefined}
            onClick={() => {
              apply({ bucket: value });
            }}
            className={cn(
              'chip',
              bucket === value
                ? 'bg-accent text-accent-contrast shadow-xs'
                : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            {AGING_BUCKET_LABELS[value]} ({slice.loansByBucket[value]})
          </button>
        ))}
      </nav>

      {/* --- Search ------------------------------------------------------ */}
      <Card className="min-w-0">
        <p className="text-text-muted mb-3 text-sm">
          As at <DateValue value={businessDate} />, in the business timezone. Days past
          due are counted net of each product&apos;s grace period.
        </p>

        <form
          className="flex min-w-0 flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ query });
          }}
        >
          <div className="min-w-0 grow">
            <label htmlFor="aging-search" className="sr-only">
              Search by borrower, client number, phone or loan number
            </label>
            <Input
              id="aging-search"
              type="search"
              placeholder="Borrower, phone or loan number"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No loans match. That is not the same as nothing being late — try clearing the
            filters.
          </p>
        </Card>
      ) : (
        <>
          {/* Phones: one card per loan, tappable, with the number dialling.
              The stretched-link shape the overdue list documents at length —
              an `<a href="tel:">` nested inside the card's own anchor is
              invalid HTML and breaks hydration. */}
          <ul className="min-w-0 space-y-2 md:hidden">
            {rows.map((row) => (
              <li key={row.loanId} className="min-w-0">
                <div className="record-surface focus-within:outline-accent relative min-w-0 rounded-lg p-3 focus-within:outline-2 focus-within:outline-offset-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <RowLink
                      href={`${ROUTES.loans}/${row.loanId}`}
                      className="text-text font-medium break-words before:absolute before:inset-0 before:content-['']"
                    >
                      {row.clientName}
                    </RowLink>
                    <span className="text-text font-semibold tabular-nums">
                      <Money amount={row.totalOutstanding} />
                    </span>
                  </div>

                  <div className="text-text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono">{row.loanNumber}</span>
                    <PhoneValue
                      value={row.clientPhone}
                      linked
                      className="text-accent relative"
                    />
                    <span>{row.productCode}</span>
                  </div>

                  <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                    <div>
                      <dt className="text-text-muted">Age</dt>
                      <dd className="text-text">
                        {AGING_BUCKET_LABELS[row.agingBucket]}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">In arrears</dt>
                      <dd className="text-text tabular-nums">
                        <Money amount={row.arrearsAmount} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Days late</dt>
                      <dd className="text-text tabular-nums">{row.daysPastDue}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>

          {/* Tablet and up: the columns fit. */}
          <Card className="hidden min-w-0 overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Active loans by age: borrower, phone, loan, product, bucket, days late,
                arrears, outstanding principal, total outstanding and the last payment
              </caption>
              <thead>
                <tr className="border-border bg-surface-sunken border-b">
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Borrower
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Phone
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Loan
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Product
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Age
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Days
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Arrears
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Principal
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Outstanding
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Last paid
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {rows.map((row) => (
                  <tr key={row.loanId} className="hover:bg-surface-hover">
                    <th scope="row" className="py-2.5 pr-4 font-medium">
                      <RowLink
                        href={`${ROUTES.loans}/${row.loanId}`}
                        className="text-brand-700 hover:underline"
                      >
                        {row.clientName}
                      </RowLink>
                      <span className="text-text-muted block text-xs">
                        {row.clientNumber}
                      </span>
                    </th>
                    <td className="py-2.5 pr-4 whitespace-nowrap">
                      <PhoneValue
                        value={row.clientPhone}
                        linked
                        className="text-accent"
                      />
                    </td>
                    <td className="text-text py-2.5 pr-4 font-mono whitespace-nowrap">
                      {row.loanNumber}
                    </td>
                    <td className="text-text py-2.5 pr-4 whitespace-nowrap">
                      {row.productCode}
                    </td>
                    <td className="text-text py-2.5 pr-4 whitespace-nowrap">
                      {AGING_BUCKET_LABELS[row.agingBucket]}
                    </td>
                    <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                      {row.daysPastDue}
                    </td>
                    <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                      <Money amount={row.arrearsAmount} />
                    </td>
                    <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                      <Money amount={row.principalRemaining} />
                    </td>
                    <td className="text-text py-2.5 pr-4 text-right tabular-nums">
                      <Money amount={row.totalOutstanding} />
                    </td>
                    <td className="text-text-muted py-2.5 pr-4 whitespace-nowrap">
                      {row.lastPaymentDate === null ? (
                        'Never'
                      ) : (
                        <DateValue value={row.lastPaymentDate} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-text-muted text-sm">Page {page}</p>
            <div className="flex gap-2">
              {page > 1 ? (
                <RowLink
                  href={`${pathname}?${pageParams(page - 1)}`}
                  className="text-brand-700 min-h-11 text-sm font-medium hover:underline"
                >
                  Previous
                </RowLink>
              ) : null}
              {hasMore ? (
                <RowLink
                  href={`${pathname}?${pageParams(page + 1)}`}
                  className="text-brand-700 min-h-11 text-sm font-medium hover:underline"
                >
                  Next
                </RowLink>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
