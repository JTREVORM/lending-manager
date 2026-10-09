'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { recordIncomeAction, type FinanceActionResult } from '@/lib/finance/actions';
import type { BusinessDate } from '@/lib/domain/datetime';
import type { LedgerAccountSummary } from '@/lib/domain/finance';

export interface IncomeFormProps {
  /**
   * Fee and other-income accounts.
   *
   * Interest Income and Penalty Income are deliberately absent: those are
   * written by the lending functions from a payment's own allocation
   * components, and the database refuses them here. Offering them in the
   * picker would be offering a refusal.
   */
  readonly categories: readonly LedgerAccountSummary[];
  readonly cashAccounts: readonly LedgerAccountSummary[];
  readonly today: BusinessDate;
}

/** Recording a fee or other non-loan income. */
export function IncomeForm({ categories, cashAccounts, today }: IncomeFormProps) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(recordIncomeAction, undefined);

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
              htmlFor="incomeAccountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Category
            </label>
            <select
              id="incomeAccountId"
              name="incomeAccountId"
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
              htmlFor="receivingAccountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Received into
            </label>
            <select
              id="receivingAccountId"
              name="receivingAccountId"
              required
              defaultValue={cashAccounts[0]?.accountId ?? ''}
              className="border-border bg-surface text-text focus:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus:outline-2 focus:outline-offset-2"
            >
              {cashAccounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Amount"
            name="amount"
            inputMode="numeric"
            autoComplete="off"
            required
            error={result?.fieldErrors?.amount?.[0]}
            hint="Whole shillings."
          />

          <Field
            label="Date"
            name="incomeDate"
            type="date"
            required
            defaultValue={today}
            max={today}
            error={result?.fieldErrors?.incomeDate?.[0]}
          />

          <Field
            label="Received from (optional)"
            name="payer"
            autoComplete="off"
            error={result?.fieldErrors?.payer?.[0]}
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
              hint="What the money was for."
            />
          </div>
        </div>

        <p className="text-text-muted mt-3 text-xs">
          Income is recorded, never approved — the money has already arrived, and holding
          it in a pending state would leave cash the books do not know about.
        </p>

        <div className="mt-4">
          <Button type="submit" loading={pending}>
            Record income
          </Button>
        </div>
      </Card>
    </form>
  );
}
