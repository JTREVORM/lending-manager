import { describe, expect, it } from 'vitest';

import {
  cancelWithdrawalSchema,
  consentCodeSchema,
  consentMethodSchema,
  decideWithdrawalSchema,
  enrolMemberSchema,
  issueMembershipCardSchema,
  recordConsentSchema,
  recordMembershipFeeSchema,
  recordSavingsDepositSchema,
  requestWithdrawalSchema,
  reverseSavingsSchema,
  savingsAmountSchema,
  savingsSearchSchema,
  savingsStatementSchema,
  signaturePathSchema,
  withdrawalSearchSchema,
} from '@/lib/validation/savings';

/**
 * The edge of the savings and enrolment write surfaces.
 *
 * None of this is the control. Anyone posting directly to PostgREST skips every
 * schema below, which is why the same rules are enforced again by CHECK
 * constraints, by the column guards and by the posting functions. What these
 * tests are protecting is a different thing: that a staff member is told what
 * is wrong *before* they confirm, and in a sentence rather than as a constraint
 * name.
 *
 * Two of them are protecting something sharper than that. The absence of a
 * `verificationStatus` field and the absence of a fee `amount` from enrolment
 * are the two places where accepting a value would let a form decide something
 * only the database may decide, so both are asserted as absences.
 */

const KEY = '7f1c2d4e-5a6b-4c8d-9e0f-1a2b3c4d5e6f';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const MEMBERSHIP = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const PROFILE = '12345678-1234-4234-8234-123456789abc';

describe('amounts', () => {
  it('takes a whole number of shillings, with or without separators', () => {
    expect(savingsAmountSchema.parse('50000')).toBe(50_000);
    expect(savingsAmountSchema.parse('50,000')).toBe(50_000);
    expect(savingsAmountSchema.parse(' 50 000 ')).toBe(50_000);
  });

  it('refuses a decimal rather than quietly reading it as a thousands separator', () => {
    // The mistake this is guarding against: `50000,00` typed by somebody used
    // to a decimal comma becoming UGX 5,000,000. Ugandan shillings have no
    // smaller unit, so there is nothing a decimal could legitimately mean.
    expect(savingsAmountSchema.safeParse('50000,00').success).toBe(false);
    expect(savingsAmountSchema.safeParse('50000.50').success).toBe(false);
  });

  it('refuses zero, a negative and a non-number', () => {
    expect(savingsAmountSchema.safeParse('0').success).toBe(false);
    expect(savingsAmountSchema.safeParse('-5000').success).toBe(false);
    expect(savingsAmountSchema.safeParse('fifty thousand').success).toBe(false);
    expect(savingsAmountSchema.safeParse('').success).toBe(false);
  });
});

describe('a deposit', () => {
  const valid = {
    savingsAccountId: ACCOUNT,
    amount: '50000',
    paymentMethod: 'cash',
    externalReference: '',
    idempotencyKey: KEY,
    notes: '',
  };

  it('accepts a cash deposit with no reference', () => {
    const parsed = recordSavingsDepositSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.amount).toBe(50_000);
      expect(parsed.data.externalReference).toBeNull();
    }
  });

  it('requires a reference for Mobile Money and for a bank transfer', () => {
    for (const method of ['mtn_mobile_money', 'airtel_money', 'bank']) {
      const parsed = recordSavingsDepositSchema.safeParse({
        ...valid,
        paymentMethod: method,
      });
      expect(parsed.success, `${method} should need a reference`).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.some((i) => i.path[0] === 'externalReference')).toBe(
          true,
        );
      }
    }
  });

  it('refuses a reference on cash rather than dropping it', () => {
    // Refused, not ignored. Silently discarding something a staff member
    // typed loses information they believe they have recorded — and if the
    // money really did arrive by Mobile Money, the method is the field that
    // is wrong.
    const parsed = recordSavingsDepositSchema.safeParse({
      ...valid,
      externalReference: 'MM-4411-A',
    });
    expect(parsed.success).toBe(false);
  });

  it('normalises a reference to upper case and trims it', () => {
    const parsed = recordSavingsDepositSchema.safeParse({
      ...valid,
      paymentMethod: 'mtn_mobile_money',
      externalReference: '  mm-4411-a ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.externalReference).toBe('MM-4411-A');
  });

  it('requires an idempotency key', () => {
    const { idempotencyKey: _omitted, ...withoutKey } = valid;
    expect(recordSavingsDepositSchema.safeParse(withoutKey).success).toBe(false);
    expect(
      recordSavingsDepositSchema.safeParse({ ...valid, idempotencyKey: 'not-a-uuid' })
        .success,
    ).toBe(false);
  });

  it('accepts no field that would let a caller decide the ledger', () => {
    const parsed = recordSavingsDepositSchema.parse(valid);
    // A caller that could choose the kind could post a withdrawal as a
    // deposit; one that could choose the value date could backdate a
    // contribution month and manufacture a qualifying month.
    expect(parsed).not.toHaveProperty('kind');
    expect(parsed).not.toHaveProperty('signedAmount');
    expect(parsed).not.toHaveProperty('valueDate');
    expect(parsed).not.toHaveProperty('journalEntryId');
    expect(parsed).not.toHaveProperty('transactionNumber');
  });
});

