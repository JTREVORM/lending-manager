/**
 * Guaranteeing a loan: who may, what they sign, and how to say why not.
 *
 * Pure. The rules themselves live in the database —
 * `loan_guarantors_check_eligibility` refuses the write and
 * `validate_loan_for_approval` refuses the approval, both re-evaluated at the
 * moment that matters. What is here is the vocabulary the screens use to
 * explain those rules to the person filling in the form.
 *
 * ## Why the reasons are codes rather than sentences
 *
 * `public.guarantor_candidates` returns `reasons` as an array of codes, which
 * means the database says *what* is wrong and this module says *how to put
 * it*. A sentence crossing that boundary would be a user-facing string stored
 * in a migration, changeable only by a schema change, and untranslatable.
 */

/** How a guarantor is identified: an existing borrower, or somebody new. */
export const GUARANTOR_SUBJECT_KINDS = ['client', 'external'] as const;

export type GuarantorSubjectKind = (typeof GUARANTOR_SUBJECT_KINDS)[number];

export function isGuarantorSubjectKind(value: unknown): value is GuarantorSubjectKind {
  return (
    typeof value === 'string' &&
    (GUARANTOR_SUBJECT_KINDS as readonly string[]).includes(value)
  );
}

export const GUARANTOR_SUBJECT_LABELS: Readonly<Record<GuarantorSubjectKind, string>> = {
  client: 'Existing client',
  external: 'External guarantor',
};

/**
 * Why a client may not back a particular application.
 *
 * `not_active_*` is a family rather than a value: the database appends the
 * client's own status, so a suspended client and a blacklisted one are
 * distinguishable without this list having to track the client status enum.
 */
export const GUARANTOR_INELIGIBILITY_REASONS = [
  'is_borrower',
  'already_attached',
  'clients_not_allowed',
  'underage',
  'no_identification',
  'has_active_loan',
  'in_arrears',
  'guarantee_limit',
] as const;

export type GuarantorIneligibilityReason =
  (typeof GUARANTOR_INELIGIBILITY_REASONS)[number];

/**
 * What to tell the person looking at the screen.
 *
 * Written so that a staff member can act on it. "Not eligible" sends somebody
 * to look up a rule; "already guarantees 2 active loans, which is the limit"
 * lets them pick somebody else and get on with their morning.
 */
export function describeGuarantorIneligibility(
  reason: string,
  context?: {
    readonly guaranteeingCount?: number;
    readonly activeLoanCount?: number;
    readonly minAgeYears?: number;
  },
): string {
  if (reason.startsWith('not_active_')) {
    const status = reason.slice('not_active_'.length);
    return `This client is ${status} and cannot guarantee a loan.`;
  }

  switch (reason) {
    case 'is_borrower':
      return 'This is the borrower. Nobody can guarantee their own loan.';
    case 'already_attached':
      return 'Already a guarantor on this application.';
    case 'clients_not_allowed':
      return 'The business does not currently permit a borrower to guarantee another borrower’s loan.';
    case 'underage':
      return context?.minAgeYears === undefined
        ? 'Below the age the business requires of a guarantor.'
        : `Under ${String(context.minAgeYears)}, the age the business requires of a guarantor.`;
    case 'no_identification':
      return 'No identification on file. A guarantor needs a recorded NIN.';
    case 'has_active_loan':
      return context?.activeLoanCount === undefined || context.activeLoanCount <= 1
        ? 'Has an outstanding loan of their own.'
        : `Has ${String(context.activeLoanCount)} outstanding loans of their own.`;
    case 'in_arrears':
      return 'Behind on their own repayments.';
    case 'guarantee_limit':
      return context?.guaranteeingCount === undefined
        ? 'Already guarantees as many active loans as the business permits.'
        : `Already guarantees ${String(context.guaranteeingCount)} active loans, which is the limit the business permits.`;
    default:
      // An unrecognised code is still worth showing: it is a rule somebody
      // added, and silently dropping it would present an ineligible candidate
      // as eligible.
      return 'Not eligible to guarantee this loan.';
  }
}

/**
 * The relationships a guarantor commonly has to a borrower.
 *
 * Offered as suggestions, not enforced: the column is free text with a
 * not-blank constraint, because a lending business meets relationships no
 * list anticipates. The screen offers these and accepts anything.
 */
export const COMMON_GUARANTOR_RELATIONSHIPS = [
  'Spouse',
  'Parent',
  'Child',
  'Brother',
  'Sister',
  'Relative',
  'Friend',
  'Neighbour',
  'Business partner',
  'Employer',
  'Colleague',
] as const;

/**
 * Is this consent complete enough to be relied on?
 *
 * The same rule as the `loan_guarantors_consent_complete` constraint, stated
 * here so the form can say what is missing before the database refuses it.
 * A consent is all of its parts or none of them: a date with no signatory, or
 * a signatory with no witness, is not something anybody could enforce.
 */
export function consentIsComplete(input: {
  readonly signatureName: string | null;
  readonly witnessName: string | null;
  readonly consentedAt: string | null;
  readonly termsVersion: string | null;
}): boolean {
  return (
    input.consentedAt !== null &&
    input.termsVersion !== null &&
    input.signatureName !== null &&
    input.signatureName.trim() !== '' &&
    input.witnessName !== null &&
    input.witnessName.trim() !== ''
  );
}
