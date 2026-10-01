'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  assignRoleAction,
  resetUserPasswordAction,
  revokeRoleAction,
  setUserStatusAction,
} from '@/lib/auth/admin-actions';
import { MIN_PASSWORD_LENGTH } from '@/lib/validation/auth';
import { ROLES, type RoleKey } from '@/lib/permissions';
import type { ActionResult } from '@/lib/auth/actions';
import type { DirectoryUser } from '@/lib/data/users';

export interface UserAdminPanelProps {
  readonly user: DirectoryUser;
  readonly assignableRoles: readonly RoleKey[];
  readonly canAssignRole: boolean;
  readonly canDisable: boolean;
  readonly canResetPassword: boolean;
  /** True when the viewer is looking at their own record. */
  readonly isSelf: boolean;
}

/**
 * Administrative controls for one account.
 *
 * Each control is a separate form posting to its own Server Action, so a
 * single action never accepts a free-form "what to do" argument. A generic
 * privileged endpoint taking a table and an operation is exactly the shape
 * that turns one authorization slip into total compromise.
 *
 * The controls shown reflect the viewer's capabilities. That is a courtesy —
 * every action re-checks its own capability server-side, and the database
 * re-checks it again.
 */
export function UserAdminPanel({
  user,
  assignableRoles,
  canAssignRole,
  canDisable,
  canResetPassword,
  isSelf,
}: UserAdminPanelProps) {
  const unassigned = assignableRoles.filter((role) => !user.roles.includes(role));

  return (
    <div className="space-y-4">
      {canAssignRole ? (
        <Card>
          <CardHeader title="Roles" description="What this person is allowed to do." />

          {isSelf ? (
            <Alert tone="info">
              You cannot change your own roles. Another administrator must do it — this is
              what stops an account quietly promoting itself.
            </Alert>
          ) : (
            <div className="space-y-4">
              <CurrentRoles user={user} />
              {unassigned.length > 0 ? (
                <GrantRoleForm profileId={user.id} roles={unassigned} />
              ) : (
                <p className="text-text-muted text-sm">
                  This person already holds every role you are able to grant.
                </p>
              )}
            </div>
          )}
        </Card>
      ) : null}

      {canDisable ? (
        <Card>
          <CardHeader
            title="Account access"
            description="Deactivating stops access immediately, including any session already open."
          />
          {isSelf ? (
            <Alert tone="info">You cannot change your own account status here.</Alert>
          ) : (
            <StatusForm user={user} />
          )}
        </Card>
      ) : null}

      {canResetPassword && user.hasLogin ? (
        <Card>
          <CardHeader
            title="Password"
            description="Issue a temporary password. They must change it when they next sign in."
          />
          <ResetPasswordForm profileId={user.id} />
        </Card>
      ) : null}
    </div>
  );
}

function CurrentRoles({ user }: { readonly user: DirectoryUser }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    revokeRoleAction,
    undefined,
  );

  return (
    <div className="space-y-2">
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {user.roles.length === 0 ? (
        <p className="text-text-muted text-sm">
          This account holds no role, so it cannot sign in.
        </p>
      ) : (
        <ul className="space-y-2">
          {user.roles.map((role) => (
            <li
              key={role}
              className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{ROLES[role].label}</p>
                <p className="text-text-muted text-xs">{ROLES[role].description}</p>
              </div>
              <form action={formAction} className="shrink-0">
                <input type="hidden" name="profileId" value={user.id} />
                <input type="hidden" name="roleKey" value={role} />
                <Button type="submit" variant="secondary" size="sm" loading={pending}>
                  Revoke
                </Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GrantRoleForm({
  profileId,
  roles,
}: {
  readonly profileId: string;
  readonly roles: readonly RoleKey[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    assignRoleAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-2">
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <input type="hidden" name="profileId" value={profileId} />

      <Label htmlFor="grant-role">Grant another role</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          id="grant-role"
          name="roleKey"
          required
          defaultValue=""
          disabled={pending}
          className="min-h-touch bg-surface text-text border-border-strong w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
        >
          <option value="" disabled>
            Choose a role
          </option>
          {roles.map((role) => (
            <option key={role} value={role}>
              {ROLES[role].label}
            </option>
          ))}
        </select>
        <Button type="submit" loading={pending} className="shrink-0">
          Grant
        </Button>
      </div>
    </form>
  );
}

function StatusForm({ user }: { readonly user: DirectoryUser }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    setUserStatusAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-3">
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <input type="hidden" name="profileId" value={user.id} />

      <div className="space-y-1.5">
        <Label htmlFor="status">Status</Label>
        <select
          id="status"
          name="status"
          defaultValue={user.status === 'archived' ? 'inactive' : user.status}
          disabled={pending}
          className="min-h-touch bg-surface text-text border-border-strong w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
        >
          <option value="active">Active — can sign in</option>
          <option value="inactive">Inactive — cannot sign in</option>
          <option value="suspended">Suspended — access blocked</option>
        </select>
      </div>

      <Button type="submit" loading={pending}>
        Update status
      </Button>
    </form>
  );
}

function ResetPasswordForm({ profileId }: { readonly profileId: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    resetUserPasswordAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <input type="hidden" name="profileId" value={profileId} />

      <PasswordInput
        label="Temporary password"
        name="temporaryPassword"
        autoComplete="new-password"
        required
        hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters. Hand it over in person; it is not shown again.`}
        error={state?.fieldErrors?.temporaryPassword?.[0]}
        disabled={pending}
      />

      <Button type="submit" variant="secondary" loading={pending}>
        Set temporary password
      </Button>
    </form>
  );
}
