'use server';

import { revalidatePath } from 'next/cache';

import { requirePermission } from '@/lib/auth/context';
import type { ActionResult } from '@/lib/auth/actions';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Permission } from '@/lib/permissions';
import { checkActorRateLimit, type RateLimitedAction } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { policyUpdateSchema, type PolicyOperation } from '@/lib/validation/policy-update';

const capabilities: Record<PolicyOperation['operation'], Permission> = {
  record_timing: 'membership_policy:manage',
  begin_transition: 'membership_policy:manage',
  transition_member: 'membership_policy:manage',
  complete_transition: 'membership_policy:manage',
  record_consent: 'membership:manage_policies',
  carry_forward: 'payments:create',
  record_notice: 'meetings:manage',
  review_notice: 'meetings:excuse_review',
  assess_fines: 'fines:assess',
  collect_fine: 'fines:collect',
  cancel_fine: 'fines:reverse',
  reverse_fine_payment: 'fines:reverse',
  confirm_death: 'benefits:claim',
};

export interface PolicyActionResult extends ActionResult {
  readonly referenceId?: string;
}

export async function policyUpdateAction(
  _previous: PolicyActionResult | undefined,
  formData: FormData,
): Promise<PolicyActionResult> {
  const parsed = policyUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const input = parsed.data;
  try {
    const actor = await requirePermission(capabilities[input.operation]);
    const rateAction: RateLimitedAction =
      input.operation === 'collect_fine'
        ? 'finance.income'
        : input.operation === 'reverse_fine_payment' || input.operation === 'cancel_fine'
          ? 'payments.reverse'
          : input.operation === 'confirm_death'
            ? 'benefit.claim'
            : input.operation === 'record_notice' ||
                input.operation === 'review_notice' ||
                input.operation === 'assess_fines'
              ? 'meeting.manage'
              : 'settings.update';
    const limit = await checkActorRateLimit(rateAction, actor.profileId);
    if (!limit.allowed) return { ok: false, message: limit.message };
    const db = await createSupabaseServerClient();
    const response = await (async () => {
      switch (input.operation) {
        case 'record_timing':
          return db.rpc('record_draft_policy_timing', {
            p_policy_id: input.policyId,
            p_effective_from: input.effectiveDate,
            p_authorization_reference: input.reference,
          });
        case 'begin_transition':
          return db.rpc('begin_membership_policy_transition', {
            p_to_version_id: input.policyId,
            p_effective_on: input.effectiveDate,
            p_note: input.note,
          });
        case 'transition_member':
          return db.rpc('transition_membership_to_policy', {
            p_transition_id: input.transitionId,
            p_membership_id: input.membershipId,
          });
        case 'complete_transition':
          return db.rpc('complete_membership_policy_transition', {
            p_transition_id: input.transitionId,
          });
        case 'record_consent':
          return db.rpc('accept_membership_policy_version', {
            p_membership_id: input.membershipId,
            p_policy_version_id: input.policyId,
            p_consent_method: 'witnessed_in_branch',
            p_signature_name: input.signatureName,
            p_witness_profile_id: input.witnessId,
            p_accepted_place: input.place,
          });
        case 'carry_forward':
          return db.rpc('carry_forward_unpaid_installments', {
            p_loan_id: input.loanId,
            p_as_of: input.asOf,
            p_reason: input.note,
          });
        case 'record_notice':
          return db.rpc('record_meeting_absence_notice', {
            p_meeting_id: input.meetingId,
            p_membership_id: input.membershipId,
            p_reason_kind: input.reasonKind,
            p_reason: input.reason,
            p_reported_via: input.via,
          });
        case 'review_notice':
          return db.rpc('review_meeting_absence_notice', {
            p_notice_id: input.noticeId,
            p_approved: input.decision === 'approved',
            p_note: input.note,
          });
        case 'assess_fines':
          return db.rpc('assess_meeting_fines', { p_meeting_id: input.meetingId });
        case 'collect_fine':
          return db.rpc('post_meeting_fine_payment', {
            p_fine_id: input.fineId,
            p_amount: input.amount,
            p_payment_method: input.method,
            p_external_reference: input.reference,
            p_idempotency_key: input.key,
          });
        case 'cancel_fine':
          return db.rpc('cancel_meeting_fine', {
            p_fine_id: input.fineId,
            p_reason: input.note,
          });
        case 'reverse_fine_payment':
          return db.rpc('reverse_meeting_fine_payment', {
            p_payment_id: input.paymentId,
            p_reason: input.note,
          });
        case 'confirm_death':
          return db.rpc('record_death_confirmation', {
            p_claim_id: input.claimId,
            p_confirming_membership_id: input.membershipId,
            p_statement: input.statement,
            p_confirmation_method: 'witnessed_by_staff',
            p_relationship_note: input.relationship,
          });
      }
    })();
    if (response.error) {
      logger.warn('A policy operation was refused.', {
        operation: input.operation,
        code: response.error.code,
      });
      return { ok: false, message: mapDatabaseError(response.error).message };
    }
    revalidatePath('/membership', 'layout');
    revalidatePath('/meetings', 'layout');
    revalidatePath('/benefits', 'layout');
    revalidatePath('/loans', 'layout');
    revalidatePath('/savings', 'layout');
    revalidatePath('/portal', 'layout');
    return {
      ok: true,
      message:
        input.operation === 'record_timing'
          ? 'Authorized date recorded. The policy remains a draft.'
          : input.operation === 'record_consent'
            ? 'Verified acceptance recorded. The controlled transition is a separate step.'
            : 'Recorded successfully.',
      referenceId: typeof response.data === 'string' ? response.data : undefined,
    };
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }
}