describe('consent', () => {
  it('offers the four verifiable methods and refuses the legacy one', () => {
    for (const method of [
      'member_portal',
      'one_time_code',
      'signature_document',
      'witnessed_in_branch',
    ]) {
      expect(consentMethodSchema.safeParse(method).success, method).toBe(true);
    }

    // The point of the whole phase. `legacy_typed_name` can never satisfy
    // activation, so offering it as an input would be offering a dead end.
    expect(consentMethodSchema.safeParse('legacy_typed_name').success).toBe(false);
  });

  it('takes a signature path only under its own membership', () => {
    expect(
      signaturePathSchema.safeParse(`memberships/${MEMBERSHIP}/signature/signed.png`)
        .success,
    ).toBe(true);

    // A path of any other shape is one `storage_path_membership_id()` reads no
    // membership out of — so every storage policy would deny it, and the file
    // would be uploaded somewhere nothing could ever read it again.
    expect(signaturePathSchema.safeParse('signatures/signed.png').success).toBe(false);
    expect(
      signaturePathSchema.safeParse(`memberships/${MEMBERSHIP}/photo/signed.png`).success,
    ).toBe(false);
    expect(
      signaturePathSchema.safeParse('memberships/not-a-uuid/signature/signed.png')
        .success,
    ).toBe(false);
  });

  it('takes a six-digit code and nothing else', () => {
    expect(consentCodeSchema.safeParse('012345').success).toBe(true);
    expect(consentCodeSchema.safeParse('12345').success).toBe(false);
    expect(consentCodeSchema.safeParse('1234567').success).toBe(false);
    expect(consentCodeSchema.safeParse('12345a').success).toBe(false);
  });

  const consentBase = {
    membershipId: MEMBERSHIP,
    policyVersionId: CLIENT,
    signatureName: 'Sarah Nakato',
    signaturePath: '',
    witnessProfileId: '',
    challengeId: '',
    acceptedPlace: '',
  };

  it('requires the evidence its own method takes', () => {
    const witnessed = recordConsentSchema.safeParse({
      ...consentBase,
      consentMethod: 'witnessed_in_branch',
    });
    expect(witnessed.success).toBe(false);
    if (!witnessed.success) {
      expect(witnessed.error.issues.some((i) => i.path[0] === 'witnessProfileId')).toBe(
        true,
      );
    }

    expect(
      recordConsentSchema.safeParse({
        ...consentBase,
        consentMethod: 'witnessed_in_branch',
        witnessProfileId: PROFILE,
      }).success,
    ).toBe(true);
  });

  it('requires a challenge for a code and a path for a signature', () => {
    expect(
      recordConsentSchema.safeParse({ ...consentBase, consentMethod: 'one_time_code' })
        .success,
    ).toBe(false);
    expect(
      recordConsentSchema.safeParse({
        ...consentBase,
        consentMethod: 'one_time_code',
        challengeId: KEY,
      }).success,
    ).toBe(true);

    expect(
      recordConsentSchema.safeParse({
        ...consentBase,
        consentMethod: 'signature_document',
      }).success,
    ).toBe(false);
    expect(
      recordConsentSchema.safeParse({
        ...consentBase,
        consentMethod: 'signature_document',
        signaturePath: `memberships/${MEMBERSHIP}/signature/signed.png`,
      }).success,
    ).toBe(true);
  });

  it('needs no extra evidence for a portal confirmation, because the session is the evidence', () => {
    expect(
      recordConsentSchema.safeParse({ ...consentBase, consentMethod: 'member_portal' })
        .success,
    ).toBe(true);
  });

  it('refuses evidence belonging to a different method', () => {
    // A witness id sent alongside `one_time_code` means somebody filled in
    // two halves of two different forms. Ignoring it would record an
    // acceptance the staff member believes was witnessed and that carries no
    // witness at all.
    const confused = recordConsentSchema.safeParse({
      ...consentBase,
      consentMethod: 'one_time_code',
      challengeId: KEY,
      witnessProfileId: PROFILE,
    });
    expect(confused.success).toBe(false);
    if (!confused.success) {
      expect(confused.error.issues.some((i) => i.path[0] === 'witnessProfileId')).toBe(
        true,
      );
    }
  });

  it('accepts no verdict field at all', () => {
    const parsed = recordConsentSchema.parse({
      ...consentBase,
      consentMethod: 'member_portal',
    });

    // The Phase 1 defect, closed. A caller that could send
    // `verificationStatus: 'verified'` could activate a membership on a typed
    // name. The guard derives it; nothing out here can state it.
    expect(parsed).not.toHaveProperty('verificationStatus');
    expect(parsed).not.toHaveProperty('evidenceDigest');
    expect(parsed).not.toHaveProperty('verifiedAt');
    expect(parsed).not.toHaveProperty('verifiedBy');
  });
});

