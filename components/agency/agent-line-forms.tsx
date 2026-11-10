'use client';

import { useActionState, useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import {
  closeAgentLineAction,
  registerAgentLineAction,
  setAgentLineSuspendedAction,
  setCommissionSourceAction,
  setServiceLimitAction,
  updateAgentLineAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type {
  AgencyLineCommissionRow,
  AgencyProviderRow,
  AgencyServiceTypeRow,
} from '@/lib/domain/agency';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/** A branch the Owner may open a line at. */
export interface LineBranchOption {
  readonly id: string;
  readonly branchCode: string;
  readonly name: string;
}

/**
 * Registering a Mobile Money agent line.
 *
 * ## What this creates, and what it does not
 *
 * A line is a float ledger account plus the provider's own identifiers for
 * it. Registering one does not activate the provider, set a commission rate
 * or raise a transaction ceiling: those are separate, Owner-only, audited
 * decisions, which is why they are separate forms on this screen rather than
 * fields on this one. A provider with no approved ceiling still cannot be
 * activated no matter how many lines it has (decision OD-11).
 *
 * ## Why the MSISDN is validated here and again in the database
 *
 * The CHECK constraint is the one that matters — it is what stops a line
 * being created with a malformed number by any route, including SQL. The
 * client-side pattern exists so the officer finds out before submitting,
 * not instead of the constraint.
 */
export function AgentLineRegistrationForm({
  providers,
  branches,
}: {
  readonly providers: readonly AgencyProviderRow[];
  readonly branches: readonly LineBranchOption[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(registerAgentLineAction, undefined);
  const formId = useId();

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) setAttempt((n) => n + 1);
  }

  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [tillName, setTillName] = useState('');
  const [label, setLabel] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [agentCode, setAgentCode] = useState('');
  const [openedOn, setOpenedOn] = useState('');

  if (providers.length === 0 || branches.length === 0) {
    return (
      <Alert tone="info">
        {providers.length === 0
          ? 'No Mobile Money provider is registered yet, so there is no line to open.'
          : 'No branch could be read, so a line cannot be placed at one. This needs the branch viewing permission.'}
      </Alert>
    );
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">Open an agent line</h2>
      <p className="text-muted mt-1 text-sm">
        This creates the line&rsquo;s float account at a branch. It does not activate the
        provider, agree a commission rate or set a transaction ceiling.
      </p>

      <form key={`line-${attempt}`} action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-provider`}>Provider</Label>
          <select
            id={`${formId}-provider`}
            name="providerId"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            className={SELECT}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.code}){p.isActive ? '' : ' — not yet activated'}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-branch`}>Branch</Label>
          <select
            id={`${formId}-branch`}
            name="branchId"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            className={SELECT}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.branchCode} — {b.name}
              </option>
            ))}
          </select>
          <p className="text-muted text-xs">
            A line&rsquo;s branch and provider can never be changed afterwards. The float
            it holds belongs to that branch.
          </p>
        </div>

        <Field
          label="Till name"
          name="tillName"
          required
          value={tillName}
          onChange={(event) => setTillName(event.target.value)}
          hint="Short, and unique for the provider — it names the ledger account."
          error={result?.fieldErrors?.tillName?.[0]}
        />

        <Field
          label="Label (optional)"
          name="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          hint="What the staff call this line, if that differs from the till name."
          error={result?.fieldErrors?.label?.[0]}
        />

        <Field
          label="Line number (optional)"
          name="lineMsisdn"
          inputMode="tel"
          value={msisdn}
          onChange={(event) => setMsisdn(event.target.value)}
          hint="The SIM this line transacts on, as +256 and nine digits."
          error={result?.fieldErrors?.lineMsisdn?.[0]}
        />

        <Field
          label="Agent code (optional)"
          name="agentCode"
          value={agentCode}
          onChange={(event) => setAgentCode(event.target.value)}
          hint="The provider's own code for this line, as it appears on the statement."
          error={result?.fieldErrors?.agentCode?.[0]}
        />

        <Field
          label="Opened on (optional)"
          name="openedOn"
          type="date"
          value={openedOn}
          onChange={(event) => setOpenedOn(event.target.value)}
          error={result?.fieldErrors?.openedOn?.[0]}
        />

        <Button type="submit" loading={pending}>
          Open the line
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}

