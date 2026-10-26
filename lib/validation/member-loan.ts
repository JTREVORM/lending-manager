/**
 * Validation for member-loan input.
 *
 * ## What this layer decides, and what it must not
 *
 * Shape: that an amount is a positive whole number of shillings, that a term
 * is a whole number of months, that a cadence is one the business offers.
 *
 * Not eligibility. Whether this member has served six qualifying months,
 * whether the amount fits their ceiling, whether the cadence suits the term
 * and whether member lending is open at all are decided inside
 * `validate_loan_for_approval` from the loan's **own** figures, at the moment
 * the business decides. A check here would be stale by then — another deposit,
 * a withdrawal, a suspension, a policy published — and a stale check that
 * passes is worse than none.
 *
 * So: shape here, eligibility there, and eligibility re-evaluated at approval
 * rather than carried forward from when the form was filled in.
 *
 * ## Nothing below accepts a verdict, a ceiling or a membership
 *
 * There is no field for `is_eligible`, for `max_eligible_loan`, for
 * `membership_id`, for `interest_basis`, for `interest_method` or for a rate.
 * A caller that could send a verdict could approve an unqualified member by
 * typing `true`; one that could send a membership could lend against somebody
 * else's savings; one that could send a rate could price a member loan at
 * nothing. Each is derived by the database — the membership from the client,
 * the terms from that member's own frozen policy version.
 *
 * Every schema here runs on the server. The browser's copy of any of it can be
 * skipped by anyone posting directly, so none of it is the control: Row Level
 * Security, the column guards and `approve_loan` are.
 */

import { z } from 'zod';

import { REPAYMENT_FREQUENCY_DEFAULTS } from '@/config/defaults';
import { ugxAmountFromText, uuidSchema } from '@/lib/validation/common';

/**
 * A cadence key the business has configured.
 *
 * Drawn from the application constants rather than written out, so a cadence
 * the business adds or retires does not need a second edit here. Membership of
 * the list is shape; whether the cadence is *active*, and whether it is the one
 * this term requires, are decided by the database.
 */
export const memberLoanCadenceSchema = z.enum(
  REPAYMENT_FREQUENCY_DEFAULTS.map((entry) => entry.key) as [string, ...string[]],
  { error: 'Select a collection cadence the business offers.' },
);

/**
 * The longest term this form will submit.
 *
 * A sanity bound, not the commercial limit: the real ceiling is
 * `member_loan_max_term_months` on the borrower's own policy version, which
 * `validate_loan_for_approval` enforces. This stops a corrupted field asking
 * for a thousand months.
 */
const MAX_SUBMITTABLE_TERM_MONTHS = 120;

export const memberLoanApplicationSchema = z.object({
  clientId: uuidSchema,

  amount: ugxAmountFromText({
    empty: 'Enter the amount the member is applying for.',
    malformed: 'Enter a whole number of shillings, with no decimal point.',
    nonPositive: 'A loan must be for more than zero shillings.',
  }),

  termMonths: z.coerce
    .number({ error: 'Enter the loan term in whole months.' })
    .int('A loan term is a whole number of months.')
    .min(1, 'A loan runs for at least one month.')
    .max(
      MAX_SUBMITTABLE_TERM_MONTHS,
      `A loan term beyond ${String(MAX_SUBMITTABLE_TERM_MONTHS)} months is not supported.`,
    ),

  repaymentFrequency: memberLoanCadenceSchema,

  /**
   * The day the money is proposed to reach the member.
   *
   * A plan, and the schedule is never anchored on it: `generate_loan_schedule`
   * reads `loans.disbursed_at`, the moment the borrower actually took
   * possession. Carried here because the loans table requires it and because a
   * counter needs to tell the member when to come back.
   */
  proposedDisbursementDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date as YYYY-MM-DD.'),

  purpose: z
    .string()
    .trim()
    .max(500, 'Keep the purpose under 500 characters.')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
});

export type MemberLoanApplicationInput = z.output<typeof memberLoanApplicationSchema>;

/**
 * The preview request.
 *
 * Separate from the application because a preview is read-only and is asked
 * for while the form is still being filled in — so it accepts a term and an
 * amount that may not be submittable yet, and says why rather than refusing.
 */
export const memberLoanPreviewSchema = z.object({
  clientId: uuidSchema,
  amount: ugxAmountFromText({
    empty: 'Enter an amount to preview.',
    malformed: 'Enter a whole number of shillings, with no decimal point.',
    nonPositive: 'Enter an amount above zero to preview.',
  }),
  termMonths: z.coerce
    .number({ error: 'Enter the loan term in whole months.' })
    .int()
    .min(1)
    .max(MAX_SUBMITTABLE_TERM_MONTHS),
});

/** The eligibility register's filters. A malformed one falls back to the default. */
export const memberEligibilitySearchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  qualified: z.enum(['all', 'qualified', 'not_qualified']).default('all').optional(),
  sort: z.enum(['savings', 'name', 'months']).default('savings').optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1).optional(),
});

/** The member loan register's filters. */
export const memberLoanSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value)),
  status: z
    .enum([
      'all',
      'draft',
      'pending_approval',
      'approved',
      'active',
      'cleared',
      'cancelled',
    ])
    .default('all')
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1).optional(),
});
