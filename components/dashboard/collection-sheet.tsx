import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { ReportEmpty } from '@/components/reports/report-empty';
import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { ROUTES } from '@/config/app';
import { formatUgx } from '@/lib/domain/money';
import { COLLECTION_STATUS_LABELS, type CollectionStatus } from '@/lib/domain/reporting';
import type { CollectionSheetRow } from '@/lib/data/dashboard';
import { PhoneValue } from '@/components/ui/data-value';

const STATUS_TONES: Readonly<Record<CollectionStatus, 'warning' | 'info' | 'success'>> = {
  unpaid: 'warning',
  part_paid: 'info',
  paid: 'success',
};

/**
 * Who is due today, and whether they have paid.
 *
 * ## A prepaid collection is never on this list
 *
 * The underlying view excludes a collection already covered before today, so a
 * borrower who paid ahead last week does not appear. Sending somebody to
 * collect from a client who owes nothing today is the sort of error that loses
 * a customer, and §130 is explicit about it.
 *
 * ## It links to the existing payment form
 *
 * "Collect" is a link to `/payments/new`, prefilled with the loan. There is no
 * payment logic here and no second posting path: `post_payment` remains the
 * only writer, with its own minimum, overpayment and idempotency rules. A
 * report may start a workflow; it may not reimplement one.
 */
export function CollectionSheet({
  rows,
  canCollect,
}: {
  readonly rows: readonly CollectionSheetRow[];
  readonly canCollect: boolean;
}) {
  if (rows.length === 0) {
    return (
      <ReportEmpty
        title="Nothing is due today"
        description="No loan has a collection falling due today that is not already covered. Collections paid ahead are not listed."
      />
    );
  }

  const columns: readonly ReportColumn<CollectionSheetRow>[] = [
    {
      key: 'client',
      header: 'Client',
      primary: true,
      cell: (row) => (
        <Link
          href={`${ROUTES.clients}/${row.clientId}`}
          className="text-brand-700 hover:underline"
        >
          {row.clientName === '' ? row.clientNumber : row.clientName}
        </Link>
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      cell: (row) => <PhoneValue value={row.clientPhone} />,
    },
    {
      key: 'loan',
      header: 'Loan',
      cell: (row) => (
        <Link
          href={`${ROUTES.loans}/${row.loanId}`}
          className="text-brand-700 font-mono hover:underline"
        >
          {row.loanNumber}
        </Link>
      ),
    },
    {
      key: 'expected',
      header: 'Due today',
      numeric: true,
      cell: (row) => formatUgx(row.expectedToday, { withCurrency: false }),
    },
    {
      key: 'arrears',
      header: 'Past unpaid',
      numeric: true,
      cell: (row) => formatUgx(row.arrearsAmount, { withCurrency: false }),
    },
    {
      key: 'current',
      header: 'Current due',
      numeric: true,
      cell: (row) => formatUgx(row.currentDue, { withCurrency: false }),
    },
    {
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      hideOnMobile: true,
      cell: (row) => formatUgx(row.totalOutstanding, { withCurrency: false }),
    },
    {
      key: 'status',
      header: 'Payment status',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONES[row.collectionStatus]}>
            {COLLECTION_STATUS_LABELS[row.collectionStatus]}
          </Badge>
          <DelinquencyBadge state={row.state} />
        </span>
      ),
    },
    ...(canCollect
      ? [
          {
            key: 'action',
            header: 'Action',
            cell: (row: CollectionSheetRow) => (
              <Link
                href={`${ROUTES.payments}/new?loanId=${row.loanId}`}
                className="text-brand-700 hover:underline"
              >
                Collect
              </Link>
            ),
          },
        ]
      : []),
  ];

  return (
    <ReportTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.loanId}
      caption="Loans with a collection due today, the amount due and whether it has been paid"
      rowTone={(row) => (row.collectionStatus === 'paid' ? 'muted' : undefined)}
    />
  );
}
