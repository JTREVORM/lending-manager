'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { useFocusWhen } from '@/components/ui/focus-on-appear';
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
import { contributionProgressPercent } from '@/lib/domain/savings';
import {
  recordSavingsDepositAction,
  type SavingsActionResult,
} from '@/lib/savings/actions';

/**
 * Taking a deposit at the counter.
 *
 * ## The confirmation step is not decoration
 *
 * A staff member taking cash cannot un-take it, and only the Owner can reverse
 * a recorded deposit. So the flow is two steps: enter, then confirm against
 * the figures — member, account, amount, method, balance before, balance
 * after. A mistyped amount is far cheaper to catch before posting than to
 * reverse afterwards.
 *
 * ## Every figure here is recomputed by the server
 *
 * The preview below adds the amount to the balance this page was rendered
 * with. That is a **preview**. `post_savings_deposit` reads the balance itself
 * under the account's row lock, writes the journal from its own figures, and
 * stamps the value date from the business clock. If something moved between
 * this form rendering and the staff member confirming — another deposit, a
 * withdrawal, a reversal — the server's answer is the one recorded.
 *
 * So nothing here is trusted. It exists so the person at the counter is told
 * the consequence before they commit, not so the browser decides it.
 *
 * ## What it says about the month
 *
 * A deposit's most useful consequence to a member is whether it completes the
 * month. The preview says so, and says what is still short when it does not —
 * because "you need five thousand more for this month to count" is the
 * sentence that gets the five thousand paid in today rather than next month.
 *
 * ## The idempotency key
 *
 * Minted server-side when this form is rendered and carried as a hidden field.
 * A double tap, a lost response or a back-button resubmission all send the
 * same key, and the database returns the deposit that already exists rather
 * than recording the money twice. The disabled button is a courtesy; the key
 * is the guarantee. See ADR-030.
 */
