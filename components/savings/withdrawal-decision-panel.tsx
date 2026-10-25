'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  isMobileMoney,
  requiresExternalReference,
  type PaymentMethod,
} from '@/lib/domain/payment';
import { formatUgx, toUgx } from '@/lib/domain/money';
import {
  cancelWithdrawalAction,
  decideWithdrawalAction,
  postWithdrawalAction,
  type SavingsActionResult,
} from '@/lib/savings/actions';

/**
 * Deciding and paying a withdrawal.
 *
 * ## Three acts, three forms, and the separation is real
 *
 * Approving, paying and cancelling are separate submissions rather than one
 * form with a mode, because they are separate decisions with separate
 * consequences: an approval moves no money, a payment moves it, and a
 * cancellation ends the request. Collapsing them would make it possible to
 * approve and pay in one tap, which is exactly the control this phase exists
 * to put in place.
 *
 * `decide_savings_withdrawal` refuses a decision from whoever prepared the
 * request. That cannot be checked here — the browser does not know who is
 * signed in without being told, and being told is not evidence — so this panel
 * does not try. It states the rule, and the database enforces it.
 *
 * ## The balance shown is the balance *now*, not the balance at request
 *
 * Both are shown, deliberately. A withdrawal approved when the account held
 * UGX 100,000 and paid after a deposit was reversed cannot be paid, and
 * `post_savings_withdrawal` re-checks under the account's row lock and refuses.
 * Showing only the figure recorded at request time would leave a Manager
 * approving against money that is no longer there.
 */
