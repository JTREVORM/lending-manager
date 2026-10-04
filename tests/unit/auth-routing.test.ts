import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { isPublicPath, landingPathFor, permissionForPath } from '@/lib/auth/routing';
import { ROLE_PERMISSIONS, type Permission } from '@/lib/permissions';

describe('public routes', () => {
  it('treats only the sign-in page as reachable without a session', () => {
    expect(isPublicPath(ROUTES.login)).toBe(true);

    for (const route of [
      ROUTES.dashboard,
      ROUTES.users,
      ROUTES.audit,
      ROUTES.settings,
      ROUTES.account,
      ROUTES.portal,
      ROUTES.clients,
    ]) {
      expect(isPublicPath(route), route).toBe(false);
    }
  });

  it('fails closed for an unrecognised path', () => {
    // A route added without being considered must be protected, not open.
    expect(isPublicPath('/something-new')).toBe(false);
    expect(permissionForPath('/something-new')).toBe('dashboard:view');
  });
});

describe('permissionForPath', () => {
  it('maps each protected route to its capability', () => {
    expect(permissionForPath(ROUTES.users)).toBe('users:view');
    expect(permissionForPath(ROUTES.audit)).toBe('audit:view');
    expect(permissionForPath(ROUTES.settings)).toBe('settings:view');
    expect(permissionForPath(ROUTES.portal)).toBe('portal:view');
    expect(permissionForPath(ROUTES.account)).toBe('account:view');
    expect(permissionForPath(ROUTES.dashboard)).toBe('dashboard:view');
  });

  it('applies a section capability to its detail pages', () => {
    expect(permissionForPath(`${ROUTES.users}/0f8fad5b`)).toBe('users:view');
    expect(permissionForPath(`${ROUTES.users}/new`)).toBe('users:view');
  });

  it('prefers the more specific prefix', () => {
    // `/account/password` must resolve through `/account`, not through `/`.
    expect(permissionForPath(ROUTES.changePassword)).toBe('account:view');
  });

  it('does not let the dashboard prefix swallow every route', () => {
    // `/` prefixes everything, so a naive prefix match would make the whole
    // application require only `dashboard:view` — which a client does not hold
    // but which would wrongly gate `/portal`.
    expect(permissionForPath(ROUTES.portal)).not.toBe('dashboard:view');
    expect(permissionForPath(ROUTES.users)).not.toBe('dashboard:view');
  });

  /**
   * The defect this project has now been told about three times.
   *
   * Phase 3 shipped `/clients` behind `dashboard:view`; Phase 6 found the same
   * thing on `/payments`; §98 asks explicitly that a dashboard capability must
   * not open a report. So every protected route is asserted to require
   * something *other* than the dashboard's capability, with the dashboard
   * itself as the single exception.
   */
  it('lets no route but the dashboard be opened with dashboard:view alone', () => {
    for (const [name, path] of Object.entries(ROUTES)) {
      if (path === ROUTES.dashboard || path === ROUTES.login) continue;
      expect(permissionForPath(path), name).not.toBe('dashboard:view');
    }
  });

  it('guards the reporting surface with its own capability', () => {
    expect(permissionForPath(ROUTES.reports)).toBe('reports:view_operational');

    // Every page inside the section inherits the prefix. The two narrower
    // reporting capabilities differ *within* it — the loan register needs
    // `reports:view_financial` while the collection report does not — which a
    // prefix map cannot express, so those are checked by the pages themselves
    // and by their export routes.
    for (const page of [
      'collections',
      'loans',
      'arrears',
      'grace',
      'penalties',
      'clients',
    ]) {
      expect(permissionForPath(`${ROUTES.reports}/${page}`), page).toBe(
        'reports:view_operational',
      );
    }
  });

  it('guards an export route as tightly as the page it came from', () => {
    // A download is a separate request to a separate URL that can be typed,
    // kept, or shared. It resolves through the same prefix, and the handler
    // repeats the check.
    expect(permissionForPath(`${ROUTES.reports}/collections/export`)).toBe(
      'reports:view_operational',
    );
    expect(permissionForPath(`${ROUTES.reports}/loans/export`)).toBe(
      'reports:view_operational',
    );
  });

  it('guards a statement with the capability of the record it states', () => {
    expect(permissionForPath(`${ROUTES.loans}/abc/statement`)).toBe('loans:view');
    expect(permissionForPath(`${ROUTES.portal}/loans/abc`)).toBe('portal:view');
  });

  it('returns null only for a public path', () => {
    expect(permissionForPath(ROUTES.login)).toBeNull();
  });
});

describe('landingPathFor', () => {
  const subject = (permissions: readonly Permission[], mustChangePassword = false) => ({
    permissions,
    mustChangePassword,
  });

  it('sends staff to the dashboard', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(landingPathFor(subject(ROLE_PERMISSIONS[role])), role).toBe(
        ROUTES.dashboard,
      );
    }
  });

  it('sends a borrower to the portal', () => {
    expect(landingPathFor(subject(ROLE_PERMISSIONS.client))).toBe(ROUTES.portal);
  });

  it('sends anyone with a temporary password to change it first', () => {
    // Until it is changed, somebody other than the account holder knows the
    // password. That outranks every other destination.
    for (const role of ['client', 'secretary_treasurer', 'owner_admin'] as const) {
      expect(landingPathFor(subject(ROLE_PERMISSIONS[role], true)), role).toBe(
        ROUTES.changePassword,
      );
    }
  });

  it('falls back to the account page when a user holds neither shell', () => {
    expect(landingPathFor(subject(['account:view']))).toBe(ROUTES.account);
    expect(landingPathFor(subject([]))).toBe(ROUTES.account);
  });
});
