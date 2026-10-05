import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { isPublicPath, isSignedOutOnlyPath } from '@/lib/auth/routing';

/**
 * Which paths are reachable without a session, and which are for signed-out
 * visitors only.
 *
 * The two were one set until Phase 9, because `/login` was the only public
 * path. Adding `/api/health` separated them, and the separation is the point:
 * a public path must answer whoever asks, including somebody who is signed in.
 */

describe('paths reachable without a session', () => {
  it('includes the sign-in page, the offline page and the health endpoint', () => {
    for (const path of [ROUTES.login, ROUTES.offline, ROUTES.health]) {
      expect(isPublicPath(path), path).toBe(true);
    }
  });

  it('includes nothing that shows anybody money', () => {
    for (const path of [
      ROUTES.dashboard,
      ROUTES.clients,
      ROUTES.loans,
      ROUTES.payments,
      ROUTES.overdue,
      ROUTES.reports,
      ROUTES.users,
      ROUTES.audit,
      ROUTES.settings,
      ROUTES.portal,
      ROUTES.account,
      '/clients/00000000-0000-0000-0000-000000000000',
      '/reports/collections/export',
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });
});

describe('paths for signed-out visitors only', () => {
  it('is the sign-in page, and nothing else', () => {
    expect(isSignedOutOnlyPath(ROUTES.login)).toBe(true);

    // The defect this guards against: the proxy redirected a signed-in caller
    // away from every *public* path, so `/api/health` answered a monitor with
    // a 307 to the dashboard and a page of HTML where it expected JSON.
    expect(isSignedOutOnlyPath(ROUTES.health)).toBe(false);
    expect(isSignedOutOnlyPath(ROUTES.offline)).toBe(false);
  });

  it('does not sweep in a path that merely starts with the same letters', () => {
    expect(isSignedOutOnlyPath('/loginsomething')).toBe(false);
    expect(isSignedOutOnlyPath('/login/callback')).toBe(true);
  });
});
