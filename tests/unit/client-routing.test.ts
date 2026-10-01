import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { permissionForPath, isPublicPath } from '@/lib/auth/routing';
import { can, type RoleKey } from '@/lib/permissions';

/**
 * Direct-URL protection for the Phase 3 routes.
 *
 * ## The regression this exists for
 *
 * When `/clients` was a Phase 2 placeholder its route requirement was
 * `dashboard:view`, which every staff role holds. Phase 3 gave the menu entry
 * its own `clients:view` requirement but the route map was not updated in the
 * same change — so for a while the menu entry and the route behind it
 * disagreed, and the screen stayed reachable by typing the URL.
 *
 * That is the classic shape of this bug: hiding a menu entry is not
 * protection. `tests/integration/navigation.test.tsx` caught it by asserting
 * the two maps agree; this file asserts the consequences directly, per role
 * and per route, so the next person to add a route sees what is expected.
 *
 * None of this is the boundary. Row Level Security is — a caller who gets past
 * every layer here still reads no rows. These three layers exist so that
 * somebody who should not be on a screen is told so rather than shown an empty
 * one.
 */

const PHASE_3_ROUTES = [
  { path: ROUTES.clients, permission: 'clients:view' },
  { path: `${ROUTES.clients}/new`, permission: 'clients:view' },
  {
    path: `${ROUTES.clients}/0f8fad5b-d9cb-469f-a165-70867728950e`,
    permission: 'clients:view',
  },
  {
    path: `${ROUTES.clients}/0f8fad5b-d9cb-469f-a165-70867728950e/edit`,
    permission: 'clients:view',
  },
  { path: ROUTES.guarantors, permission: 'guarantors:view' },
  { path: `${ROUTES.guarantors}/new`, permission: 'guarantors:view' },
  {
    path: `${ROUTES.guarantors}/0f8fad5b-d9cb-469f-a165-70867728950e`,
    permission: 'guarantors:view',
  },
] as const;

describe('Phase 3 route requirements', () => {
  it.each(PHASE_3_ROUTES)('$path requires $permission', ({ path, permission }) => {
    expect(permissionForPath(path)).toBe(permission);
  });

  it('no longer lets dashboard:view alone open the client directory', () => {
    // The regression. `dashboard:view` is held by every staff role, so this
    // mapping would have made the directory reachable by any of them.
    expect(permissionForPath(ROUTES.clients)).not.toBe('dashboard:view');
  });

  it('keeps every Phase 3 route behind the sign-in wall', () => {
    for (const { path } of PHASE_3_ROUTES) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it('matches the most specific prefix, so a nested route is not under-guarded', () => {
    // `/guarantors/...` must not fall through to the dashboard's catch-all
    // simply because it is longer than the prefix that was registered.
    expect(permissionForPath('/guarantors/abc/edit')).toBe('guarantors:view');
    expect(permissionForPath('/clients/abc/edit')).toBe('clients:view');
  });

  it('does not let a similarly named path inherit the requirement', () => {
    // `/clientsomething` is not under `/clients`. It falls back to the
    // dashboard requirement rather than silently being treated as a client
    // route — and since no such route exists, the guard refuses it anyway.
    expect(permissionForPath('/clientsomething')).toBe('dashboard:view');
  });
});

describe('what each role can reach by typing a URL', () => {
  const reaches = (role: RoleKey, path: string): boolean => {
    const permission = permissionForPath(path);
    if (permission === null) return true;
    // `can` takes role keys and resolves their grants itself.
    return can([role], permission);
  };

  it('lets staff with clients:view reach the client directory', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(reaches(role, ROUTES.clients), role).toBe(true);
    }
  });

  it('keeps a borrower out of the client directory', () => {
    // A borrower reads their own record through the portal, resolved by the
    // identity clause in the policy. The directory is not theirs at any URL.
    expect(reaches('client', ROUTES.clients)).toBe(false);
    expect(reaches('client', `${ROUTES.clients}/new`)).toBe(false);
    expect(
      reaches('client', `${ROUTES.clients}/0f8fad5b-d9cb-469f-a165-70867728950e`),
    ).toBe(false);
  });

  it('keeps a borrower out of the guarantor directory', () => {
    expect(reaches('client', ROUTES.guarantors)).toBe(false);
    expect(
      reaches('client', `${ROUTES.guarantors}/0f8fad5b-d9cb-469f-a165-70867728950e`),
    ).toBe(false);
  });

  it('lets a borrower reach the portal and their own account, and nothing else', () => {
    expect(reaches('client', ROUTES.portal)).toBe(true);
    expect(reaches('client', ROUTES.account)).toBe(true);

    for (const path of [
      ROUTES.dashboard,
      ROUTES.clients,
      ROUTES.guarantors,
      ROUTES.users,
      ROUTES.audit,
      ROUTES.settings,
      ROUTES.loans,
      ROUTES.payments,
    ]) {
      expect(reaches('client', path), path).toBe(false);
    }
  });

  it('keeps the portal out of reach of staff', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(reaches(role, ROUTES.portal), role).toBe(false);
    }
  });

  it('lets every staff role reach the guarantor directory', () => {
    // Read access is operational; creating and attaching are separate
    // capabilities the Secretary/Treasurer does not hold.
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      expect(reaches(role, ROUTES.guarantors), role).toBe(true);
    }
  });
});

describe('capabilities the route guard deliberately does not check', () => {
  /**
   * The guard is a coarse gate: it decides whether a screen opens at all. The
   * finer rules — who may blacklist, who may read a National Identification
   * Number, who may write a remark — are enforced per operation and per row,
   * because a single route serves callers with different rights to different
   * parts of the same page.
   */
  it('opens the client page for a Secretary/Treasurer who may not see a NIN', () => {
    expect(can(['secretary_treasurer'], 'clients:view')).toBe(true);
    expect(can(['secretary_treasurer'], 'clients:view_nin')).toBe(false);
  });

  it('opens it for a Manager who may not blacklist', () => {
    expect(can(['manager'], 'clients:view')).toBe(true);
    expect(can(['manager'], 'clients:blacklist')).toBe(false);
  });

  it('opens it for a Secretary/Treasurer who may read remarks but not write them', () => {
    expect(can(['secretary_treasurer'], 'clients:remarks_view')).toBe(true);
    expect(can(['secretary_treasurer'], 'clients:remarks_create')).toBe(false);
  });
});
