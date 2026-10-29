import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  attachVerifiedDocument,
  clearEvidenceBucket,
  makeBenefitMember,
  makeVerifiedBeneficiary,
  requiredKindsFor,
  recordDeathConfirmations,
  makeListedNextOfKin,
  type BenefitMember,
} from '../helpers/benefits';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * The claim lifecycle, the medical arithmetic, the caps, and every rule the
 * client has not decided.
 *
 * ## What the TEST ONLY policy in this suite is, and is not
 *
 * The client has not answered the medical annual cap, the claims a member may
 * make in a year, the benefit waiting period or the annual period's basis.
 * Four of these tests cannot exist without answers, so this suite **publishes
 * its own** version with figures it chooses and labels TEST ONLY — the same
 * thing the member-loan suites do with the interest basis.
 *
 * Those figures are the fixture's. They are not the programme's terms, they
 * are not in any migration, and `benefits-undecided.test.ts` is the suite that
 * proves the real seeded version refuses everything.
 *
 * ## The arithmetic the brief states
 *
 * 5% of a UGX 400,000 bill is UGX 20,000, by
 * `(400000 * 500 + 5000) / 10000` in `bigint`. Asserted here against the
 * database, and in `tests/unit/benefits.test.ts` against the TypeScript that
 * renders it, because two implementations of one rule is one too many unless
 * something holds them to each other.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('benefit claim suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  /** A second manager, so assess and approve can be two people. */
  approver: TestUser;
  policyId: string;
  nextMember: (activatedOn?: string) => Promise<BenefitMember>;
}

let fx: Fixtures;

/** An admission that clears "longer than one day" on every reading. */
const ADMISSION = {
  in: '2025-03-10 09:00+03',
  out: '2025-03-13 11:00+03',
} as const;

async function openMedicalClaim(
  member: BenefitMember,
  bill: number,
  options: {
    readonly admissionAt?: string;
    readonly dischargeAt?: string | null;
    readonly provider?: string;
  } = {},
): Promise<string> {
  const opened = await asUserCommitted(fx.secretary, [
    {
      sql: `select public.open_benefit_claim(
                     $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
                     $5::bigint, null, null, null) as id`,
      params: [
        member.membershipId,
        options.provider ?? 'Kiruddu Referral Hospital',
        options.admissionAt ?? ADMISSION.in,
        options.dischargeAt === undefined ? ADMISSION.out : options.dischargeAt,
        bill,
      ],
    },
  ]);

  if (!opened.ok) throw new Error(`could not open a medical claim: ${opened.message}`);
  return (opened.rows[0] as { id: string }).id;
}

/** Submit, attach and check every required document, and assess. */
async function driveToAssessed(
  claimId: string,
  member: BenefitMember,
  claimType: string,
): Promise<{
  readonly ok: boolean;
  readonly message?: string;
  readonly amount?: number;
}> {
  const submitted = await asUserCommitted(fx.secretary, [
    { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
  ]);
  if (!submitted.ok) return { ok: false, message: submitted.message };

  for (const kind of await requiredKindsFor(claimType)) {
    await attachVerifiedDocument(
      claimId,
      member.membershipId,
      kind,
      fx.secretary,
      fx.manager,
    );
  }

  if (claimType === 'family_condolence' || claimType === 'member_bereavement') {
    await recordDeathConfirmations(claimId, fx.policyId, fx.secretary);
  }

  const assessed = await asUserCommitted(fx.manager, [
    {
      sql: `select public.assess_benefit_claim($1, 'Evidence checked against the bill.') as amount`,
      params: [claimId],
    },
  ]);

  if (!assessed.ok) return { ok: false, message: assessed.message };

  return {
    ok: true,
    amount: Number((assessed.rows[0] as { amount: string }).amount),
  };
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, approver, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('client'),
  ]);

  // The approver needs `benefits:approve`, which no Manager holds and the
  // Owner does. Granted to this one Manager for the suite, explicitly, so the
  // tests of the separation can have two distinct people who each hold one
  // key — and so the default grant stays what 20261022000100 says it is.
  await query(
    `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')
     on conflict do nothing`,
    [approver.profileId],
  );

  const policyId = await publishTestPolicy({
    version: '41.0',
    // Its own effective day. `membership_policy_versions_effective_from_unique`
    // and `..._one_active` between them mean every suite needs a distinct
    // date, and the suites run sequentially in one database.
    effectiveDaysAgo: 900,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
    // TEST ONLY. The client has decided none of these four.
    medicalAnnualCap: 500_000,
    medicalClaimsPerYear: 3,
    benefitWaitingPeriodDays: 30,
    medicalYearBasis: 'calendar_year',
  });

  fx = {
    owner,
    manager,
    approver,
    secretary,
    borrower,
    policyId,
    nextMember: (activatedOn) =>
      makeBenefitMember(policyId, { activatedOn: activatedOn ?? '2024-06-01' }),
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await clearEvidenceBucket();
  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await closePool();
});

