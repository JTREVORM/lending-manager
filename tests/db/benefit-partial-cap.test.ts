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
import { closePool, hasDatabase, query } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

const describeDb = hasDatabase ? describe : describe.skip;
let secretary: TestUser;
let assessor: TestUser;
let secondAssessor: TestUser;
let owner: TestUser;
let policyId: string | undefined;

async function readyMedicalClaim(
  member: BenefitMember,
  hospital: string,
  admission: string,
  discharge: string,
  bill: number,
): Promise<string> {
  const opened = await asUserCommitted(secretary, [
    {
      sql: `select public.open_benefit_claim(
        $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
        $5::bigint, null, null, null) as id`,
      params: [member.membershipId, hospital, admission, discharge, bill],
    },
  ]);
  expect(opened.ok, opened.message).toBe(true);
  const claimId = (opened.rows[0] as { id: string }).id;

  const submitted = await asUserCommitted(secretary, [
    { sql: 'select public.submit_benefit_claim($1)', params: [claimId] },
  ]);
  expect(submitted.ok, submitted.message).toBe(true);

  for (const kind of await requiredKindsFor('medical')) {
    await attachVerifiedDocument(claimId, member.membershipId, kind, secretary, assessor);
  }
  return claimId;
}

beforeAll(async () => {
  if (!hasDatabase) return;
  [secretary, assessor, secondAssessor, owner] = await Promise.all([
    createTestUser('secretary_treasurer'),
    createTestUser('manager'),
    createTestUser('manager'),
    createTestUser('owner_admin'),
  ]);
  policyId = await publishTestPolicy({
    version: '948.9',
    effectiveDaysAgo: 6107,
    medicalAnnualCap: 500_000,
    medicalClaimsPerYear: 2,
    medicalYearBasis: 'calendar_year',
    benefitWaitingPeriodDays: 0,
    medicalExcessHandling: 'pay_remaining',
  });
});

afterAll(async () => {
  if (!hasDatabase) return;
  await clearEvidenceBucket();
  await deleteTestUsers();
  if (policyId) await forcePolicyStatus(policyId, 'superseded');
  await closePool();
});

describeDb('partial annual medical cap is a versioned, locked business decision', () => {
  it('assesses only the remaining UGX 100,000 and stores the reduced amount', async () => {
    const member = await makeBenefitMember(policyId!, { activatedOn: '2024-06-01' });
    const first = await readyMedicalClaim(
      member,
      'Cap clinic A',
      '2025-02-03 08:00+03',
      '2025-02-08 08:00+03',
      8_000_000, // 5% = 400,000
    );
    const second = await readyMedicalClaim(
      member,
      'Cap clinic B',
      '2025-05-03 08:00+03',
      '2025-05-08 08:00+03',
      8_000_000, // 5% = 400,000, only 100,000 available
    );

    const firstResult = await asUserCommitted(assessor, [
      { sql: 'select public.assess_benefit_claim($1, null) as amount', params: [first] },
    ]);
    expect(firstResult.ok, firstResult.message).toBe(true);
    expect((firstResult.rows[0] as { amount: string }).amount).toBe('400000');

    const secondResult = await asUserCommitted(secondAssessor, [
      { sql: 'select public.assess_benefit_claim($1, null) as amount', params: [second] },
    ]);
    expect(secondResult.ok, secondResult.message).toBe(true);
    expect((secondResult.rows[0] as { amount: string }).amount).toBe('100000');

    const approved = await asUserCommitted(owner, [
      {
        sql: 'select public.approve_benefit_claim($1, null, null) as amount',
        params: [second],
      },
    ]);
    expect(approved.ok, approved.message).toBe(true);
    expect((approved.rows[0] as { amount: string }).amount).toBe('100000');

    const rows = await query<{
      assessed_amount: string;
      annual_cap: string;
      remaining_cap_before: string;
      medical_benefit_excess_handling: string;
    }>(
      `
      select assessed_amount::text, annual_cap::text, remaining_cap_before::text,
             medical_benefit_excess_handling
        from public.benefit_assessment_snapshots
       where claim_id = $1
    `,
      [second],
    );
    expect(rows).toEqual([
      {
        assessed_amount: '100000',
        annual_cap: '500000',
        remaining_cap_before: '100000',
        medical_benefit_excess_handling: 'pay_remaining',
      },
    ]);
  });

  it('caps an oversized first claim and refuses another after exhaustion', async () => {
    const member = await makeBenefitMember(policyId!, { activatedOn: '2024-06-01' });
    const first = await readyMedicalClaim(
      member,
      'Cap clinic C',
      '2025-03-03 08:00+03',
      '2025-03-08 08:00+03',
      12_000_000, // nominally 600,000 > 500,000 annual cap
    );
    const second = await readyMedicalClaim(
      member,
      'Cap clinic D',
      '2025-06-03 08:00+03',
      '2025-06-08 08:00+03',
      1_000_000,
    );

    const firstResult = await asUserCommitted(assessor, [
      { sql: 'select public.assess_benefit_claim($1, null) as amount', params: [first] },
    ]);
    expect(firstResult.ok, firstResult.message).toBe(true);
    expect((firstResult.rows[0] as { amount: string }).amount).toBe('500000');

    const refused = await asUserCommitted(secondAssessor, [
      { sql: 'select public.assess_benefit_claim($1, null) as amount', params: [second] },
    ]);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('medical_cap_exceeded');
  });

  it('serializes simultaneous assessments and never exceeds the ceiling', async () => {
    const member = await makeBenefitMember(policyId!, { activatedOn: '2024-06-01' });
    const a = await readyMedicalClaim(
      member,
      'Cap clinic E',
      '2025-07-03 08:00+03',
      '2025-07-08 08:00+03',
      8_000_000,
    );
    const b = await readyMedicalClaim(
      member,
      'Cap clinic F',
      '2025-09-03 08:00+03',
      '2025-09-08 08:00+03',
      8_000_000,
    );

    const results = await Promise.all([
      asUserCommitted(assessor, [
        { sql: 'select public.assess_benefit_claim($1, null) as amount', params: [a] },
      ]),
      asUserCommitted(secondAssessor, [
        { sql: 'select public.assess_benefit_claim($1, null) as amount', params: [b] },
      ]),
    ]);
    expect(
      results.every((r) => r.ok),
      results.map((r) => r.message).join('; '),
    ).toBe(true);
    const amounts = results.map((r) => Number((r.rows[0] as { amount: string }).amount));
    expect(amounts.sort((x, y) => x - y)).toEqual([100_000, 400_000]);
    expect(amounts.reduce((sum, x) => sum + x, 0)).toBe(500_000);
  });
});