describe('enrolment', () => {
  const valid = {
    clientId: CLIENT,
    paymentMethod: 'cash',
    externalReference: '',
    idempotencyKey: KEY,
    consentMethod: 'witnessed_in_branch',
    signatureName: 'Sarah Nakato',
    signaturePath: '',
    witnessProfileId: PROFILE,
    challengeId: '',
    initialDeposit: '',
    depositReference: '',
    notes: '',
  };

  it('accepts a cash enrolment with a witness and no deposit', () => {
    const parsed = enrolMemberSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.initialDeposit).toBeNull();
      expect(parsed.data.witnessProfileId).toBe(PROFILE);
    }
  });

  it('accepts a first deposit taken at the same counter', () => {
    const parsed = enrolMemberSchema.safeParse({ ...valid, initialDeposit: '50000' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.initialDeposit).toBe(50_000);
  });

  it('never accepts the fee amount', () => {
    // The fee comes from the membership's own effective-dated policy version
    // inside `enrol_member`. A caller that could send it could enrol somebody
    // for a shilling, and a member who joins in March would stop keeping
    // March's terms.
    const parsed = enrolMemberSchema.parse(valid);
    expect(parsed).not.toHaveProperty('amount');
    expect(parsed).not.toHaveProperty('feeAmount');
    expect(parsed).not.toHaveProperty('registrationFee');
  });

  it('never accepts a status or an activation date', () => {
    const parsed = enrolMemberSchema.parse(valid);
    // Activation is the database's decision, and it needs a posted fee and a
    // verified acceptance to make it. A caller that could send `activatedOn`
    // could backdate a savings qualification by six months.
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('activatedOn');
    expect(parsed).not.toHaveProperty('membershipNumber');
    expect(parsed).not.toHaveProperty('policyVersionId');
  });

  it('refuses a deposit reference with no deposit to belong to', () => {
    const parsed = enrolMemberSchema.safeParse({
      ...valid,
      paymentMethod: 'mtn_mobile_money',
      externalReference: 'MM-1111',
      depositReference: 'MM-2222',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === 'depositReference')).toBe(
        true,
      );
    }
  });

  it('requires a reference for the deposit as well as for the fee on Mobile Money', () => {
    const parsed = enrolMemberSchema.safeParse({
      ...valid,
      paymentMethod: 'mtn_mobile_money',
      externalReference: 'MM-1111',
      initialDeposit: '50000',
      depositReference: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a deposit reference on a cash enrolment', () => {
    expect(
      enrolMemberSchema.safeParse({
        ...valid,
        initialDeposit: '50000',
        depositReference: 'MM-2222',
      }).success,
    ).toBe(false);
  });

  it('still applies the consent rule', () => {
    expect(enrolMemberSchema.safeParse({ ...valid, witnessProfileId: '' }).success).toBe(
      false,
    );
  });
});

