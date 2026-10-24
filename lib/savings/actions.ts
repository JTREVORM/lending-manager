'use server';

/**
 * Savings deposits, withdrawals and reversals, as trusted server-side
 * operations.
 *
 * Every function here performs the same checks in the same order: a session
 * exists, the account is active (`current_profile_id()` resolves only active
 * profiles), the capability is held, the input validates — and then the
 * database decides the rest, by running as the caller, so Row Level Security
 * and each posting function's own rules all apply.
 *
 * ## Nothing here computes a balance, and nothing here decides a journal
 *
 * No function in this module works out what an account holds, which ledger
 * accounts a movement touches, or which way round the legs go. The posting
 * functions do, in one transaction, from figures they derive themselves under
 * a row lock — which is the only place a balance check is worth anything,
 * because any check made out here is already stale by the time the money
 * moves.
 *
 * The direction in particular is not the caller's to supply. A deposit credits
 * `2100 Member Savings`, a **liability**: it increases what the business owes
 * its member. An action that could choose the credit leg could credit an
 * income account instead, which looks right on every screen, overstates the
 * year's surplus by the whole savings book, and in Phase 5 pays a profit share
 * out of members' own deposits.
 *
 * ## The split between taking money in and giving it back
 *
 * Four functions, four capabilities, because taking money out is three acts by
 * at least two people. A Secretary records deposits and prepares withdrawals;
 * a Manager decides and pays; only the Owner reverses. And
 * `decide_savings_withdrawal` additionally refuses a decision from whoever
 * prepared the request, so the split holds even for a Manager who holds both
 * capabilities — which is what makes it a control rather than a label on a
 * permissions page.
 *
 * ## Double submission
 *
 * A deposit is not idempotent by state: two genuine UGX 50,000 deposits from
 * one member on one day are ordinary. So every money-moving submission carries
 * a key minted server-side when the form renders, and the posting function
 * returns the transaction that already exists rather than recording the money
 * twice. See ADR-030.
 */

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  cancelWithdrawalSchema,
  decideWithdrawalSchema,
  openSavingsAccountSchema,
  postWithdrawalSchema,
  recordSavingsDepositSchema,
  requestWithdrawalSchema,
  reverseSavingsSchema,
} from '@/lib/validation/savings';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface SavingsActionResult extends ActionResult {
  readonly transactionId?: string;
  readonly requestId?: string;
  readonly savingsAccountId?: string;
}

/**
 * Mint an idempotency key for a savings form.
 *
 * Called when the form is *rendered*, so the key is fixed before the staff
 * member can tap twice and both taps carry it. `node:crypto` rather than the
 * browser's, so the key cannot be chosen by the client — a client-chosen key
 * would let a caller replay somebody else's to read back their transaction.
 */
export async function mintSavingsKey(): Promise<string> {
  return Promise.resolve(randomUUID());
}

const FIELD_ERROR_MESSAGE = 'Please check the highlighted fields.';

// ---------------------------------------------------------------------------
// Opening an account
// ---------------------------------------------------------------------------

/**
 * Open the savings account for a membership that has none.
 *
 * Idempotent by construction rather than by key: a membership has one account,
 * so a second call returns the first. Refused while the savings rules are
 * undecided — which is the activity-specific readiness gate, and the reason
 * enrolment carries on in the meantime.
 */
