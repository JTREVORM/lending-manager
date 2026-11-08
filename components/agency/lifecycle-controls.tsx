'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import {
  cancelAgencyTransactionAction,
  returnAgencyTransactionAction,
  reverseAgencyTransactionAction,
  submitAgencyTransactionAction,
  verifyAgencyTransactionAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import type { AgencyStatus } from '@/lib/domain/agency';

type Action = (
  previous: AgencyActionResult | undefined,
  formData: FormData,
) => Promise<AgencyActionResult>;

/**
 * One button that needs no explanation, wired to a real server action.
 *
 * `loading` is the double-submit guard: React keeps the action pending until
 * it resolves and the button is disabled throughout, so a second press cannot
 * post the same money twice. The database refuses it as well, on the
 * idempotency key — this only spares the officer the error.
 */
function OneClick({
  action,
  label,
  transactionId,
  variant,
}: {
  readonly action: Action;
  readonly label: string;
  readonly transactionId: string;
  readonly variant: 'primary' | 'secondary' | 'danger';
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(action, undefined);

  return (
    <form action={submit} className="min-w-0">
      <input type="hidden" name="transactionId" value={transactionId} />
      <Button type="submit" size="sm" variant={variant} loading={pending}>
        {label}
      </Button>
      {result !== undefined ? (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mt-2">
          {result.message}
        </Alert>
      ) : null}
    </form>
  );
}

/** A decision that must say why, because the database requires a reason. */
function Reasoned({
  action,
  submitLabel,
  transactionId,
  hint,
  variant,
}: {
  readonly action: Action;
  readonly submitLabel: string;
  readonly transactionId: string;
  readonly hint: string;
  readonly variant: 'secondary' | 'danger';
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(action, undefined);

  return (
    <form
      action={submit}
      className="border-border bg-surface-sunken min-w-0 space-y-2 rounded-lg border p-3"
    >
      <input type="hidden" name="transactionId" value={transactionId} />
      <Field
        label="Reason"
        name="reason"
        required
        autoComplete="off"
        hint={hint}
        error={result?.fieldErrors?.reason?.[0]}
      />
      <Button type="submit" size="sm" variant={variant} loading={pending}>
        {submitLabel}
      </Button>
      {result !== undefined ? (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      ) : null}
    </form>
  );
}

/** A control the officer may not use, saying so rather than vanishing. */
function Unavailable({ reason }: { readonly reason: string }) {
  return (
    <p className="text-text-muted text-xs" role="note">
      {reason}
    </p>
  );
}

export interface LifecycleControlsProps {
  readonly transactionId: string;
  readonly status: AgencyStatus;
  /** Whether the signed-in officer recorded this one. */
  readonly isOwnEntry: boolean;
  readonly canWrite: boolean;
  readonly canVerify: boolean;
  readonly canReverse: boolean;
  readonly canReverseCrossDay: boolean;
  /** Whether the transaction is dated before today. */
  readonly isPriorDay: boolean;
}

/**
 * What can be done to one transaction next.
 *
 * Every branch either renders a button wired to a server action or says in
 * words why it is not available. Nothing is silently hidden: an officer who
 * cannot verify should learn that verification exists and is somebody else's,
 * which is also what stops them asking why the screen looks different from a
 * colleague's.
 *
 * None of this is authorization. The capability flags come from the session
 * and the database refuses the same things again with SQLSTATE 42501 — a
 * disabled button is a courtesy, not a control.
 */
export function LifecycleControls({
  transactionId,
  status,
  isOwnEntry,
  canWrite,
  canVerify,
  canReverse,
  canReverseCrossDay,
  isPriorDay,
}: LifecycleControlsProps) {
  if (status === 'draft' || status === 'returned') {
    if (!canWrite)
      return (
        <Unavailable reason="Only a recording officer can send this for verification." />
      );
    return (
      <div className="min-w-0 space-y-2">
        <OneClick
          action={submitAgencyTransactionAction}
          label="Send for verification"
          transactionId={transactionId}
          variant="primary"
        />
        <Reasoned
          action={cancelAgencyTransactionAction}
          submitLabel="Cancel"
          transactionId={transactionId}
          hint="Kept on the record. Nothing is deleted."
          variant="secondary"
        />
      </div>
    );
  }

  if (status === 'awaiting_verification') {
    if (!canVerify) {
      return (
        <Unavailable reason="Awaiting a second officer. Verification is a manager's, and never the officer who recorded it." />
      );
    }
    if (isOwnEntry) {
      return (
        <Unavailable reason="You recorded this one, so you cannot verify it. A second officer must." />
      );
    }
    return (
      <div className="min-w-0 space-y-2">
        <OneClick
          action={verifyAgencyTransactionAction}
          label="Verify and post"
          transactionId={transactionId}
          variant="primary"
        />
        <Reasoned
          action={returnAgencyTransactionAction}
          submitLabel="Return for correction"
          transactionId={transactionId}
          hint="Sends it back to the counter with your note. No journal is written."
          variant="secondary"
        />
      </div>
    );
  }

  if (status === 'posted') {
    if (!canReverse) return <Unavailable reason="Posted. Reversing it is a manager's." />;
    if (isPriorDay && !canReverseCrossDay) {
      return (
        <Unavailable reason="Dated before today. Reversing a closed day is the Owner's." />
      );
    }
    return (
      <Reasoned
        action={reverseAgencyTransactionAction}
        submitLabel="Reverse"
        transactionId={transactionId}
        hint="Posts a mirrored contra entry. The original stays on the record."
        variant="danger"
      />
    );
  }

  return (
    <Unavailable
      reason={status === 'reversed' ? 'Reversed by contra entry.' : 'Cancelled.'}
    />
  );
}