/** Correcting a line's identifiers. Its branch, provider and account cannot move. */
export function AgentLineUpdateForm({
  line,
}: {
  readonly line: AgencyLineCommissionRow;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(updateAgentLineAction, undefined);

  return (
    <div className="min-w-0 space-y-2">
      <form action={submit} className="min-w-0 space-y-2">
        <input type="hidden" name="floatAccountId" value={line.floatAccountId} />
        <Field
          label="Label"
          name="label"
          defaultValue={line.label ?? ''}
          error={result?.fieldErrors?.label?.[0]}
        />
        <Field
          label="Line number"
          name="lineMsisdn"
          inputMode="tel"
          hint="+256 and nine digits. Leave blank to clear it."
          error={result?.fieldErrors?.lineMsisdn?.[0]}
        />
        <Field
          label="Agent code"
          name="agentCode"
          error={result?.fieldErrors?.agentCode?.[0]}
        />
        <Button type="submit" size="sm" variant="secondary" loading={pending}>
          Save
        </Button>
      </form>
      {result !== undefined ? (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      ) : null}
    </div>
  );
}

/**
 * Suspension, and closure.
 *
 * These are the two halves of decision OD-4 and they are deliberately not
 * the same control. Suspension is immediate and keeps everything: the float
 * stays on the line, the history stays readable, and recovery operations are
 * still allowed, which is the whole point — a suspended line is one you are
 * getting money *off*. Closure is the end, and the database refuses it while
 * anything is outstanding.
 *
 * The screen shows what stands in the way rather than offering a button the
 * database will refuse, because an Owner told "nothing stands in the way" by
 * a failed query and then refused at the last step learns to distrust both
 * messages.
 */
export function AgentLineSuspension({
  line,
  obligations,
}: {
  readonly line: AgencyLineCommissionRow;
  readonly obligations: readonly string[] | null;
}) {
  const [suspendResult, suspend, suspending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setAgentLineSuspendedAction, undefined);
  const [closeResult, close, closing] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(closeAgentLineAction, undefined);

  if (line.lineStatus === 'closed') {
    return <p className="text-muted text-xs">Closed.</p>;
  }

  const suspended = line.lineStatus === 'suspended';

  return (
    <div className="min-w-0 space-y-3">
      <form action={suspend} className="min-w-0 space-y-2">
        <input type="hidden" name="floatAccountId" value={line.floatAccountId} />
        <input type="hidden" name="suspended" value={suspended ? 'false' : 'true'} />
        <Field
          label="Reason"
          name="reason"
          required
          hint={
            suspended
              ? 'Why this line may transact again. It stays on the record.'
              : 'Why this line must stop. New transactions stop at once; the float, the history and recovery stay.'
          }
          error={suspendResult?.fieldErrors?.reason?.[0]}
        />
        <Button
          type="submit"
          size="sm"
          variant={suspended ? 'secondary' : 'danger'}
          loading={suspending}
        >
          {suspended ? 'Lift the suspension' : 'Suspend this line'}
        </Button>
      </form>
      {suspendResult !== undefined ? (
        <Alert tone={suspendResult.ok ? 'success' : 'danger'}>
          {suspendResult.message}
        </Alert>
      ) : null}

      {obligations === null ? (
        <Alert tone="warning">
          Whether this line can be closed could not be read, so closing it is not offered.
          This is not a statement that it is clear.
        </Alert>
      ) : obligations.length > 0 ? (
        <div className="min-w-0">
          <p className="text-muted text-xs">Closing this line is blocked by:</p>
          <ul className="text-muted mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {obligations.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <form action={close} className="min-w-0 space-y-2">
            <input type="hidden" name="floatAccountId" value={line.floatAccountId} />
            <Field
              label="Reason for closing"
              name="reason"
              required
              hint="Nothing is outstanding on this line. Closing it is final: it can never transact again."
              error={closeResult?.fieldErrors?.reason?.[0]}
            />
            <Button type="submit" size="sm" variant="danger" loading={closing}>
              Close this line for good
            </Button>
          </form>
          {closeResult !== undefined ? (
            <Alert tone={closeResult.ok ? 'success' : 'danger'}>
              {closeResult.message}
            </Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * The transaction ceiling, per provider and service (decision OD-11).
 *
 * There is no default and no suggested figure here. The database refuses a
 * null and refuses a zero, so a service without an approved ceiling simply
 * has none and the provider cannot be activated. A form that pre-filled a
 * plausible number would be inventing a commercial limit.
 */
export function ServiceLimitForm({
  services,
}: {
  readonly services: readonly AgencyServiceTypeRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setServiceLimitAction, undefined);
  const formId = useId();

  const [handled, setHandled] = useState(result);
  const [attempt, setAttempt] = useState(0);
  if (result !== handled) {
    setHandled(result);
    if (result?.ok === true) setAttempt((n) => n + 1);
  }

  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [max, setMax] = useState('');

  if (services.length === 0) {
    return (
      <Alert tone="info">
        No service type is configured, so there is no ceiling to set.
      </Alert>
    );
  }

  const service = services.find((s) => s.id === serviceId);

  return (
    <Card>
      <h2 className="text-sm font-semibold">Transaction ceiling</h2>
      <p className="text-muted mt-1 text-sm">
        The largest single transaction allowed on a service. There is no default: a
        service without a ceiling cannot be used, and a provider cannot be activated until
        each of its services has one.
      </p>

      <form key={`limit-${attempt}`} action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-service`}>Service</Label>
          <select
            id={`${formId}-service`}
            name="transactionTypeId"
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
            className={SELECT}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.providerName} — {s.name} (
                {s.maxSingleTransaction === null
                  ? 'no ceiling'
                  : s.maxSingleTransaction.toLocaleString('en-UG')}
                )
              </option>
            ))}
          </select>
          {service?.maxSingleTransaction === null ? (
            <p className="text-muted text-xs">
              This service has no ceiling and cannot be transacted on.
            </p>
          ) : null}
        </div>

        <Field
          label="Largest single transaction (UGX)"
          name="maxSingleTransaction"
          inputMode="numeric"
          required
          value={max}
          onChange={(event) => setMax(event.target.value)}
          hint="Whatever the business has agreed with the provider. Zero is refused — it would read as a ceiling when it means the service is unusable."
          error={result?.fieldErrors?.maxSingleTransaction?.[0]}
        />

        <Field
          label="Reason (optional)"
          name="reason"
          hint="Who agreed this, and when. It is kept in the audit log."
          error={result?.fieldErrors?.reason?.[0]}
        />

        <Button type="submit" loading={pending}>
          Set the ceiling
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Where a provider's commission figure comes from.
 *
 * `configured` means we compute it from an agreed rate. `reported` means we
 * take the provider's own figure per transaction, which is what MTN and
 * Airtel actually do when no rate has been agreed in writing. Switching to
 * `reported` clears any rate, because keeping one would leave two
 * contradictory answers to "what does this earn".
 */
export function CommissionSourceForm({
  providers,
}: {
  readonly providers: readonly AgencyProviderRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setCommissionSourceAction, undefined);
  const formId = useId();

  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [source, setSource] = useState<'configured' | 'reported'>('reported');

  if (providers.length === 0) {
    return null;
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold">Where commission comes from</h2>
      <p className="text-muted mt-1 text-sm">
        Either we compute commission from an agreed rate, or we record what the provider
        reports on each transaction. This sets no rate and agrees no terms.
      </p>

      <form action={submit} className="mt-3 min-w-0 space-y-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-provider`}>Provider</Label>
          <select
            id={`${formId}-provider`}
            name="providerId"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
            className={SELECT}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.code})
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${formId}-source`}>Commission figure</Label>
          <select
            id={`${formId}-source`}
            name="source"
            value={source}
            onChange={(event) =>
              setSource(event.target.value as 'configured' | 'reported')
            }
            className={SELECT}
          >
            <option value="reported">
              Entered per transaction, as the provider reports it
            </option>
            <option value="configured">Computed from an agreed rate</option>
          </select>
          <p className="text-muted text-xs">
            {source === 'reported'
              ? 'Any configured rate is cleared. Each transaction carries the figure the provider reported, and that figure is what the ledger records.'
              : 'A rate or fixed amount has to be configured separately before the provider can be activated.'}
          </p>
        </div>

        <Field
          label="Reason (optional)"
          name="reason"
          hint="Kept in the audit log."
          error={result?.fieldErrors?.reason?.[0]}
        />

        <Button type="submit" loading={pending}>
          Set the commission source
        </Button>

        {result !== undefined ? (
          <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
        ) : null}
      </form>
    </Card>
  );
}
