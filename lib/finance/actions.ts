'use server';

/**
 * Moving the company's own money, as trusted server-side operations.
 *
 * Every function does the same four things in order: confirm a session and
 * its capability, rate-limit the actor, validate the shape of the input, and
 * hand the decision to the database — which runs as the caller, so Row Level
 * Security, the posting function's own rules and the approval threshold all
 * apply whatever this module believes.
 *
 * ## Nothing here writes a journal
 *
 * No function below constructs a debit or a credit. `record_transfer`,
 * `record_expense`, `record_other_income` and `submit_reconciliation` do,
 * from figures they read themselves, inside the transaction that writes the
 * document. An action that could supply the legs could post a transfer that
 * credited nothing, or an expense that debited income.
 *
 * ## Nothing here decides whether approval is needed
 *
 * The threshold lives in `finance_settings` and is read inside the posting
 * function. A caller that could decide would be a caller that could opt out.
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
  approveExpenseSchema,
  approveTransferSchema,
  expenseDecisionSchema,
  incomeDecisionSchema,
  reconciliationDecisionSchema,
  recordExpenseSchema,
  recordIncomeSchema,
  recordTransferSchema,
  rejectReconciliationSchema,
  submitReconciliationSchema,
  transferDecisionSchema,
} from '@/lib/validation/finance';
import type { ActionResult } from '@/lib/auth/actions';
import type { Permission } from '@/lib/permissions';
import type { RateLimitedAction } from '@/lib/security/rate-limit';

export interface FinanceActionResult extends ActionResult {
  /** The document the action created or acted on, for a redirect. */
  readonly recordId?: string;
}

const INVALID = 'Please check the highlighted fields.';

/** Every finance screen that could be showing a figure this action moved. */
function revalidateFinance(): void {
  revalidatePath(ROUTES.finance);
  revalidatePath(ROUTES.transfers);
  revalidatePath(ROUTES.expenses);
  revalidatePath(ROUTES.otherIncome);
  revalidatePath(ROUTES.reconciliation);
  revalidatePath(ROUTES.dashboard);
}

