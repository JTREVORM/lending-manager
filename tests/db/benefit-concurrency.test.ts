import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
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
import { closePool, getClient, hasDatabase, query, skipReason } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * Two claims racing for one member's annual cap.
 *
 * ## The failure this suite exists to catch
 *
 * Two medical claims, each worth 60% of the member's annual cap, assessed at
 * the same moment. Each reads the year's consumption, each sees zero, each
 * finds room, each writes. The member is now committed 120% of their cap and
 * the business has approved money it meant to refuse — and nothing in the
 * schema would ever say so, because each snapshot is individually consistent
 * with the cap it checked against.
 *
 * `assess_benefit_claim` takes `pg_advisory_xact_lock` on the membership
 * before it reads anything, so the second assessment waits for the first to
 * commit and then sees it. That is what these tests prove, by running two
 * sessions against one member and holding the first open.
 *
 * ## Why the lock is on the membership and not on the claim
 *
 * The thing being protected is the *member's* remaining entitlement, which is
 * shared between their claims. A lock on the claim would serialise each claim
 * against itself, which nothing was racing.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('benefit concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secondAssessor: TestUser;
  secretary: TestUser;
  policyId: string;
}

let fx: Fixtures;

/** A submitted medical claim with every required document checked. */
async function readyClaim(
  member: BenefitMember,
  bill: number,
  provider: string,
  admission: string,
  discharge: string,
): Promise<string> {
  const opened = await asUserCommitted(fx.secretary, [
    {
      sql: `select public.open_benefit_claim(
                     $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
                     $5::bigint, null, null, null) as id`,
      params: [member.membershipId, provider, admission, discharge, bill],
    },
  ]);

  const claimId = (opened.rows[0] as { id: string }).id;

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

  return claimId;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secondAssessor, secretary] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
  ]);

  const policyId = await publishTestPolicy({
    version: '43.0',
    // Its own effective day. `membership_policy_versions_effective_from_unique`
    // and `..._one_active` between them mean every suite needs a distinct
    // date, and the suites run sequentially in one database.
    effectiveDaysAgo: 898,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
    // TEST ONLY. A cap of 1,000,000 and a 5% rate means a 12,000,000 bill is
    // worth 600,000 — 60% of the cap, so two of them cannot both fit.
    medicalAnnualCap: 1_000_000,
    medicalClaimsPerYear: 12,
    benefitWaitingPeriodDays: 0,
    medicalYearBasis: 'calendar_year',
  });

  fx = { owner, manager, secondAssessor, secretary, policyId };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await clearEvidenceBucket();
  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await closePool();
});

