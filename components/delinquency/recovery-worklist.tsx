import { StatusText, type StatusTone } from '@/components/ui/status-text';
import { CalendarCheck, Handshake, ShieldCheck } from 'lucide-react';

import { EmptyState } from '@/components/ui/states';
import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { ROUTES } from '@/config/app';
import {
  PROMISE_STATUS_LABELS,
  RECOVERY_ACTION_KIND_LABELS,
  type PromiseStatus,
} from '@/lib/domain/security';
import type { RecoveryAction, RecoveryStatusRow } from '@/lib/data/security';

/**
 * The follow-up worklist and the promise register.
 *
 * Both are tables of loans somebody has already touched, which is what makes
 * them different from the aging register above them. Aging says which loans are
 * late; these two say which ones are *being worked*, and where that work has
 * reached — the thing a supervisor cannot see from an arrears figure.
 */

/** Loans whose follow-up date has passed without another action being recorded. */
export function FollowUpWorklist({
  rows,
}: {
  readonly rows: readonly RecoveryStatusRow[];
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title="No follow-up is outstanding"
        description="Follow-ups appear here on the day after they were due."
      />
    );
  }

  return (
    <DataTable caption="Loans with an overdue follow-up" density="compact">
      <thead>
        <tr>
          <TableHead width="name">Borrower</TableHead>
          <TableHead width="phone">Phone</TableHead>
          <TableHead width="ref">Loan</TableHead>
          <TableHead width="money" align="numeric">
            Arrears
          </TableHead>
          <TableHead width="count" align="numeric">
            Days
          </TableHead>
          <TableHead width="date">Follow-up was due</TableHead>
          <TableHead width="prose">Last done</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <TableRow key={row.loanId}>
            <TableCell header width="name" wrap="wrap">
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
              <PhoneValue value={row.clientPhone} linked className="text-accent" />
            </TableCell>
            <TableCell width="ref" className="text-text font-mono">
              {row.loanNumber}
            </TableCell>
            <TableCell width="money" align="numeric" className="text-text">
              {row.arrearsAmount === null ? (
                <NotRecorded />
              ) : (
                <Money amount={row.arrearsAmount} />
              )}
            </TableCell>
            <TableCell width="count" align="numeric" className="text-text">
              {row.daysPastDue ?? 0}
            </TableCell>
            <TableCell width="date" className="text-danger">
              {row.overdueFollowUpOn === null ? (
                <NotRecorded />
              ) : (
                <DateValue value={row.overdueFollowUpOn} />
              )}
            </TableCell>
            <TableCell width="prose" wrap="wrap" className="text-text-muted">
              {row.lastActionKind === null
                ? 'Nothing'
                : RECOVERY_ACTION_KIND_LABELS[row.lastActionKind]}
              {row.lastActionDate === null ? null : (
                <span className="block text-[10px]">
                  <DateValue value={row.lastActionDate} />
                  {row.lastActionBy === null ? '' : ` · ${row.lastActionBy}`}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </tbody>
    </DataTable>
  );
}

const PROMISE_TONES: Readonly<Record<PromiseStatus, StatusTone>> = {
  pending: 'attention',
  kept: 'positive',
  broken: 'critical',
};

/**
 * Promises to pay.
 *
 * The "paid in the window" column is the one that makes the register useful:
 * it says *why* a promise reads as kept or not kept, from the posted payments,
 * so nobody has to take the verdict on trust. A reversal moves this column and
 * the verdict together, because both are the same question asked of the same
 * rows.
 */
export function PromiseRegister({
  promises,
}: {
  readonly promises: readonly RecoveryAction[];
}) {
  if (promises.length === 0) {
    return (
      <EmptyState
        icon={Handshake}
        title="No promise to pay has been recorded"
        description="One is taken from a loan's recovery panel."
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <DataTable caption="Promises to pay" density="compact">
        <thead>
          <tr>
            <TableHead width="name">Borrower</TableHead>
            <TableHead width="ref">Loan</TableHead>
            <TableHead width="money" align="numeric">
              Promised
            </TableHead>
            <TableHead width="date">By</TableHead>
            <TableHead width="money" align="numeric">
              Paid in the window
            </TableHead>
            <TableHead width="status">Verdict</TableHead>
            <TableHead width="name">Taken by</TableHead>
          </tr>
        </thead>
        <tbody>
          {promises.map((promise) => (
            <TableRow key={promise.id}>
              <TableCell header width="name" wrap="clamp">
                <RowLink
                  href={`${ROUTES.loans}/${promise.loanId}`}
                  className="text-brand-700 line-clamp-2 break-words hover:underline"
                  title={promise.clientName}
                >
                  {promise.clientName}
                </RowLink>
              </TableCell>
              <TableCell width="ref" className="text-text font-mono">
                {promise.loanNumber}
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                {promise.promisedAmount === null ? (
                  <NotRecorded />
                ) : (
                  <Money amount={promise.promisedAmount} />
                )}
              </TableCell>
              <TableCell width="date" className="text-text">
                {promise.promisedOn === null ? (
                  <NotRecorded />
                ) : (
                  <DateValue value={promise.promisedOn} />
                )}
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                {promise.promisePaidAmount === null ? (
                  <NotRecorded />
                ) : (
                  <Money amount={promise.promisePaidAmount} />
                )}
              </TableCell>
              <TableCell width="status">
                {promise.promiseStatus === null ? (
                  <NotRecorded />
                ) : (
                  <StatusText tone={PROMISE_TONES[promise.promiseStatus]}>
                    {PROMISE_STATUS_LABELS[promise.promiseStatus]}
                  </StatusText>
                )}
              </TableCell>
              <TableCell width="name" wrap="clamp" className="text-text-muted">
                {promise.createdByLabel}
                <span className="block text-[10px]">
                  <DateValue value={promise.actionDate} />
                </span>
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </DataTable>

      <p className="text-text-muted mt-3 text-sm">
        A promise changes nothing contractual — no due date, no arrears figure, no
        penalty. Whether it was kept is read from the payments posted between the day it
        was given and the day it was for, so a reversal un-keeps one on its own.
      </p>
    </div>
  );
}

/** The security register across the book. */
export function CollateralRegister({
  items,
}: {
  readonly items: readonly {
    readonly id: string;
    readonly loanId: string;
    readonly loanNumber: string;
    readonly clientName: string;
    readonly productCode: string;
    readonly itemTypeLabel: string;
    readonly description: string;
    readonly estimatedValue: number;
    readonly valuedOn: string;
    readonly statusLabel: string;
    readonly totalOutstanding: number | null;
  }[];
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No security has been recorded"
        description="Items are recorded from a loan's own security panel."
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3">
      <DataTable caption="Security held" density="compact">
        <thead>
          <tr>
            <TableHead width="name">Borrower</TableHead>
            <TableHead width="ref">Loan</TableHead>
            <TableHead width="prose">Item</TableHead>
            <TableHead width="money" align="numeric">
              Valued at
            </TableHead>
            <TableHead width="date">Valued on</TableHead>
            <TableHead width="status">Status</TableHead>
            <TableHead width="money" align="numeric">
              Loan owes
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <TableRow key={item.id}>
              <TableCell header width="name" wrap="clamp">
                <RowLink
                  href={`${ROUTES.loans}/${item.loanId}`}
                  className="text-brand-700 line-clamp-2 break-words hover:underline"
                  title={item.clientName}
                >
                  {item.clientName}
                </RowLink>
              </TableCell>
              <TableCell width="ref" className="text-text font-mono">
                {item.loanNumber}
                <span className="text-text-muted mt-0.5 block font-sans text-[10px] font-normal whitespace-nowrap">
                  {item.productCode}
                </span>
              </TableCell>
              {/* The one genuinely prose column here: a description of a
                  motorcycle or a plot of land is not a value to scan, so it
                  wraps rather than widening the table for every other row. */}
              <TableCell width="prose" wrap="wrap" className="text-text">
                {item.itemTypeLabel}
                <span className="text-text-muted block text-[10px]">
                  {item.description}
                </span>
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                <Money amount={item.estimatedValue} />
              </TableCell>
              <TableCell width="date" className="text-text">
                <DateValue value={item.valuedOn} />
              </TableCell>
              <TableCell width="status" className="text-text">
                {item.statusLabel}
              </TableCell>
              <TableCell width="money" align="numeric" className="text-text">
                {item.totalOutstanding === null ? (
                  <NotRecorded />
                ) : (
                  <Money amount={item.totalOutstanding} />
                )}
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </DataTable>

      <p className="text-text-muted mt-3 text-sm">
        A valuation is a judgement recorded on a date, not a figure any balance is
        computed from. Realising an item reduces a loan only through the payment the sale
        produces.
      </p>
    </div>
  );
}
