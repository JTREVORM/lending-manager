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
  agentLineClosureSchema,
  agentLineRegistrationSchema,
  agentLineSuspensionSchema,
  agentLineUpdateSchema,
  verifyAgencyTransactionSchema,
  agencyTransactionReasonSchema,
  cashCountSchema,
  commissionExceptionSchema,
  commissionPayoutSchema,
  commissionReconciliationDecisionSchema,
  commissionReconciliationSchema,
  commissionRecoverySchema,
  commissionSettlementSchema,
  commissionSourceSchema,
  correctReferenceSchema,
  floatReplenishmentSchema,
  floatStatementSchema,
  floatTradeReasonSchema,
  floatTradeSchema,
  floatTradeVerificationSchema,
  payableSettlementSchema,
  reconciliationApprovalSchema,
  recordAgencyTransactionSchema,
  cashBankingReasonSchema,
  cashBankingSchema,
  cashBankingVerificationSchema,
  serviceLimitSchema,
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
    // The Agency redesign's screens. A cash banking moves the branch cash
    // position, which the banking overview and the consolidated report both
    // lead with, so both are stale the moment one posts.
    ROUTES.agencyBanking,
    ROUTES.agencyBankingAccounts,
    ROUTES.agencyCashBanking,
    ROUTES.agencyTransfers,
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

/**
 * The shared tail: map the refusal, or revalidate and report.
 *
 * ## Why a `P0001` keeps its own words here
 *
 * `mapDatabaseError` replaces every database message with a sentence of its
 * own, and it is right to: PostgreSQL's own errors carry table names, column
 * names, constraint names and row values, none of which belong in a browser.
 *
 * But `P0001` is not PostgreSQL's. It is the SQLSTATE of an explicit
 * `raise exception`, so every one of them is a sentence this project wrote -
 * and in the agency engine they are written for the officer at the counter:
 *
 *   "The financial details of this transaction changed since your screen
 *    loaded (you reviewed revision 1, it is now revision 2). Reload and
 *    review the current values before verifying."
 *
 * The generic mapping turns that into "That action is not permitted on this
 * record", which tells a manager they lack permission when what actually
 * happened is that an Owner changed the commission while their screen was
 * open. They would ask for a capability they already have, and the
 * transaction would sit unposted. Phase 4D-F found this with a browser, and
 * it is the difference between a refusal that teaches and one that misleads.
 *
 * Everything else still goes through the mapper, so a unique violation, a
 * check constraint or an RLS denial never reaches a user in the database's
 * words.
 */
