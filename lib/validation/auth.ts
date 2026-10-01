/**
 * Validation for the authentication and user-administration surfaces.
 *
 * As in Phase 1, these schemas are shared between the form and the Server
 * Action, so a rule cannot hold in one and not the other. Everything is
 * re-validated server-side regardless of what the browser did.
 */

import { z } from 'zod';

import {
  fullNameSchema,
  optionalEmailSchema,
  profileStatusSchema,
  roleKeySchema,
  ugandanPhoneSchema,
  uuidSchema,
} from './common';

/**
 * Minimum password length.
 *
 * Supabase Auth enforces its own project-level policy and is the authority;
 * this is a client-side courtesy so a user learns the password is too short
 * before a round trip, and a floor in case the project policy is ever relaxed.
 *
 * Deliberately a length requirement and nothing else. Mandated mixes of
 * character classes push people towards `Password1!` and towards writing
 * passwords down — which, for staff sharing a counter, is the realistic
 * failure mode. Length is the requirement that actually resists guessing.
 */
export const MIN_PASSWORD_LENGTH = 10;

export const passwordSchema = z
  .string({ error: 'Enter a password.' })
  .min(
    MIN_PASSWORD_LENGTH,
    `Use at least ${String(MIN_PASSWORD_LENGTH)} characters. A short phrase you can remember works well.`,
  )
  .max(72, 'Passwords cannot be longer than 72 characters.');

/**
 * The sign-in form.
 *
 * The identifier is deliberately NOT validated as a phone number here. A
 * validation message distinguishing "that is not a phone number" from "those
 * details are wrong" would be the start of an enumeration oracle, and the
 * sign-in action returns one generic failure for every cause. The only check
 * is that something was typed.
 */
export const signInSchema = z.object({
  identifier: z
    .string({ error: 'Enter your phone number.' })
    .trim()
    .min(1, 'Enter your phone number.')
    .max(60, 'That does not look like a phone number.'),
  password: z.string({ error: 'Enter your password.' }).min(1, 'Enter your password.'),
});

export type SignInInput = z.input<typeof signInSchema>;

/** Changing one's own password. */
export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ error: 'Enter your current password.' })
      .min(1, 'Enter your current password.'),
    newPassword: passwordSchema,
    confirmPassword: z.string({ error: 'Confirm your new password.' }).min(1),
  })
  .superRefine((value, ctx) => {
    if (value.newPassword !== value.confirmPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmPassword'],
        message: 'The two passwords do not match.',
      });
    }

    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPassword'],
        message: 'Choose a password different from your current one.',
      });
    }
  });

export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

/**
 * Creating a staff account.
 *
 * `roleKey` is validated as one of the known roles here; whether the acting
 * administrator may actually grant *that* role is a separate, authoritative
 * check made by the database trigger, because it depends on who is asking.
 */
export const createStaffUserSchema = z.object({
  fullName: fullNameSchema,
  phone: ugandanPhoneSchema,
  email: optionalEmailSchema,
  roleKey: roleKeySchema,
  temporaryPassword: passwordSchema,
});

export type CreateStaffUserInput = z.input<typeof createStaffUserSchema>;

/** Editing another user's contact details. Never their role or status. */
export const updateUserDetailsSchema = z.object({
  profileId: uuidSchema,
  fullName: fullNameSchema,
  email: optionalEmailSchema,
});

export type UpdateUserDetailsInput = z.input<typeof updateUserDetailsSchema>;

/** Editing one's own contact details. The profile comes from the session. */
export const updateOwnDetailsSchema = z.object({
  fullName: fullNameSchema,
  email: optionalEmailSchema,
});

export type UpdateOwnDetailsInput = z.input<typeof updateOwnDetailsSchema>;

/**
 * Changing an account's status.
 *
 * `archived` is excluded: archiving is a retention decision with consequences
 * beyond access, and Phase 2 only needs to turn access on and off.
 */
export const setUserStatusSchema = z.object({
  profileId: uuidSchema,
  status: profileStatusSchema.refine(
    (value) => value === 'active' || value === 'suspended' || value === 'inactive',
    'Choose active, inactive or suspended.',
  ),
});

export type SetUserStatusInput = z.input<typeof setUserStatusSchema>;

export const assignRoleSchema = z.object({
  profileId: uuidSchema,
  roleKey: roleKeySchema,
});

export type AssignRoleInput = z.input<typeof assignRoleSchema>;

export const revokeRoleSchema = assignRoleSchema;

/** Issuing a temporary password for another user. */
export const resetUserPasswordSchema = z.object({
  profileId: uuidSchema,
  temporaryPassword: passwordSchema,
});

export type ResetUserPasswordInput = z.input<typeof resetUserPasswordSchema>;

/** Filters on the user directory. */
export const userDirectoryFilterSchema = z.object({
  search: z.string().trim().max(80).optional(),
  role: z.union([roleKeySchema, z.literal('all')]).default('all'),
  status: z.union([profileStatusSchema, z.literal('all')]).default('all'),
});

export type UserDirectoryFilter = z.output<typeof userDirectoryFilterSchema>;
