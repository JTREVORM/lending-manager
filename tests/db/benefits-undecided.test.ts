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
  requiredKindsFor,
  type BenefitMember,
} from '../helpers/benefits';
import {
  closePool,
  hasDatabase,
  inRollbackTransaction,
  query,
  skipReason,
} from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * What the benefits module does under the policy the client actually has.
 *
 * ## Why this is a suite of its own
 *
 * Every other benefit suite publishes a TEST ONLY policy version that answers
 * the medical cap, the claim frequency, the waiting period and the annual
 * period, because without answers there is nothing to assess. That makes them
 * tests of the *arithmetic* and the *controls*.
 *
 * This one is the opposite test, and it is the one that matters for delivery:
 * under a version where those four rules are undecided — which is what version
 * 1.0 looks like today — **nothing can be assessed, approved or paid**, and
 * every refusal names the decision rather than saying "not available".
 *
 * Only one policy version may be in force, so a suite cannot hold both an open
 * and a shut one. Hence two files, and this is the shut one.
 *
 * ## What is deliberately still allowed
 *
 * Recording a claim, and registering and verifying a beneficiary. §6 of the
 * Phase 4 brief says intake and beneficiary registration must not be blocked
 * by an undecided assessment rule, and the reason is practical: a business
 * that could not write down that somebody came in and asked would keep the
 * record on paper, where nobody can audit it.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('undecided benefit policy suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  undecidedPolicyId: string;
}

let fx: Fixtures;

const ADMISSION = { in: '2025-03-10 09:00+03', out: '2025-03-14 11:00+03' } as const;

async function openMedical(member: BenefitMember, provider: string): Promise<string> {
  const opened = await asUserCommitted(fx.secretary, [
    {
      sql: `select public.open_benefit_claim(
                     $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
                     400000, null, null, null) as id`,
      params: [member.membershipId, provider, ADMISSION.in, ADMISSION.out],
    },
  ]);
  if (!opened.ok) throw new Error(`could not open a claim: ${opened.message}`);
  return (opened.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
  ]);

  // Approved and in force, with the savings rules answered so a member can be
  // enrolled — and with **every benefit rule left undecided**, which is what
  // the client's own version 1.0 looks like today.
  const undecidedPolicyId = await publishTestPolicy({
    version: '45.0',
    // Its own effective day: `membership_policy_versions_effective_from_unique`
    // means two suites cannot both publish for the same date.
    effectiveDaysAgo: 880,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
  });

  fx = { owner, manager, secretary, undecidedPolicyId };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await clearEvidenceBucket();
  await deleteTestUsers();
  await forcePolicyStatus(fx.undecidedPolicyId, 'superseded');
  await closePool();
});

describeDb('the policy gate, with every benefit rule undecided', () => {
  it('lets a claim be recorded, because a claimant came in and asked', async () => {
    const member = await makeBenefitMember(fx.undecidedPolicyId, {
      activatedOn: '2024-06-01',
    });

    // Deliberately permitted. A business that could not write down that
    // somebody came in and asked would be keeping the record on paper, and
    // §6 of the brief says intake must not be blocked by an undecided
    // assessment rule.
    const claimId = await openMedical(member, 'Gate Hospital');
    const submitted = await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    expect(submitted.message ?? 'ok').toBe('ok');
  });

  it('refuses the assessment, naming all three decisions', async () => {
    const member = await makeBenefitMember(fx.undecidedPolicyId, {
      activatedOn: '2024-06-01',
    });
    const claimId = await openMedical(member, 'Gate Hospital Two');
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    for (const kind of await requiredKindsFor('medical')) {
      await attachVerifiedDocument(
        claimId,
        member.membershipId,
        kind,
        fx.secretary,
        fx.manager,
      );
    }

    const assessed = await asUserCommitted(fx.manager, [
      {
        sql: `select public.assess_benefit_claim($1, null) as amount`,
        params: [claimId],
      },
    ]);

    expect(assessed.ok).toBe(false);
    expect(assessed.message).toContain('policy_not_open');
    // The three decisions, in the words a person would use.
    expect(assessed.message).toContain('annual cap');
    expect(assessed.message).toContain('claims a member may make');
    expect(assessed.message).toContain('waiting period');
  });

  it('says exactly what is missing, rather than "not available"', async () => {
    const reason = await asUser(
      fx.owner,
      `select public.benefits_blocked_reason($1) as reason`,
      [fx.undecidedPolicyId],
    );

    expect(reason.message ?? 'ok').toBe('ok');
    const text = (reason.rows[0] as { reason: string }).reason;
    expect(text).toContain('Benefit payments wait on');
    expect(text).toContain('the most the medical benefit pays one member in a year');
    expect(text).toContain('how many medical claims a member may make in a year');
    expect(text).toContain('how long after enrolment a benefit may first be claimed');
  });

  it('refuses a payment even against a forged approval', async () => {
    const member = await makeBenefitMember(fx.undecidedPolicyId, {
      activatedOn: '2024-06-01',
    });
    const claimId = await openMedical(member, 'Forged Approval Hospital');

    // Forcing the claim to `approved` with an amount, as the table owner,
    // through the transitions the state machine does allow. There is no
    // snapshot behind it, and the policy is shut. Both refuse it.
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    await query(`alter table public.benefit_claims disable trigger benefit_claims_guard`);
    try {
      await query(
        `update public.benefit_claims
            set status = 'approved',
                assessed_amount = 20000, approved_amount = 20000,
                assessed_at = pg_catalog.now(), assessed_by_label = 'forged',
                decided_at = pg_catalog.now(), decided_by_label = 'forged'
          where id = $1`,
        [claimId],
      );
    } finally {
      await query(
        `alter table public.benefit_claims enable trigger benefit_claims_guard`,
      );
    }

    const paid = await asUserCommitted(fx.manager, [
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
        params: [claimId],
      },
    ]);

    expect(paid.ok).toBe(false);
    // The policy gate is re-asked at the moment the money moves, which is the
    // last point at which asking can still prevent anything.
    expect(paid.message).toContain('not open under policy version');
  });
});

