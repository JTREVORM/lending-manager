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
  basisPointsSchema,
  businessDateSchema,
  nonEmptyString,
  optionalField,
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

// ---------------------------------------------------------------------------
// Decision A — confirming cash, and banking it
// ---------------------------------------------------------------------------

/**
 * One or more receipts a second officer has counted.
 *
 * A list rather than a single id because confirming is end-of-day work over a
 * whole drawer, and the database performs every per-receipt check inside the
 * batch — the ones this officer recorded themselves are refused by name and
 * the rest are confirmed. Capped so a form cannot ask the database to walk
 * the register.
 */
export const confirmReceiptsSchema = z.object({
  confirmationIds: z
    .array(uuidSchema)
    .min(1, { message: 'Choose at least one receipt to confirm.' })
    .max(200, { message: 'Confirm at most 200 receipts at a time.' }),
  note: optionalString(500),
});

export const recordDepositSchema = z.object({
  fromAccountId: uuidSchema,
  bankAccountId: uuidSchema,
  amount: movementAmountSchema,
  description: optionalString(500),
  idempotencyKey: uuidSchema,
});

/**
 * The bank's own evidence that the money arrived.
 *
 * The value date is the bank's, and may be earlier than today — a credit
 * dated Friday is verified on Monday. It may not be later, because a bank
 * cannot have valued money it has not yet received. The accounting entry is
 * dated today whatever this says; the database decides that, not the form.
 */
export const verifyDepositSchema = z.object({
  depositId: uuidSchema,
  bankReference: nonEmptyString('Bank reference', 64).refine(
    (value) => value.trim().length >= 4,
    { message: 'Enter the reference the bank gave for the credit.' },
  ),
  bankValueDate: businessDateSchema,
  notes: optionalString(500),
});

export const depositReasonSchema = z.object({
  depositId: uuidSchema,
  reason: reasonSchema,
});

export const depositReturnSchema = z.object({
  depositId: uuidSchema,
  evidenceNote: nonEmptyString('Evidence', 500).refine(
    (value) => value.trim().length >= 4,
    {
      message:
        'Record what was physically handed back, by whom and when. A return nobody described is not evidence.',
    },
  ),
});

// ===========================================================================
// Operational task 3 — the money the business was started and funded with
//
// Shape only, as above. Whether the destination is a cash or bank account of
// the right branch, whether the capital account is in the right half of the
// balance sheet, whether the officer verifying is the one who recorded it:
// `capital_funding_accounts_guard()` and `verify_capital_funding()` decide all
// of it, under lock, in the transaction that writes the journal.
// ===========================================================================

/**
 * Recording that capital arrived.
 *
 * `fundedOn` is the date the evidence bears and may be years old — that is
 * how an opening balance is recorded. It may not be in the future, because
 * capital cannot be recorded before it arrives. The journal is dated the day
 * it is verified whatever this says; the database decides that, not the form.
 *
 * The borrowing terms are refused on an equity contribution here as well as
 * in the database, because a form that accepted a repayment date and then
 * lost it would be worse than one that explains why it cannot.
 */
export const recordCapitalFundingSchema = z
  .object({
    fundingKind: z.enum(['equity', 'borrowing']),
    amount: movementAmountSchema,
    destinationAccountId: uuidSchema,
    capitalAccountId: uuidSchema,
    funderName: nonEmptyString('Who provided it', 120),
    fundedOn: businessDateSchema,
    evidenceKind: z.enum([
      'bank_transfer',
      'cash_deposit',
      'cheque',
      'mobile_money',
      'other',
    ]),
    evidenceReference: nonEmptyString('Evidence reference', 120).refine(
      (value) => value.trim().length >= 2,
      { message: 'Enter the reference on the slip, transfer or cheque.' },
    ),
    interestRateBps: optionalField(basisPointsSchema),
    repaymentDueOn: optionalField(businessDateSchema),
    description: optionalString(500),
    idempotencyKey: uuidSchema,
  })
  .refine(
    (value) =>
      value.fundingKind !== 'equity' ||
      (value.interestRateBps === undefined && value.repaymentDueOn === undefined),
    {
      path: ['interestRateBps'],
      error:
        'A contribution of the owner’s own money is not repayable and carries no interest. Record it as a borrowing if it is a loan to the business.',
    },
  )
  .refine((value) => value.destinationAccountId !== value.capitalAccountId, {
    path: ['capitalAccountId'],
    error: 'The account the money landed in cannot also be its source.',
  });
export type RecordCapitalFundingInput = z.infer<typeof recordCapitalFundingSchema>;

export const capitalFundingVerificationSchema = z.object({
  fundingId: uuidSchema,
  note: optionalString(500),
});

export const capitalFundingReasonSchema = z.object({
  fundingId: uuidSchema,
  reason: reasonSchema,
});
