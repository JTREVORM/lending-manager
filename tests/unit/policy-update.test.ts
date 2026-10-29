import { describe, expect, it } from 'vitest';

import {
  isBenefitPolicyReady,
  outstandingPolicyDecisions,
  type PolicyDecisionState,
} from '@/lib/domain/membership';
import { policyUpdateSchema } from '@/lib/validation/policy-update';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const policy: PolicyDecisionState = {
  status: 'active',
  approvedAt: '2026-10-29T08:00:00Z',
  interestBasis: 'per_month',
  interestMethod: 'flat',
  savingsToLoanMultiplierBps: 20000,
  qualifyingMonthsConsecutive: false,
  savingsWithdrawalWithActiveLoan: 'blocked',
  profitDistributionBasis: null,
  medicalBenefitAnnualCap: null,
  medicalBenefitClaimsPerYear: 2,
  benefitWaitingPeriodDays: null,
  medicalBenefitCapMode: 'no_separate_cap',
  benefitQualificationBasis: 'savings_qualifying_months',
  medicalBenefitYearBasis: 'enrolment_anniversary',
  deathConfirmationsRequired: 3,
};

describe('policy implementation validation', () => {
  it('requires an explicit timing date and business authorization reference', () => {
    expect(
      policyUpdateSchema.safeParse({
        operation: 'record_timing',
        policyId: ID,
        effectiveDate: '2026-12-02',
        reference: 'Board minute 17',
      }).success,
    ).toBe(true);
    expect(
      policyUpdateSchema.safeParse({
        operation: 'record_timing',
        policyId: ID,
        effectiveDate: '',
        reference: 'Board minute 17',
      }).success,
    ).toBe(false);
    expect(
      policyUpdateSchema.safeParse({
        operation: 'record_timing',
        policyId: ID,
        effectiveDate: '2026-12-02',
        reference: '',
      }).success,
    ).toBe(false);
  });

  it.each(['-1', '0', '1.5', '5,000', '1e3', '10000001'])(
    'refuses invalid fine money %s',
    (amount) => {
      expect(
        policyUpdateSchema.safeParse({
          operation: 'collect_fine',
          fineId: ID,
          key: OTHER,
          amount,
          method: 'cash',
          reference: '',
        }).success,
      ).toBe(false);
    },
  );

  it('requires a network reference only for a network or bank payment', () => {
    const base = { operation: 'collect_fine', fineId: ID, key: OTHER, amount: '5000' };
    expect(
      policyUpdateSchema.safeParse({ ...base, method: 'cash', reference: '' }).success,
    ).toBe(true);
    expect(
      policyUpdateSchema.safeParse({ ...base, method: 'cash', reference: 'TX1234' })
        .success,
    ).toBe(false);
    expect(
      policyUpdateSchema.safeParse({ ...base, method: 'bank', reference: '' }).success,
    ).toBe(false);
    expect(
      policyUpdateSchema.safeParse({ ...base, method: 'bank', reference: 'TX1234' })
        .success,
    ).toBe(true);
  });

  it('requires a real membership identifier for a death confirmation', () => {
    expect(
      policyUpdateSchema.safeParse({
        operation: 'confirm_death',
        claimId: ID,
        membershipId: 'Typed Person',
        statement: 'I confirm the death.',
      }).success,
    ).toBe(false);
    expect(
      policyUpdateSchema.safeParse({
        operation: 'confirm_death',
        claimId: ID,
        membershipId: OTHER,
        statement: 'I confirm the death.',
      }).success,
    ).toBe(true);
  });

  it('requires a reason for cancellation and reversal', () => {
    expect(
      policyUpdateSchema.safeParse({ operation: 'cancel_fine', fineId: ID, note: '' })
        .success,
    ).toBe(false);
    expect(
      policyUpdateSchema.safeParse({
        operation: 'reverse_fine_payment',
        paymentId: ID,
        note: '',
      }).success,
    ).toBe(false);
  });
});

describe('benefit-specific policy readiness', () => {
  it('opens fixed benefits while the medical ceiling decision is outstanding', () => {
    const undecided = { ...policy, medicalBenefitCapMode: null };
    expect(isBenefitPolicyReady(undecided, 'medical')).toBe(false);
    expect(isBenefitPolicyReady(undecided, 'family_condolence')).toBe(true);
    expect(isBenefitPolicyReady(undecided, 'member_bereavement')).toBe(true);
  });

  it('distinguishes no separate ceiling from an undecided ceiling', () => {
    expect(isBenefitPolicyReady(policy, 'medical')).toBe(true);
    expect(outstandingPolicyDecisions(policy)).toEqual(['profitDistributionBasis']);
  });

  it('does not open any benefit on an unapproved draft', () => {
    for (const benefit of [
      'medical',
      'family_condolence',
      'member_bereavement',
    ] as const) {
      expect(
        isBenefitPolicyReady({ ...policy, status: 'draft', approvedAt: null }, benefit),
      ).toBe(false);
    }
  });
});
