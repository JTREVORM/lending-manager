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
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = [
  ROUTES.login,
  // Phase 9. The installable-application surface, which is reached before
  // there is a session and must stay reachable when there is no network.
  //
  // None of it carries anything private: the manifest holds the software's
  // own name and icons, and the offline page deliberately shows no figures at
  // all. Redirecting them to sign-in would mean the service worker precaches
  // a sign-in page as its offline fallback, and an offline borrower would be
  // told to log in rather than told the figures are unavailable.
  ROUTES.offline,
  // Phase 9. The health endpoint, which a monitor reaches with no session.
  //
  // Reachable, and deliberately uninformative: it reports whether the process
  // is up, whether the database answers, and which build is running. Not the
  // database's host, not the schema version, not a row count, not a reason for
  // a failure. A health check is the easiest thing on a deployment to probe,
  // so what it says is said to everybody.
  ROUTES.health,
];

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
  // Phase 12. Longest prefix wins, so the product routes are listed before
  // `/settings` itself. `products:view` is deliberately *not* the same
  // capability: a Secretary/Treasurer may read the products — they have to,
  // to answer "what rate is a Salary Loan" — but holds no `settings:view`
  // and must not reach the company record or the finance thresholds.
  { prefix: ROUTES.loanProducts, permission: 'products:view' },
  { prefix: ROUTES.settings, permission: 'settings:view' },
  { prefix: ROUTES.clients, permission: 'clients:view' },
  { prefix: ROUTES.guarantors, permission: 'guarantors:view' },
  { prefix: ROUTES.loans, permission: 'loans:view' },
  // Its own capability as of Phase 6, rather than `dashboard:view`. The same
  // latent defect Phase 3 found on `/clients`: a placeholder route left
  // guarded by the broad capability stays open after the real screen lands,
  // and the menu hiding the entry is not protection.
  { prefix: ROUTES.payments, permission: 'payments:view' },
  // Phase 7. Its own capability, not the dashboard's — the mistake Phase 3
  // made with `/clients` and Phase 6 found again on `/payments`.
  { prefix: ROUTES.overdue, permission: 'delinquency:view' },
  // Phase 8. `reports:view_operational` is the floor for the reporting
  // surface, not `dashboard:view`: §98 is explicit that a dashboard
  // capability must not open a report, which is the third time this project
  // has been told about the same defect. The two narrower reporting
  // capabilities are checked by the individual pages, because they differ
  // *within* this prefix — the loan register needs
  // `reports:view_financial` while the collection report does not — and a
  // prefix map cannot express that. The pages call `guardPermission`, and
  // their export routes check again.
  { prefix: ROUTES.reports, permission: 'reports:view_operational' },
  // Phase 11. Longest prefix wins, so the four document routes are listed
  // before `/finance` itself: a Secretary/Treasurer holds `transfers:view`
  // and `ledger:view` alike, but a Manager who one day holds only one of
  // them must reach only the one. `/finance` itself needs `ledger:view`,
  // because the overview's whole content is the cash position.
  { prefix: ROUTES.transfers, permission: 'transfers:view' },
  { prefix: ROUTES.expenses, permission: 'expenses:view' },
  { prefix: ROUTES.otherIncome, permission: 'income:view' },
  { prefix: ROUTES.reconciliation, permission: 'reconciliation:view' },
  { prefix: ROUTES.ledger, permission: 'ledger:view' },
  { prefix: ROUTES.finance, permission: 'ledger:view' },
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
 * Paths that make no sense to somebody who is already signed in.
 *
 * Just the sign-in page. "Public" and "for signed-out visitors only" used to
 * be the same set, because `/login` was the only public path — so the proxy
 * redirected a signed-in caller away from *any* public path. Adding
 * `/api/health` made that wrong in a way worth recording: a signed-in browser,
 * or a monitor that happened to hold a session cookie, asked for the health
 * endpoint and got a 307 to the dashboard and a page of HTML where it expected
 * JSON.
 *
 * The offline page is in the same position. It is served by the service worker
 * rather than navigated to, so the redirect never fired in practice — but a
 * signed-in person with no network has more use for "the figures are
 * unavailable" than for a dashboard that cannot load.
 */
export function isSignedOutOnlyPath(pathname: string): boolean {
  return pathname === ROUTES.login || pathname.startsWith(`${ROUTES.login}/`);
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
