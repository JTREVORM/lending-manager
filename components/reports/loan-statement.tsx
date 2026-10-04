import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import { ROUTES } from '@/config/app';
import { formatBusinessDate, formatInstant } from '@/lib/domain/datetime';
import { formatUgx } from '@/lib/domain/money';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { formatBps, toBps } from '@/lib/domain/rate';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';
import type {
  LoanStatement,
  StatementPaymentRow,
  StatementScheduleRow,
} from '@/lib/data/reports';

/**
 * A loan statement: the agreement, the plan, the payments and the balance.
 *
 * ## Which name the header carries, and why it is a decision
 *
 * The borrower as they were when the loan was written, from the loan's own
 * immutable snapshot, with the current name shown beside it when the two
 * differ. A statement is a historical document about an agreement: a borrower
 * who changed their name last month did not change who signed in March, and
 * silently rewriting the header would make the statement disagree with the
 * paper the client holds. Phase 4 captured the snapshot for exactly this, and
 * §33 asks for the choice to be made deliberately rather than by whichever
 * column was to hand.
 *
 * Each payment line likewise shows the name recorded on its own receipt, so a
 * statement and the receipts it lists cannot contradict each other.
 *
 * ## Business-friendly labels, no internal vocabulary
 *
 * "Amount borrowed", "Total interest", "Amount paid", "Outstanding balance",
 * "Current amount due", "Past unpaid amount", "Late-payment charge", "Loan
 * completion date". Nothing says obligation, allocation, basis points or
 * delinquency state. §11 asks for this in the portal; there is no reason the
 * staff copy should read differently, and one version is one thing to get
 * right.
 *
 * ## What a borrower's copy leaves out
 *
 * Who recorded each payment, and internal references. Staff attribution is
 * internal information about the business's own people; the borrower needs the
 * receipt number, the date and the amount. Internal remarks are not on this
 * page for anybody — they live on the client record behind
 * `clients:remarks_view`.
 *
 * ## It is a current statement, not an as-at one
 *
 * The balance is today's. Nothing here implies the figures are frozen at a
 * date, because they are not: a reversal tomorrow changes them, and Phase 8
 * builds no historical balance reporting (§106). The header says "as at" with
 * today's date for that reason.
 */
