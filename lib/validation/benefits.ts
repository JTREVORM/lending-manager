/**
 * Validation for beneficiaries, benefit claims and their evidence.
 *
 * ## What this layer decides, and what it must not
 *
 * Shape: that a hospital bill is a positive whole number of shillings, that a
 * discharge is after an admission, that a relationship is one the business
 * recognises, that a refusal carries a reason long enough to mean something,
 * that a claim of one type does not arrive carrying another type's facts.
 *
 * Not policy. The medical rate, the annual cap, the claim frequency, the
 * waiting period, the admission threshold and the eligible relationship are
 * all read from the claim's own policy version **inside**
 * `benefit_claim_eligibility()` and `assess_benefit_claim()`, at the moment
 * the assessment is made. A check here would be stale by then — another claim
 * assessed, a policy superseded, a document refused — and a stale check that
 * passes is worse than none.
 *
 * So: shape here, policy there, and the policy re-evaluated when it matters
 * rather than carried forward from when the form was filled in. The approval
 * re-asks every rule for the same reason.
 *
 * ## Nothing below accepts a verdict, an amount or an actor
 *
 * There is no field for `verification_status`, for `assessed_amount`, for a
 * claim status, for a claim number, for a recipient, for a journal entry or
 * for who did anything. A caller that could send
 * `verification_status: 'verified'` could pay UGX 200,000 to a name somebody
 * typed; one that could send an assessed amount could decide its own benefit.
 * Each is derived by the database from evidence, from the policy or from the
 * session.
 *
 * The one apparent exception is the beneficiary a bereavement claim names,
 * which is an id a caller supplies. It is not a verdict: the database checks
 * that the record is live, primary and verified before anything is assessed,
 * and freezes a copy of it into the snapshot at assessment so a later change
 * cannot redirect the payment.
 *
 * Every schema here runs on the server. The browser's copy of any of it can be
 * skipped by anyone posting directly, so none of it is the control: Row Level
 * Security, the column guards, the state machine and the posting functions
 * are.
 */

import { z } from 'zod';

import {
  BENEFICIARY_EVIDENCE_KINDS,
  BENEFICIARY_IDENTITY_DOCUMENT_KINDS,
  BENEFIT_CLAIM_STATUSES,
  BENEFIT_CLAIM_TYPES,
} from '@/lib/domain/benefits';
import { PAYMENT_METHODS } from '@/lib/domain/payment';
import {
  businessDateSchema,
  fullNameSchema,
  optionalField,
  optionalString,
  ugandanPhoneSchema,
  ugxAmountFromText,
  uuidSchema,
} from './common';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const benefitClaimTypeSchema = z.enum(BENEFIT_CLAIM_TYPES, {
  error: 'Choose which benefit is being claimed.',
});

/**
 * A hospital bill, in whole shillings.
 *
 * The same hardened parser a loan principal and a payment use, so `400000,00`
 * is refused rather than becoming UGX 40,000,000 — which at 5% would be a
 * UGX 2,000,000 benefit instead of a UGX 20,000 one.
 */
export const hospitalBillSchema = ugxAmountFromText({
  empty: 'Enter the hospital bill.',
  malformed:
    'Enter a whole number of shillings, for example 400000 or 400,000. Ugandan shillings have no smaller unit.',
  nonPositive: 'Enter an amount greater than zero.',
});

/**
 * An instant, from a form's date-and-time input.
 *
 * `datetime-local` sends no offset, so the value is interpreted in
 * Africa/Kampala — the business timezone — and the database stores the instant.
 * Reading it as UTC would put a 23:00 admission on the following day, and the
 * admission date is what every date-based rule reads.
 */
export const kampalaInstantSchema = z
  .string()
  .trim()
  .min(1, 'Enter the date and time.')
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    'Enter a date and a time, for example 2026-03-10T09:00.',
  )
  .transform((value) => `${value.length === 16 ? `${value}:00` : value}+03:00`);

/**
 * A reason, note or explanation that somebody will have to read.
 *
 * Three characters is the floor the database enforces, and it is low on
 * purpose: "Flu" is a real answer. What it refuses is the empty string and a
 * single stray character, which is what a form submitted by accident sends.
 */
