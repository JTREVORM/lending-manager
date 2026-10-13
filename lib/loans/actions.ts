'use server';

/**
 * The loan lifecycle, as trusted server-side operations.
 *
 * Every function performs the five checks in order: a session exists, the
 * account is active (`current_profile_id()` resolves only active profiles),
 * the capability is held, the input validates, and the target is authorised —
 * the last by running as the caller, so Row Level Security and the state
 * machine decide.
 *
 * ## Nothing here computes money
 *
 * No function in this module calculates interest, a total, or a breakdown.
 * The database does, in `approve_loan`. These actions pass identifiers and
 * read results back.
 *
 * That is the whole reason the approval function takes only a loan id. An
 * approver who could supply the figures could approve a loan at zero
 * interest, and `loans:approve` is held by the Manager — so the figures are
 * not the caller's to supply.
 *
 * ## Double submission
 *
 * Every lifecycle operation is idempotent by *state* rather than by a token.
 * `approve_loan` locks the row and refuses a loan that is not awaiting
 * approval; `disburse_loan` refuses one that is not approved; `cancel_loan`
 * refuses one already cancelled. So a double tap produces a clear "this loan
 * is already approved" rather than two approvals or two audit events. A
 * nonce-based guard would add a table and a cleanup job to achieve what the
 * state machine already gives for free.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  approveLoanSchema,
  cancelLoanSchema,
  createLoanSchema,
  disburseLoanSchema,
  returnLoanSchema,
  submitLoanSchema,
  updateLoanDraftSchema,
} from '@/lib/validation/loan';
import { rejectLoanSchema } from '@/lib/validation/loan-application';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface LoanActionResult extends ActionResult {
  readonly loanId?: string;
}

/**
 * Start a loan draft.
 *
 * The draft carries the *shape* of the proposed loan — client, amount, term,
 * rhythm, intended date — and no price. The rate, the method and the totals
 * are set at approval from the settings in force then, which is why the
 * insert below writes placeholder policy values that approval overwrites.
 *
 * Those placeholders are the current settings, read server-side. They are not
 * trusted as the agreed terms; they exist because the columns are NOT NULL and
 * a draft has to be savable. Approval replaces every one of them.
 */