/**
 * The preamble every action shares: capability, then rate limit.
 *
 * Written once because four modules repeating it is four chances to leave
 * one of them out, and the one left out is the one that matters.
 */
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

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export async function recordTransferAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('transfers:create', 'finance.transfer');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(recordTransferSchema, {
    fromAccountId: formData.get('fromAccountId'),
    toAccountId: formData.get('toAccountId'),
    amount: formData.get('amount'),
    transferDate: formData.get('transferDate'),
    description: formData.get('description'),
    externalReference: formData.get('externalReference'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('record_transfer', {
    p_from_account_id: input.fromAccountId,
    p_to_account_id: input.toAccountId,
    p_amount: input.amount,
    p_transfer_date: input.transferDate,
    p_description: input.description,
    p_external_reference: input.externalReference ?? null,
  });

  if (error !== null) {
    logger.warn('A transfer could not be recorded.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();

  return {
    ok: true,
    // Deliberately non-committal about whether it posted: the threshold
    // decides, in the database, and the register says which happened.
    message: 'Transfer recorded.',
    recordId: typeof data === 'string' ? data : undefined,
  };
}

export async function approveTransferAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('transfers:approve', 'finance.transfer_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(approveTransferSchema, {
    transferId: formData.get('transferId'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('approve_transfer', {
    p_transfer_id: parsed.data.transferId,
  });

  if (error !== null) {
    logger.warn('A transfer could not be approved.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return { ok: true, message: 'Transfer approved and posted.' };
}

export async function rejectTransferAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('transfers:approve', 'finance.transfer_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(transferDecisionSchema, {
    transferId: formData.get('transferId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reject_transfer', {
    p_transfer_id: parsed.data.transferId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A transfer could not be rejected.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return { ok: true, message: 'Transfer rejected. Nothing was posted.' };
}

export async function reverseTransferAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('transfers:approve', 'finance.transfer_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(transferDecisionSchema, {
    transferId: formData.get('transferId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reverse_transfer', {
    p_transfer_id: parsed.data.transferId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A transfer could not be reversed.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return {
    ok: true,
    message:
      'Transfer reversed. The original posting stands, cancelled by a contra entry.',
  };
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export async function recordExpenseAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('expenses:create', 'finance.expense');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(recordExpenseSchema, {
    expenseAccountId: formData.get('expenseAccountId'),
    paymentAccountId: formData.get('paymentAccountId'),
    amount: formData.get('amount'),
    expenseDate: formData.get('expenseDate'),
    description: formData.get('description'),
    payee: formData.get('payee'),
    externalReference: formData.get('externalReference'),
    receiptPath: formData.get('receiptPath'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('record_expense', {
    p_expense_account_id: input.expenseAccountId,
    p_payment_account_id: input.paymentAccountId,
    p_amount: input.amount,
    p_expense_date: input.expenseDate,
    p_description: input.description,
    p_payee: input.payee ?? null,
    p_external_reference: input.externalReference ?? null,
    p_receipt_path: input.receiptPath ?? null,
  });

  if (error !== null) {
    logger.warn('An expense could not be recorded.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();

  return {
    ok: true,
    message: 'Expense recorded.',
    recordId: typeof data === 'string' ? data : undefined,
  };
}

export async function approveExpenseAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('expenses:approve', 'finance.expense_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(approveExpenseSchema, {
    expenseId: formData.get('expenseId'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('approve_expense', {
    p_expense_id: parsed.data.expenseId,
  });

  if (error !== null) {
    logger.warn('An expense could not be approved.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return { ok: true, message: 'Expense approved and posted.' };
}

export async function rejectExpenseAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('expenses:approve', 'finance.expense_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(expenseDecisionSchema, {
    expenseId: formData.get('expenseId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reject_expense', {
    p_expense_id: parsed.data.expenseId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('An expense could not be rejected.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return { ok: true, message: 'Expense rejected. Nothing was posted.' };
}

export async function reverseExpenseAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('expenses:approve', 'finance.expense_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(expenseDecisionSchema, {
    expenseId: formData.get('expenseId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reverse_expense', {
    p_expense_id: parsed.data.expenseId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('An expense could not be reversed.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return {
    ok: true,
    message:
      'Expense reversed. The original posting stands, cancelled by a contra entry.',
  };
}

// ---------------------------------------------------------------------------
// Other income
// ---------------------------------------------------------------------------

export async function recordIncomeAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('income:create', 'finance.income');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(recordIncomeSchema, {
    incomeAccountId: formData.get('incomeAccountId'),
    receivingAccountId: formData.get('receivingAccountId'),
    amount: formData.get('amount'),
    incomeDate: formData.get('incomeDate'),
    description: formData.get('description'),
    payer: formData.get('payer'),
    clientId: formData.get('clientId') === '' ? null : formData.get('clientId'),
    loanId: formData.get('loanId') === '' ? null : formData.get('loanId'),
    externalReference: formData.get('externalReference'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('record_other_income', {
    p_income_account_id: input.incomeAccountId,
    p_receiving_account_id: input.receivingAccountId,
    p_amount: input.amount,
    p_income_date: input.incomeDate,
    p_description: input.description,
    p_payer: input.payer ?? null,
    p_client_id: input.clientId ?? null,
    p_loan_id: input.loanId ?? null,
    p_external_reference: input.externalReference ?? null,
  });

  if (error !== null) {
    logger.warn('Income could not be recorded.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();

  return {
    ok: true,
    message: 'Income recorded.',
    recordId: typeof data === 'string' ? data : undefined,
  };
}

export async function reverseIncomeAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('income:create', 'finance.income');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(incomeDecisionSchema, {
    incomeId: formData.get('incomeId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reverse_other_income', {
    p_income_id: parsed.data.incomeId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('Income could not be reversed.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return {
    ok: true,
    message: 'Income reversed. The original posting stands, cancelled by a contra entry.',
  };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export async function submitReconciliationAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('reconciliation:perform', 'finance.reconciliation');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(submitReconciliationSchema, {
    accountId: formData.get('accountId'),
    businessDate: formData.get('businessDate'),
    countedBalance: formData.get('countedBalance'),
    explanation: formData.get('explanation'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('submit_reconciliation', {
    p_account_id: input.accountId,
    p_business_date: input.businessDate,
    p_counted_balance: input.countedBalance,
    p_explanation: input.explanation ?? null,
  });

  if (error !== null) {
    logger.warn('A reconciliation could not be recorded.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();

  return {
    ok: true,
    // What happened next depends on whether the count agreed, which the
    // register shows. Claiming either outcome here would be guessing.
    message: 'Count recorded.',
    recordId: typeof data === 'string' ? data : undefined,
  };
}

export async function approveReconciliationAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize(
    'reconciliation:approve',
    'finance.reconciliation_decision',
  );
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(reconciliationDecisionSchema, {
    reconciliationId: formData.get('reconciliationId'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('approve_reconciliation', {
    p_reconciliation_id: parsed.data.reconciliationId,
    p_notes: parsed.data.notes ?? null,
  });

  if (error !== null) {
    logger.warn('A reconciliation could not be approved.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return {
    ok: true,
    message: 'Difference written off to Cash Over and Short by an explicit journal.',
  };
}

export async function rejectReconciliationAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize(
    'reconciliation:approve',
    'finance.reconciliation_decision',
  );
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(rejectReconciliationSchema, {
    reconciliationId: formData.get('reconciliationId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reject_reconciliation', {
    p_reconciliation_id: parsed.data.reconciliationId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A reconciliation could not be rejected.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  return {
    ok: true,
    message: 'Rejected. The difference is still outstanding and the ledger is unchanged.',
  };
}
