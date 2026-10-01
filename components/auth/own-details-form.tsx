'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { updateOwnDetailsAction } from '@/lib/auth/actions';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Self-service detail editing.
 *
 * Name and contact email only. Phone number is absent because it is the
 * sign-in identifier and changing it would change which login the account
 * answers to; role and status are absent because neither is a user's to
 * decide. The database enforces all three regardless of what is posted.
 */
export function OwnDetailsForm({
  fullName,
  email,
}: {
  readonly fullName: string;
  readonly email: string | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    updateOwnDetailsAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <Field
        label="Full name"
        name="fullName"
        defaultValue={fullName}
        autoComplete="name"
        required
        error={state?.fieldErrors?.fullName?.[0]}
        disabled={pending}
      />

      <Field
        label="Email address"
        name="email"
        type="email"
        inputMode="email"
        defaultValue={email ?? ''}
        hint="Optional, for contact only. You sign in with your phone number."
        error={state?.fieldErrors?.email?.[0]}
        disabled={pending}
      />

      <Button type="submit" loading={pending} className="w-full sm:w-auto">
        Save details
      </Button>
    </form>
  );
}
