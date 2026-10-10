/**
 * Validation for security taken against a loan and for the work of recovering
 * one that has gone bad.
 *
 * The same principle every schema in this directory states: nothing here
 * decides *whether* an action is allowed. `loan_collateral_guard` decides
 * whether an item may still be edited, `loan_recovery_actions_stamp_author`
 * decides whether a loan has anything to recover, and
 * `release_loan_guarantor` decides whether the loan would be left with enough
 * cover. These schemas check that what was typed is well-formed, so the form
 * can say "enter the date as YYYY-MM-DD" without a round trip.
 *
 * One rule is here and nowhere else, because it is about the *form* rather
 * than the data: a promise needs both an amount and a date, and the browser
 * should say so beside the two empty boxes rather than after a submit. The
 * database carries the same rule as a check constraint, because a form is not
 * a guarantee of anything.
 */

import { z } from 'zod';

import {
  COLLATERAL_ITEM_TYPES,
  RECORDABLE_RECOVERY_KINDS,
  RECOVERY_OUTCOMES,
} from '@/lib/domain/security';

import {
  businessDateSchema,
  ugandanPhoneSchema,
  ugxAmountFromText,
  uuidSchema,
} from './common';

/** An amount of security or a promised sum, as typed into a form. */
const amount = (label: string) =>
  ugxAmountFromText({
    empty: `${label} is required.`,
    malformed: `Enter ${label.toLowerCase()} as a whole number of shillings.`,
    nonPositive: `${label} must be more than zero.`,
  });

const reason = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(3, `${label} is required.`)
    .max(500, `${label} must be 500 characters or fewer.`);

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

const optionalDate = z
  .union([z.literal(''), businessDateSchema])
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

// ---------------------------------------------------------------------------
// Collateral
// ---------------------------------------------------------------------------

export const recordCollateralSchema = z.object({
  loanId: uuidSchema,
  itemType: z.enum(COLLATERAL_ITEM_TYPES, { error: 'Choose what kind of item this is.' }),
  description: z
    .string({ error: 'Describe the item.' })
    .trim()
    .min(3, 'Describe the item in a few words at least.')
    .max(500, 'The description must be 500 characters or fewer.'),
  estimatedValue: amount('Estimated value'),
  // Required, and required to be in the past, because a valuation with no date
  // is a figure nobody can tell the age of. The database agrees.
  valuedOn: businessDateSchema,
  serialNumber: optionalText(120),
  ownershipDocument: optionalText(200),
  location: optionalText(200),
});

export type RecordCollateralInput = z.infer<typeof recordCollateralSchema>;

/**
 * Editing an item while the application is still being assembled.
 *
 * The same fields, by id. Deliberately not a partial: a form that submits
 * only what changed cannot tell "left blank" from "cleared", and a serial
 * number that silently survives being deleted is worse than one that has to
 * be retyped.
 */
export const updateCollateralSchema = recordCollateralSchema
  .omit({ loanId: true })
  .extend({ collateralId: uuidSchema });

export const removeCollateralSchema = z.object({
  collateralId: uuidSchema,
  loanId: uuidSchema,
});

export const releaseCollateralSchema = z.object({
  collateralId: uuidSchema,
  loanId: uuidSchema,
  releaseReason: reason('A reason for releasing the item'),
});

/**
 * Realising an item.
 *
 * `realisedAmount` allows zero: an item that fetched nothing at auction is a
 * real and painful outcome, and refusing to record it would leave the register
 * saying the item is still held.
 *
 * What this does **not** do is move money. The proceeds reach the books as a
 * payment through `post_payment`, like every other shilling, so this records
 * the sale and the collection screen records the receipt. Nothing here touches
 * a balance.
 */
export const realiseCollateralSchema = z.object({
  collateralId: uuidSchema,
  loanId: uuidSchema,
  realisedAmount: ugxAmountFromText({
    empty: 'What the item fetched is required.',
    malformed: 'Enter the proceeds as a whole number of shillings.',
    nonPositive: 'The proceeds cannot be negative.',
    allowZero: true,
  }),
  releaseReason: reason('A note on the sale'),
});

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