export function LoanStatementView({
  statement,
  audience,
  companyName,
  businessDate,
  timeZone,
}: {
  readonly statement: LoanStatement;
  readonly audience: 'staff' | 'client';
  readonly companyName: string;
  readonly businessDate: string;
  readonly timeZone: string;
}) {
  const { loan, schedule, payments, penalty } = statement;
  const forClient = audience === 'client';

  const nameChanged =
    loan.clientNameAtOrigination !== null &&
    loan.clientName !== null &&
    loan.clientNameAtOrigination !== loan.clientName;

  const scheduleColumns: readonly ReportColumn<StatementScheduleRow>[] = [
    {
      key: 'number',
      header: 'No.',
      primary: true,
      cell: (row) => `Payment ${String(row.installmentNumber)}`,
    },
    { key: 'due', header: 'Date due', cell: (row) => formatBusinessDate(row.dueDate) },
    {
      key: 'expected',
      header: 'Amount due',
      numeric: true,
      cell: (row) => formatUgx(row.expectedAmount, { withCurrency: false }),
    },
    {
      key: 'paid',
      header: 'Paid',
      numeric: true,
      cell: (row) => formatUgx(row.allocatedAmount, { withCurrency: false }),
    },
    {
      key: 'remaining',
      header: 'Still to pay',
      numeric: true,
      cell: (row) =>
        row.remainingAmount === 0
          ? 'Paid'
          : formatUgx(row.remainingAmount, { withCurrency: false }),
    },
  ];

  const paymentColumns: readonly ReportColumn<StatementPaymentRow>[] = [
    {
      key: 'receipt',
      header: 'Receipt',
      primary: true,
      cell: (row) =>
        forClient ? (
          <span className="font-mono">{row.paymentNumber}</span>
        ) : (
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
      header: 'Date',
      cell: (row) => formatInstant(row.receivedAt, { timeZone, withTime: false }),
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
      header: 'Paid by',
      cell: (row) => PAYMENT_METHOD_LABELS[row.paymentMethod],
    },
    {
      key: 'towards',
      header: 'Towards',
      hideOnMobile: true,
      cell: (row) =>
        row.isEffective
          ? [
              row.principalCollected > 0
                ? `${formatUgx(row.principalCollected, { withCurrency: false })} principal`
                : null,
              row.interestCollected > 0
                ? `${formatUgx(row.interestCollected, { withCurrency: false })} interest`
                : null,
              row.penaltyCollected > 0
                ? `${formatUgx(row.penaltyCollected, { withCurrency: false })} charge`
                : null,
            ]
              .filter((part) => part !== null)
              .join(' · ')
          : '—',
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.isEffective ? (
          <Badge tone="success">Received</Badge>
        ) : (
          <Badge tone="danger">Withdrawn</Badge>
        ),
    },
  ];

  return (
    <div className="min-w-0 space-y-6">
      <header className="min-w-0 space-y-1">
        <p className="text-text-muted text-sm">{companyName}</p>
        <h1 className="text-text text-2xl font-semibold">Loan statement</h1>
        <p className="text-text-muted text-sm">
          Loan <span className="font-mono">{loan.loanNumber}</span> · as at{' '}
          {formatBusinessDate(businessDate as Parameters<typeof formatBusinessDate>[0])}
        </p>
      </header>

      <Card className="min-w-0">
        <h2 className="text-text text-base font-semibold">Borrower</h2>
        <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
          <Figure label="Name">
            {loan.clientNameAtOrigination ?? loan.clientName ?? '—'}
          </Figure>
          <Figure label="Client number">
            <span className="font-mono">{loan.clientNumber ?? '—'}</span>
          </Figure>
          <Figure label="Phone">
            {loan.clientPhoneAtOrigination === null
              ? '—'
              : formatUgandanPhoneLocal(loan.clientPhoneAtOrigination)}
          </Figure>
          {nameChanged ? <Figure label="Now known as">{loan.clientName}</Figure> : null}
        </dl>
        {nameChanged ? (
          <p className="text-text-muted mt-3 text-xs">
            The name above is the one recorded when this loan was agreed, which is what
            makes this statement match the paperwork.
          </p>
        ) : null}
      </Card>

      <Card className="min-w-0">
        <h2 className="text-text text-base font-semibold">The loan</h2>
        <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Amount borrowed">{formatUgx(loan.principalAmount)}</Figure>
          <Figure label="Total interest">{formatUgx(loan.contractualInterest)}</Figure>
          <Figure label="Total to repay">{formatUgx(loan.totalExpectedRepayment)}</Figure>
          <Figure label="Date money was given">
            {loan.disbursedAt === null
              ? 'Not yet paid out'
              : formatInstant(loan.disbursedAt, { timeZone, withTime: false })}
          </Figure>
          <Figure label="Loan completion date">
            {loan.scheduledCompletionDate === null
              ? '—'
              : formatBusinessDate(loan.scheduledCompletionDate)}
          </Figure>
          <Figure label="Number of payments">{String(loan.installmentCount)}</Figure>
        </dl>
      </Card>

      <Card className="min-w-0">
        <h2 className="text-text text-base font-semibold">Where the loan stands</h2>
        <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Figure label="Amount paid">{formatUgx(loan.totalCollected)}</Figure>
          <Figure label="Outstanding on the loan">
            {formatUgx(loan.contractualOutstanding)}
          </Figure>
          <Figure label="Late-payment charge unpaid">
            {formatUgx(loan.penaltyRemaining)}
          </Figure>
          <Figure label="Outstanding balance">
            <strong>{formatUgx(loan.totalOutstanding)}</strong>
          </Figure>
          <Figure label="Past unpaid amount">{formatUgx(loan.arrearsAmount)}</Figure>
          <Figure label="Current amount due">{formatUgx(loan.currentDue)}</Figure>
        </dl>

        <p className="text-text-muted mt-3 text-xs">
          Amount paid plus outstanding balance equals the total to repay plus any
          late-payment charge. Current amount due is the past unpaid amount plus anything
          due today — it is not the whole outstanding balance.
        </p>
      </Card>

      {penalty !== null ? (
        <Alert tone="warning" title="Late-payment charge">
          <p>
            A charge of {formatUgx(penalty.penaltyAmount)} applies from{' '}
            {formatBusinessDate(penalty.effectiveDate)}. It is{' '}
            {/* Through the shared basis-point formatter, never a division by
                100 in a component. The rate is stored in basis points exactly
                so that no screen performs percentage arithmetic of its own. */}
            {formatBps(toBps(penalty.penaltyRateBps))} of the{' '}
            {formatUgx(penalty.basisAmount)} that was still owed when the grace period
            ended on {formatBusinessDate(penalty.graceEndDate)}.{' '}
            {penalty.penaltyRemaining === 0
              ? 'It has been paid in full.'
              : `${formatUgx(penalty.penaltyRemaining)} of it is still to pay.`}
          </p>
          <p className="mt-2">
            This is a charge for settling late. It is not interest, and it is charged
            once.
          </p>
        </Alert>
      ) : null}

      <section aria-labelledby="schedule-heading" className="min-w-0 space-y-3">
        <h2 id="schedule-heading" className="text-base">
          Payment plan
        </h2>
        <ReportTable
          columns={scheduleColumns}
          rows={schedule}
          rowKey={(row) => String(row.installmentNumber)}
          caption="The agreed payment plan, with what has been paid against each payment"
          rowTone={(row) => (row.remainingAmount === 0 ? 'muted' : undefined)}
        />
      </section>

      <section aria-labelledby="payments-heading" className="min-w-0 space-y-3">
        <h2 id="payments-heading" className="text-base">
          Payments received
        </h2>

        {payments.length === 0 ? (
          <Card>
            <p className="text-text-muted text-sm">
              No payments have been recorded against this loan yet.
            </p>
          </Card>
        ) : (
          <ReportTable
            columns={paymentColumns}
            rows={payments}
            rowKey={(row) => row.paymentId}
            caption="Payments received against this loan, with what each was applied to"
            rowTone={(row) => (row.isEffective ? undefined : 'muted')}
          />
        )}

        {payments.some((payment) => !payment.isEffective) ? (
          <p className="text-text-muted text-sm">
            A withdrawn payment stays on this statement so the history is complete. It
            does not count towards the amount paid.
          </p>
        ) : null}
      </section>

      <p className="text-text-muted text-sm">
        {forClient
          ? 'These figures are what our records show today. If anything looks wrong, please bring your receipts and speak to our staff.'
          : 'Figures are read from the ledger and the agreed schedule. Nothing on this page changes a record.'}
      </p>
    </div>
  );
}

function Figure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
