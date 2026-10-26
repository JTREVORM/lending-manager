'use server';

/**
 * Beneficiaries, benefit claims, evidence and payments, as trusted
 * server-side operations.
 *
 * Every function here performs the same checks in the same order: a session
 * exists, the account is active (`current_profile_id()` resolves only active
 * profiles), the capability is held, the rate limit permits it, the input
 * validates — and then the database decides the rest, by running as the
 * caller, so Row Level Security, the state machine and each function's own
 * rules all apply.
 *
 * ## Nothing here decides an amount, a recipient or an outcome
 *
 * No function in this module works out what a benefit is worth, who it is
 * paid to, whether a claim qualifies, or which ledger accounts a payment
 * touches. `assess_benefit_claim` does, from the claim's own policy version
 * and under an advisory lock on the membership; `post_benefit_payment` does,
 * from the assessment snapshot the approver agreed to.
 *
 * The recipient in particular is not the caller's to supply. A payment that
 * took a payee from the request could pay UGX 200,000 to somebody the
 * approver never saw — which is the fraud §11 of the Phase 4 brief names, and
 * the reason the posting function reads the snapshot rather than the live
 * beneficiary record.
 *
 * ## The split between the four stages
 *
 * Four capabilities, because a benefit is money leaving the business on the
 * strength of a document somebody produced. A Secretary/Treasurer opens
 * claims; a Manager assesses and pays; an Owner approves. And
 * `approve_benefit_claim` additionally refuses an approval from whoever
 * assessed the claim, so the split holds for an Owner who holds both keys —
 * which is what makes it a control rather than a label on a permissions page.
 *
 * The same shape appears twice more: `verify_member_beneficiary` refuses the
 * person who recorded the beneficiary, and `verify_benefit_document` refuses
 * the person who attached the document.
 *
 * ## Double submission
 *
 * A benefit payment is not idempotent by state the way an approval is: the
 * claim moves from `approved` to `paid`, so a second call is refused — but
 * only after reading the claim, which makes a network retry look like a
 * failure. So every payment carries a key minted server-side when the form
 * renders, and the posting function returns the existing payment instead of
 * paying twice. See ADR-030, and ADR-056 for why the capability check sits
 * above the replay.
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
  approveClaimSchema,
  assessClaimSchema,
  attachDocumentSchema,
  bereavementClaimSchema,
  cancelClaimSchema,
  claimIdSchema,
  condolenceClaimSchema,
  medicalClaimSchema,
  payBenefitSchema,
  registerBeneficiaryFormSchema,
  rejectClaimSchema,
  removeDocumentSchema,
  requestInformationSchema,
  reverseBenefitPaymentSchema,
  revokeBeneficiarySchema,
  verifyBeneficiarySchema,
  verifyDocumentSchema,
} from '@/lib/validation/benefits';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface BenefitActionResult extends ActionResult {
  readonly claimId?: string;
  readonly beneficiaryId?: string;
  readonly documentId?: string;
  readonly paymentId?: string;
  readonly assessedAmount?: number;
}

const FIELD_ERROR_MESSAGE = 'Please check the highlighted fields.';

/**
 * Mint an idempotency key for a benefit payment form.
 *
 * Called when the form is *rendered*, so the key is fixed before the staff
 * member can tap twice and both taps carry it. `node:crypto` rather than the
 * browser's, so the key cannot be chosen by the client — a client-chosen key
 * would let a caller replay somebody else's to read back their payment.
 */
export async function mintBenefitKey(): Promise<string> {
  return Promise.resolve(randomUUID());
}

/** Every route a benefit change can be visible on. */
function revalidateBenefitRoutes(claimId?: string, membershipId?: string): void {
  revalidatePath(ROUTES.benefits);
  revalidatePath(ROUTES.benefitClaims);
  revalidatePath(ROUTES.benefitApprovals);
  revalidatePath(ROUTES.benefitPayments);

  if (claimId !== undefined) {
    revalidatePath(`${ROUTES.benefitClaims}/${claimId}`);
  }

  if (membershipId !== undefined) {
    revalidatePath(`${ROUTES.membership}/${membershipId}`);
  }

  // A member sees their own claim's status in the portal.
  revalidatePath(ROUTES.portal);
}

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

