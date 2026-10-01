'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { changePasswordAction } from '@/lib/auth/actions';
import { MIN_PASSWORD_LENGTH } from '@/lib/validation/auth';
import type { ActionResult } from '@/lib/auth/actions';

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    changePasswordAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <PasswordInput
        label="Current password"
        name="currentPassword"
        autoComplete="current-password"
        required
        hint="The one you signed in with."
        error={state?.fieldErrors?.currentPassword?.[0]}
        disabled={pending}
      />

      <PasswordInput
        label="New password"
        name="newPassword"
        autoComplete="new-password"
        required
        hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters. A short phrase you can remember works well.`}
        error={state?.fieldErrors?.newPassword?.[0]}
        disabled={pending}
      />

      <PasswordInput
        label="Confirm new password"
        name="confirmPassword"
        autoComplete="new-password"
        required
        error={state?.fieldErrors?.confirmPassword?.[0]}
        disabled={pending}
      />

      <Button type="submit" size="lg" loading={pending} className="w-full sm:w-auto">
        {pending ? 'Changing password' : 'Change password'}
      </Button>
    </form>
  );
}
