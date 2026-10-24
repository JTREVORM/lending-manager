/**
 * Validation for enrolment, consent and savings input.
 *
 * ## What this layer decides, and what it must not
 *
 * Shape: that an amount is a positive whole number of shillings, that a method
 * is one the business accepts, that a consent method arrives with the evidence
 * that method requires, that a reason is long enough to mean something.
 *
 * Not policy. The registration fee is checked against the membership's own
 * effective-dated policy version inside `record_membership_fee`; the balance is
 * checked inside `request_savings_withdrawal` and again inside
 * `post_savings_withdrawal` under a row lock. A check here would be stale by
 * the time the money moved — another deposit, another withdrawal, a reversal —
 * and a stale check that passes is worse than none.
 *
 * So: shape here, policy there, and the policy re-evaluated at the moment the
 * money moves rather than carried forward from when the form was filled in.
 *
 * ## Nothing below accepts a verdict, a balance or a number
 *
 * There is no field for `verification_status`, for a balance, for a
 * `signed_amount`, for a transaction number, for a value date or for an actor.
 * A caller that could send `verification_status: 'verified'` could activate a
 * membership on a typed name — which is the exact defect Phase 1 left for this
 * phase to close — and one that could send a balance could print any statement
 * it liked. Each of those is derived by the database from evidence or from the
 * business clock.
 *
 * Every schema here runs on the server. The browser's copy of any of it can be
 * skipped by anyone posting directly, so none of it is the control: Row Level
 * Security, the column guards and the posting functions are.
 */

import { z } from 'zod';

import {
  CONSENT_METHOD_REQUIREMENTS,
  MEMBERSHIP_CARD_REASONS,
  OFFERABLE_CONSENT_METHODS,
  type ConsentMethod,
} from '@/lib/domain/savings';
import { PAYMENT_METHODS } from '@/lib/domain/payment';
import {
  businessDateSchema,
  optionalString,
  ugxAmountFromText,
  uuidSchema,
} from './common';

/** Reuses the payment vocabulary: savings arrive at the same counter. */
export const savingsMethodSchema = z.enum(PAYMENT_METHODS, {
  error: 'Choose how the money was received.',
});

/**
 * A savings amount, in whole shillings.
 *
 * The same hardened parser a loan principal and a payment use, so `50000,00`
 * is refused rather than becoming UGX 5,000,000.
 */
export const savingsAmountSchema = ugxAmountFromText({
  empty: 'Enter the amount.',
  malformed:
    'Enter a whole number of shillings, for example 50000 or 50,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'Enter an amount greater than zero.',
});

/**
 * A network or bank reference, normalised exactly as a payment's is.
 *
 * Trimmed and upper-cased and nothing else stripped: an internal character the
 * network put there is part of the reference. The same normalisation is applied
 * again in the database, so a caller that skipped this layer cannot store a
 * variant that defeats the uniqueness rule by case or whitespace alone.
 */
export const savingsReferenceSchema = z
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
 * Minted server-side when the form renders and carried as a hidden field, so a
 * double tap, a lost response and a replayed form all arrive with the same key.
 * Required rather than optional: an optional key would make the protection
 * depend on the caller remembering to send one, and the caller that forgets is
 * exactly the one that double-submits. See ADR-030.
 */
export const savingsIdempotencyKeySchema = uuidSchema;

/**
 * The cross-field reference rule, shared by every money-moving schema here.
 *
 * Cash has no network reference and sending one is *refused* rather than
 * ignored, because silently dropping something a staff member typed loses
 * information they believed they had recorded.
 */
function refineReference(
  value: { readonly paymentMethod: string; readonly externalReference?: string | null },
  ctx: z.RefinementCtx,
): void {
  const isCash = value.paymentMethod === 'cash';
  const reference = value.externalReference ?? null;

  if (!isCash && reference === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['externalReference'],
      message:
        'Enter the reference from the network or the bank. It is what makes the line findable when the account is reconciled.',
    });
  }

  if (isCash && reference !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['externalReference'],
      message:
        'A cash deposit has no network reference. Its transaction number is its reference.',
    });
  }
}

const optionalReference = z
  .union([savingsReferenceSchema, z.literal('')])
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * How consent was taken.
 *
 * Only the four offerable methods. `legacy_typed_name` is deliberately absent
 * from the enum rather than merely discouraged: it exists so the Phase 1 rows
 * that carry a typed name can be labelled honestly as `unverified`, and
 * offering it as an input would be offering a way to record a new acceptance
 * that can never satisfy activation.
 */
