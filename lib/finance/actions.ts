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
  confirmReceiptsSchema,
  depositReasonSchema,
  depositReturnSchema,
  recordDepositSchema,
  recordTransferSchema,
  rejectReconciliationSchema,
  verifyDepositSchema,
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

// ---------------------------------------------------------------------------
// Decision A — confirming cash received, and banking it
//
// Nothing below decides whether money is available. `confirm_cash_receipt`,
// `record_bank_deposit`, `verify_bank_deposit` and the rest read the balances
// and apply the rules themselves, inside the transaction that writes the
// document, under the account locks. An action that could pass an amount or
// an account the database did not check would be an action that could pay out
// money the business does not hold — which is the whole thing this module was
// added to prevent.
//
// Nor does anything below decide *who* may confirm. The refusal of a person
// confirming their own receipt is a CHECK constraint and a function raise, in
// that order; the capability check here only decides whether the screen
// should have offered the button.
// ---------------------------------------------------------------------------

export async function confirmCashReceiptsAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('receipts:confirm', 'finance.receipt_confirmation');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(confirmReceiptsSchema, {
    confirmationIds: formData.getAll('confirmationIds'),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('confirm_cash_receipts', {
    p_confirmation_ids: input.confirmationIds,
    p_note: input.note ?? null,
  });

  if (error !== null) {
    logger.warn('Receipts could not be confirmed.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  // The batch answers per receipt, because a drawer may hold one the
  // confirmer recorded themselves. Saying "12 confirmed" when one was refused
  // would be the kind of quiet half-success this module exists to avoid.
  const rows = Array.isArray(data) ? data : [];
  const confirmed = rows.filter((r) => r.outcome === 'confirmed').length;
  const refused = rows.length - confirmed;

  revalidateFinance();
  revalidatePath(ROUTES.receipts);

  if (refused > 0) {
    const first = rows.find((r) => r.outcome === 'refused')?.detail ?? '';
    return {
      ok: confirmed > 0,
      message:
        `${String(confirmed)} confirmed, ${String(refused)} refused. ` +
        (first === '' ? 'Somebody else must confirm those.' : first),
    };
  }

  return {
    ok: true,
    message:
      confirmed === 1
        ? 'Receipt confirmed. The money is now available.'
        : `${String(confirmed)} receipts confirmed. The money is now available.`,
  };
}

export async function recordBankDepositAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('deposits:create', 'finance.deposit');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(recordDepositSchema, {
    fromAccountId: formData.get('fromAccountId'),
    bankAccountId: formData.get('bankAccountId'),
    amount: formData.get('amount'),
    description: formData.get('description'),
    idempotencyKey: formData.get('idempotencyKey'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('record_bank_deposit', {
    p_from_account_id: input.fromAccountId,
    p_bank_account_id: input.bankAccountId,
    p_amount: input.amount,
    p_description: input.description ?? null,
    p_idempotency_key: input.idempotencyKey,
  });

  if (error !== null) {
    logger.warn('A bank deposit could not be recorded.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  revalidatePath(ROUTES.deposits);

  return {
    ok: true,
    recordId: typeof data === 'string' ? data : undefined,
    // Said plainly, because a cashier who believes the bank already has it
    // will reconcile against the wrong figure.
    message: 'Deposit recorded. The money is in transit and cannot be spent yet.',
  };
}

export async function verifyBankDepositAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('deposits:verify', 'finance.deposit_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(verifyDepositSchema, {
    depositId: formData.get('depositId'),
    bankReference: formData.get('bankReference'),
    bankValueDate: formData.get('bankValueDate'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('verify_bank_deposit', {
    p_deposit_id: input.depositId,
    p_bank_reference: input.bankReference,
    p_bank_value_date: input.bankValueDate,
    p_deposit_slip_path: null,
    p_notes: input.notes ?? null,
  });

  if (error !== null) {
    logger.warn('A bank clearance could not be verified.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  revalidatePath(ROUTES.deposits);

  return { ok: true, message: 'Clearance verified. The money is now in the bank.' };
}

export async function openDepositInvestigationAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('deposits:verify', 'finance.deposit_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(depositReasonSchema, {
    depositId: formData.get('depositId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('open_deposit_investigation', {
    p_deposit_id: parsed.data.depositId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A deposit investigation could not be opened.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  revalidatePath(ROUTES.deposits);

  return {
    ok: true,
    // No journal was posted and the money has not moved. Saying so is the
    // difference between an investigation and a pretended recovery.
    message: 'Investigation opened. The money stays in transit until it is found.',
  };
}

export async function confirmCashReturnAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('deposits:verify', 'finance.deposit_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(depositReturnSchema, {
    depositId: formData.get('depositId'),
    evidenceNote: formData.get('evidenceNote'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('confirm_physical_cash_return', {
    p_deposit_id: parsed.data.depositId,
    p_evidence_note: parsed.data.evidenceNote,
  });

  if (error !== null) {
    logger.warn('A physical cash return could not be confirmed.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  revalidatePath(ROUTES.deposits);

  return { ok: true, message: 'Return confirmed. The cash is back in the till.' };
}

export async function reverseBankClearanceAction(
  _previous: FinanceActionResult | undefined,
  formData: FormData,
): Promise<FinanceActionResult> {
  const allowed = await authorize('deposits:reverse', 'finance.deposit_decision');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(depositReasonSchema, {
    depositId: formData.get('depositId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('reverse_bank_clearance', {
    p_deposit_id: parsed.data.depositId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A bank clearance could not be reversed.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateFinance();
  revalidatePath(ROUTES.deposits);

  return { ok: true, message: 'Clearance reversed. The money is back in transit.' };
}
