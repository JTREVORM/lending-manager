import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { PrintButton } from '@/components/reports/print-button';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { ActionLink } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/domain/payment';

/**
 * The confirmation shown immediately after a payment is recorded.
 *
 * ## What it replaces
 *
 * A green bar reading "Payment recorded." on an otherwise empty page. No
 * receipt number, no amount, no new balance, and nothing to do next — so a
 * cashier with a borrower still at the counter had to navigate to the
 * register and find the payment to read back the number they had just taken.
 *
 * ## Every figure comes from the record
 *
 * Nothing here is read from the URL. The page that renders this loads the
 * payment by id and passes what the ledger says; the only thing the query
 * string decides is whether this panel appears at all. A confirmation built
 * from query parameters is a confirmation anybody can forge by typing a
 * different number into the address bar, and a borrower photographing that
 * screen has a receipt for a payment that was never made.
 *
 * ## The actions
 *
 * Four, in the order the work actually goes: look at the receipt, print it,
 * take the next payment, go back to the borrower. "Record another payment"
 * returns to the loan picker rather than this loan — the next person in the
 * queue is a different borrower.
 */
export interface PaymentRecordedProps {
  readonly paymentNumber: string;
  readonly amount: number;
  readonly clientName: string;
  readonly clientId: string | null;
  readonly loanNumber: string;
  readonly loanId: string;
  readonly paymentMethod: PaymentMethod;
  readonly receivedAt: string;
  readonly outstandingAfter: number;
  readonly timeZone: string;
}

export function PaymentRecorded({
  paymentNumber,
  amount,
  clientName,
  clientId,
  loanNumber,
  loanId,
  paymentMethod,
  receivedAt,
  outstandingAfter,
  timeZone,
}: PaymentRecordedProps) {
  return (
    <section
      aria-labelledby="payment-recorded-heading"
      className="border-success/30 bg-success-surface rounded-xl border p-4 sm:p-5 print:hidden"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2
          aria-hidden="true"
          className="text-success mt-0.5 size-6 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <h2 id="payment-recorded-heading" className="text-text text-lg font-semibold">
            Payment recorded
          </h2>
          <p className="text-text-muted mt-0.5 text-sm">
            This is now on the loan. Only the Owner can withdraw it, as a reversal.
          </p>

          <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <Fact label="Receipt number">
              <span className="font-mono font-medium">{paymentNumber}</span>
            </Fact>
            <Fact label="Amount">
              <Money amount={amount} weight="semibold" size="lg" />
            </Fact>
            <Fact label="Borrower">
              <span className="break-words">{clientName}</span>
            </Fact>
            <Fact label="Loan">
              <span className="font-mono">{loanNumber}</span>
            </Fact>
            <Fact label="Method">{PAYMENT_METHOD_LABELS[paymentMethod]}</Fact>
            <Fact label="Received">
              <DateValue value={receivedAt} variant="datetime" timeZone={timeZone} />
            </Fact>
            <Fact label="Still owed on this loan">
              <Money amount={outstandingAfter} weight="semibold" />
            </Fact>
          </dl>

          <div className="mt-5 flex flex-wrap gap-2">
            {/* Not a "view receipt" link: the receipt is already further down
                this page. The anchor jumps to it, which is quicker than a
                navigation and keeps the confirmation on screen. */}
            <ActionLink href="#receipt-heading">View receipt</ActionLink>
            {/* The one control here that has to run script. It is the
                reporting layer's print button, not a second one: two ways to
                print is two chances for one of them to break. */}
            <PrintButton label="Print receipt" />
            <ActionLink href={`${ROUTES.payments}/new`} variant="secondary">
              Record another payment
            </ActionLink>
            {clientId === null ? null : (
              <ActionLink href={`${ROUTES.clients}/${clientId}`} variant="secondary">
                Back to borrower
              </ActionLink>
            )}
            <ActionLink href={`${ROUTES.loans}/${loanId}`} variant="secondary">
              Back to loan
            </ActionLink>
          </div>
        </div>
      </div>
    </section>
  );
}

function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
