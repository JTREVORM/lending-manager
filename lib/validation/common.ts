/**
 * Reusable Zod schemas for the primitives this domain keeps re-using.
 *
 * These are deliberately shared between forms, Server Actions and domain
 * operations so that a phone number typed into a form and a phone number
 * arriving at an API endpoint are held to exactly the same standard. A rule
 * that lives only in a React component is not a rule.
 *
 * Validation here complements the database rather than replacing it: every
 * constraint expressed below also exists as a `CHECK`, `NOT NULL` or `UNIQUE`
 * in the schema, so a write that somehow skipped this layer still cannot
 * corrupt the data.
 */

import { z } from 'zod';

import { MAX_UGX_AMOUNT } from '@/lib/domain/money';
import { normalizeUgandanPhone } from '@/lib/domain/phone';
import { MAX_BPS } from '@/lib/domain/rate';
import { isBusinessDate } from '@/lib/domain/datetime';
import { PROFILE_STATUSES } from '@/lib/domain/status';
import { ROLE_KEYS } from '@/lib/permissions/roles';
import { REFERENCE_SCOPES } from '@/lib/domain/reference';

/** A trimmed, non-empty string. Whitespace-only input is rejected. */
export const nonEmptyString = (label: string, max = 255): z.ZodString =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${String(max)} characters or fewer.`);

/** An optional string that normalises blank input to `null`. */
export const optionalString = (max = 255) =>
  z
    .string()
    .trim()
    .max(max, `Must be ${String(max)} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

export const uuidSchema = z.string().uuid('Must be a valid identifier.');

/**
 * A person's full name.
 *
 * Permits the letters, spaces, hyphens and apostrophes that Ugandan names
 * actually contain, and rejects digits and punctuation that indicate a
 * mis-filled field. Deliberately permissive about scripts — `\p{L}` covers
 * accented and non-Latin letters.
 */
export const fullNameSchema = nonEmptyString('Full name', 120)
  .min(2, 'Full name must be at least 2 characters.')
  .regex(
    /^[\p{L}][\p{L}\s'\-.]*$/u,
    'Full name may only contain letters, spaces, hyphens, apostrophes and full stops.',
  );

/**
 * A Ugandan phone number in any form staff might type, normalised to E.164.
 *
 * The output is always `+256` followed by nine digits, which is what the
 * `UNIQUE` column and its `CHECK` constraint expect.
 */
export const ugandanPhoneSchema = z
  .string({ error: 'Phone number is required.' })
  .trim()
  .min(1, 'Phone number is required.')
  .transform((value, ctx) => {
    try {
      return normalizeUgandanPhone(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid phone number.',
      });
      return z.NEVER;
    }
  });

/** An email address, lowercased. Optional throughout: many clients have none. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(254, 'Email address is too long.');

export const optionalEmailSchema = z
  .union([emailSchema, z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

/**
 * A monetary amount in whole Ugandan shillings.
 *
 * Fractional input is rejected rather than rounded — see lib/domain/money.ts.
 */
export const ugxAmountSchema = z
  .number({ error: 'Amount is required.' })
  .int('Amount must be a whole number of shillings.')
  .min(0, 'Amount cannot be negative.')
  .max(MAX_UGX_AMOUNT, `Amount cannot exceed ${MAX_UGX_AMOUNT.toLocaleString('en-UG')}.`);

/** A strictly positive monetary amount, for values where zero is meaningless. */
export const positiveUgxAmountSchema = ugxAmountSchema.min(
  1,
  'Amount must be greater than zero.',
);

/**
 * A monetary amount as a human types it, in whole shillings.
 *
 * Shared rather than copied, because the comma rule below is subtle enough
 * that two implementations would eventually disagree — and the amount of a
 * loan and the amount of a payment are equally load-bearing.
 *
 * ## The comma rule, which is the whole point
 *
 * Spaces are always formatting. Commas are **conditionally** formatting, and
 * the distinction is not cosmetic: stripping every comma turns `100000,50` —
 * a decimal comma, which much of the world writes — into 10,000,050
 * shillings. A hundredfold error, accepted silently, on the single most
 * important number on the screen. So a comma is accepted only where a
 * thousands separator belongs: groups of exactly three digits, from the right.
 *
 * Fractional input is **rejected rather than rounded**. Someone typing
 * `4000.50` has either mistyped or is thinking in a currency that is not UGX,
 * and quietly turning it into `4001` would hide which.
 */