export const consentMethodSchema = z.enum(
  OFFERABLE_CONSENT_METHODS as [ConsentMethod, ...ConsentMethod[]],
  { error: 'Choose how the member’s acceptance was taken.' },
);

/**
 * The storage path of an uploaded signature.
 *
 * `memberships/<membership id>/signature/<file>`, which is the shape
 * `storage_path_membership_id()` reads the membership out of — and that
 * function is what makes "this member's own signature" expressible as a
 * storage policy predicate. A path of any other shape denies every policy, so
 * it is refused here rather than uploaded somewhere nothing can ever read.
 */
export const signaturePathSchema = z
  .string()
  .trim()
  .max(400, 'That path is too long.')
  .regex(
    /^memberships\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/signature\/[A-Za-z0-9._-]+$/,
    'A signature has to be stored under its own membership, as memberships/<id>/signature/<file>.',
  );

/**
 * The name the member signed as.
 *
 * Kept, and still required, even though it is no longer the evidence. It is how
 * a person reading the record later knows which name was used — a member who
 * signs "Nakato S." where the client record says "Sarah Nakato" is a question
 * worth being able to ask. What changed in Phase 2 is that this no longer
 * *proves* anything on its own.
 */
export const signatureNameSchema = z
  .string({ error: 'Enter the name the member signed as.' })
  .trim()
  .min(2, 'Enter the name the member signed as.')
  .max(160, 'That name is too long.');

/**
 * The one-time code a member reads back.
 *
 * Six digits. The entropy that matters is not in the code but in the single
 * live challenge, the ten-minute window, the one-use rule and the five-attempt
 * limit — all of which are in the database, because a limit enforced only here
 * is no limit at all.
 */
export const consentCodeSchema = z
  .string({ error: 'Enter the code the member read back to you.' })
  .trim()
  .regex(/^\d{6}$/, 'The code is six digits.');

/**
 * The evidence rule, shared by enrolment and by re-acceptance.
 *
 * Each method requires exactly one piece of evidence, or none, and
 * `CONSENT_METHOD_REQUIREMENTS` is the single statement of which — so this
 * function and the four branches inside
 * `membership_terms_acceptances_guard` cannot drift into disagreeing about
 * what `one_time_code` needs.
 */
