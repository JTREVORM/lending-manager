import { describe, expect, it } from 'vitest';

import {
  approveClaimSchema,
  assessClaimSchema,
  attachDocumentSchema,
  benefitClaimSearchSchema,
  benefitClaimTypeSchema,
  beneficiarySearchSchema,
  bereavementClaimSchema,
  cancelClaimSchema,
  condolenceClaimSchema,
  hospitalBillSchema,
  kampalaInstantSchema,
  medicalClaimSchema,
  payBenefitSchema,
  registerBeneficiaryFormSchema,
  rejectClaimSchema,
  requestInformationSchema,
  reverseBenefitPaymentSchema,
  revokeBeneficiarySchema,
  verifyBeneficiarySchema,
  verifyDocumentSchema,
} from '@/lib/validation/benefits';

/**
 * The edge of the benefit write surface.
 *
 * None of this is the control. Anyone posting directly to PostgREST skips
 * every schema below, which is why the same rules are enforced again by CHECK
 * constraints, by the column guards and by the posting functions. What these
 * tests protect is a different thing: that a member of staff is told what is
 * wrong *before* they confirm, and in a sentence rather than as a constraint
 * name.
 *
 * ## The two assertions that matter most
 *
 * That an approval has **no amount field**, and a payment has no amount and no
 * payee. Those are not omissions to be tidied up later: an approver agrees to
 * the assessed figure or refuses the claim, and a payment reads its recipient
 * from the assessment snapshot the approver agreed to. A field here would be
 * the place the substitution fraud happened.
 *
 * And that a hospital bill goes through the hardened shilling parser, so
 * `400000,00` is refused rather than becoming UGX 40,000,000 — which at 5%
 * would be a UGX 2,000,000 benefit instead of a UGX 20,000 one.
 */

const UUID = '00000000-0000-4000-8000-000000000001';
const OTHER_UUID = '00000000-0000-4000-8000-000000000002';

describe('the claim type', () => {
  it('accepts the three the business promised and nothing else', () => {
    for (const type of ['medical', 'family_condolence', 'member_bereavement']) {
      expect(benefitClaimTypeSchema.safeParse(type).success, type).toBe(true);
    }

    const refused = benefitClaimTypeSchema.safeParse('funeral');
    expect(refused.success).toBe(false);
  });
});

