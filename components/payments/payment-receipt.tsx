import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '@/lib/domain/payment';
import { DateValue } from '@/components/ui/data-value';

/**
 * A payment receipt.
 *
 * ## Why the figures come from the payment row, not from the loan
 *
 * `outstandingBefore` and `outstandingAfter` were frozen onto the payment when
 * it was posted, by the posting function, from figures it derived itself.
 * Re-deriving them here from the loan's *current* balance would silently
 * rewrite history: every later payment would change what an earlier receipt
 * said, and a borrower holding a printed slip would find the system disagreeing
 * with it.
 *
 * So a receipt shows what the receipt showed. The live balance is a different
 * question, answered elsewhere on the loan. See ADR-029.
 *
 * The borrower's name is likewise the name as it read at the time, and the
 * staff member is a stored label rather than a lookup — so a receipt survives
 * a client being renamed or a staff account being disabled.
 *
 * ## A reversed receipt does not disappear
 *
 * It is marked, loudly, and still shows every original figure. A borrower who
 * holds the printed slip needs to be able to find the record it refers to, and
 * a receipt that vanished would make a reversal look like a deletion.
 *
 * ## A penalty on a receipt is named as a penalty
 *
 * Phase 7 can allocate part of a payment to a late-payment charge. It appears
 * on its own line, labelled, and is never added into the interest figure: a
 * borrower is entitled to know which part of what they handed over was the
 * loan they took and which part was a charge for settling late.
 *
 * ## Company branding
 *
 * Read from the current company settings. If the business later needs receipts
 * to show the branding as it was on the day, that becomes a snapshot — but
 * inventing one now would be building for a requirement nobody has stated.
 */
export function PaymentReceipt({
  companyName,
  companyPhone,
  receiptHeader,
  receiptFooter,
  paymentNumber,
  receivedAt,
  clientName,
  clientNumber,
  loanNumber,
  amount,
  paymentMethod,
  externalReference,
  outstandingBefore,
  outstandingAfter,
  recordedByLabel,
  timeZone,
  reversedAt,
  reversalReason,
  allocations,
}: {
  readonly companyName: string;
  readonly companyPhone: string | null;
  readonly receiptHeader: string | null;
  readonly receiptFooter: string | null;
  readonly paymentNumber: string;
  readonly receivedAt: string;
  readonly clientName: string;
  readonly clientNumber: string;
  readonly loanNumber: string;
  readonly amount: number;
  readonly paymentMethod: PaymentMethod;
  readonly externalReference: string | null;
  readonly outstandingBefore: number;
  readonly outstandingAfter: number;
  readonly recordedByLabel: string;
  /** The business timezone, from company settings. Never hard-coded. */
  readonly timeZone: string;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
  readonly allocations?: readonly {
    readonly id: string;
    readonly kind?: 'installment' | 'penalty';
    readonly installmentNumber: number;
    readonly dueDate: string;
    readonly allocatedAmount: number;
    readonly allocatedPrincipal: number;
    readonly allocatedInterest: number;
    readonly allocatedPenalty?: number;
  }[];
}) {
  const isReversed = reversedAt !== null;

  return (
    <div className="min-w-0 space-y-3">
      {isReversed ? (
        <Alert tone="danger" title="REVERSED">
          This payment was reversed on{' '}
          <DateValue value={reversedAt} variant="datetime" timeZone={timeZone} />. It no
          longer counts toward the loan balance. The figures below are what this receipt
          said when it was issued.
          {reversalReason === null ? null : (
            <>
              {' '}
              Reason: <span className="font-medium">{reversalReason}</span>
            </>
          )}
        </Alert>
      ) : null}

      <Card className="min-w-0">
        {/* --- Header ------------------------------------------------- */}
        <header className="border-border mb-4 border-b pb-3 text-center">
          <h2 className="text-text text-lg font-semibold break-words">{companyName}</h2>
          {companyPhone === null ? null : (
            <p className="text-text-muted text-sm">{companyPhone}</p>
          )}
          {receiptHeader === null ? null : (
            <p className="text-text-muted mt-1 text-sm break-words">{receiptHeader}</p>
          )}
          <p className="text-text mt-2 font-medium">Payment receipt</p>
        </header>

        <dl className="min-w-0 space-y-2 text-sm">
          <Line label="Receipt number">
            <span className="font-mono font-semibold">{paymentNumber}</span>
          </Line>
          <Line label="Date and time">
            <DateValue value={receivedAt} variant="datetime" timeZone={timeZone} />
          </Line>
          <Line label="Borrower">
            <span className="break-words">{clientName}</span>
          </Line>
          <Line label="Client number">
            <span className="font-mono">{clientNumber}</span>
          </Line>
          <Line label="Loan number">
            <span className="font-mono">{loanNumber}</span>
          </Line>
          <Line label="Method">{PAYMENT_METHOD_LABELS[paymentMethod]}</Line>
          {externalReference === null ? null : (
            <Line label="Transaction reference">
              <span className="font-mono break-all">{externalReference}</span>
            </Line>
          )}
          <Line label="Received by">
            <span className="break-words">{recordedByLabel}</span>
          </Line>
        </dl>

        {/* --- The money ---------------------------------------------- */}
        <div className="border-border mt-4 border-t pt-3">
          <dl className="min-w-0 space-y-2 text-sm">
            <Line label="Balance before">
              <span className="tabular-nums">
                <Money amount={toUgx(outstandingBefore)} />
              </span>
            </Line>
            <Line label="Amount paid">
              <span className="text-base font-semibold tabular-nums">
                <Money amount={toUgx(amount)} />
              </span>
            </Line>
            <Line label="Balance after">
              <span className="font-semibold tabular-nums">
                <Money amount={toUgx(outstandingAfter)} />
              </span>
            </Line>
          </dl>
        </div>

        {/* --- How it was applied ------------------------------------- */}
        {allocations !== undefined && allocations.length > 0 ? (
          <div className="border-border mt-4 border-t pt-3">
            <h3 className="text-text mb-2 text-sm font-medium">
              Applied to {allocations.length === 1 ? 'collection' : 'collections'}
            </h3>
            <ul className="min-w-0 space-y-1 text-sm">
              {allocations.map((entry) => (
                <li
                  key={entry.id}
                  className="flex min-w-0 flex-wrap justify-between gap-x-3"
                >
                  <span className="text-text-muted">
                    {entry.kind === 'penalty' ? (
                      <>
                        Late-payment penalty, from{' '}
                        <DateValue value={entry.dueDate as never} />
                      </>
                    ) : (
                      <>
                        #{entry.installmentNumber} due{' '}
                        <DateValue value={entry.dueDate as never} />
                      </>
                    )}
                  </span>
                  <span className="text-text tabular-nums">
                    <Money amount={toUgx(entry.allocatedAmount)} />
                    {/* A penalty is named as a penalty, never folded into
                        interest. A borrower is entitled to know which part of
                        what they paid was the loan and which was a charge. */}
                    <span className="text-text-muted">
                      {entry.kind === 'penalty'
                        ? ' (penalty)'
                        : ` (${formatUgx(toUgx(entry.allocatedPrincipal))} + ${formatUgx(toUgx(entry.allocatedInterest))} int.)`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {receiptFooter === null ? null : (
          <footer className="border-border text-text-muted mt-4 border-t pt-3 text-center text-sm break-words">
            {receiptFooter}
          </footer>
        )}
      </Card>

      <p className="text-text-muted text-sm">
        Keep this receipt. {paymentNumber} identifies this payment in any query.
      </p>
    </div>
  );
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap justify-between gap-x-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text min-w-0 text-right">{children}</dd>
    </div>
  );
}
