import { describe, expect, it } from 'vitest';

import {
  LIVE_MEMBERSHIP_STATUSES,
  MEMBERSHIP_NUMBER_PATTERN,
  MEMBERSHIP_POLICY_STATUSES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUSES_REQUIRING_REASON,
  MEMBERSHIP_STATUS_DESCRIPTIONS,
  MEMBERSHIP_STATUS_LABELS,
  MEMBERSHIP_TRANSITIONS,
  TERMINAL_MEMBERSHIP_STATUSES,
  UNDECIDED_POLICY_RULES,
  UNDECIDED_POLICY_RULE_LABELS,
  canTransitionMembership,
  isLiveMembershipStatus,
  isMembershipNumber,
  isMembershipPolicyStatus,
  isMembershipStatus,
  isPolicyFinanciallyEnabled,
  isTerminalMembershipStatus,
  membershipStatusRequiresReason,
  membershipTransitionRequirements,
  membershipTransitionsFrom,
  outstandingPolicyDecisions,
  policyBlockedReason,
  type MembershipStatus,
  type PolicyDecisionState,
} from '@/lib/domain/membership';
import {
  REFERENCE_FORMAT_DEFAULTS,
  formatReference,
  parseReference,
} from '@/lib/domain/reference';
import {
  membershipSearchSchema,
  membershipTransitionSchema,
} from '@/lib/validation/membership';

/**
 * The membership domain, as pure logic.
 *
 * These assert the rules the database also enforces — the lifecycle, the
 * reason requirement, the financial gate — at the layer that decides what a
 * form offers and what an error says. The database tests
 * (`tests/db/memberships.test.ts`) assert the same rules where they are
 * actually enforced; neither file is a substitute for the other, and a
 * disagreement between them is the thing worth catching.
 */

const UUID = '3f1b4c4a-0b8a-4f4a-9f1e-5b2c7d8e9a01';
const OTHER_UUID = '3f1b4c4a-0b8a-4f4a-9f1e-5b2c7d8e9a02';

// ===========================================================================
describe('membership status vocabulary', () => {
  it('names every status, describes it, and discriminates it', () => {
    for (const status of MEMBERSHIP_STATUSES) {
      expect(MEMBERSHIP_STATUS_LABELS[status].trim(), status).not.toBe('');
      expect(MEMBERSHIP_STATUS_DESCRIPTIONS[status].trim(), status).not.toBe('');
      expect(isMembershipStatus(status)).toBe(true);
    }

    expect(isMembershipStatus('member')).toBe(false);
    expect(isMembershipStatus('ACTIVE')).toBe(false);
    expect(isMembershipStatus(undefined)).toBe(false);
    expect(isMembershipStatus(null)).toBe(false);
  });

  it('splits the statuses into live and terminal, with nothing in both or neither', () => {
    const live = new Set<MembershipStatus>(LIVE_MEMBERSHIP_STATUSES);
    const terminal = new Set<MembershipStatus>(TERMINAL_MEMBERSHIP_STATUSES);

    for (const status of MEMBERSHIP_STATUSES) {
      expect(live.has(status) !== terminal.has(status), status).toBe(true);
      expect(isLiveMembershipStatus(status), status).toBe(live.has(status));
      expect(isTerminalMembershipStatus(status), status).toBe(terminal.has(status));
    }
  });

  it('asks for a reason where the business chose the restriction, and not for a death', () => {
    expect(membershipStatusRequiresReason('suspended')).toBe(true);
    expect(membershipStatusRequiresReason('withdrawn')).toBe(true);

    // The reason for `deceased` is the status, and asking a clerk to type one
    // beside a bereavement benefit would be both pointless and unkind.
    expect(membershipStatusRequiresReason('deceased')).toBe(false);
    expect(membershipStatusRequiresReason('pending')).toBe(false);
    expect(membershipStatusRequiresReason('active')).toBe(false);

    expect(MEMBERSHIP_STATUSES_REQUIRING_REASON).toEqual(['suspended', 'withdrawn']);
  });
});

