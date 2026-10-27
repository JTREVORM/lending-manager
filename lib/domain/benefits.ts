/**
 * The benefits domain: the vocabulary, the arithmetic, and the rules that are
 * pure enough to state in TypeScript.
 *
 * ## A benefit is money leaving the business on the strength of a document
 *
 * This is the fact worth stating at the top of the file, because every design
 * decision below follows from it. Nobody in the office saw the admission,
 * nobody attended the funeral, and the invoice is a photograph of a piece of
 * paper. So the act is split into four judgements held by people who can
 * refuse the one before them — claim, assess, approve, pay — and
 * `approve_benefit_claim` refuses an approval from whoever assessed it.
 *
 * None of that is enforced here. The controls live in the database, where a
 * forged POST, a leaked key and a `psql` session all meet them. What is in
 * this module is the vocabulary those tables are constrained to, the labels a
 * screen renders, and a second opinion on arithmetic the database has already
 * done — so a figure can be shown beside a form without a round trip, and a
 * test can drive the calculation directly.
 *
 * ## The values live in the policy, not here
 *
 * The medical rate (500 basis points today), the admission threshold, the two
 * fixed amounts (UGX 100,000 and UGX 200,000), the annual cap, the claim
 * frequency and the waiting period are all columns on
 * `public.membership_policy_versions`, effective-dated, and a claim references
 * the version its membership was enrolled under. They are deliberately not
 * constants in this file: a constant cannot be effective-dated, and a member
 * who joined in March keeps March's terms when the business changes them in
 * June. Every function below that needs one takes it as an argument.
 *
 * ## Four rules are the client's and are not invented here
 *
 * The annual cap, how many claims a year, the waiting period and whether the
 * benefit year runs on the calendar or on the member's enrolment anniversary.
 * Benefits do not open at all until the first three are answered — through the
 * Phase 1 activity-specific readiness gate, which lets enrolment and savings
 * carry on meanwhile — and a medical assessment additionally refuses while the
 * fourth is open. Every arm of each is implemented; none is defaulted.
 *
 * `scripts/audit-financial-arithmetic.mjs` holds this file to integer and
 * `BigInt` arithmetic only. `bill * 0.05` is 30000.000000000004 on the wrong
 * bill, and across a year of postings that is a ledger that does not balance.
 */

import { applyRateBps, toUgx, type UgxAmount } from './money';

// ---------------------------------------------------------------------------
// The three benefits
// ---------------------------------------------------------------------------

/**
 * The benefits the membership programme promises.
 *
 * Mirrors the `benefit_claim_type_valid` CHECK constraint, and a database test
 * asserts the two agree. One claim table carries all three, because they
 * differ only in what evidences them and how the amount is reached — not in
 * who handles them, how they are approved, or how they post.
 */
export const BENEFIT_CLAIM_TYPES = [
  'medical',
  'family_condolence',
  'member_bereavement',
] as const;

export type BenefitClaimType = (typeof BENEFIT_CLAIM_TYPES)[number];

export function isBenefitClaimType(value: unknown): value is BenefitClaimType {
  return (
    typeof value === 'string' &&
    (BENEFIT_CLAIM_TYPES as readonly string[]).includes(value)
  );
}

export const BENEFIT_CLAIM_TYPE_LABELS: Readonly<Record<BenefitClaimType, string>> = {
  medical: 'Medical support',
  family_condolence: 'Family condolence support',
  member_bereavement: 'Member bereavement support',
} as const;

/** What each benefit is for, in the words the client's own documents use. */
export const BENEFIT_CLAIM_TYPE_DESCRIPTIONS: Readonly<Record<BenefitClaimType, string>> =
  {
    medical:
      'A share of an eligible hospital bill, where the member was admitted for longer than the policy’s threshold.',
    family_condolence:
      'A fixed amount on the death of a member’s eligible family member.',
    member_bereavement:
      'A fixed amount on the death of a member, paid to their registered and verified next of kin.',
  } as const;

