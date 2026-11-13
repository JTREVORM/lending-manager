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
  optionalField,
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
  /**
   * The branch this transaction is recorded at.
   *
   * Optional here and decided by the database, deliberately. An officer
   * assigned to a branch records at it and need send nothing; one who is not
   * — Head Office — must name a branch, and
   * `create_agency_transaction()` refuses the call when they do not. Making
   * it required in this schema would mean the form deciding a rule the
   * database owns, and getting a different answer when the two drift.
   */
  branchId: optionalField(uuidSchema),
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

/**
 * Verification carries the revision the screen was showing.
 *
 * Not a policy check: the database compares it with the row it locks. What
 * this refuses is a form that lost the value, which would otherwise fall back
 * to the weaker no-token path.
 */
export const verifyAgencyTransactionSchema = z.object({
  transactionId: uuidSchema,
  reviewedRevision: z
    .string()
    .trim()
    .min(1, 'Reload the transaction before verifying it.')
    .regex(/^[0-9]+$/, 'Reload the transaction before verifying it.')
    .transform((v) => Number(v))
    .refine((v) => Number.isSafeInteger(v) && v >= 1, {
      message: 'Reload the transaction before verifying it.',
    }),
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

// ---------------------------------------------------------------------------
// Phase 4E — Mobile Money
//
// The same division as above: shape here, policy in the database. Whether a
// line holds enough float to sell, whether a period overlaps one already
// reconciled, whether the verifier is the person who recorded it, whether a
// line can be closed — every one of those depends on state that can change
// between the form rendering and the button being pressed.
//
// Two shapes deserve a note.
//
// A float trade's fields depend on its kind, and the schema does **not**
// enforce that dependency: `record_agency_float_trade()` does, with messages
// that name the kind. Encoding it twice would mean two sets of words for one
// rule, and the database's set is the one that cannot be bypassed.
//
// A sale's fee allows zero, and that is the point of decision OD-6: "sell
// without fee" is a stated zero rather than a blank, so a cashier who leaves
// the field empty is asked rather than assumed about.
// ---------------------------------------------------------------------------

/** What was actually paid for float, which may differ from its face value. */
const paidSchema = ugxAmountFromText({
  empty: 'Enter what was paid for the float.',
  malformed: 'Enter a whole number of shillings, with no decimals.',
  nonPositive: 'Enter an amount greater than zero.',
});

export const floatTradeSchema = z.object({
  kind: z.enum(['purchase', 'sale', 'transfer']),
  floatAccountId: uuidSchema,
  floatAmount: amountSchema,
  reference: providerReferenceSchema,
  counterFloatAccountId: uuidSchema.optional().nullable(),
  settlementAccountId: uuidSchema.optional().nullable(),
  cashAmount: paidSchema.optional().nullable(),
  feeAmount: feeSchema.optional().nullable(),
  sourceKind: z
    .enum(['provider_service_centre', 'external_agent', 'bank', 'cash'])
    .optional()
    .nullable(),
  counterpartyName: optionalString(160),
  tradeDate: businessDateSchema.optional().nullable(),
  notes: optionalString(500),
});

export const floatTradeVerificationSchema = z.object({
  tradeId: uuidSchema,
  /**
   * The revision the officer was shown. Optional so a caller that cannot
   * supply one still works, and sent by every screen, because a verifier who
   * posts figures they never saw is the thing it prevents.
   */
  expectedRevision: z.coerce.number().int().positive().optional().nullable(),
});

export const floatTradeReasonSchema = z.object({
  tradeId: uuidSchema,
  reason: reasonSchema,
});

export const commissionPayoutSchema = z.object({
  floatAccountId: uuidSchema,
  amount: amountSchema,
  /** Required, not optional: without it the duplicate index has nothing to bite on. */
  providerReference: providerReferenceSchema,
  payoutDate: optionalField(businessDateSchema),
  notes: optionalString(500),
});

export const commissionRecoverySchema = z.object({
  floatAccountId: uuidSchema,
  amount: amountSchema,
  method: z.enum(['float_deduction', 'commission_offset']),
  providerReference: providerReferenceSchema,
  recoveryDate: optionalField(businessDateSchema),
  notes: optionalString(500),
});

export const commissionReconciliationSchema = z.object({
  floatAccountId: uuidSchema,
  /** The provider's own statement dates, copied off the statement. */
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  /** A statement showing no commission is a real reading, so zero is allowed. */
  providerReportedCommission: countSchema,
  statementRef: providerReferenceSchema,
  notes: optionalString(500),
});

export const commissionReconciliationDecisionSchema = z.object({
  reconciliationId: uuidSchema,
  notes: optionalString(500),
});

const tillNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a till name.')
  .max(31, 'A till name is at most 31 characters.')
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'A till name is lower-case letters, digits, hyphens and underscores.',
  );

const msisdnSchema = z
  .string()
  .trim()
  .regex(/^\+256[0-9]{9}$/, 'Enter a Ugandan mobile number, as +256700000000.')
  .optional()
  .nullable();

export const agentLineRegistrationSchema = z.object({
  providerId: uuidSchema,
  branchId: uuidSchema,
  tillName: tillNameSchema,
  label: optionalString(80),
  lineMsisdn: msisdnSchema,
  agentCode: optionalString(40),
  openedOn: optionalField(businessDateSchema),
  notes: optionalString(500),
});

export const agentLineUpdateSchema = z.object({
  floatAccountId: uuidSchema,
  label: optionalString(80),
  lineMsisdn: msisdnSchema,
  agentCode: optionalString(40),
  notes: optionalString(500),
});

export const agentLineSuspensionSchema = z.object({
  floatAccountId: uuidSchema,
  suspended: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true'),
  reason: reasonSchema,
});

export const agentLineClosureSchema = z.object({
  floatAccountId: uuidSchema,
  reason: reasonSchema,
  closedOn: optionalField(businessDateSchema),
});

export const serviceLimitSchema = z.object({
  transactionTypeId: uuidSchema,
  /** A ceiling of zero is refused by the database: it means "nothing may be transacted". */
  maxSingleTransaction: amountSchema,
  reason: optionalString(500),
});

export const commissionSourceSchema = z.object({
  providerId: uuidSchema,
  source: z.enum(['configured', 'reported']),
  reason: optionalString(500),
});