export async function createLoanAction(
  _previous: LoanActionResult | undefined,
  formData: FormData,
): Promise<LoanActionResult> {
  try {
    await requirePermission('loans:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(createLoanSchema, {
    clientId: formData.get('clientId'),
    loanProductId: formData.get('loanProductId'),
    principalAmount: formData.get('principalAmount'),
    loanTermMonths: formData.get('loanTermMonths'),
    repaymentFrequency: formData.get('repaymentFrequency'),
    proposedInterestRateBps: formData.get('proposedInterestRateBps'),
    proposedDisbursementDate: formData.get('proposedDisbursementDate'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // Read authoritatively, server-side. Never from the submitted form.
  const { data: settings, error: settingsError } = await supabase
    .from('business_settings')
    .select(
      'default_monthly_interest_rate_bps, default_interest_method, min_loan_amount, max_loan_amount, grace_period_days, penalty_rate_bps, min_loan_term_months, max_loan_term_months, multi_month_min_amount',
    )
    .eq('id', 1)
    .maybeSingle();

  if (settingsError !== null || settings === null) {
    logger.error('Business settings are unavailable; cannot start a loan.', {
      code: settingsError?.code,
    });
    return {
      ok: false,
      message: 'Lending settings could not be read. Contact your administrator.',
    };
  }

  // Checked here so the person entering the loan is told immediately, rather
  // than discovering it at approval. The database checks all of this again at
  // approval, which is the check that counts — settings may change in between.
  if (input.principalAmount < settings.min_loan_amount) {
    return {
      ok: false,
      message: `The minimum loan is UGX ${settings.min_loan_amount.toLocaleString('en-UG')}.`,
      fieldErrors: { principalAmount: ['Below the current minimum.'] },
    };
  }

  if (
    settings.max_loan_amount !== null &&
    input.principalAmount > settings.max_loan_amount
  ) {
    return {
      ok: false,
      message: `The maximum loan is UGX ${settings.max_loan_amount.toLocaleString('en-UG')}.`,
      fieldErrors: { principalAmount: ['Above the current maximum.'] },
    };
  }

  if (
    input.loanTermMonths > 1 &&
    input.principalAmount < settings.multi_month_min_amount
  ) {
    return {
      ok: false,
      message: `A loan of more than one month requires at least UGX ${settings.multi_month_min_amount.toLocaleString('en-UG')}.`,
      fieldErrors: { loanTermMonths: ['Not available at this amount.'] },
    };
  }

  if (
    input.loanTermMonths < settings.min_loan_term_months ||
    input.loanTermMonths > settings.max_loan_term_months
  ) {
    return {
      ok: false,
      message: `Loan periods currently run from ${String(settings.min_loan_term_months)} to ${String(settings.max_loan_term_months)} months.`,
      fieldErrors: { loanTermMonths: ['Not a permitted period.'] },
    };
  }

  // `loan_number` is absent: the trigger mints it and refuses a supplied
  // value. So is `status`, which defaults to draft — and the insert policy
  // would refuse anything else.
  const { data: created, error: insertError } = await supabase
    .from('loans')
    .insert({
      client_id: input.clientId,
      loan_product_id: input.loanProductId,
      principal_amount: input.principalAmount,
      loan_term_months: input.loanTermMonths,
      repayment_frequency: input.repaymentFrequency,
      proposed_interest_rate_bps: input.proposedInterestRateBps,
      proposed_disbursement_date: input.proposedDisbursementDate,
      notes: input.notes,
      // Placeholders, overwritten at approval. See the note above.
      interest_rate_bps: settings.default_monthly_interest_rate_bps,
      interest_method: settings.default_interest_method,
      min_loan_amount_applied: settings.min_loan_amount,
      max_loan_amount_applied: settings.max_loan_amount,
      grace_period_days_applied: settings.grace_period_days,
      penalty_rate_bps_applied: settings.penalty_rate_bps,
    })
    .select('id, loan_number')
    .single();

  if (insertError !== null) {
    logger.warn('Could not start a loan.', { code: insertError.code });
    return { ok: false, message: friendlyLoanError(insertError) };
  }

  revalidatePath(ROUTES.loans);

  return {
    ok: true,
    loanId: created.id,
    message: `Loan ${created.loan_number} has been started as a draft.`,
  };
}

/** Start a loan and go to it. */
export async function createLoanAndRedirect(
  previous: LoanActionResult | undefined,
  formData: FormData,
): Promise<LoanActionResult> {
  const result = await createLoanAction(previous, formData);

  if (result.ok && result.loanId !== undefined) {
    redirect(`${ROUTES.loans}/${result.loanId}`);
  }

  return result;
}

/** Change a draft. Refused once the loan has left draft, by the state machine. */
export async function updateLoanDraftAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:update_draft');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(updateLoanDraftSchema, {
    loanId: formData.get('loanId'),
    clientId: formData.get('clientId'),
    loanProductId: formData.get('loanProductId'),
    principalAmount: formData.get('principalAmount'),
    loanTermMonths: formData.get('loanTermMonths'),
    repaymentFrequency: formData.get('repaymentFrequency'),
    proposedInterestRateBps: formData.get('proposedInterestRateBps'),
    proposedDisbursementDate: formData.get('proposedDisbursementDate'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // An explicit column list. No status, no attribution, no totals — each has
  // its own operation, and the guard trigger would refuse them here anyway.
  const { error } = await supabase
    .from('loans')
    .update({
      client_id: input.clientId,
      loan_product_id: input.loanProductId,
      principal_amount: input.principalAmount,
      loan_term_months: input.loanTermMonths,
      repayment_frequency: input.repaymentFrequency,
      proposed_interest_rate_bps: input.proposedInterestRateBps,
      proposed_disbursement_date: input.proposedDisbursementDate,
      notes: input.notes,
    })
    .eq('id', input.loanId);

  if (error !== null) {
    logger.warn('Could not update a loan draft.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${input.loanId}`);
  revalidatePath(ROUTES.loans);

  return { ok: true, message: 'The draft has been updated.' };
}

/** Submit a draft for a decision. */
export async function submitLoanAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:submit');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(submitLoanSchema, { loanId: formData.get('loanId') });

  if (!parsed.success) return { ok: false, message: 'That loan was not recognised.' };

  const supabase = await createSupabaseServerClient();

  // `submitted_at` and `submitted_by` are absent: the transition trigger
  // stamps both from the session, so a submission cannot be attributed to
  // somebody else. The state machine refuses this unless the loan is a draft,
  // which makes a double tap a clear refusal rather than a second submission.
  const { error } = await supabase
    .from('loans')
    .update({ status: 'pending_approval', review_note: null })
    .eq('id', parsed.data.loanId);

  if (error !== null) {
    logger.warn('Could not submit a loan.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${parsed.data.loanId}`);
  revalidatePath(ROUTES.loans);

  return { ok: true, message: 'The loan has been submitted for approval.' };
}

/**
 * Approve a loan.
 *
 * Delegates entirely to `public.approve_loan`, which revalidates every rule
 * against current settings, computes the authoritative breakdown, captures
 * every snapshot and freezes the terms — in one transaction. Either all of it
 * or none: there is no partially approved loan.
 */
export async function approveLoanAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('loans:approve');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  // A decision, not throughput. The database still refuses a second
  // transition on the same loan; this is the brake on a script walking the
  // whole book.
  const limit = await checkActorRateLimit('loans.approve', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(approveLoanSchema, { loanId: formData.get('loanId') });

  if (!parsed.success) return { ok: false, message: 'That loan was not recognised.' };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('approve_loan', {
    p_loan_id: parsed.data.loanId,
  });

  if (error !== null) {
    logger.warn('Could not approve a loan.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${parsed.data.loanId}`);
  revalidatePath(ROUTES.loans);

  return {
    ok: true,
    message: 'The loan has been approved. The money has not been released yet.',
  };
}

/** Return a submitted loan to draft, with a note saying what to change. */
export async function returnLoanToDraftAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:approve');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(returnLoanSchema, {
    loanId: formData.get('loanId'),
    reviewNote: formData.get('reviewNote'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Say what needs changing.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('loans')
    .update({ status: 'draft', review_note: parsed.data.reviewNote })
    .eq('id', parsed.data.loanId);

  if (error !== null) {
    logger.warn('Could not return a loan to draft.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${parsed.data.loanId}`);
  revalidatePath(ROUTES.loans);

  return { ok: true, message: 'The loan has been returned for correction.' };
}

/**
 * Release the money and activate the loan.
 *
 * The one-active-loan rule is enforced by a trigger on `loans` under an
 * advisory lock, so two concurrent disbursements for the same client cannot
 * both succeed — whichever arrives second is refused with the limit named.
 */
export async function disburseLoanAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('loans:disburse');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  // A decision, not throughput. The database still refuses a second
  // transition on the same loan; this is the brake on a script walking the
  // whole book.
  const limit = await checkActorRateLimit('loans.disburse', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(disburseLoanSchema, { loanId: formData.get('loanId') });

  if (!parsed.success) return { ok: false, message: 'That loan was not recognised.' };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('disburse_loan', {
    p_loan_id: parsed.data.loanId,
  });

  if (error !== null) {
    logger.warn('Could not disburse a loan.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${parsed.data.loanId}`);
  revalidatePath(ROUTES.loans);

  return { ok: true, message: 'The loan is now active.' };
}

/**
 * Refuse an application.
 *
 * Separate from `cancelLoanAction` rather than a flag on it, for the reason
 * `reject_loan` is separate from `cancel_loan`: the two are different
 * decisions with different preconditions and different capabilities. A
 * refusal can only happen to an application awaiting a decision and belongs to
 * whoever may approve one; a cancellation can also take back a loan already
 * approved and belongs to the Owner.
 *
 * Both end as `status = 'cancelled'` with `closure_kind` saying which, so the
 * register can separate a credit decision from a change of mind — and a
 * report about lending standards counts only the first.
 */
export async function rejectLoanAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('loans:approve');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  // A decision, not throughput — the same brake the approval carries, for the
  // same reason: the database still refuses a second transition on the same
  // loan, and this is what stops a script walking the whole book.
  const limit = await checkActorRateLimit('loans.approve', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(rejectLoanSchema, {
    loanId: formData.get('loanId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Say why this application is being refused.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('reject_loan', {
    p_loan_id: parsed.data.loanId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('Could not reject a loan application.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${parsed.data.loanId}`);
  revalidatePath(ROUTES.loans);

  return {
    ok: true,
    message: 'The application has been refused. The reason is recorded against it.',
  };
}

/** Cancel a loan before the money moves. */
export async function cancelLoanAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:cancel');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(cancelLoanSchema, {
    loanId: formData.get('loanId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Say why this loan is being cancelled.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('cancel_loan', {
    p_loan_id: parsed.data.loanId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('Could not cancel a loan.', { code: error.code });
    return { ok: false, message: friendlyLoanError(error) };
  }

  revalidatePath(`${ROUTES.loans}/${parsed.data.loanId}`);
  revalidatePath(ROUTES.loans);

  return { ok: true, message: 'The loan has been cancelled.' };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Turn a database error into something a person can act on.
 *
 * The guards, constraints and lifecycle functions raise messages written for
 * exactly this purpose, so `P0001` is passed through — "this client already
 * has 1 active loan(s); the limit is 1" is more useful than anything this
 * layer could invent. Everything else goes through `mapDatabaseError`, which
 * never exposes SQL or a constraint name.
 */
function friendlyLoanError(error: { code?: string; message?: string }): string {
  if (error.code === 'P0001' && typeof error.message === 'string') {
    return error.message;
  }

  if (error.code === '42501') {
    return 'You do not have permission to do that.';
  }

  return toPublicError(mapDatabaseError(error, 'loan')).message;
}
