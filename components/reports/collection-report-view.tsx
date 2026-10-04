import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ReportEmpty } from '@/components/reports/report-empty';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { ROUTES } from '@/config/app';
import { formatBusinessDate, formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { MAX_EXPORT_ROWS } from '@/lib/domain/reporting';
import type { CollectionReport, DayTotals } from '@/lib/data/reports';

/**
 * The collection report: the payments, the totals and the breakdowns.
 *
 * ## Why the totals and the table cannot disagree
 *
 * They are derived from the same array. The data layer runs one query for the
 * whole filtered set, sums it, groups it by day, week and month, and slices the
 * page out of it — so the summary cards, the three breakdown tables, the row
 * list and the CSV are four renderings of one result rather than four queries
 * that happen to share a filter. Parity is structural, not something a test
 * has to keep catching.
 *
 * ## Reversed payments: listed, never counted
 *
 * Every reversal stays in the table with its amount struck through and a
 * reason. The totals sum `effectiveAmount`, which the database sets to zero
 * once a payment is withdrawn, so no total includes money the business gave
 * back. Hiding the row would make a reversal look like a payment that never
 * happened; counting it would make withdrawn money look collected.
 *
 * ## The gross figure is labelled as what it is
 *
 * `grossAmount` appears only when something in the range was reversed, and it
 * is named "recorded, including reversed" rather than anything that could be
 * mistaken for takings.
 */
export function CollectionReportView({
  report,
  timeZone,
}: {
  readonly report: CollectionReport;
  readonly timeZone: string;
}) {
  const { totals } = report;

  const columns: readonly ReportColumn<CollectionReport['page']['rows'][number]>[] = [
    {
      key: 'payment',
      header: 'Payment',
      primary: true,
      cell: (row) => (
        <Link
          href={`${ROUTES.payments}/${row.paymentId}`}
          className="text-brand-700 font-mono hover:underline"
        >
          {row.paymentNumber}
        </Link>
      ),
    },
    {
      key: 'when',
      header: 'Received',
      cell: (row) => formatInstant(row.receivedAt, { timeZone }),
    },
    {
      key: 'client',
      header: 'Client',
      cell: (row) => (
        <Link
          href={`${ROUTES.clients}/${row.clientId}`}
          className="text-brand-700 hover:underline"
        >
          {/* The name recorded on the receipt, so the report and the receipt
              cannot disagree about who paid. */}
          {row.clientNameAtPayment}
        </Link>
      ),
    },
    {
      key: 'loan',
      header: 'Loan',
      cell: (row) =>
        row.loanNumber === null ? (
          '—'
        ) : (
          <Link
            href={`${ROUTES.loans}/${row.loanId}`}
            className="text-brand-700 font-mono hover:underline"
          >
            {row.loanNumber}
          </Link>
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      cell: (row) => (
        <span className={row.isEffective ? '' : 'line-through'}>
          {formatUgx(row.amount, { withCurrency: false })}
        </span>
      ),
    },
    {
      key: 'method',
      header: 'Method',
      cell: (row) => PAYMENT_METHOD_LABELS[row.paymentMethod],
    },
    {
      key: 'by',
      header: 'Recorded by',
      hideOnMobile: true,
      cell: (row) => row.recordedByLabel,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.isEffective ? (
          <Badge tone="success">Posted</Badge>
        ) : (
          <span className="flex min-w-0 flex-col gap-1">
            <Badge tone="danger">Reversed</Badge>
            {row.reversalReason === null ? null : (
              <span className="text-text-muted text-xs break-words">
                {row.reversalReason}
              </span>
            )}
          </span>
        ),
    },
  ];

  return (
    <div className="min-w-0 space-y-5">
      {report.truncated ? (
        <Alert tone="warning" title="Too many payments for one report">
          This range matches more than {String(MAX_EXPORT_ROWS)} payments, so the totals
          below would describe only part of it. Narrow the dates or add a filter, and the
          figures will be complete again.
        </Alert>
      ) : null}

      <StatGrid>
        <StatCard
          label="Collected"
          value={formatUgx(totals.collected)}
          secondary={`${String(totals.paymentCount)} ${totals.paymentCount === 1 ? 'payment' : 'payments'}`}
          metric="total_collected"
          tone="success"
        />
        <StatCard
          label="Cash received"
          value={formatUgx(totals.byMethod.cash)}
          secondary={`${String(totals.countByMethod.cash)} payments`}
          metric="cash_received"
        />
        <StatCard
          label="MTN received"
          value={formatUgx(totals.byMethod.mtn_mobile_money)}
          secondary={`${String(totals.countByMethod.mtn_mobile_money)} payments`}
          metric="mtn_received"
        />
        <StatCard
          label="Airtel received"
          value={formatUgx(totals.byMethod.airtel_money)}
          secondary={`${String(totals.countByMethod.airtel_money)} payments`}
          metric="airtel_received"
        />
      </StatGrid>

      <StatGrid>
        <StatCard
          label="Principal collected"
          value={formatUgx(totals.principalCollected)}
          metric="principal_collected"
        />
        <StatCard
          label="Interest collected"
          value={formatUgx(totals.interestCollected)}
          metric="interest_collected"
        />
        <StatCard
          label="Penalty collected"
          value={formatUgx(totals.penaltyCollected)}
          metric="penalty_collected"
        />
        {totals.reversedCount > 0 ? (
          <StatCard
            label="Reversed"
            value={formatUgx(totals.reversedAmount)}
            secondary={`${String(totals.reversedCount)} withdrawn · ${formatUgx(totals.grossAmount)} recorded, including reversed`}
            definition="Payments recorded in this range and since withdrawn. Excluded from every collection total above."
            tone="danger"
          />
        ) : null}
      </StatGrid>

      <p className="text-text-muted text-sm">
        Cash, MTN and Airtel add up to the collected total, because every payment has
        exactly one method. Principal, interest and penalty collected also add up to it,
        because every shilling received is applied to one of the three.
      </p>

      {report.byDay.length > 1 ? (
        <Breakdown
          title="By day"
          rows={report.byDay}
          label={(key) =>
            formatBusinessDate(key as Parameters<typeof formatBusinessDate>[0])
          }
        />
      ) : null}

      {report.byWeek.length > 1 ? (
        <Breakdown
          title="By week"
          rows={report.byWeek}
          label={(key) =>
            `Week of ${formatBusinessDate(key as Parameters<typeof formatBusinessDate>[0])}`
          }
        />
      ) : null}

      {report.byMonth.length > 1 ? (
        <Breakdown
          title="By month"
          rows={report.byMonth}
          label={(key) => monthLabel(key)}
        />
      ) : null}

      <section aria-labelledby="payments-heading" className="min-w-0 space-y-3">
        <h2 id="payments-heading" className="text-base">
          Payments
        </h2>

        {report.page.rows.length === 0 ? (
          <ReportEmpty
            title="No payments in this range"
            description="Nothing was recorded between these dates with the filters you chose. Try a wider range."
          />
        ) : (
          <ReportTable
            columns={columns}
            rows={report.page.rows}
            rowKey={(row) => row.paymentId}
            caption="Payments received, with the client, loan, amount, method, who recorded it and its status"
            rowTone={(row) => (row.isEffective ? undefined : 'muted')}
          />
        )}
      </section>
    </div>
  );
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  const date = new Date(Date.UTC(Number(year ?? '1970'), Number(month ?? '1') - 1, 1));
  return new Intl.DateTimeFormat('en-UG', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/**
 * A day, week or month breakdown.
 *
 * Shown only when there is more than one bucket: a single-day report whose
 * "by day" table repeats the summary card is noise, and noise on a financial
 * screen makes the real figures harder to find.
 */
function Breakdown({
  title,
  rows,
  label,
}: {
  readonly title: string;
  readonly rows: readonly DayTotals[];
  readonly label: (key: string) => string;
}) {
  const columns: readonly ReportColumn<DayTotals>[] = [
    { key: 'when', header: title, primary: true, cell: (row) => label(row.key) },
    {
      key: 'collected',
      header: 'Collected',
      numeric: true,
      cell: (row) => formatUgx(row.collected, { withCurrency: false }),
    },
    {
      key: 'count',
      header: 'Payments',
      numeric: true,
      cell: (row) => String(row.paymentCount),
    },
    {
      key: 'cash',
      header: 'Cash',
      numeric: true,
      cell: (row) => formatUgx(row.cash, { withCurrency: false }),
    },
    {
      key: 'mtn',
      header: 'MTN',
      numeric: true,
      cell: (row) => formatUgx(row.mtn, { withCurrency: false }),
    },
    {
      key: 'airtel',
      header: 'Airtel',
      numeric: true,
      cell: (row) => formatUgx(row.airtel, { withCurrency: false }),
    },
    {
      key: 'reversed',
      header: 'Reversed',
      numeric: true,
      hideOnMobile: true,
      cell: (row) =>
        row.reversedCount === 0
          ? '—'
          : formatUgx(row.reversedAmount, { withCurrency: false }),
    },
  ];

  return (
    <section className="min-w-0 space-y-3">
      <h2 className="text-base">{title}</h2>
      <ReportTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        caption={`Collections ${title.toLowerCase()}, with the method split`}
      />
    </section>
  );
}
