/**
 * Validation for the parts of a loan application a product decides it needs.
 *
 * Separate from `loan.ts`, which holds the shape every loan has — borrower,
 * amount, period, cadence — because these are the questions a *particular*
 * product asks. A Salary Loan asks who employs the borrower; a Business Loan
 * asks what the business turns over; a Quick Loan asks neither. Putting them
 * in one schema with everything optional would mean a schema that validates
 * nothing.
 *
 * The same three principles `client.ts` states apply, and one more that
 * matters here specifically:
 *
 *   **Nothing below decides whether a question must be answered.** That is the
 *   product's `application_profile`, read server-side, and re-checked by
 *   `validate_loan_for_approval` at the moment of the decision. These schemas
 *   check that an answer given is well-formed. A form that decided its own
 *   requirements from a hidden field would be no check at all.
 */

import { z } from 'zod';

import { ugandanPhoneSchema, uuidSchema } from './common';

const text = (label: string, max: number, min = 2) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(min, `${label} is required.`)
    .max(max, `${label} must be ${String(max)} characters or fewer.`);

const optional = (max: number) =>
  z
    .union([z.string().trim().max(max), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

/**
 * A whole number of shillings, as typed.
 *
 * Fractional input is rejected rather than rounded, on the same reasoning as
 * `loanPrincipalSchema`: somebody typing `450000.50` is either mistyping or
 * thinking in a currency that is not UGX, and rounding hides which.
 */
const shillings = (label: string, max: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .transform((value, ctx) => {
      const cleaned = value.replace(/[\s,]/g, '');

      if (!/^\d+$/.test(cleaned)) {
        ctx.addIssue({
          code: 'custom',
          message: `Enter ${label.toLowerCase()} as a whole number of shillings.`,
        });
        return z.NEVER;
      }

      const amount = Number(cleaned);

      if (!Number.isSafeInteger(amount) || amount > max) {
        ctx.addIssue({ code: 'custom', message: `That is larger than ${label} can be.` });
        return z.NEVER;
      }

      return amount;
    });

/** The same, where the business accepts "we have never counted it". */
const optionalShillings = (label: string, max: number) =>
  z
    .union([shillings(label, max), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

const pastDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date as YYYY-MM-DD.')
    .refine((value) => value >= '1900-01-01', { message: 'Check the year.' });

const optionalPastDate = (label: string) =>
  z
    .union([pastDate(label), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null);

// ---------------------------------------------------------------------------
// Salary loans
// ---------------------------------------------------------------------------

export const EMPLOYMENT_STATUSES = [
  'permanent',
  'contract',
  'probation',
  'casual',
] as const;

export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const EMPLOYMENT_STATUS_LABELS: Readonly<Record<EmploymentStatus, string>> = {
  permanent: 'Permanent',
  contract: 'Contract',
  probation: 'On probation',
  casual: 'Casual',
};

export const SALARY_VERIFICATIONS = [
  'not_checked',
  'payslip_seen',
  'employer_confirmed',
  'bank_statement',
] as const;

export type SalaryVerification = (typeof SALARY_VERIFICATIONS)[number];

export const SALARY_VERIFICATION_LABELS: Readonly<Record<SalaryVerification, string>> = {
  not_checked: 'Not checked',
  payslip_seen: 'Payslip seen',
  employer_confirmed: 'Confirmed with the employer',
  bank_statement: 'Seen on a bank statement',
};

/**
 * The questions a salary product asks.
 *
 * `salaryPayDay` is required and is the one field a collection officer
 * actually uses: a schedule that ignores the day the money lands asks a
 * borrower to pay the day before they are paid.
 */
export const salaryDetailsSchema = z.object({
  loanId: uuidSchema,
  employerName: text('Employer name', 120),
  employerContact: optional(120),
  jobTitle: text('Job title', 80),
  staffNumber: optional(40),
  netMonthlySalary: shillings('Net monthly salary', 1_000_000_000),
  salaryPayDay: z.coerce
    .number({ error: 'Enter the day of the month the salary is paid.' })
    .int('Enter a day of the month, 1 to 31.')
    .min(1, 'Enter a day of the month, 1 to 31.')
    .max(31, 'Enter a day of the month, 1 to 31.'),
  employmentStartedOn: optionalPastDate('Employment start date'),
  employmentStatus: z
    .union([z.enum(EMPLOYMENT_STATUSES), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  salaryVerification: z.enum(SALARY_VERIFICATIONS).default('not_checked'),
});

export type SalaryDetailsInput = z.infer<typeof salaryDetailsSchema>;

// ---------------------------------------------------------------------------
// Business loans
// ---------------------------------------------------------------------------

export const PREMISES_OWNERSHIP = ['owned', 'rented', 'family', 'mobile'] as const;

export type PremisesOwnership = (typeof PREMISES_OWNERSHIP)[number];

export const PREMISES_OWNERSHIP_LABELS: Readonly<Record<PremisesOwnership, string>> = {
  owned: 'Owned',
  rented: 'Rented',
  family: 'Family property',
  mobile: 'Mobile or no fixed premises',
};

/**
 * The questions a business product asks.
 *
 * `loanPurpose` is required and bounded at both ends: the single most useful
 * line on a business application, and the one a Quick Loan deliberately does
 * not ask. Five characters is the floor because "cash" is not a purpose.
 */
export const businessDetailsSchema = z.object({
  loanId: uuidSchema,
  businessName: text('Business name', 120),
  businessType: text('Business type', 80),
  businessLocation: text('Business location', 120),
  businessContact: optional(120),
  tradingSince: optionalPastDate('Trading since'),
  monthlyTurnover: shillings('Monthly turnover', 10_000_000_000),
  monthlyExpenses: optionalShillings('Monthly expenses', 10_000_000_000),
  employeeCount: z
    // The empty branch first: `z.coerce.number()` turns `''` into `0`, and a
    // business that did not answer "how many people do you employ" has not
    // answered zero.
    .union([z.literal(''), z.coerce.number().int().min(0).max(10_000)])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  premisesOwnership: z
    .union([z.enum(PREMISES_OWNERSHIP), z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  tradingLicenceNumber: optional(60),
  loanPurpose: z
    .string({ error: 'Say what the loan is for.' })
    .trim()
    .min(5, 'Say what the loan is for, in a few words.')
    .max(500, 'The purpose cannot be longer than 500 characters.'),
});

export type BusinessDetailsInput = z.infer<typeof businessDetailsSchema>;

// ---------------------------------------------------------------------------
// Guarantors
// ---------------------------------------------------------------------------

const relationshipSchema = text('Relationship to the borrower', 60);

/** Attaching somebody already in the client register. */
export const attachClientGuarantorSchema = z.object({
  loanId: uuidSchema,
  guarantorClientId: uuidSchema,
  relationshipToClient: relationshipSchema,
});

/**
 * Capturing somebody new, from inside the application.
 *
 * The whole point of this schema is that it exists: the business should not
 * have to leave the loan form, register a guarantor, and come back. So it
 * carries everything `createGuarantorSchema` does plus the relationship, and
 * the action behind it writes both records in one go.
 */
export const attachExternalGuarantorSchema = z
  .object({
    loanId: uuidSchema,
    fullName: z
      .string({ error: 'Full name is required.' })
      .trim()
      .min(2, 'Full name must be at least 2 characters.')
      .max(120, 'Full name must be 120 characters or fewer.')
      .regex(
        /^[\p{L}][\p{L}\s'\-.]*$/u,
        'Full name may only contain letters, spaces, hyphens, apostrophes and full stops.',
      ),
    sex: z.enum(['female', 'male'], { error: 'Select female or male.' }),
    dateOfBirth: pastDate('Date of birth'),
    phone: ugandanPhoneSchema,
    alternativePhone: z
      .union([ugandanPhoneSchema, z.literal('')])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    occupation: text('Occupation', 80),
    employerName: optional(120),
    location: text('Location', 120),
    district: optional(60),
    nin: z
      .union([
        z
          .string()
          .trim()
          .transform((value) => value.replace(/\s+/g, '').toUpperCase())
          .pipe(
            z
              .string()
              .regex(
                /^[A-Z0-9]{14}$/,
                'A National Identification Number is 14 letters and digits.',
              ),
          ),
        z.literal(''),
      ])
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    relationshipToClient: relationshipSchema,
  })
  .refine((value) => value.alternativePhone !== value.phone, {
    message: 'The alternative number is the same as the main number.',
    path: ['alternativePhone'],
  });

export type AttachExternalGuarantorInput = z.infer<typeof attachExternalGuarantorSchema>;

export const removeLoanGuarantorSchema = z.object({
  loanId: uuidSchema,
  loanGuarantorId: uuidSchema,
});

/**
 * The undertaking a guarantor signs.
 *
 * Every field is required, which is the `loan_guarantors_consent_complete`
 * constraint stated in the layer a person sees. "Partially signed" is not a
 * state the business recognises: a consent with a date and no witness is not
 * something anybody could enforce, and offering it as a half-way point would
 * fill the register with undertakings that look signed and are not.
 */
export const recordGuarantorConsentSchema = z.object({
  loanId: uuidSchema,
  loanGuarantorId: uuidSchema,
  signatureName: text('The name as signed', 120),
  witnessName: text('Witness name', 120),
  witnessPhone: z
    .union([ugandanPhoneSchema, z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  consentPlace: optional(120),
  accepted: z
    .string()
    .optional()
    .transform((value) => value === 'on' || value === 'true')
    .refine((value) => value, {
      message: 'The guarantor must accept the undertaking before it can be recorded.',
    }),
});

export type RecordGuarantorConsentInput = z.infer<typeof recordGuarantorConsentSchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const LOAN_DOCUMENT_KINDS = [
  'payslip',
  'employment_letter',
  'trading_licence',
  'bank_statement',
  'business_photo',
  'guarantor_identification',
  'guarantor_photograph',
  'guarantor_signature',
  'supporting',
] as const;

export type LoanDocumentKind = (typeof LOAN_DOCUMENT_KINDS)[number];

export const LOAN_DOCUMENT_LABELS: Readonly<Record<LoanDocumentKind, string>> = {
  payslip: 'Payslip',
  employment_letter: 'Employment letter',
  trading_licence: 'Trading licence',
  bank_statement: 'Bank statement',
  business_photo: 'Business photograph',
  guarantor_identification: 'Guarantor identification',
  guarantor_photograph: 'Guarantor photograph',
  guarantor_signature: 'Guarantor signature',
  supporting: 'Supporting document',
};

/** The three kinds that belong to a guarantor rather than to the application. */
export const GUARANTOR_DOCUMENT_KINDS = [
  'guarantor_identification',
  'guarantor_photograph',
  'guarantor_signature',
] as const;

export function isGuarantorDocumentKind(kind: LoanDocumentKind): boolean {
  return (GUARANTOR_DOCUMENT_KINDS as readonly string[]).includes(kind);
}

export const uploadLoanDocumentSchema = z.object({
  loanId: uuidSchema,
  kind: z.enum(LOAN_DOCUMENT_KINDS, { error: 'Choose what this document is.' }),
  loanGuarantorId: z
    .union([uuidSchema, z.literal('')])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Two characters at the floor, matching the column's own constraint: a
  // one-letter description would be refused by the database, and a
  // constraint violation is a worse sentence than this one.
  label: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .min(2, 'A description needs at least two characters, or leave it blank.')
        .max(120, 'A description cannot be longer than 120 characters.'),
    ])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

export const removeLoanDocumentSchema = z.object({
  loanId: uuidSchema,
  documentId: uuidSchema,
});

// ---------------------------------------------------------------------------
// Refusing an application
// ---------------------------------------------------------------------------

/**
 * Refusing, which is not cancelling.
 *
 * The reason is required and the lower bound is the same as a cancellation's:
 * "no" is not a reason, and this is a permanent record of a credit decision
 * that a borrower may well come back and ask about.
 */
export const rejectLoanSchema = z.object({
  loanId: uuidSchema,
  reason: z
    .string({ error: 'Say why this application is being refused.' })
    .trim()
    .min(3, 'Say why. This is recorded against the application permanently.')
    .max(500, 'A reason cannot be longer than 500 characters.'),
});
