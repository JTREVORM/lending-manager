'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { recordPaymentAction } from '@/lib/payments/actions';
import {
  allocatePayment,
  describePaymentFailure,
  isMobileMoney,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  validatePaymentAmount,
  type InstallmentObligation,
  type PaymentMethod,
} from '@/lib/domain/payment';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { formatBusinessDate } from '@/lib/domain/datetime';
import type { PaymentActionResult } from '@/lib/payments/actions';

/**
 * Recording a payment at the counter.
 *
 * ## The confirmation step is not decoration
 *
 * A staff member taking cash cannot un-take it. So the flow is deliberately
 * two steps: enter, then confirm against the figures — client, loan, amount,
 * method, balance before, balance after. The specification asks for exactly
 * that, and the reason is that a mistyped amount is far cheaper to catch
 * before posting than to reverse afterwards, which needs the Owner.
 *
 * ## Every figure shown here is recomputed by the server
 *
 * The preview below runs `allocatePayment` in the browser, which is the same
 * rule `post_payment` applies — but it is a **preview**. The server
 * re-derives the balance, re-checks the minimum and the outstanding cap
 * against a locked row, and allocates from its own figures. If the ledger
 * moved between this form rendering and the staff member confirming — another
 * payment, a reversal — the server's answer wins and the posting is refused
 * with a message saying why.
 *
 * So nothing here is trusted. It exists so the person at the counter is told
 * the consequence before they commit, not so the browser decides it.
 *
 * ## The idempotency key
 *
 * Minted server-side when this form is rendered and carried as a hidden
 * field. A double tap, a lost response or a back-button resubmission all send
 * the same key, and the database returns the payment that already exists
 * rather than recording the money twice. The disabled button below is a
 * courtesy; the key is the guarantee. See ADR-030.
 */
