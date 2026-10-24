/**
 * Validation for membership input.
 *
 * Phase 1 has no membership write actions — enrolment, savings and status
 * changes are Polytos Phase 2 — so what is here is the validation the *read*
 * surfaces need: the register's filter, and the identifiers a route segment
 * carries.
 *
 * The transition schema is the exception, and it is here deliberately rather
 * than waiting for Phase 2. The lifecycle is enforced three times over — by
 * `memberships_guard_transition` in the database, by
 * `canTransitionMembership` in the domain, and by this schema at the edge —
 * and writing the third one now means Phase 2's write action is a thin call
 * over rules that have already been reviewed and tested, rather than a place
 * where a fourth interpretation of the lifecycle gets invented under
 * deadline.
 *
 * Every schema here runs on the server. The browser's copy of any of it can
 * be skipped by anyone posting directly, so none of it is the control; Row
 * Level Security and the column guards are.
 */

import { z } from 'zod';

import {
  MEMBERSHIP_STATUSES,
  canTransitionMembership,
  isMembershipStatus,
  membershipStatusRequiresReason,
} from '@/lib/domain/membership';
import { uuidSchema } from './common';

/** A membership status, as a filter value or a transition target. */
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES, {
  error: 'Select a valid membership status.',
});

/**
 * The register's filter.
 *
 * Shaped exactly like `clientSearchSchema`: blank means "no filter" rather
 * than an empty string, and a malformed page falls back to one. A filter is a
 * convenience, not a control, so nothing here fails closed — the page renders
 * the default view instead of an error.
 */
export const membershipSearchSchema = z.object({
  // Short enough to be a search box, long enough for a full name.
  query: z
    .union([z.string().trim().max(120), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  status: z
    .union([membershipStatusSchema, z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
});

export type MembershipSearchInput = z.infer<typeof membershipSearchSchema>;

/** A membership identified by its own id. */
export const membershipIdSchema = z.object({ membershipId: uuidSchema });

/**
 * A status transition, validated against the lifecycle rather than merely
 * against the vocabulary.
 *
 * Two rules the database also enforces, stated here so a person gets a
 * sentence rather than a constraint name:
 *
 *   - the move must be one the lifecycle permits, which is why `from` is
 *     part of the input — a schema that validated only the destination would
 *     accept `withdrawn -> active`;
 *   - suspending or withdrawing requires a reason, because a restriction the
 *     business chose must say why.
 *
 * The dates each transition stamps are deliberately absent. They are supplied
 * by the database from the business clock; a caller who could set
 * `activated_on` could backdate a savings qualification by six months.
 */
export const membershipTransitionSchema = z
  .object({
    membershipId: uuidSchema,
    from: membershipStatusSchema,
    to: membershipStatusSchema,
    reason: z
      .string()
      .trim()
      .max(500, 'A reason cannot be longer than 500 characters.')
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  })
  .superRefine((value, ctx) => {
    if (!canTransitionMembership(value.from, value.to)) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `A membership cannot move from ${value.from} to ${value.to}.`,
      });
    }

    if (membershipStatusRequiresReason(value.to) && value.reason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Give a reason. It is recorded against the membership.',
      });
    }
  });

export type MembershipTransitionInput = z.infer<typeof membershipTransitionSchema>;

/**
 * Read a status out of an untrusted string, or `null`.
 *
 * For a query parameter, where an unrecognised value is an ordinary outcome
 * rather than an error.
 */
export function parseMembershipStatus(value: unknown): string | null {
  return isMembershipStatus(value) ? value : null;
}