describeDb('the medical arithmetic', () => {
  it('pays 5% of a UGX 400,000 bill as UGX 20,000', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    const result = await driveToAssessed(claimId, member, 'medical');

    expect(result.message ?? 'ok').toBe('ok');
    expect(result.amount).toBe(20_000);
  });

  it('rounds half-up in integer arithmetic, never in floating point', async () => {
    // A bill whose 5% is not a whole shilling. 123_457 * 500 = 61_728_500,
    // plus 5_000 is 61_733_500, over 10_000 is 6_173 — half-up. In IEEE 754,
    // 123457 * 0.05 is 6172.8500000000004, which rounds the same way here and
    // does not on a different bill; the point is that the database never
    // touches a float.
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 123_457);

    const result = await driveToAssessed(claimId, member, 'medical');
    expect(result.amount).toBe(6_173);

    const row = await queryOne<{ assessed_amount: string; bill_amount: string }>(
      `select assessed_amount, bill_amount
         from public.benefit_assessment_snapshots where claim_id = $1`,
      [claimId],
    );

    // The snapshot's own constraint restates the rule, so the row could not
    // exist if the two disagreed. Asserted anyway, because a constraint that
    // nothing exercises is a constraint nobody knows works.
    expect(Number(row.assessed_amount)).toBe(
      Math.floor((Number(row.bill_amount) * 500 + 5000) / 10000),
    );
  });

  it('derives the claimed amount rather than accepting one', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 200_000);

    const row = await queryOne<{ claimed_amount: string; event_date: string }>(
      `select claimed_amount, event_date from public.benefit_claims where id = $1`,
      [claimId],
    );

    expect(Number(row.claimed_amount)).toBe(10_000);
    // And the event date is the admission date, whatever the caller passed —
    // in Africa/Kampala, which is what makes a 23:00 admission belong to the
    // day it happened rather than to the next one in UTC.
    expect(new Date(row.event_date).toISOString().slice(0, 10)).toBe('2025-03-10');
  });

  it('pays the policy’s fixed figure for a condolence claim', async () => {
    const member = await fx.nextMember();

    const opened = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
                       $1, 'family_condolence', '2025-04-02'::date,
                       null, null, null, null,
                       'Grace Akello', 'parent', null) as id`,
        params: [member.membershipId],
      },
    ]);

    const claimId = (opened.rows[0] as { id: string }).id;

    const row = await queryOne<{ claimed_amount: string }>(
      `select claimed_amount from public.benefit_claims where id = $1`,
      [claimId],
    );

    // UGX 100,000, from the policy version rather than from a constant in a
    // posting function: a figure in a function cannot be effective-dated.
    expect(Number(row.claimed_amount)).toBe(100_000);
  });
});

describeDb('the admission threshold', () => {
  it('refuses a stay that is short on every reading', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000, {
      admissionAt: '2025-03-10 09:00+03',
      dischargeAt: '2025-03-10 17:00+03',
    });

    const result = await driveToAssessed(claimId, member, 'medical');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('admission_too_short');
    expect(result.message).toContain('every reading');
  });

  it('holds a stay whose three readings disagree, naming the decision', async () => {
    // One night, two ward days, zero whole elapsed days. "Longer than one
    // day" is true on one reading and false on two, and which one the client
    // means is undecided — so the claim is held rather than assessed on
    // whichever reading happens to favour one side.
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000, {
      admissionAt: '2025-03-10 22:00+03',
      dischargeAt: '2025-03-11 09:00+03',
    });

    const readings = await queryOne<{
      admission_nights: number;
      admission_inclusive_days: number;
      admission_elapsed_days: number;
    }>(
      `select admission_nights, admission_inclusive_days, admission_elapsed_days
         from public.benefit_claims where id = $1`,
      [claimId],
    );

    expect(readings.admission_nights).toBe(1);
    expect(readings.admission_inclusive_days).toBe(2);
    expect(readings.admission_elapsed_days).toBe(0);

    const result = await driveToAssessed(claimId, member, 'medical');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('admission_measure_undecided');
    expect(result.message).toContain('which of the three');
  });

  it('refuses to submit a claim with no discharge recorded', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000, { dischargeAt: null });

    const submitted = await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    expect(submitted.ok).toBe(false);
    expect(submitted.message).toContain('no discharge date');
  });
});

describeDb('the waiting period', () => {
  it('refuses an event inside it, naming the date it opens', async () => {
    // Activated three weeks before the admission, against a 30-day period.
    const member = await fx.nextMember('2025-02-20');
    const claimId = await openMedicalClaim(member, 400_000);

    const result = await driveToAssessed(claimId, member, 'medical');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('waiting_period_not_served');
    expect(result.message).toContain('2025-03-22');
  });

  it('allows an event the day the period opens', async () => {
    // Exactly 30 days before the admission on 2025-03-10.
    const member = await fx.nextMember('2025-02-08');
    const claimId = await openMedicalClaim(member, 100_000);

    const result = await driveToAssessed(claimId, member, 'medical');

    expect(result.message ?? 'ok').toBe('ok');
    expect(result.amount).toBe(5_000);
  });
});

describeDb('the annual cap and the claim count', () => {
  it('refuses a claim that would exceed the cap, rather than part-paying it', async () => {
    const member = await fx.nextMember();

    // 5% of 8,000,000 is 400,000 — inside the 500,000 cap on its own.
    const first = await openMedicalClaim(member, 8_000_000, {
      provider: 'Mulago National Referral',
    });
    const firstResult = await driveToAssessed(first, member, 'medical');
    expect(firstResult.amount).toBe(400_000);

    // A second admission worth 150,000 would take the year to 550,000.
    const second = await openMedicalClaim(member, 3_000_000, {
      provider: 'Nsambya Hospital',
      admissionAt: '2025-06-02 08:00+03',
      dischargeAt: '2025-06-06 10:00+03',
    });
    const secondResult = await driveToAssessed(second, member, 'medical');

    expect(secondResult.ok).toBe(false);
    expect(secondResult.message).toContain('medical_cap_exceeded');
    // The refusal says what is left and why it is not simply paid.
    expect(secondResult.message).toContain('100000');
    expect(secondResult.message).toContain('undecided');
  });

  it('counts an assessed-but-unpaid claim against the cap', async () => {
    const member = await fx.nextMember();

    const first = await openMedicalClaim(member, 9_000_000, {
      provider: 'Case Medcare',
    });
    const firstResult = await driveToAssessed(first, member, 'medical');
    expect(firstResult.amount).toBe(450_000);

    // Nothing has been approved and nothing paid. A cap that counted only
    // completed payments would let this through and leave the business
    // committed to twice what it meant to be.
    const status = await queryOne<{ status: string }>(
      `select status from public.benefit_claims where id = $1`,
      [first],
    );
    expect(status.status).toBe('assessed');

    const second = await openMedicalClaim(member, 2_000_000, {
      provider: 'IHK Hospital',
      admissionAt: '2025-07-02 08:00+03',
      dischargeAt: '2025-07-06 10:00+03',
    });
    const secondResult = await driveToAssessed(second, member, 'medical');

    expect(secondResult.ok).toBe(false);
    expect(secondResult.message).toContain('medical_cap_exceeded');
  });

  it('refuses a fourth claim in a year that allows three', async () => {
    const member = await fx.nextMember();

    const providers = ['Hospital A', 'Hospital B', 'Hospital C', 'Hospital D'];
    const months = ['03', '05', '07', '09'];
    const results: { ok: boolean; message?: string }[] = [];

    for (let index = 0; index < 4; index += 1) {
      const claimId = await openMedicalClaim(member, 100_000, {
        provider: providers[index],
        admissionAt: `2025-${months[index]}-04 08:00+03`,
        dischargeAt: `2025-${months[index]}-08 10:00+03`,
      });
      results.push(await driveToAssessed(claimId, member, 'medical'));
    }

    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3]!.ok).toBe(false);
    expect(results[3]!.message).toContain('medical_claims_exhausted');
  });

  it('counts the calendar year, under the basis this policy chose', async () => {
    const member = await fx.nextMember();

    // December and the following January. Under `calendar_year` those are two
    // years and each gets its own cap; under `enrolment_anniversary` they
    // might be one. The suite's policy says calendar, so both go through.
    const december = await openMedicalClaim(member, 9_000_000, {
      provider: 'December Hospital',
      admissionAt: '2025-12-20 08:00+03',
      dischargeAt: '2025-12-24 10:00+03',
    });
    expect((await driveToAssessed(december, member, 'medical')).amount).toBe(450_000);

    const january = await openMedicalClaim(member, 9_000_000, {
      provider: 'January Hospital',
      admissionAt: '2026-01-04 08:00+03',
      dischargeAt: '2026-01-08 10:00+03',
    });
    const result = await driveToAssessed(january, member, 'medical');

    expect(result.message ?? 'ok').toBe('ok');
    expect(result.amount).toBe(450_000);
  });
});

describeDb('evidence', () => {
  it('refuses an assessment where a required document is unchecked', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    // Attach both required documents and check only one. A claim with two
    // files and one conclusion is a claim with one fact established.
    const kinds = await requiredKindsFor('medical');
    await attachVerifiedDocument(
      claimId,
      member.membershipId,
      kinds[0]!,
      fx.secretary,
      fx.manager,
    );

    const { putEvidenceObject } = await import('../helpers/benefits');
    const path = await putEvidenceObject(member.membershipId, kinds[1]!, claimId);
    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.attach_benefit_document(
                       $1, null, $2, $3, 'application/pdf', 20480, null) as id`,
        params: [claimId, kinds[1], path],
      },
    ]);

    const assessed = await asUserCommitted(fx.manager, [
      {
        sql: `select public.assess_benefit_claim($1, null) as amount`,
        params: [claimId],
      },
    ]);

    expect(assessed.ok).toBe(false);
    expect(assessed.message).toContain('evidence_missing');
    expect(assessed.message).toContain('have not been checked');
  });

  it('refuses a check from whoever attached the document', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    const { putEvidenceObject } = await import('../helpers/benefits');
    const path = await putEvidenceObject(member.membershipId, 'medical_invoice', claimId);

    const attached = await asUserCommitted(fx.manager, [
      {
        sql: `select public.attach_benefit_document(
                       $1, null, 'medical_invoice', $2,
                       'application/pdf', 20480, null) as id`,
        params: [claimId, path],
      },
    ]);

    const checked = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_benefit_document($1, true, null) as id`,
        params: [(attached.rows[0] as { id: string }).id],
      },
    ]);

    expect(checked.ok).toBe(false);
    expect(checked.message).toContain('attached that document');
  });

  it('refuses a document whose path names another claim', async () => {
    const member = await fx.nextMember();
    const mine = await openMedicalClaim(member, 400_000, { provider: 'Mine' });
    const theirs = await openMedicalClaim(member, 400_000, {
      provider: 'Theirs',
      admissionAt: '2025-08-01 08:00+03',
      dischargeAt: '2025-08-05 09:00+03',
    });

    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [mine] },
    ]);

    const { putEvidenceObject } = await import('../helpers/benefits');
    // A real object, filed under the other claim.
    const path = await putEvidenceObject(member.membershipId, 'medical_invoice', theirs);

    const attached = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.attach_benefit_document(
                       $1, null, 'medical_invoice', $2,
                       'application/pdf', 20480, null) as id`,
        params: [mine, path],
      },
    ]);

    expect(attached.ok).toBe(false);
    expect(attached.message).toContain('different claim');
  });

  it('refuses a metadata row naming an object nobody uploaded', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    const attached = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.attach_benefit_document(
                       $1, null, 'medical_invoice', $2,
                       'application/pdf', 20480, null) as id`,
        params: [
          claimId,
          `benefits/${member.membershipId}/medical_invoice/${claimId}/nothing.pdf`,
        ],
      },
    ]);

    expect(attached.ok).toBe(false);
    expect(attached.message).toContain('no such object');
  });

  it('refuses a death certificate on a medical claim', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    const { putEvidenceObject } = await import('../helpers/benefits');
    const path = await putEvidenceObject(
      member.membershipId,
      'member_death_evidence',
      claimId,
    );

    const attached = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.attach_benefit_document(
                       $1, null, 'member_death_evidence', $2,
                       'application/pdf', 20480, null) as id`,
        params: [claimId, path],
      },
    ]);

    expect(attached.ok).toBe(false);
    expect(attached.message).toContain('member_bereavement');
  });
});

