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
import type {
  AgencyFloatRow,
  AgencyServiceTypeRow,
  OperatingBranchOption,
} from '@/lib/domain/agency';

export interface RecordFormProps {
  /** Services the officer may post against: live providers only. */
  readonly services: readonly AgencyServiceTypeRow[];
  /** Tills available for a float-model provider. */
  readonly tills: readonly AgencyFloatRow[];
  /**
   * The branches this officer may record at.
   *
   * One entry, their own, for a branch-assigned officer. Every open branch
   * for one with no branch of their own, who has to choose.
   */
  readonly branches: readonly OperatingBranchOption[];
  /** Their own branch, or null for a Head Office account. */
  readonly ownBranch: OperatingBranchOption | null;
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
 * ## Double submission, and the thing that is not one
 *
 * The idempotency key answers one question: "did the submission I just made
 * arrive?" So it has to survive a retry of *that* submission and must not
 * survive past it.
 *
 * Phase 4D built only the first half. The key was minted once per mounted
 * form, which is right for a double tap and wrong for everything after a
 * success: a secretary who recorded one customer and then typed the next
 * without reloading sent the second transaction under the first one's key,
 * and the database - correctly idempotent - handed back the first
 * transaction while this form reported success. The second customer's money
 * was never recorded.
 *
 * So the key is `mount nonce + attempt`, and the attempt advances on a
 * confirmed success and on nothing else:
 *
 *   - **pending** - the button is disabled, so a double tap cannot submit
 *     twice from here at all;
 *   - **failed, or never answered** - the key is unchanged, so the officer's
 *     retry is the same submission asked again and the database returns the
 *     first transaction rather than writing a second;
 *   - **succeeded** - a new key, and the customer's fields are cleared, so
 *     the next customer is a new transaction.
 *
 * None of that is a guarantee on its own, which is why the database makes
 * the same distinction itself: `create_agency_transaction` refuses a key
 * already recorded against materially different details instead of returning
 * the earlier transaction. This form is the convenience; that is the control.
 */
export function RecordForm({
  services,
  tills,
  terms,
  branches,
  ownBranch,
}: RecordFormProps) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(recordAgencyTransactionAction, undefined);

  const formId = useId();

  /**
   * One nonce per mounted form, and one attempt number per recorded
   * transaction. Together they are the submission's identity.
   */
  const [mountNonce] = useState(
    () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [attempt, setAttempt] = useState(0);
  const idempotencyKey = `ui-${mountNonce}-${String(attempt)}`;

  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');

  /**
   * Every field the officer types is controlled, and that is not a style
   * preference.
   *
   * React resets an uncontrolled form after a form action completes -
   * whatever the action returned. So a submission that failed, or that the
   * counter's connection never answered, used to leave the officer staring
   * at a blank form with the customer in front of them and no idea whether
   * the money had moved. Holding the values in state keeps them through a
   * failure, and lets a success clear them deliberately rather than as a
   * side effect of the framework.
   */
  const [principal, setPrincipal] = useState('');
  const [fee, setFee] = useState('0');
  const [customerIdentifier, setCustomerIdentifier] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [providerReference, setProviderReference] = useState('');
  const [description, setDescription] = useState('');

  /**
   * A recorded transaction ends this submission.
   *
   * The attempt advances, which retires the key, and the fields that
   * describe a customer are cleared so the next one starts empty. The
   * service and the till stay as they are: a counter works one provider at
   * a time, and re-choosing it for every customer in the queue is how an
   * officer ends up recording against the wrong till.
   *
   * Adjusted during render against the last result this form has seen,
   * rather than in an effect. `result` keeps its identity until the next
   * submission resolves, so the comparison fires exactly once per
   * resolution - and React re-renders with the new state before anything
   * reaches the screen, so the officer never sees the old customer's
   * details beside a success message.
   */
  const [handled, setHandled] = useState(result);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) {
      setAttempt((n) => n + 1);
      setPrincipal('');
      setFee('0');
      setCustomerIdentifier('');
      setCustomerName('');
      setProviderReference('');
      setDescription('');
    }
  }

  const service = services.find((s) => s.id === serviceId) ?? null;
  const providerTerms = service === null ? undefined : terms[service.providerId];

  /**
   * The operating branch.
   *
   * An officer with a branch of their own records at it and is told so
   * rather than asked. One with none starts on no branch at all: a
   * pre-selected first option would be the silent default this correction
   * exists to remove, and the officer would never see the choice they were
   * making.
   */
  const [branchId, setBranchId] = useState(ownBranch?.id ?? '');

  const providerTills = useMemo(
    () =>
      service === null
        ? []
        : tills.filter(
            (t) => t.providerId === service.providerId && t.branchId === branchId,
          ),
    [service, tills, branchId],
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

        {ownBranch !== null ? (
          <>
            <input type="hidden" name="branchId" value={ownBranch.id} />
            <p className="text-muted text-sm">
              Recording at <span className="font-semibold">{ownBranch.branchCode}</span> —{' '}
              {ownBranch.name}, the branch your account is assigned to. Transactions
              cannot be recorded at another branch from this account.
            </p>
          </>
        ) : branches.length === 0 ? (
          <Alert tone="warning">
            Your account is not assigned to a branch, and no open branch could be read, so
            there is nowhere to record this transaction. This is not a statement that the
            business has no branches.
          </Alert>
        ) : (
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${formId}-branch`}>Branch</Label>
            <select
              id={`${formId}-branch`}
              name="branchId"
              required
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              className="border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
            >
              <option value="">Choose the branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.branchCode} — {b.name}
                </option>
              ))}
            </select>
            <p className="text-muted text-xs">
              Your account is not assigned to a branch, so the branch has to be said. It
              decides which drawer the cash moves through and which tills are available
              below; it is never assumed.
            </p>
            {result?.fieldErrors?.branchId?.[0] === undefined ? null : (
              <p className="text-danger text-xs">{result.fieldErrors.branchId[0]}</p>
            )}
          </div>
        )}

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

        {service !== null && branchId !== '' && providerTills.length === 0 ? (
          <Alert tone="info">
            {service.providerName} has no active till at the branch you have chosen. A
            transaction settled from electronic float needs one, and the database refuses
            a till belonging to another branch.
          </Alert>
        ) : null}

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
          value={fee}
          onChange={(event) => setFee(event.target.value)}
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

        {/*
          Cleared on a recorded transaction and kept through a failure. The
          next customer's reference must not be the last customer's, and a
          form that still reads "Nakato" after Nakato's transaction was
          recorded is a form that invites recording it twice.
        */}
        <Field
          label="Customer identifier"
          name="customerIdentifier"
          required
          autoComplete="off"
          value={customerIdentifier}
          onChange={(event) => setCustomerIdentifier(event.target.value)}
          hint="The phone number, meter number or account the customer gave."
          error={result?.fieldErrors?.customerIdentifier?.[0]}
        />

        <Field
          label="Customer name"
          name="customerName"
          autoComplete="off"
          value={customerName}
          onChange={(event) => setCustomerName(event.target.value)}
          hint="Optional."
          error={result?.fieldErrors?.customerName?.[0]}
        />

        <Field
          label="Provider reference"
          name="providerReference"
          required
          autoComplete="off"
          value={providerReference}
          onChange={(event) => setProviderReference(event.target.value)}
          hint="What the provider's own system called it. Checked for duplicates."
          error={result?.fieldErrors?.providerReference?.[0]}
        />

        <Field
          label="Note"
          name="description"
          autoComplete="off"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
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
