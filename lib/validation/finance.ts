/**
 * Validation for money movement.
 *
 * Shape here, policy in the database — the same division as
 * `lib/validation/payment.ts`, and for the same reason. Whether Cash at Hand
 * holds enough to cover a transfer, whether an amount is above the approval
 * threshold, whether an account is a cash account at all: every one of those
 * depends on state that can change between the form rendering and the button
 * being pressed, so checking it here would be checking a stale fact.
 *
 * `record_transfer`, `record_expense`, `record_other_income` and
 * `submit_reconciliation` re-evaluate all of it at the moment of posting,
 * against locked rows, inside the transaction that writes the journal.
 *
 * What this layer refuses is input that could not be right under any state:
 * a blank description, a negative amount, a date in the wrong century, a
 * status word that does not exist.
 */

import { z } from 'zod';

import {
  businessDateSchema,
  nonEmptyString,
  optionalString,
  ugxAmountFromText,
  uuidSchema,
} from './common';

/**
 * An amount of money moving, in whole shillings.
 *
 * The hardened text parser, so `500,00` is refused rather than silently
 * becoming UGX 50,000 — the same trap the payment amount closes.
 */
export const movementAmountSchema = ugxAmountFromText({
  empty: 'Enter the amount.',
  malformed:
    'Enter a whole number of shillings, for example 500000 or 500,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'Enter an amount greater than zero.',
});

/**
 * A count, which may legitimately be zero.
 *
 * An empty drawer is a real and important thing to record, so this is the one
 * figure in the module that does not have to be positive.
 */
export const countedBalanceSchema = ugxAmountFromText({
  empty: 'Enter the amount counted.',
  malformed:
    'Enter a whole number of shillings, for example 500000 or 500,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'A count cannot be negative.',
  allowZero: true,
});

/** The other side's reference: a deposit slip, a wallet transaction id. */
export const movementReferenceSchema = optionalString(64);

const descriptionSchema = nonEmptyString('Description', 500);

const reasonSchema = nonEmptyString('Reason', 500).refine(
  (value) => value.trim().length >= 4,
  { message: 'Say briefly why. Four characters is not a reason anybody can act on.' },
);

export const recordTransferSchema = z
  .object({
    fromAccountId: uuidSchema,
    toAccountId: uuidSchema,
    amount: movementAmountSchema,
    transferDate: businessDateSchema,
    description: descriptionSchema,
    externalReference: movementReferenceSchema,
  })
  // Caught here as well as in the database so the form can say it against the
  // field rather than through a posting failure.
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: 'Choose two different accounts.',
    path: ['toAccountId'],
  });

export type RecordTransferInput = z.infer<typeof recordTransferSchema>;

export const transferDecisionSchema = z.object({
  transferId: uuidSchema,
  reason: reasonSchema,
});

export const approveTransferSchema = z.object({
  transferId: uuidSchema,
});

export const recordExpenseSchema = z.object({
  expenseAccountId: uuidSchema,
  paymentAccountId: uuidSchema,
  amount: movementAmountSchema,
  expenseDate: businessDateSchema,
  description: descriptionSchema,
  payee: optionalString(160),
  externalReference: movementReferenceSchema,
  receiptPath: optionalString(400),
});

export type RecordExpenseInput = z.infer<typeof recordExpenseSchema>;

export const expenseDecisionSchema = z.object({
  expenseId: uuidSchema,
  reason: reasonSchema,
});

export const approveExpenseSchema = z.object({
  expenseId: uuidSchema,
});

export const recordIncomeSchema = z.object({
  incomeAccountId: uuidSchema,
  receivingAccountId: uuidSchema,
  amount: movementAmountSchema,
  incomeDate: businessDateSchema,
  description: descriptionSchema,
  payer: optionalString(160),
  clientId: uuidSchema.optional().nullable(),
  loanId: uuidSchema.optional().nullable(),
  externalReference: movementReferenceSchema,
});

export type RecordIncomeInput = z.infer<typeof recordIncomeSchema>;

export const incomeDecisionSchema = z.object({
  incomeId: uuidSchema,
  reason: reasonSchema,
});

export const submitReconciliationSchema = z.object({
  accountId: uuidSchema,
  businessDate: businessDateSchema,
  countedBalance: countedBalanceSchema,
  explanation: optionalString(500),
});

export type SubmitReconciliationInput = z.infer<typeof submitReconciliationSchema>;

export const reconciliationDecisionSchema = z.object({
  reconciliationId: uuidSchema,
  notes: optionalString(500),
});

export const rejectReconciliationSchema = z.object({
  reconciliationId: uuidSchema,
  reason: reasonSchema,
});
