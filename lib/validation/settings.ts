/**
 * Validation schemas for the two settings tables.
 *
 * The settings UI is Phase 2+, but the *rules* are foundation: they state what
 * a valid lending configuration is, and they mirror the `CHECK` constraints in
 * migration 0004 so the two layers agree. Cross-field rules (a maximum above a
 * minimum, a term range that is the right way round) are expressed here with
 * `superRefine`, and the same relationships are constrained in SQL.
 */

import { z } from 'zod';

import {
  basisPointsSchema,
  currencyCodeSchema,
  dayCountSchema,
  localeSchema,
  monthCountSchema,
  optionalEmailSchema,
  optionalString,
  positiveUgxAmountSchema,
  storagePathSchema,
  timezoneSchema,
  ugandanPhoneSchema,
} from './common';

/**
 * Company identity and branding.
 *
 * Everything but the display name is optional, because the company's
 * registration is still in progress: there is no legal name, TIN or
 * registration number to record yet, and the system must not require them.
 */
export const companySettingsSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(2, 'Company name must be at least 2 characters.')
    .max(120, 'Company name must be 120 characters or fewer.'),

  legalName: optionalString(160),
  registrationNumber: optionalString(60),
  taxIdentificationNumber: optionalString(60),

  phone: z
    .union([ugandanPhoneSchema, z.literal('')])
    .nullable()
    .optional(),
  email: optionalEmailSchema,

  addressLine1: optionalString(160),
  addressLine2: optionalString(160),
  city: optionalString(80),
  country: optionalString(80),

  currencyCode: currencyCodeSchema.default('UGX'),
  locale: localeSchema.default('en-UG'),
  timezone: timezoneSchema.default('Africa/Kampala'),

  /** Storage object path, not a URL — the bucket is private. */
  logoPath: z
    .union([storagePathSchema, z.literal('')])
    .nullable()
    .optional(),

  receiptHeader: optionalString(500),
  receiptFooter: optionalString(500),
  brandPrimaryColor: z
    .union([
      z
        .string()
        .trim()
        .regex(
          /^#[0-9A-Fa-f]{6}$/,
          'Enter a colour as a six-digit hex value, e.g. #1F6F54.',
        ),
      z.literal(''),
    ])
    .nullable()
    .optional(),
});

export type CompanySettingsInput = z.input<typeof companySettingsSchema>;
export type CompanySettings = z.output<typeof companySettingsSchema>;

/**
 * Configurable lending rules.
 *
 * These are *data*, not constants. The 15% monthly rate and the 50% penalty
 * the business uses today are seeded values that the Owner/Admin can change;
 * no calculation may hard-code them. See docs/DECISIONS.md (ADR-008).
 */
export const businessSettingsSchema = z
  .object({
    minLoanAmount: positiveUgxAmountSchema,
    maxLoanAmount: positiveUgxAmountSchema,

    /** Monthly interest, in basis points. 15% is 1500. */
    defaultMonthlyInterestRateBps: basisPointsSchema,

    minLoanTermMonths: monthCountSchema,
    maxLoanTermMonths: monthCountSchema,

    /** Days after expiry before a penalty may be applied. */
    gracePeriodDays: dayCountSchema,

    /** One-time penalty on the remaining balance, in basis points. 50% is 5000. */
    penaltyRateBps: basisPointsSchema,

    /** The business permits one active loan per client today. */
    maxActiveLoansPerClient: z
      .number()
      .int('Must be a whole number.')
      .min(1, 'At least one active loan must be permitted.')
      .max(20, 'That many concurrent loans per client is not supported.'),

    defaultRepaymentFrequency: z
      .string()
      .trim()
      .min(1, 'Select a default repayment frequency.'),
  })
  .superRefine((value, ctx) => {
    if (value.maxLoanAmount < value.minLoanAmount) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLoanAmount'],
        message: 'Maximum loan amount must be greater than or equal to the minimum.',
      });
    }

    if (value.maxLoanTermMonths < value.minLoanTermMonths) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLoanTermMonths'],
        message: 'Maximum loan term must be greater than or equal to the minimum.',
      });
    }
  });

export type BusinessSettingsInput = z.input<typeof businessSettingsSchema>;
export type BusinessSettings = z.output<typeof businessSettingsSchema>;
