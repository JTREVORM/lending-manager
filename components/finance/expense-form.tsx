'use client';

import { useActionState, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { recordExpenseAction, type FinanceActionResult } from '@/lib/finance/actions';
import type { UgxAmount } from '@/lib/domain/money';
import type { BusinessDate } from '@/lib/domain/datetime';
import type { LedgerAccountSummary } from '@/lib/domain/finance';

export interface ExpenseFormProps {
  /** Expense accounts from the chart. The category list *is* the chart. */
  readonly categories: readonly LedgerAccountSummary[];
  readonly cashAccounts: readonly LedgerAccountSummary[];
  readonly today: BusinessDate;
  readonly approvalThreshold: UgxAmount | null;
  readonly allowNegativeCash: boolean;
}

/**
 * Recording what the business spent.
 *
 * The category list is the expense side of the chart of accounts, so adding a
 * category and adding an account are the same act — see the head of
 * `20261011000100_finance_foundations.sql`. The practical effect here is that
 * a new category appears in this picker, in the trial balance and in the
 * general ledger at the same moment, with nothing to wire up.
 */
export function ExpenseForm({
  categories,
  cashAccounts,
  today,
  approvalThreshold,
  allowNegativeCash,
}: ExpenseFormProps) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(recordExpenseAction, undefined);

  const [paymentId, setPaymentId] = useState<string>(cashAccounts[0]?.accountId ?? '');
  const [amountText, setAmountText] = useState('');

  const payment = useMemo(
    () => cashAccounts.find((a) => a.accountId === paymentId),
    [cashAccounts, paymentId],
  );

  const amount = Number(amountText.replace(/[,\s]/g, ''));
  const validAmount = Number.isSafeInteger(amount) && amount > 0;
  const wouldOverdraw =
    !allowNegativeCash &&
    payment !== undefined &&
    validAmount &&
    amount > payment.balance;
  const needsApproval =
    approvalThreshold !== null && validAmount && amount > approvalThreshold;

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
              htmlFor="expenseAccountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Category
            </label>
            <select
              id="expenseAccountId"
              name="expenseAccountId"
              required
              defaultValue={categories[0]?.accountId ?? ''}
              className="border-border bg-surface text-text focus:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus:outline-2 focus:outline-offset-2"
            >
              {categories.map((category) => (
                <option key={category.accountId} value={category.accountId}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0">
            <label
              htmlFor="paymentAccountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Paid from
            </label>
            <select
              id="paymentAccountId"
              name="paymentAccountId"
              required
              value={paymentId}
              onChange={(event) => {
                setPaymentId(event.target.value);
              }}
              className="border-border bg-surface text-text focus:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus:outline-2 focus:outline-offset-2"
            >
              {cashAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.name}
                </option>
              ))}
            </select>
            {payment !== undefined ? (
              <p className="text-text-muted mt-1 text-xs">
                Holds <Money amount={payment.balance} />
              </p>
            ) : null}
          </div>

          <Field
            label="Amount"
            name="amount"
            inputMode="numeric"
            autoComplete="off"
            required
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value);
            }}
            error={result?.fieldErrors?.amount?.[0]}
            hint="Whole shillings."
          />

          <Field
            label="Date"
            name="expenseDate"
            type="date"
            required
            defaultValue={today}
            max={today}
            error={result?.fieldErrors?.expenseDate?.[0]}
          />

          <Field
            label="Paid to (optional)"
            name="payee"
            autoComplete="off"
            error={result?.fieldErrors?.payee?.[0]}
            hint="The supplier or person who received the money."
          />

          <Field
            label="Reference (optional)"
            name="externalReference"
            autoComplete="off"
            error={result?.fieldErrors?.externalReference?.[0]}
          />

          <div className="sm:col-span-2">
            <Field
              label="Description"
              name="description"
              required
              error={result?.fieldErrors?.description?.[0]}
              hint="What it was for."
            />
          </div>
        </div>

        {wouldOverdraw ? (
          <Alert tone="warning" className="mt-4">
            {payment?.name} holds less than this. The posting will be refused unless money
            arrives first.
          </Alert>
        ) : null}

        {needsApproval ? (
          <Alert tone="info" className="mt-4">
            Above <Money amount={approvalThreshold} />, so this will wait for approval.
            Nothing is posted until somebody agrees.
          </Alert>
        ) : null}

        <div className="mt-4">
          <Button type="submit" loading={pending}>
            Record expense
          </Button>
        </div>
      </Card>
    </form>
  );
}
