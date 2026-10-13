import { describe, expect, it } from 'vitest';

import {
  LOAN_CLOSURE_KINDS,
  LOAN_WORKFLOW_STAGES,
  describeLoanApprovalFailure,
  isLoanApprovalFailure,
  isLoanClosureKind,
  isLoanWorkflowStage,
} from '@/lib/domain/loan';
import {
  GUARANTOR_SUBJECT_KINDS,
  consentIsComplete,
  describeGuarantorIneligibility,
  isGuarantorSubjectKind,
} from '@/lib/domain/guarantor';
import {
  attachClientGuarantorSchema,
  attachExternalGuarantorSchema,
  businessDetailsSchema,
  isGuarantorDocumentKind,
  recordGuarantorConsentSchema,
  rejectLoanSchema,
  salaryDetailsSchema,
  uploadLoanDocumentSchema,
} from '@/lib/validation/loan-application';

const LOAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GUARANTOR_ROW_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CLIENT_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

/**
 * The Phase 13 application layer, as rules rather than as screens.
 *
 * Everything here is pure, which is the point: the product-specific questions,
 * the guarantor capture and the undertaking are the parts of a loan file a
 * dispute turns on, and "the form rejected it" is not a claim worth making
 * unless the rule can be driven directly.
 */

// ---------------------------------------------------------------------------
describe('the questions a salary product asks', () => {
  const VALID = {
    loanId: LOAN_ID,
    employerName: 'Mukwano Industries',
    employerContact: '+256700111222',
    jobTitle: 'Machine operator',
    staffNumber: 'MI-4471',
    netMonthlySalary: '850000',
    salaryPayDay: '28',
    employmentStartedOn: '2022-03-01',
    employmentStatus: 'permanent',
    salaryVerification: 'payslip_seen',
  };

  it('accepts a complete answer', () => {
    expect(salaryDetailsSchema.safeParse(VALID).success).toBe(true);
  });

  it.each(['employerName', 'jobTitle', 'netMonthlySalary', 'salaryPayDay'])(
    'requires %s',
    (field) => {
      expect(salaryDetailsSchema.safeParse({ ...VALID, [field]: '' }).success).toBe(
        false,
      );
    },
  );

  it('treats the contact, staff number and start date as optional', () => {
    const parsed = salaryDetailsSchema.safeParse({
      ...VALID,
      employerContact: '',
      staffNumber: '',
      employmentStartedOn: '',
      employmentStatus: '',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.employerContact).toBeNull();
      expect(parsed.data.staffNumber).toBeNull();
      expect(parsed.data.employmentStartedOn).toBeNull();
      expect(parsed.data.employmentStatus).toBeNull();
    }
  });

  it('reads a salary with separators as a whole number of shillings', () => {
    const parsed = salaryDetailsSchema.safeParse({
      ...VALID,
      netMonthlySalary: '850,000',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.netMonthlySalary).toBe(850_000);
  });

  it('rejects a fractional salary rather than rounding it', () => {
    // Somebody typing 850000.50 has either mistyped or is thinking in a
    // currency that is not UGX, and rounding hides which.
    expect(
      salaryDetailsSchema.safeParse({ ...VALID, netMonthlySalary: '850000.50' }).success,
    ).toBe(false);
  });

  it.each(['0', '32', '-1'])('rejects %s as a day of the month', (day) => {
    expect(salaryDetailsSchema.safeParse({ ...VALID, salaryPayDay: day }).success).toBe(
      false,
    );
  });

  it('rejects an employment status it does not recognise', () => {
    expect(
      salaryDetailsSchema.safeParse({ ...VALID, employmentStatus: 'freelance' }).success,
    ).toBe(false);
  });

  it('defaults the verification to not checked', () => {
    const { salaryVerification: _omitted, ...withoutVerification } = VALID;
    const parsed = salaryDetailsSchema.safeParse(withoutVerification);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.salaryVerification).toBe('not_checked');
  });
});

