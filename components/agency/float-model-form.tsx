'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  setAgencyProviderFloatModelAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type { AgencyProviderRow, LiabilityAccountOption } from '@/lib/domain/agency';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/**
 * Correcting where a provisional provider's money sits.
 *
 * ## Why this control exists at all
 *
 * The provisional provider catalogue was written before the client confirmed
 * how banks actually work, and it recorded every bank as `cash_payable` — the
 * company holds the customer's cash and owes it onward. The Owner's decision 1
 * says the opposite is true: "banks provide electronic float to agents in the
 * same way MTN and Airtel do." Nothing in the application could change that
 * column, so the choice was a migration that edits production data or a
 * control that an Owner can use and that refuses to do damage.
 *
 * ## Why the provider is chosen rather than hard-coded
 *
 * The Owner's instruction was explicit: "Do not blindly update Stanbic."
 * Which bank has which model is business data and the Owner is the one who
 * knows it. A migration naming one bank would also be a migration that is
 * wrong for the second bank the business adds.
 *
 * ## Why the form does not hide itself for a provider it cannot change
 *
 * Every real guard is in the database: provisional, no float held, nothing
 * outstanding on the payable, no posted or in-flight transaction. A screen
 * that greyed out the control would be deciding from data read when the page
 * rendered, and would say nothing about why. The database's refusals are
 * written to be read — "settle the position it holds under the present model
 * first" — and showing one teaches more than hiding a button.
 *
 * What the form *does* do is list the confirmed providers as unavailable with
 * the reason, because that reason does not change and an Owner looking for a
 * bank that is not in the list deserves to be told where it went.
 */
export function FloatModelCorrectionForm({
  providers,
  liabilities,
}: {
  readonly providers: readonly AgencyProviderRow[];
  readonly liabilities: readonly LiabilityAccountOption[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setAgencyProviderFloatModelAction, undefined);

  const [providerId, setProviderId] = useState('');
  const [floatModel, setFloatModel] = useState<'provider_float' | 'cash_payable'>(
    'provider_float',
  );
  const [payableAccountId, setPayableAccountId] = useState('');
  const [reason, setReason] = useState('');

  const [handled, setHandled] = useState(result);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setProviderId('');
      setPayableAccountId('');
      setReason('');
    }
  }

  const correctable = providers.filter((p) => p.isProvisional);
  const confirmed = providers.filter((p) => !p.isProvisional);

  const chosen = correctable.find((p) => p.id === providerId) ?? null;

  if (correctable.length === 0) {
    return (
      <Alert tone="info" title="Every provider's money model is confirmed">
        A confirmed provider&rsquo;s model cannot be corrected here: its posted history
        cites the model that was in force when each entry was made. Changing one means
        settling the position it holds under the present model first.
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-3">
      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      )}

      <div className="min-w-0">
        <Label htmlFor="float-model-provider">Provider</Label>
        <select
          id="float-model-provider"
          name="providerId"
          required
          className={SELECT}
          value={providerId}
          onChange={(event) => {
            setProviderId(event.target.value);
          }}
        >
          <option value="">Choose a provisional provider…</option>
          {correctable.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} — currently{' '}
              {provider.floatModel === 'provider_float'
                ? 'electronic float'
                : 'cash, payable to the provider'}
            </option>
          ))}
        </select>
        {confirmed.length === 0 ? null : (
          <p className="text-text-muted mt-1 text-xs">
            {confirmed.map((p) => p.name).join(', ')}{' '}
            {confirmed.length === 1 ? 'is' : 'are'} confirmed and not in this list. A
            confirmed provider&rsquo;s posted history cites the model that was in force.
          </p>
        )}
      </div>

      <div className="min-w-0">
        <Label htmlFor="float-model-value">Correct it to</Label>
        <select
          id="float-model-value"
          name="floatModel"
          required
          className={SELECT}
          value={floatModel}
          onChange={(event) => {
            setFloatModel(
              event.target.value === 'cash_payable' ? 'cash_payable' : 'provider_float',
            );
          }}
        >
          <option value="provider_float">
            Electronic float — the provider advances float to the agent
          </option>
          <option value="cash_payable">
            Cash, payable — the company holds the customer&rsquo;s cash and owes it onward
          </option>
        </select>
      </div>

      {floatModel === 'cash_payable' ? (
        <div className="min-w-0">
          <Label htmlFor="float-model-payable">Owed on</Label>
          <select
            id="float-model-payable"
            name="payableAccountId"
            required
            className={SELECT}
            value={payableAccountId}
            onChange={(event) => {
              setPayableAccountId(event.target.value);
            }}
          >
            <option value="">Choose a liability account…</option>
            {liabilities.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
              </option>
            ))}
          </select>
          <p className="text-text-muted mt-1 text-xs">
            Required for this model: the customer&rsquo;s money is a debt until it reaches
            the provider, and the debt has to be named.
          </p>
        </div>
      ) : null}

      <Field
        label="Because"
        name="reason"
        required
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        hint="Kept on the audit record. Every other condition is checked by the database; this is the one thing only you know."
      />

      {chosen === null ? null : (
        <div className="border-border bg-surface-muted min-w-0 rounded-lg border p-3 text-xs">
          <p className="font-medium">What this changes</p>
          {chosen.floatModel === floatModel ? (
            <p className="text-text-muted mt-1">
              {chosen.name} already uses this model, so there is nothing to correct.
            </p>
          ) : floatModel === 'provider_float' ? (
            <ul className="text-text-muted mt-1 space-y-0.5">
              <li>Float accounts can be opened against {chosen.name}.</li>
              <li>
                Its payable is cleared from the register — it advances float instead of
                being owed the customer&rsquo;s cash.
              </li>
              <li>
                Refused unless it holds no float and owes nothing, so no balance is
                stranded.
              </li>
            </ul>
          ) : (
            <ul className="text-text-muted mt-1 space-y-0.5">
              <li>
                Customer money taken on {chosen.name} becomes a debt on the liability you
                named.
              </li>
              <li>
                No float account can be opened against it, and refused outright if one
                already is.
              </li>
            </ul>
          )}
          <p className="text-text-muted mt-1">
            No posted entry is altered either way. The model governs what is posted next.
          </p>
        </div>
      )}

      <Button type="submit" size="sm" variant="save" loading={pending}>
        Correct the money model
      </Button>
    </form>
  );
}