export async function openSavingsAccountAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  try {
    await requirePermission('savings:deposit');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(openSavingsAccountSchema, {
    membershipId: formData.get('membershipId'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('open_savings_account', {
    p_membership_id: parsed.data.membershipId,
  });

  if (error !== null) {
    logger.warn('A savings account could not be opened.', {
      code: error.code,
      membershipId: parsed.data.membershipId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.savings);
  revalidatePath(`${ROUTES.membership}/${parsed.data.membershipId}`);

  return {
    ok: true,
    message: 'Savings account opened.',
    savingsAccountId: typeof data === 'string' ? data : undefined,
  };
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

/**
 * Record a deposit received from a member.
 *
 * Debits the branch's cash, Mobile Money or bank account and credits
 * `2100 Member Savings`. Several deposits in a month accumulate towards that
 * month's minimum — `member_savings_contributions` sums them — so there is no
 * "monthly contribution" concept here to get out of step with the subledger.
 */
export async function recordSavingsDepositAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:deposit');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  // A brake on volume, not the protection against a double tap — that is the
  // idempotency key, minted when the form renders and re-presented on every
  // retry. Sixty a minute is faster than any counter runs.
  const limit = await checkActorRateLimit('savings.deposit', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordSavingsDepositSchema, {
    savingsAccountId: formData.get('savingsAccountId'),
    amount: formData.get('amount'),
    paymentMethod: formData.get('paymentMethod'),
    externalReference: formData.get('externalReference'),
    idempotencyKey: formData.get('idempotencyKey'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('post_savings_deposit', {
    p_savings_account_id: input.savingsAccountId,
    p_amount: input.amount,
    p_payment_method: input.paymentMethod,
    p_external_reference: input.externalReference ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_notes: input.notes ?? null,
  });

  if (error !== null) {
    // The amount is deliberately not logged: a failed posting is an
    // operational event, and the figures belong on the ledger rather than in
    // application logs.
    logger.warn('A savings deposit could not be recorded.', {
      code: error.code,
      savingsAccountId: input.savingsAccountId,
      method: input.paymentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  const transactionId = typeof data === 'string' ? data : null;

  if (transactionId === null) {
    return {
      ok: false,
      message: 'The deposit was not recorded. Try again, or report this.',
    };
  }

  revalidatePath(ROUTES.savings);
  revalidatePath(`${ROUTES.savings}/${input.savingsAccountId}`);
  revalidatePath(ROUTES.portal);

  return {
    ok: true,
    message: 'Deposit recorded.',
    transactionId,
    savingsAccountId: input.savingsAccountId,
  };
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

/**
 * Prepare a withdrawal for review.
 *
 * Decides nothing. `request_savings_withdrawal` checks the account, the
 * membership, the balance and the policy's rule about live loans — and under
 * `above_pledged` it refuses outright rather than inventing a pledged amount,
 * because "the excess over what secures the loan" needs a definition the
 * client's documents do not give.
 */
export async function requestWithdrawalAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:request_withdrawal');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('savings.withdrawal', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(requestWithdrawalSchema, {
    savingsAccountId: formData.get('savingsAccountId'),
    amount: formData.get('amount'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('request_savings_withdrawal', {
    p_savings_account_id: input.savingsAccountId,
    p_amount: input.amount,
    p_reason: input.reason,
  });

  if (error !== null) {
    logger.warn('A withdrawal could not be prepared.', {
      code: error.code,
      savingsAccountId: input.savingsAccountId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.savingsWithdrawals);
  revalidatePath(`${ROUTES.savings}/${input.savingsAccountId}`);

  return {
    ok: true,
    message: 'Withdrawal prepared. It now needs a decision from somebody else.',
    requestId: typeof data === 'string' ? data : undefined,
    savingsAccountId: input.savingsAccountId,
  };
}

/**
 * Approve or reject a prepared withdrawal.
 *
 * `decide_savings_withdrawal` refuses a decision from the person who prepared
 * it. That check cannot be made here: this layer does not know who prepared
 * the request without a read, and a read made now would be stale by the time
 * the decision landed. It belongs with the row lock, and that is where it is.
 */
export async function decideWithdrawalAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:approve_withdrawal');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('savings.withdrawal_decision', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(decideWithdrawalSchema, {
    requestId: formData.get('requestId'),
    // A checkbox absent from the body means "not approved", which is what an
    // unticked box means in HTML. `z.coerce.boolean()` on the string 'false'
    // would be `true`, so the comparison is made here rather than there.
    approve: formData.get('approve') === 'true',
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('decide_savings_withdrawal', {
    p_request_id: input.requestId,
    p_approve: input.approve,
    p_notes: input.notes ?? null,
  });

  if (error !== null) {
    logger.warn('A withdrawal could not be decided.', {
      code: error.code,
      requestId: input.requestId,
      approve: input.approve,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.savingsWithdrawals);
  revalidatePath(ROUTES.savings);

  return {
    ok: true,
    message: input.approve
      ? 'Withdrawal approved. It is not paid until somebody records the payment.'
      : 'Withdrawal rejected.',
    requestId: input.requestId,
  };
}

/**
 * Pay an approved withdrawal.
 *
 * Debits `2100 Member Savings` — the liability falls — and credits the
 * branch's cash, Mobile Money or bank account. The balance is re-checked
 * inside the function under the account's row lock, so a deposit reversed
 * between the decision and the counter stops the payment rather than taking
 * the account negative.
 */
export async function postWithdrawalAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:post_withdrawal');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('savings.withdrawal', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(postWithdrawalSchema, {
    requestId: formData.get('requestId'),
    paymentMethod: formData.get('paymentMethod'),
    externalReference: formData.get('externalReference'),
    idempotencyKey: formData.get('idempotencyKey'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('post_savings_withdrawal', {
    p_request_id: input.requestId,
    p_payment_method: input.paymentMethod,
    p_external_reference: input.externalReference ?? null,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error !== null) {
    logger.warn('A withdrawal could not be paid.', {
      code: error.code,
      requestId: input.requestId,
      method: input.paymentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.savingsWithdrawals);
  revalidatePath(ROUTES.savings);
  revalidatePath(ROUTES.portal);

  return {
    ok: true,
    message: 'Withdrawal paid.',
    transactionId: typeof data === 'string' ? data : undefined,
    requestId: input.requestId,
  };
}

/**
 * Cancel a withdrawal that has not been paid.
 *
 * Rides on `savings:request_withdrawal` rather than on the approval
 * capability: cancelling is withdrawing a request, which is the same kind of
 * act as making one. Nothing moves — a cancelled request has no journal
 * because no money ever left.
 */
export async function cancelWithdrawalAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:request_withdrawal');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('savings.withdrawal', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(cancelWithdrawalSchema, {
    requestId: formData.get('requestId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { requestId, reason } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('cancel_savings_withdrawal', {
    p_request_id: requestId,
    p_reason: reason,
  });

  if (error !== null) {
    logger.warn('A withdrawal could not be cancelled.', {
      code: error.code,
      requestId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.savingsWithdrawals);
  revalidatePath(ROUTES.savings);

  return { ok: true, message: 'Withdrawal cancelled.', requestId };
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

/**
 * Reverse a posted deposit or withdrawal.
 *
 * `savings:reverse` is the Owner's alone, for the reason `payments:reverse`
 * is: the person who records money must not be the person who can withdraw
 * the record.
 *
 * The original transaction is not edited and not deleted. A contra row is
 * appended with its own contra journal, and every balance follows because the
 * balance is the sum of the subledger. So a statement printed last week still
 * agrees with the ledger, and the correction is visible as a correction rather
 * than as a figure that quietly changed.
 */
export async function reverseSavingsTransactionAction(
  _previous: SavingsActionResult | undefined,
  formData: FormData,
): Promise<SavingsActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:reverse');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('savings.reverse', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(reverseSavingsSchema, {
    transactionId: formData.get('transactionId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { transactionId, reason } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('reverse_savings_transaction', {
    p_transaction_id: transactionId,
    p_reason: reason,
  });

  if (error !== null) {
    logger.warn('A savings transaction could not be reversed.', {
      code: error.code,
      transactionId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.savings);
  revalidatePath(ROUTES.portal);

  return {
    ok: true,
    message: 'Transaction reversed. The balance has been restored.',
    transactionId: typeof data === 'string' ? data : undefined,
  };
}
