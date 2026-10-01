'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { updateClientIdentityAction } from '@/lib/clients/actions';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Correct a client's National Identification Number.
 *
 * Separate from the main edit form because it writes a different table under a
 * different policy, and because a change here is a correction to identity
 * evidence rather than an ordinary edit — it deserves its own deliberate
 * submission rather than riding along with a phone number change.
 *
 * The existing value is shown in full: somebody correcting a number needs to
 * see what is currently recorded in order to compare it with the card.
 */
export function ClientIdentityForm({
  clientId,
  currentNin,
}: {
  readonly clientId: string;
  readonly currentNin: string | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    updateClientIdentityAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="clientId" value={clientId} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <Field
        label="National Identification Number"
        name="nin"
        autoCapitalize="characters"
        spellCheck={false}
        defaultValue={currentNin ?? ''}
        hint="14 characters, beginning CM or CF. Clear the field to remove the recorded number."
        error={state?.fieldErrors?.nin?.[0]}
      />

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save identification'}
      </Button>
    </form>
  );
}
