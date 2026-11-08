'use server';

/**
 * Agency banking, as trusted server-side operations.
 *
 * Every function does the same four things in order: confirm a session and
 * its capability, rate-limit the actor, validate the shape of the input, and
 * hand the decision to the database — which runs as the caller, so Row Level
 * Security, the branch rule, the readiness gate, the provider and account
 * locks and the maker-checker rules all apply whatever this module believes.
 *
 * ## Nothing here writes a journal
 *
 * No function below constructs a debit or a credit, computes a commission, or
 * decides whether a payable may be drawn down. The Phase 4A–4C posting
 * functions do, from figures they read themselves under lock, inside the
 * transaction that writes the journal. An action that could supply the legs
 * could post a deposit as a withdrawal; one that could supply the commission
 * would be the operator-typed figure Phase 4B-S took away.
 *
 * ## Nothing here is authorization
 *
 * `requirePermission` is a server-side gate and it is the *second* line:
 * every function it calls refuses the same thing again with SQLSTATE 42501,
 * from `agency_actor()` and `user_can_see_branch()`. Hiding a button is not
 * authorization, and neither is this module — the database is.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { parseSafely } from '@/lib/validation/validate';
import {
  agencyTransactionIdSchema,
  agencyTransactionReasonSchema,
  cashCountSchema,
  commissionExceptionSchema,
  commissionSettlementSchema,
  correctReferenceSchema,
  floatReplenishmentSchema,
  floatStatementSchema,
  payableSettlementSchema,
  reconciliationApprovalSchema,
  recordAgencyTransactionSchema,
  settlementReversalSchema,
} from '@/lib/validation/agency';
import type { ActionResult } from '@/lib/auth/actions';
import type { Permission } from '@/lib/permissions';
import type { RateLimitedAction } from '@/lib/security/rate-limit';

export interface AgencyActionResult extends ActionResult {
  /** The record the action created or acted on, for a redirect. */
  readonly recordId?: string;
}

const INVALID = 'Please check the highlighted fields.';

/** Every agency screen that could be showing a figure this action moved. */
function revalidateAgency(): void {
  for (const route of [
    ROUTES.agency,
    ROUTES.agencyPending,
    ROUTES.agencyHistory,
    ROUTES.agencyFloat,
    ROUTES.agencyCommission,
    ROUTES.agencyPayables,
    ROUTES.agencyCashCount,
    ROUTES.agencyFloatCount,
    ROUTES.agencyReports,
    ROUTES.agencyExceptions,
    ROUTES.dashboard,
  ]) {
    revalidatePath(route);
  }
}

async function authorize(
  permission: Permission,
  bucket: RateLimitedAction,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let actor;
  try {
    actor = await requirePermission(permission);
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }
  const limit = await checkActorRateLimit(bucket, actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };
  return { ok: true };
}

/** The shared tail: map the refusal, or revalidate and report. */
function settle(
  error: { code?: string; message: string } | null,
  what: string,
  success: string,
  recordId?: unknown,
): AgencyActionResult {
  if (error !== null) {
    logger.warn(`${what} was refused.`, { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }
  revalidateAgency();
  return {
    ok: true,
    message: success,
    recordId: typeof recordId === 'string' ? recordId : undefined,
  };
}

// ===========================================================================
// The counter
// ===========================================================================

export async function recordAgencyTransactionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:write', 'agency.record');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(recordAgencyTransactionSchema, {
    transactionTypeId: formData.get('transactionTypeId'),
    principalAmount: formData.get('principalAmount'),
    floatAccountId: formData.get('floatAccountId') ?? null,
    customerIdentifier: formData.get('customerIdentifier'),
    customerName: formData.get('customerName'),
    providerReference: formData.get('providerReference'),
    customerFee: formData.get('customerFee') ?? 0,
    description: formData.get('description'),
    idempotencyKey: formData.get('idempotencyKey'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // The commission argument is deliberately null. A figure typed at the
  // counter is what Phase 4B-S refused: a difference from the provider's
  // configured terms now needs an Owner's authorisation with evidence.
  const { data, error } = await supabase.rpc('create_agency_transaction', {
    p_transaction_type_id: input.transactionTypeId,
    p_principal_amount: input.principalAmount,
    p_float_account_id: input.floatAccountId ?? null,
    p_customer_identifier: input.customerIdentifier,
    p_customer_name: input.customerName ?? null,
    p_provider_reference: input.providerReference,
    p_customer_fee: input.customerFee,
    p_commission_supplied: null,
    p_description: input.description ?? null,
    p_transaction_date: null,
    p_idempotency_key: input.idempotencyKey,
  });

  return settle(error, 'Recording an agency transaction', 'Transaction recorded.', data);
}

/**
 * One lifecycle move that takes an id and a reason.
 *
 * Written out per RPC rather than through one generic helper: the four
 * functions have different argument types, and a helper that reached them
 * through a cast was trading a type error for a silent one.
 */
async function withReason(
  formData: FormData,
  options: {
    readonly permission: Permission;
    readonly bucket: RateLimitedAction;
    readonly what: string;
    readonly success: string;
    readonly call: (
      supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
      transactionId: string,
      reason: string,
      // A thenable builder rather than a Promise: that is what .rpc() returns.
    ) => PromiseLike<{
      data: unknown;
      error: { code?: string; message: string } | null;
    }>;
  },
): Promise<AgencyActionResult> {
  const allowed = await authorize(options.permission, options.bucket);
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agencyTransactionReasonSchema, {
    transactionId: formData.get('transactionId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await options.call(
    supabase,
    parsed.data.transactionId,
    parsed.data.reason,
  );
  return settle(error, options.what, options.success, data);
}

export async function submitAgencyTransactionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:write', 'agency.lifecycle');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agencyTransactionIdSchema, {
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { ok: false, message: INVALID };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('submit_agency_transaction', {
    p_transaction_id: parsed.data.transactionId,
  });
  return settle(error, 'Submitting a transaction', 'Sent for verification.');
}

export async function verifyAgencyTransactionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:verify', 'agency.verify');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agencyTransactionIdSchema, {
    transactionId: formData.get('transactionId'),
  });
  if (!parsed.success) return { ok: false, message: INVALID };

  const supabase = await createSupabaseServerClient();
  // Posts the journal. The database refuses an officer verifying their own
  // entry, a provisional or inactive provider, insufficient cash or float,
  // and a bank payable that would go into net debit.
  const { data, error } = await supabase.rpc('verify_agency_transaction', {
    p_transaction_id: parsed.data.transactionId,
  });
  return settle(error, 'Verifying a transaction', 'Verified and posted.', data);
}

