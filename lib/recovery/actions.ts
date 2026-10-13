'use server';

/**
 * Recording the work done against a loan: the security taken, the calls made,
 * the promises given, and the decision to let a guarantor out.
 *
 * Every function performs the same five checks in order — a session exists,
 * the account is active, the capability is held, the input validates, and the
 * target is authorised, the last by running as the caller so Row Level
 * Security and the table guards decide.
 *
 * ## What is deliberately absent
 *
 * There is no `updateRecoveryActionAction` and no `deleteRecoveryActionAction`.
 * `loan_recovery_actions` refuses every UPDATE and DELETE with a
 * statement-level trigger, the way `audit_log` and `client_remarks` do, so an
 * action that offered to edit one would be an action that could only ever
 * fail. A mistake is corrected by appending a correction, which leaves both
 * the original and the correction visible — the whole point of a file somebody
 * will later be asked to justify.
 *
 * ## Realising security does not move money
 *
 * `realiseCollateralAction` records that an item was sold and what it fetched.
 * The proceeds reach the books as a payment through `post_payment`, like every
 * other shilling, because a realisation is money arriving and money arriving
 * is a receipt against a loan. Nothing here touches a balance, a schedule or a
 * journal, and the action says so to the person using it.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  correctRecoveryActionSchema,
  realiseCollateralSchema,
  recordCollateralSchema,
  recordRecoveryActionSchema,
  releaseCollateralSchema,
  releaseGuarantorSchema,
  removeCollateralSchema,
  updateCollateralSchema,
} from '@/lib/validation/security';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Turn a database error into something a person can act on.
 *
 * `P0001` is passed through unchanged, because the guards raise messages
 * written for exactly this purpose: "What this item is and what it was valued
 * at cannot be changed on an active loan" is more useful than anything this
 * layer could invent from an error code.
 */
function friendly(error: { code?: string; message?: string }): string {
  if (error.code === 'P0001' && typeof error.message === 'string') {
    return error.message;
  }

  if (error.code === '42501') {
    return 'You do not have permission to do that.';
  }

  return toPublicError(mapDatabaseError(error, 'loan')).message;
}

