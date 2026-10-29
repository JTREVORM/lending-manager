'use server';

/**
 * Enrolment, consent and membership cards, as trusted server-side operations.
 *
 * Every function here performs the same checks in the same order: a session
 * exists, the account is active (`current_profile_id()` resolves only active
 * profiles), the capability is held, the input validates — and then the
 * database decides the rest, because each of these calls runs as the caller
 * and so Row Level Security, the posting functions' own rules and the ADR-050
 * activation preconditions all apply.
 *
 * ## Nothing here activates a membership, and nothing here verifies consent
 *
 * `enrolMemberAction` does not set a status and `recordConsentAction` does not
 * set `verification_status`. Both are derived by the database:
 * `memberships_guard_transition` refuses `pending -> active` unless the
 * registration fee has reached the ledger unreversed and a **verified**
 * acceptance of the member's own policy version exists, and
 * `membership_terms_acceptances_guard` decides what "verified" means from
 * evidence it can itself check.
 *
 * That split is the point, and it is the Phase 1 defect this phase closes. An
 * action that could assert consent could activate a membership on a typed
 * name, and a typed name is something anybody with the form can produce.
 *
 * ## Why enrolment is one call
 *
 * `enrol_member` takes the fee, posts its journal, records the acceptance,
 * activates the membership, opens the savings account and takes an optional
 * first deposit in a single transaction. The alternative — four actions and a
 * wizard — has two failure states this business cannot afford: a member who
 * paid and is not active, and a member who is active and did not pay. Neither
 * exists here, because there is no point between them at which the transaction
 * can be left.
 *
 * ## Double submission
 *
 * Enrolment is not idempotent by state — two people called Sarah Nakato can
 * both join on one morning — so every submission carries a key minted
 * server-side when the form renders. A double tap, a lost response and a
 * replayed form all arrive with the same key, and the database returns the
 * membership that already exists rather than enrolling twice. See ADR-030.
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
  enrolMemberSchema,
  issueConsentCodeSchema,
  issueMembershipCardSchema,
  recordConsentSchema,
  recordMembershipFeeSchema,
  redeemConsentCodeSchema,
  reverseMembershipFeeSchema,
} from '@/lib/validation/savings';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface MembershipActionResult extends ActionResult {
  readonly membershipId?: string;
  readonly receiptId?: string;
  readonly cardId?: string;
}

/**
 * Mint an idempotency key for an enrolment or fee form.
 *
 * Called when the form is *rendered*, not when it is submitted, which is what
 * makes it work: the key is fixed before the staff member can tap twice, so
 * both taps carry it.
 *
 * `node:crypto` rather than the browser's `crypto`, so the key cannot be
 * chosen by the client. A client-chosen key would let a caller replay somebody
 * else's key to read back their receipt.
 */
export async function mintEnrolmentKey(): Promise<string> {
  return Promise.resolve(randomUUID());
}

const FIELD_ERROR_MESSAGE = 'Please check the highlighted fields.';

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/**
 * Enrol a client as a member.
 *
 * Returns the membership id, so the caller can show the record and offer the
 * card. The fee amount is deliberately not a parameter: it comes from the
 * membership's own effective-dated policy version inside `enrol_member`, so a
 * caller cannot enrol somebody for a shilling and a member who joins in March
 * pays March's fee when the business changes it in June.
 */