export async function returnAgencyTransactionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  return withReason(formData, {
    permission: 'agency:verify',
    bucket: 'agency.lifecycle',
    what: 'Returning a transaction',
    success: 'Returned for correction.',
    call: (supabase, id, reason) =>
      supabase.rpc('return_agency_transaction', {
        p_transaction_id: id,
        p_reason: reason,
      }),
  });
}

export async function cancelAgencyTransactionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  return withReason(formData, {
    permission: 'agency:write',
    bucket: 'agency.lifecycle',
    what: 'Cancelling a transaction',
    success: 'Cancelled.',
    call: (supabase, id, reason) =>
      supabase.rpc('cancel_agency_transaction', {
        p_transaction_id: id,
        p_reason: reason,
      }),
  });
}

export async function reverseAgencyTransactionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  // A prior-day reversal additionally needs agency:reverse_cross_day, which
  // the database checks: this action does not decide which day it is.
  return withReason(formData, {
    permission: 'agency:reverse',
    bucket: 'agency.reverse',
    what: 'Reversing a transaction',
    success: 'Reversed by contra entry.',
    call: (supabase, id, reason) =>
      supabase.rpc('reverse_agency_transaction', {
        p_transaction_id: id,
        p_reason: reason,
      }),
  });
}

export async function correctAgencyReferenceAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:correct', 'agency.lifecycle');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(correctReferenceSchema, {
    transactionId: formData.get('transactionId'),
    newReference: formData.get('newReference'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('update_agency_transaction_reference', {
    p_transaction_id: parsed.data.transactionId,
    p_new_reference: parsed.data.newReference,
    p_reason: parsed.data.reason,
  });
  return settle(
    error,
    'Correcting a reference',
    'Reference corrected. No journal moved.',
  );
}

export async function authoriseCommissionExceptionAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:commission_exception', 'agency.lifecycle');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionExceptionSchema, {
    transactionId: formData.get('transactionId'),
    reason: formData.get('reason'),
    evidence: formData.get('evidence'),
    proposedAmount: formData.get('proposedAmount'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  // The fourth argument is what makes this reachable at all: the counter
  // supplies no commission, so without a proposed figure the database would
  // refuse every transaction the interface can produce.
  const { error } = await supabase.rpc('authorise_agency_commission_exception', {
    p_transaction_id: parsed.data.transactionId,
    p_reason: parsed.data.reason,
    p_evidence: parsed.data.evidence,
    p_proposed_amount: parsed.data.proposedAmount,
  });
  return settle(error, 'Authorising a commission difference', 'Difference authorised.');
}

// ===========================================================================
// Settlement, remittance and replenishment
// ===========================================================================

export async function recordCommissionSettlementAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionSettlementSchema, {
    providerId: formData.get('providerId'),
    branchId: formData.get('branchId'),
    amount: formData.get('amount'),
    settlementAccountId: formData.get('settlementAccountId'),
    statementRef: formData.get('statementRef'),
    settlementDate: formData.get('settlementDate') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_commission_settlement', {
    p_provider_id: input.providerId,
    p_branch_id: input.branchId,
    p_settlement_amount: input.amount,
    p_settlement_account_id: input.settlementAccountId,
    p_statement_ref: input.statementRef ?? null,
    p_settlement_date: input.settlementDate ?? null,
  });
  return settle(
    error,
    'Recording a commission settlement',
    'Commission settlement recorded.',
    data,
  );
}