describeDb('two assessments racing for one annual cap', () => {
  it('serialises them, and the second sees the first', async () => {
    const member = await makeBenefitMember(fx.policyId, { activatedOn: '2024-06-01' });

    const first = await readyClaim(
      member,
      12_000_000,
      'Race Hospital A',
      '2025-02-03 08:00+03',
      '2025-02-08 09:00+03',
    );
    const second = await readyClaim(
      member,
      12_000_000,
      'Race Hospital B',
      '2025-04-03 08:00+03',
      '2025-04-08 09:00+03',
    );

    const a = await getClient();
    const b = await getClient();

    try {
      // Session A assesses and holds its transaction open, so it holds the
      // advisory lock on the membership.
      await a.query('begin');
      await a.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        fx.manager.authUserId,
      ]);
      const firstAmount = await a.query<{ amount: string }>(
        `select public.assess_benefit_claim($1, 'First through the door.') as amount`,
        [first],
      );
      expect(Number(firstAmount.rows[0]!.amount)).toBe(600_000);

      // Session B tries the second claim. It must block on the lock rather
      // than read a stale consumption figure, so the call is raced against a
      // short timer: if it returned before A committed, it had not waited.
      await b.query('begin');
      await b.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        fx.secondAssessor.authUserId,
      ]);
      await b.query(`set local lock_timeout = '2s'`);

      const secondAttempt = b
        .query(`select public.assess_benefit_claim($1, 'Second.') as amount`, [second])
        .then(
          () => ({ ok: true, message: '' }),
          (error: { message: string }) => ({ ok: false, message: error.message }),
        );

      const blocked = await Promise.race([
        secondAttempt.then(() => 'returned' as const),
        new Promise<'still waiting'>((resolve) => {
          setTimeout(() => resolve('still waiting'), 600);
        }),
      ]);

      // The lock held: B is waiting on A rather than reading around it.
      expect(blocked).toBe('still waiting');

      await a.query('commit');

      const outcome = await secondAttempt;

      // A committed 600,000 of a 1,000,000 cap, so B's 600,000 does not fit.
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain('medical_cap_exceeded');

      await b.query('rollback');
    } finally {
      try {
        await a.query('rollback');
      } catch {
        // Already committed.
      }
      try {
        await b.query('rollback');
      } catch {
        // Already rolled back.
      }
      a.release();
      b.release();
    }

    // One assessment on the record, not two.
    const assessed = await query<{ claim_id: string }>(
      `select claim_id from public.benefit_assessment_snapshots
        where membership_id = $1`,
      [member.membershipId],
    );
    expect(assessed).toHaveLength(1);
  });

  it('lets two claims that both fit through', async () => {
    const member = await makeBenefitMember(fx.policyId, { activatedOn: '2024-06-01' });

    // 5% of 8,000,000 is 400,000. Two of them is 800,000, inside the
    // 1,000,000 cap — so the lock must serialise them without refusing
    // either. A control that blocked anything concurrent would be useless.
    const first = await readyClaim(
      member,
      8_000_000,
      'Fits Hospital A',
      '2025-02-03 08:00+03',
      '2025-02-08 09:00+03',
    );
    const second = await readyClaim(
      member,
      8_000_000,
      'Fits Hospital B',
      '2025-04-03 08:00+03',
      '2025-04-08 09:00+03',
    );

    const results = await Promise.all([
      asUserCommitted(fx.manager, [
        { sql: `select public.assess_benefit_claim($1, null) as amount`, params: [first] },
      ]),
      asUserCommitted(fx.secondAssessor, [
        {
          sql: `select public.assess_benefit_claim($1, null) as amount`,
          params: [second],
        },
      ]),
    ]);

    expect(results.map((r) => r.message ?? 'ok')).toEqual(['ok', 'ok']);

    const snapshots = await query<{ assessed_amount: string }>(
      `select assessed_amount::text from public.benefit_assessment_snapshots
        where membership_id = $1`,
      [member.membershipId],
    );
    expect(snapshots).toHaveLength(2);
    expect(
      snapshots.reduce((total, row) => total + Number(row.assessed_amount), 0),
    ).toBe(800_000);
  });

  it('refuses two payments racing on one claim', async () => {
    const member = await makeBenefitMember(fx.policyId, { activatedOn: '2024-06-01' });
    const claimId = await readyClaim(
      member,
      4_000_000,
      'Payment Race Hospital',
      '2025-02-03 08:00+03',
      '2025-02-08 09:00+03',
    );

    await asUserCommitted(fx.manager, [
      { sql: `select public.assess_benefit_claim($1, null) as amount`, params: [claimId] },
    ]);
    await asUserCommitted(fx.owner, [
      {
        sql: `select public.approve_benefit_claim($1, null, null) as amount`,
        params: [claimId],
      },
    ]);

    // Two different keys, at once. The idempotency lock does not help here —
    // the keys differ — so what has to hold is the row lock on the claim and
    // the partial unique index on (claim_id) where unreversed.
    const results = await Promise.all([
      asUserCommitted(fx.manager, [
        {
          sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
          params: [claimId],
        },
      ]),
      asUserCommitted(fx.owner, [
        {
          sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid()) as id`,
          params: [claimId],
        },
      ]),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const payments = await query<{ id: string }>(
      `select id from public.benefit_payments where claim_id = $1`,
      [claimId],
    );
    expect(payments).toHaveLength(1);
  });

  it('refuses two beneficiaries racing to be the same member’s primary', async () => {
    const member = await makeBenefitMember(fx.policyId, { activatedOn: '2024-06-01' });

    const results = await Promise.all([
      asUserCommitted(fx.secretary, [
        {
          sql: `select public.register_member_beneficiary(
                         $1, 'Race Payee A', 'spouse', '+256700666001') as id`,
          params: [member.membershipId],
        },
      ]),
      asUserCommitted(fx.manager, [
        {
          sql: `select public.register_member_beneficiary(
                         $1, 'Race Payee B', 'child', '+256700666002') as id`,
          params: [member.membershipId],
        },
      ]),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const primaries = await query<{ id: string }>(
      `select id from public.member_beneficiaries
        where membership_id = $1 and status = 'active' and is_primary`,
      [member.membershipId],
    );
    expect(primaries).toHaveLength(1);
  });
});