export function DepositForm({
  savingsAccountId,
  accountNumber,
  fullName,
  clientNumber,
  balance,
  monthlyMinimum,
  contributedThisMonth,
  idempotencyKey,
}: {
  readonly savingsAccountId: string;
  readonly accountNumber: string;
  readonly fullName: string;
  readonly clientNumber: string;
  readonly balance: number;
  readonly monthlyMinimum: number;
  readonly contributedThisMonth: number;
  readonly idempotencyKey: string;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    SavingsActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await recordSavingsDepositAction(previous, formData);

    if (next.ok) {
      // `replace`, not `push`: the form's URL must not stay in history, or the
      // browser's back button offers to re-submit a deposit that has already
      // been recorded. The destination reads the balance from the subledger —
      // which this form is not in a position to state authoritatively.
      router.replace(`${ROUTES.savings}/${savingsAccountId}?deposited=1`);
    }

    return next;
  }, undefined);

  // Prefilled with what is still needed for this month to count, which is the
  // figure a member most often comes to pay. Editable, because they may pay
  // more, and blank once the month is already met rather than suggesting a
  // second minimum they do not owe.
  const shortfall = Math.max(monthlyMinimum - contributedThisMonth, 0);

  const [amountText, setAmountText] = useState(shortfall > 0 ? String(shortfall) : '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useFocusWhen<HTMLDivElement>(confirming);

  // Deliberately tolerant of input that is not yet a number: somebody mid-type
  // should not see an error on every keystroke.
  const parsedAmount = /^\d+$/.test(amountText.replace(/[\s,]/g, ''))
    ? Number(amountText.replace(/[\s,]/g, ''))
    : null;

  // Anything but cash is incomplete without the other side's reference. The
  // field is `required` and the database refuses without it, but `Continue` is
  // a `type="button"` so the browser's own validation never runs — which would
  // let a cashier read the whole confirmation and only then be told.
  const referenceMissing = requiresExternalReference(method) && reference.trim() === '';

  const canContinue =
    parsedAmount !== null && parsedAmount > 0 && !referenceMissing && !pending;

  const monthAfter = contributedThisMonth + (parsedAmount ?? 0);
  const balanceAfter = balance + (parsedAmount ?? 0);
  const percentAfter = contributionProgressPercent(
    toUgx(monthAfter),
    toUgx(monthlyMinimum),
  );

  if (result?.ok === true) {
    // Shown for the moment between the action returning and the navigation
    // completing. The real confirmation is the page it is going to.
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> Opening the account…
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      <input type="hidden" name="savingsAccountId" value={savingsAccountId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      {/* --- Step one: the figures ------------------------------------- */}
      {confirming ? null : (
        <Card>
          <dl className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Member</dt>
              <dd className="text-text font-medium break-words">
                {fullName}{' '}
                <span className="text-text-muted font-mono text-sm">{clientNumber}</span>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Account</dt>
              <dd className="text-text font-mono">{accountNumber}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Balance now</dt>
              <dd className="text-text font-semibold tabular-nums">
                <Money amount={toUgx(balance)} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Paid in this month</dt>
              <dd className="text-text font-semibold tabular-nums">
                <Money amount={toUgx(contributedThisMonth)} />
              </dd>
              <dd className="text-text-muted text-xs">
                {shortfall === 0 ? (
                  <>This month already counts.</>
                ) : (
                  <>
                    <Money amount={toUgx(shortfall)} /> short of{' '}
                    <Money amount={toUgx(monthlyMinimum)} />
                  </>
                )}
              </dd>
            </div>
          </dl>

          <div className="space-y-4">
            {/* `type="text"` with a numeric keypad, not `type="number"`: a
                number input accepts exponent and decimal forms the shilling
                parser then has to reject, and on a phone it offers a keyboard
                that invites `50000.50`. */}
            <Field
              label="Amount received"
              name="amount"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              required
              autoFocus
              value={amountText}
              onChange={(event) => {
                setAmountText(event.target.value);
              }}
              error={result?.fieldErrors?.amount?.[0]}
              hint={
                shortfall > 0
                  ? `${formatUgx(toUgx(shortfall))} completes this month. A member may pay in more.`
                  : 'This month already counts. Anything paid in adds to the balance.'
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
                hint={
                  isMobileMoney(method)
                    ? 'From the Mobile Money message. It is what makes the line findable when the account is reconciled.'
                    : 'From the bank statement or deposit slip. It is what makes this posting reconcilable.'
                }
              />
            ) : (
              // Not rendered at all for cash, rather than rendered and
              // ignored: the database refuses a reference on a cash deposit,
              // so offering the field would invite a refusal.
              <p className="text-text-muted text-sm">
                A cash deposit has no network reference. Its transaction number is its
                reference.
              </p>
            )}

            <Field
              label="Note (optional)"
              name="notes"
              type="text"
              autoComplete="off"
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
              error={result?.fieldErrors?.notes?.[0]}
            />
          </div>

          {parsedAmount !== null && parsedAmount > 0 ? (
            <div className="border-border mt-4 min-w-0 rounded-lg border p-3">
              <p className="text-text-muted text-sm tabular-nums">
                Balance afterwards <Money amount={toUgx(balanceAfter)} />.
              </p>
              <p
                className={
                  percentAfter >= 100
                    ? 'text-success mt-1 text-sm font-medium'
                    : 'text-text-muted mt-1 text-sm'
                }
              >
                {percentAfter >= 100 ? (
                  <>This completes the month — it will count towards qualification.</>
                ) : (
                  <>
                    <Money amount={toUgx(monthlyMinimum - monthAfter)} /> would still be
                    needed for this month to count.
                  </>
                )}
              </p>
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
      {confirming && parsedAmount !== null ? (
        // Takes focus when it appears: step one is unmounted by now, so the
        // button that was focused no longer exists and the browser would drop
        // focus to `<body>`.
        <Card ref={confirmRef} tabIndex={-1} aria-labelledby="confirm-deposit-heading">
          {/* Step one is unmounted while this step is shown, and an unmounted
              input is not submitted — so the amount, the method, the reference
              and the note are carried here as hidden fields. The values are
              the same state step one edits, so the two cannot disagree. */}
          <input type="hidden" name="amount" value={amountText} />
          <input type="hidden" name="paymentMethod" value={method} />
          {requiresExternalReference(method) ? (
            <input type="hidden" name="externalReference" value={reference} />
          ) : null}
          <input type="hidden" name="notes" value={notes} />

          <h3 id="confirm-deposit-heading" className="text-text text-lg font-semibold">
            Confirm this deposit
          </h3>
          <p className="text-text-muted mt-1 text-sm">
            Check every figure against what the member handed over. Once recorded, a
            deposit can only be withdrawn by the Owner, as a reversal.
          </p>

          <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <Confirm label="Member">
              {fullName} <span className="font-mono">{clientNumber}</span>
            </Confirm>
            <Confirm label="Account">
              <span className="font-mono">{accountNumber}</span>
            </Confirm>
            <Confirm label="Amount">
              <span className="text-lg font-semibold tabular-nums">
                <Money amount={toUgx(parsedAmount)} />
              </span>
            </Confirm>
            <Confirm label="Method">
              {PAYMENT_METHOD_LABELS[method]}
              {reference.trim() === '' ? null : (
                <span className="text-text-muted block font-mono text-xs">
                  {reference.trim().toUpperCase()}
                </span>
              )}
            </Confirm>
            <Confirm label="Balance before">
              <span className="tabular-nums">
                <Money amount={toUgx(balance)} />
              </span>
            </Confirm>
            <Confirm label="Balance after">
              <span className="font-semibold tabular-nums">
                <Money amount={toUgx(balanceAfter)} />
              </span>
            </Confirm>
          </dl>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Recording…' : `Record ${formatUgx(toUgx(parsedAmount))}`}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Change something
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
      <dd className="text-text break-words">{children}</dd>
    </div>
  );
}