/** The ledger account each benefit is debited to. Mirrors `benefit_expense_account()`. */
export const BENEFIT_EXPENSE_ACCOUNT_CODES: Readonly<Record<BenefitClaimType, string>> = {
  medical: '5210',
  family_condolence: '5220',
  member_bereavement: '5230',
} as const;

/**
 * Who a benefit of each type is paid to.
 *
 * Not a preference: the bereavement benefit is payable to the registered next
 * of kin because the member is dead, and `benefit_payment_bereavement_pays_
 * beneficiary` refuses anything else.
 */
export const BENEFIT_RECIPIENT_KINDS = ['member', 'beneficiary'] as const;
export type BenefitRecipientKind = (typeof BENEFIT_RECIPIENT_KINDS)[number];

export function benefitRecipientKindFor(type: BenefitClaimType): BenefitRecipientKind {
  return type === 'member_bereavement' ? 'beneficiary' : 'member';
}

/** How a payment names its payee on screen. */
export const BENEFIT_RECIPIENT_KIND_LABELS: Readonly<
  Record<BenefitRecipientKind, string>
> = {
  member: 'Paid to the member',
  beneficiary: 'Paid to the registered next of kin',
} as const;

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/**
 * Claim statuses.
 *
 *   - `draft`                — being prepared. Nothing asserted, nothing
 *                              claimed. Correctable freely, which is what a
 *                              draft is for.
 *   - `submitted`            — the claim is made, and every fact it asserts is
 *                              frozen from here.
 *   - `under_verification`   — somebody is checking the documents.
 *   - `information_required` — waiting on the claimant, with a note saying for
 *                              what.
 *   - `assessed`             — the eligible amount is computed and
 *                              recommended. **This is "waiting for an
 *                              approver".**
 *   - `approved`             — independently approved. **This is "waiting for a
 *                              payer".**
 *   - `rejected`             — refused, with a reason. Terminal.
 *   - `paid`                 — the money has gone, with a journal behind it.
 *   - `cancelled`            — withdrawn before a decision. Terminal.
 *   - `reversed`             — paid and then un-paid, with a contra journal.
 *                              Terminal: there is no edge back to `approved`,
 *                              so an erroneous reversal cannot make a paid
 *                              claim payable twice.
 *
 * The Phase 4 brief lists "pending approval" and "pending payment" as separate
 * statuses. They are not modelled, deliberately: nothing *happens* between
 * being assessed and being pending approval — they are one moment named twice,
 * and a status no act moves a claim into drifts out of step with the one it
 * shadows. The labels below say the waiting part in words, so nothing is lost
 * to a reader.
 *
 * Mirrors `benefit_claim_status_valid`.
 */
export const BENEFIT_CLAIM_STATUSES = [
  'draft',
  'submitted',
  'under_verification',
  'information_required',
  'assessed',
  'approved',
  'rejected',
  'paid',
  'cancelled',
  'reversed',
] as const;

export type BenefitClaimStatus = (typeof BENEFIT_CLAIM_STATUSES)[number];

export function isBenefitClaimStatus(value: unknown): value is BenefitClaimStatus {
  return (
    typeof value === 'string' &&
    (BENEFIT_CLAIM_STATUSES as readonly string[]).includes(value)
  );
}

export const BENEFIT_CLAIM_STATUS_LABELS: Readonly<Record<BenefitClaimStatus, string>> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_verification: 'Checking evidence',
  information_required: 'Waiting for information',
  assessed: 'Waiting for approval',
  approved: 'Waiting for payment',
  rejected: 'Refused',
  paid: 'Paid',
  cancelled: 'Withdrawn',
  reversed: 'Payment reversed',
} as const;

export const BENEFIT_CLAIM_STATUS_DESCRIPTIONS: Readonly<
  Record<BenefitClaimStatus, string>
