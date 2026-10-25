import { FileText } from 'lucide-react';

import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/states';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import type { StatementLine } from '@/lib/data/savings';
import { SavingsKindBadge } from './savings-badges';

/**
 * A savings statement: every movement, with the balance after each.
 *
 * ## The running balance is the database's, not this component's
 *
 * Each row carries `runningBalance`, computed by `savings_statement` over the
 * whole account in one chronological order, with the period filter applied
 * afterwards. So a statement for March opens at the balance March actually
 * opened at rather than at zero — and the figure on this screen, the figure in
 * an export and the figure on a printed copy are the same figure rather than
 * three renderings that each sorted the rows for themselves.
 *
 * Adding the amounts up here instead would be a second implementation of the
 * same arithmetic, and the one that drifts is the one somebody hands to a
 * member.
 *
 * ## A reversal is a row
 *
 * A corrected deposit appears twice: the original, untouched, and a contra row
 * naming it and carrying the reason. That is deliberate — marking the original
 * "reversed" would mean a statement printed last week no longer agreed with
 * this one, and the member would have no way to see that a correction had been
 * made at all.
 *
 * Printed deliberately plainly: `print:hidden` is left off the table, because
 * this is the screen a member is handed a copy of.
 */
export function SavingsStatementTable({
  lines,
  accountNumber,
}: {
  readonly lines: readonly StatementLine[];
  readonly accountNumber: string;
}) {
  if (lines.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No movements in this period"
        description="Nothing has been paid in or taken out of this account between these dates. Widen the period, or clear the dates to see everything."
      />
    );
  }

  return (
    <>
      {/* Phone: cards. A six-column statement at 390px is unreadable, and this
          is the screen a member looks over somebody's shoulder at. */}
      <ul className="space-y-2 md:hidden">
        {lines.map((line) => (
          <li key={line.transactionId} className="record-surface min-w-0 rounded-lg p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-text text-sm font-medium break-words">
                  {line.description}
                </p>
                <p className="text-text-muted font-mono text-xs">
                  {line.transactionNumber} · <DateValue value={line.valueDate} />
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={
                    line.deposit > 0
                      ? 'text-success text-sm font-semibold tabular-nums'
                      : 'text-text text-sm font-semibold tabular-nums'
                  }
                >
                  {line.deposit > 0 ? '+' : '−'}
                  <Money
                    amount={line.deposit > 0 ? line.deposit : line.withdrawal}
                    variant="bare"
                  />
                </p>
                <p className="text-text-muted text-xs tabular-nums">
                  <Money amount={line.runningBalance} />
                </p>
              </div>
            </div>
            {line.reversalReason === null ? null : (
              <p className="text-text-muted mt-1.5 text-xs break-words">
                {line.reversalReason}
              </p>
            )}
          </li>
        ))}
      </ul>

      {/* Tablet and up, and print: the statement proper. */}
      <div className="hidden min-w-0 md:block">
        <DataTable
          caption={`Savings statement for account ${accountNumber}, oldest movement first`}
        >
          <thead>
            <tr>
              <TableHead width="date">Date</TableHead>
              <TableHead width="ref">Reference</TableHead>
              <TableHead width="prose">Description</TableHead>
              <TableHead width="status" hideBelow="xl">
                Method
              </TableHead>
              <TableHead width="money" align="numeric">
                In
              </TableHead>
              <TableHead width="money" align="numeric">
                Out
              </TableHead>
              <TableHead width="money-wide" align="numeric">
                Balance
              </TableHead>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <TableRow key={line.transactionId}>
                <TableCell width="date" className="text-text-muted">
                  <DateValue value={line.valueDate} />
                </TableCell>
                <TableCell width="ref" className="font-mono">
                  {line.transactionNumber}
                </TableCell>
                <TableCell width="prose" wrap="wrap">
                  <span className="text-text">{line.description}</span>
                  {line.reversalReason === null ? null : (
                    <span className="text-text-muted block text-xs">
                      {line.reversalReason}
                    </span>
                  )}
                  {/* The badge sits under the description rather than in a
                      column of its own: four kinds across a column of
                      hundreds of deposits is a column of one repeated word. */}
                  {line.kind === 'deposit' ? null : (
                    <span className="mt-1 inline-block">
                      <SavingsKindBadge kind={line.kind} />
                    </span>
                  )}
                </TableCell>
                <TableCell width="status" hideBelow="xl" className="text-text-muted">
                  {line.paymentMethod === null ? (
                    <NotRecorded />
                  ) : (
                    <>
                      {PAYMENT_METHOD_LABELS[line.paymentMethod]}
                      {line.externalReference === null ? null : (
                        <span className="block font-mono text-xs">
                          {line.externalReference}
                        </span>
                      )}
                    </>
                  )}
                </TableCell>
                <TableCell width="money" align="numeric">
                  {line.deposit > 0 ? (
                    <Money amount={line.deposit} tone="success" />
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </TableCell>
                <TableCell width="money" align="numeric">
                  {line.withdrawal > 0 ? (
                    <Money amount={line.withdrawal} />
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </TableCell>
                <TableCell width="money-wide" align="numeric">
                  <Money amount={line.runningBalance} weight="semibold" />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </DataTable>
      </div>
    </>
  );
}
