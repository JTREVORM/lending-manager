'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
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
  /**
   * The risk slice the bucket counts come from, or `null` when it could not be
   * read. The filters still work without it; the counts are omitted rather
   * than shown as zero, which would say every bucket is empty.
   */
  readonly slice: ParSlice | null;
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
          All active{slice === null ? '' : ` (${String(slice.loanCount)})`}
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
            {AGING_BUCKET_LABELS[value]}
            {slice === null ? '' : ` (${String(slice.loansByBucket[value])})`}
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

          {/* Tablet and up: the columns fit. Ten of them, so the table runs
              past a laptop and scrolls inside its own box; the two that a
              collections officer can work without — the product code and the
              last payment date, both on the loan's own page — step out below
              `xl`. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Active loans by age" density="compact">
              <thead>
                <tr>
                  <TableHead width="name">Borrower</TableHead>
                  <TableHead width="phone">Phone</TableHead>
                  <TableHead width="ref">Loan</TableHead>
                  <TableHead width="count" hideBelow="xl">
                    Product
                  </TableHead>
                  <TableHead width="status">Age</TableHead>
                  <TableHead width="count" align="numeric">
                    Days
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Arrears
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Principal
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Outstanding
                  </TableHead>
                  <TableHead width="date" hideBelow="xl">
                    Last paid
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TableRow key={row.loanId}>
                    <TableCell header width="name" wrap="clamp">
                      <span className="block min-w-0">
                        <RowLink
                          href={`${ROUTES.loans}/${row.loanId}`}
                          className="text-brand-700 line-clamp-2 break-words hover:underline"
                          title={row.clientName}
                        >
                          {row.clientName}
                        </RowLink>
                        <span className="text-text-muted mt-0.5 block font-mono text-[10px] font-normal whitespace-nowrap">
                          {row.clientNumber}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell width="phone">
                      <PhoneValue
                        value={row.clientPhone}
                        linked
                        className="text-accent"
                      />
                    </TableCell>
                    <TableCell width="ref" className="text-text font-mono">
                      {row.loanNumber}
                    </TableCell>
                    <TableCell width="count" hideBelow="xl" className="text-text">
                      {row.productCode}
                    </TableCell>
                    <TableCell width="status" className="text-text">
                      {AGING_BUCKET_LABELS[row.agingBucket]}
                    </TableCell>
                    <TableCell width="count" align="numeric" className="text-text">
                      {row.daysPastDue}
                    </TableCell>
                    <TableCell width="money" align="numeric" className="text-text">
                      <Money amount={row.arrearsAmount} />
                    </TableCell>
                    <TableCell width="money" align="numeric" className="text-text">
                      <Money amount={row.principalRemaining} />
                    </TableCell>
                    <TableCell width="money" align="numeric" className="text-text">
                      <Money amount={row.totalOutstanding} />
                    </TableCell>
                    <TableCell width="date" hideBelow="xl" className="text-text-muted">
                      {row.lastPaymentDate === null ? (
                        'Never'
                      ) : (
                        <DateValue value={row.lastPaymentDate} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>

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
