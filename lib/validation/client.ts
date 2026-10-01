/**
 * Validation for client and guarantor input.
 *
 * Every schema here runs on the server, inside the Server Action, against the
 * raw `FormData`. The same schemas are used to shape the forms, but that is a
 * convenience: the browser's copy can be skipped entirely by anyone posting
 * directly, so nothing below is "the client-side check".
 *
 * Three principles, each with a consequence visible in the code:
 *
 *   **Identity data is never silently corrected.** A phone number is
 *   normalised, because `0771 234 567` and `+256771234567` are the same number
 *   written two ways. A National Identification Number is uppercased and has
 *   spaces removed, because that is also formatting. But a NIN of the wrong
 *   length is rejected rather than padded, and a name is not "corrected" at
 *   all beyond trimming — the business works from the card in the person's
 *   hand, and a system that quietly alters identity data produces records that
 *   match nothing.
 *
 *   **Required means required at the counter.** Fields the business genuinely
 *   collects on its paper form are required. Fields it often does not have —
 *   an alternative phone, a NIN when the card is at home, a business type for
 *   somebody who is employed — are optional, because a system that cannot
 *   record a real client until every box is full gets filled with fiction.
 *
 *   **Upper bounds everywhere.** Every string has a maximum length. Without
 *   one, a text column is an invitation to store a megabyte in a name field.
 */

import { z } from 'zod';

import {
  CLIENT_STATUSES,
  COMPOSABLE_REMARK_CATEGORIES,
  MINIMUM_CLIENT_AGE,
  NIN_PATTERN,
  SEXES,
  normalizeNin,
} from '@/lib/domain/client';
import { fullNameSchema, ugandanPhoneSchema, uuidSchema } from './common';

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** An optional free-text field: blank becomes null rather than an empty string. */
const optionalText = (label: string, max: number) =>
  z
    .union([
      z
        .string()
        .trim()
        .max(max, `${label} cannot be longer than ${String(max)} characters.`),
      z.literal(''),
    ])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

/** A required free-text field, trimmed. */
const requiredText = (label: string, max: number, min = 2) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(min, `${label} is required.`)
    .max(max, `${label} cannot be longer than ${String(max)} characters.`);

export const sexSchema = z.enum(SEXES, { error: 'Select female or male.' });

export const clientStatusSchema = z.enum(CLIENT_STATUSES, {
  error: 'Select a valid status.',
});

/**
 * An optional alternative phone number.
 *
 * Optional, and normalised when present. The "must differ from the primary"
 * rule is applied at the object level, where both numbers are in view.
 */
