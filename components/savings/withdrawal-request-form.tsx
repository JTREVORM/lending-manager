'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { requestWithdrawalAction, type SavingsActionResult } from '@/lib/savings/actions';

/**
 * Preparing a withdrawal for somebody else to decide.
 *
 * ## One step, not two
 *
 * Unlike the deposit form, this does not confirm. Nothing irreversible
 * happens: no money moves, no journal is written, and the request can be
 * cancelled. What follows is a decision by a *different* person, which is the
 * real check — a confirmation step here would be ceremony where the control
 * is the second pair of eyes.
 *
 * ## What it says about the amount
 *
 * The balance is shown and the field is capped against it in the hint, but the
 * cap is not enforced here as a hard stop: the balance is re-read under a row
 * lock by `request_savings_withdrawal` and again by `post_savings_withdrawal`,
 * and those are the checks that count. A browser that refused to let a staff
 * member *type* an amount would be refusing on a figure that may already be
 * stale.
 *
 * ## The reason is not optional
 *
 * It is the only record of why money left a member's savings, and it is what
 * the person deciding reads. "Cash" tells them nothing, so there is a floor on
 * its length — here, and again in the database.
 */
export function WithdrawalRequestForm({
  savingsAccountId,
  accountNumber,
  fullName,
  clientNumber,
  balance,
}: {
  readonly savingsAccountId: string;
  readonly accountNumber: string;
  readonly fullName: string;
  readonly clientNumber: string;
  readonly balance: number;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    SavingsActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await requestWithdrawalAction(previous, formData);

    if (next.ok) {
      // `replace`, not `push`: the form's URL must not stay in history, or the
      // back button offers to prepare a second request — which the database
      // would refuse, because an account has one live request at a time, but
      // the refusal would read as a fault.
      router.replace(`${ROUTES.savings}/${savingsAccountId}?requested=1`);
    }

    return next;
  }, undefined);

  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');

  const parsedAmount = /^\d+$/.test(amountText.replace(/[\s,]/g, ''))
    ? Number(amountText.replace(/[\s,]/g, ''))
    : null;

  const overBalance = parsedAmount !== null && parsedAmount > balance;

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> Opening the account…
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      <input type="hidden" name="savingsAccountId" value={savingsAccountId} />

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

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
            <dt className="text-text-muted text-sm">Balance available</dt>
            <dd className="text-text font-semibold tabular-nums">
              <Money amount={toUgx(balance)} />
            </dd>
          </div>
        </dl>

        <div className="space-y-4">
          <Field
            label="Amount requested"
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
            hint={`At most ${formatUgx(toUgx(balance))}.`}
          />

          <Field
            label="What is it for?"
            name="reason"
            type="text"
            autoComplete="off"
            required
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            error={result?.fieldErrors?.reason?.[0]}
            hint="The person deciding this request reads exactly what you write here."
          />
        </div>

        {overBalance ? (
          <Alert tone="warning" className="mt-4">
            This account holds <Money amount={toUgx(balance)} />. A request for more than
            that will be refused.
          </Alert>
        ) : null}

        <Alert tone="info" className="mt-4">
          This prepares the withdrawal. It is not paid until somebody else approves it and
          then records the payment — and the person who prepares a withdrawal cannot be
          the one who approves it.
        </Alert>

        <div className="mt-4">
          <Button type="submit" disabled={pending || parsedAmount === null}>
            {pending ? 'Preparing…' : 'Prepare this withdrawal'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
