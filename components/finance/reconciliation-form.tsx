'use client';

import { useActionState, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import {
  submitReconciliationAction,
  type FinanceActionResult,
} from '@/lib/finance/actions';
import { toUgx } from '@/lib/domain/money';
import type { BusinessDate } from '@/lib/domain/datetime';
import type { LedgerAccountSummary } from '@/lib/domain/finance';

export interface ReconciliationFormProps {
  readonly cashAccounts: readonly LedgerAccountSummary[];
  readonly today: BusinessDate;
  readonly requiresReview: boolean;
}

/**
 * Counting an account against what the ledger says.
 *
 * ## The expected figure is shown, and that is a deliberate risk
 *
 * There is an argument for hiding it: a cashier who can see the answer may
 * type the answer. The argument against is stronger here. This is a two-
 * person business, the count is physically in the drawer in front of them,
 * and the figure is on the dashboard they just came from — hiding it would
 * deter nobody while making an honest count harder to enter.
 *
 * What makes the control real is not secrecy. It is that a difference cannot
 * be resolved by the person who found it unless the business has said a
 * second review is not required, that resolving it writes an explicit journal
 * naming the amount, and that the whole thing is on the audit trail.
 */
export function ReconciliationForm({
  cashAccounts,
  today,
  requiresReview,
}: ReconciliationFormProps) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(submitReconciliationAction, undefined);

  const [accountId, setAccountId] = useState<string>(cashAccounts[0]?.accountId ?? '');
  const [countedText, setCountedText] = useState('');

  const account = useMemo(
    () => cashAccounts.find((a) => a.accountId === accountId),
    [cashAccounts, accountId],
  );

  const counted = Number(countedText.replace(/[,\s]/g, ''));
  const validCount = Number.isSafeInteger(counted) && counted >= 0 && countedText !== '';
  const variance = validCount && account !== undefined ? counted - account.balance : null;

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> It appears in the register
        below.
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <Card>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label
              htmlFor="accountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Account
            </label>
            <select
              id="accountId"
              name="accountId"
              required
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
              }}
              className="border-border bg-surface text-text focus:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus:outline-2 focus:outline-offset-2"
            >
              {cashAccounts.map((cash) => (
                <option key={cash.accountId} value={cash.accountId}>
                  {cash.name}
                </option>
              ))}
            </select>
            {account !== undefined ? (
              <p className="text-text-muted mt-1 text-xs">
                The ledger says <Money amount={account.balance} />
              </p>
            ) : null}
          </div>

          <Field
            label="Date"
            name="businessDate"
            type="date"
            required
            defaultValue={today}
            max={today}
            error={result?.fieldErrors?.businessDate?.[0]}
          />

          <Field
            label="Counted"
            name="countedBalance"
            inputMode="numeric"
            autoComplete="off"
            required
            value={countedText}
            onChange={(event) => {
              setCountedText(event.target.value);
            }}
            error={result?.fieldErrors?.countedBalance?.[0]}
            hint="What is actually there. Zero is a valid answer."
          />

          <Field
            label="Explanation (optional)"
            name="explanation"
            autoComplete="off"
            error={result?.fieldErrors?.explanation?.[0]}
            hint="Needed if the count differs."
          />
        </div>

        {variance !== null ? (
          <div className="border-border bg-surface-sunken mt-4 min-w-0 rounded-lg border p-3">
            {variance === 0 ? (
              <p className="text-success text-sm font-medium">
                Agrees with the ledger. Nothing will be posted.
              </p>
            ) : (
              <>
                <p className="text-text text-sm">
                  <span className="font-medium">
                    {variance > 0 ? 'Over' : 'Short'} by{' '}
                    <Money amount={toUgx(Math.abs(variance))} />
                  </span>
                </p>
                <p className="text-text-muted mt-1 text-xs">
                  {requiresReview
                    ? 'The difference will be recorded and stay visible until somebody with the approving capability writes it off. The ledger is not changed in the meantime.'
                    : 'The difference will be written off to Cash Over and Short by an explicit journal.'}
                </p>
              </>
            )}
          </div>
        ) : null}

        <div className="mt-4">
          <Button type="submit" loading={pending}>
            Record count
          </Button>
        </div>
      </Card>
    </form>
  );
}
