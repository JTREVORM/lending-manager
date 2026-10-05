'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useFocusWhen } from '@/components/ui/focus-on-appear';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { reversePaymentAction } from '@/lib/payments/actions';
import { toUgx } from '@/lib/domain/money';
import type { PaymentActionResult } from '@/lib/payments/actions';

/**
 * Reversing a payment.
 *
 * ## Why this does not look like a delete
 *
 * It is not one. The payment stays on the ledger with every figure intact,
 * its allocations stay attached, and its receipt stays reachable and marked
 * REVERSED. What changes is that the allocations stop counting toward the
 * balance.
 *
 * So the control says "Reverse", never "Delete" or "Remove", and the
 * confirmation spells out the consequence in money: the balance goes *up* by
 * this amount, and a settled loan may reopen. A staff member who thought they
 * were tidying up a mistaken entry needs to understand they are changing what
 * a borrower owes.
 *
 * ## Why the reason has a length floor
 *
 * This is the only record of why money was withdrawn from a borrower's
 * account. "Error" tells a future reader nothing, so the schema requires ten
 * characters and the hint explains why rather than treating it as a formality.
 *
 * ## Owner only
 *
 * The panel is rendered only for a caller holding `payments:reverse`, which is
 * the Owner alone. That is presentation: `reverse_payment` re-checks the
 * capability itself, and the guard trigger refuses an unattributed reversal
 * even to the privileged client. Hiding the button is not the control.
 */
export function PaymentReversalPanel({
  paymentId,
  paymentNumber,
  amount,
  loanNumber,
  willReopenLoan,
  alreadyReversed,
}: {
  readonly paymentId: string;
  readonly paymentNumber: string;
  readonly amount: number;
  readonly loanNumber: string;
  /** Is the loan currently cleared, so that reversing would reopen it? */
  readonly willReopenLoan: boolean;
  readonly alreadyReversed: boolean;
}) {
  const [result, submit, pending] = useActionState<
    PaymentActionResult | undefined,
    FormData
  >(reversePaymentAction, undefined);

  const [confirming, setConfirming] = useState(false);
  const confirmRef = useFocusWhen<HTMLFormElement>(confirming);

  if (alreadyReversed) {
    return (
      <Card>
        <p className="text-text-muted text-sm">
          This payment has already been reversed. A reversal cannot be repeated, and it
          cannot be undone — if the borrower did pay, record a new payment.
        </p>
      </Card>
    );
  }

  if (result?.ok === true) {
    return <Alert tone="success">{result.message}</Alert>;
  }

  return (
    <Card>
      {result?.ok === false ? (
        <Alert tone="danger" className="mb-3">
          {result.message}
        </Alert>
      ) : null}

      {confirming ? (
        // Takes focus when it appears: the "Reverse…" button is unmounted by
        // now, so the browser would drop focus to `<body>`. See
        // `useFocusWhen`.
        <form
          action={submit}
          className="min-w-0 space-y-3"
          ref={confirmRef}
          tabIndex={-1}
        >
          <input type="hidden" name="paymentId" value={paymentId} />

          <Alert tone="warning" title="This changes what the borrower owes">
            <ul className="list-inside list-disc space-y-1">
              <li>
                Loan {loanNumber} will owe{' '}
                <span className="font-medium tabular-nums">
                  <Money amount={toUgx(amount)} />
                </span>{' '}
                more than it does now.
              </li>
              <li>
                The collections this payment covered become uncovered again. The schedule
                itself does not change.
              </li>
              {willReopenLoan ? (
                <li className="font-medium">
                  This loan is currently settled. Reversing will reopen it as active.
                </li>
              ) : null}
              <li>
                {paymentNumber} stays on the register, marked reversed, with its receipt
                intact. Nothing is deleted.
              </li>
            </ul>
          </Alert>

          <Field
            label="Reason for this reversal"
            name="reason"
            type="text"
            required
            autoComplete="off"
            error={result?.fieldErrors?.reason?.[0]}
            hint="This is the only record of why the money was withdrawn. Be specific enough for somebody reading it in a year."
          />

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? 'Reversing…' : `Reverse ${paymentNumber}`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="min-w-0">
          <h3 className="text-text font-medium">Reverse this payment</h3>
          <p className="text-text-muted mt-1 text-sm">
            For a payment recorded in error. The record is kept and marked reversed; the
            loan balance is restored.
          </p>
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Reverse…
          </Button>
        </div>
      )}
    </Card>
  );
}
