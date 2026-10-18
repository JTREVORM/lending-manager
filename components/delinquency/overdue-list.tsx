'use client';

import { RowLink } from '@/components/ui/row-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { RegisterPagination } from '@/components/ui/register';
import { ROUTES } from '@/config/app';
import {
  DELINQUENCY_STATE_LABELS,
  type DelinquencyState,
} from '@/lib/domain/delinquency';
import type { DelinquentLoanRow } from '@/lib/data/delinquency';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { MagnitudeChart } from '@/components/charts/magnitude-chart';

/**
 * The overdue list: who is behind, by how much, and since when.
 *
 * ## What it is not
 *
 * Not a report and not a dashboard. There is no chart, no trend, no portfolio
 * total and no export — those are Phase 8's. This is the working screen of the
 * people who chase payments, so every column is something they act on: who to
 * call, the number to call, how much to ask for, and how late it is.
 *
 * ## A settled loan is never on it
 *
 * The filter excludes `cleared` unless somebody asks for it explicitly. A
 * collection officer acting on a list that included settled loans would be
 * chasing borrowers who have already paid, which is worse than useless.
 *
 * ## Cards on a phone, a table on a desktop
 *
 * This is a screen used standing up, often outdoors. Nine columns at 320px is
 * unreadable however it is squeezed, so both renderings come from the same
 * rows — the Phase 6 register's approach, for the same reason.
 */
const FILTERABLE_STATES: readonly DelinquencyState[] = [
  'penalty_due',
  'expired_unpaid',
  'grace_period',
  'in_arrears',
  'due_today',
  'current',
  'cleared',
];

