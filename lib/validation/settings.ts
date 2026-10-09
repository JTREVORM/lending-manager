/**
 * Validation for the settings an Owner may change.
 *
 * ## Shape here, policy in the database — again
 *
 * The same division the rest of this directory keeps. `business_settings`
 * carries its own CHECK constraints (a maximum not below a minimum, a term
 * range the right way round, a rate inside bounds) and, as of Phase 12, a
 * trigger that refuses a change which would strand an active loan product.
 * None of that is re-implemented here: the first is re-stated field by field
 * so a person is told *which* box is wrong, and the second cannot be checked
 * here at all, because it depends on the products as they are at the moment
 * of the write.
 *
 * ## Why the company fields are this strict
 *
 * Because a receipt prints them. A phone number that is not a phone number is
 * a receipt a borrower cannot act on, and the column's own CHECK would refuse
 * it anyway — with a constraint name instead of a sentence.
 */

import { z } from 'zod';

import { parseRatePercent } from '@/lib/domain/rate';
import {
  localeSchema,
  nonEmptyString,
  optionalEmailSchema,
  optionalString,
  storagePathSchema,
  timezoneSchema,
  ugandanPhoneSchema,
  ugxAmountFromText,
} from './common';

/** A published phone number, or nothing. Normalised to E.164. */
const optionalPhoneSchema = z
  .union([z.string(), z.null(), z.undefined()])
  // Optional, because an unticked checkbox and an untouched text box both
  // send *nothing at all* — the key is absent rather than empty.
  .optional()
  .transform((value, ctx) => {
    const raw = (value ?? '').trim();
    if (raw === '') return null;

    const parsed = ugandanPhoneSchema.safeParse(raw);

    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        message: parsed.error.issues[0]?.message ?? 'Enter a valid Ugandan phone number.',
      });
      return z.NEVER;
    }

    return parsed.data;
  });

/** A hex brand colour, or nothing. The same shape the column's CHECK allows. */
const optionalColourSchema = z
  .union([z.string(), z.null(), z.undefined()])
  // Optional, because an unticked checkbox and an untouched text box both
  // send *nothing at all* — the key is absent rather than empty.
  .optional()
  .transform((value, ctx) => {
    const raw = (value ?? '').trim();
    if (raw === '') return null;

    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a colour as six hex digits after a hash, for example #0B4394.',
      });
      return z.NEVER;
    }

    return raw.toUpperCase();
  });

/** The logo's path under the public asset root, or nothing. */
const optionalLogoPathSchema = z
  .union([z.string(), z.null(), z.undefined()])
  // Optional, because an unticked checkbox and an untouched text box both
  // send *nothing at all* — the key is absent rather than empty.
  .optional()
  .transform((value, ctx) => {
    const raw = (value ?? '').trim();
    if (raw === '') return null;

    const parsed = storagePathSchema.safeParse(raw);

    if (!parsed.success) {
      ctx.addIssue({
        code: 'custom',
        message: parsed.error.issues[0]?.message ?? 'Enter a valid asset path.',
      });
      return z.NEVER;
    }

    return parsed.data;
  });

/**
 * The company's own identity.
 *
 * Phase 12 replaced a placeholder with the real business, and this is how it
 * stays the real business without a migration: one screen, the same row every
 * receipt, statement and header reads.
 */
export const companyIdentitySchema = z.object({
  companyName: nonEmptyString('Trading name', 120),
  legalName: optionalString(160),
  tagline: optionalString(160),
  registrationNumber: optionalString(60),
  taxIdentificationNumber: optionalString(60),
  phone: optionalPhoneSchema,
  phoneSecondary: optionalPhoneSchema,
  email: optionalEmailSchema,
  postalAddress: optionalString(160),
  addressLine1: optionalString(160),
  addressLine2: optionalString(160),
  city: optionalString(80),
  country: optionalString(80),
  locale: localeSchema,
  timezone: timezoneSchema,
  logoPath: optionalLogoPathSchema,
  brandPrimaryColor: optionalColourSchema,
  receiptHeader: optionalString(200),
  receiptFooter: optionalString(300),
});

