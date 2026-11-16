'use client';

import { useActionState, useState } from 'react';
import { randomUUID } from 'node:crypto';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import {
  confirmCashReturnAction,
  openDepositInvestigationAction,
  recordBankDepositAction,
  reverseBankClearanceAction,
  verifyBankDepositAction,
  type FinanceActionResult,
} from '@/lib/finance/actions';
import {
  DEPOSIT_STATUS_LABELS,
  type BankDepositRow,
  type CashAccountAvailability,
  type LedgerAccountSummary,
} from '@/lib/domain/finance';
import { cn } from '@/lib/utils/cn';

export interface BankDepositRegisterProps {
  readonly deposits: readonly BankDepositRow[];
  readonly accounts: readonly LedgerAccountSummary[];
  readonly availability: readonly CashAccountAvailability[];
  readonly canRecord: boolean;
  readonly canVerify: boolean;
  readonly canReverse: boolean;
  readonly className?: string;
}

/** A key the browser mints, so a double submission records one deposit. */
function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : randomUUID();
}

export function BankDepositRegister({
  deposits,
  accounts,
  availability,
  canRecord,
  canVerify,
  canReverse,
  className,
}: BankDepositRegisterProps) {
  const [key, setKey] = useState<string>(() => newKey());

  const [recordResult, record, recording] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(recordBankDepositAction, undefined);
  const [decisionResult, decide, deciding] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(verifyBankDepositAction, undefined);

  const tills = accounts.filter(
    (a) => a.cashKind !== null && a.cashKind !== 'bank' && a.isPostable,
  );
  const banks = accounts.filter((a) => a.cashKind === 'bank' && a.isPostable);
  const availableOf = (accountId: string) =>
    availability.find((a) => a.accountId === accountId)?.available ?? 0;

  return (
    <div className={cn('min-w-0 space-y-8', className)}>
      {canRecord && tills.length > 0 && banks.length > 0 ? (
        <section aria-labelledby="record-deposit-heading">
          <h2 id="record-deposit-heading" className="text-text text-sm font-semibold">
            Take cash to the bank
          </h2>
          <p className="text-text-muted mt-1 text-xs">
            The money leaves the till now and reaches the bank when somebody else verifies
            the bank&rsquo;s own record of it.
          </p>

          {recordResult !== undefined ? (
            <Alert tone={recordResult.ok ? 'success' : 'danger'} className="mt-3">
              {recordResult.message}
            </Alert>
          ) : null}

          <form
            action={(formData) => {
              record(formData);
              // A new key for the next deposit, so the one just submitted
              // cannot be replayed by a second click.
              setKey(newKey());
            }}
            className="mt-3"
          >
            <input type="hidden" name="idempotencyKey" value={key} />
            <Card className="grid min-w-0 gap-4 p-4 sm:grid-cols-2">
              <label className="block min-w-0 text-sm">
                <span className="text-text font-medium">From</span>
                <select
                  name="fromAccountId"
                  required
                  className="border-border bg-surface mt-1 w-full rounded-md border px-3 py-2 text-sm"
                >
                  {tills.map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.name} — {String(availableOf(account.accountId))} available
                    </option>
                  ))}
                </select>
              </label>

              <label className="block min-w-0 text-sm">
                <span className="text-text font-medium">To</span>
                <select
                  name="bankAccountId"
                  required
                  className="border-border bg-surface mt-1 w-full rounded-md border px-3 py-2 text-sm"
                >
                  {banks.map((account) => (
                    <option key={account.accountId} value={account.accountId}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>

              <Field label="Amount" name="amount" inputMode="numeric" required />

              <Field label="Description" name="description" />

              <div className="sm:col-span-2">
                <Button type="submit" disabled={recording}>
                  {recording ? 'Recording…' : 'Record deposit'}
                </Button>
              </div>
            </Card>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="deposit-register-heading">
        <h2 id="deposit-register-heading" className="text-text text-sm font-semibold">
          Deposit register
        </h2>

        {decisionResult !== undefined ? (
          <Alert tone={decisionResult.ok ? 'success' : 'danger'} className="mt-3">
            {decisionResult.message}
          </Alert>
        ) : null}

        {deposits.length === 0 ? (
          <Card className="mt-3 p-4">
            <p className="text-text-muted text-sm">
              No cash has been taken to the bank yet.
            </p>
          </Card>
        ) : (
          <div className="divide-border border-border mt-3 min-w-0 divide-y rounded-md border">
            {deposits.map((deposit) => (
              <article key={deposit.id} className="min-w-0 p-4">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                  <p className="text-text text-sm font-medium tabular-nums">
                    <Money amount={deposit.amount} />{' '}
                    <span className="text-text-muted font-normal">
                      · {deposit.depositNumber}
                    </span>
                  </p>
                  <p
                    className={cn(
                      'text-xs font-medium',
                      deposit.status === 'cleared'
                        ? 'text-success'
                        : deposit.status === 'under_investigation'
                          ? 'text-danger'
                          : 'text-warning',
                    )}
                  >
                    {DEPOSIT_STATUS_LABELS[deposit.status]}
                  </p>
                </div>

                <p className="text-text-muted mt-1 text-xs">
                  {deposit.depositDate} · recorded by {deposit.recordedByLabel}
                  {deposit.verifiedByLabel === null
                    ? ''
                    : ` · verified by ${deposit.verifiedByLabel}`}
                  {deposit.bankReference === null
                    ? ''
                    : ` · bank reference ${deposit.bankReference}`}
                </p>

                {deposit.investigationReason === null ? null : (
                  <p className="text-danger mt-1 text-xs">
                    Under investigation: {deposit.investigationReason}
                  </p>
                )}

                {canVerify && deposit.status === 'submitted' ? (
                  <form action={decide} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="depositId" value={deposit.id} />
                    <Field label="Bank reference" name="bankReference" required />
                    <Field label="Value date" name="bankValueDate" type="date" required />
                    <Button type="submit" disabled={deciding}>
                      {deciding ? 'Verifying…' : 'Verify clearance'}
                    </Button>
                  </form>
                ) : null}

                {canVerify && deposit.status === 'submitted' ? (
                  <InvestigationForm depositId={deposit.id} />
                ) : null}

                {canVerify && deposit.status === 'under_investigation' ? (
                  <ReturnForm depositId={deposit.id} />
                ) : null}

                {canReverse && deposit.status === 'cleared' ? (
                  <ReversalForm depositId={deposit.id} />
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** The bank has no record of it. Posts nothing; the money stays in transit. */
function InvestigationForm({ depositId }: { readonly depositId: string }) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(openDepositInvestigationAction, undefined);

  return (
    <form action={submit} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="depositId" value={depositId} />
      <Field
        label="Open an investigation"
        name="reason"
        placeholder="Why the bank has not credited it"
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Opening…' : 'Investigate'}
      </Button>
      {result?.ok === false ? (
        <p className="text-danger w-full text-xs">{result.message}</p>
      ) : null}
    </form>
  );
}

/** The cash physically came back, and a second person saw it. */
function ReturnForm({ depositId }: { readonly depositId: string }) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(confirmCashReturnAction, undefined);

  return (
    <form action={submit} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="depositId" value={depositId} />
      <Field
        label="Confirm the cash came back"
        name="evidenceNote"
        placeholder="Who handed it back, when, and what was counted"
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Confirming…' : 'Confirm return'}
      </Button>
      {result?.ok === false ? (
        <p className="text-danger w-full text-xs">{result.message}</p>
      ) : null}
    </form>
  );
}

/** The Owner's act, and never the officer who verified it. */
function ReversalForm({ depositId }: { readonly depositId: string }) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(reverseBankClearanceAction, undefined);

  return (
    <form action={submit} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="depositId" value={depositId} />
      <Field
        label="Reverse the clearance"
        name="reason"
        placeholder="Why the clearance was wrong"
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Reversing…' : 'Reverse clearance'}
      </Button>
      {result?.ok === false ? (
        <p className="text-danger w-full text-xs">{result.message}</p>
      ) : null}
    </form>
  );
}