export function PaymentForm({
  loanId,
  loanNumber,
  clientName,
  clientNumber,
  obligations,
  outstanding,
  unpaidDue,
  minimumPayment,
  idempotencyKey,
  onPosted,
}: {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientName: string;
  readonly clientNumber: string;
  readonly obligations: readonly InstallmentObligation[];
  readonly outstanding: number;
  readonly unpaidDue: number;
  readonly minimumPayment: number | null;
  readonly idempotencyKey: string;
  readonly onPosted?: (paymentId: string) => void;
}) {
  const [result, submit, pending] = useActionState<
    PaymentActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await recordPaymentAction(previous, formData);
    if (next.ok && next.paymentId !== undefined) onPosted?.(next.paymentId);
    return next;
  }, undefined);

  // Prefilled with what is due now, falling back to the minimum — the figure
  // the borrower has most likely come to pay. Editable, because they may pay
  // more.
  const suggested = unpaidDue > 0 ? unpaidDue : (minimumPayment ?? 0);

  const [amountText, setAmountText] = useState(suggested > 0 ? String(suggested) : '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [confirming, setConfirming] = useState(false);

  // The preview. Deliberately tolerant of input that is not yet a number —
  // somebody mid-type should not see an error on every keystroke.
  const parsedAmount = /^\d+$/.test(amountText.replace(/[\s,]/g, ''))
    ? Number(amountText.replace(/[\s,]/g, ''))
    : null;

  const failure =
    parsedAmount === null ? null : validatePaymentAmount(parsedAmount, obligations);

  const plan =
    parsedAmount !== null && failure === null
      ? (() => {
          try {
            return allocatePayment({
              amount: toUgx(parsedAmount),
              obligations,
            });
          } catch {
            return null;
          }
        })()
      : null;

  const canContinue = parsedAmount !== null && failure === null && plan !== null;

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span>
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      {/* --- Step one: the figures ------------------------------------- */}
      {confirming ? null : (
        <Card>
          <dl className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Borrower</dt>
              <dd className="text-text font-medium break-words">
                {clientName}{' '}
                <span className="text-text-muted font-mono text-sm">{clientNumber}</span>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Loan</dt>
              <dd className="text-text font-mono">{loanNumber}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Due now</dt>
              <dd className="text-text font-semibold tabular-nums">
                {formatUgx(toUgx(unpaidDue))}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Outstanding balance</dt>
              <dd className="text-text font-semibold tabular-nums">
                {formatUgx(toUgx(outstanding))}
              </dd>
            </div>
          </dl>

          <div className="space-y-4">
            {/* `type="text"` with a numeric keypad, not `type="number"`: a
                number input accepts exponent and decimal forms that the
                shilling parser then has to reject, and on a phone it offers a
                keyboard that invites `4000.50`. */}
            <Field
              label="Amount received"
              name="amount"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              required
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
              }}
              error={result?.fieldErrors?.amount?.[0]}
              hint={
                minimumPayment === null
                  ? undefined
                  : `At least ${formatUgx(toUgx(minimumPayment))}, at most ${formatUgx(toUgx(outstanding))}.`
              }
            />

            <fieldset className="min-w-0">
              <legend className="text-text mb-2 text-sm font-medium">
                How was it received?
              </legend>
              <div className="flex min-w-0 flex-wrap gap-2">
                {PAYMENT_METHODS.map((candidate) => (
                  <label
                    key={candidate}
                    className={`focus-within:outline-accent inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 ${
                      method === candidate
                        ? 'border-accent bg-accent-surface text-accent'
                        : 'border-border text-text'
                    }`}
                  >
                    <input
                      type="radio"
                      name="paymentMethod"
                      value={candidate}
                      checked={method === candidate}
                      onChange={() => {
                        setMethod(candidate);
                      }}
                      className="sr-only"
                    />
                    {PAYMENT_METHOD_LABELS[candidate]}
                  </label>
                ))}
              </div>
            </fieldset>

            {isMobileMoney(method) ? (
              <Field
                label="Transaction reference"
                name="externalReference"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                required
                error={result?.fieldErrors?.externalReference?.[0]}
                hint="From the Mobile Money message. It is what stops the same payment being recorded twice."
              />
            ) : (
              // Not rendered at all for cash, rather than rendered and
              // ignored: the database refuses a reference on a cash payment,
              // so offering the field would invite a refusal.
              <p className="text-text-muted text-sm">
                A cash payment has no network reference. Its payment number is its
                reference.
              </p>
            )}

            <Field
              label="Note (optional)"
              name="notes"
              type="text"
              autoComplete="off"
              error={result?.fieldErrors?.notes?.[0]}
            />
          </div>

          {failure !== null ? (
            <Alert tone="warning" className="mt-4">
              {describePaymentFailure(failure.code, failure.detail)}
            </Alert>
          ) : null}

          {plan !== null ? (
            <div className="border-border mt-4 min-w-0 rounded-lg border p-3">
              <p className="text-text text-sm font-medium">
                This payment would cover{' '}
                {plan.allocations.length === 1
                  ? '1 collection'
                  : `${String(plan.allocations.length)} collections`}
                .
              </p>
              <p className="text-text-muted mt-1 text-sm tabular-nums">
                {formatUgx(plan.totalPrincipal)} principal and{' '}
                {formatUgx(plan.totalInterest)} interest. Balance afterwards{' '}
                {formatUgx(plan.outstandingAfter)}.
              </p>
              {plan.clearsLoan ? (
                <p className="text-success mt-1 text-sm font-medium">
                  This settles the loan in full.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4">
            <Button
              type="button"
              disabled={!canContinue}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Continue
            </Button>
          </div>
        </Card>
      )}

      {/* --- Step two: confirm ----------------------------------------- */}
      {confirming && plan !== null ? (
        <Card>
          <h3 className="text-text text-lg font-semibold">Confirm this payment</h3>
          <p className="text-text-muted mt-1 text-sm">
            Check every figure against what the borrower handed over. Once recorded, a
            payment can only be withdrawn by the Owner, as a reversal.
          </p>

          <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <Confirm label="Borrower">
              {clientName} <span className="font-mono">{clientNumber}</span>
            </Confirm>
            <Confirm label="Loan">
              <span className="font-mono">{loanNumber}</span>
            </Confirm>
            <Confirm label="Amount">
              <span className="text-lg font-semibold tabular-nums">
                {formatUgx(plan.amount)}
              </span>
            </Confirm>
            <Confirm label="Method">{PAYMENT_METHOD_LABELS[method]}</Confirm>
            <Confirm label="Balance before">
              <span className="tabular-nums">{formatUgx(plan.outstandingBefore)}</span>
            </Confirm>
            <Confirm label="Balance after">
              <span className="font-semibold tabular-nums">
                {formatUgx(plan.outstandingAfter)}
              </span>
            </Confirm>
          </dl>

          <div className="border-border mt-4 min-w-0 overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                How this payment would be applied: collection, due date, principal and
                interest
              </caption>
              <thead>
                <tr className="border-border text-text-muted border-b">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Collection
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Due
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Principal
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Interest
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Applied
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.allocations.map((entry) => {
                  const target = obligations.find(
                    (row) => row.installmentId === entry.installmentId,
                  );

                  return (
                    <tr key={entry.installmentId} className="border-border border-b">
                      <th scope="row" className="text-text px-3 py-2 font-normal">
                        {entry.installmentNumber}
                      </th>
                      <td className="text-text-muted px-3 py-2">
                        {target === undefined ? '—' : formatBusinessDate(target.dueDate)}
                      </td>
                      <td className="text-text px-3 py-2 text-right tabular-nums">
                        {formatUgx(entry.allocatedPrincipal)}
                      </td>
                      <td className="text-text px-3 py-2 text-right tabular-nums">
                        {formatUgx(entry.allocatedInterest)}
                      </td>
                      <td className="text-text px-3 py-2 text-right font-medium tabular-nums">
                        {formatUgx(entry.allocatedAmount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-text-muted mt-3 text-sm">
            Interest on each collection is covered before its principal. The schedule
            itself does not change — these collections keep their dates and amounts.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Recording…' : `Record ${formatUgx(plan.amount)}`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Back
            </Button>
          </div>
        </Card>
      ) : null}
    </form>
  );
}

function Confirm({
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
