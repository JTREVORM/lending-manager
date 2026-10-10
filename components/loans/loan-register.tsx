'use client';

import { RowLink } from '@/components/ui/row-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import { Badge } from '@/components/ui/badge';
import { LoanStatusBadge } from './loan-status-badge';
import { LOAN_WORKFLOW_LABELS } from '@/lib/domain/loan';
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
  products,
}: {
  readonly page: LoanPage;
  readonly filter: {
    readonly query: string;
    readonly stage: string;
    readonly productId: string;
  };
  /**
   * Phase 13. The products the register can be sliced by. Read server-side,
   * so a product nobody may see is a product nobody can filter on.
   */
  readonly products: readonly { readonly id: string; readonly name: string }[];
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

          {/*
            Phase 13. The product, not the status: the status is what the
            workflow strip above this card already navigates by, and two
            controls answering the same question is how a filter row comes to
            contradict itself.
          */}
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="loan-product">Loan product</Label>
            <select
              id="loan-product"
              defaultValue={filter.productId}
              onChange={(event) => {
                apply('productId', event.target.value);
              }}
              className="border-border bg-surface text-text focus-visible:outline-accent h-11 w-full rounded-lg border px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <option value="">All products</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
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
            {filter.query === '' && filter.stage === '' && filter.productId === ''
              ? 'No loans have been recorded yet.'
              : 'No loans match this view.'}
          </p>
        </Card>
      ) : (
        <>
          <ul className="space-y-3 md:hidden">
            {page.loans.map((loan) => (
              <li key={loan.id}>
                <RowLink
                  href={`/loans/${loan.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
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
                        <Money amount={toUgx(loan.principalAmount)} />
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
                    <div className="col-span-2 min-w-0">
                      <dt className="text-text-muted">Product</dt>
                      <dd className="text-text break-words">{loan.productName}</dd>
                    </div>
                  </dl>

                  <p className="text-text-muted mt-2 text-sm">
                    {LOAN_WORKFLOW_LABELS[loan.workflowStage]}
                    {loan.arrearsAmount !== null && loan.arrearsAmount > 0
                      ? ` · ${formatUgx(toUgx(loan.arrearsAmount))} in arrears`
                      : ''}
                  </p>
                </RowLink>
              </li>
            ))}
          </ul>

          <Card className="hidden min-w-0 overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Loan register, most recently started first
              </caption>
              <thead>
                <tr className="border-border bg-surface-sunken border-b">
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Loan
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Client
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Product
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Principal
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Period
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Rate
                  </th>
                  <th
                    scope="col"
                    className="t-th py-2.5 pr-4 text-right whitespace-nowrap"
                  >
                    Repayable
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Started
                  </th>
                  <th scope="col" className="t-th py-2.5 pr-4 whitespace-nowrap">
                    Status
                  </th>
                  <th scope="col" className="t-th py-2.5 whitespace-nowrap">
                    Stage
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.loans.map((loan) => (
                  <tr key={loan.id} className="border-border border-b last:border-0">
                    <td className="py-3 pr-4 font-mono">
                      <RowLink
                        href={`/loans/${loan.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {loan.loanNumber}
                      </RowLink>
                    </td>
                    <td className="text-text py-3 pr-4">
                      {loan.clientName}
                      <span className="text-text-muted block font-mono text-xs">
                        {loan.clientNumber}
                      </span>
                    </td>
                    <td className="text-text-muted py-3 pr-4">
                      {loan.productName}
                      <span className="block font-mono text-xs">{loan.productCode}</span>
                    </td>
                    <td className="text-text py-3 pr-4 text-right tabular-nums">
                      <Money amount={toUgx(loan.principalAmount)} />
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
                    <td className="py-3 pr-4">
                      <LoanStatusBadge status={loan.status} />
                    </td>
                    <td className="py-3">
                      <Badge
                        tone={
                          loan.workflowStage === 'arrears'
                            ? 'danger'
                            : loan.workflowStage === 'grace_period'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {LOAN_WORKFLOW_LABELS[loan.workflowStage]}
                      </Badge>
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