// ===========================================================================
describeDb('the tenth decision is frozen like the other nine', () => {
  /**
   * The benefit year cannot be decided on a version somebody is held to.
   *
   * `membership_policy_versions_guard` freezes every contractual column the
   * moment a version is approved or anybody is enrolled under it, and the
   * reason given there applies to this column word for word: a member enrolled
   * while the rule was open did not agree to the answer somebody writes into
   * it afterwards. A cap measured over the calendar year and one measured over
   * the enrolment anniversary give a member admitted in December either one
   * year's ceiling or two.
   *
   * It is enforced by a trigger of its own — `membership_policy_year_basis_
   * guard` — rather than by folding the column into that function, so neither
   * is a copy of the other. These tests are therefore about the *rule* rather
   * than about which function states it.
   */
  it('refuses to decide the benefit year on the version in force', async () => {
    // A member is enrolled under this version, which is the stronger of the
    // two freezes: the rule binds the privileged path as well as a session.
    const refused = await (async (): Promise<string | null> => {
      try {
        await query(
          `update public.membership_policy_versions
              set medical_benefit_year_basis = 'calendar_year' where id = $1`,
          [fx.undecidedPolicyId],
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    expect(refused).not.toBeNull();
    expect(refused).toContain('Publish a new version');

    const after = await query<{ basis: string | null }>(
      `select medical_benefit_year_basis as basis
         from public.membership_policy_versions where id = $1`,
      [fx.undecidedPolicyId],
    );

    // Still undecided, which is the point: the refusal is not advisory.
    expect(after[0]?.basis).toBeNull();
  });

  it('allows it on a draft nobody has approved or been enrolled under', async () => {
    // The other side of the same rule, inside a transaction that is always
    // rolled back: a version cannot be deleted once it exists — the no-delete
    // trigger says so — and a suite that left an approved `46.0` behind would
    // fail on its second run against the same database.
    const outcome = await inRollbackTransaction(async (client) => {
      const draft = await client.query<{ id: string }>(
        `insert into public.membership_policy_versions
           (version, title, effective_from, status,
            registration_fee, monthly_savings_minimum, savings_qualifying_months,
            member_loan_interest_rate_bps, member_loan_max_term_months,
            member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
            medical_benefit_rate_bps, medical_benefit_min_admission_days,
            family_condolence_benefit, member_bereavement_benefit)
         values ('46.0', 'A draft, for the year-basis freeze test',
                 (public.business_date() - 879), 'draft',
                 5000, 50000, 6, 500, 5, 2, 3, 500, 1, 100000, 200000)
         returning id`,
      );

      const draftId = draft.rows[0]!.id;

      // A version still being drafted is a document being written, and the
      // figures in it are not yet terms anybody is held to. So it can be
      // edited, which is what a draft is for.
      await client.query(
        `update public.membership_policy_versions
            set medical_benefit_year_basis = 'enrolment_anniversary' where id = $1`,
        [draftId],
      );

      const edited = await client.query<{ basis: string | null }>(
        `select medical_benefit_year_basis as basis
           from public.membership_policy_versions where id = $1`,
        [draftId],
      );

      // And refused once it is approved, with nobody enrolled under it at all
      // — so the freeze is about the approval as well as about the enrolment.
      await client.query(
        `update public.membership_policy_versions
            set approved_at = pg_catalog.now() where id = $1`,
        [draftId],
      );

      let refusal: string | null = null;

      try {
        await client.query(
          `update public.membership_policy_versions
              set medical_benefit_year_basis = 'calendar_year' where id = $1`,
          [draftId],
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
        // The failed statement aborts the transaction; the rollback in
        // `inRollbackTransaction` is what ends it either way.
      }

      return { basis: edited.rows[0]?.basis ?? null, refusal };
    });

    expect(outcome.basis).toBe('enrolment_anniversary');
    expect(outcome.refusal).not.toBeNull();
    expect(outcome.refusal).toContain('has been approved');
  });
});
