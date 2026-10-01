'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SelectField } from './select-field';
import { changeClientStatusAction } from '@/lib/clients/actions';
import {
  CLIENT_STATUSES,
  CLIENT_STATUS_DESCRIPTIONS,
  CLIENT_STATUS_LABELS,
  isClientStatus,
  statusRequiresReason,
  type ClientStatus,
} from '@/lib/domain/client';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Change a client's status.
 *
 * The reason box appears for the statuses that require one, and the
 * requirement is enforced in three places: here (so the person is asked), in
 * the Zod schema (so a direct post is refused), and as a CHECK constraint (so
 * nothing can write the row without it). This layer is the courtesy; the
 * constraint is the guarantee.
 *
 * The options offered are only those the viewer may actually set. Blacklisting
 * is Owner-only, so a Manager is not shown a choice that will be refused —
 * and the database refuses it regardless of what is posted.
 *
 * No optimistic update. A status change is the kind of record where showing
 * "Blacklisted" before the server has agreed would be actively misleading, so
 * the panel waits.
 */
export function ClientStatusPanel({
  clientId,
  currentStatus,
  currentReason,
  canBlacklist,
  canArchive,
}: {
  readonly clientId: string;
  readonly currentStatus: ClientStatus;
  readonly currentReason: string | null;
  readonly canBlacklist: boolean;
  readonly canArchive: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    changeClientStatusAction,
    undefined,
  );

  const [selected, setSelected] = useState<ClientStatus>(currentStatus);

  const available = CLIENT_STATUSES.filter((status) => {
    if (status === 'blacklisted') return canBlacklist;
    if (status === 'archived') return canArchive;
    return true;
  });

  // Lifting a blacklisting also needs the blacklist capability, which the
  // database checks against the *old* status. Saying so here avoids offering a
  // change that will be refused.
  const lockedByBlacklist = currentStatus === 'blacklisted' && !canBlacklist;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="clientId" value={clientId} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {lockedByBlacklist ? (
        <Alert tone="warning">
          This client is blacklisted. Only an Owner or Administrator can lift that.
        </Alert>
      ) : null}

      <SelectField
        label="Status"
        name="status"
        required
        disabled={lockedByBlacklist}
        defaultValue={currentStatus}
        options={available.map((status) => ({
          value: status,
          label: CLIENT_STATUS_LABELS[status],
        }))}
        hint={CLIENT_STATUS_DESCRIPTIONS[selected]}
        error={state?.fieldErrors?.status?.[0]}
        onValueChange={(value) => {
          // Drives the description and whether a reason is demanded. The
          // select remains uncontrolled, so the posted value is its own.
          if (isClientStatus(value)) setSelected(value);
        }}
      />

      <div className="min-w-0 space-y-1.5">
        <Label htmlFor="status-reason">
          Reason
          {statusRequiresReason(selected) ? (
            <>
              <span aria-hidden="true" className="text-danger ml-0.5">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </Label>
        <textarea
          id="status-reason"
          name="reason"
          rows={2}
          maxLength={500}
          disabled={lockedByBlacklist}
          defaultValue={currentReason ?? ''}
          aria-describedby="status-reason-hint"
          aria-invalid={state?.fieldErrors?.reason !== undefined}
          className="border-border bg-surface text-text focus-visible:outline-accent aria-invalid:border-danger w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        />
        <p id="status-reason-hint" className="text-text-muted text-sm">
          {statusRequiresReason(selected)
            ? 'Required. Recorded against the client permanently, with your name.'
            : 'Optional for this status.'}
        </p>
        {state?.fieldErrors?.reason?.[0] !== undefined ? (
          <p role="alert" className="text-danger text-sm">
            {state.fieldErrors.reason[0]}
          </p>
        ) : null}
      </div>

      <Button type="submit" disabled={pending || lockedByBlacklist}>
        {pending ? 'Saving…' : 'Change status'}
      </Button>
    </form>
  );
}