/**
 * Register a beneficiary, or record a change to one.
 *
 * Passing `supersedesId` makes this a change: the old record becomes
 * `superseded` with every detail intact, in the same statement, so there is
 * never a moment at which both are live. The database refuses it outright
 * while a bereavement claim on that membership is under way — because the
 * recipient the business is deciding on must not move under the decision.
 */
export async function registerBeneficiaryAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('beneficiaries:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('beneficiary.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(registerBeneficiaryFormSchema, {
    membershipId: formData.get('membershipId'),
    fullName: formData.get('fullName'),
    relationship: formData.get('relationship'),
    phone: formData.get('phone'),
    alternativePhone: formData.get('alternativePhone'),
    villageArea: formData.get('villageArea'),
    district: formData.get('district'),
    identityDocumentKind: formData.get('identityDocumentKind'),
    identityReference: formData.get('identityReference'),
    isPrimary: formData.get('isPrimary') === 'on' || formData.get('isPrimary') === 'true',
    supersedesId: formData.get('supersedesId'),
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

  const { data, error } = await supabase.rpc('register_member_beneficiary', {
    p_membership_id: input.membershipId,
    p_full_name: input.fullName,
    p_relationship: input.relationship,
    p_phone: input.phone,
    p_alternative_phone: input.alternativePhone ?? null,
    p_village_area: input.villageArea ?? null,
    p_district: input.district ?? null,
    p_identity_document_kind: input.identityDocumentKind ?? null,
    p_identity_reference: input.identityReference ?? null,
    p_is_primary: input.isPrimary,
    p_supersedes_id: input.supersedesId ?? null,
  });

  if (error !== null) {
    // The name, the telephone number and the identity reference are
    // deliberately not logged. They are the payment instruction, and an
    // application log is a wider audience than
    // `membership:view_sensitive`.
    logger.warn('A beneficiary could not be registered.', {
      code: error.code,
      membershipId: input.membershipId,
      isChange: (input.supersedesId ?? null) !== null,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.beneficiaries);
  revalidatePath(`${ROUTES.membership}/${input.membershipId}`);

  return {
    ok: true,
    message:
      (input.supersedesId ?? null) === null
        ? 'Beneficiary recorded. Somebody else must verify it before a bereavement benefit can be paid against it.'
        : 'Beneficiary replaced. The previous record is kept, so an earlier payment stays explicable.',
    beneficiaryId: typeof data === 'string' ? data : undefined,
  };
}

/**
 * Verify a beneficiary record, or refuse it.
 *
 * Refused by the database when the caller recorded the record. That is the
 * control: a member of staff who could both create a payment instruction and
 * attest to it could name themselves the beneficiary of a member they expect
 * to die.
 */
export async function verifyBeneficiaryAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('beneficiaries:verify');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('beneficiary.verify', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(verifyBeneficiarySchema, {
    beneficiaryId: formData.get('beneficiaryId'),
    verified: formData.get('verified') === 'true',
    evidenceKind: formData.get('evidenceKind'),
    evidencePath: formData.get('evidencePath'),
    note: formData.get('note'),
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

  const { error } = await supabase.rpc('verify_member_beneficiary', {
    p_beneficiary_id: input.beneficiaryId,
    p_verified: input.verified,
    p_evidence_kind: input.evidenceKind,
    p_evidence_path: input.evidencePath ?? null,
    p_note: input.note ?? null,
  });

  if (error !== null) {
    logger.warn('A beneficiary could not be verified.', {
      code: error.code,
      beneficiaryId: input.beneficiaryId,
      verified: input.verified,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.beneficiaries);
  revalidatePath(ROUTES.benefits);

  return {
    ok: true,
    message: input.verified ? 'Beneficiary verified.' : 'Beneficiary record refused.',
    beneficiaryId: input.beneficiaryId,
  };
}

/** End a beneficiary nomination with a reason, keeping every detail. */
export async function revokeBeneficiaryAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('beneficiaries:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('beneficiary.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(revokeBeneficiarySchema, {
    beneficiaryId: formData.get('beneficiaryId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('revoke_member_beneficiary', {
    p_beneficiary_id: parsed.data.beneficiaryId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A beneficiary could not be revoked.', {
      code: error.code,
      beneficiaryId: parsed.data.beneficiaryId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.beneficiaries);

  return { ok: true, message: 'Beneficiary nomination withdrawn.' };
}

// ---------------------------------------------------------------------------
// Opening a claim
// ---------------------------------------------------------------------------

/**
 * One helper behind the three claim forms.
 *
 * `open_benefit_claim` takes every type's arguments and the schema's CHECK
 * constraints refuse the wrong combination, so there is one function and not
 * three signatures over one table — the one that drifted would be the one
 * nobody tested.
 */
async function openClaim(payload: {
  readonly membershipId: string;
  readonly claimType: 'medical' | 'family_condolence' | 'member_bereavement';
  readonly eventDate?: string | null;
  readonly providerName?: string | null;
  readonly admissionAt?: string | null;
  readonly dischargeAt?: string | null;
  readonly billAmount?: number | null;
  readonly deceasedName?: string | null;
  readonly deceasedRelationship?: string | null;
  readonly beneficiaryId?: string | null;
}): Promise<BenefitActionResult> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('open_benefit_claim', {
    p_membership_id: payload.membershipId,
    p_claim_type: payload.claimType,
    p_event_date: payload.eventDate ?? null,
    p_provider_name: payload.providerName ?? null,
    p_admission_at: payload.admissionAt ?? null,
    p_discharge_at: payload.dischargeAt ?? null,
    p_bill_amount: payload.billAmount ?? null,
    p_deceased_name: payload.deceasedName ?? null,
    p_deceased_relationship: payload.deceasedRelationship ?? null,
    p_beneficiary_id: payload.beneficiaryId ?? null,
  });

  if (error !== null) {
    // No hospital, no deceased's name, no bill. The claim type and the
    // membership are enough to find the event in the register, and an
    // application log is a wider audience than `benefits:view`.
    logger.warn('A benefit claim could not be opened.', {
      code: error.code,
      membershipId: payload.membershipId,
      claimType: payload.claimType,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  const claimId = typeof data === 'string' ? data : null;

  if (claimId === null) {
    return {
      ok: false,
      message: 'The claim was not opened. Try again, or report this.',
    };
  }

  revalidateBenefitRoutes(claimId, payload.membershipId);

  return {
    ok: true,
    message: 'Claim opened as a draft. Attach the evidence, then submit it.',
    claimId,
  };
}

export async function openMedicalClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:claim');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.claim', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(medicalClaimSchema, {
    membershipId: formData.get('membershipId'),
    providerName: formData.get('providerName'),
    admissionAt: formData.get('admissionAt'),
    dischargeAt: formData.get('dischargeAt'),
    billAmount: formData.get('billAmount'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  return openClaim({
    membershipId: parsed.data.membershipId,
    claimType: 'medical',
    providerName: parsed.data.providerName,
    admissionAt: parsed.data.admissionAt,
    dischargeAt: parsed.data.dischargeAt ?? null,
    billAmount: parsed.data.billAmount,
  });
}

export async function openCondolenceClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:claim');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.claim', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(condolenceClaimSchema, {
    membershipId: formData.get('membershipId'),
    deceasedName: formData.get('deceasedName'),
    deceasedRelationship: formData.get('deceasedRelationship'),
    dateOfDeath: formData.get('dateOfDeath'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  return openClaim({
    membershipId: parsed.data.membershipId,
    claimType: 'family_condolence',
    eventDate: parsed.data.dateOfDeath,
    deceasedName: parsed.data.deceasedName,
    deceasedRelationship: parsed.data.deceasedRelationship,
  });
}

export async function openBereavementClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:claim');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.claim', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(bereavementClaimSchema, {
    membershipId: formData.get('membershipId'),
    deceasedName: formData.get('deceasedName'),
    dateOfDeath: formData.get('dateOfDeath'),
    beneficiaryId: formData.get('beneficiaryId'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  return openClaim({
    membershipId: parsed.data.membershipId,
    claimType: 'member_bereavement',
    eventDate: parsed.data.dateOfDeath,
    deceasedName: parsed.data.deceasedName,
    beneficiaryId: parsed.data.beneficiaryId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Moving a claim along
// ---------------------------------------------------------------------------

/**
 * Submit a draft claim.
 *
 * The facts freeze here, and no eligibility rule is checked: a claim that
 * cannot succeed should be recorded and then refused with a reason, which is
 * a document the member can be shown. A business that refused to write down
 * that somebody came in and asked would keep the record on paper.
 */
export async function submitBenefitClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:claim');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.claim', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(claimIdSchema, { claimId: formData.get('claimId') });

  if (!parsed.success) {
    return { ok: false, message: FIELD_ERROR_MESSAGE };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('submit_benefit_claim', {
    p_claim_id: parsed.data.claimId,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be submitted.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return {
    ok: true,
    message: 'Claim submitted. Its facts are now fixed.',
    claimId: parsed.data.claimId,
  };
}

/** Pick a claim up for checking, so the register shows what is in hand. */
export async function beginVerificationAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  try {
    await requirePermission('benefits:assess');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(claimIdSchema, { claimId: formData.get('claimId') });

  if (!parsed.success) return { ok: false, message: FIELD_ERROR_MESSAGE };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('begin_benefit_verification', {
    p_claim_id: parsed.data.claimId,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be taken up for checking.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return {
    ok: true,
    message: 'Claim taken up for checking.',
    claimId: parsed.data.claimId,
  };
}

/** Put a claim back to the claimant, saying what is missing. */
export async function requestInformationAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  try {
    await requirePermission('benefits:assess');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(requestInformationSchema, {
    claimId: formData.get('claimId'),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('request_benefit_information', {
    p_claim_id: parsed.data.claimId,
    p_note: parsed.data.note,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be put back to the claimant.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return {
    ok: true,
    message: 'Claim put back to the claimant.',
    claimId: parsed.data.claimId,
  };
}

/**
 * Assess a claim.
 *
 * The amount comes back from the database, computed from the claim's own
 * policy version under an advisory lock on the membership — so two
 * assessments for one member cannot share one annual cap. Every eligibility
 * rule is checked there; this function supplies a note and nothing else.
 */
export async function assessBenefitClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:assess');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.assess', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(assessClaimSchema, {
    claimId: formData.get('claimId'),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('assess_benefit_claim', {
    p_claim_id: parsed.data.claimId,
    p_note: parsed.data.note ?? null,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be assessed.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return {
    ok: true,
    message: 'Claim assessed. It now needs an approver, who may not be you.',
    claimId: parsed.data.claimId,
    assessedAmount: typeof data === 'number' ? data : undefined,
  };
}

/**
 * Approve an assessed claim.
 *
 * Refused by the database when the caller assessed it — the control the
 * roadmap calls the one that must not be collapsed. Every eligibility rule is
 * re-asked, because an approval is a fresh decision and the only thing the
 * snapshot settles is what the *assessment* was.
 */
export async function approveBenefitClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:approve');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.decision', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(approveClaimSchema, {
    claimId: formData.get('claimId'),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('approve_benefit_claim', {
    p_claim_id: parsed.data.claimId,
    // Deliberately null: the approver agrees the assessment or refuses the
    // claim. A part approval is refused while that rule is undecided, and
    // sending a figure here would invite somebody to type one.
    p_approved_amount: null,
    p_note: parsed.data.note ?? null,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be approved.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return {
    ok: true,
    message: 'Claim approved. It is now waiting to be paid.',
    claimId: parsed.data.claimId,
  };
}

/**
 * Refuse a claim, with a reason.
 *
 * Takes `benefits:approve`, because refusing a claim is the same decision
 * about a member's entitlement that approving one is. Available after
 * approval too, which is how an approval is withdrawn before the money goes.
 */
export async function rejectBenefitClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:approve');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.decision', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(rejectClaimSchema, {
    claimId: formData.get('claimId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('reject_benefit_claim', {
    p_claim_id: parsed.data.claimId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be refused.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return {
    ok: true,
    message: 'Claim refused. The reason is on the record.',
    claimId: parsed.data.claimId,
  };
}

/**
 * Withdraw a claim before a decision.
 *
 * Available to whoever may open one, because withdrawing a claim is the
 * absence of a decision rather than one. An approved claim is refused
 * instead, by somebody with the authority to refuse.
 */
export async function cancelBenefitClaimAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  try {
    await requirePermission('benefits:claim');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(cancelClaimSchema, {
    claimId: formData.get('claimId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('cancel_benefit_claim', {
    p_claim_id: parsed.data.claimId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A benefit claim could not be withdrawn.', {
      code: error.code,
      claimId: parsed.data.claimId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes(parsed.data.claimId);

  return { ok: true, message: 'Claim withdrawn.', claimId: parsed.data.claimId };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Record an uploaded document against a claim or a beneficiary.
 *
 * The *object* is written by the caller's own session through the storage
 * policies, by `lib/storage/benefit-documents.ts`; this records the metadata.
 * The two halves are authorised independently and neither is enough alone:
 * the policy refuses an object outside a membership the caller can see, and
 * the metadata guard refuses a row whose path does not agree with its
 * membership, its kind and its claim.
 *
 * The row is `unchecked`. A document existing is not a fact being
 * established, and assessment counts only the verified ones.
 */
export async function attachBenefitDocumentAction(input: {
  readonly claimId: string | null;
  readonly beneficiaryId: string | null;
  readonly kind: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly label: string | null;
}): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission(
      input.claimId !== null ? 'benefits:claim' : 'beneficiaries:manage',
    );
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('uploads.document', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(attachDocumentSchema, {
    claimId: input.claimId,
    beneficiaryId: input.beneficiaryId,
    kind: input.kind,
    label: input.label,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('attach_benefit_document', {
    p_claim_id: parsed.data.claimId ?? null,
    p_beneficiary_id: parsed.data.beneficiaryId ?? null,
    p_kind: parsed.data.kind,
    p_object_path: input.objectPath,
    p_content_type: input.contentType,
    p_byte_size: input.byteSize,
    p_label: parsed.data.label ?? null,
  });

  if (error !== null) {
    // The path is not logged. It carries the membership and the claim, and an
    // object path is a thing a reader could fetch.
    logger.warn('A benefit document could not be recorded.', {
      code: error.code,
      kind: parsed.data.kind,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  if (input.claimId !== null) {
    revalidateBenefitRoutes(input.claimId);
  } else {
    revalidatePath(ROUTES.beneficiaries);
  }

  return {
    ok: true,
    message: 'Document attached. It still needs checking by somebody else.',
    documentId: typeof data === 'string' ? data : undefined,
  };
}

/**
 * Record that somebody checked a piece of evidence.
 *
 * Takes `benefits:assess`, because checking that an invoice is an invoice is
 * part of assessing. Refused by the database when the caller attached the
 * document: evidence uploaded and attested by one hand is evidence nobody
 * checked.
 */
export async function verifyBenefitDocumentAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  try {
    await requirePermission('benefits:assess');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(verifyDocumentSchema, {
    documentId: formData.get('documentId'),
    verified: formData.get('verified') === 'true',
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('verify_benefit_document', {
    p_document_id: parsed.data.documentId,
    p_verified: parsed.data.verified,
    p_note: parsed.data.note ?? null,
  });

  if (error !== null) {
    logger.warn('A benefit document could not be checked.', {
      code: error.code,
      documentId: parsed.data.documentId,
      verified: parsed.data.verified,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.benefitClaims);
  revalidatePath(ROUTES.beneficiaries);

  return {
    ok: true,
    message: parsed.data.verified ? 'Document checked.' : 'Document refused.',
    documentId: parsed.data.documentId,
  };
}

/**
 * Remove an unchecked document from an open claim.
 *
 * The one DELETE in the phase, and it is narrow: the delete guard refuses a
 * document somebody has already checked, and refuses any document on a claim
 * that has been decided. A mis-attached file on a draft is a thing people need
 * to undo; evidence an officer acted on is part of the record.
 */
export async function removeBenefitDocumentAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  try {
    await requirePermission('benefits:claim');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(removeDocumentSchema, {
    documentId: formData.get('documentId'),
  });

  if (!parsed.success) return { ok: false, message: FIELD_ERROR_MESSAGE };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('benefit_claim_documents')
    .delete()
    .eq('id', parsed.data.documentId);

  if (error !== null) {
    logger.warn('A benefit document could not be removed.', {
      code: error.code,
      documentId: parsed.data.documentId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.benefitClaims);

  return { ok: true, message: 'Document removed.' };
}

// ---------------------------------------------------------------------------
// Paying and reversing
// ---------------------------------------------------------------------------

/**
 * Pay an approved benefit.
 *
 * Debits the benefit expense account for the claim's type and credits the
 * branch's cash, Mobile Money or bank account. Neither the amount nor the
 * recipient is supplied here: both come from the assessment the approver
 * agreed to, and the recipient from its frozen copy rather than from the live
 * beneficiary record.
 *
 * Idempotent on the key minted when the form rendered, so a double tap and a
 * lost response both return the first payment.
 */
export async function payBenefitAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('benefits:pay');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.pay', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(payBenefitSchema, {
    claimId: formData.get('claimId'),
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

  const { data, error } = await supabase.rpc('post_benefit_payment', {
    p_claim_id: input.claimId,
    p_payment_method: input.paymentMethod,
    p_external_reference: input.externalReference ?? null,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error !== null) {
    // The amount is deliberately not logged: a failed posting is an
    // operational event, and the figures belong on the ledger rather than in
    // application logs.
    logger.warn('A benefit payment could not be posted.', {
      code: error.code,
      claimId: input.claimId,
      method: input.paymentMethod,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  const paymentId = typeof data === 'string' ? data : null;

  if (paymentId === null) {
    return {
      ok: false,
      message: 'The benefit was not paid. Try again, or report this.',
    };
  }

  revalidateBenefitRoutes(input.claimId);
  revalidatePath(ROUTES.ledger);
  revalidatePath(ROUTES.trialBalance);

  return { ok: true, message: 'Benefit paid.', claimId: input.claimId, paymentId };
}

/**
 * Reverse a benefit payment.
 *
 * The Owner's alone, under `savings:reverse` — the authority that already
 * covers reversing any posted movement in this programme. Posts the contra
 * journal, keeps the original, and moves the claim to the terminal `reversed`
 * state: there is no edge back to `approved`, so an erroneous reversal cannot
 * make a paid claim payable twice.
 */
export async function reverseBenefitPaymentAction(
  _previous: BenefitActionResult | undefined,
  formData: FormData,
): Promise<BenefitActionResult> {
  let actor;
  try {
    actor = await requirePermission('savings:reverse');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('benefit.reverse', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(reverseBenefitPaymentSchema, {
    paymentId: formData.get('paymentId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('reverse_benefit_payment', {
    p_payment_id: parsed.data.paymentId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A benefit payment could not be reversed.', {
      code: error.code,
      paymentId: parsed.data.paymentId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateBenefitRoutes();
  revalidatePath(ROUTES.ledger);
  revalidatePath(ROUTES.trialBalance);

  return {
    ok: true,
    message:
      'Payment reversed. The original entry and its contra are both on the ledger.',
    paymentId: parsed.data.paymentId,
  };
}
