import 'server-only';

import { redirect } from 'next/navigation';

import { ROUTES } from '@/config/app';
import { getAuthContext, type AuthContext } from '@/lib/auth/context';
import {
  landingPathFor,
  permissionForPath,
  signInRedirectPath,
} from '@/lib/auth/routing';
import { can, type Permission } from '@/lib/permissions';
import { checkActorRateLimit } from '@/lib/security/rate-limit';

/**
 * The authoritative route guard, run inside Server Components.
 *
 * ## Why this exists when the proxy already redirects
 *
 * The proxy knows only what the token says: that somebody signed in. It cannot
 * cheaply know whether that account was suspended two minutes ago, or which
 * capabilities it holds now. This runs with a database read behind it and
 * answers both.
 *
 * Running it in a layout means the redirect happens before any of the page's
 * markup is produced, so there is no flash of content the caller should not
 * see — the thing a client-side `useEffect` redirect cannot promise.
 *
 * ## It is still not the boundary
 *
 * A caller who skips the application entirely and queries Supabase directly
 * never reaches this code. Row Level Security is what stops them, and every
 * policy is written so that it would. This layer makes the application behave
 * correctly; the database makes it safe.
 */

/**
 * Require a usable session, and send the caller somewhere sensible if not.
 *
 * Redirects rather than throwing, because a page cannot usefully render an
 * authorization failure it has no session for.
 */
export async function guardPage(pathname: string): Promise<AuthContext> {
  const result = await getAuthContext();

  if (!result.ok) {
    // Every failure goes to the sign-in page, with a reason the page turns
    // into a sentence. The reason is safe to expose here because the caller
    // already proved they hold a session for the account in question — except
    // for `no_session`, which says nothing about anyone.
    const reason = result.reason === 'no_session' ? undefined : result.reason;
    redirect(signInRedirectPath(pathname, reason));
  }

  const context = result.context;

  // An administrator-issued temporary password is still in force, so somebody
  // other than the account holder knows it. Nothing else is reachable until it
  // is changed — not the dashboard, not the portal.
  if (context.mustChangePassword && pathname !== ROUTES.changePassword) {
    redirect(ROUTES.changePassword);
  }

  const required = permissionForPath(pathname);

  if (required !== null && !can(context.roles, required)) {
    // Send them to a page they can actually use rather than showing a dead
    // end. A Secretary/Treasurer who types /users lands back on the dashboard;
    // a client lands in the portal.
    const landing = landingPathFor(context);

    // Guard against a redirect loop if the landing page itself is refused —
    // which would mean a misconfigured matrix rather than a routine denial.
    if (landing === pathname) {
      redirect(signInRedirectPath(pathname, 'no_roles'));
    }

    redirect(landing);
  }

  return context;
}

/**
 * Require a specific capability on a page, independent of its path.
 *
 * For a surface whose requirement is narrower than its route's — a page that
 * anyone may open but whose action needs more.
 */
export async function guardPermission(
  pathname: string,
  permission: Permission,
): Promise<AuthContext> {
  const context = await guardPage(pathname);

  if (!can(context.roles, permission)) {
    redirect(landingPathFor(context));
  }

  return context;
}

/**
 * The guard a report page runs: capability, then budget.
 *
 * Report reads are the heaviest queries in the system and the ones a scraper
 * would walk. 120 a minute is a number no person reaches by clicking and a
 * script reaches immediately, so the limit costs honest use nothing.
 *
 * It fails **open** when the counter is unreachable — see `LIMITS` — because
 * a report is a read. Refusing to show a manager their arrears because a
 * counter table is unavailable would be an outage caused by a safety
 * mechanism, which is the wrong trade for an operation that changes nothing.
 */
export async function guardReportPage(
  pathname: string,
  permissions: readonly Permission[],
): Promise<AuthContext> {
  let context: AuthContext | undefined;

  for (const permission of permissions) {
    context = await guardPermission(pathname, permission);
  }

  if (context === undefined) {
    throw new Error('guardReportPage needs at least one capability to check.');
  }

  const limit = await checkActorRateLimit('reports.read', context.profileId);

  if (!limit.allowed) {
    // A read, so this is a message rather than a thrown error: the page is
    // still the right page, it simply has nothing new to show yet.
    throw new RateLimitedError(limit.message, limit.retryAfterSeconds);
  }

  return context;
}

/** Raised when a report read exceeds its budget. Carries the wait. */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