export const benefitReasonSchema = z
  .string()
  .trim()
  .min(3, 'Say why, in a few words. Somebody will have to read this.')
  .max(1000, 'That is too long for a reason. Put the detail in the claim notes.');

export const benefitNoteSchema = z
  .string()
  .trim()
  .min(3, 'Say something, or leave it empty.')
  .max(4000, 'That note is too long.');

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

/**
 * Registering a beneficiary.
 *
 * `relationship` is validated as a non-empty key rather than against a
 * TypeScript enum, because the vocabulary is a table — `beneficiary_
 * relationships` — and the foreign key is what refuses an unknown one. An enum
 * here would be a second list to keep in step, and the one that drifted would
 * be this one.
 *
 * There is no `isPrimary: false` convenience. A second beneficiary is recorded
 * as an additional contact by *saying so*, because the difference between
 * "this is who we pay" and "this is somebody else we hold a number for" is the
 * whole point of the column.
 */
export const registerBeneficiarySchema = z.object({
  membershipId: uuidSchema,
  fullName: fullNameSchema,
  relationship: z
    .string()
    .trim()
    .min(1, 'Choose the beneficiary’s relationship to the member.')
    .max(40),
  phone: ugandanPhoneSchema,
  alternativePhone: optionalField(ugandanPhoneSchema),
  villageArea: optionalString(120),
  district: optionalString(120),
  identityDocumentKind: optionalField(z.enum(BENEFICIARY_IDENTITY_DOCUMENT_KINDS)),
  identityReference: optionalString(60),
  isPrimary: z.coerce.boolean(),
  /** Set when this record replaces another, which supersedes it. */
  supersedesId: optionalField(uuidSchema),
});

export type RegisterBeneficiaryInput = z.infer<typeof registerBeneficiarySchema>;

/**
 * The identity-document rule, as a refinement.
 *
 * Both or neither: a reference with no document named, and a document named
 * with no reference, are each half an identification. The database says the
 * same thing in a CHECK constraint; this says it where a form can highlight
 * the field.
 */
export const registerBeneficiaryFormSchema = registerBeneficiarySchema.superRefine(
  (value, ctx) => {
    const hasKind = (value.identityDocumentKind ?? null) !== null;
    const hasReference = (value.identityReference ?? null) !== null;

    if (hasKind !== hasReference) {
      ctx.addIssue({
        code: 'custom',
        path: hasKind ? ['identityReference'] : ['identityDocumentKind'],
        message:
          'Name the document and its reference, or neither. Half an identification identifies nobody.',
      });
    }

    if (
      value.alternativePhone !== null &&
      value.alternativePhone !== undefined &&
      value.alternativePhone === value.phone
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['alternativePhone'],
        message: 'The alternative number is the same as the first one.',
      });
    }
  },
);

/**
 * Verifying a beneficiary.
 *
 * `verified: false` requires a note, because a refusal somebody has to explain
 * to a member needs words. `verified: true` does not: the evidence speaks for
 * itself, and a mandatory note would be filled with "ok".
 *
 * A document evidence kind requires a path, and the path is checked against
 * the private bucket **under this membership's own folder** by the database. A
 * path naming a file nobody uploaded verifies nothing, and a path naming
 * somebody else's file is the forgery this check exists for.
 */
export const verifyBeneficiarySchema = z
  .object({
    beneficiaryId: uuidSchema,
    verified: z.coerce.boolean(),
    evidenceKind: z.enum(BENEFICIARY_EVIDENCE_KINDS, {
      error: 'Say what the verification rests on.',
    }),
    evidencePath: optionalString(500),
    note: optionalField(benefitReasonSchema),
  })
  .superRefine((value, ctx) => {
    const needsDocument =
      value.evidenceKind === 'relationship_document' ||
      value.evidenceKind === 'identity_document';

    if (needsDocument && (value.evidencePath ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidencePath'],
        message: 'Upload the document first, then verify against it.',
      });
    }

    if (!needsDocument && (value.evidencePath ?? null) !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidencePath'],
        message: 'That kind of evidence carries no document.',
      });
    }

    if (!value.verified && (value.note ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Say why it was refused. Somebody will have to tell the member.',
      });
    }
  });

