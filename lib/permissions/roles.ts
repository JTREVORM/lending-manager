/**
 * Role vocabulary.
 *
 * ## The database design, and why
 *
 * Roles are a **lookup table** (`public.roles`) plus an **assignment table**
 * (`public.user_roles`), not a PostgreSQL `enum` and not a column on
 * `profiles`. The alternatives were weighed as follows:
 *
 *   - *A `role` column on `profiles`* — simplest, but it permits exactly one
 *     role per person and records nothing about who granted it or when. For a
 *     financial system, "who gave this person the ability to approve loans,
 *     and when" is an audit question that must be answerable.
 *
 *   - *A PostgreSQL `enum`* — gives type safety at the column, but adding a
 *     role means `ALTER TYPE` in a migration, a value can never be removed,
 *     and the role carries no metadata (no label, no rank, no "is this a staff
 *     role"). The brief asks for a design that grows.
 *
 *   - *Lookup table + assignment table* (chosen) — a new role is a `INSERT`,
 *     roles carry their own label/rank/flags, assignments are rows that record
 *     `granted_by` and `granted_at`, and referential integrity is enforced by
 *     a foreign key. Multiple roles per person are representable, which the
 *     business does not need today but which costs nothing to allow.
 *
 * The four known roles are seeded by migration `0006`. This module mirrors
 * them so application code is strongly typed; a database integration test
 * asserts the two lists are identical, so a role added in SQL without
 * updating this file fails the build.
 *
 * ## What Phase 2 adds
 *
 * The full permission matrix, the UI for granting roles, and the Row Level
 * Security policies that consume `public.user_has_role()`. Phase 1 defines the
 * vocabulary and the shape of the check — see `lib/permissions/permissions.ts`.
 *
 * See docs/DECISIONS.md (ADR-001).
 */

/**
 * Role keys, in ascending order of authority.
 *
 * The order is meaningful: `ROLE_RANK` is derived from it.
 */
export const ROLE_KEYS = [
  'client',
  'secretary_treasurer',
  'manager',
  'owner_admin',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleDefinition {
  readonly key: RoleKey;
  readonly label: string;
  readonly description: string;
  /**
   * Higher means more authority. Used for "at least a manager" style checks
   * and to pick a person's effective role when they hold several.
   *
   * Gaps are left between values so a role can be inserted later without
   * renumbering the existing ones.
   */
  readonly rank: number;
  /** `false` for roles held by borrowers rather than employees. */
  readonly isStaff: boolean;
}

/**
 * Canonical role definitions. Mirrors the rows seeded into `public.roles`.
 */
export const ROLES: Readonly<Record<RoleKey, RoleDefinition>> = {
  client: {
    key: 'client',
    label: 'Client',
    description:
      'A borrower. May view only their own loans, schedule and payment history through the client portal.',
    rank: 10,
    isStaff: false,
  },
  secretary_treasurer: {
    key: 'secretary_treasurer',
    label: 'Secretary / Treasurer',
    description:
      'Front-office staff. Registers clients and guarantors and records payments.',
    rank: 30,
    isStaff: true,
  },
  manager: {
    key: 'manager',
    label: 'Manager',
    description:
      'Supervises lending operations: approves loans, applies penalties and reviews reports.',
    rank: 50,
    isStaff: true,
  },
  owner_admin: {
    key: 'owner_admin',
    label: 'Owner / Administrator',
    description:
      'Full control, including business settings, user management and the audit trail.',
    rank: 70,
    isStaff: true,
  },
} as const;

/** Ranks keyed by role, for ordering comparisons. */
export const ROLE_RANK: Readonly<Record<RoleKey, number>> = Object.freeze(
  Object.fromEntries(ROLE_KEYS.map((key) => [key, ROLES[key].rank])) as Record<
    RoleKey,
    number
  >,
);

export function isRoleKey(value: unknown): value is RoleKey {
  return typeof value === 'string' && (ROLE_KEYS as readonly string[]).includes(value);
}

/** All roles held by employees rather than borrowers. */
export const STAFF_ROLE_KEYS: readonly RoleKey[] = ROLE_KEYS.filter(
  (key) => ROLES[key].isStaff,
);

/**
 * The highest-ranked role a person holds, or `null` if they hold none.
 *
 * A person with no role must be treated as having no access at all, never as a
 * default `client` — an unassigned account is an incomplete one.
 */
export function effectiveRole(roles: readonly RoleKey[]): RoleKey | null {
  let highest: RoleKey | null = null;

  for (const role of roles) {
    // An unknown key ranks below every real role, so a corrupted value can
    // never be selected over a valid one.
    const candidate = ROLE_RANK[role] ?? -1;
    const incumbent = highest === null ? -1 : (ROLE_RANK[highest] ?? -1);

    if (candidate > incumbent) highest = role;
  }

  return highest;
}

/** Does this person hold `required`, or any role ranked above it? */
export function hasAtLeastRole(roles: readonly RoleKey[], required: RoleKey): boolean {
  const threshold = ROLE_RANK[required];
  return roles.some((role) => (ROLE_RANK[role] ?? -1) >= threshold);
}

/** Does this person hold any employee role? */
export function isStaff(roles: readonly RoleKey[]): boolean {
  return roles.some((role) => ROLES[role]?.isStaff === true);
}