describe('the hospital bill', () => {
  it('reads a plain figure and a grouped one', () => {
    expect(hospitalBillSchema.parse('400000')).toBe(400_000);
    expect(hospitalBillSchema.parse('400,000')).toBe(400_000);
    expect(hospitalBillSchema.parse(' 400 000 ')).toBe(400_000);
  });

  it('refuses a decimal comma, rather than reading it as a thousands mark', () => {
    // The failure this parser exists for. `400000,00` means four hundred
    // thousand in much of the world; read as a thousands separator it is
    // forty million, and 5% of that is a UGX 2,000,000 benefit instead of a
    // UGX 20,000 one.
    const refused = hospitalBillSchema.safeParse('400000,00');
    expect(refused.success).toBe(false);
  });

  it('refuses nothing, zero and a negative bill with a sentence each', () => {
    for (const value of ['', '0', '-5000', 'abc', '4.5']) {
      const result = hospitalBillSchema.safeParse(value);
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('the Kampala instant', () => {
  it('appends the business offset rather than trusting the browser', () => {
    // `datetime-local` sends no offset. Read as UTC, a 23:00 admission would
    // land on the following day — and the admission date is what every
    // date-based rule reads.
    expect(kampalaInstantSchema.parse('2026-03-10T09:00')).toBe(
      '2026-03-10T09:00:00+03:00',
    );
    expect(kampalaInstantSchema.parse('2026-03-10T09:00:30')).toBe(
      '2026-03-10T09:00:30+03:00',
    );
  });

  it('refuses a date with no time, and a time with no date', () => {
    for (const value of ['2026-03-10', '09:00', '', '2026-03-10 09:00']) {
      expect(kampalaInstantSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('a medical claim', () => {
  const valid = {
    membershipId: UUID,
    providerName: 'Mulago Specialised Hospital',
    admissionAt: '2026-03-10T09:00',
    dischargeAt: '2026-03-14T11:00',
    billAmount: '400000',
  };

  it('accepts an admission with a discharge and a bill', () => {
    const parsed = medicalClaimSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.billAmount).toBe(400_000);
      expect(parsed.data.admissionAt).toContain('+03:00');
    }
  });

  it('accepts a claim opened while the member is still in the ward', () => {
    // A real and common case. `submit_benefit_claim` is what refuses to take
    // it further, which is where that refusal belongs: the business date is
    // the database's, not the form's.
    const parsed = medicalClaimSchema.safeParse({ ...valid, dischargeAt: undefined });
    expect(parsed.success).toBe(true);
  });

  it('refuses a discharge at or before the admission, on that field', () => {
    for (const dischargeAt of ['2026-03-10T09:00', '2026-03-09T09:00']) {
      const parsed = medicalClaimSchema.safeParse({ ...valid, dischargeAt });
      expect(parsed.success, dischargeAt).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.path).toEqual(['dischargeAt']);
      }
    }
  });

  it('refuses a hospital nobody could find', () => {
    expect(medicalClaimSchema.safeParse({ ...valid, providerName: 'A' }).success).toBe(
      false,
    );
  });
});

describe('a condolence claim', () => {
  it('requires the relationship even though nobody has decided which qualify', () => {
    // Both are true at once. The claim records what the member says the
    // deceased was to them — a fact about the claim — and the assessment
    // refuses with `relationship_eligibility_undecided` until the client
    // answers. Recording the claim without it would make it unassessable on
    // the day they do.
    const refused = condolenceClaimSchema.safeParse({
      membershipId: UUID,
      deceasedName: 'Margaret Achieng',
      deceasedRelationship: '',
      dateOfDeath: '2026-03-01',
    });

    expect(refused.success).toBe(false);

    const accepted = condolenceClaimSchema.safeParse({
      membershipId: UUID,
      deceasedName: 'Margaret Achieng',
      deceasedRelationship: 'cousin',
      dateOfDeath: '2026-03-01',
    });

    expect(accepted.success).toBe(true);
  });
});

describe('a bereavement claim', () => {
  it('takes a beneficiary and does not require one', () => {
    // A claim opened the day a member dies, before anybody has checked the
    // next of kin, is the common case; refusing to record it would push the
    // work onto paper. The database refuses the *assessment* with
    // `beneficiary_missing`, which is where it belongs.
    const without = bereavementClaimSchema.safeParse({
      membershipId: UUID,
      deceasedName: 'Joseph Okello',
      dateOfDeath: '2026-03-01',
    });

    expect(without.success).toBe(true);

    const with_ = bereavementClaimSchema.safeParse({
      membershipId: UUID,
      deceasedName: 'Joseph Okello',
      dateOfDeath: '2026-03-01',
      beneficiaryId: OTHER_UUID,
    });

    expect(with_.success).toBe(true);
  });
});

describe('the decisions', () => {
  it('gives an approval no amount field at all', () => {
    // The assertion this file exists for. An approver agrees to the assessed
    // figure or refuses the claim; a partial approval would be a second
    // assessment performed by somebody who did not assess, and
    // `approve_benefit_claim` refuses one outright.
    const parsed = approveClaimSchema.safeParse({
      claimId: UUID,
      note: 'Checked against the invoice.',
      approvedAmount: '1',
      amount: '1',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual(['claimId', 'note']);
    }
  });

  it('gives an assessment no amount field either', () => {
    const parsed = assessClaimSchema.safeParse({
      claimId: UUID,
      note: 'Four nights, invoice checked.',
      assessedAmount: '20000',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual(['claimId', 'note']);
    }
  });

  it('requires a reason to refuse, to withdraw and to ask for more', () => {
    // Each of these travels to somebody: the member, or whoever has to
    // produce a replacement document. A refusal with no reason is a dead end.
    for (const schema of [rejectClaimSchema, cancelClaimSchema]) {
      expect(schema.safeParse({ claimId: UUID, reason: '' }).success).toBe(false);
      expect(schema.safeParse({ claimId: UUID, reason: 'No' }).success).toBe(false);
      expect(
        schema.safeParse({ claimId: UUID, reason: 'The admission was one night.' })
          .success,
      ).toBe(true);
    }

    expect(requestInformationSchema.safeParse({ claimId: UUID, note: '' }).success).toBe(
      false,
    );
    expect(
      requestInformationSchema.safeParse({
        claimId: UUID,
        note: 'The invoice is unsigned.',
      }).success,
    ).toBe(true);
  });

  it('accepts a three-character reason, because "Flu" is a real answer', () => {
    expect(rejectClaimSchema.safeParse({ claimId: UUID, reason: 'Flu' }).success).toBe(
      true,
    );
  });
});

describe('the payment', () => {
  it('carries no amount and no payee', () => {
    // Both are read from the assessment the approver agreed to. A payment
    // that took a payee from the request could pay UGX 200,000 to somebody
    // the approver never saw, which is the fraud §11 of the brief names.
    const parsed = payBenefitSchema.safeParse({
      claimId: UUID,
      paymentMethod: 'cash',
      idempotencyKey: OTHER_UUID,
      amount: '999999',
      recipientName: 'Somebody Else',
      beneficiaryId: UUID,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // `externalReference` is absent rather than null, because the optional
      // string transform drops an unsupplied one — which is itself the right
      // shape: a cash payment has no reference to carry.
      expect(Object.keys(parsed.data).sort()).toEqual([
        'claimId',
        'idempotencyKey',
        'paymentMethod',
      ]);
    }
  });

  it('requires a reference for everything but cash', () => {
    const refused = payBenefitSchema.safeParse({
      claimId: UUID,
      paymentMethod: 'mtn_mobile_money',
      idempotencyKey: OTHER_UUID,
    });

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]?.path).toEqual(['externalReference']);
    }
  });

  it('refuses a reference on a cash payment rather than ignoring it', () => {
    // Silently dropping something a staff member typed loses information they
    // believed they had recorded.
    const refused = payBenefitSchema.safeParse({
      claimId: UUID,
      paymentMethod: 'cash',
      externalReference: 'MM123456',
      idempotencyKey: OTHER_UUID,
    });

    expect(refused.success).toBe(false);
  });

  it('requires an idempotency key that is a UUID', () => {
    for (const key of [undefined, '', 'not-a-uuid']) {
      const refused = payBenefitSchema.safeParse({
        claimId: UUID,
        paymentMethod: 'cash',
        idempotencyKey: key,
      });
      expect(refused.success, String(key)).toBe(false);
    }
  });

  it('requires a reason to reverse', () => {
    expect(
      reverseBenefitPaymentSchema.safeParse({ paymentId: UUID, reason: '' }).success,
    ).toBe(false);
    expect(
      reverseBenefitPaymentSchema.safeParse({
        paymentId: UUID,
        reason: 'Paid against the wrong claim.',
      }).success,
    ).toBe(true);
  });
});

describe('the evidence', () => {
  it('belongs to a claim or a beneficiary, and to exactly one', () => {
    const neither = attachDocumentSchema.safeParse({
      kind: 'medical_invoice',
      claimId: null,
      beneficiaryId: null,
    });
    expect(neither.success).toBe(false);

    const both = attachDocumentSchema.safeParse({
      kind: 'medical_invoice',
      claimId: UUID,
      beneficiaryId: OTHER_UUID,
    });
    expect(both.success).toBe(false);

    expect(
      attachDocumentSchema.safeParse({ kind: 'medical_invoice', claimId: UUID }).success,
    ).toBe(true);
  });

  it('needs a reason to refuse a document and none to accept one', () => {
    // Asymmetric on purpose. "I looked at this and it is what it says it is"
    // needs no essay; "I am not accepting this" has to reach whoever will
    // have to produce a replacement.
    expect(
      verifyDocumentSchema.safeParse({ documentId: UUID, verified: true }).success,
    ).toBe(true);

    const refused = verifyDocumentSchema.safeParse({
      documentId: UUID,
      verified: false,
    });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]?.path).toEqual(['note']);
    }

    expect(
      verifyDocumentSchema.safeParse({
        documentId: UUID,
        verified: false,
        note: 'The invoice names another patient.',
      }).success,
    ).toBe(true);
  });
});

describe('a beneficiary', () => {
  const valid = {
    membershipId: UUID,
    fullName: 'Hadija Nakato',
    relationship: 'spouse',
    phone: '0771234567',
    isPrimary: 'true',
  };

  it('accepts a name, a relationship and a Ugandan number', () => {
    expect(registerBeneficiaryFormSchema.safeParse(valid).success).toBe(true);
  });

  it('wants the document and its reference together, or neither', () => {
    // Half an identification identifies nobody, and the database says the
    // same thing in a CHECK constraint.
    expect(
      registerBeneficiaryFormSchema.safeParse({
        ...valid,
        identityDocumentKind: 'national_id',
      }).success,
    ).toBe(false);

    expect(
      registerBeneficiaryFormSchema.safeParse({
        ...valid,
        identityReference: 'CM90000001DEMO',
      }).success,
    ).toBe(false);

    expect(
      registerBeneficiaryFormSchema.safeParse({
        ...valid,
        identityDocumentKind: 'national_id',
        identityReference: 'CM90000001DEMO',
      }).success,
    ).toBe(true);
  });

  it('refuses the same telephone number twice', () => {
    const refused = registerBeneficiaryFormSchema.safeParse({
      ...valid,
      alternativePhone: '0771234567',
    });

    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]?.path).toEqual(['alternativePhone']);
    }
  });

  it('needs a document path for a document verification, and none otherwise', () => {
    // A path naming a file nobody uploaded verifies nothing, and the database
    // checks the object exists under this membership's own folder.
    const missingPath = verifyBeneficiarySchema.safeParse({
      beneficiaryId: UUID,
      verified: true,
      evidenceKind: 'relationship_document',
    });
    expect(missingPath.success).toBe(false);

    const strayPath = verifyBeneficiarySchema.safeParse({
      beneficiaryId: UUID,
      verified: true,
      evidenceKind: 'witnessed_in_branch',
      evidencePath: 'benefits/x/y/beneficiary/z.pdf',
    });
    expect(strayPath.success).toBe(false);

    expect(
      verifyBeneficiarySchema.safeParse({
        beneficiaryId: UUID,
        verified: true,
        evidenceKind: 'witnessed_in_branch',
      }).success,
    ).toBe(true);
  });

  it('needs a reason to refuse a record and to withdraw one', () => {
    const refusedWithoutNote = verifyBeneficiarySchema.safeParse({
      beneficiaryId: UUID,
      verified: false,
      evidenceKind: 'relationship_document',
      evidencePath: 'benefits/x/y/beneficiary/z.pdf',
    });
    expect(refusedWithoutNote.success).toBe(false);

    expect(
      revokeBeneficiarySchema.safeParse({ beneficiaryId: UUID, reason: '' }).success,
    ).toBe(false);
    expect(
      revokeBeneficiarySchema.safeParse({
        beneficiaryId: UUID,
        reason: 'The member asked for a different person.',
      }).success,
    ).toBe(true);
  });
});

describe('the register filters', () => {
  it('falls back to the default view rather than erroring', () => {
    // A filter is a convenience and not a control: which rows a caller may
    // see is decided by Row Level Security whatever the query string says.
    const parsed = benefitClaimSearchSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ query: null, type: 'all', status: 'all', page: 1 });
    }

    expect(benefitClaimSearchSchema.safeParse({ status: 'nonsense' }).success).toBe(
      false,
    );
  });

  it('offers "open" as a stage the database does not have', () => {
    // Every status a claim can still move out of — what somebody working a
    // queue wants, and what no single column holds.
    expect(benefitClaimSearchSchema.safeParse({ status: 'open' }).success).toBe(true);
  });

  it('reads an empty search as no search', () => {
    const parsed = beneficiarySearchSchema.safeParse({ query: '   ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.query).toBeNull();
  });
});
