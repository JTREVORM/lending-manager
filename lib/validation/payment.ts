/**
 * Validation for payment input.
 *
 * ## What this layer does and does not decide
 *
 * These schemas check *shape*: that an amount is a positive whole number of
 * shillings, that a method is one of the three the business accepts, that a
 * Mobile Money payment carries a reference.
 *
 * They deliberately do **not** check the commercial rules — the minimum
 * acceptable payment, the outstanding cap, the duplicate reference. Those
 * depend on the loan's current ledger state, which can change between the
 * form being rendered and the payment being posted, so a check here would be
 * stale. They live in `public.post_payment`, which re-evaluates every one of
 * them at the moment of posting against a locked row.
 *
 * So: shape here, policy there, and the policy is re-evaluated at the moment
 * the money is recorded rather than carried forward from when the form was
 * filled in.
 *
 * ## No balances, no allocations and no payment number are ever accepted
 *
 * There is no field below for an allocation, an outstanding balance, a
 * payment number, a timestamp or an actor. A caller who could supply an
 * allocation could credit a borrower's principal while leaving the interest
 * unpaid; one who could supply a balance could print any receipt it liked.
 * All of those are derived server-side.
 */

import { z } from 'zod';

import { PAYMENT_METHODS } from '@/lib/domain/payment';
import {
  businessDateSchema,
  optionalString,
  ugxAmountFromText,
  uuidSchema,
} from './common';

/**
 * A payment amount, in whole shillings.
 *
 * Uses the same hardened parser as a loan principal, so `4000,50` is refused
 * here exactly as `100000,50` is refused there rather than becoming
 * UGX 400,050.
 */
export const paymentAmountSchema = ugxAmountFromText({
  empty: 'Enter the amount received.',
  malformed:
    'Enter a whole number of shillings, for example 4000 or 4,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'Enter an amount greater than zero.',
});

export const paymentMethodSchema = z.enum(PAYMENT_METHODS, {
  error: 'Choose how the payment was received.',
});

/**
 * A Mobile Money transaction reference, normalised.
 *
 * Trimmed and upper-cased, and nothing else is stripped: an internal
 * character the network put there is part of the reference. The same
 * normalisation is applied again, and enforced by a CHECK constraint, in the
 * database — so a caller that skipped this layer cannot store a variant that
 * defeats the uniqueness rule by whitespace or case alone.
 */
export const externalReferenceSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(4, 'A transaction reference is at least 4 characters.')
  .max(64, 'That transaction reference is too long.')
  .regex(
    /^[A-Z0-9][A-Z0-9.\-_]*$/,
    'A transaction reference may contain only letters, numbers, dots, hyphens and underscores.',
  );

/**
 * The idempotency key for one submission.
 *
 * Minted server-side when the form is rendered and carried as a hidden field,
 * so a double tap, a lost response or a replayed form all arrive with the
 * same key — and `post_payment` returns the payment that already exists
 * rather than recording the money twice. See ADR-030.
 *
 * Required rather than optional. An optional key would make the protection
 * depend on the caller remembering to send one, and the caller that forgets is
 * exactly the one that double-submits.
 */
export const idempotencyKeySchema = uuidSchema;

/**
 * Recording a payment.
 *
 * The cross-field rule — a reference for Mobile Money, none for cash — is
 * checked here as well as in the database. Here so the staff member is told
 * before they confirm; there because this layer can be bypassed.
 */
export const recordPaymentSchema = z
  .object({
    loanId: uuidSchema,
    amount: paymentAmountSchema,
    paymentMethod: paymentMethodSchema,
    externalReference: z
      .union([externalReferenceSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    idempotencyKey: idempotencyKeySchema,
    notes: optionalString(1_000),
  })
  .superRefine((value, ctx) => {
    const isMobileMoney = value.paymentMethod !== 'cash';

    if (isMobileMoney && (value.externalReference ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalReference'],
        message:
          'Enter the transaction reference from the network. It is what stops the same payment being recorded twice.',
      });
    }

    // Refused rather than ignored: silently dropping a reference a staff
    // member typed would lose information they believed they had recorded.
    if (!isMobileMoney && (value.externalReference ?? null) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalReference'],
        message:
          'A cash payment has no network reference. Its payment number is its reference.',
      });
    }
  });

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * Reversing a payment.
 *
 * The reason is required and has a floor on its length, because "error" tells
 * a future reader nothing and this is the only record of why money was
 * withdrawn from a borrower's account.
 */
export const reversePaymentSchema = z.object({
  paymentId: uuidSchema,
  reason: z
    .string({ error: 'Give the reason for this reversal.' })
    .trim()
    .min(
      10,
      'Explain the reason in at least 10 characters — this is the only record of it.',
    )
    .max(500, 'Keep the reason to 500 characters or fewer.'),
});

/** Filters for the payment register. */
export const paymentSearchSchema = z.object({
  /** Free text: a payment number, a client name or number, a loan number, a reference. */
  query: z
    .string()
    .trim()
    .max(100, 'Search text is too long.')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  method: z
    .union([paymentMethodSchema, z.literal('all')])
    .default('all')
    .optional(),
  status: z
    .union([z.enum(['posted', 'reversed']), z.literal('all')])
    .default('all')
    .optional(),
  clientId: z.union([uuidSchema, z.literal('')]).optional(),
  // `businessDateSchema` rather than a shape regex. A pattern of
  // `\d{4}-\d{2}-\d{2}` accepts `2026-13-01`, and a filter that silently
  // matched nothing would look to the user like a register with no payments
  // in it. The shared schema checks the date is real.
  /** Inclusive lower bound on the business date the payment was received. */
  from: z.union([businessDateSchema, z.literal('')]).optional(),
  to: z.union([businessDateSchema, z.literal('')]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1).optional(),
});

export type PaymentSearchInput = z.infer<typeof paymentSearchSchema>;