function settle(
  error: { code?: string; message: string } | null,
  what: string,
  success: string,
  recordId?: unknown,
): AgencyActionResult {
  if (error !== null) {
    logger.warn(`${what} was refused.`, { code: error.code });
    if (error.code === 'P0001' && error.message.trim() !== '') {
      return { ok: false, message: error.message };
    }
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
    branchId: formData.get('branchId') ?? null,
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
    // Null when the officer has a branch of their own: the database uses it,
    // and refuses any other. Named when they have none, and refused when
    // they have none and name nothing — there is no fallback.
    p_branch_id: input.branchId ?? null,
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

  const parsed = parseSafely(verifyAgencyTransactionSchema, {
    transactionId: formData.get('transactionId'),
    reviewedRevision: formData.get('reviewedRevision'),
  });
  if (!parsed.success) return { ok: false, message: INVALID };

  const supabase = await createSupabaseServerClient();
  // Posts the journal. The database refuses an officer verifying their own
  // entry, a provisional or inactive provider, insufficient cash or float,
  // and a bank payable that would go into net debit.
  //
  // `reviewedRevision` is the revision the screen was rendered from. The
  // database refuses the posting if the figures have moved since - an Owner
  // authorising a commission exception behind an open screen, say - so the
  // manager reloads and sees what they are approving. Passing it is not a
  // substitute for that check: the database compares it with the row it
  // locks, and refuses a call that quotes nothing just as firmly once the
  // figures have changed after submission.
  const { data, error } = await supabase.rpc('verify_agency_transaction', {
    p_transaction_id: parsed.data.transactionId,
    p_expected_revision: parsed.data.reviewedRevision,
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

// ===========================================================================
// Phase 4E — Mobile Money
//
// Thirteen more operations, each doing the same four things in the same
// order, and each handing the decision to a database function that refuses
// the same thing again. Three are worth a word.
//
// `recordFloatTradeAction` posts nothing. It writes a pending row, and a
// pending row moves no balance because nothing writes a journal until
// `verifyFloatTradeAction` — which is a *different* capability held by a
// different person, and the data layer refuses the same person doing both.
//
// `verifyFloatTradeAction` sends the revision the officer was shown, for the
// same reason `verifyAgencyTransactionAction` does: a verifier must not post
// figures that changed while their screen was open.
//
// `certifyCommissionReconciliationAction` moves no money at all, by design.
// Decision OD-2: a reconciliation never posts a financial change.
// ===========================================================================

export async function recordFloatTradeAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:float_trade', 'agency.float_trade');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(floatTradeSchema, {
    kind: formData.get('kind'),
    floatAccountId: formData.get('floatAccountId'),
    floatAmount: formData.get('floatAmount'),
    reference: formData.get('reference'),
    counterFloatAccountId: formData.get('counterFloatAccountId') ?? null,
    settlementAccountId: formData.get('settlementAccountId') ?? null,
    cashAmount: formData.get('cashAmount') ?? null,
    feeAmount: formData.get('feeAmount') ?? null,
    sourceKind: formData.get('sourceKind') ?? null,
    counterpartyName: formData.get('counterpartyName') ?? null,
    tradeDate: formData.get('tradeDate') ?? null,
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_agency_float_trade', {
    p_kind: input.kind,
    p_float_account_id: input.floatAccountId,
    p_float_amount: input.floatAmount,
    p_reference: input.reference,
    p_counter_float_account_id: input.counterFloatAccountId ?? null,
    p_settlement_account_id: input.settlementAccountId ?? null,
    p_cash_amount: input.cashAmount ?? null,
    p_fee_amount: input.feeAmount ?? null,
    p_source_kind: input.sourceKind ?? null,
    p_counterparty_name: input.counterpartyName ?? null,
    p_trade_date: input.tradeDate ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Recording a float trade',
    'Recorded, and waiting for a second officer. Nothing has moved yet.',
    data,
  );
}

export async function verifyFloatTradeAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(floatTradeVerificationSchema, {
    tradeId: formData.get('tradeId'),
    expectedRevision: formData.get('expectedRevision') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('verify_agency_float_trade', {
    p_trade_id: parsed.data.tradeId,
    p_expected_revision: parsed.data.expectedRevision ?? null,
  });
  return settle(error, 'Posting a float trade', 'Float trade posted.', data);
}

export async function rejectFloatTradeAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(floatTradeReasonSchema, {
    tradeId: formData.get('tradeId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reject_agency_float_trade', {
    p_trade_id: parsed.data.tradeId,
    p_reason: parsed.data.reason,
  });
  return settle(
    error,
    'Rejecting a float trade',
    'Refused, with your reason on the record. Nothing was posted.',
  );
}

export async function reverseFloatTradeAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reverse', 'agency.reverse');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(floatTradeReasonSchema, {
    tradeId: formData.get('tradeId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('reverse_agency_float_trade', {
    p_trade_id: parsed.data.tradeId,
    p_reason: parsed.data.reason,
  });
  return settle(
    error,
    'Reversing a float trade',
    'Reversed. Both entries are kept and the balances are restored.',
    data,
  );
}

export async function recordCommissionPayoutAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionPayoutSchema, {
    floatAccountId: formData.get('floatAccountId'),
    amount: formData.get('amount'),
    providerReference: formData.get('providerReference'),
    payoutDate: formData.get('payoutDate') ?? null,
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_agency_commission_payout', {
    p_float_account_id: input.floatAccountId,
    p_amount: input.amount,
    p_provider_reference: input.providerReference,
    p_payout_date: input.payoutDate ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Recording a commission payout',
    'Commission recorded against the line, and the receivable is cleared by that much.',
    data,
  );
}

export async function recordCommissionRecoveryAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionRecoverySchema, {
    floatAccountId: formData.get('floatAccountId'),
    amount: formData.get('amount'),
    method: formData.get('method'),
    providerReference: formData.get('providerReference'),
    recoveryDate: formData.get('recoveryDate') ?? null,
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_agency_commission_recovery', {
    p_float_account_id: input.floatAccountId,
    p_amount: input.amount,
    p_method: input.method,
    p_provider_reference: input.providerReference,
    p_recovery_date: input.recoveryDate ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Recording a commission recovery',
    'Recovery recorded, and what was owed back is lower by that much.',
    data,
  );
}