export function OverdueList({
  loans,
  page,
  hasMore,
  counts,
  businessDate,
}: {
  readonly loans: readonly DelinquentLoanRow[];
  readonly page: number;
  readonly hasMore: boolean;
  readonly counts: Readonly<Record<DelinquencyState, number>>;
  readonly businessDate: string;
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

    next.delete('page');
    router.replace(`${pathname}?${next.toString()}`);
  };

  return (
    <div className="min-w-0 space-y-4">
      {/* --- What the list is counting ---------------------------------- */}
      <Card className="min-w-0">
        <p className="text-text-muted mb-3 text-sm">
          As at <DateValue value={businessDate} />, in the business timezone.
        </p>
        <dl className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
          <Count label="Penalty due" value={counts.penalty_due} tone="danger" />
          <Count label="Expired, unpaid" value={counts.expired_unpaid} tone="danger" />
          <Count label="Grace period" value={counts.grace_period} tone="warning" />
          <Count label="In arrears" value={counts.in_arrears} tone="warning" />
        </dl>

        {/* The same four counts, drawn to scale and in order of severity.
            One hue rather than the four status colours: `success` and
            `warning` separate by ΔE 5.8 under protanopia, so a reader with
            the commonest form of colour blindness could not tell a grace
            period from arrears by colour. The row label carries the identity;
            the bar carries the magnitude. */}
        <MagnitudeChart
          className="mt-4"
          title="How the delinquent loans are spread"
          caption="Loans by delinquency state, worst first. Each loan is in exactly one state."
          valueHeading="Loans"
          format="count"
          empty="Nothing is behind."
          rows={[
            { label: 'Penalty due', value: counts.penalty_due, emphasis: true },
            { label: 'Expired, unpaid', value: counts.expired_unpaid, emphasis: true },
            { label: 'Grace period', value: counts.grace_period },
            { label: 'In arrears', value: counts.in_arrears },
          ]}
        />
      </Card>

      {/* --- Filters ----------------------------------------------------- */}
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
              <label htmlFor="overdue-search" className="sr-only">
                Search overdue loans by loan number
              </label>
              <Input
                id="overdue-search"
                type="search"
                placeholder="Loan number"
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
              <label htmlFor="overdue-state" className="text-text-muted block text-sm">
                State
              </label>
              <select
                id="overdue-state"
                className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 rounded-lg border px-3 focus-visible:outline-2 focus-visible:outline-offset-2"
                value={params.get('state') ?? 'all'}
                onChange={(event) => {
                  apply({ state: event.target.value });
                }}
              >
                <option value="all">Everything behind</option>
                {FILTERABLE_STATES.map((state) => (
                  <option key={state} value={state}>
                    {DELINQUENCY_STATE_LABELS[state]}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-w-0">
              <label htmlFor="overdue-days" className="text-text-muted block text-sm">
                At least this many days late
              </label>
              <Input
                id="overdue-days"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                defaultValue={params.get('days') ?? ''}
                onChange={(event) => {
                  apply({ days: event.target.value });
                }}
              />
            </div>
          </div>
        </form>
      </Card>

      {loans.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No loans match. That is not the same as nothing being overdue — try clearing
            the filters.
          </p>
        </Card>
      ) : (
        <>
          {/* Phones: one card per loan.

              The card is tappable anywhere, and the phone number dials. Those
              two wants are in tension: an `<a href="tel:">` inside the card's
              own `<a>` is a nested anchor, which is invalid HTML. The browser
              does not render it as written — the parser closes the outer
              anchor at the inner one — so the server's markup and React's tree
              disagree and hydration fails (React #418), after which everything
              below the phone number stops opening the loan. Stopping the click
              from propagating does not help, because the damage is done by the
              parser before any handler exists.

              So the card is a plain element with one link stretched across it,
              and the phone number sits above that link on its own. Both
              targets work, the HTML is valid, and the tap area is unchanged. */}
          <ul className="min-w-0 space-y-2 md:hidden">
            {loans.map((loan) => (
              <li key={loan.loanId} className="min-w-0">
                <div className="record-surface focus-within:outline-accent relative min-w-0 rounded-lg p-3 focus-within:outline-2 focus-within:outline-offset-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <RowLink
                      href={`${ROUTES.loans}/${loan.loanId}`}
                      // The stretched link: it covers the card, so a tap
                      // anywhere that is not another control opens the loan.
                      // `before:` keeps the overlay out of the accessibility
                      // tree as a second element — it is this link's own box.
                      className="text-text font-medium break-words before:absolute before:inset-0 before:content-['']"
                    >
                      {loan.clientName}
                    </RowLink>
                    <span className="text-text font-semibold tabular-nums">
                      <Money amount={loan.totalOutstanding} />
                    </span>
                  </div>
                  <div className="text-text-muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono">{loan.loanNumber}</span>
                    {/* Above the stretched link, so dialling wins over
                        opening the loan. */}
                    <PhoneValue
                      value={loan.clientPhone}
                      linked
                      className="text-accent relative"
                    />
                    <DelinquencyBadge state={loan.state} />
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div>
                      <dt className="text-text-muted">Due now</dt>
                      <dd className="text-text tabular-nums">
                        <Money amount={loan.currentDue} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">Days late</dt>
                      <dd className="text-text tabular-nums">{loan.daysPastDue}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>

          {/* Tablet and up: the columns fit. Nine of them; the two a
              collections officer can work without — the missed count and the
              final due date, both on the loan's own page — step out below
              `xl`. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Overdue loans" density="compact">
              <thead>
                <tr>
                  <TableHead width="name">Borrower</TableHead>
                  <TableHead width="phone">Phone</TableHead>
                  <TableHead width="ref">Loan</TableHead>
                  <TableHead width="money" align="numeric">
                    Due now
                  </TableHead>
                  <TableHead width="money-wide" align="numeric">
                    Outstanding
                  </TableHead>
                  <TableHead width="count" align="numeric" hideBelow="xl">
                    Missed
                  </TableHead>
                  <TableHead width="count" align="numeric">
                    Days late
                  </TableHead>
                  <TableHead width="date" hideBelow="xl">
                    Final due
                  </TableHead>
                  <TableHead width="status">State</TableHead>
                </tr>
              </thead>
              <tbody>
                {loans.map((loan) => (
                  <TableRow key={loan.loanId}>
                    <TableCell header width="name" wrap="clamp" className="font-normal">
                      <span className="block min-w-0">
                        <RowLink
                          href={`${ROUTES.clients}/${loan.clientId}`}
                          className="text-accent focus-visible:outline-accent line-clamp-2 break-words underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                          title={loan.clientName}
                        >
                          {loan.clientName}
                        </RowLink>
                        <span className="text-text-muted mt-0.5 block font-mono text-[10px] whitespace-nowrap">
                          {loan.clientNumber}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell width="phone" className="text-text-muted">
                      <PhoneValue value={loan.clientPhone} linked />
                    </TableCell>
                    <TableCell width="ref">
                      <RowLink
                        href={`${ROUTES.loans}/${loan.loanId}`}
                        className="text-accent focus-visible:outline-accent font-mono underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {loan.loanNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell
                      width="money"
                      align="numeric"
                      className="text-text font-medium"
                    >
                      <Money amount={loan.currentDue} />
                    </TableCell>
                    {/* The one cell allowed extra lines: a penalty note under
                        the figure is the reason the officer is looking. */}
                    <TableCell width="money-wide" align="numeric" className="text-text">
                      <Money amount={loan.totalOutstanding} />
                      {loan.penaltyRemaining > 0 ? (
                        <span className="text-danger block text-[10px] whitespace-nowrap">
                          incl. <Money amount={loan.penaltyRemaining} /> penalty
                        </span>
                      ) : null}
                      {loan.penaltyEligible ? (
                        <span className="text-danger block text-[10px] whitespace-nowrap">
                          + <Money amount={loan.penaltyProjectedAmount} /> penalty pending
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell
                      width="count"
                      align="numeric"
                      hideBelow="xl"
                      className="text-text-muted"
                    >
                      {loan.missedInstallmentCount}
                    </TableCell>
                    <TableCell width="count" align="numeric" className="text-text-muted">
                      {loan.daysPastDue}
                    </TableCell>
                    <TableCell width="date" hideBelow="xl" className="text-text-muted">
                      {loan.scheduledCompletionDate === null ? (
                        <NotRecorded />
                      ) : (
                        <DateValue value={loan.scheduledCompletionDate} />
                      )}
                    </TableCell>
                    <TableCell width="status">
                      <DelinquencyBadge state={loan.state} />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}

      <RegisterPagination page={page} hasMore={hasMore} />
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'danger' | 'warning';
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd
        className={`text-2xl font-semibold tabular-nums ${
          value === 0
            ? 'text-text-muted'
            : tone === 'danger'
              ? 'text-danger'
              : 'text-warning'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
