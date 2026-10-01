/**
 * Validation schemas for `public.profiles`.
 *
 * Phase 1 ships no screen that creates a profile — staff and client
 * registration are Phase 2. These schemas exist because the schema and its
 * rules are part of the foundation: they are what the Phase 2 forms and Server
 * Actions will validate against, they document the contract of the table, and
 * they are unit-tested now so the rules are known to work before anything
 * depends on them.
 */

import { z } from 'zod';

import {
  fullNameSchema,
  optionalEmailSchema,
  profileStatusSchema,
  ugandanPhoneSchema,
  uuidSchema,
} from './common';

/**
 * Creating a profile.
 *
 * `authUserId` is optional on purpose. Staff register a client at the counter
 * long before that client has portal credentials, so a profile may exist with
 * no linked `auth.users` row. See docs/DECISIONS.md (ADR-007).
 */
export const createProfileSchema = z.object({
  fullName: fullNameSchema,
  phone: ugandanPhoneSchema,
  email: optionalEmailSchema,
  authUserId: uuidSchema.nullable().optional(),
  status: profileStatusSchema.default('active'),
});

export type CreateProfileInput = z.input<typeof createProfileSchema>;
export type CreateProfile = z.output<typeof createProfileSchema>;

/**
 * Updating a profile.
 *
 * `authUserId` is absent: linking a profile to an auth account is an identity
 * operation with its own rules and audit trail, not a field on an edit form.
 * At least one field must be supplied, so an empty submission is rejected
 * rather than writing a no-op row and bumping `updated_at`.
 */
export const updateProfileSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    phone: ugandanPhoneSchema.optional(),
    email: optionalEmailSchema,
    status: profileStatusSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'No changes were submitted.',
    path: [],
  });

export type UpdateProfileInput = z.input<typeof updateProfileSchema>;
export type UpdateProfile = z.output<typeof updateProfileSchema>;

/** Assigning a role to a profile. The granting user comes from the session. */
export const assignRoleSchema = z.object({
  profileId: uuidSchema,
  roleKey: z.string().min(1),
});

export type AssignRoleInput = z.input<typeof assignRoleSchema>;
