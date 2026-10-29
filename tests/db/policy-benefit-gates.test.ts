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
} from '../helpers/benefits';
import { closePool, hasDatabase, queryOne } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

let owner: TestUser;
let secretary: TestUser;
let manager: TestUser;
let policyId: string | undefined;

beforeAll(async () => {
  if (!hasDatabase) return;
  [owner, secretary, manager] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('secretary_treasurer'),
    createTestUser('manager'),
  ]);
});

afterAll(async () => {
  if (!hasDatabase) return;
  await clearEvidenceBucket();
  await deleteTestUsers();
  if (policyId) await forcePolicyStatus(policyId, 'superseded');
  await closePool();
});

describe.skipIf(!hasDatabase)('official policy benefit gates', () => {
  it('preserves every recorded official financial decision without approval', async () => {
    const row = await queryOne(
      `select status, approved_at, effective_from,
        registration_fee::text, monthly_savings_minimum::text,
        savings_qualifying_months, qualifying_months_consecutive,
        savings_withdrawal_with_active_loan,
        member_loan_interest_rate_bps, interest_basis, interest_method,
        savings_to_loan_multiplier_bps, medical_benefit_rate_bps,
        medical_benefit_claims_per_year, medical_benefit_year_basis,
        medical_benefit_cap_mode, medical_benefit_annual_cap,
        benefit_qualification_basis, benefit_waiting_period_days,
        family_condolence_benefit::text, member_bereavement_benefit::text,
        death_confirmations_required, meeting_absence_fine::text,
        profit_distribution_basis, is_medical_benefit_enabled,
        is_condolence_benefit_enabled, is_bereavement_benefit_enabled
       from public.membership_policy_versions where version='2.0'`,
    );
    expect(row).toEqual({
      status: 'draft', approved_at: null, effective_from: null,
      registration_fee: '5000', monthly_savings_minimum: '50000',
      savings_qualifying_months: 6, qualifying_months_consecutive: false,
      savings_withdrawal_with_active_loan: 'blocked',
      member_loan_interest_rate_bps: 500, interest_basis: 'per_month',
      interest_method: 'flat', savings_to_loan_multiplier_bps: 20000,
      medical_benefit_rate_bps: 500, medical_benefit_claims_per_year: 2,
      medical_benefit_year_basis: 'enrolment_anniversary',
      medical_benefit_cap_mode: null, medical_benefit_annual_cap: null,
      benefit_qualification_basis: 'savings_qualifying_months',
      benefit_waiting_period_days: null, family_condolence_benefit: '100000',
      member_bereavement_benefit: '200000', death_confirmations_required: 3,
      meeting_absence_fine: '5000', profit_distribution_basis: null,
      is_medical_benefit_enabled: false, is_condolence_benefit_enabled: false,
      is_bereavement_benefit_enabled: false,
    });
  });

  it('keeps specified death benefits open while an unspecified medical ceiling stays closed', async () => {
    policyId = await publishTestPolicy({
      version: '947.1', effectiveDaysAgo: 2372,
      benefitQualificationBasis: 'savings_qualifying_months',
      medicalClaimsPerYear: 2, medicalYearBasis: 'enrolment_anniversary',
    });
    const gates = await queryOne(
      `select is_medical_benefit_enabled as medical,
        is_condolence_benefit_enabled as condolence,
        is_bereavement_benefit_enabled as bereavement
       from public.membership_policy_versions where id=$1`, [policyId],
    );
    expect(gates).toEqual({ medical: false, condolence: true, bereavement: true });
    const member = await makeBenefitMember(policyId);
    const opened = await asUserCommitted(secretary, [{
      sql: `select public.open_benefit_claim($1, 'medical', null, 'Clinic',
        public.business_now() - interval '4 days',
        public.business_now() - interval '1 day',
        400000, null, null, null) as id`,
      params: [member.membershipId],
    }]);
    expect(opened.ok, opened.message).toBe(true);
    const failure = await queryOne<{ count: string }>(
      `select count(*)::text from public.benefit_claim_eligibility($1)
        where failure_code='savings_months_not_qualified'`,
      [(opened.rows[0] as { id: string }).id],
    );
    expect(failure.count).toBe('1');
    await forcePolicyStatus(policyId, 'superseded');
  });

  it('honors an explicitly chosen no-separate-cap mode while enforcing the two-claim limit', async () => {
    policyId = await publishTestPolicy({
      version: '947.2', effectiveDaysAgo: 2373,
      medicalCapMode: 'no_separate_cap', medicalClaimsPerYear: 2,
      medicalYearBasis: 'enrolment_anniversary', benefitWaitingPeriodDays: 0,
    });
    const member = await makeBenefitMember(policyId);
    for (let index = 0; index < 3; index += 1) {
      const opened = await asUserCommitted(secretary, [{
        sql: `select public.open_benefit_claim($1, 'medical', null, $2,
          '2025-03-01 09:00+03'::timestamptz + ($3::int * interval '1 day'),
          '2025-03-04 11:00+03'::timestamptz + ($3::int * interval '1 day'),
          20000000, null, null, null) as id`,
        params: [member.membershipId, 'Cap test hospital ' + index, index * 10],
      }]);
      expect(opened.ok, opened.message).toBe(true);
      const claimId = (opened.rows[0] as { id: string }).id;
      const submitted = await asUserCommitted(secretary, [{
        sql: 'select public.submit_benefit_claim($1)', params: [claimId],
      }]);
      expect(submitted.ok, submitted.message).toBe(true);
      for (const kind of await requiredKindsFor('medical')) {
        await attachVerifiedDocument(claimId, member.membershipId, kind, secretary, manager);
      }
      const assessed = await asUserCommitted(manager, [{
        sql: 'select public.assess_benefit_claim($1, null) as amount', params: [claimId],
      }]);
      if (index < 2) {
        expect(assessed.ok, assessed.message).toBe(true);
        expect((assessed.rows[0] as { amount: string }).amount).toBe('1000000');
        const approved = await asUserCommitted(owner, [{
          sql: 'select public.approve_benefit_claim($1, null, null)', params: [claimId],
        }]);
        expect(approved.ok, approved.message).toBe(true);
      } else {
        expect(assessed.ok).toBe(false);
        expect(assessed.message).toContain('medical_claims_exhausted');
      }
    }
  });
});