describeDb('the state machine', () => {
  it('refuses a draft becoming paid', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    await expect(
      query(`update public.benefit_claims set status = 'paid' where id = $1`, [claimId]),
    ).rejects.toThrow(/cannot go from draft to paid/);
  });

  it('refuses approval of a claim nobody assessed', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    const approved = await asUserCommitted(fx.approver, [
      {
        sql: `select public.approve_benefit_claim($1, null, null) as amount`,
        params: [claimId],
      },
    ]);

    expect(approved.ok).toBe(false);
    expect(approved.message).toContain('Only an assessed claim is approved');
  });

  it('refuses an approval from the person who assessed it', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    // Assessed by the Owner, who holds `benefits:assess` **and**
    // `benefits:approve` — and must, because a rule that no person may hold
    // both would make a claim unapprovable on any day the one other
    // key-holder is out. So the refusal cannot come from the capability
    // check; it has to come from the function noticing it is the same person.
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    for (const kind of await requiredKindsFor('medical')) {
      await attachVerifiedDocument(
        claimId,
        member.membershipId,
        kind,
        fx.secretary,
        fx.owner,
      );
    }

    const assessed = await asUserCommitted(fx.owner, [
      {
        sql: `select public.assess_benefit_claim($1, 'Checked by the Owner.') as amount`,
        params: [claimId],
      },
    ]);
    expect(assessed.message ?? 'ok').toBe('ok');

    const approved = await asUserCommitted(fx.owner, [
      {
        sql: `select public.approve_benefit_claim($1, null, null) as amount`,
        params: [claimId],
      },
    ]);

    expect(approved.ok).toBe(false);
    expect(approved.message).toContain('You assessed claim');
    expect(approved.message).toContain('no check at all');
  });

  it('accepts an approval from somebody else', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await driveToAssessed(claimId, member, 'medical');

    const approved = await asUserCommitted(fx.approver, [
      {
        sql: `select public.approve_benefit_claim($1, null, 'Agreed.') as amount`,
        params: [claimId],
      },
    ]);

    expect(approved.message ?? 'ok').toBe('ok');

    const row = await queryOne<{
      status: string;
      approved_amount: string;
      assessed_by_label: string;
      decided_by_label: string;
    }>(
      `select status, approved_amount, assessed_by_label, decided_by_label
         from public.benefit_claims where id = $1`,
      [claimId],
    );

    expect(row.status).toBe('approved');
    expect(Number(row.approved_amount)).toBe(20_000);
    expect(row.assessed_by_label).not.toBe(row.decided_by_label);
  });

  it('refuses a part approval while that rule is undecided', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await driveToAssessed(claimId, member, 'medical');

    const approved = await asUserCommitted(fx.approver, [
      {
        sql: `select public.approve_benefit_claim($1, 15000, null) as amount`,
        params: [claimId],
      },
    ]);

    expect(approved.ok).toBe(false);
    expect(approved.message).toContain('paid in part is undecided');
  });

  it('refuses an approval above the assessment', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await driveToAssessed(claimId, member, 'medical');

    const approved = await asUserCommitted(fx.approver, [
      {
        sql: `select public.approve_benefit_claim($1, 25000, null) as amount`,
        params: [claimId],
      },
    ]);

    expect(approved.ok).toBe(false);
    expect(approved.message).toContain('not authorise more');
  });

  it('refuses a refusal with no reason, and records one with', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await driveToAssessed(claimId, member, 'medical');

    const silent = await asUserCommitted(fx.approver, [
      { sql: `select public.reject_benefit_claim($1, '') as id`, params: [claimId] },
    ]);
    expect(silent.ok).toBe(false);
    expect(silent.message).toContain('needs a reason');

    const refused = await asUserCommitted(fx.approver, [
      {
        sql: `select public.reject_benefit_claim(
                       $1, 'The invoice names a different patient.') as id`,
        params: [claimId],
      },
    ]);
    expect(refused.message ?? 'ok').toBe('ok');

    const row = await queryOne<{
      status: string;
      rejected_reason: string;
      approved_amount: string | null;
    }>(
      `select status, rejected_reason, approved_amount
         from public.benefit_claims where id = $1`,
      [claimId],
    );

    expect(row.status).toBe('rejected');
    expect(row.rejected_reason).toContain('different patient');
    expect(row.approved_amount).toBeNull();
  });

  it('refuses an assessor editing their own assessment', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await driveToAssessed(claimId, member, 'medical');

    // Even as the table owner, who RLS does not apply to.
    await expect(
      query(`update public.benefit_claims set assessed_amount = 999999 where id = $1`, [
        claimId,
      ]),
    ).rejects.toThrow(/on the record/);
  });

  it('freezes the claim’s facts at submission', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    await expect(
      query(`update public.benefit_claims set bill_amount = 900000 where id = $1`, [
        claimId,
      ]),
    ).rejects.toThrow(/facts it asserts are fixed/);
  });

  it('lets a draft be corrected freely, which is what a draft is for', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    await query(`update public.benefit_claims set bill_amount = 450000 where id = $1`, [
      claimId,
    ]);

    const row = await queryOne<{ bill_amount: string }>(
      `select bill_amount from public.benefit_claims where id = $1`,
      [claimId],
    );
    expect(Number(row.bill_amount)).toBe(450_000);
  });

  it('never deletes a claim', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    await expect(
      query(`delete from public.benefit_claims where id = $1`, [claimId]),
    ).rejects.toThrow();
  });
});

