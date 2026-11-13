'use client';

import { Badge } from '@/components/ui/badge';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { EmptyTableRow } from '@/components/ui/states';
import type { AgencyFloatTradeRow } from '@/lib/domain/agency';

import { FloatTradeDecision } from './float-trade-forms';

const STATUS_TONE = {
  pending: 'warning',
  posted: 'success',
  rejected: 'neutral',
  reversed: 'danger',
} as const;

const KIND_LABEL = {
  purchase: 'Bought',
  sale: 'Sold',
  transfer: 'Moved',
} as const;

/**
 * The float trade register.
 *
 * ## Why the status column says what it means in words
 *
 * "Pending" is the one an officer must not misread: the row is there, the
 * figures are there, and none of it has touched a balance. The column states
 * that in the cell rather than relying on the colour of the pill, which a
 * printed register loses entirely.
 *
 * ## Why a purchase shows its difference
 *
 * A purchase at face value, one with a premium and one with a discount are
 * three different journals (decision OD-1), and which one was posted is a
 * question somebody will ask about a figure in the expense account. The
 * basis the database recorded is shown, not re-derived here from the amounts.
 */
export function FloatTradeRegister({
  rows,
  canPost,
  canReverse,
}: {
  readonly rows: readonly AgencyFloatTradeRow[];
  readonly canPost: boolean;
  readonly canReverse: boolean;
}) {
  return (
    <DataTable caption="Float trades" stickyHeader>
      <thead>
        <tr>
          <TableHead width="ref">Date</TableHead>
          <TableHead width="name">Line</TableHead>
          <TableHead>What</TableHead>
          <TableHead align="numeric" width="money">
            Float
          </TableHead>
          <TableHead align="numeric" width="money">
            Cash
          </TableHead>
          <TableHead>Reference</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Decision</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={8}>
            No float has been bought, sold or moved on a line you can see.
          </EmptyTableRow>
        ) : (
          rows.map((t) => (
            <TableRow key={t.id}>
              <TableCell>
                <DateValue value={t.tradeDate} />
              </TableCell>
              <TableCell header>
                {t.label ?? t.tillName}
                <span className="text-text-muted ml-2 text-xs">{t.branchCode}</span>
                {t.counterTillName !== null ? (
                  <span className="text-text-muted block text-xs">
                    into {t.counterLabel ?? t.counterTillName}
                    {t.counterBranchCode !== null && t.counterBranchCode !== t.branchCode
                      ? ` at ${t.counterBranchCode}`
                      : ''}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                {KIND_LABEL[t.kind]}
                {t.purchaseBasis !== null ? (
                  <span className="text-text-muted block text-xs">
                    {t.purchaseBasis}
                    {t.purchaseDifference !== null && t.purchaseDifference !== 0 ? (
                      <>
                        {' '}
                        of <Money amount={t.purchaseDifference} />
                      </>
                    ) : null}
                  </span>
                ) : null}
                {t.feeAmount !== null && t.feeAmount > 0 ? (
                  <span className="text-text-muted block text-xs">
                    fee <Money amount={t.feeAmount} />
                  </span>
                ) : null}
              </TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={t.floatAmount} />
                </span>
              </TableCell>
              <TableCell align="numeric">
                {t.cashAmount === null ? (
                  <span className="text-text-muted text-xs">no cash moved</span>
                ) : (
                  <span className="tabular-nums">
                    <Money amount={t.cashAmount} />
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{t.reference}</span>
              </TableCell>
              <TableCell>
                <Badge tone={STATUS_TONE[t.status]}>
                  {t.status === 'pending' ? 'waiting — nothing posted' : t.status}
                </Badge>
              </TableCell>
              <TableCell>
                <FloatTradeDecision trade={t} canPost={canPost} canReverse={canReverse} />
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
