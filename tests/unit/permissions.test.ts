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
  rolePermissionPairs,
  type Permission,
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

  it('names every permission as resource:action', () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    }
  });

  it('lists no permission twice', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('grants no role the same permission twice', () => {
    for (const key of ROLE_KEYS) {
      const granted = ROLE_PERMISSIONS[key];
      expect(new Set(granted).size, key).toBe(granted.length);
    }
  });

  it('discriminates permission names', () => {
    expect(isPermission('settings:view')).toBe(true);
    expect(isPermission('loans:approve')).toBe(true);
    expect(isPermission('settings:write')).toBe(false);
    // A capability a later phase will add. Using a genuinely non-existent one
    // keeps this assertion meaningful; `loans:approve` used to serve here and
    // stopped being a negative case the moment Phase 4 declared it.
    expect(isPermission('payments:post')).toBe(false);
  });
});

/**
 * The authorization matrix.
 *
 * This is the table the business agreed, asserted cell by cell. It is written
 * exhaustively rather than as a handful of spot checks because a permission
 * silently appearing in the wrong row is the kind of mistake that reads as
 * correct and is caught only by stating the whole grid.
 *
 * `tests/db/rls-identity.test.ts` asserts the same matrix at the database
 * level, where it is actually enforced.
 */
describe('authorization matrix', () => {
  const MATRIX: Readonly<Record<Permission, readonly RoleKey[]>> = {
    'dashboard:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'account:view': ['client', 'secretary_treasurer', 'manager', 'owner_admin'],
    'account:update': ['client', 'secretary_treasurer', 'manager', 'owner_admin'],
    'portal:view': ['client'],
    'users:view': ['manager', 'owner_admin'],
    'users:create': ['owner_admin'],
    'users:update': ['owner_admin'],
    'users:disable': ['owner_admin'],
    'users:assign_role': ['owner_admin'],
    'users:reset_password': ['owner_admin'],
    'settings:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'settings:update': ['owner_admin'],
    'audit:view': ['owner_admin'],

    // --- Phase 10: branch network and the financial ledger ------------------
    // Everyone who works here may see where the money is; a treasurer most of
    // all, since they are the one holding it. Opening a branch and
    // hand-posting a journal are the Owner's, for the same reason disbursing
    // and reversing are: they are the two acts that can move money without an
    // operational event behind them.
    'branches:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'branches:create': ['owner_admin'],
    'branches:update': ['manager', 'owner_admin'],
    'ledger:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'ledger:post': ['owner_admin'],

    // --- Phase 11: money movement -------------------------------------------
    // Recording and approving are split in every row. The treasurer moves
    // the money and counts it; the Manager is the second pair of eyes; the
    // thresholds and the chart of accounts are the Owner's, because a
    // Manager who could raise the threshold could approve their own work by
    // making approval unnecessary.
    'transfers:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'transfers:create': ['secretary_treasurer', 'manager', 'owner_admin'],
    'transfers:approve': ['manager', 'owner_admin'],
    'expenses:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'expenses:create': ['secretary_treasurer', 'manager', 'owner_admin'],
    'expenses:approve': ['manager', 'owner_admin'],
    'income:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'income:create': ['secretary_treasurer', 'manager', 'owner_admin'],
    'reconciliation:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'reconciliation:perform': ['secretary_treasurer', 'manager', 'owner_admin'],
    'reconciliation:approve': ['manager', 'owner_admin'],
    'finance:settings': ['owner_admin'],
    'finance:accounts': ['owner_admin'],

    // --- Phase 12: loan products --------------------------------------------
    // Everybody who sells a loan needs to know what the business offers;
    // only the Owner sets the price.
    'products:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'products:manage': ['owner_admin'],

    // --- Phase 3: clients ---------------------------------------------------
    // A borrower is absent from every row here, including `clients:view`.
    // They read their own client record through the identity clause in the
    // RLS policy, not through a capability — see the note in
    // lib/permissions/permissions.ts.
    'clients:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'clients:create': ['manager', 'owner_admin'],
    'clients:update': ['secretary_treasurer', 'manager', 'owner_admin'],
    'clients:status': ['manager', 'owner_admin'],
    // Owner-only: a standing commercial judgement, not an operational state.
    'clients:blacklist': ['owner_admin'],
    'clients:archive': ['owner_admin'],
    'clients:documents': ['manager', 'owner_admin'],
    // Not held by the Secretary/Treasurer, who reads the directory all day.
    'clients:view_nin': ['manager', 'owner_admin'],
    // Owner-only: decides who may sign in and see a client's data.
    'clients:link_auth': ['owner_admin'],
    'clients:remarks_view': ['secretary_treasurer', 'manager', 'owner_admin'],
    // Deliberately not the Secretary/Treasurer: a remark that will later weigh
    // on a lending decision should carry a Manager's name.
    'clients:remarks_create': ['manager', 'owner_admin'],

    // --- Phase 3: guarantors ------------------------------------------------
    'guarantors:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'guarantors:create': ['manager', 'owner_admin'],
    'guarantors:update': ['manager', 'owner_admin'],
    'guarantors:documents': ['manager', 'owner_admin'],
    'guarantors:view_nin': ['manager', 'owner_admin'],
    'guarantors:link': ['manager', 'owner_admin'],

    // --- Phase 4: loans -----------------------------------------------------
    'loans:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'loans:create': ['secretary_treasurer', 'manager', 'owner_admin'],
    'loans:update_draft': ['secretary_treasurer', 'manager', 'owner_admin'],
    'loans:submit': ['secretary_treasurer', 'manager', 'owner_admin'],
    // The Secretary/Treasurer enters loans and decides nothing.
    'loans:approve': ['manager', 'owner_admin'],
    // Owner-only, and this is the phase's main internal control: a Manager
    // who could both approve and disburse could originate, approve and pay
    // out a loan alone.
    'loans:disburse': ['owner_admin'],
    'loans:cancel': ['owner_admin'],
    'loans:view_sensitive': ['manager', 'owner_admin'],

    // Phase 5. Every staff role that reads the loan register also reads the
    // collection schedules; the borrower reaches their own through the
    // ownership clause in the policy rather than through a capability.
    'schedules:view': ['secretary_treasurer', 'manager', 'owner_admin'],

    // Phase 6. Posting and reversing are separate, and reversal is the
    // Owner's alone: the person who records a payment must not be the person
    // who can withdraw the record.
    'payments:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'payments:create': ['secretary_treasurer', 'manager', 'owner_admin'],
    'payments:reverse': ['owner_admin'],

    // Phase 7. Both read-only: nothing in delinquency is entered by a person,
    // so there is no create, edit, delete or waive capability to place in any
    // row. A borrower sees their own arrears and their own penalty through the
    // ownership clauses in the policies, never through a capability, which is
    // why `client` is absent from both.
    'delinquency:view': ['secretary_treasurer', 'manager', 'owner_admin'],
    'penalties:view': ['secretary_treasurer', 'manager', 'owner_admin'],

    // Phase 8. Reporting is split by what the figures reveal. The counter role
    // gets the working reports; the Manager also gets the book; what the
    // business earns is the Owner's alone.
    'reports:view_operational': ['secretary_treasurer', 'manager', 'owner_admin'],
    'reports:view_financial': ['manager', 'owner_admin'],
    'reports:view_sensitive': ['owner_admin'],
  };

  it('covers every declared permission', () => {
    // A permission added without a row here is an untested capability.
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(PERMISSIONS)('grants %s to exactly the intended roles', (permission) => {
    const expected = MATRIX[permission];

    for (const role of ROLE_KEYS) {
      expect(can([role], permission), `${role} / ${permission}`).toBe(
        expected.includes(role),
      );
    }
  });

  it('keeps a borrower out of every staff surface', () => {
    // The single most important row: a client must never reach staff data.
    for (const permission of [
      'dashboard:view',
      'users:view',
      'users:create',
      'users:assign_role',
      'settings:view',
      'settings:update',
      'audit:view',
    ] as const) {
      expect(can(['client'], permission), permission).toBe(false);
    }
  });

  it('keeps a Secretary/Treasurer out of user administration entirely', () => {
    for (const permission of [
      'users:view',
      'users:create',
      'users:update',
      'users:disable',
      'users:assign_role',
      'users:reset_password',
      'settings:update',
      'audit:view',
    ] as const) {
      expect(can(['secretary_treasurer'], permission), permission).toBe(false);
    }
  });

  it('lets a Manager see staff but administer none of them', () => {
    // The Manager's boundary is the one most likely to be widened by accident,
    // because "manager" sounds like it should include administration.
    expect(can(['manager'], 'users:view')).toBe(true);

    for (const permission of [
      'users:create',
      'users:update',
      'users:disable',
      'users:assign_role',
      'users:reset_password',
    ] as const) {
      expect(can(['manager'], permission), permission).toBe(false);
    }
  });

  it('keeps settings changes and the audit trail with the Owner alone', () => {
    for (const role of ['client', 'secretary_treasurer', 'manager'] as const) {
      expect(can([role], 'settings:update'), role).toBe(false);
      expect(can([role], 'audit:view'), role).toBe(false);
    }

    expect(can(['owner_admin'], 'settings:update')).toBe(true);
    expect(can(['owner_admin'], 'audit:view')).toBe(true);
  });

  it('gives the Owner every staff capability, and deliberately not the borrower one', () => {
    // `portal:view` is the client portal. An Owner administers the business
    // and does not hold it — which is the clearest demonstration that grants
    // are read from the matrix rather than inferred from rank.
    const borrowerOnly: readonly Permission[] = ['portal:view'];

    for (const permission of PERMISSIONS) {
      expect(can(['owner_admin'], permission), permission).toBe(
        !borrowerOnly.includes(permission),
      );
    }
  });
});

describe('rank never substitutes for an explicit grant', () => {
  it("does not give a higher-ranked role a lower one's exclusive permission", () => {
    // `portal:view` belongs to the lowest-ranked role. An Owner outranks a
    // client and still must not hold it — proof that grants are read from the
    // matrix and not derived from ordering.
    expect(ROLE_RANK.owner_admin).toBeGreaterThan(ROLE_RANK.client);
    expect(can(['owner_admin'], 'portal:view')).toBe(false);
    expect(can(['manager'], 'portal:view')).toBe(false);
  });

  it('does not give a Manager an Owner-only permission despite outranking others', () => {
    expect(ROLE_RANK.manager).toBeGreaterThan(ROLE_RANK.secretary_treasurer);
    expect(can(['manager'], 'users:assign_role')).toBe(false);
  });

  it('would not grant a newly added permission to anyone by default', () => {
    // Every permission is held by at least one role today, but the mechanism
    // that matters is that `can` reads the table rather than inferring from
    // rank — so an unlisted capability is held by nobody.
    // A Phase 5 capability that does not exist yet. It has to be one nothing
    // declares: the previous placeholder was `loans:approve`, which Phase 4
    // then granted, quietly turning this into a test of nothing.
    const unlisted = 'payments:post' as Permission;
    for (const role of ROLE_KEYS) {
      expect(can([role], unlisted), role).toBe(false);
    }
  });
});

describe('combining roles', () => {
  it('unions the grants of every role held', () => {
    // The documented rule: permissions are additive and there are no deny
    // rules, so holding an extra role can only ever widen access.
    const granted = permissionsFor(['secretary_treasurer', 'owner_admin']);

    expect(granted).toContain('settings:update');
    expect(granted).toContain('dashboard:view');
    expect(new Set(granted).size).toBe(granted.length);
  });

  it('gives a combination exactly the union, never more', () => {
    const combined = new Set(permissionsFor(['client', 'manager']));
    const expected = new Set([...ROLE_PERMISSIONS.client, ...ROLE_PERMISSIONS.manager]);

    expect([...combined].sort()).toEqual([...expected].sort());
  });

  it('does not let a second role unlock an Owner-only capability', () => {
    expect(can(['manager', 'secretary_treasurer'], 'users:assign_role')).toBe(false);
    expect(can(['client', 'manager'], 'audit:view')).toBe(false);
  });

  it('evaluates canAll and canAny', () => {
    expect(canAll(['owner_admin'], ['settings:view', 'settings:update'])).toBe(true);
    expect(canAll(['manager'], ['settings:view', 'settings:update'])).toBe(false);
    expect(canAny(['manager'], ['settings:view', 'settings:update'])).toBe(true);
    expect(canAny(['client'], ['settings:view', 'settings:update'])).toBe(false);
  });

  it('fails closed for no roles and for an unknown role', () => {
    expect(can([], 'dashboard:view')).toBe(false);
    expect(can(['not_a_role' as RoleKey], 'dashboard:view')).toBe(false);
    expect(permissionsFor([])).toEqual([]);
  });
});

describe('rolePermissionPairs', () => {
  it('flattens the matrix to the shape seeded into the database', () => {
    const pairs = rolePermissionPairs();

    const total = ROLE_KEYS.reduce((sum, role) => sum + ROLE_PERMISSIONS[role].length, 0);
    expect(pairs).toHaveLength(total);

    for (const { role, permission } of pairs) {
      expect(ROLE_PERMISSIONS[role]).toContain(permission);
    }
  });

  it('is deterministic, so the database comparison is stable', () => {
    expect(rolePermissionPairs()).toEqual(rolePermissionPairs());
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