> = {
  draft: 'Being prepared. Nothing has been claimed and nothing is fixed yet.',
  submitted: 'The claim is made. Its facts are now fixed.',
  under_verification: 'Somebody is checking the documents against the claim.',
  information_required: 'Something is missing. The note says what.',
  assessed: 'The eligible amount has been worked out and needs an approver.',
  approved: 'Approved and waiting to be paid.',
  rejected: 'Refused, with a reason on the record.',
  paid: 'Paid, with a journal entry behind it.',
  cancelled: 'Withdrawn before any decision was made.',
  reversed: 'The payment was reversed by a contra entry. The original stands.',
} as const;

/** Statuses from which nothing further happens. */
export const TERMINAL_BENEFIT_CLAIM_STATUSES: readonly BenefitClaimStatus[] = [
  'rejected',
  'cancelled',
  'reversed',
] as const;

export function isTerminalBenefitClaimStatus(status: BenefitClaimStatus): boolean {
  return TERMINAL_BENEFIT_CLAIM_STATUSES.includes(status);
}

/**
 * Statuses in which a claim has committed part of a member's annual
 * entitlement.
 *
 * Mirrors the status list in `medical_benefit_consumed()`, and the agreement
 * matters: a screen that showed remaining capacity over a different set from
 * the one the database reserves against would show a number the assessment
 * then refuses.
 *
 * `assessed` is in the list, which is the whole point — a cap that counted only
 * completed payments would let two approvals share one member's ceiling.
 * `reversed` is not, because the money came back.
 */
export const CAP_CONSUMING_BENEFIT_STATUSES: readonly BenefitClaimStatus[] = [
  'assessed',
  'approved',
  'paid',
] as const;

export function consumesAnnualCap(status: BenefitClaimStatus): boolean {
  return CAP_CONSUMING_BENEFIT_STATUSES.includes(status);
}

/**
 * The transitions the database allows.
 *
 * Mirrors `benefit_claim_transition_allowed()`, and a database test asserts
 * the two agree edge for edge. This copy exists so an interface can offer only
 * the controls that will work: a button that posts a transition the guard
 * refuses is a button that teaches people the system is unreliable.
 */
export const BENEFIT_CLAIM_TRANSITIONS: Readonly<
  Record<BenefitClaimStatus, readonly BenefitClaimStatus[]>
> = {
  draft: ['submitted', 'cancelled'],
  submitted: [
    'under_verification',
    'information_required',
    'assessed',
    'rejected',
    'cancelled',
  ],
  under_verification: ['information_required', 'assessed', 'rejected', 'cancelled'],
  information_required: ['under_verification', 'assessed', 'rejected', 'cancelled'],
  // An approver's three options, plus sending it back. Sending it back is not
  // a rejection — the commonest reason is an arithmetic disagreement — and it
  // returns to the stage where the assessment is made.
  assessed: [
    'approved',
    'rejected',
    'under_verification',
    'information_required',
    'cancelled',
  ],
  // Not `cancelled`. An approved claim the business changes its mind about is
  // a refusal by somebody with the authority to refuse, and it needs a reason
  // on the record rather than a withdrawal note.
  approved: ['paid', 'rejected'],
  rejected: [],
  paid: ['reversed'],
  cancelled: [],
  reversed: [],
} as const;

export function canTransitionBenefitClaim(
  from: BenefitClaimStatus,
  to: BenefitClaimStatus,
): boolean {
  return BENEFIT_CLAIM_TRANSITIONS[from].includes(to);
}

