/**
 * Validation for loan input.
 *
 * ## What this layer does and does not decide
 *
 * These schemas check *shape*: that an amount is a positive whole number of
 * shillings, that a term is an integer, that a client identifier looks like
 * one. They deliberately do **not** check the commercial rules — the minimum
 * amount, the permitted terms, the multi-month threshold, the guarantor
 * count.
 *
 * Those live in `public.validate_loan_for_approval`, in the database, for two
 * reasons. They depend on settings that can change between a draft being
 * entered and it being approved, so a check at entry time would be stale. And
 * they must hold against a caller who bypasses this layer entirely, which
 * anybody with a token can do.
 *
 * So: shape here, policy there, and the policy is re-evaluated at the moment
 * of approval rather than carried forward from when the form was filled in.
 *
 * ## No totals are ever accepted from the browser
 *
 * There is no field for `totalInterest` or `totalExpectedRepayment` in any
 * schema below. The figures shown while entering a loan are a preview; the
 * ones that count are computed by the database at approval. A schema that
 * accepted a total would imply the browser's arithmetic mattered.
 */

import { z } from 'zod';

import { MAX_SUPPORTED_TERM_MONTHS } from '@/lib/domain/loan';
import { MAX_UGX_AMOUNT } from '@/lib/domain/money';
import { uuidSchema } from './common';

/**
 * A loan principal, in whole shillings.
 *
 * Fractional input is **rejected rather than rounded**. Someone typing
 * `100000.50` has either mistyped or is thinking in a currency that is not
 * UGX, and quietly turning it into `100001` would hide which.
 */
export const loanPrincipalSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const text = typeof value === 'number' ? String(value) : value.trim();

    if (text === '') {
      ctx.addIssue({ code: 'custom', message: 'Enter the loan amount.' });
      return z.NEVER;
    }

    // Spaces are formatting. Commas are *conditionally* formatting, and that
    // distinction matters more than it looks.
    //
    // Stripping every comma would turn `100000,50` — a decimal comma, which
    // much of the world writes — into 10,000,050 shillings. A hundredfold
    // error, accepted silently, on the single most important number in the
    // system. So a comma is accepted only where a thousands separator
    // belongs: groups of exactly three digits, from the right.
    const spaceless = text.replace(/\s/g, '');

    const grouped = /^\d{1,3}(,\d{3})+$/.test(spaceless);
    const plain = /^\d+$/.test(spaceless);

    if (!grouped && !plain) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Enter a whole number of shillings, for example 600000 or 600,000. Ugandan shillings have no smaller unit.',
      });
      return z.NEVER;
    }

    const cleaned = spaceless.replace(/,/g, '');

    const amount = Number(cleaned);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Enter an amount greater than zero.' });
      return z.NEVER;
    }

    if (amount > MAX_UGX_AMOUNT) {
      ctx.addIssue({ code: 'custom', message: 'That amount is implausibly large.' });
      return z.NEVER;
    }

    return amount;
  });

/**
 * A loan term in whole months.
 *
 * Bounded here only by what the engine can compute. Whether a *particular*
 * term is commercially permitted for a *particular* amount is a settings
 * question, answered at approval.
 */
export const loanTermSchema = z.coerce
  .number({ error: 'Choose a loan period.' })
  .int('A loan period is a whole number of months.')
  .min(1, 'A loan runs for at least one month.')
  .max(
    MAX_SUPPORTED_TERM_MONTHS,
    `A loan period cannot exceed ${String(MAX_SUPPORTED_TERM_MONTHS)} months.`,
  );

/**
 * The repayment rhythm.
 *
 * Validated as a non-empty key rather than against a fixed list: the
 * permitted frequencies are rows in `repayment_frequencies`, which the
 * business can change, and the database checks membership at approval. A
 * hard-coded enum here would silently stop accepting a frequency the business
 * had just added.
 */
export const repaymentFrequencySchema = z
  .string({ error: 'Choose how often the borrower will pay.' })
  .trim()
  .min(1, 'Choose how often the borrower will pay.')
  .max(40);

/**
 * The date the business intends to hand over the money.
 *
 * Not the date Phase 5 will schedule from — that is the actual
 * `disbursed_at`. This is a plan, so a future date is normal and a past one
 * is permitted: a loan entered on Monday for money handed over on Friday, and
 * a loan recorded late, are both ordinary.
 */
export const proposedDisbursementDateSchema = z
  .string({ error: 'Enter the intended disbursement date.' })
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);

      if (Number.isNaN(parsed.getTime())) return false;

      // Read back, because `Date.parse` rolls an impossible day over rather
      // than rejecting it — 2026-02-30 would silently become 2 March.
      const [year, month, day] = value.split('-').map(Number);

      return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() + 1 === month &&
        parsed.getUTCDate() === day
      );
    },
    { message: 'That is not a real date. Check the day and month.' },
  )
  .refine((value) => value >= '2020-01-01', {
    message: 'Check the year.',
  });

const optionalNote = (label: string, max: number) =>
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

/** Starting a loan draft. */
export const createLoanSchema = z.object({
  clientId: uuidSchema,
  principalAmount: loanPrincipalSchema,
  loanTermMonths: loanTermSchema,
  repaymentFrequency: repaymentFrequencySchema,
  proposedDisbursementDate: proposedDisbursementDateSchema,
  notes: optionalNote('Notes', 2000),
});

export type CreateLoanInput = z.infer<typeof createLoanSchema>;

/**
 * Editing a draft.
 *
 * The same fields, because a draft is editable in full. Note the absence of
 * `status`, every attribution column, and both totals: the status moves
 * through its own operations and the figures are the database's.
 */
export const updateLoanDraftSchema = createLoanSchema.safeExtend({
  loanId: uuidSchema,
});

export type UpdateLoanDraftInput = z.infer<typeof updateLoanDraftSchema>;

/** Submitting for a decision. Carries nothing but the loan. */
export const submitLoanSchema = z.object({ loanId: uuidSchema });

/** Approving. Nothing to supply: every figure is computed server-side. */
export const approveLoanSchema = z.object({ loanId: uuidSchema });

/** Returning a draft for correction, with a note saying what to change. */
export const returnLoanSchema = z.object({
  loanId: uuidSchema,
  reviewNote: z
    .string({ error: 'Say what needs changing.' })
    .trim()
    .min(3, 'Say what needs changing, so it can be corrected.')
    .max(500, 'A review note cannot be longer than 500 characters.'),
});

/** Disbursing. Deliberately bare: the loan is confirmed, nothing is entered. */
export const disburseLoanSchema = z.object({ loanId: uuidSchema });

/**
 * Cancelling.
 *
 * The reason is required, and the lower bound is deliberate: "no" is not a
 * reason, and this is a permanent record of a decision not to lend.
 */
export const cancelLoanSchema = z.object({
  loanId: uuidSchema,
  reason: z
    .string({ error: 'Say why this loan is being cancelled.' })
    .trim()
    .min(3, 'Say why. This is recorded against the loan permanently.')
    .max(500, 'A reason cannot be longer than 500 characters.'),
});

/** Filtering the loan register. */
export const loanSearchSchema = z.object({
  query: z
    .union([z.string().trim().max(120), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  status: z
    .union([z.string().trim().max(40), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  clientId: z
    .union([uuidSchema, z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
});

export type LoanSearchInput = z.infer<typeof loanSearchSchema>;

/** The preview request: enough to compute a breakdown, and nothing more. */
export const loanPreviewSchema = z.object({
  principalAmount: loanPrincipalSchema,
  loanTermMonths: loanTermSchema,
});