// ---------------------------------------------------------------------------
describe('the questions a business product asks', () => {
  const VALID = {
    loanId: LOAN_ID,
    businessName: 'Kalerwe Produce Stall',
    businessType: 'Produce retail',
    businessLocation: 'Kalerwe market, Kampala',
    businessContact: '+256700333444',
    tradingSince: '2019-06-01',
    monthlyTurnover: '2400000',
    monthlyExpenses: '1600000',
    employeeCount: '2',
    premisesOwnership: 'rented',
    tradingLicenceNumber: 'KCCA-99812',
    loanPurpose: 'Buy stock ahead of the school term',
  };

  it('accepts a complete answer', () => {
    expect(businessDetailsSchema.safeParse(VALID).success).toBe(true);
  });

  it.each([
    'businessName',
    'businessType',
    'businessLocation',
    'monthlyTurnover',
    'loanPurpose',
  ])('requires %s', (field) => {
    expect(businessDetailsSchema.safeParse({ ...VALID, [field]: '' }).success).toBe(
      false,
    );
  });

  it('refuses a purpose too short to mean anything', () => {
    // "Cash" is not a purpose.
    expect(
      businessDetailsSchema.safeParse({ ...VALID, loanPurpose: 'cash' }).success,
    ).toBe(false);
  });

  it('leaves expenses null rather than zero when nobody has counted them', () => {
    // A business that did not answer "what do you spend" has not answered
    // zero, and a margin computed from a zero it invented would be a lie.
    const parsed = businessDetailsSchema.safeParse({ ...VALID, monthlyExpenses: '' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.monthlyExpenses).toBeNull();
  });

  it('leaves the employee count null rather than zero when it is blank', () => {
    const parsed = businessDetailsSchema.safeParse({ ...VALID, employeeCount: '' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.employeeCount).toBeNull();
  });

  it('accepts a genuine zero employees', () => {
    const parsed = businessDetailsSchema.safeParse({ ...VALID, employeeCount: '0' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.employeeCount).toBe(0);
  });

  it('rejects premises it does not recognise', () => {
    expect(
      businessDetailsSchema.safeParse({ ...VALID, premisesOwnership: 'leased' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('attaching a guarantor', () => {
  it('accepts an existing client with a relationship', () => {
    expect(
      attachClientGuarantorSchema.safeParse({
        loanId: LOAN_ID,
        guarantorClientId: CLIENT_ID,
        relationshipToClient: 'Neighbour',
      }).success,
    ).toBe(true);
  });

  it('requires the relationship', () => {
    // Recorded per application rather than on the guarantor, because the same
    // person is a brother to one borrower and a business partner to another.
    expect(
      attachClientGuarantorSchema.safeParse({
        loanId: LOAN_ID,
        guarantorClientId: CLIENT_ID,
        relationshipToClient: '   ',
      }).success,
    ).toBe(false);
  });

  const EXTERNAL = {
    loanId: LOAN_ID,
    fullName: 'Nabirye Sarah',
    sex: 'female',
    dateOfBirth: '1988-04-12',
    phone: '0771234567',
    alternativePhone: '',
    occupation: 'Tailor',
    employerName: 'Self employed',
    location: 'Bweyogerere',
    district: 'Wakiso',
    nin: 'CF88012345678',
    relationshipToClient: 'Sister',
  };

  it('captures somebody new in one go, with their identification', () => {
    const parsed = attachExternalGuarantorSchema.safeParse({
      ...EXTERNAL,
      nin: 'CF880123456789',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.nin).toBe('CF880123456789');
  });

  it('normalises a phone number written the local way', () => {
    const parsed = attachExternalGuarantorSchema.safeParse({
      ...EXTERNAL,
      nin: 'CF880123456789',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.phone).toBe('+256771234567');
  });

  it('uppercases a NIN and strips its spaces, but refuses a short one', () => {
    const spaced = attachExternalGuarantorSchema.safeParse({
      ...EXTERNAL,
      nin: 'cf88 0123 456789',
    });
    expect(spaced.success).toBe(true);
    if (spaced.success) expect(spaced.data.nin).toBe('CF880123456789');

    // Padded rather than rejected is how a register comes to hold a number
    // that matches nothing.
    expect(
      attachExternalGuarantorSchema.safeParse({ ...EXTERNAL, nin: 'CF8801' }).success,
    ).toBe(false);
  });

  it('allows the identification to be absent, and says so elsewhere', () => {
    // A guarantor whose card is at home is still a guarantor; the approval
    // validator is what refuses the loan until the number is recorded.
    const parsed = attachExternalGuarantorSchema.safeParse({ ...EXTERNAL, nin: '' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.nin).toBeNull();
  });

  it('refuses an alternative number that repeats the main one', () => {
    expect(
      attachExternalGuarantorSchema.safeParse({
        ...EXTERNAL,
        nin: 'CF880123456789',
        alternativePhone: '0771234567',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the undertaking', () => {
  const VALID = {
    loanId: LOAN_ID,
    loanGuarantorId: GUARANTOR_ROW_ID,
    signatureName: 'Nabirye Sarah',
    witnessName: 'Opio Daniel',
    witnessPhone: '0700111222',
    consentPlace: 'Nsumbi, Kyebando',
    accepted: 'on',
  };

  it('accepts a complete consent', () => {
    expect(recordGuarantorConsentSchema.safeParse(VALID).success).toBe(true);
  });

  it('refuses one that was not accepted', () => {
    // The checkbox is the act. Recording a signature against terms nobody
    // agreed to would be recording evidence of something that did not happen.
    expect(
      recordGuarantorConsentSchema.safeParse({ ...VALID, accepted: undefined }).success,
    ).toBe(false);
  });

  it.each(['signatureName', 'witnessName'])('requires %s', (field) => {
    expect(
      recordGuarantorConsentSchema.safeParse({ ...VALID, [field]: '' }).success,
    ).toBe(false);
  });

  it('carries no version and no timestamp', () => {
    // Both are read server-side from the terms in force. A browser that could
    // name the version could name an older one, and a guarantor cannot be held
    // to words they were not shown.
    const parsed = recordGuarantorConsentSchema.safeParse(VALID);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).not.toContain('consentVersion');
      expect(Object.keys(parsed.data)).not.toContain('consentedAt');
    }
  });

  it('knows a consent is all of its parts or none of them', () => {
    expect(
      consentIsComplete({
        signatureName: 'Nabirye Sarah',
        witnessName: 'Opio Daniel',
        consentedAt: '2026-10-09T08:00:00Z',
        termsVersion: '1.0',
      }),
    ).toBe(true);

    // A date with no witness is not something anybody could enforce.
    expect(
      consentIsComplete({
        signatureName: 'Nabirye Sarah',
        witnessName: null,
        consentedAt: '2026-10-09T08:00:00Z',
        termsVersion: '1.0',
      }),
    ).toBe(false);

    expect(
      consentIsComplete({
        signatureName: '   ',
        witnessName: 'Opio Daniel',
        consentedAt: '2026-10-09T08:00:00Z',
        termsVersion: '1.0',
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('filing a document', () => {
  it('accepts a document on the application', () => {
    expect(
      uploadLoanDocumentSchema.safeParse({
        loanId: LOAN_ID,
        kind: 'payslip',
        loanGuarantorId: '',
        label: 'September payslip',
      }).success,
    ).toBe(true);
  });

  it('refuses a kind it does not recognise', () => {
    expect(
      uploadLoanDocumentSchema.safeParse({ loanId: LOAN_ID, kind: 'passport' }).success,
    ).toBe(false);
  });

  it('knows which three kinds belong to a guarantor', () => {
    expect(isGuarantorDocumentKind('guarantor_signature')).toBe(true);
    expect(isGuarantorDocumentKind('guarantor_identification')).toBe(true);
    expect(isGuarantorDocumentKind('guarantor_photograph')).toBe(true);
    expect(isGuarantorDocumentKind('payslip')).toBe(false);
    expect(isGuarantorDocumentKind('supporting')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('refusing an application', () => {
  it('requires a reason', () => {
    expect(rejectLoanSchema.safeParse({ loanId: LOAN_ID, reason: '' }).success).toBe(
      false,
    );
    // "No" is not a reason for a permanent record of a credit decision.
    expect(rejectLoanSchema.safeParse({ loanId: LOAN_ID, reason: 'no' }).success).toBe(
      false,
    );
    expect(
      rejectLoanSchema.safeParse({ loanId: LOAN_ID, reason: 'Income unproven' }).success,
    ).toBe(true);
  });

  it('separates a refusal from a withdrawal', () => {
    expect(LOAN_CLOSURE_KINDS).toEqual(['rejected', 'withdrawn']);
    expect(isLoanClosureKind('rejected')).toBe(true);
    expect(isLoanClosureKind('expired')).toBe(false);
    expect(isLoanClosureKind(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the workflow stages', () => {
  it('names every view the loan module presents', () => {
    expect(LOAN_WORKFLOW_STAGES).toEqual([
      'draft',
      'pending_approval',
      'approved',
      'awaiting_disbursement',
      'active',
      'grace_period',
      'arrears',
      'cleared',
      'rejected',
      'withdrawn',
    ]);
  });

  it('validates rather than asserts an unrecognised stage', () => {
    expect(isLoanWorkflowStage('arrears')).toBe(true);
    expect(isLoanWorkflowStage('written_off')).toBe(false);
    expect(isLoanWorkflowStage(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the approval failures Phase 13 added', () => {
  it.each([
    'salary_details_missing',
    'business_details_missing',
    'guarantor_consent_missing',
    'guarantor_ineligible',
  ])('recognises %s', (code) => {
    expect(isLoanApprovalFailure(code)).toBe(true);
  });

  it('names the product in a missing-details message', () => {
    expect(
      describeLoanApprovalFailure('salary_details_missing', 'Salary Loan'),
    ).toContain('Salary Loan');
  });

  it('counts unsigned undertakings in words a person can act on', () => {
    expect(describeLoanApprovalFailure('guarantor_consent_missing', '1')).toBe(
      'One guarantor has not signed the undertaking.',
    );
    expect(describeLoanApprovalFailure('guarantor_consent_missing', '3')).toContain('3');
  });
});

// ---------------------------------------------------------------------------
describe('why somebody cannot guarantee a loan', () => {
  it('names the two ways of being a guarantor', () => {
    expect(GUARANTOR_SUBJECT_KINDS).toEqual(['client', 'external']);
    expect(isGuarantorSubjectKind('client')).toBe(true);
    expect(isGuarantorSubjectKind('staff')).toBe(false);
  });

  it('turns a status code into the status it names', () => {
    expect(describeGuarantorIneligibility('not_active_blacklisted')).toContain(
      'blacklisted',
    );
    expect(describeGuarantorIneligibility('not_active_suspended')).toContain('suspended');
  });

  it('says what the limit actually is, not merely that there is one', () => {
    // "Not eligible" sends somebody to look up a rule; this lets them pick
    // somebody else and get on with their morning.
    expect(
      describeGuarantorIneligibility('guarantee_limit', { guaranteeingCount: 2 }),
    ).toContain('2');
  });

  it('counts a candidate’s own outstanding loans', () => {
    expect(
      describeGuarantorIneligibility('has_active_loan', { activeLoanCount: 1 }),
    ).toMatch(/outstanding loan/);
    expect(
      describeGuarantorIneligibility('has_active_loan', { activeLoanCount: 3 }),
    ).toContain('3');
  });

  it('still says something for a code it has never seen', () => {
    // A rule somebody added after this file was written. Dropping it silently
    // would present an ineligible candidate as eligible.
    expect(describeGuarantorIneligibility('under_investigation')).toMatch(/Not eligible/);
  });

  it.each([
    'is_borrower',
    'already_attached',
    'clients_not_allowed',
    'underage',
    'no_identification',
    'in_arrears',
  ])('explains %s without needing context', (reason) => {
    expect(describeGuarantorIneligibility(reason).length).toBeGreaterThan(10);
  });
});