export async function submitCommissionReconciliationAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reconcile', 'agency.reconcile');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionReconciliationSchema, {
    floatAccountId: formData.get('floatAccountId'),
    periodStart: formData.get('periodStart'),
    periodEnd: formData.get('periodEnd'),
    providerReportedCommission: formData.get('providerReportedCommission'),
    statementRef: formData.get('statementRef'),
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('submit_agency_commission_reconciliation', {
    p_float_account_id: input.floatAccountId,
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_provider_reported_commission: input.providerReportedCommission,
    p_statement_ref: input.statementRef,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Reconciling a commission statement',
    'Statement recorded against the books. Nothing has been posted.',
    data,
  );
}

export async function certifyCommissionReconciliationAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reconcile', 'agency.reconcile_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionReconciliationDecisionSchema, {
    reconciliationId: formData.get('reconciliationId'),
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('certify_agency_commission_reconciliation', {
    p_reconciliation_id: parsed.data.reconciliationId,
    p_notes: parsed.data.notes ?? null,
  });
  return settle(
    error,
    'Certifying a commission statement',
    'Certified. No balance changed: a difference is corrected at the transaction, not here.',
  );
}

// ---------------------------------------------------------------------------
// Agent line administration — the Owner's
// ---------------------------------------------------------------------------

export async function registerAgentLineAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:providers', 'agency.configure');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agentLineRegistrationSchema, {
    providerId: formData.get('providerId'),
    branchId: formData.get('branchId'),
    tillName: formData.get('tillName'),
    label: formData.get('label') ?? null,
    lineMsisdn: formData.get('lineMsisdn') ?? null,
    agentCode: formData.get('agentCode') ?? null,
    openedOn: formData.get('openedOn') ?? null,
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('register_agency_agent_line', {
    p_provider_id: input.providerId,
    p_branch_id: input.branchId,
    p_till_name: input.tillName,
    p_label: input.label ?? null,
    p_line_msisdn: input.lineMsisdn ?? null,
    p_agent_code: input.agentCode ?? null,
    p_opened_on: input.openedOn ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(
    error,
    'Registering an agent line',
    'Agent line registered, with its own float account.',
    data,
  );
}

export async function updateAgentLineAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:providers', 'agency.configure');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agentLineUpdateSchema, {
    floatAccountId: formData.get('floatAccountId'),
    label: formData.get('label') ?? null,
    lineMsisdn: formData.get('lineMsisdn') ?? null,
    agentCode: formData.get('agentCode') ?? null,
    notes: formData.get('notes') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('update_agency_agent_line', {
    p_float_account_id: input.floatAccountId,
    p_label: input.label ?? null,
    p_line_msisdn: input.lineMsisdn ?? null,
    p_agent_code: input.agentCode ?? null,
    p_notes: input.notes ?? null,
  });
  return settle(error, 'Editing an agent line', 'Agent line updated.');
}

export async function setAgentLineSuspendedAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:providers', 'agency.configure');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agentLineSuspensionSchema, {
    floatAccountId: formData.get('floatAccountId'),
    suspended: formData.get('suspended'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_agency_agent_line_suspended', {
    p_float_account_id: input.floatAccountId,
    p_suspended: input.suspended,
    p_reason: input.reason,
  });
  return settle(
    error,
    input.suspended ? 'Suspending an agent line' : 'Reinstating an agent line',
    input.suspended
      ? 'Suspended. New business stops at once; the float and the history remain, and can still be moved off.'
      : 'Reinstated. The line is trading again.',
  );
}

export async function closeAgentLineAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:providers', 'agency.configure');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(agentLineClosureSchema, {
    floatAccountId: formData.get('floatAccountId'),
    reason: formData.get('reason'),
    closedOn: formData.get('closedOn') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('close_agency_agent_line', {
    p_float_account_id: input.floatAccountId,
    p_reason: input.reason,
    p_closed_on: input.closedOn ?? null,
  });
  return settle(error, 'Closing an agent line', 'Agent line closed.');
}

export async function setServiceLimitAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:providers', 'agency.configure');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(serviceLimitSchema, {
    transactionTypeId: formData.get('transactionTypeId'),
    maxSingleTransaction: formData.get('maxSingleTransaction'),
    reason: formData.get('reason') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('set_agency_service_limit', {
    p_transaction_type_id: input.transactionTypeId,
    p_max_single_transaction: input.maxSingleTransaction,
    p_reason: input.reason ?? null,
  });
  return settle(
    error,
    'Setting a service ceiling',
    'Ceiling set. The service can now be posted against.',
    data,
  );
}