// ===========================================================================
describe('the membership lifecycle', () => {
  it('permits exactly the documented transitions and no others', () => {
    const permitted = new Set(
      Object.entries(MEMBERSHIP_TRANSITIONS).flatMap(([from, targets]) =>
        targets.map((to) => `${from}->${to}`),
      ),
    );

    expect([...permitted].toSorted()).toEqual([
      'active->deceased',
      'active->suspended',
      'active->withdrawn',
      'pending->active',
      'pending->deceased',
      'pending->withdrawn',
      'suspended->active',
      'suspended->deceased',
      'suspended->withdrawn',
    ]);
  });

  it('answers every from/to pair consistently with the table', () => {
    for (const from of MEMBERSHIP_STATUSES) {
      for (const to of MEMBERSHIP_STATUSES) {
        expect(canTransitionMembership(from, to), `${from}->${to}`).toBe(
          MEMBERSHIP_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it('never lets a status transition to itself', () => {
    for (const status of MEMBERSHIP_STATUSES) {
      expect(canTransitionMembership(status, status), status).toBe(false);
    }
  });

  it('lets nothing out of a terminal state', () => {
    for (const status of TERMINAL_MEMBERSHIP_STATUSES) {
      expect(membershipTransitionsFrom(status), status).toEqual([]);
    }
  });

  it('refuses the reactivation that would quietly restart a qualification clock', () => {
    // A client who withdrew and rejoins gets a *new* membership, because the
    // savings qualification period and the benefit waiting period both start
    // again. Reusing the row would carry the old dates forward.
    expect(canTransitionMembership('withdrawn', 'active')).toBe(false);
    expect(canTransitionMembership('withdrawn', 'pending')).toBe(false);
    expect(canTransitionMembership('deceased', 'active')).toBe(false);
  });

  it('states what each transition needs beyond the capability', () => {
    expect(membershipTransitionRequirements('suspended')).toHaveLength(1);
    expect(membershipTransitionRequirements('withdrawn')).toHaveLength(1);
    expect(membershipTransitionRequirements('active')).toEqual([]);
    expect(membershipTransitionRequirements('deceased')).toEqual([]);
  });
});

// ===========================================================================
describe('membership reference numbers', () => {
  it('formats and parses a membership number through the shared generator', () => {
    const formatted = formatReference('membership', 26, 1);

    expect(formatted).toBe('MB260001');
    expect(isMembershipNumber(formatted)).toBe(true);
    expect(parseReference(formatted)).toEqual({
      scope: 'membership',
      prefix: 'MB',
      twoDigitYear: 26,
      sequence: 1,
    });
  });

  it('grows a digit rather than truncating past its padding', () => {
    // Truncating would reintroduce duplicates, which is the whole thing the
    // generator exists to prevent.
    expect(formatReference('membership', 26, 123456)).toBe('MB26123456');
    expect(isMembershipNumber('MB26123456')).toBe(true);
  });

  it('rejects a shape that is not a membership number', () => {
    for (const value of ['CL26001', 'MB2601', 'MB', 'mb260001', '', 'MB26000A', 42]) {
      expect(isMembershipNumber(value), String(value)).toBe(false);
    }
  });

  it('keeps the application and the seeded format in step', () => {
    expect(REFERENCE_FORMAT_DEFAULTS.membership).toEqual({
      scope: 'membership',
      prefix: 'MB',
      padding: 4,
    });
  });

  it('does not collide with the client prefix when parsing', () => {
    // `MB` and `CL` are unambiguous, but the parser sorts by prefix length
    // and this is the assertion that keeps a future `M` scope honest.
    expect(parseReference('MB260001')?.scope).toBe('membership');
    expect(parseReference('CL26001')?.scope).toBe('client');
  });
});

// ===========================================================================
describe('the policy vocabulary', () => {
  it('discriminates a policy status', () => {
    for (const status of MEMBERSHIP_POLICY_STATUSES) {
      expect(isMembershipPolicyStatus(status)).toBe(true);
    }
    expect(isMembershipPolicyStatus('published')).toBe(false);
    expect(isMembershipPolicyStatus(null)).toBe(false);
  });

  it('labels every outstanding decision in words a person can act on', () => {
    expect(UNDECIDED_POLICY_RULES).toHaveLength(9);

    for (const rule of UNDECIDED_POLICY_RULES) {
      const label = UNDECIDED_POLICY_RULE_LABELS[rule];
      expect(label.trim(), rule).not.toBe('');
      // A label that merely restated the field name would be useless on the
      // screen that asks the client to settle it.
      expect(label.length, rule).toBeGreaterThan(20);
    }
  });
});

// ===========================================================================
describe('the financial gate', () => {
  /** A version with every decision made. The baseline the cases vary from. */
  const decided: PolicyDecisionState = {
    status: 'active',
    approvedAt: '2026-10-01T00:00:00.000Z',
    interestBasis: 'per_month',
    interestMethod: 'flat',
    savingsToLoanMultiplierBps: 20_000,
    qualifyingMonthsConsecutive: true,
    savingsWithdrawalWithActiveLoan: 'blocked',
    profitDistributionBasis: 'pro_rata_savings',
    medicalBenefitAnnualCap: 500_000,
    medicalBenefitClaimsPerYear: 2,
    benefitWaitingPeriodDays: 90,
  };

  it('opens only when the version is active, approved and complete', () => {
    expect(isPolicyFinanciallyEnabled(decided)).toBe(true);
    expect(policyBlockedReason(decided)).toBeNull();
  });

  it('stays shut for a draft, however complete', () => {
    const draft = { ...decided, status: 'draft' as const };

    expect(isPolicyFinanciallyEnabled(draft)).toBe(false);
    expect(policyBlockedReason(draft)).toContain('draft');
  });

  it('stays shut for a superseded version', () => {
    const old = { ...decided, status: 'superseded' as const };

    expect(isPolicyFinanciallyEnabled(old)).toBe(false);
    expect(policyBlockedReason(old)).toContain('superseded');
  });

  it('stays shut while the business has not approved it', () => {
    const unapproved = { ...decided, approvedAt: null };

    expect(isPolicyFinanciallyEnabled(unapproved)).toBe(false);
    expect(policyBlockedReason(unapproved)).toContain('not been approved');
  });

  it('stays shut while any single decision is outstanding', () => {
    for (const rule of UNDECIDED_POLICY_RULES) {
      const incomplete: PolicyDecisionState = { ...decided, [rule]: null };

      expect(outstandingPolicyDecisions(incomplete), rule).toEqual([rule]);
      expect(isPolicyFinanciallyEnabled(incomplete), rule).toBe(false);
      expect(policyBlockedReason(incomplete), rule).toContain('not been decided');
    }
  });

  it('counts a decided `false` as decided, not as missing', () => {
    // The distinction the whole model rests on. `qualifyingMonthsConsecutive:
    // false` means the client decided the months need not be consecutive. A
    // falsy check here would hold up a programme that is ready to run.
    const decidedFalse = { ...decided, qualifyingMonthsConsecutive: false };

    expect(outstandingPolicyDecisions(decidedFalse)).toEqual([]);
    expect(isPolicyFinanciallyEnabled(decidedFalse)).toBe(true);
  });

  it('counts a decided zero as decided, not as missing', () => {
    // `benefitWaitingPeriodDays: 0` means "no waiting period", which is a
    // real answer and a different one from "nobody has said".
    const noWait = {
      ...decided,
      benefitWaitingPeriodDays: 0,
      medicalBenefitClaimsPerYear: 0,
    };

    expect(outstandingPolicyDecisions(noWait)).toEqual([]);
    expect(isPolicyFinanciallyEnabled(noWait)).toBe(true);
  });

  it('reports every outstanding decision at once, and says how many', () => {
    const blank: PolicyDecisionState = {
      status: 'active',
      approvedAt: '2026-10-01T00:00:00.000Z',
      interestBasis: null,
      interestMethod: null,
      savingsToLoanMultiplierBps: null,
      qualifyingMonthsConsecutive: null,
      savingsWithdrawalWithActiveLoan: null,
      profitDistributionBasis: null,
      medicalBenefitAnnualCap: null,
      medicalBenefitClaimsPerYear: null,
      benefitWaitingPeriodDays: null,
    };

    expect(outstandingPolicyDecisions(blank)).toEqual([...UNDECIDED_POLICY_RULES]);
    expect(policyBlockedReason(blank)).toContain('9 membership rules');
  });

  it('says "rule has" for one and "rules have" for several', () => {
    const one = { ...decided, interestBasis: null };

    expect(policyBlockedReason(one)).toContain('1 membership rule has');
    expect(policyBlockedReason({ ...one, interestMethod: null })).toContain(
      '2 membership rules have',
    );
  });
});

// ===========================================================================
describe('the register filter', () => {
  it('reads a blank search and a blank status as no filter', () => {
    const parsed = membershipSearchSchema.parse({ query: '', status: '', page: '1' });

    expect(parsed).toEqual({ query: null, status: null, page: 1 });
  });

  it('trims a search term and keeps a recognised status', () => {
    const parsed = membershipSearchSchema.parse({
      query: '  Nakato  ',
      status: 'active',
      page: '3',
    });

    expect(parsed.query).toBe('Nakato');
    expect(parsed.status).toBe('active');
    expect(parsed.page).toBe(3);
  });

  it('refuses a status outside the vocabulary rather than guessing one', () => {
    expect(
      membershipSearchSchema.safeParse({ query: '', status: 'member', page: '1' })
        .success,
    ).toBe(false);
  });

  it('refuses a page that is not a page', () => {
    for (const page of ['0', '-4', 'first', '10001']) {
      expect(
        membershipSearchSchema.safeParse({ query: '', status: '', page }).success,
        page,
      ).toBe(false);
    }
  });
});

// ===========================================================================
describe('the transition schema', () => {
  it('accepts a documented transition', () => {
    const parsed = membershipTransitionSchema.safeParse({
      membershipId: UUID,
      from: 'pending',
      to: 'active',
      reason: '',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reason).toBeNull();
  });

  it('refuses a transition the lifecycle does not permit', () => {
    const parsed = membershipTransitionSchema.safeParse({
      membershipId: UUID,
      from: 'withdrawn',
      to: 'active',
      reason: 'Changed their mind',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      'cannot move from withdrawn to active',
    );
  });

  it('demands a reason for a suspension', () => {
    const parsed = membershipTransitionSchema.safeParse({
      membershipId: UUID,
      from: 'active',
      to: 'suspended',
      reason: '   ',
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(['reason']);
  });

  it('accepts a death with no reason', () => {
    expect(
      membershipTransitionSchema.safeParse({
        membershipId: OTHER_UUID,
        from: 'active',
        to: 'deceased',
        reason: '',
      }).success,
    ).toBe(true);
  });

  it('refuses an identifier that is not one', () => {
    expect(
      membershipTransitionSchema.safeParse({
        membershipId: 'not-a-uuid',
        from: 'pending',
        to: 'active',
        reason: '',
      }).success,
    ).toBe(false);
  });

  it('bounds the reason, so a text column cannot be used as storage', () => {
    expect(
      membershipTransitionSchema.safeParse({
        membershipId: UUID,
        from: 'active',
        to: 'suspended',
        reason: 'x'.repeat(501),
      }).success,
    ).toBe(false);
  });
});

// ===========================================================================
describe('the number pattern agrees with the database constraint', () => {
  it('matches the shape the CHECK constraint states', () => {
    // `memberships_number_shape` is `^MB[0-9]{5,}$`. Written out here so a
    // change to one without the other is visible in a diff.
    expect(MEMBERSHIP_NUMBER_PATTERN.source).toBe('^MB\\d{5,}$');
  });
});