export const optionalUgandanPhoneSchema = z
  .union([ugandanPhoneSchema, z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * A National Identification Number.
 *
 * Normalised (spaces removed, uppercased) and then checked for shape. The
 * normalisation is applied before validation so that a number read aloud and
 * typed `cm 9105 1234 abcd` is accepted, while `CM123` is still refused.
 */
export const ninSchema = z
  .string({ error: 'Enter the National Identification Number.' })
  .trim()
  .transform(normalizeNin)
  .refine((value) => NIN_PATTERN.test(value), {
    message:
      'A NIN is 14 characters: CM or CF followed by twelve letters or digits. Check the card.',
  });

export const optionalNinSchema = z
  .union([ninSchema, z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * A date of birth, as an ISO date string from a date input.
 *
 * Both bounds are checked here as well as in the database. The lower bound
 * catches a mistyped year — a client born in 1890 is a typo, not a customer —
 * and the upper enforces the borrowing age with a message that says what the
 * rule is, rather than failing an opaque database constraint at the counter.
 */
export const dateOfBirthSchema = z
  .string({ error: 'Enter the date of birth.' })
  .trim()
  .min(1, 'Enter the date of birth.')
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth as YYYY-MM-DD.')
  .refine(
    (value) => {
      // `Date.parse` is not enough on its own: JavaScript rolls an impossible
      // day over rather than rejecting it, so `1990-02-30` parses happily and
      // becomes 2 March. Silently recording a different date of birth than the
      // one submitted is exactly the quiet corruption of identity data this
      // module exists to prevent — so the parsed date is read back and its
      // components must match what was given.
      const parsed = new Date(`${value}T00:00:00Z`);

      if (Number.isNaN(parsed.getTime())) return false;

      const [year, month, day] = value.split('-').map(Number);

      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() + 1 === month &&
        parsed.getUTCDate() === day
      );
    },
    { message: 'That is not a real date. Check the day and month.' },
  )
  .refine(
    (value) => {
      const born = new Date(`${value}T00:00:00Z`);
      return born.getUTCFullYear() >= 1900;
    },
    { message: 'Check the year of birth.' },
  )
  .refine(
    (value) => {
      // Compared against today in Kampala, because that is the day the person
      // is standing at the counter. Comparing in UTC would turn away an
      // eighteenth birthday for the first three hours of the day.
      const born = new Date(`${value}T00:00:00Z`);
      const today = new Date();
      const kampalaToday = new Date(today.getTime() + 3 * 60 * 60 * 1000);

      const eighteenth = new Date(born);
      eighteenth.setUTCFullYear(eighteenth.getUTCFullYear() + MINIMUM_CLIENT_AGE);

      return eighteenth <= kampalaToday;
    },
    {
      message: `A client must be at least ${String(MINIMUM_CLIENT_AGE)} years old.`,
    },
  );

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Registering a client.
 *
 * `client_number` is absent by design: it is minted by the database, and a
 * schema that accepted one would imply a caller could choose it.
 */
export const createClientSchema = z
  .object({
    fullName: fullNameSchema,
    sex: sexSchema,
    dateOfBirth: dateOfBirthSchema,

    phone: ugandanPhoneSchema,
    alternativePhone: optionalUgandanPhoneSchema,

    occupation: requiredText('Occupation', 80),
    businessType: optionalText('Business type', 80),

    villageArea: requiredText('Village or area', 80),
    district: requiredText('District', 60),

    nin: optionalNinSchema,
    notes: optionalText('Notes', 2000),
  })
  .refine((value) => value.alternativePhone !== value.phone, {
    message: 'The alternative number is the same as the main number.',
    path: ['alternativePhone'],
  });

export type CreateClientInput = z.infer<typeof createClientSchema>;

/**
 * Editing a client.
 *
 * Note which fields are *not* here: `clientNumber`, `status`, `profileId`,
 * `photoPath`. Each is changed through its own narrower operation with its own
 * capability, so a general edit form cannot reach them. That is the allowlist
 * the specification asks for, expressed as a type rather than as a filter
 * somebody has to remember to apply.
 *
 * `nin` is present but handled separately in the action: writing it requires
 * `clients:view_nin`, which the Secretary/Treasurer who may use this form does
 * not hold.
 */
export const updateClientSchema = z
  .object({
    clientId: uuidSchema,

    fullName: fullNameSchema,
    sex: sexSchema,
    dateOfBirth: dateOfBirthSchema,

    phone: ugandanPhoneSchema,
    alternativePhone: optionalUgandanPhoneSchema,

    occupation: requiredText('Occupation', 80),
    businessType: optionalText('Business type', 80),

    villageArea: requiredText('Village or area', 80),
    district: requiredText('District', 60),

    notes: optionalText('Notes', 2000),
  })
  .refine((value) => value.alternativePhone !== value.phone, {
    message: 'The alternative number is the same as the main number.',
    path: ['alternativePhone'],
  });

export type UpdateClientInput = z.infer<typeof updateClientSchema>;

/** Correcting a client's identity data. Requires `clients:view_nin`. */
export const updateClientIdentitySchema = z.object({
  clientId: uuidSchema,
  nin: optionalNinSchema,
});

/**
 * Changing a client's status.
 *
 * The reason requirement is conditional, matching the database constraint: a
 * restriction must say why, an ordinary state need not. Checked at the object
 * level because it depends on the status chosen.
 */
export const changeClientStatusSchema = z
  .object({
    clientId: uuidSchema,
    status: clientStatusSchema,
    reason: optionalText('Reason', 500),
  })
  .refine(
    (value) =>
      !['suspended', 'blacklisted'].includes(value.status) ||
      (value.reason !== null && value.reason.trim().length >= 3),
    {
      message: 'Say why. This is recorded against the client permanently.',
      path: ['reason'],
    },
  );

export type ChangeClientStatusInput = z.infer<typeof changeClientStatusSchema>;

/** Searching and filtering the client directory. */
export const clientSearchSchema = z.object({
  // Short enough to be a search box, long enough for a full name.
  query: z
    .union([z.string().trim().max(120), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  status: z
    .union([clientStatusSchema, z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
});

export type ClientSearchInput = z.infer<typeof clientSearchSchema>;

/** Linking a client to a portal login. Owner-only. */
export const linkClientProfileSchema = z.object({
  clientId: uuidSchema,
  profileId: uuidSchema,
});

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

export const remarkCategorySchema = z.enum(COMPOSABLE_REMARK_CATEGORIES, {
  error: 'Select a category.',
});

export const createRemarkSchema = z.object({
  clientId: uuidSchema,
  // The lower bound is deliberate: a two-character remark is a mis-click, and
  // this table cannot be edited afterwards.
  body: z
    .string({ error: 'Write the remark.' })
    .trim()
    .min(3, 'Write at least a few words. A remark cannot be edited later.')
    .max(2000, 'A remark cannot be longer than 2000 characters.'),
  category: remarkCategorySchema,
});

export type CreateRemarkInput = z.infer<typeof createRemarkSchema>;

export const retractRemarkSchema = z.object({
  clientId: uuidSchema,
  remarkId: uuidSchema,
  body: z
    .string({ error: 'Say why this is being withdrawn.' })
    .trim()
    .min(3, 'Say why this is being withdrawn.')
    .max(2000, 'A retraction cannot be longer than 2000 characters.'),
});

// ---------------------------------------------------------------------------
// Guarantors
// ---------------------------------------------------------------------------

export const createGuarantorSchema = z
  .object({
    fullName: fullNameSchema,
    sex: sexSchema,
    dateOfBirth: dateOfBirthSchema,

    phone: ugandanPhoneSchema,
    alternativePhone: optionalUgandanPhoneSchema,

    occupation: requiredText('Occupation', 80),
    location: requiredText('Location', 120),
    district: optionalText('District', 60),

    nin: optionalNinSchema,
  })
  .refine((value) => value.alternativePhone !== value.phone, {
    message: 'The alternative number is the same as the main number.',
    path: ['alternativePhone'],
  });

export type CreateGuarantorInput = z.infer<typeof createGuarantorSchema>;

export const updateGuarantorSchema = createGuarantorSchema.safeExtend({
  guarantorId: uuidSchema,
});

/**
 * Attaching a guarantor to a client.
 *
 * The relationship is required and is recorded per association rather than on
 * the guarantor, because the same person is a brother to one client and a
 * business partner to another.
 */
export const linkGuarantorSchema = z.object({
  clientId: uuidSchema,
  guarantorId: uuidSchema,
  relationshipToClient: requiredText('Relationship to the client', 60),
});

export const detachGuarantorSchema = z.object({
  linkId: uuidSchema,
  clientId: uuidSchema,
  reason: optionalText('Reason', 300),
});

export const guarantorSearchSchema = z.object({
  query: z
    .union([z.string().trim().max(120), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/** 5 MiB. A phone photograph is well under this; a scanned PDF can approach it. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Accepted image types for a photograph.
 *
 * SVG is **excluded deliberately**, and it is the one exclusion worth
 * explaining: an SVG is a document that can contain script, so a stored SVG
 * served from the same origin is a cross-site scripting vector dressed as a
 * picture. Nobody photographs a client with a vector camera, so nothing is
 * lost. HEIC is included because iPhones produce it by default.
 */
export const ALLOWED_PHOTO_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

/** An identity document may also be a scan, so PDF is accepted here. */
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  ...ALLOWED_PHOTO_MIME_TYPES,
  'application/pdf',
] as const;

export type AllowedPhotoMimeType = (typeof ALLOWED_PHOTO_MIME_TYPES)[number];

export function isAllowedPhotoMimeType(value: string): boolean {
  return (ALLOWED_PHOTO_MIME_TYPES as readonly string[]).includes(value);
}

export function isAllowedDocumentMimeType(value: string): boolean {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}
