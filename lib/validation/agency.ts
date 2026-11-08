/**
 * Validation for agency banking.
 *
 * Shape here, policy in the database — the same division the rest of the
 * money layer keeps. Whether a provider is still provisional, whether a till
 * holds enough float, whether a payable would go into net debit, whether the
 * commission supplied matches the provider's configured terms, whether the
 * officer verifying is the one who recorded it: every one of those depends on
 * state that can change between the form rendering and the button being
 * pressed, so checking it here would be checking a stale fact. The Phase
 * 4A–4C functions re-evaluate all of it at the moment of posting, against
 * locked rows, inside the transaction that writes the journal.
 *
 * What this layer refuses is input that could not be right under any state:
 * a blank reason, a negative amount, an identifier that is not one.
 *
 * ## Deliberately absent
 *
 * No schema here carries a commission rate, a transaction limit or an
 * approval threshold. Decision L — whether `requires_approval_above` should
 * gate verification — is unresolved, and a form that offered a threshold
 * would be inventing the policy that decision is waiting on.
 */

import { z } from 'zod';

import {
  businessDateSchema,
  nonEmptyString,
  optionalString,
  ugxAmountFromText,
  uuidSchema,
} from './common';

/** Money changing hands: never zero, which would be a typo. */
const amountSchema = ugxAmountFromText({
  empty: 'Enter an amount in shillings.',
  malformed: 'Enter a whole number of shillings, with no decimals.',
  nonPositive: 'Enter an amount greater than zero.',
});

/** A customer fee, which may legitimately be nothing. */
const feeSchema = ugxAmountFromText({
  empty: 'Enter a fee, or zero.',
  malformed: 'Enter a whole number of shillings, with no decimals.',
  nonPositive: 'A fee cannot be negative.',
  allowZero: true,
});

/** A physical count: an empty drawer is a real and important reading. */
const countSchema = ugxAmountFromText({
  empty: 'Enter what was counted.',
  malformed: 'Enter a whole number of shillings, with no decimals.',
  nonPositive: 'A count cannot be negative.',
  allowZero: true,
});

const reasonSchema = nonEmptyString('Reason', 500);
const referenceSchema = optionalString(120);

/** What the provider's own system called it. Required to record a transaction. */
const providerReferenceSchema = nonEmptyString('Provider reference', 120);

// ---------------------------------------------------------------------------
// Recording and moving a transaction through its lifecycle
// ---------------------------------------------------------------------------

export const recordAgencyTransactionSchema = z.object({
  transactionTypeId: uuidSchema,
  principalAmount: amountSchema,
  /** Absent for a `cash_payable` provider, which has no till of its own. */
  floatAccountId: uuidSchema.optional().nullable(),
  customerIdentifier: nonEmptyString('Customer identifier', 120),
  customerName: optionalString(160),
  providerReference: providerReferenceSchema,
  customerFee: feeSchema,
  description: optionalString(500),
  /**
   * The client supplies this so a retry of the same submission cannot post
   * twice. The database enforces it with a unique index; this only carries it.
   */
  idempotencyKey: nonEmptyString('Submission key', 80),
});
export type RecordAgencyTransactionInput = z.infer<typeof recordAgencyTransactionSchema>;

export const agencyTransactionIdSchema = z.object({
  transactionId: uuidSchema,
});

export const agencyTransactionReasonSchema = z.object({
  transactionId: uuidSchema,
  reason: reasonSchema,
});

export const correctReferenceSchema = z.object({
  transactionId: uuidSchema,
  newReference: providerReferenceSchema,
  reason: reasonSchema,
});

export const commissionExceptionSchema = z.object({
  transactionId: uuidSchema,
  reason: reasonSchema,
  /** A statement number, a handset reference, a ticket: something checkable. */
  evidence: nonEmptyString('External evidence', 200),
  /**
   * The figure the Owner is authorising.
   *
   * Required by the interface, because the counter supplies none: the
   * standard form has no commission field, so without this the owner-only
   * workflow would have no figure to authorise. Zero is a legitimate answer -
   * "we agreed nothing on this one" is a real decision - so it is allowed
   * here and the database refuses it only if it equals what the terms
   * already produce.
   */
  proposedAmount: ugxAmountFromText({
    empty: 'Enter the commission being authorised.',
    malformed: 'Enter a whole number of shillings, with no decimals.',
    nonPositive: 'A commission cannot be negative.',
    allowZero: true,
  }),
});

// ---------------------------------------------------------------------------
// Settlement, remittance and replenishment
// ---------------------------------------------------------------------------

export const commissionSettlementSchema = z.object({
  providerId: uuidSchema,
  branchId: uuidSchema,
  amount: amountSchema,
  settlementAccountId: uuidSchema,
  statementRef: referenceSchema,
  settlementDate: businessDateSchema.optional().nullable(),
});

export const payableSettlementSchema = z.object({
  providerId: uuidSchema,
  branchId: uuidSchema,
  amount: amountSchema,
  cashAccountId: uuidSchema,
  receiptRef: referenceSchema,
  settlementDate: businessDateSchema.optional().nullable(),
});

export const settlementReversalSchema = z.object({
  settlementId: uuidSchema,
  reason: reasonSchema,
});

export const floatReplenishmentSchema = z.object({
  floatAccountId: uuidSchema,
  amount: amountSchema,
  fundingAccountId: uuidSchema,
  reference: referenceSchema,
  replenishmentDate: businessDateSchema.optional().nullable(),
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export const cashCountSchema = z.object({
  cashAccountId: uuidSchema,
  physicalCount: countSchema,
  reconciliationDate: businessDateSchema.optional().nullable(),
  notes: optionalString(500),
});

export const floatStatementSchema = z.object({
  floatAccountId: uuidSchema,
  statementBalance: countSchema,
  statementRef: referenceSchema,
  reconciliationDate: businessDateSchema.optional().nullable(),
  notes: optionalString(500),
});

/**
 * Approving a count.
 *
 * `adjust` is explicit and defaults to off. A difference never writes itself
 * into the ledger: an unexplained variance is a real outcome and stays on the
 * record as one. When it is on, the reason is required — and
 * `agency:variance_adjustment` is checked by the database, not here.
 */
export const reconciliationApprovalSchema = z
  .object({
    reconciliationId: uuidSchema,
    adjust: z.coerce.boolean().default(false),
    reason: optionalString(500),
  })
  .refine((value) => !value.adjust || (value.reason ?? '').trim() !== '', {
    message: 'Say why the difference is being written off.',
    path: ['reason'],
  });