export const revokeBeneficiarySchema = z.object({
  beneficiaryId: uuidSchema,
  reason: benefitReasonSchema,
});

// ---------------------------------------------------------------------------
// Opening a claim
// ---------------------------------------------------------------------------

/**
 * A medical claim.
 *
 * The discharge is optional at draft and required at submission — a claim
 * opened while the member is still in the ward is a real and common case, and
 * `submit_benefit_claim` is what refuses to take it further. So the schema
 * permits it and the refusal happens where the business date does.
 */
export const medicalClaimSchema = z
  .object({
    membershipId: uuidSchema,
    providerName: z
      .string()
      .trim()
      .min(3, 'Name the hospital or clinic.')
      .max(150, 'That name is too long.'),
    admissionAt: kampalaInstantSchema,
    dischargeAt: optionalField(kampalaInstantSchema),
    billAmount: hospitalBillSchema,
  })
  .superRefine((value, ctx) => {
    const discharge = value.dischargeAt ?? null;

    if (discharge !== null && Date.parse(discharge) <= Date.parse(value.admissionAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['dischargeAt'],
        message: 'The discharge is before or at the admission. Check the two times.',
      });
    }
  });

export type MedicalClaimInput = z.infer<typeof medicalClaimSchema>;

/**
 * A family condolence claim.
 *
 * The relationship is required even though **nobody has decided which
 * relationships qualify**. That is not a contradiction: the claim records what
 * the member says the deceased was to them, and the assessment refuses with
 * `relationship_eligibility_undecided` until the client answers. Recording the
 * claim without the relationship would make it unassessable the day they do.
 */
export const condolenceClaimSchema = z.object({
  membershipId: uuidSchema,
  deceasedBeneficiaryId: optionalField(uuidSchema),
  deceasedName: fullNameSchema,
  deceasedRelationship: z
    .string()
    .trim()
    .min(1, 'Choose what the deceased was to the member.')
    .max(40),
  dateOfDeath: businessDateSchema,
});

export type CondolenceClaimInput = z.infer<typeof condolenceClaimSchema>;

/**
 * A member bereavement claim.
 *
 * The beneficiary is optional here and required at assessment. A claim opened
 * the day a member dies, before anybody has checked the next of kin, is the
 * common case; refusing to record it would push the work onto paper. The
 * database refuses the *assessment* with `beneficiary_missing` or
 * `beneficiary_not_verified`, which is where it belongs.
 */
export const bereavementClaimSchema = z.object({
  membershipId: uuidSchema,
  deceasedName: fullNameSchema,
  dateOfDeath: businessDateSchema,
  beneficiaryId: optionalField(uuidSchema),
});

export type BereavementClaimInput = z.infer<typeof bereavementClaimSchema>;

// ---------------------------------------------------------------------------
// Moving a claim along
// ---------------------------------------------------------------------------

export const claimIdSchema = z.object({ claimId: uuidSchema });

export const requestInformationSchema = z.object({
  claimId: uuidSchema,
  note: z
    .string()
    .trim()
    .min(
      3,
      'Say what is missing. "Requires information" with nothing to fetch sends somebody away twice.',
    )
    .max(1000, 'That is too long. Put the detail in the claim notes.'),
});

export const assessClaimSchema = z.object({
  claimId: uuidSchema,
  /**
   * The assessor's working note. Optional, and **internal**: no approved
   * policy discloses an officer's reasoning about whether an invoice looked
   * genuine to the member it is about, so `benefit_claim_portal_view` does not
   * carry it.
   */
  note: optionalField(benefitNoteSchema),
});

/**
 * Approving a claim.
 *
 * `approvedAmount` is deliberately absent. The approver agrees the assessment
 * or refuses the claim; a part approval is refused by
 * `approve_benefit_claim` while that rule is undecided, and a field here would
 * invite somebody to type a number the function then rejects.
 *
 * When the client settles whether an eligible claim may be paid in part, this
 * schema grows the field and the function loses one branch.
 */
