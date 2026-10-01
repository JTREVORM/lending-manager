/**
 * The permission matrix.
 *
 * ## Capabilities, not role-name comparisons
 *
 * Authorization is expressed as named capabilities (`users:create`), never as
 * `role === 'owner_admin'` scattered through components. That matters for a
 * reason beyond tidiness: when the business later decides a Manager may reset
 * passwords, the change is one line in this table, not a hunt through every
 * screen and endpoint for role checks that happened to encode the old rule.
 *
 * ## Grants are explicit, never derived from rank
 *
 * `ROLE_RANK` exists, and it is deliberately **not** used to decide
 * permissions. A Manager outranks a Secretary/Treasurer, but a Manager does
 * not therefore receive every capability a future Owner-only feature adds.
 * Each role's grants are listed by hand, so a new permission defaults to being
 * held by nobody until somebody decides who should have it.
 *
 * Rank is used for two narrow things, both documented where they happen:
 * ordering roles in the interface, and the rule that an administrator may not
 * assign a role outranking their own.
 *
 * ## Multiple roles are additive
 *
 * A profile may hold several roles. The effective permission set is the
 * **union** of every held role's grants; there are no deny rules, so adding a
 * role can only ever widen access. `can()` returns true if any held role
 * grants the capability.
 *
 * ## This is one of two enforcement layers, not the boundary
 *
 * These checks decide whether a control renders and whether a Server Action
 * proceeds. A caller holding a valid token can skip all of it by calling the
 * Supabase REST API directly, so **Row Level Security is the real boundary**.
 *
 * Every grant here is mirrored into `public.role_permissions` by migration
 * `20261002000100`, and RLS policies are written against
 * `public.user_has_permission(...)`. A database test asserts the two
 * representations are identical, so this file and the policies cannot drift
 * apart.
 */

import { ROLE_KEYS, type RoleKey } from './roles';

/**
 * Named capabilities, as `resource:action`.
 *
 * The colon separator is the Phase 1 convention and is kept deliberately —
 * `resource:action` reads unambiguously because resources never contain a
 * colon, whereas a dot is also how nested fields are written elsewhere in the
 * codebase.
 *
 * Permissions for unbuilt lending functionality are **not** declared here.
 * A permission nothing enforces is a false assurance, and the matrix is
 * cheaper to extend than to audit.
 */
export const PERMISSIONS = [
  // --- Application shell ---------------------------------------------------
  /** Reach the authenticated staff shell and its dashboard. */
  'dashboard:view',

  // --- Own account ---------------------------------------------------------
  /** View one's own profile and account details. */
  'account:view',
  /** Change one's own non-privileged details (name, contact email). */
  'account:update',

  // --- Client portal -------------------------------------------------------
  /** Reach the client portal. Borrowers only. */
  'portal:view',

  // --- User administration -------------------------------------------------
  /** See the staff directory and individual user records. */
  'users:view',
  /** Create a staff account and its linked authentication identity. */
  'users:create',
  /** Change another user's name or contact details. */
  'users:update',
  /** Activate, suspend or archive another user's account. */
  'users:disable',
  /** Grant or revoke role assignments. */
  'users:assign_role',
  /** Set another user's password to a temporary value. */
  'users:reset_password',

  // --- Settings ------------------------------------------------------------
  /** Read company and business settings. */
  'settings:view',
  /** Change company or business settings. */
  'settings:update',

  // --- Audit ---------------------------------------------------------------
  /** Read the audit trail. */
  'audit:view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Grants per role.
 *
 * Every role is listed explicitly — including an empty set, were one empty —
 * so that adding a role to `ROLE_KEYS` without deciding its grants is a type
 * error rather than a silent denial.
 *
 * ### Why the Manager's set stops where it does
 *
 * A Manager supervises lending operations and needs to see who works here, so
 * they hold `users:view`. They deliberately do **not** hold `users:create`,
 * `users:assign_role`, `users:disable` or `users:reset_password`: those are
 * the capabilities that would let a Manager promote themselves, manufacture an
 * Owner account, or lock the Owner out. Concentrating account administration
 * in one role is the point of having the role.
 *
 * `settings:update` and `audit:view` are Owner-only for the same reason — the
 * first changes the rates money is lent at, the second is the record of who
 * changed them.
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly Permission[]>> = {
  // A borrower reaches the portal and their own account. Nothing else. They
  // must never see the staff shell, other clients, or any administration.
  client: ['portal:view', 'account:view', 'account:update'],

  secretary_treasurer: [
    'dashboard:view',
    'account:view',
    'account:update',
    'settings:view',
  ],

  manager: [
    'dashboard:view',
    'account:view',
    'account:update',
    'settings:view',
    'users:view',
  ],

  owner_admin: [
    'dashboard:view',
    'account:view',
    'account:update',
    'settings:view',
    'settings:update',
    'users:view',
    'users:create',
    'users:update',
    'users:disable',
    'users:assign_role',
    'users:reset_password',
    'audit:view',
  ],
} as const;

/**
 * Does any of these roles grant `permission`?
 *
 * Fails closed: no roles, an unknown role, or an ungranted permission all
 * return `false`.
 */
export function can(roles: readonly RoleKey[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission) === true);
}

/** Every permission these roles grant between them, deduplicated. */
export function permissionsFor(roles: readonly RoleKey[]): readonly Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return [...granted];
}

/** Do these roles grant every one of `permissions`? */
export function canAll(
  roles: readonly RoleKey[],
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => can(roles, permission));
}

/** Do these roles grant at least one of `permissions`? */
export function canAny(
  roles: readonly RoleKey[],
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => can(roles, permission));
}

/**
 * Exhaustiveness guard, evaluated at module load.
 *
 * If a role is added to `ROLE_KEYS` without an entry in `ROLE_PERMISSIONS`,
 * the `Record<RoleKey, …>` type already fails to compile. This runtime check
 * covers the reverse direction and the case of types being bypassed.
 */
const missingRoles = ROLE_KEYS.filter((role) => ROLE_PERMISSIONS[role] === undefined);
if (missingRoles.length > 0) {
  throw new Error(
    `ROLE_PERMISSIONS is missing an entry for: ${missingRoles.join(', ')}. Every role must declare its grants, even if empty.`,
  );
}

/**
 * Flattened `(role, permission)` pairs, sorted deterministically.
 *
 * This is the shape seeded into `public.role_permissions`, and the shape a
 * database test compares against. Keeping the projection here means the
 * migration and the test read from one definition.
 */
export function rolePermissionPairs(): readonly {
  role: RoleKey;
  permission: Permission;
}[] {
  return ROLE_KEYS.flatMap((role) =>
    [...ROLE_PERMISSIONS[role]].sort().map((permission) => ({ role, permission })),
  ).sort((a, b) =>
    a.role === b.role
      ? a.permission.localeCompare(b.permission)
      : a.role.localeCompare(b.role),
  );
}