describeDb('duplicate events', () => {
  it('refuses a second live claim for the same admission', async () => {
    const member = await fx.nextMember();
    const first = await openMedicalClaim(member, 400_000);
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [first] },
    ]);

    const second = await openMedicalClaim(member, 400_000);
    const submitted = await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [second] },
    ]);

    expect(submitted.ok).toBe(false);
    expect(submitted.code).toBe('23505');
  });

  it('allows a resubmission after a refusal', async () => {
    const member = await fx.nextMember();
    const first = await openMedicalClaim(member, 400_000);
    await driveToAssessed(first, member, 'medical');
    await asUserCommitted(fx.approver, [
      {
        sql: `select public.reject_benefit_claim($1, 'The invoice was illegible.') as id`,
        params: [first],
      },
    ]);

    // The commonest reason a claim is refused is a document somebody can go
    // and fetch, so a rejected claim must not block the corrected one.
    const second = await openMedicalClaim(member, 400_000);
    const submitted = await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [second] },
    ]);

    expect(submitted.message ?? 'ok').toBe('ok');
  });

  it('refuses a second live bereavement claim on one membership', async () => {
    const member = await fx.nextMember();
    await makeVerifiedBeneficiary(member.membershipId, fx.secretary, fx.manager);

    const beneficiary = await queryOne<{ id: string }>(
      `select id from public.member_beneficiaries
        where membership_id = $1 and status = 'active'`,
      [member.membershipId],
    );

    const open = async (): Promise<string> => {
      const row = await asUserCommitted(fx.secretary, [
        {
          sql: `select public.open_benefit_claim(
                         $1, 'member_bereavement', '2025-05-01'::date,
                         null, null, null, null,
                         'The Deceased Member', null, $2) as id`,
          params: [member.membershipId, beneficiary.id],
        },
      ]);
      return (row.rows[0] as { id: string }).id;
    };

    const first = await open();
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [first] },
    ]);

    const second = await open();
    const submitted = await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [second] },
    ]);

    expect(submitted.ok).toBe(false);
    expect(submitted.code).toBe('23505');
  });
});