const amountSchema = ugxAmountFromText({
  empty: 'Enter the amount.',
  malformed:
    'Enter a whole number of shillings, for example 500000 or 500,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'Enter an amount greater than zero.',
});

const zeroableAmountSchema = ugxAmountFromText({
  empty: 'Enter the amount.',
  malformed:
    'Enter a whole number of shillings, for example 500000 or 500,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'An amount cannot be negative.',
  allowZero: true,
});

const rateSchema = z
  .string({ error: 'Enter the rate.' })
  .trim()
  .transform((value, ctx) => {
    try {
      return Number(parseRatePercent(value));
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message:
          error instanceof Error
            ? error.message
            : 'Enter a monthly rate as a percentage, for example 15.',
      });
      return z.NEVER;
    }
  });

const wholeNumber = (label: string, min: number, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .transform((value, ctx) => {
      if (!/^\d+$/.test(value)) {
        ctx.addIssue({ code: 'custom', message: `${label} must be a whole number.` });
        return z.NEVER;
      }

      const parsed = Number(value);

      if (parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `${label} must be between ${String(min)} and ${String(max)}.`,
        });
        return z.NEVER;
      }

      return parsed;
    });

const checkbox = z
  .union([z.string(), z.null(), z.undefined()])
  // Optional, because an unticked checkbox and an untouched text box both
  // send *nothing at all* — the key is absent rather than empty.
  .optional()
  .transform((value) => value !== null && value !== undefined && value !== '');

/**
 * The business's own rules: the guard rail, not a product.
 *
 * Every figure here bounds what a product may offer, which is why the screen
 * says so and why a change that would strand a product is refused by the
 * database rather than here.
 */
export const lendingRulesSchema = z
  .object({
    minLoanAmount: amountSchema,
    maxLoanAmount: amountSchema,
    multiMonthMinAmount: amountSchema,
    defaultMonthlyInterestRateBps: rateSchema,
    minLoanTermMonths: wholeNumber('Shortest term', 1, 120),
    maxLoanTermMonths: wholeNumber('Longest term', 1, 120),
    gracePeriodDays: wholeNumber('Grace period', 0, 3650),
    penaltyRateBps: rateSchema,
    maxActiveLoansPerClient: wholeNumber('Active loans per client', 1, 10),
    minGuarantorsRequired: wholeNumber('Guarantors required', 0, 10),
  })
  .superRefine((value, ctx) => {
    if (value.maxLoanAmount < value.minLoanAmount) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLoanAmount'],
        message: 'The largest loan cannot be smaller than the smallest.',
      });
    }

    if (value.maxLoanTermMonths < value.minLoanTermMonths) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLoanTermMonths'],
        message: 'The longest term cannot be shorter than the shortest.',
      });
    }

    if (value.multiMonthMinAmount < value.minLoanAmount) {
      ctx.addIssue({
        code: 'custom',
        path: ['multiMonthMinAmount'],
        message: 'The multi-month threshold cannot be below the smallest loan.',
      });
    }
  });

/**
 * The finance thresholds.
 *
 * `allowNegativeCash` is the one setting in the product that can let a
 * drawer go below zero, so the screen states what it means and the posting
 * functions read it themselves — no caller can opt out.
 */
export const financeSettingsSchema = z.object({
  transferApprovalThreshold: zeroableAmountSchema,
  expenseApprovalThreshold: zeroableAmountSchema,
  allowNegativeCash: checkbox,
  reconciliationRequiresReview: checkbox,
  lowBalanceCashAtHand: zeroableAmountSchema,
  lowBalanceMtn: zeroableAmountSchema,
  lowBalanceAirtel: zeroableAmountSchema,
  lowBalanceBank: zeroableAmountSchema,
});

export type CompanyIdentityInput = z.infer<typeof companyIdentitySchema>;
export type LendingRulesInput = z.infer<typeof lendingRulesSchema>;
export type FinanceSettingsInput = z.infer<typeof financeSettingsSchema>;