/** Statuses a claim may still be worked on from. */
export function isBenefitClaimOpen(status: BenefitClaimStatus): boolean {
  return BENEFIT_CLAIM_TRANSITIONS[status].length > 0;
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/**
 * What a medical benefit is worth before any cap.
 *
 * `(bill * rate_bps + 5000) / 10000` in integer arithmetic — exactly half-up
 * for non-negative operands, and the same form `benefit_amount_for_claim()`
 * uses in the database, the penalty engine uses for a late charge and the loan
 * engine uses for interest.
 *
 * On a UGX 400,000 bill at 500 basis points: 20,000 shillings.
 *
 * `applyRateBps` is Phase 1's `BigInt` helper rather than arithmetic written
 * out here, so there is one implementation of half-up rate application in the
 * codebase and not four that could disagree on a rounding boundary.
 */
export function medicalBenefitAmount(billAmount: number, rateBps: number): UgxAmount {
  if (!Number.isSafeInteger(billAmount) || billAmount < 0) {
    throw new RangeError('A hospital bill is a whole number of shillings, not negative.');
  }

  if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
    throw new RangeError(
      'A benefit rate is a non-negative whole number of basis points.',
    );
  }

  return applyRateBps(toUgx(billAmount), rateBps);
}

/** The fixed-amount policy figures a claim of each type reads. */
export interface BenefitPolicyAmounts {
  readonly medicalBenefitRateBps: number;
  readonly familyCondolenceBenefit: number;
  readonly memberBereavementBenefit: number;
}

/**
 * What a claim of any type is worth before caps.
 *
 * Mirrors `benefit_amount_for_claim()`. The two fixed benefits are the policy's
 * own figures, returned unchanged: neither is capped, counted or pro-rated, so
 * there is nothing for the amount to be other than the figure.
 */
export function benefitAmountFor(
  type: BenefitClaimType,
  amounts: BenefitPolicyAmounts,
  billAmount: number | null,
): UgxAmount | null {
  switch (type) {
    case 'medical':
      return billAmount === null
        ? null
        : medicalBenefitAmount(billAmount, amounts.medicalBenefitRateBps);
    case 'family_condolence':
      return toUgx(amounts.familyCondolenceBenefit);
    case 'member_bereavement':
      return toUgx(amounts.memberBereavementBenefit);
  }
}

// ---------------------------------------------------------------------------
// The three readings of "an admission longer than one day"
// ---------------------------------------------------------------------------

/**
 * How long an admission lasted, on each of the three defensible readings.
 *
 * The client's documents say the admission must be "longer than one day" and
 * do not say what is being counted. Three readings are defensible, and for a
 * stay of about a day they disagree:
 *
 *   `nights`        Monday 22:00 to Tuesday 09:00 is 1
 *   `inclusiveDays` the same stay is 2, which is what a ward chart says
 *   `elapsedDays`   the same stay is 0, which is what a clock says
 *
 * All three are stored on the claim by the database and all three are
 * recomputed here, so a form can show a clerk what the stay will be read as
 * before they submit it.
 *
 * `nights` and `inclusiveDays` are calendar-day differences in the business
 * timezone; `elapsedDays` is whole 24-hour periods. The caller passes dates
 * already in Africa/Kampala, because turning an instant into a Kampala
 * calendar day is `lib/domain/datetime.ts`'s job and not this module's.
 */
export interface AdmissionLength {
  readonly nights: number;
  readonly inclusiveDays: number;
  readonly elapsedDays: number;
}

export function admissionLength(
  admittedAt: Date,
  dischargedAt: Date,
  kampalaDayOf: (instant: Date) => string,
): AdmissionLength {
  const admittedDay = Date.parse(`${kampalaDayOf(admittedAt)}T00:00:00Z`);
  const dischargedDay = Date.parse(`${kampalaDayOf(dischargedAt)}T00:00:00Z`);

  const nights = Math.round((dischargedDay - admittedDay) / 86_400_000);
  const elapsedMs = dischargedAt.getTime() - admittedAt.getTime();

  return {
    nights,
    inclusiveDays: nights + 1,
    elapsedDays: Math.floor(elapsedMs / 86_400_000),
  };
}

