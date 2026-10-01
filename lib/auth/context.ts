/**
 * The authenticated session, resolved server-side.
 *
 * ## One place that answers "who is this, and what may they do"
 *
 * Every protected page and every Server Action resolves its caller through
 * this module. Having one entry point means there is one place to audit, and
 * one place where the rules about disabled accounts and missing roles are
 * applied — rather than each screen re-deriving them slightly differently.
 *
 * ## Why it is resolved per request, from the database
 *
 * The JWT says who signed in. It does not say whether that account is still
 * active, what roles it holds now, or whether an administrator revoked
 * something a minute ago — a token issued an hour ago asserts an hour-old
 * truth. So the context is read from the database on every request.
 *
 * That read is itself subject to Row Level Security, which closes the loop:
 * `public.current_profile_id()` resolves only *active* profiles, so a
 * suspended user's own profile row is invisible to them and this function
 * reports them as unauthorised. Disabling an account takes effect on the next
 * request, not when the token expires.
 *
 * ## Layering
 *
 * This is the second of three layers. The proxy does a cheap token check and
 * redirects anonymous visitors; this does the authoritative per-request
 * authorization; Row Level Security is the boundary that holds even if both
 * are bypassed. Each is useful on its own and none is sufficient.
 */

import 'server-only';

import { cache } from 'react';

import { AuthenticationError, AuthorizationError, type AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  can,
  canAny,
  isRoleKey,
  permissionsFor,
  type Permission,
  type RoleKey,
} from '@/lib/permissions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { ProfileStatus } from '@/lib/domain/status';

/** The caller, once established. */
export interface AuthContext {
  readonly authUserId: string;
  readonly profileId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly status: ProfileStatus;
  readonly roles: readonly RoleKey[];
  readonly permissions: readonly Permission[];
  /** True while an administrator-issued temporary password is still in force. */
  readonly mustChangePassword: boolean;
}

/**
 * Why a request is not authorised.
 *
 * These are distinguished because the application responds differently to
 * each — a missing session goes to the login page, a disabled account gets an
 * explanation — but the *reason* is never shown to an anonymous visitor at the
 * login screen, where it would reveal whether an account exists.
 */
export type AuthFailureReason =
  /** No session at all. */
  | 'no_session'
  /**
   * A valid token, but no profile the caller can resolve. Either the account
   * was never linked to a profile, or its status is no longer active — the
   * two are indistinguishable here by design, because `current_profile_id()`
   * returns NULL for both.
   */
  | 'no_active_profile'
  /** A profile with no role assignment. An incomplete account, not a client. */
  | 'no_roles';

export type AuthResult =
  | { readonly ok: true; readonly context: AuthContext }
  | { readonly ok: false; readonly reason: AuthFailureReason };

/**
 * Resolve the caller, without throwing.
 *
 * Memoised per request with React's `cache`, so a layout and the page beneath
 * it share one database round trip rather than issuing the same query twice.
 * The cache is per-request and never shared between users.
 */
export const getAuthContext = cache(async (): Promise<AuthResult> => {
  const supabase = await createSupabaseServerClient();

  // `getClaims` verifies the token signature against the project's published
  // keys. `getSession` does not, and a cookie is attacker-controlled input, so
  // it must never be trusted on the server.
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError !== null || claimsData === null) {
    return { ok: false, reason: 'no_session' };
  }

  const authUserId = claimsData.claims.sub;

  if (typeof authUserId !== 'string' || authUserId === '') {
    return { ok: false, reason: 'no_session' };
  }

  // Read as the user. RLS returns their own row only when the account is
  // active, so a suspended account simply finds nothing — the status check and
  // the identity lookup are the same query.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, full_name, phone, email, status, must_change_password')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (profileError !== null) {
    logger.warn('Could not resolve the profile for an authenticated session.', {
      code: profileError.code,
    });
    return { ok: false, reason: 'no_active_profile' };
  }

  if (profile === null) {
    return { ok: false, reason: 'no_active_profile' };
  }

  const { data: assignments, error: rolesError } = await supabase
    .from('user_roles')
    .select('role_key')
    .eq('profile_id', profile.id);

  if (rolesError !== null) {
    logger.warn('Could not resolve role assignments for an authenticated session.', {
      code: rolesError.code,
    });
    return { ok: false, reason: 'no_roles' };
  }

  const roles = (assignments ?? [])
    .map((row) => row.role_key)
    .filter((key): key is RoleKey => isRoleKey(key));

  // An account with no role is incomplete, not a borrower. Defaulting it to
  // `client` would silently grant portal access to a half-created user.
  if (roles.length === 0) {
    return { ok: false, reason: 'no_roles' };
  }

  // Computed from the TypeScript matrix rather than read from the database.
  // A database test asserts the two representations are identical, so this
  // saves a round trip without creating a second source of truth.
  const permissions = permissionsFor(roles);

  return {
    ok: true,
    context: {
      authUserId,
      profileId: profile.id,
      fullName: profile.full_name,
      phone: profile.phone,
      email: profile.email,
      status: profile.status as ProfileStatus,
      roles,
      permissions,
      mustChangePassword: profile.must_change_password,
    },
  };
});

/**
 * The caller, or an error.
 *
 * @throws AuthenticationError when there is no usable session — the caller
 *   should sign in.
 * @throws AuthorizationError when there is a session but the account cannot be
 *   used: disabled, unlinked, or holding no role.
 */
export async function requireAuth(): Promise<AuthContext> {
  const result = await getAuthContext();

  if (result.ok) return result.context;

  throw authFailureToError(result.reason);
}

/**
 * The caller, having confirmed they hold `permission`.
 *
 * @throws AuthenticationError / AuthorizationError as `requireAuth`, or
 *   AuthorizationError when the capability is not held.
 */
export async function requirePermission(permission: Permission): Promise<AuthContext> {
  const context = await requireAuth();

  if (!can(context.roles, permission)) {
    // The capability is logged, the roles are not: knowing which permission
    // was refused is useful for debugging and harmless, whereas logging a
    // user's full role set on every denial is needless personal data.
    logger.info('Authorization denied.', { permission, profileId: context.profileId });
    throw new AuthorizationError(`Missing capability: ${permission}.`);
  }

  return context;
}

/** The caller, having confirmed they hold at least one of `permissions`. */
export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<AuthContext> {
  const context = await requireAuth();

  if (!canAny(context.roles, permissions)) {
    logger.info('Authorization denied.', {
      permissions: [...permissions],
      profileId: context.profileId,
    });
    throw new AuthorizationError(`Missing any of: ${permissions.join(', ')}.`);
  }

  return context;
}

/** Does the resolved caller hold this capability? For conditional rendering. */
export function contextCan(context: AuthContext, permission: Permission): boolean {
  return can(context.roles, permission);
}

/** Map a failure reason onto the application error taxonomy. */
export function authFailureToError(reason: AuthFailureReason): AppError {
  switch (reason) {
    case 'no_session':
      return new AuthenticationError('No authenticated session.');

    case 'no_active_profile':
      return new AuthorizationError('No active profile for this session.', {
        userMessage: 'Your account is not active. Please contact your administrator.',
      });

    case 'no_roles':
      return new AuthorizationError('Session holds no role assignment.', {
        userMessage:
          'Your account has not been given a role yet. Please contact your administrator.',
      });
  }
}
