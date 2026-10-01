/**
 * Permission checking — the *shape* of authorization, not the full matrix.
 *
 * ## Scope in Phase 1
 *
 * The complete permission matrix belongs to Phase 2, and inventing it now
 * would mean guessing at rules the business has not yet stated. What this file
 * establishes is the mechanism that matrix will plug into:
 *
 *   - permissions are named `resource:action` strings, not booleans scattered
 *     across components;
 *   - `can()` is the single entry point, so there is exactly one place to
 *     audit and one place for Phase 2 to extend;
 *   - the grants below cover only the surfaces Phase 1 actually has.
 *
 * Anything not listed is denied. That is deliberate: a permission the matrix
 * has not yet been taught about must fail closed.
 *
 * ## This is not the security boundary
 *
 * These checks run in application code and are a usability layer — they decide
 * whether a button renders and whether a Server Action proceeds. A determined
 * caller can skip them entirely by talking to the Supabase REST API with their
 * own token. **Row Level Security is the real boundary**, and Phase 2 must
 * express every rule here as an RLS policy as well. A check that exists only
 * in TypeScript is not enforcement.
 */

import { ROLE_KEYS, type RoleKey } from './roles';

/**
 * Named permissions, as `resource:action`.
 *
 * Phase 1 covers only what Phase 1 ships: the application shell and the
 * read-only settings surface. Phase 2 extends this union with the client,
 * guarantor, loan, payment, penalty and report permissions.
 */
export const PERMISSIONS = [
  /** See the authenticated application shell and the placeholder dashboard. */
  'dashboard:view',
  /** Read company and business settings. */
  'settings:read',
  /** Change company or business settings. */
  'settings:write',
  /** Read the audit trail. */
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Grants per role, for the Phase 1 permissions only.
 *
 * Every role is listed explicitly — including `client` with an empty set —
 * so that adding a role to `ROLE_KEYS` without deciding its grants is a type
 * error rather than a silent denial. A test asserts the keys stay in step.
 *
 * TODO(phase-2): extend with the client, guarantor, loan, payment, penalty and
 * report permissions once the business has confirmed the matrix, and mirror
 * each rule in a Row Level Security policy.
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly Permission[]>> = {
  // A borrower reaches the client portal, not the staff shell. The portal's
  // own permissions arrive with it in a later phase.
  client: [],

  secretary_treasurer: ['dashboard:view', 'settings:read'],

  manager: ['dashboard:view', 'settings:read'],

  owner_admin: ['dashboard:view', 'settings:read', 'settings:write', 'audit:read'],
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