/**
 * Whether an admission clears the policy threshold, and on which readings.
 *
 * `qualifies` only when **every** reading exceeds the threshold, and
 * `undecided` when they disagree — which is the arm the database refuses with
 * `admission_measure_undecided`. So a stay that qualifies on one reading is
 * never quietly paid, and one that qualifies on all of them never waits for a
 * decision it does not need.
 *
 * This is the same discipline Phase 3 applied to the four interest
 * basis/method combinations: implement every arm, refuse the one that is not a
 * calculation, default nothing.
 */
export interface AdmissionVerdict {
  readonly qualifies: boolean;
  readonly undecided: boolean;
  readonly tooShort: boolean;
}

export function admissionVerdict(
  length: AdmissionLength,
  minimumDays: number,
): AdmissionVerdict {
  const readings = [length.nights, length.inclusiveDays, length.elapsedDays];
  const clearing = readings.filter((reading) => reading > minimumDays).length;

  return {
    qualifies: clearing === readings.length,
    tooShort: clearing === 0,
    undecided: clearing > 0 && clearing < readings.length,
  };
}

// ---------------------------------------------------------------------------
// The eligibility codes
// ---------------------------------------------------------------------------

/**
 * Every reason a claim cannot be assessed.
 *
 * Mirrors the codes `benefit_claim_eligibility()` returns, and a database test
 * asserts the lists agree. Seven of the sixteen are an undecided client rule
 * named explicitly, which is the honest state of this phase: the client's
 * documents confirm three amounts and one rate, and leave the ceiling, the
 * period, the measure, the eligible relative, the consequence of suspension
 * and the loan interaction open.
 */
export const BENEFIT_ELIGIBILITY_CODES = [
  'policy_not_open',
  'membership_not_claimable',
  'membership_suspended_undecided',
  'waiting_period_not_served',
  'admission_not_ended',
  'admission_too_short',
  'admission_measure_undecided',
  'medical_year_basis_undecided',
  'medical_claims_exhausted',
  'medical_cap_exceeded',
  'relationship_eligibility_undecided',
  'relationship_not_eligible',
  'beneficiary_missing',
  'beneficiary_not_verified',
  'bereavement_loan_offset_undecided',
  'evidence_missing',
  'claim_not_in_assessable_state',
] as const;

export type BenefitEligibilityCode = (typeof BENEFIT_ELIGIBILITY_CODES)[number];

/**
 * The codes that mean "nobody has decided", rather than "this claim does not
 * qualify".
 *
 * The distinction is what a screen has to get right. "Your admission was too
 * short" is a refusal the member can be told. "Nobody has decided which of
 * three ways we count a day" is the business owing itself an answer, and
 * showing it as a refusal would make the member think they had been turned
 * down.
 */
export const UNDECIDED_BENEFIT_ELIGIBILITY_CODES: readonly BenefitEligibilityCode[] = [
  'policy_not_open',
  'membership_suspended_undecided',
  'admission_measure_undecided',
  'medical_year_basis_undecided',
  'relationship_eligibility_undecided',
  'bereavement_loan_offset_undecided',
] as const;

export function isUndecidedEligibilityCode(code: string): boolean {
  return (UNDECIDED_BENEFIT_ELIGIBILITY_CODES as readonly string[]).includes(code);
}

/** The heading a screen puts above each kind of refusal. */
export const BENEFIT_ELIGIBILITY_CODE_LABELS: Readonly<
  Record<BenefitEligibilityCode, string>