export function WithdrawalDecisionPanel({
  requestId,
  requestNumber,
  status,
  amount,
  reason,
  balanceAtRequest,
  balanceNow,
  requestedByLabel,
  canDecide,
  canPost,
  canCancel,
  idempotencyKey,
}: {
  readonly requestId: string;
  readonly requestNumber: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'paid' | 'cancelled';
  readonly amount: number;
  readonly reason: string;
  readonly balanceAtRequest: number;
  readonly balanceNow: number;
  readonly requestedByLabel: string;
  readonly canDecide: boolean;
  readonly canPost: boolean;
  readonly canCancel: boolean;
  readonly idempotencyKey: string;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    SavingsActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const intent = formData.get('intent');

    const next =
      intent === 'approve' || intent === 'reject'
        ? await decideWithdrawalAction(previous, formData)
        : intent === 'pay'
          ? await postWithdrawalAction(previous, formData)
          : await cancelWithdrawalAction(previous, formData);

    if (next.ok) {
      // `refresh`, not `replace`: the request stays at this URL and the page
      // re-reads it, so a Manager who has just approved sees the payment form
      // appear rather than being sent somewhere else mid-task.
      router.refresh();
    }

    return next;
  }, undefined);

  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [rejectionNotes, setRejectionNotes] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const shortOfBalance = balanceNow < amount;
  const referenceMissing = requiresExternalReference(method) && reference.trim() === '';

  if (status === 'rejected' || status === 'cancelled' || status === 'paid') {
    // Nothing left to do. The detail page states what happened and when; this
    // panel has no part to play, and rendering an empty card would suggest
    // otherwise.
    return null;
  }

  return (
    <div className="min-w-0 space-y-4">
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}
      {result?.ok === true ? <Alert tone="success">{result.message}</Alert> : null}

      {shortOfBalance ? (
        <Alert tone="danger" title="The balance has moved">
          This account now holds <Money amount={toUgx(balanceNow)} />, which is less than
          the <Money amount={toUgx(amount)} /> requested. A payment will be refused.
          Either a deposit was reversed, or something else was paid out.
        </Alert>
      ) : null}

      {/* --- Pending: approve or reject -------------------------------- */}
      {status === 'pending' && canDecide ? (
        <Card>
          <h2 className="text-text text-sm font-semibold">Decide this withdrawal</h2>
          <p className="text-text-muted mt-1 text-sm">
            {requestedByLabel} prepared it. A withdrawal cannot be decided by the person
            who prepared it, so if that was you, somebody else has to decide this one.
          </p>

          {rejecting ? (
            <form action={submit} className="mt-4 min-w-0 space-y-3">
              <input type="hidden" name="intent" value="reject" />
              <input type="hidden" name="requestId" value={requestId} />
              <input type="hidden" name="approve" value="false" />

              <Field
                label="Why is it rejected?"
                name="notes"
                type="text"
                autoComplete="off"
                required
                autoFocus
                value={rejectionNotes}
                onChange={(event) => {
                  setRejectionNotes(event.target.value);
                }}
                error={result?.fieldErrors?.notes?.[0]}
                hint="The member will be told this. An approval needs no note; a refusal does."
              />

              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="danger" disabled={pending}>
                  {pending ? 'Rejecting…' : 'Reject this withdrawal'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setRejecting(false);
                  }}
                >
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <form action={submit}>
                <input type="hidden" name="intent" value="approve" />
                <input type="hidden" name="requestId" value={requestId} />
                <input type="hidden" name="approve" value="true" />
                <Button type="submit" disabled={pending}>
                  {pending ? 'Approving…' : `Approve ${formatUgx(toUgx(amount))}`}
                </Button>
              </form>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setRejecting(true);
                }}
              >
                Reject
              </Button>
            </div>
          )}

          <p className="text-text-muted mt-3 text-xs">
            Approving moves no money. The member is paid when somebody records the payment
            below.
          </p>
        </Card>
      ) : null}

      {status === 'pending' && !canDecide ? (
        <Alert tone="info" title="This withdrawal is waiting for a decision">
          Deciding a withdrawal needs the approval capability, which a Manager or the
          Owner holds.
        </Alert>
      ) : null}

      {/* --- Approved: pay --------------------------------------------- */}
      {status === 'approved' && canPost ? (
        <Card>
          <h2 className="text-text text-sm font-semibold">Record the payment</h2>
          <p className="text-text-muted mt-1 text-sm">
            Record this once the member has the money. It reduces what the business owes
            them, and it is only reversible by the Owner.
          </p>

          <form action={submit} className="mt-4 min-w-0 space-y-4">
            <input type="hidden" name="intent" value="pay" />
            <input type="hidden" name="requestId" value={requestId} />
            {/* Minted server-side when this page rendered: a double tap sends
                the same key and the database returns the payment that already
                exists rather than paying twice. See ADR-030. */}
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

            <fieldset className="min-w-0">
              <legend className="text-text mb-2 text-sm font-medium">
                How is it being paid?
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

            {requiresExternalReference(method) ? (
              <Field
                label={
                  isMobileMoney(method) ? 'Transaction reference' : 'Transfer reference'
                }
                name="externalReference"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                required
                value={reference}
                onChange={(event) => {
                  setReference(event.target.value);
                }}
                error={result?.fieldErrors?.externalReference?.[0]}
                hint="What makes this payment findable when the account is reconciled."
              />
            ) : (
              <p className="text-text-muted text-sm">
                A cash payment has no network reference. Its transaction number is its
                reference.
              </p>
            )}

            <Button
              type="submit"
              disabled={pending || referenceMissing || shortOfBalance}
            >
              {pending ? 'Recording…' : `Pay ${formatUgx(toUgx(amount))}`}
            </Button>
          </form>
        </Card>
      ) : null}

      {status === 'approved' && !canPost ? (
        <Alert tone="info" title="This withdrawal is approved and not yet paid">
          Recording the payment needs the payment capability, which a Manager or the Owner
          holds.
        </Alert>
      ) : null}

      {/* --- Cancelling ------------------------------------------------- */}
      {canCancel ? (
        <Card>
          {cancelling ? (
            <form action={submit} className="min-w-0 space-y-3">
              <input type="hidden" name="intent" value="cancel" />
              <input type="hidden" name="requestId" value={requestId} />

              <Field
                label="Why is it being cancelled?"
                name="reason"
                type="text"
                autoComplete="off"
                required
                autoFocus
                value={cancelReason}
                onChange={(event) => {
                  setCancelReason(event.target.value);
                }}
                error={result?.fieldErrors?.reason?.[0]}
                hint="Recorded against the request. Nothing moves — a cancelled request never had a journal."
              />

              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="secondary" disabled={pending}>
                  {pending ? 'Cancelling…' : `Cancel ${requestNumber}`}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setCancelling(false);
                  }}
                >
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <>
              <h2 className="text-text text-sm font-semibold">Withdraw this request</h2>
              <p className="text-text-muted mt-1 text-sm">
                If the member has changed their mind, cancel the request. The account is
                then free to take another one.
              </p>
              <div className="mt-3">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => {
                    setCancelling(true);
                  }}
                >
                  Cancel this request
                </Button>
              </div>
            </>
          )}
        </Card>
      ) : null}

      <p className="text-text-muted text-xs">
        {reason === '' ? null : <>Requested for: {reason}. </>}
        Balance when prepared <Money amount={toUgx(balanceAtRequest)} />; balance now{' '}
        <Money amount={toUgx(balanceNow)} />.{' '}
        <a href={ROUTES.savingsWithdrawals} className="underline underline-offset-2">
          Back to the queue
        </a>
      </p>
    </div>
  );
}
