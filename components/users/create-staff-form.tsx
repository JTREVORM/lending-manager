'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { createStaffUserAction } from '@/lib/auth/admin-actions';
import { MIN_PASSWORD_LENGTH } from '@/lib/validation/auth';
import { ROLES, type RoleKey } from '@/lib/permissions';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Create a staff account.
 *
 * The role options are the ones the acting administrator may actually grant,
 * resolved server-side from their own rank. The database refuses anything
 * beyond that regardless, so this is about not offering a choice that will be
 * rejected rather than about preventing one.
 */
export function CreateStaffForm({
  assignableRoles,
}: {
  readonly assignableRoles: readonly RoleKey[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    createStaffUserAction,
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
        autoComplete="name"
        required
        error={state?.fieldErrors?.fullName?.[0]}
        disabled={pending}
      />

      <Field
        label="Phone number"
        name="phone"
        type="tel"
        inputMode="tel"
        required
        hint="This is what they will sign in with. For example 0772 123 456."
        error={state?.fieldErrors?.phone?.[0]}
        disabled={pending}
      />

      <Field
        label="Email address"
        name="email"
        type="email"
        inputMode="email"
        hint="Optional. Used for contact only — sign-in is by phone number."
        error={state?.fieldErrors?.email?.[0]}
        disabled={pending}
      />

      <div className="space-y-1.5">
        <Label htmlFor="roleKey" required>
          Role
        </Label>
        <select
          id="roleKey"
          name="roleKey"
          required
          disabled={pending}
          defaultValue=""
          aria-describedby="roleKey-hint"
          className="min-h-touch bg-surface text-text border-border-strong w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
        >
          <option value="" disabled>
            Choose a role
          </option>
          {assignableRoles.map((role) => (
            <option key={role} value={role}>
              {ROLES[role].label}
            </option>
          ))}
        </select>
        <p id="roleKey-hint" className="text-text-muted text-xs">
          You can only grant roles up to your own level of authority.
        </p>
        {state?.fieldErrors?.roleKey?.[0] !== undefined ? (
          <p role="alert" className="text-danger text-xs font-medium">
            {state.fieldErrors.roleKey[0]}
          </p>
        ) : null}
      </div>

      <PasswordInput
        label="Temporary password"
        name="temporaryPassword"
        autoComplete="new-password"
        required
        hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters. Give it to them in person — it is not shown again, and they must change it when they first sign in.`}
        error={state?.fieldErrors?.temporaryPassword?.[0]}
        disabled={pending}
      />

      <Button type="submit" size="lg" loading={pending} className="w-full sm:w-auto">
        {pending ? 'Creating account' : 'Create staff account'}
      </Button>
    </form>
  );
}