describeDb('the bereavement safeguards', () => {
  async function openBereavement(
    member: BenefitMember,
    beneficiaryId: string | null,
  ): Promise<string> {
    const row = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
                       $1, 'member_bereavement', '2025-05-01'::date,
                       null, null, null, null,
                       'The Deceased Member', null, $2) as id`,
        params: [member.membershipId, beneficiaryId],
      },
    ]);
    if (!row.ok) throw new Error(`could not open a bereavement claim: ${row.message}`);
    return (row.rows[0] as { id: string }).id;
  }

  it('refuses a claim with no beneficiary', async () => {
    const member = await fx.nextMember();
    const claimId = await openBereavement(member, null);

    const result = await driveToAssessed(claimId, member, 'member_bereavement');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('beneficiary_missing');
  });

  it('refuses a claim whose beneficiary nobody verified', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Unchecked Payee', 'spouse', '+256700555001') as id`,
        params: [member.membershipId],
      },
    ]);

    const claimId = await openBereavement(member, (created.rows[0] as { id: string }).id);
    const result = await driveToAssessed(claimId, member, 'member_bereavement');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('beneficiary_not_verified');
    expect(result.message).toContain('a name somebody typed');
  });

  it('freezes the payee into the snapshot, by copy', async () => {
    const member = await fx.nextMember();
    const beneficiaryId = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
      { fullName: 'Authorised Payee' },
    );

    const claimId = await openBereavement(member, beneficiaryId);
    const result = await driveToAssessed(claimId, member, 'member_bereavement');

    expect(result.message ?? 'ok').toBe('ok');
    expect(result.amount).toBe(200_000);

    const snapshot = await queryOne<{
      beneficiary_name: string;
      beneficiary_number: string;
      beneficiary_verified_by_label: string;
      outstanding_member_loan_principal: string;
    }>(
      `select beneficiary_name, beneficiary_number, beneficiary_verified_by_label,
              outstanding_member_loan_principal
         from public.benefit_assessment_snapshots where claim_id = $1`,
      [claimId],
    );

    expect(snapshot.beneficiary_name).toBe('Authorised Payee');
    expect(snapshot.beneficiary_verified_by_label).toContain('manager');
    expect(Number(snapshot.outstanding_member_loan_principal)).toBe(0);
  });

  it('refuses a beneficiary change while the claim is live', async () => {
    const member = await fx.nextMember();
    const beneficiaryId = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    const claimId = await openBereavement(member, beneficiaryId);
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    // The substitution attack: a member of staff who creates a beneficiary
    // and redirects a claim that is already under way.
    const substituted = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Substituted Payee', 'child', '+256700555002',
                       null, null, null, null, null, true, $2) as id`,
        params: [member.membershipId, beneficiaryId],
      },
    ]);

    expect(substituted.ok).toBe(false);
    expect(substituted.message).toContain('must not move');
  });

  it('refuses swapping the claim’s beneficiary once it names one', async () => {
    const member = await fx.nextMember();
    const first = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    const claimId = await openBereavement(member, first);
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    await expect(
      query(
        `update public.benefit_claims
            set beneficiary_id = gen_random_uuid() where id = $1`,
        [claimId],
      ),
    ).rejects.toThrow(/does not change|already names a beneficiary/);
  });

  it('holds a bereavement claim where the member holds a live member loan', async () => {
    const member = await fx.nextMember();
    const beneficiaryId = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    // Whether a bereavement benefit is reduced by an outstanding loan,
    // withheld, offset against pledged savings or unaffected is undecided
    // (Phase 3, and still open). So where the member holds one, the amount
    // payable cannot be determined and the claim is held — nothing netted, no
    // pledge released, no savings touched.
    //
    // The loan is driven to `active` through the owner-level exemption rather
    // than through approval and disbursement, because what this test is about
    // is the *boundary*: an active member loan exists, and the assessment must
    // refuse. Driving a whole loan would make this a test of Phase 3.
    const product = await queryOne<{ id: string }>(
      `select id from public.loan_products order by created_at limit 1`,
    );

    await query(`alter table public.loans disable trigger loans_guard_transition`);
    try {
      await query(
        `insert into public.loans
           (client_id, loan_product_id, branch_id, membership_id, status,
            principal_amount, interest_rate_bps, interest_method,
            loan_term_months, repayment_frequency,
            total_interest, total_expected_repayment, currency_code,
            min_loan_amount_applied, grace_period_days_applied,
            penalty_rate_bps_applied, proposed_disbursement_date,
            approved_at, approved_by, disbursed_at, disbursed_by)
         values ($1, $2, $3, $4, 'active', 500000, 500,
                 'reducing_balance_monthly', 3, 'weekly',
                 25000, 525000, 'UGX', 50000, 0, 200,
                 public.business_date(),
                 pg_catalog.now(), $5, pg_catalog.now(), $5)`,
        [
          member.clientId,
          product.id,
          member.branchId,
          member.membershipId,
          fx.owner.profileId,
        ],
      );
    } finally {
      await query(`alter table public.loans enable trigger loans_guard_transition`);
    }

    const claimId = await openBereavement(member, beneficiaryId);
    const result = await driveToAssessed(claimId, member, 'member_bereavement');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('bereavement_loan_outstanding');
    expect(result.message).toContain('Nothing has been netted');

    // And the savings pledge, if any, is untouched — nothing about filing a
    // claim releases security.
    const pledges = await query<{ released_at: string | null }>(
      `select released_at from public.member_loan_savings_pledges
        where membership_id = $1`,
      [member.membershipId],
    );
    expect(pledges.every((p) => p.released_at === null)).toBe(true);
  });
});

describeDb('the condolence relationship rule', () => {
  it('holds a family claim without a next-of-kin listing', async () => {
    const member = await fx.nextMember();

    const opened = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
                       $1, 'family_condolence', '2025-04-02'::date,
                       null, null, null, null,
                       'Grace Akello', 'parent', null) as id`,
        params: [member.membershipId],
      },
    ]);

    const claimId = (opened.rows[0] as { id: string }).id;
    const result = await driveToAssessed(claimId, member, 'family_condolence');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('next_of_kin_not_listed');
  });

  it('accepts a listed family member and holds a non-family relationship', async () => {
    const eligible = await fx.nextMember();
    const kin = await makeListedNextOfKin(
      eligible.membershipId, fx.secretary, fx.manager,
      { relationship: 'cousin', listedOn: '2025-03-01' },
    );
    const eligibleClaim = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
          $1, 'family_condolence', '2025-04-02'::date,
          null, null, null, null, 'Grace Akello', 'cousin', null, $2) as id`,
        params: [eligible.membershipId, kin],
      },
    ]);
    expect(eligibleClaim.ok).toBe(true);
    const result = await driveToAssessed(
      (eligibleClaim.rows[0] as { id: string }).id, eligible, 'family_condolence',
    );
    expect(result.message ?? 'ok').toBe('ok');
    expect(result.amount).toBe(100_000);

    const notEligible = await fx.nextMember();
    const refusedClaim = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
          $1, 'family_condolence', '2025-04-05'::date,
          null, null, null, null, 'A Friend', 'other', null) as id`,
        params: [notEligible.membershipId],
      },
    ]);
    expect(refusedClaim.ok).toBe(true);
    const refused = await driveToAssessed(
      (refusedClaim.rows[0] as { id: string }).id, notEligible, 'family_condolence',
    );
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('relationship_not_eligible');
  });
});

describeDb('who may do what', () => {
  it('refuses an assessment from a Secretary/Treasurer', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    const attempt = await asUser(
      fx.secretary,
      `select public.assess_benefit_claim($1, null) as amount`,
      [claimId],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('benefits:assess');
  });

  it('refuses an approval from a Manager who holds only assess', async () => {
    const member = await fx.nextMember();
    const claimId = await openMedicalClaim(member, 400_000);

    const attempt = await asUser(
      fx.manager,
      `select public.approve_benefit_claim($1, null, null) as amount`,
      [claimId],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('benefits:approve');
  });

  it('refuses a borrower opening a claim for anybody', async () => {
    const member = await fx.nextMember();

    const attempt = await asUser(
      fx.borrower,
      `select public.open_benefit_claim(
                $1, 'medical', null, 'Hospital', $2::timestamptz, $3::timestamptz,
                400000, null, null, null) as id`,
      [member.membershipId, ADMISSION.in, ADMISSION.out],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('benefits:claim');
  });
});