export async function enrolMemberAction(
  _previous: MembershipActionResult | undefined,
  formData: FormData,
): Promise<MembershipActionResult> {
  let actor;
  try {
    actor = await requirePermission('membership:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('membership.enrol', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(enrolMemberSchema, {
    clientId: formData.get('clientId'),
    paymentMethod: formData.get('paymentMethod'),
    externalReference: formData.get('externalReference'),
    idempotencyKey: formData.get('idempotencyKey'),
    consentMethod: formData.get('consentMethod'),
    signatureName: formData.get('signatureName'),
    signaturePath: formData.get('signaturePath'),
    witnessProfileId: formData.get('witnessProfileId'),
    challengeId: formData.get('challengeId'),
    initialDeposit: formData.get('initialDeposit'),
    depositReference: formData.get('depositReference'),
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

  const { data, error } = await supabase.rpc('enrol_member', {
    p_client_id: input.clientId,
    p_payment_method: input.paymentMethod,
    p_fee_reference: input.externalReference ?? null,
    p_consent_method: input.consentMethod,
    p_signature_name: input.signatureName,
    p_fee_idempotency_key: input.idempotencyKey,
    p_signature_path: input.signaturePath ?? null,
    p_witness_profile_id: input.witnessProfileId ?? null,
    p_challenge_id: input.challengeId ?? null,
    p_initial_deposit: input.initialDeposit ?? null,
    p_deposit_reference: input.depositReference ?? null,
    // A second key, derived nowhere and minted here, because the deposit is a
    // second movement inside the same transaction and must not share the
    // fee's key — two rows cannot carry one idempotency key. Minted only when
    // there is a deposit to carry it.
    p_deposit_idempotency_key:
      (input.initialDeposit ?? null) === null ? null : randomUUID(),
    p_notes: input.notes ?? null,
  });

  if (error !== null) {
    // The amount and the consent evidence are deliberately absent from the
    // log. A failed enrolment is an operational event; the figures belong on
    // the ledger and the evidence belongs in the database, not in application
    // logs that are read by more people and kept for longer.
    logger.warn('A member could not be enrolled.', {
      code: error.code,
      clientId: input.clientId,
      consentMethod: input.consentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  const membershipId = typeof data === 'string' ? data : null;

  if (membershipId === null) {
    return {
      ok: false,
      message: 'The enrolment was not recorded. Try again, or report this.',
    };
  }

  revalidatePath(ROUTES.membership);
  revalidatePath(`${ROUTES.membership}/${membershipId}`);
  revalidatePath(ROUTES.savings);
  revalidatePath(ROUTES.clients);
  revalidatePath(`${ROUTES.clients}/${input.clientId}`);

  return {
    ok: true,
    message: 'Member enrolled. The registration fee has been posted.',
    membershipId,
  };
}

// ---------------------------------------------------------------------------
// The registration fee on its own
// ---------------------------------------------------------------------------

/**
 * Collect the registration fee against an existing membership.
 *
 * For an application taken first and paid for afterwards. The amount is sent
 * and then checked against the policy inside `record_membership_fee`, which
 * refuses a mismatch — so this is a counter confirming the figure they took,
 * not choosing it.
 */
export async function recordMembershipFeeAction(
  _previous: MembershipActionResult | undefined,
  formData: FormData,
): Promise<MembershipActionResult> {
  let actor;
  try {
    actor = await requirePermission('membership:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('membership.fee', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordMembershipFeeSchema, {
    membershipId: formData.get('membershipId'),
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

  const { data, error } = await supabase.rpc('record_membership_fee', {
    p_membership_id: input.membershipId,
    p_amount: input.amount,
    p_payment_method: input.paymentMethod,
    p_external_reference: input.externalReference ?? null,
    p_idempotency_key: input.idempotencyKey,
    p_notes: input.notes ?? null,
  });

  if (error !== null) {
    logger.warn('A registration fee could not be recorded.', {
      code: error.code,
      membershipId: input.membershipId,
      method: input.paymentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(`${ROUTES.membership}/${input.membershipId}`);
  revalidatePath(ROUTES.membership);
  revalidatePath(ROUTES.finance);

  return {
    ok: true,
    message: 'Registration fee recorded and posted.',
    receiptId: typeof data === 'string' ? data : undefined,
    membershipId: input.membershipId,
  };
}

/**
 * Reverse a registration fee receipt.
 *
 * The Owner's alone, like `payments:reverse`, for the same reason: the person
 * who records money must not be the person who can withdraw the record.
 *
 * This does **not** un-activate a member, and that is deliberate. Activation
 * was a decision the business took on the evidence it had; reversing the
 * receipt says the money did not arrive, which is a question about the money.
 * Whether the membership should then end is a separate decision somebody makes
 * explicitly, through the status screen, with a reason recorded against it.
 * What it does do is remove the posted fee — so the membership can no longer
 * *reach* `active` again without a fee being taken properly.
 */
export async function reverseMembershipFeeAction(
  _previous: MembershipActionResult | undefined,
  formData: FormData,
): Promise<MembershipActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:reverse');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('savings.reverse', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(reverseMembershipFeeSchema, {
    receiptId: formData.get('receiptId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { receiptId, reason } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('reverse_membership_fee', {
    p_receipt_id: receiptId,
    p_reason: reason,
  });

  if (error !== null) {
    logger.warn('A registration fee could not be reversed.', {
      code: error.code,
      receiptId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.membership);
  revalidatePath(ROUTES.finance);

  return {
    ok: true,
    message:
      'Registration fee reversed. The membership status is unchanged — change it separately if the member is no longer joining.',
    receiptId,
  };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Record a member's acceptance of a policy version.
 *
 * The method and its evidence are sent; the verdict is not. The guard verifies
 * the evidence and sets `verification_status` itself, so this action cannot
 * assert that somebody consented — which is exactly the thing a form should
 * not be able to do.
 */
export async function recordConsentAction(
  _previous: MembershipActionResult | undefined,
  formData: FormData,
): Promise<MembershipActionResult> {
  let actor;
  try {
    actor = await requirePermission('membership:manage_policies');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('membership.consent', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordConsentSchema, {
    membershipId: formData.get('membershipId'),
    policyVersionId: formData.get('policyVersionId'),
    consentMethod: formData.get('consentMethod'),
    signatureName: formData.get('signatureName'),
    signaturePath: formData.get('signaturePath'),
    witnessProfileId: formData.get('witnessProfileId'),
    challengeId: formData.get('challengeId'),
    acceptedPlace: formData.get('acceptedPlace'),
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

  const { error } = await supabase.rpc('accept_membership_policy_version', {
    p_membership_id: input.membershipId,
    p_policy_version_id: input.policyVersionId,
    p_consent_method: input.consentMethod,
    p_signature_name: input.signatureName,
    p_signature_path: input.signaturePath ?? null,
    p_witness_profile_id: input.witnessProfileId ?? null,
    p_challenge_id: input.challengeId ?? null,
    p_accepted_place: input.acceptedPlace ?? null,
  });

  if (error !== null) {
    logger.warn('An acceptance could not be recorded.', {
      code: error.code,
      membershipId: input.membershipId,
      consentMethod: input.consentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(`${ROUTES.membership}/${input.membershipId}`);
  revalidatePath(ROUTES.membership);
  revalidatePath(ROUTES.membershipPolicies);

  return {
    ok: true,
    message: 'Verified acceptance recorded. A controlled policy transition is a separate step.',
    membershipId: input.membershipId,
  };
}

export interface ConsentCodeResult extends ActionResult {
  readonly challengeId?: string;
  /**
   * The code, returned **once**, to be read to the member.
   *
   * The database stores only its digest, so this is the only moment it exists
   * anywhere outside the member's phone. It is returned rather than displayed
   * from a later read because there is no later read: that is the property
   * that makes a stolen database copy useless for consenting on somebody's
   * behalf.
   */
  readonly code?: string;
  readonly deliveredTo?: string;
  readonly expiresAt?: string;
}

/**
 * Send a member a one-time consent code.
 *
 * The number is the one already on their client record — not one typed into
 * this form — because a code sent to a number a staff member chose proves
 * nothing about who received it. `issue_membership_consent_code` reads it
 * itself for that reason, and refuses when the client record has no phone
 * number.
 */
export async function issueConsentCodeAction(
  _previous: ConsentCodeResult | undefined,
  formData: FormData,
): Promise<ConsentCodeResult> {
  let actor;
  try {
    actor = await requirePermission('membership:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('membership.consent_code', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(issueConsentCodeSchema, {
    membershipId: formData.get('membershipId'),
    policyVersionId: formData.get('policyVersionId'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('issue_membership_consent_code', {
    p_membership_id: parsed.data.membershipId,
    p_policy_version_id: parsed.data.policyVersionId,
  });

  if (error !== null) {
    logger.warn('A consent code could not be issued.', {
      code: error.code,
      membershipId: parsed.data.membershipId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  const row = (data ?? [])[0];

  if (row === undefined) {
    return { ok: false, message: 'The code was not issued. Try again.' };
  }

  // Not logged, at any level. A log line carrying the code would defeat
  // storing only its digest, and logs are read by more people and kept for
  // longer than this code is valid.
  return {
    ok: true,
    message: 'Code sent. Read it back from the member to confirm.',
    challengeId: row.challenge_id,
    code: row.code,
    deliveredTo: row.delivered_to,
    expiresAt: row.expires_at,
  };
}

/**
 * Check the code a member read back.
 *
 * Does not consume it: the acceptance guard does, in the same transaction as
 * the acceptance it proves, so a code cannot be burned by a check that then
 * fails to record anything. Wrong attempts are counted in the database and
 * the challenge dies after five.
 */
export async function redeemConsentCodeAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('membership:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(redeemConsentCodeSchema, {
    challengeId: formData.get('challengeId'),
    code: formData.get('code'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('redeem_membership_consent_code', {
    p_challenge_id: parsed.data.challengeId,
    p_code: parsed.data.code,
  });

  if (error !== null) {
    // The challenge id is logged; the code is not, for the reason above.
    logger.info('A consent code did not match.', {
      code: error.code,
      challengeId: parsed.data.challengeId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  return { ok: true, message: 'Code confirmed.' };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * Issue or reissue a membership card.
 *
 * The verification code is minted by the database, not here. A caller that
 * could choose it could print a card whose code matched somebody else's, and
 * the code is the only thing on the card that is not already public.
 */
export async function issueMembershipCardAction(
  _previous: MembershipActionResult | undefined,
  formData: FormData,
): Promise<MembershipActionResult> {
  let actor;
  try {
    actor = await requirePermission('membership:update');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('membership.card', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(issueMembershipCardSchema, {
    membershipId: formData.get('membershipId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { membershipId, reason } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('issue_membership_card', {
    p_membership_id: membershipId,
    p_reason: reason,
  });

  if (error !== null) {
    logger.warn('A membership card could not be issued.', {
      code: error.code,
      membershipId,
      reason,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(`${ROUTES.membership}/${membershipId}`);

  return {
    ok: true,
    message:
      reason === 'first_issue'
        ? 'Card issued.'
        : 'Card reissued. The previous card is no longer current.',
    cardId: typeof data === 'string' ? data : undefined,
    membershipId,
  };
}
