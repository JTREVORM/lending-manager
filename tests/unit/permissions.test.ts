import { describe, expect, it } from 'vitest';

import { REPAYMENT_FREQUENCY_DEFAULTS } from '@/config/defaults';
import {
  PROFILE_STATUSES,
  canTransact,
  isArchived,
  isProfileStatus,
  PROFILE_STATUS_LABELS,
} from '@/lib/domain/status';
import {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  ROLES,
  STAFF_ROLE_KEYS,
  can,
  canAll,
  canAny,
  effectiveRole,
  hasAtLeastRole,
  isPermission,
  isRoleKey,
  isStaff,
  permissionsFor,
  type RoleKey,
} from '@/lib/permissions';

describe('role vocabulary', () => {
  it('contains exactly the four business roles', () => {
    expect([...ROLE_KEYS]).toEqual([
      'client',
      'secretary_treasurer',
      'manager',
      'owner_admin',
    ]);
  });

  it('defines every role with a unique, ascending rank', () => {
    const ranks = ROLE_KEYS.map((key) => ROLE_RANK[key]);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('leaves gaps between ranks so a role can be inserted later', () => {
    // Adding a role between manager and owner_admin must not require
    // renumbering the existing ones.
    for (let index = 1; index < ROLE_KEYS.length; index += 1) {
      const previous = ROLE_RANK[ROLE_KEYS[index - 1]!];
      const current = ROLE_RANK[ROLE_KEYS[index]!];
      expect(current - previous).toBeGreaterThan(1);
    }
  });

  it('marks only the employee roles as staff', () => {
    expect([...STAFF_ROLE_KEYS]).toEqual([
      'secretary_treasurer',
      'manager',
      'owner_admin',
    ]);
    expect(ROLES.client.isStaff).toBe(false);
  });

  it('gives every role a non-empty label and description', () => {
    for (const key of ROLE_KEYS) {
      expect(ROLES[key].label.trim().length).toBeGreaterThan(0);
      expect(ROLES[key].description.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses keys that satisfy the database CHECK constraint', () => {
    // Mirrors roles_key_format in migration 20261001000300.
    for (const key of ROLE_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(key.length).toBeGreaterThanOrEqual(2);
      expect(key.length).toBeLessThanOrEqual(50);
    }
  });

  it('discriminates role keys', () => {
    expect(isRoleKey('manager')).toBe(true);
    expect(isRoleKey('superuser')).toBe(false);
    expect(isRoleKey(null)).toBe(false);
  });
});

describe('effectiveRole', () => {
  it('picks the highest-ranked role held', () => {
    expect(effectiveRole(['client', 'manager'])).toBe('manager');
    expect(effectiveRole(['owner_admin', 'secretary_treasurer'])).toBe('owner_admin');
    expect(effectiveRole(['manager'])).toBe('manager');
  });

  it('returns null for no roles rather than defaulting to client', () => {
    // An account with no role assignment is incomplete, not a borrower.
    // Defaulting would silently grant portal access to a half-created user.
    expect(effectiveRole([])).toBeNull();
  });
});

describe('hasAtLeastRole', () => {
  it('treats a higher rank as satisfying a lower requirement', () => {
    expect(hasAtLeastRole(['owner_admin'], 'manager')).toBe(true);
    expect(hasAtLeastRole(['manager'], 'manager')).toBe(true);
    expect(hasAtLeastRole(['manager'], 'owner_admin')).toBe(false);
    expect(hasAtLeastRole(['secretary_treasurer'], 'manager')).toBe(false);
  });

  it('fails closed with no roles', () => {
    expect(hasAtLeastRole([], 'client')).toBe(false);
  });
});

describe('isStaff', () => {
  it('identifies employees', () => {
    expect(isStaff(['secretary_treasurer'])).toBe(true);
    expect(isStaff(['client'])).toBe(false);
    expect(isStaff([])).toBe(false);
  });
});

describe('permission matrix', () => {
  it('declares grants for every role, so none is silently undefined', () => {
    for (const key of ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[key]).toBeDefined();
      expect(Array.isArray(ROLE_PERMISSIONS[key])).toBe(true);
    }
  });

  it('grants only permissions that exist', () => {
    for (const key of ROLE_KEYS) {
      for (const permission of ROLE_PERMISSIONS[key]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it('gives the owner_admin everything Phase 1 defines', () => {
    expect([...ROLE_PERMISSIONS.owner_admin].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('restricts settings writes and the audit trail to the owner_admin', () => {
    expect(can(['owner_admin'], 'settings:write')).toBe(true);
    expect(can(['manager'], 'settings:write')).toBe(false);
    expect(can(['secretary_treasurer'], 'settings:write')).toBe(false);

    expect(can(['owner_admin'], 'audit:read')).toBe(true);
    expect(can(['manager'], 'audit:read')).toBe(false);
  });

  it('gives a client no staff permissions', () => {
    // A borrower reaches the client portal, not the staff shell.
    expect(ROLE_PERMISSIONS.client).toHaveLength(0);
    expect(can(['client'], 'dashboard:view')).toBe(false);
  });

  it('fails closed for no roles and for an unknown role', () => {
    expect(can([], 'dashboard:view')).toBe(false);
    expect(can(['not_a_role' as RoleKey], 'dashboard:view')).toBe(false);
  });

  it('unions permissions across multiple roles', () => {
    const granted = permissionsFor(['secretary_treasurer', 'owner_admin']);
    expect(granted).toContain('settings:write');
    expect(granted).toContain('dashboard:view');
    // Deduplicated: both roles grant dashboard:view.
    expect(new Set(granted).size).toBe(granted.length);
  });

  it('evaluates canAll and canAny', () => {
    expect(canAll(['owner_admin'], ['settings:read', 'settings:write'])).toBe(true);
    expect(canAll(['manager'], ['settings:read', 'settings:write'])).toBe(false);
    expect(canAny(['manager'], ['settings:read', 'settings:write'])).toBe(true);
    expect(canAny(['client'], ['settings:read', 'settings:write'])).toBe(false);
  });

  it('discriminates permission names', () => {
    expect(isPermission('settings:read')).toBe(true);
    expect(isPermission('loans:approve')).toBe(false);
  });

  it('names every permission as resource:action', () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    }
  });
});

describe('profile statuses', () => {
  it('defines the lifecycle', () => {
    expect([...PROFILE_STATUSES]).toEqual([
      'active',
      'inactive',
      'suspended',
      'archived',
    ]);
  });

  it('permits transacting only when active', () => {
    expect(canTransact('active')).toBe(true);
    expect(canTransact('inactive')).toBe(false);
    expect(canTransact('suspended')).toBe(false);
    expect(canTransact('archived')).toBe(false);
  });

  it("identifies the archived state, this system's substitute for deletion", () => {
    expect(isArchived('archived')).toBe(true);
    expect(isArchived('inactive')).toBe(false);
  });

  it('labels every status', () => {
    for (const status of PROFILE_STATUSES) {
      expect(PROFILE_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it('discriminates statuses', () => {
    expect(isProfileStatus('active')).toBe(true);
    expect(isProfileStatus('deleted')).toBe(false);
  });
});

describe('repayment frequency defaults', () => {
  it('covers the three cadences the business supports', () => {
    expect(REPAYMENT_FREQUENCY_DEFAULTS.map((entry) => entry.key)).toEqual([
      'daily',
      'every_2_days',
      'every_3_days',
    ]);
    expect(REPAYMENT_FREQUENCY_DEFAULTS.map((entry) => entry.intervalDays)).toEqual([
      1, 2, 3,
    ]);
  });
});
