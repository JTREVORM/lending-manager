'use client';

import { useActionState, useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  certifyCommissionReconciliationAction,
  recordCommissionPayoutAction,
  recordCommissionRecoveryAction,
  submitCommissionReconciliationAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type {
  AgencyCommissionReconciliationRow,
  AgencyLineCommissionRow,
} from '@/lib/domain/agency';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/** The line's display name, as every one of these screens writes it. */
function lineName(line: AgencyLineCommissionRow): string {
  return `${line.label ?? line.tillName} — ${line.branchCode}`;
}

/**
 * Commission paid in, recovered, and reconciled against a statement.
 *
 * Three operations that all touch the same two balances from opposite sides,
 * so they are kept on one screen where an officer can see which way each one
 * moves money:
 *
 *   * **a payout** is the provider settling what it owes us, and the money
 *     arrives as float on the line rather than as cash — it debits the
 *     line's float and clears the receivable
 *   * **a recovery** is us settling what we owe the provider after a reversal
 *     (decision OD-10), which clears the recovery payable
 *   * **a reconciliation** compares our figure with the provider's statement
 *     and posts nothing at all
 *
 * The third is the one worth being loudest about. Certifying a statement
 * changes no balance, by decision OD-2, and an officer who expects it to
 * correct a variance will keep certifying and keep seeing the variance.
 */
export function CommissionPayoutForm({
  lines,
}: {
  readonly lines: readonly AgencyLineCommissionRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordCommissionPayoutAction, undefined);
  const formId = useId();

  const payable = lines.filter((l) => l.commissionOutstanding > 0);
  const [lineId, setLineId] = useState(payable[0]?.floatAccountId ?? '');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [payoutDate, setPayoutDate] = useState('');

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setAttempt((n) => n + 1);
      // Controlled fields are not cleared by the remount the changed key
      // triggers — that resets only the uncontrolled ones — so a success
      // clears them here. A refusal clears nothing, which is the point.
      setAmount('');
      setReference('');
      setPayoutDate('');
    }
  }

  if (payable.length === 0) {
    return (
      <Card>
        <h2 className="text-sm font-semibold">Commission paid in</h2>
        <p className="text-muted mt-1 text-sm">
          No agent line you can see is owed commission, so there is nothing to pay in.
        </p>
      </Card>
    );
  }

  const line = payable.find((l) => l.floatAccountId === lineId);

  return (
    <Card>
      <h2 className="text-sm font-semibold">Commission paid in</h2>
      <p className="text-muted mt-1 text-sm">
        The provider pays commission as float on the line, not as cash. This raises the
        line&rsquo;s float and clears the same amount of what the provider owes us.
      </p>

      <form
        key={`payout-${attempt}`}
        action={submit}
        aria-label="Commission paid in"
        className="mt-3 min-w-0 space-y-4"
      >
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-line`}>Agent line</Label>
          <select
            id={`${formId}-line`}
            name="floatAccountId"
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
            className={SELECT}
          >
            {payable.map((l) => (
              <option key={l.floatAccountId} value={l.floatAccountId}>
                {lineName(l)} — owed {l.commissionOutstanding.toLocaleString('en-UG')}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Amount (UGX)"
          name="amount"
          inputMode="numeric"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint={
            line === undefined
              ? undefined
              : `Outstanding on this line: ${line.commissionOutstanding.toLocaleString('en-UG')}. A part payment is allowed; more than the outstanding is refused.`
          }
          error={result?.fieldErrors?.amount?.[0]}
        />

        <Field
          label="Provider reference"
          name="providerReference"
          required
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          hint="The provider's own payout reference. The same one twice on one line is refused."
          error={result?.fieldErrors?.providerReference?.[0]}
        />

        <Field
          label="Payout date (optional)"
          name="payoutDate"
          type="date"
          value={payoutDate}
          onChange={(event) => setPayoutDate(event.target.value)}
          hint="Leave this blank for today in Kampala."
          error={result?.fieldErrors?.payoutDate?.[0]}
        />

        <Button type="submit" loading={pending}>
          Record the payout
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}

/** Clearing what we owe the provider after a reversal (decision OD-10). */
export function CommissionRecoveryForm({
  lines,
}: {
  readonly lines: readonly AgencyLineCommissionRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordCommissionRecoveryAction, undefined);
  const formId = useId();

  const owing = lines.filter((l) => l.recoveryOwed > 0);
  const [lineId, setLineId] = useState(owing[0]?.floatAccountId ?? '');
  const [method, setMethod] = useState<'float_deduction' | 'commission_offset'>(
    'float_deduction',
  );
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setAttempt((n) => n + 1);
      // Controlled fields are not cleared by the remount the changed key
      // triggers — that resets only the uncontrolled ones — so a success
      // clears them here. A refusal clears nothing, which is the point.
      setAmount('');
      setReference('');
    }
  }

  if (owing.length === 0) {
    return (
      <Card>
        <h2 className="text-sm font-semibold">Commission recovered by the provider</h2>
        <p className="text-muted mt-1 text-sm">
          Nothing is owed back to a provider. A reversal of a transaction whose commission
          was already paid in is what puts an amount here.
        </p>
      </Card>
    );
  }

  const line = owing.find((l) => l.floatAccountId === lineId);

  return (
    <Card>
      <h2 className="text-sm font-semibold">Commission recovered by the provider</h2>
      <p className="text-muted mt-1 text-sm">
        A reversed transaction whose commission we had already been paid leaves us owing
        it back. Record here how the provider took it.
      </p>

      <form
        key={`recovery-${attempt}`}
        action={submit}
        aria-label="Commission recovered by the provider"
        className="mt-3 min-w-0 space-y-4"
      >
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-line`}>Agent line</Label>
          <select
            id={`${formId}-line`}
            name="floatAccountId"
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
            className={SELECT}
          >
            {owing.map((l) => (
              <option key={l.floatAccountId} value={l.floatAccountId}>
                {lineName(l)} — owes {l.recoveryOwed.toLocaleString('en-UG')}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-method`}>How it was taken</Label>
          <select
            id={`${formId}-method`}
            name="method"
            value={method}
            onChange={(event) =>
              setMethod(event.target.value as 'float_deduction' | 'commission_offset')
            }
            className={SELECT}
          >
            <option value="float_deduction">Deducted from the line&rsquo;s float</option>
            <option value="commission_offset">
              Set against commission the provider still owes us
            </option>
          </select>
          <p className="text-muted text-xs">
            {method === 'float_deduction'
              ? `Float falls by the amount. The line holds ${(line?.floatBalance ?? 0).toLocaleString('en-UG')}, and a deduction larger than that is refused.`
              : `What the provider owes us falls by the amount. That receivable stands at ${(line?.commissionOutstanding ?? 0).toLocaleString('en-UG')}.`}
          </p>
        </div>

        <Field
          label="Amount (UGX)"
          name="amount"
          inputMode="numeric"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint={
            line === undefined
              ? undefined
              : `Owed back on this line: ${line.recoveryOwed.toLocaleString('en-UG')}. A part recovery is allowed; more than the outstanding is refused.`
          }
          error={result?.fieldErrors?.amount?.[0]}
        />

        <Field
          label="Provider reference"
          name="providerReference"
          required
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          hint="The provider's own reference for the deduction or offset."
          error={result?.fieldErrors?.providerReference?.[0]}
        />

        <Button type="submit" loading={pending}>
          Record the recovery
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Submitting a provider statement for reconciliation.
 *
 * The period is the provider's own statement period, to the day, in Kampala
 * (decision OD-9). Two statements covering the same day on one line are
 * refused, because that is how the same commission gets counted twice.
 */
export function CommissionReconciliationForm({
  lines,
}: {
  readonly lines: readonly AgencyLineCommissionRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(submitCommissionReconciliationAction, undefined);
  const formId = useId();

  const open = lines.filter((l) => l.lineStatus !== 'closed');
  const [lineId, setLineId] = useState(open[0]?.floatAccountId ?? '');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reported, setReported] = useState('');
  const [statementRef, setStatementRef] = useState('');

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setAttempt((n) => n + 1);
      // Controlled fields are not cleared by the remount the changed key
      // triggers — that resets only the uncontrolled ones — so a success
      // clears them here. A refusal clears nothing, which is the point.
      setStart('');
      setEnd('');
      setReported('');
      setStatementRef('');
    }
  }

  if (open.length === 0) {
    return (
      <Alert tone="info">
        No open agent line at a branch you can see, so there is no statement to reconcile.
      </Alert>
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">Reconcile a provider statement</h2>
      <p className="text-muted mt-1 text-sm">
        This compares the provider&rsquo;s commission figure with ours and records the
        difference. It posts nothing. A variance stays visible until somebody corrects the
        underlying transactions or the Owner authorises an adjustment.
      </p>

      <form
        key={`recon-${attempt}`}
        action={submit}
        aria-label="Reconcile a provider statement"
        className="mt-3 min-w-0 space-y-4"
      >
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-line`}>Agent line</Label>
          <select
            id={`${formId}-line`}
            name="floatAccountId"
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
            className={SELECT}
          >
            {open.map((l) => (
              <option key={l.floatAccountId} value={l.floatAccountId}>
                {lineName(l)}
              </option>
            ))}
          </select>
        </div>

        <Field
          label="Statement period starts"
          name="periodStart"
          type="date"
          required
          value={start}
          onChange={(event) => setStart(event.target.value)}
          hint="The provider's own start date, not the start of the month."
          error={result?.fieldErrors?.periodStart?.[0]}
        />

        <Field
          label="Statement period ends"
          name="periodEnd"
          type="date"
          required
          value={end}
          onChange={(event) => setEnd(event.target.value)}
          hint="Inclusive. A period overlapping one already recorded for this line is refused."
          error={result?.fieldErrors?.periodEnd?.[0]}
        />

        <Field
          label="Commission the provider reports (UGX)"
          name="providerReportedCommission"
          inputMode="numeric"
          required
          value={reported}
          onChange={(event) => setReported(event.target.value)}
          hint="Exactly as the statement shows it. Our own figure is computed from the posted transactions in the period."
          error={result?.fieldErrors?.providerReportedCommission?.[0]}
        />

        <Field
          label="Statement reference"
          name="statementRef"
          required
          value={statementRef}
          onChange={(event) => setStatementRef(event.target.value)}
          error={result?.fieldErrors?.statementRef?.[0]}
        />

        <Button type="submit" loading={pending}>
          Submit for certification
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Certifying a reconciliation.
 *
 * The button says what certifying does not do, because a label reading
 * "certify" invites the belief that the variance has been dealt with. It has
 * not: certifying records that a second officer looked at the figures.
 */
export function CommissionReconciliationDecision({
  row,
  canCertify,
}: {
  readonly row: AgencyCommissionReconciliationRow;
  readonly canCertify: boolean;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(certifyCommissionReconciliationAction, undefined);

  if (row.status === 'certified') {
    return <p className="text-muted text-xs">Certified.</p>;
  }

  if (!canCertify) {
    return (
      <p className="text-muted text-xs">
        Waiting for a second officer. Whoever submitted it may not certify it.
      </p>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <form
        action={submit}
        aria-label={`Certify ${row.statementRef}`}
        className="min-w-0 space-y-2"
      >
        <input type="hidden" name="reconciliationId" value={row.id} />
        <Field
          label="Note (optional)"
          name="notes"
          hint="What was checked, or what still has to be chased."
          error={result?.fieldErrors?.notes?.[0]}
        />
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          Certify (changes no balance)
        </Button>
      </form>
      {result !== undefined ? (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      ) : null}
    </div>
  );
}
