/**
 * Validation for a loan product.
 *
 * ## Shape here, policy in the database
 *
 * The same division the rest of this directory keeps. What a product may
 * offer depends on `business_settings`, on which repayment cadences are
 * active and on which roles exist — all of it state that can change between
 * this form rendering and the button being pressed. So the guard rail is
 * enforced by `loan_products_within_business_rules`, a trigger, inside the
 * transaction that writes the row, and a refusal from it arrives here as a
 * sentence naming the limit it broke.
 *
 * What this layer refuses is input that could not be right under any state: a
 * maximum below a minimum, a default rate outside its own band, a product
 * that says a guarantor is required and asks for none, a code that is not a
 * code.
 *
 * ## Why the rate fields are percentages
 *
 * Because that is what a person types and what the screen says. The database
 * stores basis points; `parseRatePercent` is the one conversion, and it
 * refuses `15%%`, `fifteen` and the empty string rather than quietly reading
 * them as zero.
 */

import { z } from 'zod';

import { parseRatePercent } from '@/lib/domain/rate';
import {
  APPLICATION_PROFILES,
  EARLY_REPAYMENT_OPTIONS,
  EXTRA_PAYMENT_OPTIONS,
  INTEREST_METHODS,
  PENALTY_METHODS,
  PRODUCT_STATUSES,
} from '@/lib/domain/loan-product';
import { ROLE_KEYS } from '@/lib/permissions/roles';
import { nonEmptyString, optionalString, ugxAmountFromText, uuidSchema } from './common';

/**
 * The product's identifier: `QL`, `SL`, `IL-LEGACY`.
 *
 * Upper case, because it appears on every snapshot, export and report, and a
 * mixed-case set of codes is a set somebody will sort wrongly. The shape is
 * the same CHECK the column carries.
 */
export const productCodeSchema = nonEmptyString('Product code', 16)
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => /^[A-Z][A-Z0-9-]{1,15}$/.test(value),
    'A product code is 2 to 16 characters: a letter, then letters, digits or hyphens.',
  );

const amountSchema = ugxAmountFromText({
  empty: 'Enter the amount.',
  malformed:
    'Enter a whole number of shillings, for example 500000 or 500,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'Enter an amount greater than zero.',
});

/** A monthly rate as a percentage, converted to basis points. */
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

/** A whole number typed into a form field. */
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

/**
 * A checkbox.
 *
 * An unchecked box sends nothing at all, so `null` and `undefined` are false
 * rather than missing. Anything present is true, which is what a browser's
 * `value="on"` means.
 */
const checkbox = z
  .union([z.string(), z.null(), z.undefined()])
  // Optional, because an unticked checkbox and an untouched text box both
  // send *nothing at all* — the key is absent rather than empty.
  .optional()
  .transform((value) => value !== null && value !== undefined && value !== '');

/** A fixed menu of durations, typed as `1, 2, 3`. Blank means any month. */
const termMenuSchema = z
  .union([z.string(), z.null(), z.undefined()])
  // Optional, because an unticked checkbox and an untouched text box both
  // send *nothing at all* — the key is absent rather than empty.
  .optional()
  .transform((value, ctx) => {
    const raw = (value ?? '').trim();
    if (raw === '') return null;

    const parts = raw
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => part !== '');

    const months: number[] = [];

    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'List the durations as whole months separated by commas, e.g. 1, 2, 3.',
        });
        return z.NEVER;
      }

      const month = Number(part);

      if (month < 1 || month > 120) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each duration must be between 1 and 120 months.',
        });
        return z.NEVER;
      }

      if (!months.includes(month)) months.push(month);
    }

    return months.sort((a, b) => a - b);
  });

/**
 * At least one repayment cadence, by key.
 *
 * Whether each key is an *active* cadence is the database's question — the
 * trigger checks `repayment_frequencies` — because a cadence can be retired
 * between this form rendering and the save.
 */
const cadenceListSchema = z
  .array(z.string().trim().min(1))
  .min(1, 'Choose at least one repayment cadence.');

const overrideRolesSchema = z.array(z.enum(ROLE_KEYS)).default([]);

