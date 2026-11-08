'use client';

import { useActionState, useId, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import {
  recordAgencyTransactionAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import { toUgx } from '@/lib/domain/money';
import type { AgencyFloatRow, AgencyServiceTypeRow } from '@/lib/domain/agency';

export interface RecordFormProps {
  /** Services the officer may post against: live providers only. */
  readonly services: readonly AgencyServiceTypeRow[];
  /** Tills available for a float-model provider. */
  readonly tills: readonly AgencyFloatRow[];
  /**
   * Confirmed commission terms per provider, as basis points or a fixed
   * amount — whichever the provider actually has. Absent when a provider's
   * terms are not approved, in which case no figure is shown at all rather
   * than a guess.
   */
  readonly terms: Readonly<
    Record<string, { readonly rateBps: number | null; readonly fixed: number | null }>
  >;
}

/**
 * Recording one agency transaction.
 *
 * ## There is no commission field
 *
 * Deliberate, and it is the Phase 4B-S decision carried into the interface: an
 * operator-typed commission is how recognised income becomes whatever somebody
 * entered. The posting engine computes it from the provider's configured terms,
 * and a difference from those terms needs an Owner's authorisation with a
 * reason and external evidence — which is its own screen, not a field here.
 *
 * What this form does show, read-only, is what those terms *will* produce, so
 * the officer can tell the customer before confirming. It is an estimate
 * rendered from the same integer arithmetic the engine uses (half-up on basis
 * points), and the engine recomputes it under lock at posting. When a
 * provider's terms are not confirmed, nothing is shown.
 *
 * ## Double submission
 *
 * The idempotency key is generated once per mounted form, so a second press —
 * or a retry after a timeout the officer never saw resolve — carries the same
 * key and the database refuses the duplicate rather than posting twice. The
 * button is also disabled while the action is pending.
 */
export function RecordForm({ services, tills, terms }: RecordFormProps) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordAgencyTransactionAction, undefined);

  const formId = useId();
  // One key per mounted form: a retry of the same submission reuses it.
  const [idempotencyKey] = useState(
    () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [principal, setPrincipal] = useState('');

  const service = services.find((s) => s.id === serviceId) ?? null;
  const providerTerms = service === null ? undefined : terms[service.providerId];

  const providerTills = useMemo(
    () =>
      service === null ? [] : tills.filter((t) => t.providerId === service.providerId),
    [service, tills],
  );

  /**
   * What the configured terms produce, for display only.
   *
   * Half-up in integer arithmetic, matching `agency_commission_for`:
   * `(principal * bps + 5000) / 10000`. A provider configuring both a rate and
   * a fixed amount is refused by the database rather than resolved, so this
   * shows nothing in that case instead of choosing one.
   */
  const estimate = useMemo(() => {
    if (providerTerms === undefined) return null;
    const amount = Number.parseInt(principal.replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const { rateBps, fixed } = providerTerms;
    if (rateBps !== null && fixed !== null) return null;
    if (rateBps !== null) return Math.trunc((amount * rateBps + 5000) / 10000);
    if (fixed !== null) return fixed;
    return null;
  }, [providerTerms, principal]);

  if (services.length === 0) {
    return (
      <Alert tone="info">
        No service is available to post against. Every provider is still provisional or
        inactive, which is deliberate until its commercial terms are approved.
      </Alert>
    );
  }

  return (
    <Card>
      <form action={submit} className="min-w-0 space-y-4">
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-service`}>Service</Label>
          <select
            id={`${formId}-service`}
            name="transactionTypeId"
            required
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
            className="border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.providerName} — {s.name} ({s.direction})
              </option>
            ))}
          </select>
          {result?.fieldErrors?.transactionTypeId?.[0] === undefined ? null : (
            <p className="text-danger text-xs">
              {result.fieldErrors.transactionTypeId[0]}
            </p>
          )}
        </div>

        {providerTills.length === 0 ? null : (
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${formId}-till`}>Float till</Label>
            <select
              id={`${formId}-till`}
              name="floatAccountId"
              required
              className="border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              {providerTills.map((t) => (
                <option key={t.floatAccountId} value={t.floatAccountId}>
                  {t.tillName} — {t.branchCode} (holds {t.balance.toLocaleString('en-UG')}
                  )
                </option>
              ))}
            </select>
          </div>
        )}

        <Field
          label="Amount (UGX)"
          name="principalAmount"
          inputMode="numeric"
          required
          value={principal}
          onChange={(event) => setPrincipal(event.target.value)}
          hint="A whole number of shillings."
          error={result?.fieldErrors?.principalAmount?.[0]}
        />

        <Field
          label="Customer fee (UGX)"
          name="customerFee"
          inputMode="numeric"
          defaultValue="0"
          hint="What the customer paid us on top, if anything."
          error={result?.fieldErrors?.customerFee?.[0]}
        />

        {/* Read-only, and absent when the terms are not confirmed. */}
        <div
          className="border-border bg-surface-sunken min-w-0 rounded-lg border p-3"
          aria-live="polite"
        >
          <p className="text-text-muted text-xs font-medium">
            Commission these terms produce
          </p>
          {estimate === null ? (
            <p className="text-text-muted mt-1 text-sm">
              {providerTerms === undefined
                ? 'This provider has no confirmed commission terms, so no figure is shown.'
                : 'Enter an amount to see it.'}
            </p>
          ) : (
            <p className="mt-1 text-sm font-semibold">
              <Money amount={toUgx(estimate)} />
            </p>
          )}
          <p className="text-text-muted mt-1 text-[10px]">
            Calculated by the posting engine, not entered here. A difference from the
            provider&rsquo;s terms needs the Owner&rsquo;s authorisation.
          </p>
        </div>

        <Field
          label="Customer identifier"
          name="customerIdentifier"
          required
          autoComplete="off"
          hint="The phone number, meter number or account the customer gave."
          error={result?.fieldErrors?.customerIdentifier?.[0]}
        />

        <Field
          label="Customer name"
          name="customerName"
          autoComplete="off"
          hint="Optional."
          error={result?.fieldErrors?.customerName?.[0]}
        />

        <Field
          label="Provider reference"
          name="providerReference"
          required
          autoComplete="off"
          hint="What the provider's own system called it. Checked for duplicates."
          error={result?.fieldErrors?.providerReference?.[0]}
        />

        <Field
          label="Note"
          name="description"
          autoComplete="off"
          hint="Optional."
          error={result?.fieldErrors?.description?.[0]}
        />

        <div className="min-w-0">
          <Button type="submit" loading={pending} className="w-full sm:w-auto">
            Record transaction
          </Button>
          <p className="text-text-muted mt-2 text-xs">
            Recording does not post anything. A second officer verifies it, and
            verification is what writes the journal.
          </p>
        </div>

        {result === undefined ? null : (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        )}
      </form>
    </Card>
  );
}