export const approveClaimSchema = z.object({
  claimId: uuidSchema,
  note: optionalString(2000),
});

export const rejectClaimSchema = z.object({
  claimId: uuidSchema,
  reason: benefitReasonSchema,
});

export const cancelClaimSchema = z.object({
  claimId: uuidSchema,
  reason: benefitReasonSchema,
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const verifyDocumentSchema = z
  .object({
    documentId: uuidSchema,
    verified: z.coerce.boolean(),
    note: optionalField(benefitReasonSchema),
  })
  .superRefine((value, ctx) => {
    if (!value.verified && (value.note ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Say why it was refused, so somebody can ask for a replacement.',
      });
    }
  });

/**
 * Attaching a document.
 *
 * `kind` is a key into `benefit_document_kinds` rather than an enum, for the
 * reason the relationship is: the vocabulary is a table and the foreign key is
 * the check.
 *
 * Exactly one parent. A document belongs to a claim or to a beneficiary
 * record, never both: a beneficiary's relationship evidence outlives any one
 * claim, and a hospital invoice means nothing apart from the claim that cites
 * it.
 */
export const attachDocumentSchema = z
  .object({
    claimId: optionalField(uuidSchema),
    beneficiaryId: optionalField(uuidSchema),
    kind: z.string().trim().min(1, 'Say what the document is.').max(60),
    label: optionalString(200),
  })
  .superRefine((value, ctx) => {
    const hasClaim = (value.claimId ?? null) !== null;
    const hasBeneficiary = (value.beneficiaryId ?? null) !== null;

    if (hasClaim === hasBeneficiary) {
      ctx.addIssue({
        code: 'custom',
        path: ['claimId'],
        message:
          'A document belongs to a claim or to a beneficiary record, and to exactly one of them.',
      });
    }
  });

export const removeDocumentSchema = z.object({ documentId: uuidSchema });

// ---------------------------------------------------------------------------
// Paying and reversing
// ---------------------------------------------------------------------------

/**
 * Paying an approved benefit.
 *
 * The amount is not here, and neither is the recipient. Both come from the
 * assessment the approver agreed to: the amount from the claim's approved
 * figure, checked again against the snapshot, and the recipient from the
 * snapshot's frozen copy — which is the line that refuses the substitution
 * fraud, because a payment that re-read the live beneficiary record could pay
 * somebody the approver never saw.
 */
export const payBenefitSchema = z
  .object({
    claimId: uuidSchema,
    paymentMethod: z.enum(PAYMENT_METHODS, {
      error: 'Choose how the money was paid.',
    }),
    externalReference: optionalString(100),
    idempotencyKey: uuidSchema,
  })
  .superRefine((value, ctx) => {
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

    // Refused rather than ignored: silently dropping something a staff member
    // typed loses information they believed they had recorded.
    if (isCash && reference !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalReference'],
        message:
          'A cash payment has no network reference. Its payment number is its reference.',
      });
    }
  });

export const reverseBenefitPaymentSchema = z.object({
  paymentId: uuidSchema,
  reason: benefitReasonSchema,
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The claim register's filters.
 *
 * A malformed filter in the URL falls back to the default view rather than
 * erroring, because a filter is a convenience and not a control: the rows a
 * caller may see are decided by Row Level Security whatever the query string
 * says.
 */
export const benefitClaimSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(80)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  type: z.enum([...BENEFIT_CLAIM_TYPES, 'all']).default('all'),
  status: z.enum([...BENEFIT_CLAIM_STATUSES, 'all', 'open']).default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type BenefitClaimSearch = z.infer<typeof benefitClaimSearchSchema>;

export const beneficiarySearchSchema = z.object({
  query: z
    .string()
    .trim()
    .max(80)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  verification: z
    .enum(['all', 'pending_verification', 'verified', 'rejected'])
    .default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type BeneficiarySearch = z.infer<typeof beneficiarySearchSchema>;