export async function reverseCommissionSettlementAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reverse', 'agency.reverse');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(settlementReversalSchema, {
    settlementId: formData.get('settlementId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('reverse_commission_settlement', {
    p_settlement_id: parsed.data.settlementId,
    p_reason: parsed.data.reason,
  });
  return settle(
    error,
    'Correcting a commission settlement',
    'Settlement corrected. The receivable is restored.',
    data,
  );
}

export async function postPayableSettlementAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(payableSettlementSchema, {
    providerId: formData.get('providerId'),
    branchId: formData.get('branchId'),
    amount: formData.get('amount'),
    cashAccountId: formData.get('cashAccountId'),
    receiptRef: formData.get('receiptRef'),
    settlementDate: formData.get('settlementDate') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('post_agency_payable_settlement', {
    p_provider_id: input.providerId,
    p_branch_id: input.branchId,
    p_settlement_amount: input.amount,
    p_cash_account_id: input.cashAccountId,
    p_receipt_ref: input.receiptRef ?? null,
    p_settlement_date: input.settlementDate ?? null,
  });
  return settle(error, 'Remitting collections', 'Remittance recorded.', data);
}

export async function reversePayableSettlementAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reverse', 'agency.reverse');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(settlementReversalSchema, {
    settlementId: formData.get('settlementId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('reverse_agency_payable_settlement', {
    p_settlement_id: parsed.data.settlementId,
    p_reason: parsed.data.reason,
  });
  return settle(error, 'Reversing a remittance', 'Remittance reversed.', data);
}

export async function postFloatReplenishmentAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.replenish');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(floatReplenishmentSchema, {
    floatAccountId: formData.get('floatAccountId'),
    amount: formData.get('amount'),
    fundingAccountId: formData.get('fundingAccountId'),
    reference: formData.get('reference'),
    replenishmentDate: formData.get('replenishmentDate') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('post_float_replenishment', {
    p_float_account_id: input.floatAccountId,
    p_amount: input.amount,
    p_funding_account_id: input.fundingAccountId,
    p_reference: input.reference ?? null,
    p_replenishment_date: input.replenishmentDate ?? null,
  });
  return settle(error, 'Topping up a float till', 'Float replenished.', data);
}

// ===========================================================================
// Reconciliation
// ===========================================================================

export async function submitCashCountAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reconcile', 'agency.reconcile');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(cashCountSchema, {
    cashAccountId: formData.get('cashAccountId'),
    physicalCount: formData.get('physicalCount'),
    reconciliationDate: formData.get('reconciliationDate') ?? null,
    notes: formData.get('notes'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('submit_agency_cash_reconciliation', {
    p_cash_account_id: input.cashAccountId,
    p_physical_count: input.physicalCount,
    p_date: input.reconciliationDate ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Recording a cash count',
    'Count recorded. A second officer must certify it.',
    data,
  );
}

export async function approveCashCountAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reconcile', 'agency.reconcile_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(reconciliationApprovalSchema, {
    reconciliationId: formData.get('reconciliationId'),
    adjust: formData.get('adjust') === 'on' || formData.get('adjust') === 'true',
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  // Writing the difference off additionally needs agency:variance_adjustment,
  // which the database checks. It also refuses the officer who recorded the
  // count, and a count whose underlying balance has moved since.
  const { data, error } = await supabase.rpc('approve_agency_cash_reconciliation', {
    p_reconciliation_id: input.reconciliationId,
    p_adjust: input.adjust,
    p_reason: input.reason ?? null,
  });
  return settle(
    error,
    'Certifying a cash count',
    input.adjust ? 'Certified and the difference written off.' : 'Certified.',
    data,
  );
}

export async function submitFloatStatementAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reconcile', 'agency.reconcile');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(floatStatementSchema, {
    floatAccountId: formData.get('floatAccountId'),
    statementBalance: formData.get('statementBalance'),
    statementRef: formData.get('statementRef'),
    reconciliationDate: formData.get('reconciliationDate') ?? null,
    notes: formData.get('notes'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('submit_agency_float_reconciliation', {
    p_float_account_id: input.floatAccountId,
    p_statement_balance: input.statementBalance,
    p_statement_ref: input.statementRef ?? null,
    p_date: input.reconciliationDate ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Recording a float statement',
    'Statement recorded. A second officer must certify it.',
    data,
  );
}

export async function approveFloatStatementAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reconcile', 'agency.reconcile_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(reconciliationApprovalSchema, {
    reconciliationId: formData.get('reconciliationId'),
    adjust: formData.get('adjust') === 'on' || formData.get('adjust') === 'true',
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('approve_agency_float_reconciliation', {
    p_reconciliation_id: input.reconciliationId,
    p_adjust: input.adjust,
    p_reason: input.reason ?? null,
  });
  return settle(
    error,
    'Certifying a float statement',
    input.adjust ? 'Certified and the difference written off.' : 'Certified.',
    data,
  );
}