export const releaseGuarantorSchema = z.object({
  loanGuarantorId: uuidSchema,
  loanId: uuidSchema,
  releaseReason: reason('A reason for releasing the guarantor'),
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recording a recovery action.
 *
 * The promise fields are validated as a pair at the end, which is the one
 * cross-field rule a form genuinely benefits from catching early: somebody
 * choosing "Promise to pay" and then leaving the amount blank should be told
 * beside the box, not after a round trip.
 */
export const recordRecoveryActionSchema = z
  .object({
    loanId: uuidSchema,
    actionKind: z.enum(RECORDABLE_RECOVERY_KINDS, {
      error: 'Choose what kind of action this was.',
    }),
    outcome: z
      .union([z.literal(''), z.enum(RECOVERY_OUTCOMES)])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    notes: z
      .string({ error: 'Say what happened.' })
      .trim()
      .min(3, 'Say what happened, in a few words at least.')
      .max(2000, 'The note must be 2,000 characters or fewer.'),
    actionDate: businessDateSchema,
    followUpOn: optionalDate,
    promisedAmount: z
      .union([z.literal(''), amount('The promised amount')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    promisedOn: optionalDate,
  })
  .superRefine((value, ctx) => {
    if (value.actionKind === 'promise' && value.promisedAmount === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['promisedAmount'],
        message: 'A promise to pay needs an amount.',
      });
    }

    if (value.promisedAmount !== null && value.promisedOn === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['promisedOn'],
        message: 'Say which day the borrower promised to pay.',
      });
    }

    if (value.promisedOn !== null && value.promisedAmount === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['promisedAmount'],
        message: 'Say how much the borrower promised.',
      });
    }

    if (value.actionKind !== 'promise' && value.promisedAmount !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['promisedAmount'],
        message: 'Choose "Promise to pay" to record a promised amount.',
      });
    }

    if (value.promisedOn !== null && value.promisedOn < value.actionDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['promisedOn'],
        message: 'The promised date cannot be before the day of the action.',
      });
    }

    if (value.followUpOn !== null && value.followUpOn < value.actionDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['followUpOn'],
        message: 'A follow-up cannot be before the day of the action.',
      });
    }
  });

export type RecordRecoveryActionInput = z.infer<typeof recordRecoveryActionSchema>;

/**
 * Correcting an action that was already recorded.
 *
 * It appends; nothing is edited. The note explains what was wrong, and the
 * register shows both rows — the original marked as corrected, and the
 * correction beneath it.
 */
export const correctRecoveryActionSchema = z.object({
  loanId: uuidSchema,
  correctsActionId: uuidSchema,
  notes: z
    .string({ error: 'Say what was wrong.' })
    .trim()
    .min(3, 'Say what was wrong, in a few words at least.')
    .max(2000, 'The correction must be 2,000 characters or fewer.'),
  actionDate: businessDateSchema,
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The Debt & Security worklist filter. */
export const recoverySearchSchema = z.object({
  query: optionalText(120),
  bucket: z
    .union([
      z.literal(''),
      z.enum(['current', '1_7', '8_30', '31_60', '61_90', '90_plus']),
    ])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  productId: z
    .union([z.literal(''), uuidSchema])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  branchId: z
    .union([z.literal(''), uuidSchema])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  /** Only loans whose follow-up date has passed. */
  followUp: z
    .union([z.literal(''), z.enum(['overdue', 'due_today', 'upcoming', 'untouched'])])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  page: z.coerce.number().int().min(1).max(500).catch(1).default(1),
});

export type RecoverySearchInput = z.infer<typeof recoverySearchSchema>;

/** The guarantor register filter. */
export const guarantorRegisterSearchSchema = z.object({
  query: optionalText(120),
  subjectKind: z
    .union([z.literal(''), z.enum(['client', 'external'])])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  guaranteeStatus: z
    .union([
      z.literal(''),
      z.enum(['proposed', 'unsigned', 'binding', 'released', 'discharged', 'void']),
    ])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  productId: z
    .union([z.literal(''), uuidSchema])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  page: z.coerce.number().int().min(1).max(500).catch(1).default(1),
});

export type GuarantorRegisterSearchInput = z.infer<typeof guarantorRegisterSearchSchema>;

/** Phone validation is re-exported so a recovery form can reuse it. */
export { ugandanPhoneSchema };