> = {
  policy_not_open: 'Benefit payments are not open yet',
  membership_not_claimable: 'This membership cannot claim',
  membership_suspended_undecided: 'What a suspension costs a member is undecided',
  waiting_period_not_served: 'The waiting period has not been served',
  admission_not_ended: 'The admission has not ended',
  admission_too_short: 'The admission was too short',
  admission_measure_undecided: 'How an admission is measured is undecided',
  medical_year_basis_undecided: 'The benefit year is undefined',
  medical_claims_exhausted: 'This year’s claims are used up',
  medical_cap_exceeded: 'This would exceed the annual cap',
  relationship_eligibility_undecided: 'Who counts as family is undecided',
  relationship_not_eligible: 'That relationship is not eligible',
  beneficiary_missing: 'No beneficiary is registered',
  beneficiary_not_verified: 'The beneficiary has not been verified',
  bereavement_loan_offset_undecided:
    'Whether an outstanding loan reduces this benefit is undecided',
  evidence_missing: 'Required evidence has not been checked',
  claim_not_in_assessable_state: 'This claim is not waiting to be assessed',
} as const;

// ---------------------------------------------------------------------------
// The benefit year
// ---------------------------------------------------------------------------

/**
 * How the medical benefit's annual cap and claim count are measured.
 *
 * A tenth decision, and not one of the client's nine. §9 of the Phase 4 brief
 * names it: is the cap a calendar year or an anniversary year? It cannot be
 * guessed — a member admitted in December and again in January has either one
 * year's cap or two — so it is a nullable column on the policy version with
 * both arms implemented and no default.
 */
export const BENEFIT_YEAR_BASES = ['calendar_year', 'enrolment_anniversary'] as const;
export type BenefitYearBasis = (typeof BENEFIT_YEAR_BASES)[number];

export function isBenefitYearBasis(value: unknown): value is BenefitYearBasis {
  return (
    typeof value === 'string' && (BENEFIT_YEAR_BASES as readonly string[]).includes(value)
  );
}

export const BENEFIT_YEAR_BASIS_LABELS: Readonly<Record<BenefitYearBasis, string>> = {
  calendar_year: 'The calendar year, 1 January to 31 December',
  enrolment_anniversary: 'The year from the member’s own enrolment anniversary',
} as const;

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

export const BENEFICIARY_STATUSES = ['active', 'superseded', 'revoked'] as const;
export type BeneficiaryStatus = (typeof BENEFICIARY_STATUSES)[number];

export const BENEFICIARY_STATUS_LABELS: Readonly<Record<BeneficiaryStatus, string>> = {
  active: 'Current',
  superseded: 'Replaced',
  revoked: 'Withdrawn',
} as const;

/**
 * Whether a beneficiary record has been checked.
 *
 * Derived by the database and never supplied: `verify_member_beneficiary` is
 * the only route to `verified`, and it refuses a verification from whoever
 * recorded the record. A column anybody can assert is not a control, which is
 * the lesson ADR-055 drew for consent.
 */
export const BENEFICIARY_VERIFICATION_STATUSES = [
  'pending_verification',
  'verified',
  'rejected',
] as const;

export type BeneficiaryVerificationStatus =
  (typeof BENEFICIARY_VERIFICATION_STATUSES)[number];

export const BENEFICIARY_VERIFICATION_LABELS: Readonly<
  Record<BeneficiaryVerificationStatus, string>
> = {
  pending_verification: 'Not yet checked',
  verified: 'Verified',
  rejected: 'Refused',
} as const;

/**
 * What a verification may rest on.
 *
 * Each is something a member of staff cannot simply type. A document kind is
 * checked against the private bucket under this membership's own path, which
 * is the technique `membership_consent_evidence` introduced: a path naming a
 * file nobody uploaded verifies nothing.
 */
export const BENEFICIARY_EVIDENCE_KINDS = [
  'relationship_document',
  'identity_document',
  'witnessed_in_branch',
  'existing_client_record',
] as const;

export type BeneficiaryEvidenceKind = (typeof BENEFICIARY_EVIDENCE_KINDS)[number];

export const BENEFICIARY_EVIDENCE_KIND_LABELS: Readonly<
  Record<BeneficiaryEvidenceKind, string>
> = {
  relationship_document: 'A document evidencing the relationship',
  identity_document: 'The beneficiary’s identity document',
  witnessed_in_branch: 'Witnessed at the branch by a second member of staff',
  existing_client_record: 'The beneficiary is already a client of the business',
} as const;

