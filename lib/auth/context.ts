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
 * That read resolves identity through `public.current_profile_id()`, which
 * closes the loop: it resolves only *active* profiles, so a suspended
 * account has no identity for authorization purposes and this function
 * reports it as unauthorised. Disabling an account takes effect on the next
 * request, not when the token expires.
 *
 * ## One round trip, since Phase 18
 *
 * It used to be three, strictly serial: `auth.getClaims()`, then a `profiles`
 * select, then a `user_roles` select. With the database in `eu-west-1` and
 * the application in `iad1` that was about 240ms of transatlantic latency
 * ahead of every page and every client-side navigation.
 *
 * It is now one call to `public.current_session_context()`, which composes
 * the same two Phase 2 primitives — `current_profile_id()` and
 * `current_user_role_keys()` — and reports the failure reason itself rather
 * than leaving it to be inferred from which of three calls came back empty.
 * See migration 20261018000300 for why removing the `getClaims()` call
 * removes no verification: the proxy still performs one on every request
 * (it has to, because that is what refreshes the session), and PostgREST
 * performs another before `auth.uid()` has any value at all.
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

  // One round trip, not three.
  //
  // This used to be `auth.getClaims()` followed by a `profiles` select
  // followed by a `user_roles` select — strictly serial, because each needed
  // the one before. With the database in `eu-west-1` and the application in
  // `iad1` that was roughly 240ms of transatlantic latency before a page
  // began to render, on every request and every client-side navigation.
  //
  // `getClaims()` was the worst of the three and the least obvious: it is a
  // local signature check only for a project signing with an asymmetric key.
  // This project's tokens are HS256, and for a symmetric algorithm
  // `getClaims()` falls back to `getUser(token)` — an HTTP call to the Auth
  // service.
  //
  // The token is still verified before anything here is believed, twice over.
  // The proxy calls `getClaims()` on every request, because that call is what
  // refreshes an expiring session and writes the cookies a Server Component
  // cannot. And PostgREST checks the signature against the project's key, and
  // rejects an expired `exp`, before `auth.uid()` has any value at all — so a
  // row coming back from this function is itself proof that the token was
  // well-formed, correctly signed and unexpired. What was removed is the
  // third verification of the same token in the same request.
  //
  // `getSession()` is still never trusted here, and no request header is
  // either. See migration 20261018000300.
  const { data, error } = await supabase.rpc('current_session_context');

  if (error !== null) {
    // A rejected token (missing, malformed, expired) never reaches the
    // function: PostgREST answers 401 and it arrives here as an error. That
    // is indistinguishable from "not signed in", and is treated as such.
    logger.debug('Could not resolve the session context.', { code: error.code });
    return { ok: false, reason: 'no_session' };
  }

  // The function always returns exactly one row. Anything else means the
  // schema and this code have diverged, which is a fault rather than an
  // anonymous visitor.
  const row = Array.isArray(data) ? data[0] : data;

  if (row === undefined || row === null) {
    logger.warn('The session context returned no row.');
    return { ok: false, reason: 'no_session' };
  }

  switch (row.outcome) {
    case 'no_session':
      return { ok: false, reason: 'no_session' };

    case 'no_active_profile':
      return { ok: false, reason: 'no_active_profile' };

    case 'no_roles':
      return { ok: false, reason: 'no_roles' };

    case 'ok':
      break;

    default:
      logger.warn('The session context reported an unknown outcome.', {
        outcome: row.outcome,
      });
      return { ok: false, reason: 'no_session' };
  }

  // `outcome = 'ok'` is the database's assertion that the profile resolved
  // and carries at least one role, so these are present. They are still
  // checked rather than asserted, because a nullable column that cannot be
  // null is exactly the assumption that breaks quietly after a schema change.
  if (
    typeof row.auth_user_id !== 'string' ||
    typeof row.profile_id !== 'string' ||
    typeof row.full_name !== 'string' ||
    typeof row.phone !== 'string' ||
    typeof row.status !== 'string'
  ) {
    logger.warn('The session context reported ok with an incomplete profile.');
    return { ok: false, reason: 'no_active_profile' };
  }

  const roles = row.role_keys.filter((key): key is RoleKey => isRoleKey(key));

  // An account whose only roles are keys this build does not know is an
  // account with no usable role — the same case as none at all, and not a
  // borrower. The database already refused `no_roles` for an empty set; this
  // covers a role removed from the matrix but not yet from the assignment.
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
      authUserId: row.auth_user_id,
      profileId: row.profile_id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      status: row.status as ProfileStatus,
      roles,
      permissions,
      mustChangePassword: row.must_change_password === true,
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