function revalidateLoan(loanId: string): void {
  revalidatePath(`${ROUTES.loans}/${loanId}`);
  revalidatePath(`${ROUTES.loans}/${loanId}/application`);
  revalidatePath(ROUTES.recovery);
  revalidatePath(ROUTES.overdue);
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/** Record an item pledged against a loan. */
export async function recordCollateralAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('collateral:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('security.collateral', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordCollateralSchema, {
    loanId: formData.get('loanId'),
    itemType: formData.get('itemType'),
    description: formData.get('description'),
    estimatedValue: formData.get('estimatedValue'),
    valuedOn: formData.get('valuedOn'),
    serialNumber: formData.get('serialNumber'),
    ownershipDocument: formData.get('ownershipDocument'),
    location: formData.get('location'),
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

  const { error } = await supabase.from('loan_collateral').insert({
    loan_id: input.loanId,
    item_type: input.itemType,
    description: input.description,
    estimated_value: input.estimatedValue,
    valued_on: input.valuedOn,
    serial_number: input.serialNumber,
    ownership_document: input.ownershipDocument,
    location: input.location,
  });

  if (error !== null) {
    logger.warn('Could not record security against a loan.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The item has been recorded as security.' };
}

/**
 * Correct an item while the application is still being assembled.
 *
 * The guard refuses this once the loan is live — the identity of the item is
 * what the business agreed to lend against — so this action does not re-state
 * that rule, it just passes the refusal on in words.
 */
export async function updateCollateralAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('collateral:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('security.collateral', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(updateCollateralSchema, {
    collateralId: formData.get('collateralId'),
    itemType: formData.get('itemType'),
    description: formData.get('description'),
    estimatedValue: formData.get('estimatedValue'),
    valuedOn: formData.get('valuedOn'),
    serialNumber: formData.get('serialNumber'),
    ownershipDocument: formData.get('ownershipDocument'),
    location: formData.get('location'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  // `FormData.get` can return a `File`, which stringifies to "[object
  // Object]". Only a string is a loan id, and anything else is a payload that
  // was not sent by this form.
  const rawLoanId = formData.get('loanId');
  const loanId = typeof rawLoanId === 'string' ? rawLoanId : '';
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('loan_collateral')
    .update({
      item_type: input.itemType,
      description: input.description,
      estimated_value: input.estimatedValue,
      valued_on: input.valuedOn,
      serial_number: input.serialNumber,
      ownership_document: input.ownershipDocument,
      location: input.location,
    })
    .eq('id', input.collateralId);

  if (error !== null) {
    logger.warn('Could not update security on a loan.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  if (loanId !== '') revalidateLoan(loanId);

  return { ok: true, message: 'The item has been updated.' };
}

/** Strike an item off an application that has not been disbursed. */
export async function removeCollateralAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('collateral:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(removeCollateralSchema, {
    collateralId: formData.get('collateralId'),
    loanId: formData.get('loanId'),
  });

  if (!parsed.success) return { ok: false, message: 'That item was not recognised.' };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('loan_collateral')
    .delete()
    .eq('id', parsed.data.collateralId);

  if (error !== null) {
    logger.warn('Could not remove security from an application.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(parsed.data.loanId);

  return { ok: true, message: 'The item has been removed from the application.' };
}

/** Hand an item back. */
export async function releaseCollateralAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('collateral:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('security.decision', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(releaseCollateralSchema, {
    collateralId: formData.get('collateralId'),
    loanId: formData.get('loanId'),
    releaseReason: formData.get('releaseReason'),
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

  // `released_at` and `released_by` are stamped by the guard, not sent: a
  // release attributed to somebody else, or dated to a day it did not happen,
  // is worse than no record.
  const { error } = await supabase
    .from('loan_collateral')
    .update({ status: 'released', release_reason: input.releaseReason })
    .eq('id', input.collateralId);

  if (error !== null) {
    logger.warn('Could not release security.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The item has been released to the borrower.' };
}

/**
 * Record that an item was sold to recover the debt.
 *
 * This records the sale. It does **not** reduce the loan: the proceeds are
 * banked through the payment screen like every other shilling, and the message
 * says so, because a staff member who thinks the balance has moved will not
 * post the receipt.
 */
export async function realiseCollateralAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('collateral:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('security.decision', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(realiseCollateralSchema, {
    collateralId: formData.get('collateralId'),
    loanId: formData.get('loanId'),
    realisedAmount: formData.get('realisedAmount'),
    releaseReason: formData.get('releaseReason'),
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

  const { error } = await supabase
    .from('loan_collateral')
    .update({
      status: 'realised',
      realised_amount: input.realisedAmount,
      release_reason: input.releaseReason,
    })
    .eq('id', input.collateralId);

  if (error !== null) {
    logger.warn('Could not realise security.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return {
    ok: true,
    message:
      'The sale has been recorded. Post the proceeds as a payment to reduce the loan.',
  };
}

// ---------------------------------------------------------------------------
// Guarantees
// ---------------------------------------------------------------------------

/**
 * Let a guarantor out of a live loan.
 *
 * Through `release_loan_guarantor`, which holds the two rules this layer must
 * not duplicate: the capability, and that the loan keeps the number of
 * guarantors its product requires. A TypeScript copy of the second would be a
 * second thing to keep in step with the product settings.
 */
export async function releaseGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('guarantors:release');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('security.decision', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(releaseGuarantorSchema, {
    loanGuarantorId: formData.get('loanGuarantorId'),
    loanId: formData.get('loanId'),
    releaseReason: formData.get('releaseReason'),
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

  const { error } = await supabase.rpc('release_loan_guarantor', {
    p_loan_guarantor_id: input.loanGuarantorId,
    p_reason: input.releaseReason,
  });

  if (error !== null) {
    logger.warn('Could not release a guarantor.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);
  revalidatePath(ROUTES.guarantorRegister);

  return {
    ok: true,
    message: 'The guarantor has been released, with the reason on file.',
  };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/** Record a call, a visit, a notice, a note or a promise to pay. */
export async function recordRecoveryActionAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('recovery:record');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('recovery.record', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordRecoveryActionSchema, {
    loanId: formData.get('loanId'),
    actionKind: formData.get('actionKind'),
    outcome: formData.get('outcome'),
    notes: formData.get('notes'),
    actionDate: formData.get('actionDate'),
    followUpOn: formData.get('followUpOn'),
    promisedAmount: formData.get('promisedAmount'),
    promisedOn: formData.get('promisedOn'),
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

  // `created_by` and `created_by_label` are derived by the trigger. An action
  // attributed to somebody who did not make the call is the one thing a
  // recovery file must never contain.
  const { error } = await supabase.from('loan_recovery_actions').insert({
    loan_id: input.loanId,
    action_kind: input.actionKind,
    outcome: input.outcome,
    notes: input.notes,
    action_date: input.actionDate,
    follow_up_on: input.followUpOn,
    promised_amount: input.promisedAmount,
    promised_on: input.promisedOn,
  });

  if (error !== null) {
    logger.warn('Could not record a recovery action.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return {
    ok: true,
    message:
      input.actionKind === 'promise'
        ? 'The promise has been recorded. Whether it is kept is read from the payments.'
        : 'The action has been recorded.',
  };
}

/**
 * Append a correction to an action recorded in error.
 *
 * Nothing is edited. The register shows the original marked as corrected, with
 * the correction beneath it — which is what an append-only file is for.
 */
export async function correctRecoveryActionAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actor;
  try {
    actor = await requirePermission('recovery:record');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('recovery.record', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(correctRecoveryActionSchema, {
    loanId: formData.get('loanId'),
    correctsActionId: formData.get('correctsActionId'),
    notes: formData.get('notes'),
    actionDate: formData.get('actionDate'),
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

  const { error } = await supabase.from('loan_recovery_actions').insert({
    loan_id: input.loanId,
    action_kind: 'correction',
    notes: input.notes,
    action_date: input.actionDate,
    corrects_action_id: input.correctsActionId,
  });

  if (error !== null) {
    logger.warn('Could not record a recovery correction.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The correction has been appended.' };
}