/** Evidence kinds that require an uploaded object the database can check. */
export const DOCUMENT_BENEFICIARY_EVIDENCE_KINDS: readonly BeneficiaryEvidenceKind[] = [
  'relationship_document',
  'identity_document',
] as const;

export function beneficiaryEvidenceNeedsDocument(kind: BeneficiaryEvidenceKind): boolean {
  return DOCUMENT_BENEFICIARY_EVIDENCE_KINDS.includes(kind);
}

/**
 * The identity documents a beneficiary may be identified by.
 *
 * Deliberately wider than the client record's, and deliberately not a
 * National Identification Number field. A beneficiary is a third party who has
 * consented to nothing, may be a minor, and may hold no national ID at all —
 * and the client's approved procedure for identifying them does not exist yet.
 * So the record says *what document was shown* and the question of which
 * documents are acceptable stays the client's.
 */
export const BENEFICIARY_IDENTITY_DOCUMENT_KINDS = [
  'national_id',
  'passport',
  'drivers_licence',
  'village_letter',
  'birth_certificate',
  'other',
] as const;

export type BeneficiaryIdentityDocumentKind =
  (typeof BENEFICIARY_IDENTITY_DOCUMENT_KINDS)[number];

export const BENEFICIARY_IDENTITY_DOCUMENT_LABELS: Readonly<
  Record<BeneficiaryIdentityDocumentKind, string>
> = {
  national_id: 'National identification card',
  passport: 'Passport',
  drivers_licence: 'Driving licence',
  village_letter: 'Letter from the local council',
  birth_certificate: 'Birth certificate',
  other: 'Other document',
} as const;

/**
 * Whether a beneficiary record may receive a bereavement payment.
 *
 * Both halves are required, and they are two different facts: `active` says
 * this is the business's live instruction, `verified` says somebody checked it.
 * A superseded record keeps its verification — that is what makes a historic
 * payment explicable — so a reader asking "who may be paid" has to ask both.
 */
export function beneficiaryMayBePaid(
  status: BeneficiaryStatus,
  verification: BeneficiaryVerificationStatus,
  isPrimary: boolean,
): boolean {
  return status === 'active' && verification === 'verified' && isPrimary;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Whether a piece of evidence has been checked.
 *
 * `unchecked` on every upload, and never supplied by a caller. This is the
 * distinction §12 of the brief turns on, and the one way an evidence workflow
 * becomes decorative: a file is uploaded, a tick appears, and the tick means
 * "a file exists". Assessment counts only `verified` documents, so an
 * unchecked upload advances a claim no further than no upload at all.
 */
export const BENEFIT_DOCUMENT_VERIFICATION_STATUSES = [
  'unchecked',
  'verified',
  'rejected',
] as const;

export type BenefitDocumentVerificationStatus =
  (typeof BENEFIT_DOCUMENT_VERIFICATION_STATUSES)[number];

export const BENEFIT_DOCUMENT_VERIFICATION_LABELS: Readonly<
  Record<BenefitDocumentVerificationStatus, string>
> = {
  unchecked: 'Not yet checked',
  verified: 'Checked',
  rejected: 'Refused',
} as const;

/**
 * Document kinds only an assessor may file.
 *
 * A counter clerk who could manufacture an assessment working paper or an
 * authorisation document could make a claim *look* authorised, which would
 * undo the whole control with a file upload. Enforced by the storage policy
 * and by the metadata guard; named here so a form can hide what it would
 * refuse.
 */
export const INTERNAL_BENEFIT_DOCUMENT_KINDS: readonly string[] = [
  'assessment_attachment',
  'authorisation_document',
] as const;

export function benefitDocumentIsInternal(kind: string): boolean {
  return INTERNAL_BENEFIT_DOCUMENT_KINDS.includes(kind);
}
