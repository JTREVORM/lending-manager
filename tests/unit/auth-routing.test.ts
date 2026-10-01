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
