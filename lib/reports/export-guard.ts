import 'server-only';

import { getAuthContext, type AuthContext } from '@/lib/auth/context';
import { can, type Permission } from '@/lib/permissions';

/**
 * The capability check an export route performs for itself.
 *
 * ## Why a route handler cannot borrow the page's check
 *
 * A download is a separate request to a separate URL. The page that rendered
 * the link is not involved, the link can be typed, copied, or kept after a
 * role changes — so the route repeats the page's check rather than trusting
 * that somebody arrived from the right place. Hiding the link is presentation;
 * this is the control.
 *
 * ## Why it returns a status rather than redirecting
 *
 * A redirect to the dashboard would hand the browser an HTML page in answer to
 * a request for a CSV, which a download manager cannot interpret and which
 * would arrive as a file called `collections.csv` full of markup. A plain 403
 * with a sentence is the honest answer.
 *
 * ## Row Level Security still decides the rows
 *
 * Passing this check means the caller may open the report, not that they may
 * read any particular row. Every query behind it runs as the caller, so the
 * file contains exactly the rows the policies admit — which is why the same
 * export route is safe for a Secretary/Treasurer and an Owner.
 */
export async function guardExport(
  permissions: readonly Permission[],
): Promise<{ ok: true; context: AuthContext } | { ok: false; response: Response }> {
  const result = await getAuthContext();

  if (!result.ok) {
    return {
      ok: false,
      response: new Response('Sign in to download this report.', {
        status: 401,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      }),
    };
  }

  // An account still holding an administrator-issued temporary password reaches
  // nothing, exports included. Somebody other than the account holder knows
  // that password, so a download is as much of a leak as a page would be.
  if (result.context.mustChangePassword) {
    return {
      ok: false,
      response: new Response('Change your password before downloading reports.', {
        status: 403,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      }),
    };
  }

  const missing = permissions.filter(
    (permission) => !can(result.context.roles, permission),
  );

  if (missing.length > 0) {
    // The capability is not named back to the caller. A refusal that lists what
    // you would need is a map of the authorization model, and the person who
    // needs it should be asking the Owner, not reading an error.
    return {
      ok: false,
      response: new Response('You do not have access to this report.', {
        status: 403,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      }),
    };
  }

  return { ok: true, context: result.context };
}
