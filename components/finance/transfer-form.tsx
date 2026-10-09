'use client';

import { useActionState, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { recordTransferAction, type FinanceActionResult } from '@/lib/finance/actions';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import type { BusinessDate } from '@/lib/domain/datetime';
import type { LedgerAccountSummary } from '@/lib/domain/finance';

export interface TransferFormProps {
  readonly accounts: readonly LedgerAccountSummary[];
  readonly today: BusinessDate;
  /**
   * Above this, the transfer waits for somebody else. Shown before the staff
   * member commits rather than discovered afterwards, because "why has this
   * not moved?" is the question an unexplained pending status creates.
   */
  readonly approvalThreshold: UgxAmount | null;
  readonly allowNegativeCash: boolean;
}

/**
 * Moving money between the company's own accounts.
 *
 * ## What the form will not let you do, and what only the database can refuse
 *
 * Choosing the same account twice is refused here, because the answer cannot
 * change between rendering and submitting. Whether the source holds enough is
 * **not** refused here, even though the balance is on screen: between the
 * page loading and the button being pressed, a cashier at the counter may
 * have taken 200,000 out of the same drawer. The figure shown is a guide; the
 * decision is `assert_cash_available`, inside the posting transaction.
 *
 * So the balance is displayed and the shortfall is hinted at, and the form
 * still submits — because being told "no" by the thing that actually knows is
 * better than being told "yes" by the thing that does not.
 */
export function TransferForm({
  accounts,
  today,
  approvalThreshold,
  allowNegativeCash,
}: TransferFormProps) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(recordTransferAction, undefined);

  const [fromId, setFromId] = useState<string>(accounts[0]?.accountId ?? '');
  const [toId, setToId] = useState<string>(accounts[1]?.accountId ?? '');
  const [amountText, setAmountText] = useState('');

  const from = useMemo(
    () => accounts.find((a) => a.accountId === fromId),
    [accounts, fromId],
  );
  const to = useMemo(() => accounts.find((a) => a.accountId === toId), [accounts, toId]);

  const amount = Number(amountText.replace(/[,\s]/g, ''));
  const validAmount = Number.isSafeInteger(amount) && amount > 0;

  const sameAccount = fromId !== '' && fromId === toId;
  const wouldOverdraw =
    !allowNegativeCash && from !== undefined && validAmount && amount > from.balance;
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
              htmlFor="fromAccountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Out of
            </label>
            <select
              id="fromAccountId"
              name="fromAccountId"
              required
              value={fromId}
              onChange={(event) => {
                setFromId(event.target.value);
              }}
              className="border-border bg-surface text-text focus:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus:outline-2 focus:outline-offset-2"
            >
              {accounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.name}
                </option>
              ))}
            </select>
            {from !== undefined ? (
              <p className="text-text-muted mt-1 text-xs">
                Holds <Money amount={from.balance} />
              </p>
            ) : null}
          </div>

          <div className="min-w-0">
            <label
              htmlFor="toAccountId"
              className="text-text mb-1.5 block text-sm font-medium"
            >
              Into
            </label>
            <select
              id="toAccountId"
              name="toAccountId"
              required
              value={toId}
              onChange={(event) => {
                setToId(event.target.value);
              }}
              aria-invalid={sameAccount}
              className="border-border bg-surface text-text focus:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus:outline-2 focus:outline-offset-2"
            >
              {accounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.name}
                </option>
              ))}
            </select>
            {sameAccount ? (
              <p role="alert" className="text-danger mt-1 text-xs">
                Choose two different accounts.
              </p>
            ) : to !== undefined ? (
              <p className="text-text-muted mt-1 text-xs">
                Holds <Money amount={to.balance} />
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
            name="transferDate"
            type="date"
            required
            defaultValue={today}
            max={today}
            error={result?.fieldErrors?.transferDate?.[0]}
          />

          <Field
            label="Reference (optional)"
            name="externalReference"
            autoComplete="off"
            error={result?.fieldErrors?.externalReference?.[0]}
            hint="The deposit slip or wallet transaction number, if there is one."
          />

          <Field
            label="Description"
            name="description"
            required
            error={result?.fieldErrors?.description?.[0]}
            hint="Why the money moved."
          />
        </div>

        {from !== undefined && to !== undefined && validAmount ? (
          <div className="border-border bg-surface-sunken mt-4 min-w-0 rounded-lg border p-3">
            <p className="text-text flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{from.name}</span>
              <ArrowRight aria-hidden="true" className="text-text-muted size-4" />
              <span className="font-medium">{to.name}</span>
              <span className="tabular-nums">
                <Money amount={toUgx(amount)} />
              </span>
            </p>
            <p className="text-text-muted mt-1 text-xs">
              A transfer is neither income nor an expense. Total liquidity does not
              change.
            </p>
          </div>
        ) : null}

        {wouldOverdraw ? (
          <Alert tone="warning" className="mt-4">
            {from?.name} holds less than this. The posting will be refused unless money
            arrives first.
          </Alert>
        ) : null}

        {needsApproval ? (
          <Alert tone="info" className="mt-4">
            Above <Money amount={approvalThreshold} />, so this will wait for somebody
            with the approving capability. Nothing is posted until they agree.
          </Alert>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" loading={pending} disabled={sameAccount}>
            Record transfer
          </Button>
        </div>
      </Card>
    </form>
  );
}