export const ugxAmountFromText = (messages: {
  /** Shown when the field is empty. */
  readonly empty: string;
  /** Shown when the text is not a whole number of shillings. */
  readonly malformed: string;
  /** Shown when the value is zero or negative. */
  readonly nonPositive: string;
}) =>
  z.union([z.string(), z.number()]).transform((value, ctx) => {
    const text = typeof value === 'number' ? String(value) : value.trim();

    if (text === '') {
      ctx.addIssue({ code: 'custom', message: messages.empty });
      return z.NEVER;
    }

    const spaceless = text.replace(/\s/g, '');

    const grouped = /^\d{1,3}(,\d{3})+$/.test(spaceless);
    const plain = /^\d+$/.test(spaceless);

    if (!grouped && !plain) {
      ctx.addIssue({ code: 'custom', message: messages.malformed });
      return z.NEVER;
    }

    const amount = Number(spaceless.replace(/,/g, ''));

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      ctx.addIssue({ code: 'custom', message: messages.nonPositive });
      return z.NEVER;
    }

    if (amount > MAX_UGX_AMOUNT) {
      ctx.addIssue({ code: 'custom', message: 'That amount is implausibly large.' });
      return z.NEVER;
    }

    return amount;
  });

/**
 * A rate in integer basis points. 15% is `1500`.
 *
 * Forms should collect a percentage and convert with
 * `percentToBps` from lib/domain/rate.ts before validating.
 */
export const basisPointsSchema = z
  .number({ error: 'Rate is required.' })
  .int('Rate must be a whole number of basis points (15% is 1500).')
  .min(0, 'Rate cannot be negative.')
  .max(MAX_BPS, `Rate cannot exceed ${MAX_BPS.toLocaleString('en-UG')} basis points.`);

/** A calendar date as `YYYY-MM-DD`, interpreted in the business timezone. */
export const businessDateSchema = z
  .string({ error: 'Date is required.' })
  .trim()
  .refine(isBusinessDate, 'Enter a valid date in YYYY-MM-DD format.');

/** A count of whole days, e.g. a grace period. */
export const dayCountSchema = z
  .number({ error: 'Number of days is required.' })
  .int('Number of days must be a whole number.')
  .min(0, 'Number of days cannot be negative.')
  .max(3_650, 'Number of days cannot exceed 3,650 (ten years).');

/** A loan term in whole months. */
export const monthCountSchema = z
  .number({ error: 'Number of months is required.' })
  .int('Number of months must be a whole number.')
  .min(1, 'Number of months must be at least 1.')
  .max(120, 'Number of months cannot exceed 120 (ten years).');

export const profileStatusSchema = z.enum(PROFILE_STATUSES, {
  error: 'Select a valid status.',
});

export const roleKeySchema = z.enum(ROLE_KEYS, { error: 'Select a valid role.' });

export const referenceScopeSchema = z.enum(REFERENCE_SCOPES);

/** ISO 4217 currency code. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Currency code must be exactly three letters.')
  .regex(/^[A-Z]{3}$/, 'Currency code must be three uppercase letters.');

/** IANA timezone identifier, validated against the host's timezone database. */
export const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'Timezone is required.')
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Enter a valid IANA timezone, for example Africa/Kampala.');

/** BCP 47 locale identifier. */
export const localeSchema = z
  .string()
  .trim()
  .min(2, 'Locale is required.')
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Enter a valid locale, for example en-UG.');

/**
 * Storage object path, e.g. `client-documents/<uuid>/id-front/<uuid>.jpg`.
 *
 * Rejects absolute paths and any `..` segment, so a crafted value cannot
 * escape its intended prefix. See docs/DECISIONS.md (ADR-010).
 */
export const storagePathSchema = z
  .string()
  .trim()
  .min(1, 'File path is required.')
  .max(1_024, 'File path is too long.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/,
    'File path may only contain letters, numbers, dots, underscores, hyphens and slashes.',
  )
  .refine((value) => !value.includes('..'), 'File path may not contain "..".')
  .refine((value) => !value.startsWith('/'), 'File path may not start with "/".');

/** Cursor-free pagination parameters, with safe bounds. */
export const paginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export type Pagination = z.infer<typeof paginationSchema>;
