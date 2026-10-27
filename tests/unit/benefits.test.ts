import { describe, expect, it } from 'vitest';

import {
  BENEFICIARY_EVIDENCE_KINDS,
  BENEFICIARY_IDENTITY_DOCUMENT_KINDS,
  BENEFICIARY_STATUSES,
  BENEFICIARY_VERIFICATION_STATUSES,
  BENEFIT_CLAIM_STATUSES,
  BENEFIT_CLAIM_STATUS_DESCRIPTIONS,
  BENEFIT_CLAIM_STATUS_LABELS,
  BENEFIT_CLAIM_TRANSITIONS,
  BENEFIT_CLAIM_TYPES,
  BENEFIT_CLAIM_TYPE_LABELS,
  BENEFIT_ELIGIBILITY_CODES,
  BENEFIT_ELIGIBILITY_CODE_LABELS,
  BENEFIT_EXPENSE_ACCOUNT_CODES,
  BENEFIT_RECIPIENT_KIND_LABELS,
  BENEFIT_YEAR_BASES,
  CAP_CONSUMING_BENEFIT_STATUSES,
  TERMINAL_BENEFIT_CLAIM_STATUSES,
  UNDECIDED_BENEFIT_ELIGIBILITY_CODES,
  admissionLength,
  admissionVerdict,
  benefitAmountFor,
  benefitRecipientKindFor,
  beneficiaryEvidenceNeedsDocument,
  canTransitionBenefitClaim,
  consumesAnnualCap,
  isBenefitClaimOpen,
  isBenefitClaimStatus,
  isBenefitClaimType,
  isBenefitYearBasis,
  isTerminalBenefitClaimStatus,
  isUndecidedEligibilityCode,
  medicalBenefitAmount,
  type BenefitClaimStatus,
} from '@/lib/domain/benefits';
import { instantToBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';

/**
 * The benefits domain, in isolation.
 *
 * ## How the expected figures were produced
 *
 * By hand, from the rule, and written out as literals — the same discipline
 * `tests/unit/member-loan.test.ts` states. Computing the expectation with the
 * function under test would prove only that the function agrees with itself.
 * `tests/db/benefit-claims.test.ts` and `tests/db/benefit-accounting.test.ts`
 * then assert the database produces the same answers, which is what makes
 * this a parity suite rather than a restatement.
 *
 * ## The two things these tests care about most
 *
 * That 5% of a bill is computed in whole shillings, half-up, with no float
 * anywhere near it — because `bill * 0.05` is 30000.000000000004 on the wrong
 * bill, and across a year of postings that is a ledger that does not balance.
 *
 * And that the three readings of "an admission longer than one day" are kept
 * apart: a stay that clears the threshold on one reading and not another is
 * **undecided**, never quietly paid and never quietly refused.
 */

const kampalaDay = (instant: Date): string => instantToBusinessDate(instant);

describe('the benefit types', () => {
  it('names three, each with a label and an expense account', () => {
    expect(BENEFIT_CLAIM_TYPES).toEqual([
      'medical',
      'family_condolence',
      'member_bereavement',
    ]);

    for (const type of BENEFIT_CLAIM_TYPES) {
      expect(BENEFIT_CLAIM_TYPE_LABELS[type].length).toBeGreaterThan(0);
      expect(BENEFIT_EXPENSE_ACCOUNT_CODES[type]).toMatch(/^52[123]0$/);
    }
  });

  it('gives each promise its own expense account', () => {
    // Three accounts, not one: "what did the benefits scheme cost" and "what
    // did each promise cost" are different questions, and a single account
    // could answer only the first.
    const codes = Object.values(BENEFIT_EXPENSE_ACCOUNT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('refuses anything that is not one of the three', () => {
    for (const value of [undefined, null, '', 'medical ', 'MEDICAL', 'other', 42]) {
      expect(isBenefitClaimType(value), String(value)).toBe(false);
    }
    expect(isBenefitClaimType('medical')).toBe(true);
  });

  it('pays a bereavement benefit to the next of kin and the others to the member', () => {
    // Not a preference: the member is dead, so there is nobody else to pay —
    // and `benefit_payment_bereavement_pays_beneficiary` refuses anything
    // else.
    expect(benefitRecipientKindFor('member_bereavement')).toBe('beneficiary');
    expect(benefitRecipientKindFor('medical')).toBe('member');
    expect(benefitRecipientKindFor('family_condolence')).toBe('member');

    for (const kind of ['member', 'beneficiary'] as const) {
      expect(BENEFIT_RECIPIENT_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

describe('the claim lifecycle', () => {
  it('names ten statuses, each with a label and a description', () => {
    expect(BENEFIT_CLAIM_STATUSES).toHaveLength(10);

    for (const status of BENEFIT_CLAIM_STATUSES) {
      expect(BENEFIT_CLAIM_STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(BENEFIT_CLAIM_STATUS_DESCRIPTIONS[status].length).toBeGreaterThan(0);
      expect(isBenefitClaimStatus(status)).toBe(true);
    }

    expect(isBenefitClaimStatus('pending')).toBe(false);
  });

  it('lets a draft be submitted or withdrawn, and nothing else', () => {
    expect(BENEFIT_CLAIM_TRANSITIONS.draft).toEqual(['submitted', 'cancelled']);
    expect(canTransitionBenefitClaim('draft', 'assessed')).toBe(false);
    expect(canTransitionBenefitClaim('draft', 'paid')).toBe(false);
  });

  it('refuses to withdraw an approved claim', () => {
    // An approved claim the business changes its mind about is a *refusal* by
    // somebody with the authority to refuse, with a reason on the record —
    // not a withdrawal note. So `approved` reaches `paid` and `rejected`, and
    // nothing else.
    expect(BENEFIT_CLAIM_TRANSITIONS.approved).toEqual(['paid', 'rejected']);
    expect(canTransitionBenefitClaim('approved', 'cancelled')).toBe(false);
  });

  it('sends an assessed claim back without calling it a rejection', () => {
    // The commonest reason an approver disagrees is arithmetic, and sending it
    // back has to return it to the stage where the assessment is made.
    expect(canTransitionBenefitClaim('assessed', 'under_verification')).toBe(true);
    expect(canTransitionBenefitClaim('assessed', 'information_required')).toBe(true);
  });

  it('never reopens a paid claim, and never pays a reversed one twice', () => {
    expect(BENEFIT_CLAIM_TRANSITIONS.paid).toEqual(['reversed']);
    expect(BENEFIT_CLAIM_TRANSITIONS.reversed).toEqual([]);
    expect(canTransitionBenefitClaim('reversed', 'approved')).toBe(false);
    expect(canTransitionBenefitClaim('reversed', 'paid')).toBe(false);
  });

  it('agrees with itself about which statuses are terminal', () => {
    for (const status of BENEFIT_CLAIM_STATUSES) {
      const terminal = BENEFIT_CLAIM_TRANSITIONS[status].length === 0;
      expect(isBenefitClaimOpen(status), status).toBe(!terminal);
    }

    // `paid` is not terminal — a payment can be reversed — and the three that
    // are, are exactly the three named.
    expect(TERMINAL_BENEFIT_CLAIM_STATUSES).toEqual([
      'rejected',
      'cancelled',
      'reversed',
    ]);

    for (const status of BENEFIT_CLAIM_STATUSES) {
      expect(isTerminalBenefitClaimStatus(status), status).toBe(
        TERMINAL_BENEFIT_CLAIM_STATUSES.includes(status),
      );
    }

    expect(isTerminalBenefitClaimStatus('paid')).toBe(false);
  });

  it('never leads anywhere that is not a status', () => {
    for (const [from, targets] of Object.entries(BENEFIT_CLAIM_TRANSITIONS)) {
      for (const to of targets) {
        expect(BENEFIT_CLAIM_STATUSES, `${from} -> ${to}`).toContain(to);
        // Nothing transitions to itself: a no-op move through the state
        // machine would make "did anything happen" unanswerable.
        expect(to).not.toBe(from);
      }
    }
  });

  it('counts an assessed claim against the annual cap, not just a paid one', () => {
    // §9 of the brief: a cap that counted only completed payments would let
    // two approvals share one member's ceiling and leave the business
    // committed to twice what it meant to be.
    expect(CAP_CONSUMING_BENEFIT_STATUSES).toEqual(['assessed', 'approved', 'paid']);

    for (const status of BENEFIT_CLAIM_STATUSES) {
      expect(consumesAnnualCap(status), status).toBe(
        (['assessed', 'approved', 'paid'] as readonly BenefitClaimStatus[]).includes(
          status,
        ),
      );
    }

    // And a reversal releases the capacity, because the money came back.
    expect(consumesAnnualCap('reversed')).toBe(false);
  });
});

describe('the medical benefit arithmetic', () => {
  it('is 5% of the bill, in whole shillings', () => {
    // The figure the brief itself quotes.
    expect(medicalBenefitAmount(400_000, 500)).toBe(toUgx(20_000));
  });

  it('rounds half up, and never through a float', () => {
    // 5% of 123,455 is 6,172.75 → 6,173. `123455 * 0.05` in JavaScript is
    // 6172.750000000001, and a floor of that is 6,172: one shilling wrong,
    // every time, in the business's favour.
    expect(medicalBenefitAmount(123_455, 500)).toBe(toUgx(6_173));

    // 5% of 123,450 is 6,172.5 → 6,173 half-up.
    expect(medicalBenefitAmount(123_450, 500)).toBe(toUgx(6_173));

    // 5% of 123,440 is 6,172 exactly.
    expect(medicalBenefitAmount(123_440, 500)).toBe(toUgx(6_172));
  });

  it('is zero on a zero bill rather than an error', () => {
    // A zero bill is a recordable fact — a hospital that charged nothing —
    // and the benefit on it is zero. The *claim* is then refused for a reason
    // the assessment gives, not by an exception in a pricing function.
    expect(medicalBenefitAmount(0, 500)).toBe(toUgx(0));
  });

  it('refuses a bill or a rate that is not a whole non-negative number', () => {
    for (const bill of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => medicalBenefitAmount(bill, 500), String(bill)).toThrow(RangeError);
    }

    for (const rate of [-1, 2.5, Number.NaN]) {
      expect(() => medicalBenefitAmount(400_000, rate), String(rate)).toThrow(RangeError);
    }
  });

  it('returns the policy figure unchanged for the two fixed benefits', () => {
    const amounts = {
      medicalBenefitRateBps: 500,
      familyCondolenceBenefit: 100_000,
      memberBereavementBenefit: 200_000,
    };

    // Neither is capped, counted or pro-rated, so there is nothing for the
    // amount to be other than the figure.
    expect(benefitAmountFor('family_condolence', amounts, null)).toBe(toUgx(100_000));
    expect(benefitAmountFor('member_bereavement', amounts, null)).toBe(toUgx(200_000));

    // And a medical claim with no bill yet has no amount at all, rather than
    // zero: an admission still running is not a claim worth nothing.
    expect(benefitAmountFor('medical', amounts, null)).toBeNull();
    expect(benefitAmountFor('medical', amounts, 400_000)).toBe(toUgx(20_000));
  });
});

describe('the three readings of an admission', () => {
  it('reads one night, two ward days and nought clock days for 22:00 to 09:00', () => {
    // The stay the whole question is about. A ward chart says two days, a
    // clock says none, and the night count says one.
    const length = admissionLength(
      new Date('2026-03-10T22:00:00+03:00'),
      new Date('2026-03-11T09:00:00+03:00'),
      kampalaDay,
    );

    expect(length).toEqual({ nights: 1, inclusiveDays: 2, elapsedDays: 0 });
  });

  it('counts a four-night stay as four, five and four', () => {
    const length = admissionLength(
      new Date('2026-03-10T08:00:00+03:00'),
      new Date('2026-03-14T10:00:00+03:00'),
      kampalaDay,
    );

    expect(length).toEqual({ nights: 4, inclusiveDays: 5, elapsedDays: 4 });
  });

  it('counts a same-day stay as nought, one and nought', () => {
    const length = admissionLength(
      new Date('2026-03-10T08:00:00+03:00'),
      new Date('2026-03-10T18:00:00+03:00'),
      kampalaDay,
    );

    expect(length).toEqual({ nights: 0, inclusiveDays: 1, elapsedDays: 0 });
  });

  it('reads the day in Kampala, not in UTC', () => {
    // 2026-03-10T22:00Z is already 01:00 on the 11th in Kampala. A reading
    // that used UTC would call this a one-night stay when the ward chart says
    // the member arrived and left on the same day.
    const length = admissionLength(
      new Date('2026-03-10T22:00:00Z'),
      new Date('2026-03-11T05:00:00Z'),
      kampalaDay,
    );

    expect(length.nights).toBe(0);
    expect(length.inclusiveDays).toBe(1);
  });

  it('qualifies only when every reading clears the threshold', () => {
    const fourNights = { nights: 4, inclusiveDays: 5, elapsedDays: 4 };

    expect(admissionVerdict(fourNights, 1)).toEqual({
      qualifies: true,
      tooShort: false,
      undecided: false,
    });
  });

  it('refuses only when no reading clears it', () => {
    const sameDay = { nights: 0, inclusiveDays: 1, elapsedDays: 0 };

    expect(admissionVerdict(sameDay, 1)).toEqual({
      qualifies: false,
      tooShort: true,
      undecided: false,
    });
  });

  it('is undecided when the readings disagree, and says so as its own answer', () => {
    // The arm that matters. One of three readings clears the threshold, so
    // the stay is neither payable nor refusable until the client says what is
    // being counted — and the verdict carries that as a third state rather
    // than falling to either side of it.
    const overnight = { nights: 1, inclusiveDays: 2, elapsedDays: 0 };

    expect(admissionVerdict(overnight, 1)).toEqual({
      qualifies: false,
      tooShort: false,
      undecided: true,
    });
  });

  it('is never more than one of the three at once', () => {
    for (const nights of [0, 1, 2, 3]) {
      for (const threshold of [0, 1, 2]) {
        const verdict = admissionVerdict(
          { nights, inclusiveDays: nights + 1, elapsedDays: Math.max(0, nights - 1) },
          threshold,
        );

        const set = [verdict.qualifies, verdict.tooShort, verdict.undecided].filter(
          Boolean,
        );

        expect(
          set,
          `${String(nights)} nights, threshold ${String(threshold)}`,
        ).toHaveLength(1);
      }
    }
  });
});

describe('the eligibility codes', () => {
  it('names seventeen, each with a heading a screen can show', () => {
    expect(BENEFIT_ELIGIBILITY_CODES).toHaveLength(17);

    for (const code of BENEFIT_ELIGIBILITY_CODES) {
      expect(BENEFIT_ELIGIBILITY_CODE_LABELS[code].length).toBeGreaterThan(0);
    }
  });

  it('keeps "nobody has decided" apart from "this does not qualify"', () => {
    // The distinction a screen has to get right. "Your admission was too
    // short" is a refusal the member can be told; "nobody has decided which
    // of three ways we count a day" is the business owing itself an answer,
    // and showing it as a refusal would tell somebody they had been turned
    // down when they have not.
    expect(UNDECIDED_BENEFIT_ELIGIBILITY_CODES).toEqual([
      'policy_not_open',
      'membership_suspended_undecided',
      'admission_measure_undecided',
      'medical_year_basis_undecided',
      'relationship_eligibility_undecided',
      'bereavement_loan_offset_undecided',
    ]);

    for (const code of BENEFIT_ELIGIBILITY_CODES) {
      expect(isUndecidedEligibilityCode(code), code).toBe(
        UNDECIDED_BENEFIT_ELIGIBILITY_CODES.includes(code),
      );
    }

    expect(isUndecidedEligibilityCode('admission_too_short')).toBe(false);
    expect(isUndecidedEligibilityCode('not_a_code')).toBe(false);
  });

  it('every undecided code is a real code', () => {
    for (const code of UNDECIDED_BENEFIT_ELIGIBILITY_CODES) {
      expect(BENEFIT_ELIGIBILITY_CODES).toContain(code);
    }
  });
});

describe('the benefit year', () => {
  it('names both arms and defaults to neither', () => {
    expect(BENEFIT_YEAR_BASES).toEqual(['calendar_year', 'enrolment_anniversary']);

    expect(isBenefitYearBasis('calendar_year')).toBe(true);
    expect(isBenefitYearBasis('enrolment_anniversary')).toBe(true);

    // A member admitted in December and again in January has either one
    // year's cap or two, so there is no sensible default and nothing here
    // supplies one.
    for (const value of [undefined, null, '', 'calendar', 'year', 2026]) {
      expect(isBenefitYearBasis(value), String(value)).toBe(false);
    }
  });
});

describe('the beneficiary vocabularies', () => {
  it('names three record states and three verification states', () => {
    expect(BENEFICIARY_STATUSES).toEqual(['active', 'superseded', 'revoked']);
    expect(BENEFICIARY_VERIFICATION_STATUSES).toEqual([
      'pending_verification',
      'verified',
      'rejected',
    ]);
  });

  it('knows which evidence kinds need a document the database can check', () => {
    // A document kind is checked against the private bucket under this
    // membership's own path. The other two are an attestation by a second
    // member of staff and a record the business already holds, neither of
    // which has a file.
    expect(beneficiaryEvidenceNeedsDocument('relationship_document')).toBe(true);
    expect(beneficiaryEvidenceNeedsDocument('identity_document')).toBe(true);
    expect(beneficiaryEvidenceNeedsDocument('witnessed_in_branch')).toBe(false);
    expect(beneficiaryEvidenceNeedsDocument('existing_client_record')).toBe(false);

    expect(BENEFICIARY_EVIDENCE_KINDS).toHaveLength(4);
  });

  it('offers wider identification than the client record, and no NIN field', () => {
    // A beneficiary is a third party who has consented to nothing, may be a
    // minor and may hold no national ID at all — and which documents are
    // acceptable is a decision the client has not made. So the list records
    // what was shown.
    expect(BENEFICIARY_IDENTITY_DOCUMENT_KINDS).toContain('village_letter');
    expect(BENEFICIARY_IDENTITY_DOCUMENT_KINDS).toContain('birth_certificate');
    expect(BENEFICIARY_IDENTITY_DOCUMENT_KINDS).toContain('other');
  });
});