describe('the registration fee on its own', () => {
  it('takes the amount, because this screen confirms the figure taken', () => {
    const parsed = recordMembershipFeeSchema.safeParse({
      membershipId: MEMBERSHIP,
      amount: '5000',
      paymentMethod: 'cash',
      externalReference: '',
      idempotencyKey: KEY,
      notes: '',
    });
    expect(parsed.success).toBe(true);
    // Sent and then checked against the policy inside
    // `record_membership_fee`, which refuses a mismatch — so this is a
    // counter confirming what they took, not choosing it.
    if (parsed.success) expect(parsed.data.amount).toBe(5_000);
  });

  it('applies the same reference rule', () => {
    expect(
      recordMembershipFeeSchema.safeParse({
        membershipId: MEMBERSHIP,
        amount: '5000',
        paymentMethod: 'bank',
        externalReference: '',
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });
});

describe('withdrawals', () => {
  it('requires a reason long enough to mean something', () => {
    expect(
      requestWithdrawalSchema.safeParse({
        savingsAccountId: ACCOUNT,
        amount: '20000',
        reason: 'School fees for the term',
      }).success,
    ).toBe(true);

    expect(
      requestWithdrawalSchema.safeParse({
        savingsAccountId: ACCOUNT,
        amount: '20000',
        reason: 'x',
      }).success,
    ).toBe(false);
  });

  it('requires a note on a rejection but not on an approval', () => {
    // Asymmetric deliberately: a refusal is what a member will ask about, and
    // an approval's justification is the request itself.
    expect(
      decideWithdrawalSchema.safeParse({
        requestId: KEY,
        approve: true,
        notes: '',
      }).success,
    ).toBe(true);

    const silentRejection = decideWithdrawalSchema.safeParse({
      requestId: KEY,
      approve: false,
      notes: '',
    });
    expect(silentRejection.success).toBe(false);
    if (!silentRejection.success) {
      expect(silentRejection.error.issues.some((i) => i.path[0] === 'notes')).toBe(true);
    }

    expect(
      decideWithdrawalSchema.safeParse({
        requestId: KEY,
        approve: false,
        notes: 'The balance secures a live loan.',
      }).success,
    ).toBe(true);
  });

  it('requires a reason to cancel', () => {
    expect(
      cancelWithdrawalSchema.safeParse({ requestId: KEY, reason: 'Member changed plans' })
        .success,
    ).toBe(true);
    expect(cancelWithdrawalSchema.safeParse({ requestId: KEY, reason: '' }).success).toBe(
      false,
    );
  });

  it('accepts no decider or decision date', () => {
    const parsed = decideWithdrawalSchema.parse({
      requestId: KEY,
      approve: true,
      notes: '',
    });
    // `decide_savings_withdrawal` stamps the decider from the session, and
    // refuses a decision from whoever prepared the request. A caller that
    // could send `decidedBy` could name somebody else as the approver.
    expect(parsed).not.toHaveProperty('decidedBy');
    expect(parsed).not.toHaveProperty('decidedAt');
  });
});

describe('reversal', () => {
  it('asks for ten characters of explanation', () => {
    // Stricter than the database's four, deliberately. This is the only record
    // of why a member's balance changed without the member doing anything, and
    // "error" is not an explanation. The database floor is the weaker
    // guarantee that still holds when this layer is bypassed.
    expect(
      reverseSavingsSchema.safeParse({ transactionId: KEY, reason: 'error' }).success,
    ).toBe(false);
    expect(
      reverseSavingsSchema.safeParse({
        transactionId: KEY,
        reason: 'Counted twice at the counter',
      }).success,
    ).toBe(true);
  });
});

describe('cards', () => {
  it('takes a reason from the fixed list', () => {
    expect(
      issueMembershipCardSchema.safeParse({
        membershipId: MEMBERSHIP,
        reason: 'first_issue',
      }).success,
    ).toBe(true);
    expect(
      issueMembershipCardSchema.safeParse({ membershipId: MEMBERSHIP, reason: 'stolen' })
        .success,
    ).toBe(false);
  });

  it('accepts no card number and no verification code', () => {
    const parsed = issueMembershipCardSchema.parse({
      membershipId: MEMBERSHIP,
      reason: 'lost',
    });
    // A caller that could choose the verification code could print a card
    // whose code matched somebody else's, and the code is the only thing on
    // the card that is not already public.
    expect(parsed).not.toHaveProperty('verificationCode');
    expect(parsed).not.toHaveProperty('cardNumber');
  });
});

describe('filters fail open', () => {
  it('reads a blank savings filter as no filter', () => {
    const parsed = savingsSearchSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('all');
      expect(parsed.data.compliance).toBe('all');
      expect(parsed.data.page).toBe(1);
    }
  });

  it('defaults the withdrawal queue to what needs a decision', () => {
    const parsed = withdrawalSearchSchema.safeParse({});
    expect(parsed.success).toBe(true);
    // The queue exists to be worked through, so it opens on the work rather
    // than on everything that ever happened.
    if (parsed.success) expect(parsed.data.status).toBe('pending');
  });

  it('refuses a statement period that ends before it starts', () => {
    const parsed = savingsStatementSchema.safeParse({
      savingsAccountId: ACCOUNT,
      from: '2026-06-01',
      to: '2026-05-01',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path[0] === 'to')).toBe(true);
    }
  });

  it('refuses a date that does not exist, rather than matching nothing', () => {
    // A shape regex would accept `2026-02-30` and the register would silently
    // come back empty, which reads to the user as a business with no savings
    // in it.
    expect(
      savingsStatementSchema.safeParse({
        savingsAccountId: ACCOUNT,
        from: '2026-02-30',
        to: '',
      }).success,
    ).toBe(false);
  });

  it('accepts an open-ended period', () => {
    expect(
      savingsStatementSchema.safeParse({ savingsAccountId: ACCOUNT, from: '', to: '' })
        .success,
    ).toBe(true);
  });
});
