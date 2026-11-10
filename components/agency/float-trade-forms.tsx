'use client';

import { useActionState, useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  recordFloatTradeAction,
  rejectFloatTradeAction,
  reverseFloatTradeAction,
  verifyFloatTradeAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type { AgencyFloatTradeRow, AgencyLineCommissionRow } from '@/lib/domain/agency';

import type { SettlementAccount } from './settlement-forms';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/**
 * Recording a float trade, and deciding on one.
 *
 * ## Why the form says what it does before it says anything else
 *
 * Decision OD-7 separates recording from posting, and the thing a cashier
 * most needs to understand is that pressing this button moves nothing. It is
 * stated above the fields, repeated in the button's label, and repeated again
 * in the success message, because an officer who believes the money has moved
 * will record it a second time when the balance does not change.
 *
 * ## Why every typed field is controlled
 *
 * React resets an uncontrolled form after a form action completes, whatever
 * the action returned. Phase 4D-F found that at the counter: a refusal left
 * the officer staring at a blank form with the customer still waiting and no
 * way to tell whether the money had moved. These fields keep what was typed
 * when a submission fails, and clear only when one succeeds.
 *
 * ## Why no figure here is computed
 *
 * A sale's proceeds, a purchase's premium and the float a line can afford are
 * all decided by the database at the moment of posting, under lock. The
 * balances shown beside the fields come from the views and are there to
 * inform, not to gate — a form that pre-checked them would be checking a
 * stale fact while looking authoritative.
 */
export function FloatTradeForm({
  lines,
  accounts,
  providerName,
}: {
  readonly lines: readonly AgencyLineCommissionRow[];
  readonly accounts: readonly SettlementAccount[];
  readonly providerName: string;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordFloatTradeAction, undefined);
  const formId = useId();

  // Advanced only when a trade is actually recorded, so a refused submission
  // keeps what was typed. Adjusted during render rather than in an effect,
  // which is what `react-hooks/set-state-in-effect` asks for.
  const tradeable = lines.filter((l) => l.lineStatus !== 'closed');
  const [kind, setKind] = useState<'purchase' | 'sale' | 'transfer'>('purchase');
  const [lineId, setLineId] = useState(tradeable[0]?.floatAccountId ?? '');
  const [counterId, setCounterId] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  const [source, setSource] = useState('provider_service_centre');
  const [floatAmount, setFloatAmount] = useState('');
  const [cashAmount, setCashAmount] = useState('');
  const [feeAmount, setFeeAmount] = useState('0');
  const [reference, setReference] = useState('');
  const [party, setParty] = useState('');

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setAttempt((n) => n + 1);
      // Controlled fields are not cleared by the remount the changed key
      // triggers — that resets only the uncontrolled ones — so a success
      // clears them here. A refusal clears nothing, which is the point: the
      // officer keeps what they typed with the customer still waiting.
      setFloatAmount('');
      setCashAmount('');
      setFeeAmount('0');
      setReference('');
      setParty('');
    }
  }

  if (tradeable.length === 0) {
    return (
      <Alert tone="info">
        {providerName} has no open agent line at a branch you can see, so there is nothing
        to trade float against.
      </Alert>
    );
  }

  const line = tradeable.find((l) => l.floatAccountId === lineId);
  const counters = tradeable.filter(
    (l) => l.floatAccountId !== lineId && l.lineStatus === 'active',
  );

  return (
    <Card>
      <h2 className="text-sm font-semibold">Record a float trade</h2>
      <p className="text-muted mt-1 text-sm">
        This records what happened and moves nothing. A different Manager or the Owner has
        to check the figures before anything is posted.
      </p>

      <form
        key={`trade-${attempt}`}
        action={submit}
        aria-label="Record a float trade"
        className="mt-3 min-w-0 space-y-4"
      >
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-kind`}>What happened</Label>
          <select
            id={`${formId}-kind`}
            name="kind"
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as 'purchase' | 'sale' | 'transfer')
            }
            className={SELECT}
          >
            <option value="purchase">We bought float</option>
            <option value="sale">We sold float</option>
            <option value="transfer">We moved float between our own lines</option>
          </select>
        </div>

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-line`}>
            {kind === 'purchase' ? 'Float received into' : 'Float taken from'}
          </Label>
          <select
            id={`${formId}-line`}
            name="floatAccountId"
            value={lineId}
            onChange={(event) => setLineId(event.target.value)}
            className={SELECT}
          >
            {tradeable.map((l) => (
              <option key={l.floatAccountId} value={l.floatAccountId}>
                {l.label ?? l.tillName} — {l.branchCode} (holds{' '}
                {l.floatBalance.toLocaleString('en-UG')})
                {l.lineStatus === 'suspended' ? ' — suspended' : ''}
              </option>
            ))}
          </select>
          {line?.lineStatus === 'suspended' ? (
            <p className="text-muted text-xs">
              This line is suspended. Float can be moved off it or sold, which is how it
              is recovered, but nothing may be bought into it.
            </p>
          ) : null}
        </div>

        {kind === 'transfer' ? (
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${formId}-counter`}>Float moved into</Label>
            <select
              id={`${formId}-counter`}
              name="counterFloatAccountId"
              value={counterId}
              onChange={(event) => setCounterId(event.target.value)}
              className={SELECT}
            >
              <option value="">Choose a line</option>
              {counters.map((l) => (
                <option key={l.floatAccountId} value={l.floatAccountId}>
                  {l.label ?? l.tillName} — {l.branchCode}
                </option>
              ))}
            </select>
            <p className="text-muted text-xs">
              Both lines must belong to {providerName}. A transfer into another branch
              needs authority over both.
            </p>
          </div>
        ) : (
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${formId}-account`}>
              {kind === 'purchase' ? 'Paid from' : 'Proceeds into'}
            </Label>
            <select
              id={`${formId}-account`}
              name="settlementAccountId"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className={SELECT}
            >
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <Field
          label="Float (UGX)"
          name="floatAmount"
          inputMode="numeric"
          required
          value={floatAmount}
          onChange={(event) => setFloatAmount(event.target.value)}
          hint={
            line === undefined
              ? undefined
              : `${line.label ?? line.tillName} holds ${line.floatBalance.toLocaleString('en-UG')}.`
          }
          error={result?.fieldErrors?.floatAmount?.[0]}
        />

        {kind === 'purchase' ? (
          <>
            <Field
              label="Paid (UGX)"
              name="cashAmount"
              inputMode="numeric"
              required
              value={cashAmount}
              onChange={(event) => setCashAmount(event.target.value)}
              hint="What actually left the drawer or the bank. More than the float is a premium and is booked as an expense; less is a discount and is booked as income."
              error={result?.fieldErrors?.cashAmount?.[0]}
            />
            <div className="min-w-0 space-y-1">
              <Label htmlFor={`${formId}-source`}>Bought from</Label>
              <select
                id={`${formId}-source`}
                name="sourceKind"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className={SELECT}
              >
                <option value="provider_service_centre">
                  The provider&rsquo;s service centre
                </option>
                <option value="external_agent">Another agent</option>
                <option value="bank">The bank</option>
                <option value="cash">Cash, over the counter</option>
              </select>
            </div>
          </>
        ) : null}

        {kind === 'sale' ? (
          <Field
            label="Service fee (UGX)"
            name="feeAmount"
            inputMode="numeric"
            required
            value={feeAmount}
            onChange={(event) => setFeeAmount(event.target.value)}
            hint="Enter 0 to sell without a fee. Whatever you enter is recognised as fee income separately from the float; no rate is applied."
            error={result?.fieldErrors?.feeAmount?.[0]}
          />
        ) : null}

        <Field
          label="Reference"
          name="reference"
          required
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          hint="The provider's or counterparty's own reference. The same one twice on one line is refused."
          error={result?.fieldErrors?.reference?.[0]}
        />

        {kind !== 'transfer' ? (
          <Field
            label="Counterparty (optional)"
            name="counterpartyName"
            value={party}
            onChange={(event) => setParty(event.target.value)}
            hint="Who we bought from or sold to."
            error={result?.fieldErrors?.counterpartyName?.[0]}
          />
        ) : null}

        <Button type="submit" loading={pending}>
          Record, for checking
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * The checker's side.
 *
 * `expectedRevision` is sent with the verification: the officer is approving
 * the figures this row was rendered with, and if somebody edited them since,
 * the database refuses rather than posting what was never seen.
 */
export function FloatTradeDecision({
  trade,
  canPost,
  canReverse,
}: {
  readonly trade: AgencyFloatTradeRow;
  readonly canPost: boolean;
  readonly canReverse: boolean;
}) {
  const [verifyResult, verify, verifying] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(verifyFloatTradeAction, undefined);
  const [rejectResult, reject, rejecting] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(rejectFloatTradeAction, undefined);
  const [reverseResult, reverse, reversing] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(reverseFloatTradeAction, undefined);

  if (trade.status === 'pending') {
    if (!canPost) {
      return (
        <p className="text-muted text-xs">
          Waiting for a Manager or the Owner. Recording it is not posting it.
        </p>
      );
    }
    return (
      <div className="min-w-0 space-y-2">
        <form action={verify} aria-label={`Check ${trade.reference}`} className="min-w-0">
          <input type="hidden" name="tradeId" value={trade.id} />
          <input type="hidden" name="expectedRevision" value={String(trade.revision)} />
          <Button type="submit" size="sm" variant="primary" loading={verifying}>
            Check and post
          </Button>
        </form>
        {verifyResult !== undefined ? (
          <Alert tone={verifyResult.ok ? 'success' : 'danger'}>
            {verifyResult.message}
          </Alert>
        ) : null}

        <form
          action={reject}
          aria-label={`Refuse ${trade.reference}`}
          className="min-w-0 space-y-2"
        >
          <input type="hidden" name="tradeId" value={trade.id} />
          <Field
            label="Reason"
            name="reason"
            required
            hint="Why this is refused. It stays on the record."
            error={rejectResult?.fieldErrors?.reason?.[0]}
          />
          <Button type="submit" size="sm" variant="secondary" loading={rejecting}>
            Refuse
          </Button>
        </form>
        {rejectResult !== undefined ? (
          <Alert tone={rejectResult.ok ? 'success' : 'danger'}>
            {rejectResult.message}
          </Alert>
        ) : null}
      </div>
    );
  }

  if (trade.status === 'posted' && canReverse) {
    return (
      <div className="min-w-0 space-y-2">
        <form
          action={reverse}
          aria-label={`Reverse ${trade.reference}`}
          className="min-w-0 space-y-2"
        >
          <input type="hidden" name="tradeId" value={trade.id} />
          <Field
            label="Reason"
            name="reason"
            required
            hint="Both entries are kept and a contra is posted."
            error={reverseResult?.fieldErrors?.reason?.[0]}
          />
          <Button type="submit" size="sm" variant="danger" loading={reversing}>
            Reverse
          </Button>
        </form>
        {reverseResult !== undefined ? (
          <Alert tone={reverseResult.ok ? 'success' : 'danger'}>
            {reverseResult.message}
          </Alert>
        ) : null}
      </div>
    );
  }

  if (trade.status === 'rejected') {
    return (
      <p className="text-muted text-xs">Refused: {trade.rejectedReason ?? 'no reason'}</p>
    );
  }

  if (trade.status === 'reversed') {
    return (
      <p className="text-muted text-xs">
        Reversed: {trade.reversalReason ?? 'no reason'}
      </p>
    );
  }

  return null;
}