const productFields = {
  name: nonEmptyString('Product name', 80),
  description: optionalString(500),
  status: z.enum(PRODUCT_STATUSES, { error: 'Choose whether this product is offered.' }),
  sortOrder: wholeNumber('Display order', 0, 999),
  isDefault: checkbox,

  minAmount: amountSchema,
  maxAmount: amountSchema,

  defaultInterestRateBps: rateSchema,
  minInterestRateBps: rateSchema,
  maxInterestRateBps: rateSchema,
  interestMethod: z.enum(INTEREST_METHODS, { error: 'Choose how interest is charged.' }),
  interestOverrideAllowed: checkbox,
  interestOverrideRoles: overrideRolesSchema,

  minTermMonths: wholeNumber('Shortest duration', 1, 120),
  maxTermMonths: wholeNumber('Longest duration', 1, 120),
  allowedTermMonths: termMenuSchema,

  allowedRepaymentFrequencies: cadenceListSchema,
  defaultRepaymentFrequency: nonEmptyString('Default repayment cadence', 40),

  gracePeriodDays: wholeNumber('Grace period', 0, 3650),
  penaltyRateBps: rateSchema,
  penaltyMethod: z.enum(PENALTY_METHODS, {
    error: 'Choose how a late-payment charge is worked out.',
  }),

  guarantorRequired: checkbox,
  minGuarantors: wholeNumber('Guarantors required', 0, 10),
  collateralRequired: checkbox,

  earlyRepayment: z.enum(EARLY_REPAYMENT_OPTIONS, {
    error: 'Choose what happens on early settlement.',
  }),
  extraPayment: z.enum(EXTRA_PAYMENT_OPTIONS, {
    error: 'Choose what happens when a borrower overpays.',
  }),

  applicationProfile: z.enum(APPLICATION_PROFILES, {
    error: 'Choose which questions the application asks.',
  }),
  requiresSupportingDocuments: checkbox,

  /** Empty means every branch, which is what no rows in the join table means. */
  branchIds: z.array(uuidSchema).default([]),
};

/**
 * The cross-field rules, applied to both create and edit.
 *
 * Each one is also a CHECK on the table. Repeating them here is not
 * duplication for its own sake: a constraint violation arrives as one
 * sentence about the whole row, and these put the message on the field that
 * is wrong, which is the difference between a form a person can fix and a
 * form they have to guess at.
 *
 * Typed against the shared fields rather than against either schema, so the
 * create and edit forms cannot drift apart — a rule added here applies to
 * both because there is only one of it.
 */
type ProductFieldValues = z.infer<z.ZodObject<typeof productFields>>;

function checkCrossFieldRules(value: ProductFieldValues, ctx: z.RefinementCtx): void {
  if (value.maxAmount < value.minAmount) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxAmount'],
      message: 'The largest loan cannot be smaller than the smallest.',
    });
  }

  if (value.maxInterestRateBps < value.minInterestRateBps) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxInterestRateBps'],
      message: 'The highest rate cannot be below the lowest.',
    });
  }

  if (
    value.defaultInterestRateBps < value.minInterestRateBps ||
    value.defaultInterestRateBps > value.maxInterestRateBps
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultInterestRateBps'],
      message: 'The standard rate has to be inside the band this product permits.',
    });
  }

  if (value.maxTermMonths < value.minTermMonths) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxTermMonths'],
      message: 'The longest duration cannot be shorter than the shortest.',
    });
  }

  if (
    value.allowedTermMonths?.some(
      (month) => month < value.minTermMonths || month > value.maxTermMonths,
    ) === true
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['allowedTermMonths'],
      message: `Every duration offered has to be between ${String(value.minTermMonths)} and ${String(value.maxTermMonths)} months.`,
    });
  }

  if (!value.allowedRepaymentFrequencies.includes(value.defaultRepaymentFrequency)) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultRepaymentFrequency'],
      message: 'The default cadence has to be one this product offers.',
    });
  }

  if (!value.interestOverrideAllowed && value.interestOverrideRoles.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['interestOverrideRoles'],
      message:
        'Naming who may change the rate means nothing unless changing it is permitted.',
    });
  }

  if (value.interestOverrideAllowed && value.interestOverrideRoles.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['interestOverrideRoles'],
      message: 'Name at least one role that may approve a different rate.',
    });
  }

  if (value.guarantorRequired && value.minGuarantors < 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['minGuarantors'],
      message: 'A product that requires a guarantor has to ask for at least one.',
    });
  }

  // A withdrawn product cannot be the one a loan gets by default: the
  // database refuses it too, with a CHECK, and this says which field.
  if (value.status !== 'active' && value.isDefault) {
    ctx.addIssue({
      code: 'custom',
      path: ['isDefault'],
      message: 'Only a product the business is offering can be the default.',
    });
  }
}

export const createLoanProductSchema = z
  .object({ productCode: productCodeSchema, ...productFields })
  .superRefine(checkCrossFieldRules);

export const updateLoanProductSchema = z
  .object({ productId: uuidSchema, ...productFields })
  .superRefine(checkCrossFieldRules);

/** Retiring or re-offering a product, from the list. */
export const productStatusSchema = z.object({
  productId: uuidSchema,
  status: z.enum(PRODUCT_STATUSES, { error: 'Choose whether this product is offered.' }),
});

/** Making a product the one a loan gets when nothing names another. */
export const productDefaultSchema = z.object({ productId: uuidSchema });

export type CreateLoanProductInput = z.infer<typeof createLoanProductSchema>;
export type UpdateLoanProductInput = z.infer<typeof updateLoanProductSchema>;
