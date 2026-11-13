'use client';

import { useActionState, useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  postFloatReplenishmentAction,
  postPayableSettlementAction,
  recordCommissionSettlementAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type {
  AgencyCommissionRow,
  AgencyFloatRow,
  AgencyPayableRow,
} from '@/lib/domain/agency';

/** A cash or bank account the branch may settle through. */
export interface SettlementAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly branchId: string | null;
}

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/**
 * Why these forms carry no computed figure of their own.
 *
 * Each one sends an amount and lets the database decide whether it is
 * allowed: the outstanding receivable, the outstanding payable and the cash
 * in the till are all read under lock at the moment of posting. A form that
 * pre-checked them would be checking a stale fact and, worse, would look
 * authoritative while doing it. The outstanding figures shown beside the
 * fields come from the Phase 4C views and are there to inform the officer,
 * not to gate the submission.
 */

export function CommissionSettlementForm({
  rows,
  accounts,
}: {
  readonly rows: readonly AgencyCommissionRow[];
  readonly accounts: readonly SettlementAccount[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordCommissionSettlementAction, undefined);
  const formId = useId();
  const settleable = rows.filter((r) => r.outstanding > 0);
  const [choice, setChoice] = useState(
    settleable.length === 0
      ? ''
      : `${settleable[0]!.providerId}|${settleable[0]!.branchId}`,
  );

  if (settleable.length === 0) {
    return (
      <Alert tone="info">
        No provider has commission outstanding at a branch you can see. Nothing to settle.
      </Alert>
    );
  }

  const [providerId, branchId] = choice.split('|');
  const selected = settleable.find(
    (r) => r.providerId === providerId && r.branchId === branchId,
  );
  const branchAccounts = accounts.filter(
    (a) => a.branchId === null || a.branchId === branchId,
  );

  return (
    <Card>
      <h2 className="text-sm font-semibold">Record a commission remittance</h2>
      <form action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-provider`}>Provider and branch</Label>
          <select
            id={`${formId}-provider`}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            className={SELECT}
          >
            {settleable.map((r) => (
              <option
                key={`${r.providerId}|${r.branchId}`}
                value={`${r.providerId}|${r.branchId}`}
              >
                {r.providerName} — {r.branchCode} (outstanding{' '}
                {r.outstanding.toLocaleString('en-UG')})
              </option>
            ))}
          </select>
        </div>
        <input type="hidden" name="providerId" value={providerId ?? ''} />
        <input type="hidden" name="branchId" value={branchId ?? ''} />

        <Field
          label="Amount received (UGX)"
          name="amount"
          inputMode="numeric"
          required
          hint={
            selected === undefined
              ? undefined
              : `${selected.outstanding.toLocaleString('en-UG')} outstanding. A partial remittance is allowed; more than the balance is refused.`
          }
          error={result?.fieldErrors?.amount?.[0]}
        />

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-account`}>Received into</Label>
          <select
            id={`${formId}-account`}
            name="settlementAccountId"
            required
            className={SELECT}
          >
            {branchAccounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
          <p className="text-text-muted text-xs">
            The branch&rsquo;s own cash at hand or bank account. A mobile money wallet is
            refused: loan repayments arrive there.
          </p>
        </div>

        <Field
          label="Provider statement reference"
          name="statementRef"
          autoComplete="off"
          hint="Optional, and checked for duplicates when given."
          error={result?.fieldErrors?.statementRef?.[0]}
        />

        <Button type="submit" loading={pending} className="w-full sm:w-auto">
          Record remittance
        </Button>
        {result === undefined ? null : (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        )}
      </form>
    </Card>
  );
}

export function PayableSettlementForm({
  rows,
  accounts,
}: {
  readonly rows: readonly AgencyPayableRow[];
  readonly accounts: readonly SettlementAccount[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(postPayableSettlementAction, undefined);
  const formId = useId();
  const settleable = rows.filter((r) => r.outstanding > 0);
  const [choice, setChoice] = useState(
    settleable.length === 0
      ? ''
      : `${settleable[0]!.providerId}|${settleable[0]!.branchId}`,
  );

  if (settleable.length === 0) {
    return (
      <Alert tone="info">
        Nothing is held on any provider&rsquo;s behalf at a branch you can see.
      </Alert>
    );
  }

  const [providerId, branchId] = choice.split('|');
  const selected = settleable.find(
    (r) => r.providerId === providerId && r.branchId === branchId,
  );
  const branchAccounts = accounts.filter(
    (a) => a.branchId === null || a.branchId === branchId,
  );

  return (
    <Card>
      <h2 className="text-sm font-semibold">Remit collections to a provider</h2>
      <form action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-provider`}>Provider and branch</Label>
          <select
            id={`${formId}-provider`}
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            className={SELECT}
          >
            {settleable.map((r) => (
              <option
                key={`${r.providerId}|${r.branchId}`}
                value={`${r.providerId}|${r.branchId}`}
              >
                {r.providerName} — {r.branchCode} (held{' '}
                {r.outstanding.toLocaleString('en-UG')})
              </option>
            ))}
          </select>
        </div>
        <input type="hidden" name="providerId" value={providerId ?? ''} />
        <input type="hidden" name="branchId" value={branchId ?? ''} />

        <Field
          label="Amount handed over (UGX)"
          name="amount"
          inputMode="numeric"
          required
          hint={
            selected === undefined
              ? undefined
              : `${selected.outstanding.toLocaleString('en-UG')} held. More than this is refused: the liability may not go into net debit, and there is no approved advance arrangement.`
          }
          error={result?.fieldErrors?.amount?.[0]}
        />

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-account`}>Paid out of</Label>
          <select
            id={`${formId}-account`}
            name="cashAccountId"
            required
            className={SELECT}
          >
            {branchAccounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Receipt reference"
          name="receiptRef"
          autoComplete="off"
          hint="What the institution gave you. Checked for duplicates when given."
          error={result?.fieldErrors?.receiptRef?.[0]}
        />

        <Button type="submit" loading={pending} className="w-full sm:w-auto">
          Record remittance
        </Button>
        {result === undefined ? null : (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        )}
      </form>
    </Card>
  );
}

export function FloatReplenishmentForm({
  tills,
  accounts,
}: {
  readonly tills: readonly AgencyFloatRow[];
  readonly accounts: readonly SettlementAccount[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(postFloatReplenishmentAction, undefined);
  const formId = useId();
  const [tillId, setTillId] = useState(tills[0]?.floatAccountId ?? '');

  if (tills.length === 0) {
    return (
      <Alert tone="info">
        No active float till is available at a branch you can see.
      </Alert>
    );
  }

  const till = tills.find((t) => t.floatAccountId === tillId);
  const branchAccounts = accounts.filter(
    (a) => a.branchId === null || a.branchId === (till?.branchId ?? ''),
  );

  return (
    <Card>
      <h2 className="text-sm font-semibold">Top up a float till</h2>
      <form action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-till`}>Till</Label>
          <select
            id={`${formId}-till`}
            name="floatAccountId"
            required
            value={tillId}
            onChange={(event) => setTillId(event.target.value)}
            className={SELECT}
          >
            {tills.map((t) => (
              <option key={t.floatAccountId} value={t.floatAccountId}>
                {t.providerName} — {t.tillName} ({t.branchCode}, holds{' '}
                {t.balance.toLocaleString('en-UG')})
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Amount (UGX)"
          name="amount"
          inputMode="numeric"
          required
          error={result?.fieldErrors?.amount?.[0]}
        />

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-funding`}>Funded from</Label>
          <select
            id={`${formId}-funding`}
            name="fundingAccountId"
            required
            className={SELECT}
          >
            {branchAccounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name} ({a.code})
              </option>
            ))}
          </select>
          <p className="text-text-muted text-xs">
            The branch&rsquo;s own cash at hand or bank account. Another float till and
            the mobile money wallets are refused.
          </p>
        </div>

        <Field
          label="Provider reference"
          name="reference"
          autoComplete="off"
          hint="What the provider said when the float arrived. Checked for duplicates."
          error={result?.fieldErrors?.reference?.[0]}
        />

        <Button type="submit" loading={pending} className="w-full sm:w-auto">
          Record top-up
        </Button>
        {result === undefined ? null : (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        )}
      </form>
    </Card>
  );
}