function refineConsentEvidence(
  value: {
    readonly consentMethod: ConsentMethod;
    readonly signaturePath?: string | null;
    readonly witnessProfileId?: string | null;
    readonly challengeId?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const required = CONSENT_METHOD_REQUIREMENTS[value.consentMethod];

  const MESSAGES = {
    signaturePath: 'Upload the signed document before recording the acceptance.',
    witnessProfileId: 'Choose the member of staff who witnessed this.',
    challengeId:
      'Send the member a code and have them read it back before recording the acceptance.',
  } as const;

  for (const field of required) {
    if ((value[field] ?? null) === null) {
      ctx.addIssue({ code: 'custom', path: [field], message: MESSAGES[field] });
    }
  }

  // Evidence that belongs to a different method is refused rather than
  // ignored, for the same reason a cash reference is: it means the person
  // filling the form believes something is recorded that is not.
  const EVIDENCE = ['signaturePath', 'witnessProfileId', 'challengeId'] as const;
  for (const field of EVIDENCE) {
    if (!required.includes(field) && (value[field] ?? null) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message:
          'That is not the evidence this method takes. Clear it or change the method.',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/**
 * Enrolling a client as a member.
 *
 * One form, one transaction: `enrol_member` takes the fee, posts its journal,
 * records the verified acceptance, activates the membership, opens the savings
 * account and takes an optional first deposit — or rolls every one of them
 * back. There is deliberately no half-enrolled state to clean up, because the
 * two most expensive states this system could hold are a member who paid and is
 * not active, and a member who is active and did not pay.
 *
 * The fee **amount** is absent. It comes from the membership's policy version
 * inside the function, so a caller cannot enrol somebody for a shilling.
 */
export const enrolMemberSchema = z
  .object({
    clientId: uuidSchema,
    paymentMethod: savingsMethodSchema,
    externalReference: optionalReference,
    idempotencyKey: savingsIdempotencyKeySchema,

    consentMethod: consentMethodSchema,
    signatureName: signatureNameSchema,
    signaturePath: z
      .union([signaturePathSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    witnessProfileId: z
      .union([uuidSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    challengeId: z
      .union([uuidSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),

    /** A first deposit taken at the counter, at the same time. Optional. */
    initialDeposit: z
      .union([savingsAmountSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    depositReference: optionalReference,
    notes: optionalString(1_000),
  })
  .superRefine((value, ctx) => {
    refineReference(value, ctx);
    refineConsentEvidence(value, ctx);

    // The deposit rides on the same payment method as the fee, because it is
    // the same money arriving at the same counter in the same act. So its
    // reference follows the same rule.
    const isCash = value.paymentMethod === 'cash';
    const depositReference = value.depositReference ?? null;

    if ((value.initialDeposit ?? null) === null && depositReference !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['depositReference'],
        message: 'There is no deposit for this reference to belong to.',
      });
    }

    if ((value.initialDeposit ?? null) !== null) {
      if (!isCash && depositReference === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['depositReference'],
          message: 'Enter the reference for the deposit as well as for the fee.',
        });
      }
      if (isCash && depositReference !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['depositReference'],
          message: 'A cash deposit has no network reference.',
        });
      }
    }
  });

export type EnrolMemberInput = z.infer<typeof enrolMemberSchema>;

/**
 * Collecting the registration fee on its own.
 *
 * For a membership taken as an application first and paid for afterwards. The
 * amount *is* here, unlike in enrolment, because this is the screen where a
 * counter confirms the figure they took — and `record_membership_fee` checks it
 * against the policy and refuses a mismatch rather than accepting whatever
 * arrives.
 */
export const recordMembershipFeeSchema = z
  .object({
    membershipId: uuidSchema,
    amount: savingsAmountSchema,
    paymentMethod: savingsMethodSchema,
    externalReference: optionalReference,
    idempotencyKey: savingsIdempotencyKeySchema,
    notes: optionalString(1_000),
  })
  .superRefine(refineReference);

export type RecordMembershipFeeInput = z.infer<typeof recordMembershipFeeSchema>;

/** Recording a verified acceptance against an existing membership. */
export const recordConsentSchema = z
  .object({
    membershipId: uuidSchema,
    policyVersionId: uuidSchema,
    consentMethod: consentMethodSchema,
    signatureName: signatureNameSchema,
    signaturePath: z
      .union([signaturePathSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    witnessProfileId: z
      .union([uuidSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    challengeId: z
      .union([uuidSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional(),
    acceptedPlace: optionalString(160),
  })
  .superRefine(refineConsentEvidence);

export type RecordConsentInput = z.infer<typeof recordConsentSchema>;

/** Sending a member a one-time consent code. */
export const issueConsentCodeSchema = z.object({
  membershipId: uuidSchema,
  policyVersionId: uuidSchema,
});

/** Checking the code the member read back. */
export const redeemConsentCodeSchema = z.object({
  challengeId: uuidSchema,
  code: consentCodeSchema,
});

// ---------------------------------------------------------------------------
// Savings
// ---------------------------------------------------------------------------

/** Opening a savings account for a membership that has none. */
export const openSavingsAccountSchema = z.object({ membershipId: uuidSchema });

/** Recording a deposit at the counter. */
export const recordSavingsDepositSchema = z
  .object({
    savingsAccountId: uuidSchema,
    amount: savingsAmountSchema,
    paymentMethod: savingsMethodSchema,
    externalReference: optionalReference,
    idempotencyKey: savingsIdempotencyKeySchema,
    notes: optionalString(1_000),
  })
  .superRefine(refineReference);

export type RecordSavingsDepositInput = z.infer<typeof recordSavingsDepositSchema>;

/**
 * Preparing a withdrawal for review.
 *
 * The reason has a floor on its length, because this is the record of why money
 * left a member's savings and "cash" tells a future reader nothing.
 */
export const requestWithdrawalSchema = z.object({
  savingsAccountId: uuidSchema,
  amount: savingsAmountSchema,
  reason: z
    .string({ error: 'Say what the withdrawal is for.' })
    .trim()
    .min(4, 'Say what the withdrawal is for, in at least 4 characters.')
    .max(500, 'Keep it to 500 characters or fewer.'),
});

export type RequestWithdrawalInput = z.infer<typeof requestWithdrawalSchema>;

/**
 * Deciding a prepared withdrawal.
 *
 * A rejection must say why; an approval need not. The asymmetry is deliberate
 * — a refusal is the thing a member will ask about, and an approval's
 * justification is the request itself.
 *
 * Who may decide is not here: `decide_savings_withdrawal` refuses a decision
 * from whoever prepared it, which this layer cannot check because it does not
 * know who prepared it without a read that would be stale anyway.
 */
export const decideWithdrawalSchema = z
  .object({
    requestId: uuidSchema,
    approve: z.coerce.boolean(),
    notes: optionalString(500),
  })
  .superRefine((value, ctx) => {
    if (!value.approve && (value.notes ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['notes'],
        message: 'Say why it was rejected. The member will be told.',
      });
    }
  });

export type DecideWithdrawalInput = z.infer<typeof decideWithdrawalSchema>;

/** Paying an approved withdrawal. */
export const postWithdrawalSchema = z
  .object({
    requestId: uuidSchema,
    paymentMethod: savingsMethodSchema,
    externalReference: optionalReference,
    idempotencyKey: savingsIdempotencyKeySchema,
  })
  .superRefine(refineReference);

export type PostWithdrawalInput = z.infer<typeof postWithdrawalSchema>;

export const cancelWithdrawalSchema = z.object({
  requestId: uuidSchema,
  reason: z
    .string({ error: 'Say why it is being cancelled.' })
    .trim()
    .min(4, 'Say why it is being cancelled, in at least 4 characters.')
    .max(500, 'Keep it to 500 characters or fewer.'),
});

/**
 * Reversing a posted deposit or withdrawal.
 *
 * Ten characters, matching `reversePaymentSchema`: this is the only record of
 * why a member's savings balance changed without the member doing anything, and
 * "error" is not an explanation. The database floor is four, which is the
 * weaker guarantee that holds when this layer is bypassed.
 */
export const reverseSavingsSchema = z.object({
  transactionId: uuidSchema,
  reason: z
    .string({ error: 'Give the reason for this reversal.' })
    .trim()
    .min(
      10,
      'Explain the reason in at least 10 characters — this is the only record of it.',
    )
    .max(500, 'Keep the reason to 500 characters or fewer.'),
});

export const reverseMembershipFeeSchema = z.object({
  receiptId: uuidSchema,
  reason: z
    .string({ error: 'Give the reason for this reversal.' })
    .trim()
    .min(
      10,
      'Explain the reason in at least 10 characters — this is the only record of it.',
    )
    .max(500, 'Keep the reason to 500 characters or fewer.'),
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export const issueMembershipCardSchema = z.object({
  membershipId: uuidSchema,
  reason: z.enum(MEMBERSHIP_CARD_REASONS, {
    error: 'Choose why the card is being issued.',
  }),
});

// ---------------------------------------------------------------------------
// Register filters
// ---------------------------------------------------------------------------

/**
 * The savings register's filter.
 *
 * Nothing here fails closed: a malformed filter renders the default view rather
 * than an error, because a filter is a convenience and not a control.
 */
export const savingsSearchSchema = z.object({
  /** Free text: an account number, a membership number, a client name or number. */
  query: z
    .string()
    .trim()
    .max(100, 'Search text is too long.')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  status: z
    .union([z.enum(['active', 'dormant', 'closed']), z.literal('all')])
    .default('all')
    .optional(),
  /** `below` finds the members who have not met this month's minimum. */
  compliance: z
    .union([z.enum(['met', 'below']), z.literal('all')])
    .default('all')
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1).optional(),
});

export type SavingsSearchInput = z.infer<typeof savingsSearchSchema>;

/** The statement's period. */
export const savingsStatementSchema = z
  .object({
    savingsAccountId: uuidSchema,
    from: z.union([businessDateSchema, z.literal('')]).optional(),
    to: z.union([businessDateSchema, z.literal('')]).optional(),
  })
  .superRefine((value, ctx) => {
    const from = value.from ?? '';
    const to = value.to ?? '';
    if (from !== '' && to !== '' && from > to) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'The end of the period comes before its start.',
      });
    }
  });

export type SavingsStatementInput = z.infer<typeof savingsStatementSchema>;

/** The withdrawal queue's filter. */
export const withdrawalSearchSchema = z.object({
  status: z
    .union([
      z.enum(['pending', 'approved', 'rejected', 'paid', 'cancelled']),
      z.literal('all'),
    ])
    .default('pending')
    .optional(),
  query: z
    .string()
    .trim()
    .max(100, 'Search text is too long.')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1).optional(),
});

export type WithdrawalSearchInput = z.infer<typeof withdrawalSearchSchema>;