export async function setCommissionSourceAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:providers', 'agency.configure');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(commissionSourceSchema, {
    providerId: formData.get('providerId'),
    source: formData.get('source'),
    reason: formData.get('reason') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('set_agency_provider_commission_source', {
    p_provider_id: input.providerId,
    p_source: input.source,
    p_reason: input.reason ?? null,
  });
  return settle(
    error,
    "Setting a provider's commission source",
    input.source === 'reported'
      ? 'Commission will be taken from each transaction’s confirmation message.'
      : "Commission will be computed from the provider's configured terms.",
    data,
  );
}

// ---------------------------------------------------------------------------
// Cash banking — the Agency redesign, client Rule 5
//
// Four actions and a strict division between them: recording writes a pending
// document and posts nothing, and exactly one of the other three posts. That
// is the maker-checker control, and it is enforced by the database — which
// refuses the person who recorded a banking from posting it, whatever these
// functions do. Neither the amount banked nor the charge is turned into a
// debit or a credit here; `verify_agency_cash_banking()` builds the legs from
// the row it locks.
// ---------------------------------------------------------------------------

/**
 * Record an agent's deposit of collected cash into a company bank account.
 *
 * Takes `agency:write`, the counter capability, because the person who fills
 * this in is the one who banked the money. Nothing moves until a second
 * officer posts it.
 */
export async function recordCashBankingAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:write', 'agency.record');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(cashBankingSchema, {
    bankAccountId: formData.get('bankAccountId'),
    amount: formData.get('amount'),
    depositReference: formData.get('depositReference'),
    bankedBy: formData.get('bankedBy') ?? null,
    charge: formData.get('charge') ?? null,
    bankingDate: formData.get('bankingDate') ?? null,
    evidenceNote: formData.get('evidenceNote') ?? null,
    notes: formData.get('notes') ?? null,
    branchId: formData.get('branchId') ?? null,
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_agency_cash_banking', {
    p_bank_account_id: input.bankAccountId,
    p_amount: input.amount,
    p_reference: input.depositReference,
    p_banked_by: input.bankedBy ?? null,
    p_charge: input.charge ?? 0,
    p_banking_date: input.bankingDate ?? null,
    p_evidence_note: input.evidenceNote ?? null,
    p_notes: input.notes ?? null,
    p_branch_id: input.branchId ?? null,
  });

  return settle(
    error,
    'Recording a cash banking',
    'Recorded, and waiting for a second officer. No cash has moved yet.',
    data,
  );
}

/**
 * Post a recorded cash banking.
 *
 * Takes `agency:settlements`. The database refuses the person who recorded it
 * and compares the revision the screen was showing against the row it locks,
 * so a figure cannot change between the screen and the click.
 */
export async function verifyCashBankingAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(cashBankingVerificationSchema, {
    bankingId: formData.get('bankingId'),
    reviewedRevision: formData.get('reviewedRevision'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('verify_agency_cash_banking', {
    p_banking_id: parsed.data.bankingId,
    p_expected_revision: parsed.data.reviewedRevision,
  });

  return settle(
    error,
    'Posting a cash banking',
    'Posted. The cash has moved from the till to the bank account.',
    parsed.data.bankingId,
  );
}

/** Reject a recorded cash banking, with a reason. Posts nothing. */
export async function rejectCashBankingAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:settlements', 'agency.settlement');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(cashBankingReasonSchema, {
    bankingId: formData.get('bankingId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reject_agency_cash_banking', {
    p_banking_id: parsed.data.bankingId,
    p_reason: parsed.data.reason,
  });

  return settle(
    error,
    'Rejecting a cash banking',
    'Rejected, with your reason on the record. Nothing was posted.',
    parsed.data.bankingId,
  );
}

/**
 * Reverse a posted cash banking by contra entries.
 *
 * Takes `agency:reverse`, and the database additionally requires
 * `agency:reverse_cross_day` for a banking dated before today. The original
 * journal is never touched.
 */
export async function reverseCashBankingAction(
  _previous: AgencyActionResult | undefined,
  formData: FormData,
): Promise<AgencyActionResult> {
  const allowed = await authorize('agency:reverse', 'agency.reverse');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(cashBankingReasonSchema, {
    bankingId: formData.get('bankingId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reverse_agency_cash_banking', {
    p_banking_id: parsed.data.bankingId,
    p_reason: parsed.data.reason,
  });

  return settle(
    error,
    'Reversing a cash banking',
    'Reversed by contra entries. The original posting is unchanged.',
    parsed.data.bankingId,
  );
}
