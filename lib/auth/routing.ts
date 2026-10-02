/**
 * Which capability each route requires, and where each role lands.
 *
 * ## Why this is a pure module
 *
 * It is imported by the proxy (which runs before any database call), by server
 * layouts (which enforce it), and by the navigation component in the browser
 * (which uses it to decide what to show). A single declarative table keeps
 * those three in agreement — the common failure is a menu that hides a link
 * while the route behind it stays reachable, and that cannot happen when both
 * read the same map.
 *
 * Nothing here is a security control on its own. It is the map that the
 * server-side guard enforces and that Row Level Security backstops.
 */

import { ROUTES } from '@/config/app';
import type { Permission } from '@/lib/permissions';

/**
 * Routes reachable without a session.
 *
 * Everything not listed requires authentication. Fail-closed: a route added
 * without being considered is protected by default, which is the safe
 * direction for the mistake to go.
 */
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = [ROUTES.login];

/**
 * The capability each protected route requires.
 *
 * Longest prefix wins, so `/account/password` can differ from `/account`.
 */
const ROUTE_PERMISSIONS: readonly {
  readonly prefix: string;
  readonly permission: Permission;
}[] = [
  { prefix: ROUTES.users, permission: 'users:view' },
  { prefix: ROUTES.audit, permission: 'audit:view' },
  { prefix: ROUTES.settings, permission: 'settings:view' },
  { prefix: ROUTES.clients, permission: 'clients:view' },
  { prefix: ROUTES.guarantors, permission: 'guarantors:view' },
  { prefix: ROUTES.loans, permission: 'loans:view' },
  // Its own capability as of Phase 6, rather than `dashboard:view`. The same
  // latent defect Phase 3 found on `/clients`: a placeholder route left
  // guarded by the broad capability stays open after the real screen lands,
  // and the menu hiding the entry is not protection.
  { prefix: ROUTES.payments, permission: 'payments:view' },
  { prefix: ROUTES.portal, permission: 'portal:view' },
  { prefix: ROUTES.account, permission: 'account:view' },
  // The dashboard is last: '/' prefixes everything, so it must only match
  // once no more specific route has.
  { prefix: ROUTES.dashboard, permission: 'dashboard:view' },
];

/** Is this path reachable without signing in? */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * The capability a path requires, or `null` if it is public.
 *
 * An unrecognised path returns `dashboard:view` rather than `null`: an
 * unknown route under an authenticated area should require *something*, and
 * a 404 shown to a signed-in user is better than a page shown to one who
 * should not see it.
 */
export function permissionForPath(pathname: string): Permission | null {
  if (isPublicPath(pathname)) return null;

  const match = ROUTE_PERMISSIONS.filter(
    ({ prefix }) =>
      pathname === prefix ||
      (prefix === ROUTES.dashboard ? false : pathname.startsWith(`${prefix}/`)),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0];

  return match?.permission ?? 'dashboard:view';
}

/** What a caller needs in order to be routed somewhere sensible. */
export interface LandingSubject {
  readonly permissions: readonly Permission[];
  readonly mustChangePassword: boolean;
}

/**
 * Where to send a user once they are signed in.
 *
 * A forced password change outranks everything: an account still holding an
 * administrator-issued temporary password goes to the change-password screen
 * and nowhere else, because until it is changed, somebody other than the
 * account holder knows the password.
 *
 * Otherwise, staff land on the dashboard and borrowers on the portal. A user
 * with neither capability — which should not happen, since an account with no
 * role is refused at sign-in — lands on their own account page, which is the
 * one thing every signed-in user may see.
 */
export function landingPathFor(subject: LandingSubject): string {
  if (subject.mustChangePassword) return ROUTES.changePassword;
  if (subject.permissions.includes('dashboard:view')) return ROUTES.dashboard;
  if (subject.permissions.includes('portal:view')) return ROUTES.portal;
  return ROUTES.account;
}

/**
 * Build the sign-in URL.
 *
 * `next` carries only a path from this site. Accepting a full URL would make
 * the sign-in page an open redirect — a way to make a phishing destination
 * look as though the lender sent you there, which is exactly what makes such a
 * link persuasive.
 */
export function signInRedirectPath(pathname?: string, reason?: string): string {
  const params = new URLSearchParams();

  const next = safeNextPath(pathname);
  if (next !== null && next !== ROUTES.dashboard && next !== ROUTES.login) {
    params.set('next', next);
  }

  if (reason !== undefined) params.set('reason', reason);

  const query = params.toString();
  return query === '' ? ROUTES.login : `${ROUTES.login}?${query}`;
}

/**
 * Sanitise a `next` parameter before redirecting to it.
 *
 * Returns `null` for anything that is not a plain in-site path, including
 * protocol-relative `//evil.example`, absolute URLs, and backslashes — which
 * some browsers normalise to forward slashes, turning `/\evil.example` into a
 * protocol-relative URL.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  if (value.length > 512) return null;
  return value;
}
