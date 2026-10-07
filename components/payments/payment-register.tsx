'use client';

import { RowLink } from '@/components/ui/row-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { toUgx } from '@/lib/domain/money';
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  type PaymentMethod,
  type PaymentStatus,
} from '@/lib/domain/payment';
import { DateValue } from '@/components/ui/data-value';

export interface PaymentRow {
  readonly id: string;
  readonly paymentNumber: string;
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientName: string;
  readonly clientNumber: string;
  readonly amount: number;
  readonly paymentMethod: PaymentMethod;
  readonly status: PaymentStatus;
  readonly receivedAt: string;
  readonly recordedByLabel: string;
}

/**
 * The payment register.
 *
 * ## Why a reversed payment is still listed
 *
 * It is marked, not hidden. A register that quietly dropped reversed payments
 * would make the ledger impossible to reconcile against a cash drawer, and it
 * would hide the one event a reviewer most wants to see. The row stays, the
 * amount is struck through, and the status says so.
 *
 * ## Cards on a phone, a table on a desktop
 *
 * Eight columns at 320px is unreadable however it is squeezed, and this is a
 * screen a collection officer uses standing up. Both renderings come from the
 * same rows.
 */
export function PaymentRegister({
  payments,
  page,
  hasMore,
  timeZone,
  showFilters = true,
}: {
  readonly payments: readonly PaymentRow[];
  readonly page: number;
  readonly hasMore: boolean;
  readonly timeZone: string;
  readonly showFilters?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [query, setQuery] = useState(params.get('query') ?? '');

  const apply = (updates: Readonly<Record<string, string | null>>): void => {
    const next = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }

    // Any filter change returns to the first page: staying on page 4 of a
    // different result set shows an empty screen for no reason.
    next.delete('page');
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="min-w-0 space-y-4">
      {showFilters ? (
        <Card className="min-w-0">
          <form
            className="min-w-0 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              apply({ query });
            }}
          >
            <div className="flex min-w-0 flex-wrap gap-2">
              <div className="min-w-0 grow">
                <label htmlFor="payment-search" className="sr-only">
                  Search payments by receipt number or transaction reference
                </label>
                <Input
                  id="payment-search"
                  type="search"
                  placeholder="Receipt number or transaction reference"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                />
              </div>
              <Button type="submit">Search</Button>
            </div>

            <div className="flex min-w-0 flex-wrap gap-3">
              <div className="min-w-0">
                <label
                  htmlFor="payment-method-filter"
                  className="text-text-muted block text-sm"
                >
                  Method
                </label>
                <select
                  id="payment-method-filter"
                  className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                  value={params.get('method') ?? 'all'}
                  onChange={(event) => {
                    apply({ method: event.target.value });
                  }}
                >
                  <option value="all">All methods</option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {PAYMENT_METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0">
                <label
                  htmlFor="payment-status-filter"
                  className="text-text-muted block text-sm"
                >
                  Status
                </label>
                <select
                  id="payment-status-filter"
                  className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                  value={params.get('status') ?? 'all'}
                  onChange={(event) => {
                    apply({ status: event.target.value });
                  }}
                >
                  <option value="all">All</option>
                  <option value="posted">Posted</option>
                  <option value="reversed">Reversed</option>
                </select>
              </div>

              <div className="min-w-0">
                <label htmlFor="payment-from" className="text-text-muted block text-sm">
                  From
                </label>
                <Input
                  id="payment-from"
                  type="date"
                  defaultValue={params.get('from') ?? ''}
                  onChange={(event) => {
                    apply({ from: event.target.value });
                  }}
                />
              </div>

              <div className="min-w-0">
                <label htmlFor="payment-to" className="text-text-muted block text-sm">
                  To
                </label>
                <Input
                  id="payment-to"
                  type="date"
                  defaultValue={params.get('to') ?? ''}
                  onChange={(event) => {
                    apply({ to: event.target.value });
                  }}
                />
              </div>
            </div>
          </form>
        </Card>
      ) : null}

      {payments.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No payments match. That is not the same as no payments existing — try clearing
            the filters.
          </p>
        </Card>
      ) : (
        <>
          {/* Phones: one card per payment. */}
          <ul className="min-w-0 space-y-2 md:hidden">
            {payments.map((payment) => (
              <li key={payment.id} className="min-w-0">
                <RowLink
                  href={`${ROUTES.payments}/${payment.id}`}
                  className="record-surface focus-visible:outline-accent block min-w-0 rounded-lg p-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-text font-medium break-words">
                      {payment.clientName}
                    </span>
                    <Amount
                      amount={payment.amount}
                      reversed={payment.status === 'reversed'}
                    />
                  </div>
                  <div className="text-text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono">{payment.paymentNumber}</span>
                    <span className="font-mono">{payment.loanNumber}</span>
                    <span>{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</span>
                    <span>
                      <DateValue
                        value={payment.receivedAt}
                        variant="datetime"
                        timeZone={timeZone}
                      />
                    </span>
                    <StatusBadge status={payment.status} />
                  </div>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: the columns fit. */}
          <Card className="hidden min-w-0 overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Payment register: receipt number, borrower, loan, amount, method, date,
                status and who recorded it
              </caption>
              <thead>
                <tr className="border-border text-text-muted border-b">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Receipt
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Borrower
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Loan
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Method
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Received
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    By
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-border border-b">
                    <th scope="row" className="py-2 pr-4 font-normal">
                      <RowLink
                        href={`${ROUTES.payments}/${payment.id}`}
                        className="text-accent focus-visible:outline-accent font-mono underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {payment.paymentNumber}
                      </RowLink>
                    </th>
                    <td className="text-text py-2 pr-4 break-words">
                      {payment.clientName}
                      <span className="text-text-muted block font-mono text-xs">
                        {payment.clientNumber}
                      </span>
                    </td>
                    <td className="text-text-muted py-2 pr-4 font-mono">
                      {payment.loanNumber}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Amount
                        amount={payment.amount}
                        reversed={payment.status === 'reversed'}
                      />
                    </td>
                    <td className="text-text-muted py-2 pr-4">
                      {PAYMENT_METHOD_LABELS[payment.paymentMethod]}
                    </td>
                    <td className="text-text-muted py-2 pr-4">
                      <DateValue
                        value={payment.receivedAt}
                        variant="datetime"
                        timeZone={timeZone}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={payment.status} />
                    </td>
                    <td className="text-text-muted py-2 break-words">
                      {payment.recordedByLabel}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {page > 1 || hasMore ? (
        <nav className="flex items-center justify-between gap-2" aria-label="Pages">
          <Button
            variant="secondary"
            disabled={page <= 1}
            onClick={() => {
              apply({ page: String(page - 1) });
            }}
          >
            Previous
          </Button>
          <span className="text-text-muted text-sm">Page {page}</span>
          <Button
            variant="secondary"
            disabled={!hasMore}
            onClick={() => {
              apply({ page: String(page + 1) });
            }}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function Amount({
  amount,
  reversed,
}: {
  readonly amount: number;
  readonly reversed: boolean;
}) {
  if (reversed) {
    return (
      <span className="font-medium">
        <Money amount={toUgx(amount)} struck tone="muted" />
        <span className="sr-only"> (reversed, no longer counted)</span>
      </span>
    );
  }

  return (
    <span className="text-text font-semibold tabular-nums">
      <Money amount={toUgx(amount)} />
    </span>
  );
}

function StatusBadge({ status }: { readonly status: PaymentStatus }) {
  return (
    <Badge tone={status === 'reversed' ? 'danger' : 'success'}>
      {PAYMENT_STATUS_LABELS[status]}
    </Badge>
  );
}
