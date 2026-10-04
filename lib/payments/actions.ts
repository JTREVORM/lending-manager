'use server';

/**
 * Recording and reversing payments, as trusted server-side operations.
 *
 * Every function performs the same checks in order: a session exists, the
 * account is active (`current_profile_id()` resolves only active profiles),
 * the capability is held, the input validates, and the database decides the
 * rest — by running as the caller, so Row Level Security, the posting
 * function's own rules and the state machine all apply.
 *
 * ## Nothing here allocates money, and nothing here computes a balance
 *
 * No function in this module decides which collections a payment covers, how
 * much of it is principal, or what the loan owes afterwards. `post_payment`
 * does, in one transaction, from figures it derives itself. These actions pass
 * an amount, a method, a reference and an idempotency key.
 *
 * That split is the point. An action that could supply an allocation could
 * credit a borrower's principal while leaving the interest unpaid; one that
 * could supply a balance could print any receipt it liked. Neither is the
 * caller's to supply, and `payments:create` is held by the Secretary.
 *
 * ## Double submission
 *
 * Unlike the loan lifecycle, a payment is **not** idempotent by state: two
 * genuine UGX 4,000 cash payments from one borrower on one day are a normal
 * occurrence, so "this loan already has a payment" cannot be the guard.
 *
 * So every submission carries an idempotency key, minted server-side when the
 * form is rendered and carried as a hidden field. A double tap, a lost
 * response or a replayed form all arrive with the same key, and
 * `post_payment` returns the payment that already exists rather than recording
 * the money twice. See ADR-030.
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
import { recordPaymentSchema, reversePaymentSchema } from '@/lib/validation/payment';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface PaymentActionResult extends ActionResult {
  readonly paymentId?: string;
}

/**
 * Mint an idempotency key for a payment form.
 *
 * Called when the form is *rendered*, not when it is submitted, which is what
 * makes it work: the key is fixed before the staff member can tap twice, so
 * both taps carry it.
 *
 * `node:crypto` rather than the browser's `crypto`, so the key cannot be
 * chosen by the client. A client-chosen key would let a caller replay somebody
 * else's key to read back their payment — a small leak, but a free one to
 * close.
 */
export async function mintIdempotencyKey(): Promise<string> {
  return Promise.resolve(randomUUID());
}

/**
 * Record a payment received from a borrower.
 *
 * Returns the payment id on success, so the caller can show the receipt.
 */
export async function recordPaymentAction(
  _previous: PaymentActionResult | undefined,
  formData: FormData,
): Promise<PaymentActionResult> {
  let actor;
  try {
    actor = await requirePermission('payments:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  // A brake on volume, not the protection against a double tap — that is the
  // idempotency key, which is minted when the form renders and re-presented
  // on every retry. Sixty a minute is faster than any counter runs and far
  // slower than a loop.
  const limit = await checkActorRateLimit('payments.create', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordPaymentSchema, {
    loanId: formData.get('loanId'),
    amount: formData.get('amount'),
    paymentMethod: formData.get('paymentMethod'),
    externalReference: formData.get('externalReference'),
    idempotencyKey: formData.get('idempotencyKey'),
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

  const { data, error } = await supabase.rpc('post_payment', {
    p_loan_id: input.loanId,
    p_amount: input.amount,
    p_payment_method: input.paymentMethod,
    p_external_reference: input.externalReference ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_notes: input.notes ?? null,
  });

  if (error !== null) {
    // The amount is deliberately not logged with the error: a failed posting
    // is an operational event, and the figures belong on the ledger rather
    // than in application logs.
    logger.warn('A payment could not be recorded.', {
      code: error.code,
      loanId: input.loanId,
      method: input.paymentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  const paymentId = typeof data === 'string' ? data : null;

  if (paymentId === null) {
    return {
      ok: false,
      message: 'The payment was not recorded. Try again, or report this.',
    };
  }

  revalidatePath(ROUTES.payments);
  revalidatePath(`${ROUTES.loans}/${input.loanId}`);
  revalidatePath(ROUTES.portal);

  return {
    ok: true,
    message: 'Payment recorded.',
    paymentId,
  };
}

/**
 * Reverse a payment recorded in error.
 *
 * `payments:reverse` is the Owner's alone — see migration
 * `20261006000100` for why the person who records a payment must not be the
 * person who can withdraw the record.
 *
 * The payment is not deleted and its allocations are not removed. Its status
 * changes, and every balance in the system follows because the balance views
 * count only posted payments.
 */
export async function reversePaymentAction(
  _previous: PaymentActionResult | undefined,
  formData: FormData,
): Promise<PaymentActionResult> {
  let actor;
  try {
    actor = await requirePermission('payments:reverse');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('payments.reverse', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(reversePaymentSchema, {
    paymentId: formData.get('paymentId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { paymentId, reason } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('reverse_payment', {
    p_payment_id: paymentId,
    p_reason: reason,
  });

  if (error !== null) {
    logger.warn('A payment could not be reversed.', {
      code: error.code,
      paymentId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.payments);
  revalidatePath(`${ROUTES.payments}/${paymentId}`);
  revalidatePath(ROUTES.loans);
  revalidatePath(ROUTES.portal);

  return {
    ok: true,
    message: 'Payment reversed. The loan balance has been restored.',
    paymentId,
  };
}
