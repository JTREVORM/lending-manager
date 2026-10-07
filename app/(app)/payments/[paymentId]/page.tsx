import { Receipt } from 'lucide-react';

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PaymentRecorded } from '@/components/payments/payment-recorded';
import { PaymentReceipt } from '@/components/payments/payment-receipt';
import { PaymentReversalPanel } from '@/components/payments/payment-reversal-panel';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getReceiptBranding } from '@/lib/data/company';
import { getPayment, getPaymentAllocations } from '@/lib/data/payments';
import { getLoan } from '@/lib/data/loans';
import { formatInstant } from '@/lib/domain/datetime';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '@/lib/domain/payment';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';

export const metadata = { title: 'Payment' };

/**
 * One payment, its receipt and how it was applied.
 *
 * A missing payment and an unauthorised one both render the same not-found
 * page: distinguishing them would confirm a payment exists to somebody who
 * may not see it.
 */
export default async function PaymentDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly paymentId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { paymentId } = await params;
  const query = await searchParams;

  // The *only* thing the query string decides is whether the confirmation
  // panel appears. Every figure in it is read from the payment record below.
  // A confirmation assembled from query parameters is one anybody can forge
  // by editing the address bar, and a borrower photographing that screen
  // would have a receipt for a payment nobody took.
  const justRecorded = query.recorded === '1';
  const context = await guardPermission(
    `${ROUTES.payments}/${paymentId}`,
    'payments:view',
  );

  const payment = await getPayment(paymentId);

  if (payment === null) notFound();

  const [allocations, branding, loan] = await Promise.all([
    getPaymentAllocations(paymentId),
    getReceiptBranding(),
    getLoan(payment.loanId),
  ]);

  const isReversed = payment.status === 'reversed';

  return (
    <div className="min-w-0 space-y-6">
      {justRecorded && !isReversed ? (
        <PaymentRecorded
          paymentNumber={payment.paymentNumber}
          amount={payment.amount}
          clientName={payment.clientName}
          clientId={payment.clientId}
          loanNumber={payment.loanNumber}
          loanId={payment.loanId}
          paymentMethod={payment.paymentMethod}
          receivedAt={payment.receivedAt}
          outstandingAfter={payment.outstandingAfter}
          timeZone={branding.timezone}
        />
      ) : null}

      <PageHeader
        eyebrow="Collections"
        icon={Receipt}
        back={{ href: ROUTES.payments, label: 'Payments' }}
        title={
          /* Struck through when the payment has been reversed, the way the
             register and the borrower's own history show it. This page is
             where a staff member comes to look at a reversal, so it is the
             worst place for the figure to read as though the money were still
             received. */
          <Money amount={payment.amount} struck={isReversed} />
        }
        status={
          <Badge tone={isReversed ? 'danger' : 'success'}>
            {PAYMENT_STATUS_LABELS[payment.status]}
          </Badge>
        }
        description={<span className="font-mono">{payment.paymentNumber}</span>}
      />

      {/* --- The record ------------------------------------------------- */}
      <section aria-labelledby="record-heading" className="min-w-0 space-y-3">
        <h2 id="record-heading" className="text-text text-lg font-semibold">
          Record
        </h2>

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Detail label="Borrower">
              <Link
                href={`${ROUTES.clients}/${payment.clientId}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                {payment.clientName}
              </Link>{' '}
              <span className="text-text-muted font-mono text-sm">
                {payment.clientNumber}
              </span>
            </Detail>
            <Detail label="Loan">
              <Link
                href={`${ROUTES.loans}/${payment.loanId}`}
                className="text-accent font-mono underline-offset-2 hover:underline"
              >
                {payment.loanNumber}
              </Link>
            </Detail>
            <Detail label="Amount">
              <span className="font-semibold tabular-nums">
                <Money amount={payment.amount} struck={isReversed} />
              </span>
            </Detail>
            <Detail label="Method">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</Detail>
            {payment.externalReference === null ? null : (
              <Detail label="Transaction reference">
                <span className="font-mono break-all">{payment.externalReference}</span>
              </Detail>
            )}
            <Detail label="Received">
              <DateValue
                value={payment.receivedAt}
                variant="datetime"
                timeZone={branding.timezone}
              />
            </Detail>
            <Detail label="Recorded by">{payment.recordedByLabel}</Detail>
            <Detail label="Borrower name on the receipt">
              {payment.clientNameAtPayment}
            </Detail>

            {payment.notes === null ? null : (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-text-muted text-sm">Note</dt>
                <dd className="text-text mt-1 break-words whitespace-pre-wrap">
                  {payment.notes}
                </dd>
              </div>
            )}

            {isReversed ? (
              <>
                <Detail label="Reversed">
                  {payment.reversedAt === null
                    ? '—'
                    : formatInstant(payment.reversedAt, {
                        timeZone: branding.timezone,
                      })}
                </Detail>
                <Detail label="Reversed by">{payment.reversedByLabel ?? '—'}</Detail>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-text-muted text-sm">Reason</dt>
                  <dd className="text-text mt-1 break-words whitespace-pre-wrap">
                    {payment.reversalReason ?? '—'}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
        </Card>
      </section>

      {/* --- How it was applied ----------------------------------------- */}
      <section aria-labelledby="allocation-heading" className="min-w-0 space-y-3">
        <h2 id="allocation-heading" className="text-text text-lg font-semibold">
          How it was applied
        </h2>

        {allocations.length === 0 ? (
          <Card>
            <p className="text-text-muted text-sm">No allocations are recorded.</p>
          </Card>
        ) : (
          <Card className="min-w-0 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Allocations: collection number, principal, interest and total applied
              </caption>
              <thead>
                <tr className="border-border text-text-muted border-b">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Collection
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Principal
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Interest
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Applied
                  </th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((entry) => (
                  <tr key={entry.id} className="border-border border-b">
                    <th scope="row" className="text-text py-2 pr-4 font-normal">
                      {entry.installmentNumber}
                    </th>
                    <td className="text-text py-2 pr-4 text-right tabular-nums">
                      <Money amount={entry.allocatedPrincipal} />
                    </td>
                    <td className="text-text py-2 pr-4 text-right tabular-nums">
                      <Money amount={entry.allocatedInterest} />
                    </td>
                    <td className="text-text py-2 text-right font-medium tabular-nums">
                      <Money amount={entry.allocatedAmount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        <p className="text-text-muted text-sm">
          Oldest collection first, and each collection&rsquo;s interest before its
          principal.
          {isReversed
            ? ' These allocations are kept as history; because the payment is reversed, they no longer count toward the balance.'
            : ''}
        </p>
      </section>

      {/* --- The receipt ------------------------------------------------ */}
      <section aria-labelledby="receipt-heading" className="min-w-0 space-y-3">
        <h2 id="receipt-heading" className="text-text text-lg font-semibold">
          Receipt
        </h2>

        <PaymentReceipt
          companyName={branding.companyName}
          companyPhone={branding.companyPhone}
          receiptHeader={branding.receiptHeader}
          receiptFooter={branding.receiptFooter}
          paymentNumber={payment.paymentNumber}
          receivedAt={payment.receivedAt}
          clientName={payment.clientNameAtPayment}
          clientNumber={payment.clientNumber}
          loanNumber={payment.loanNumber}
          amount={payment.amount}
          paymentMethod={payment.paymentMethod}
          externalReference={payment.externalReference}
          outstandingBefore={payment.outstandingBefore}
          outstandingAfter={payment.outstandingAfter}
          recordedByLabel={payment.recordedByLabel}
          timeZone={branding.timezone}
          reversedAt={payment.reversedAt}
          reversalReason={payment.reversalReason}
          allocations={allocations}
        />
      </section>

      {/* --- Reversal --------------------------------------------------- */}
      {contextCan(context, 'payments:reverse') ? (
        <section aria-labelledby="reversal-heading" className="min-w-0 space-y-3">
          <h2 id="reversal-heading" className="text-text text-lg font-semibold">
            Correction
          </h2>

          <PaymentReversalPanel
            paymentId={payment.id}
            paymentNumber={payment.paymentNumber}
            amount={payment.amount}
            loanNumber={payment.loanNumber}
            willReopenLoan={loan?.status === 'cleared'}
            alreadyReversed={isReversed}
          />
        </section>
      ) : null}
    </div>
  );
}

function Detail({
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
