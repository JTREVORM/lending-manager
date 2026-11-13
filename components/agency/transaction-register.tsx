import Link from 'next/link';

import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { EmptyTableRow } from '@/components/ui/states';
import { AgencyDirectionBadge, AgencyStatusBadge } from '@/components/agency/badges';
import type { AgencyTransactionRow } from '@/lib/domain/agency';

/**
 * The agency transaction register.
 *
 * Shared by the pending queue and the history screen, which differ only in
 * which statuses they ask the database for. Every money column is a `Money`,
 * which formats from the exact integer — nothing here adds anything up.
 *
 * The table scrolls horizontally inside its labelled region on a narrow
 * screen rather than dropping columns: a counter officer checking a disputed
 * transaction needs the provider reference and the amount side by side, and a
 * layout that hid the reference would send them to a desktop to settle it.
 */
export function AgencyTransactionRegister({
  rows,
  caption,
  emptyMessage,
}: {
  readonly rows: readonly AgencyTransactionRow[];
  readonly caption: string;
  readonly emptyMessage: string;
}) {
  return (
    <DataTable caption={caption} stickyHeader>
      <thead>
        <tr>
          <TableHead width="date">Date</TableHead>
          <TableHead width="name">Provider &amp; service</TableHead>
          <TableHead width="name">Customer</TableHead>
          <TableHead align="numeric" width="money">
            Amount
          </TableHead>
          <TableHead align="numeric" width="money">
            Fee
          </TableHead>
          <TableHead align="numeric" width="money">
            Commission
          </TableHead>
          <TableHead width="ref">Reference</TableHead>
          <TableHead width="ref">Branch</TableHead>
          <TableHead width="name">Status</TableHead>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyTableRow colSpan={9}>{emptyMessage}</EmptyTableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell header>
                <DateValue value={row.transactionDate} />
              </TableCell>
              <TableCell>
                <Link
                  href={`/agency/history/${row.id}`}
                  className="text-brand font-medium hover:underline"
                >
                  {row.providerName}
                </Link>
                <span className="text-text-muted mt-0.5 block text-[10px]">
                  {row.typeName} <AgencyDirectionBadge direction={row.direction} />
                </span>
              </TableCell>
              <TableCell>{row.customerIdentifier ?? '—'}</TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.principalAmount} />
                </span>
              </TableCell>
              <TableCell align="numeric">
                <span className="tabular-nums">
                  <Money amount={row.customerFee} />
                </span>
              </TableCell>
              <TableCell align="numeric">
                {row.commissionAmount === null ? (
                  <span className="text-text-muted">—</span>
                ) : (
                  <span className="tabular-nums">
                    <Money amount={row.commissionAmount} />
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{row.providerReference ?? '—'}</span>
              </TableCell>
              <TableCell>{row.branchCode}</TableCell>
              <TableCell>
                <AgencyStatusBadge status={row.status} />
                {row.commissionExceptionReason === null ? null : (
                  <span className="text-text-muted mt-0.5 block text-[10px]">
                    Commission difference authorised
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))
        )}
      </tbody>
    </DataTable>
  );
}
