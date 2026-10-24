import { describe, expect, it } from 'vitest';

import { toUgx } from '@/lib/domain/money';
import {
  CARD_REISSUE_REASONS,
  CARD_VERIFICATION_CODE_PATTERN,
  CONSENT_METHODS,
  CONSENT_METHOD_DESCRIPTIONS,
  CONSENT_METHOD_LABELS,
  CONSENT_METHOD_REQUIREMENTS,
  LIVE_WITHDRAWAL_STATUSES,
  MEMBERSHIP_CARD_NUMBER_PATTERN,
  MEMBERSHIP_CARD_REASONS,
  MEMBERSHIP_CARD_REASON_LABELS,
  MEMBERSHIP_FEE_RECEIPT_NUMBER_PATTERN,
  OFFERABLE_CONSENT_METHODS,
  POSTABLE_SAVINGS_KINDS,
  SAVINGS_ACCOUNT_NUMBER_PATTERN,
  SAVINGS_ACCOUNT_STATUSES,
  SAVINGS_ACCOUNT_STATUS_LABELS,
  SAVINGS_TRANSACTION_KINDS,
  SAVINGS_TRANSACTION_KIND_LABELS,
  SAVINGS_TRANSACTION_NUMBER_PATTERN,
  WITHDRAWAL_REQUEST_NUMBER_PATTERN,
  WITHDRAWAL_STATUSES,
  WITHDRAWAL_STATUS_LABELS,
  WITHDRAWAL_TRANSITIONS,
  allowsDeposit,
  allowsWithdrawal,
  canTransitionWithdrawal,
  consentSatisfiesActivation,
  contributionProgressPercent,
  isCardVerificationCode,
  isConsentMethod,
  isLiveWithdrawal,
  isMembershipCardReason,
  isNextMonth,
  isReversalKind,
  isSavingsAccountStatus,
  isSavingsTransactionKind,
  isWithdrawalStatus,
  longestConsecutiveRun,
  monthlyShortfall,
  qualificationOutcome,
  savingsSignOf,
  signedSavingsAmount,
  withdrawalBlockedReason,
} from '@/lib/domain/savings';

/**
 * The savings domain, as pure logic.
 *
 * Nothing here touches a database. What is being checked is that the
 * vocabulary this build knows matches the vocabulary the CHECK constraints
 * allow, that the arithmetic a screen does agrees with the arithmetic the
 * database does, and that the two rules the client has not decided are refused
 * rather than guessed.
 *
 * The database tests in `tests/db/savings.test.ts` are the authority on every
 * figure here. These exist because a screen that disagrees with the database
 * about whether a member qualifies is a support call, and because a progress
 * bar is cheaper to get right here than to find wrong in Kampala.
 */

describe('the account', () => {
  it('names the three statuses the constraint allows, and nothing else', () => {
    expect([...SAVINGS_ACCOUNT_STATUSES]).toEqual(['active', 'dormant', 'closed']);
    expect(Object.keys(SAVINGS_ACCOUNT_STATUS_LABELS).sort()).toEqual(
      [...SAVINGS_ACCOUNT_STATUSES].sort(),
    );
  });

  it('recognises its own statuses and refuses anything else', () => {
    expect(isSavingsAccountStatus('dormant')).toBe(true);
    expect(isSavingsAccountStatus('frozen')).toBe(false);
    expect(isSavingsAccountStatus(null)).toBe(false);
  });

  it('allows a deposit to a dormant account but a withdrawal from neither dormant nor closed', () => {
    // Dormant is a reporting state, not a restriction: a member coming back
    // after a year away should be able to pay in without a supervisor first
    // reopening something.
    expect(allowsDeposit('dormant')).toBe(true);
    expect(allowsDeposit('closed')).toBe(false);

    expect(allowsWithdrawal('active')).toBe(true);
    expect(allowsWithdrawal('dormant')).toBe(false);
    expect(allowsWithdrawal('closed')).toBe(false);
  });
});

describe('the subledger', () => {
  it('names the four kinds, two of which a caller may ask for', () => {
    expect([...SAVINGS_TRANSACTION_KINDS]).toEqual([
      'deposit',
      'withdrawal',
      'deposit_reversal',
      'withdrawal_reversal',
    ]);
    expect([...POSTABLE_SAVINGS_KINDS]).toEqual(['deposit', 'withdrawal']);
    expect(Object.keys(SAVINGS_TRANSACTION_KIND_LABELS).sort()).toEqual(
      [...SAVINGS_TRANSACTION_KINDS].sort(),
    );
  });

  it('knows which kinds are themselves reversals', () => {
    expect(isReversalKind('deposit')).toBe(false);
    expect(isReversalKind('withdrawal')).toBe(false);
    expect(isReversalKind('deposit_reversal')).toBe(true);
    expect(isReversalKind('withdrawal_reversal')).toBe(true);
  });

  it('signs each kind the way the generated column does', () => {
    // These four are the `signed_amount` expression, restated. A deposit and a
    // reversed withdrawal add; a withdrawal and a reversed deposit subtract.
    // `tests/db/savings.test.ts` asserts the column's own values, so a
    // disagreement here shows up as a failure there too.
    expect(savingsSignOf('deposit')).toBe(1);
    expect(savingsSignOf('withdrawal_reversal')).toBe(1);
    expect(savingsSignOf('withdrawal')).toBe(-1);
    expect(savingsSignOf('deposit_reversal')).toBe(-1);
  });

  it('applies the sign to an amount', () => {
    expect(signedSavingsAmount('deposit', toUgx(50_000))).toBe(50_000);
    expect(signedSavingsAmount('withdrawal', toUgx(20_000))).toBe(-20_000);
    expect(signedSavingsAmount('deposit_reversal', toUgx(50_000))).toBe(-50_000);
    expect(signedSavingsAmount('withdrawal_reversal', toUgx(20_000))).toBe(20_000);
  });

  it('recognises its own kinds', () => {
    expect(isSavingsTransactionKind('withdrawal_reversal')).toBe(true);
    expect(isSavingsTransactionKind('adjustment')).toBe(false);
  });
});

describe('the withdrawal lifecycle', () => {
  it('names the five statuses the constraint allows', () => {
    expect([...WITHDRAWAL_STATUSES]).toEqual([
      'pending',
      'approved',
      'rejected',
      'paid',
      'cancelled',
    ]);
    expect(Object.keys(WITHDRAWAL_STATUS_LABELS).sort()).toEqual(
      [...WITHDRAWAL_STATUSES].sort(),
    );
    expect(isWithdrawalStatus('paid')).toBe(true);
    expect(isWithdrawalStatus('settled')).toBe(false);
  });

  it('treats pending and approved as the ones that occupy the account', () => {
    // An account has at most one live request, enforced by a partial unique
    // index. These two are what "live" means: a rejected or cancelled request
    // is history, and a paid one is finished.
    expect([...LIVE_WITHDRAWAL_STATUSES]).toEqual(['pending', 'approved']);
    expect(isLiveWithdrawal('pending')).toBe(true);
    expect(isLiveWithdrawal('approved')).toBe(true);
    expect(isLiveWithdrawal('rejected')).toBe(false);
    expect(isLiveWithdrawal('paid')).toBe(false);
    expect(isLiveWithdrawal('cancelled')).toBe(false);
  });

  it('moves only forwards, and not out of a terminal state', () => {
    expect(canTransitionWithdrawal('pending', 'approved')).toBe(true);
    expect(canTransitionWithdrawal('pending', 'rejected')).toBe(true);
    expect(canTransitionWithdrawal('pending', 'cancelled')).toBe(true);
    expect(canTransitionWithdrawal('approved', 'paid')).toBe(true);
    expect(canTransitionWithdrawal('approved', 'cancelled')).toBe(true);

    // The ones that matter: a rejection cannot be quietly turned into an
    // approval, and a payment cannot be unmade by moving the status back.
    expect(canTransitionWithdrawal('rejected', 'approved')).toBe(false);
    expect(canTransitionWithdrawal('paid', 'approved')).toBe(false);
    expect(canTransitionWithdrawal('paid', 'cancelled')).toBe(false);
    expect(canTransitionWithdrawal('cancelled', 'pending')).toBe(false);
    expect(canTransitionWithdrawal('approved', 'pending')).toBe(false);
  });

  it('leaves the three terminal states with nowhere to go', () => {
    expect(WITHDRAWAL_TRANSITIONS.rejected).toEqual([]);
    expect(WITHDRAWAL_TRANSITIONS.paid).toEqual([]);
    expect(WITHDRAWAL_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('why a withdrawal is blocked', () => {
  const base = {
    accountStatus: 'active' as const,
    membershipIsActive: true,
    balance: toUgx(100_000),
    hasLiveWithdrawal: false,
    hasLiveLoan: false,
    withdrawalRule: 'allowed' as const,
  };

  it('allows an ordinary withdrawal', () => {
    expect(withdrawalBlockedReason(base)).toBeNull();
  });

  it('blocks a dormant or closed account, a dead membership and an empty balance', () => {
    expect(withdrawalBlockedReason({ ...base, accountStatus: 'dormant' })).toMatch(
      /needs an active account/i,
    );
    expect(withdrawalBlockedReason({ ...base, membershipIsActive: false })).toMatch(
      /active membership/i,
    );
    expect(withdrawalBlockedReason({ ...base, balance: toUgx(0) })).toMatch(
      /nothing in this account/i,
    );
    expect(withdrawalBlockedReason({ ...base, hasLiveWithdrawal: true })).toMatch(
      /already has a withdrawal/i,
    );
  });

  it('allows a withdrawal against a live loan when the policy says so', () => {
    expect(
      withdrawalBlockedReason({ ...base, hasLiveLoan: true, withdrawalRule: 'allowed' }),
    ).toBeNull();
  });

  it('blocks one when the policy says so', () => {
    expect(
      withdrawalBlockedReason({ ...base, hasLiveLoan: true, withdrawalRule: 'blocked' }),
    ).toMatch(/blocks withdrawals while a loan is running/i);
  });

  it('refuses to guess the pledged amount under above_pledged', () => {
    // The client chose a rule whose arithmetic they have not defined. Working
    // out "the excess over what secures the loan" needs a pledged amount,
    // which depends on the savings-to-loan multiplier that is itself
    // undecided. Inventing one would be inventing the member's security.
    const reason = withdrawalBlockedReason({
      ...base,
      hasLiveLoan: true,
      withdrawalRule: 'above_pledged',
    });

    expect(reason).toMatch(/has not been defined/i);
    expect(reason).toMatch(/savings-to-loan rule/i);
  });

  it('refuses to answer at all while the rule itself is undecided', () => {
    expect(
      withdrawalBlockedReason({ ...base, hasLiveLoan: true, withdrawalRule: null }),
    ).toMatch(/has not been decided/i);
  });

  it('says nothing about a live loan when there is no live loan', () => {
    // The undecided rule must not block a member who has no loan. This is the
    // activity-gate principle applied to one screen: an open question about
    // lending does not close the savings counter.
    expect(
      withdrawalBlockedReason({ ...base, hasLiveLoan: false, withdrawalRule: null }),
    ).toBeNull();
  });
});

describe('consent', () => {
  it('names the five methods the constraint allows but offers only four', () => {
    expect([...CONSENT_METHODS]).toEqual([
      'member_portal',
      'one_time_code',
      'signature_document',
      'witnessed_in_branch',
      'legacy_typed_name',
    ]);

    // `legacy_typed_name` exists so the Phase 1 rows that carry a typed name
    // can be labelled honestly as unverified. Offering it would be offering a
    // way to record a new acceptance that can never satisfy activation.
    expect(OFFERABLE_CONSENT_METHODS).not.toContain('legacy_typed_name');
    expect([...OFFERABLE_CONSENT_METHODS].sort()).toEqual(
      [
        'member_portal',
        'one_time_code',
        'signature_document',
        'witnessed_in_branch',
      ].sort(),
    );
  });

  it('labels and describes every method, including the one it does not offer', () => {
    for (const method of CONSENT_METHODS) {
      expect(CONSENT_METHOD_LABELS[method]).toBeTruthy();
      expect(CONSENT_METHOD_DESCRIPTIONS[method]).toBeTruthy();
    }
  });

  it('requires exactly one piece of evidence per method, and none for the portal', () => {
    // These four are the branches inside
    // `membership_terms_acceptances_guard`, restated. The portal needs
    // nothing extra because the session *is* the evidence.
    expect(CONSENT_METHOD_REQUIREMENTS.member_portal).toEqual([]);
    expect(CONSENT_METHOD_REQUIREMENTS.one_time_code).toEqual(['challengeId']);
    expect(CONSENT_METHOD_REQUIREMENTS.signature_document).toEqual(['signaturePath']);
    expect(CONSENT_METHOD_REQUIREMENTS.witnessed_in_branch).toEqual(['witnessProfileId']);
    expect(CONSENT_METHOD_REQUIREMENTS.legacy_typed_name).toEqual([]);
  });

  it('counts only a verified acceptance towards activation', () => {
    expect(consentSatisfiesActivation('verified')).toBe(true);
    expect(consentSatisfiesActivation('unverified')).toBe(false);
    expect(consentSatisfiesActivation('rejected')).toBe(false);
  });

  it('recognises its own methods', () => {
    expect(isConsentMethod('one_time_code')).toBe(true);
    expect(isConsentMethod('fingerprint')).toBe(false);
  });
});

describe('contribution arithmetic', () => {
  it('reports progress towards the month, capped at a hundred', () => {
    expect(contributionProgressPercent(toUgx(0), toUgx(50_000))).toBe(0);
    expect(contributionProgressPercent(toUgx(20_000), toUgx(50_000))).toBe(40);
    expect(contributionProgressPercent(toUgx(50_000), toUgx(50_000))).toBe(100);

    // Capped deliberately. A bar reading 160% invites the reading that three
    // months have been banked; the engine counts months, not shillings, which
    // is the entire point of a monthly minimum.
    expect(contributionProgressPercent(toUgx(80_000), toUgx(50_000))).toBe(100);
  });

  it('floors rather than rounds, so 99% never reads as met', () => {
    expect(contributionProgressPercent(toUgx(49_999), toUgx(50_000))).toBe(99);
  });

  it('answers zero when the minimum is undecided or zero, rather than dividing by it', () => {
    expect(contributionProgressPercent(toUgx(20_000), toUgx(0))).toBe(0);
  });

  it('reports the shortfall, and zero once the month is met', () => {
    expect(monthlyShortfall(toUgx(20_000), toUgx(50_000))).toBe(30_000);
    expect(monthlyShortfall(toUgx(50_000), toUgx(50_000))).toBe(0);
    expect(monthlyShortfall(toUgx(80_000), toUgx(50_000))).toBe(0);
  });
});

describe('consecutive months', () => {
  it('knows which months follow which, across a year boundary', () => {
    expect(isNextMonth('2026-01-01', '2026-02-01')).toBe(true);
    expect(isNextMonth('2026-12-01', '2027-01-01')).toBe(true);
    expect(isNextMonth('2026-01-01', '2026-03-01')).toBe(false);
    expect(isNextMonth('2026-02-01', '2026-01-01')).toBe(false);
    expect(isNextMonth('2026-01-01', '2026-01-01')).toBe(false);
  });

  it('counts the longest unbroken run', () => {
    expect(longestConsecutiveRun([])).toBe(0);
    expect(longestConsecutiveRun(['2026-05-01'])).toBe(1);

    expect(
      longestConsecutiveRun([
        '2026-01-01',
        '2026-02-01',
        '2026-03-01',
        '2026-04-01',
        '2026-05-01',
        '2026-06-01',
      ]),
    ).toBe(6);
  });

  it('breaks the run on a month that fell short, rather than skipping it', () => {
    // The whole difference the consecutive rule makes. Six qualifying months
    // with a gap in the middle is six months and a longest run of three.
    expect(
      longestConsecutiveRun([
        '2026-01-01',
        '2026-02-01',
        '2026-03-01',
        '2026-05-01',
        '2026-06-01',
        '2026-07-01',
      ]),
    ).toBe(3);
  });

  it('does not depend on the order it is given the months in', () => {
    expect(longestConsecutiveRun(['2026-03-01', '2026-01-01', '2026-02-01'])).toBe(3);
  });
});

describe('qualification', () => {
  const sixInARow = [
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
    '2026-04-01',
    '2026-05-01',
    '2026-06-01',
  ];
  const sixWithAGap = [
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
    '2026-05-01',
    '2026-06-01',
    '2026-07-01',
  ];

  it('qualifies six months in a row under either arm of the rule', () => {
    expect(
      qualificationOutcome({
        qualifyingMonths: sixInARow,
        monthsRequired: 6,
        mustBeConsecutive: false,
      }),
    ).toEqual({ qualifies: true, blockedReason: null });

    expect(
      qualificationOutcome({
        qualifyingMonths: sixInARow,
        monthsRequired: 6,
        mustBeConsecutive: true,
      }),
    ).toEqual({ qualifies: true, blockedReason: null });
  });

  it('separates the two arms on a history with a gap', () => {
    expect(
      qualificationOutcome({
        qualifyingMonths: sixWithAGap,
        monthsRequired: 6,
        mustBeConsecutive: false,
      }).qualifies,
    ).toBe(true);

    const strict = qualificationOutcome({
      qualifyingMonths: sixWithAGap,
      monthsRequired: 6,
      mustBeConsecutive: true,
    });

    expect(strict.qualifies).toBe(false);
    // The same sentence `member_savings_qualification` produces, so a member
    // is told the same thing whichever surface answers them.
    expect(strict.blockedReason).toBe(
      'The longest unbroken run of qualifying months is 3 of the 6 required.',
    );
  });

  it('counts short of six under the lenient arm, and says how far', () => {
    const outcome = qualificationOutcome({
      qualifyingMonths: sixInARow.slice(0, 4),
      monthsRequired: 6,
      mustBeConsecutive: false,
    });

    expect(outcome.qualifies).toBe(false);
    expect(outcome.blockedReason).toBe('4 of the 6 qualifying months have been saved.');
  });

  it('refuses to show anybody as qualified while the rule is undecided', () => {
    // Not the lenient reading, and not the strict one. A member shown as
    // qualified under a rule nobody approved is a loan approved on a guess.
    const outcome = qualificationOutcome({
      qualifyingMonths: sixInARow,
      monthsRequired: 6,
      mustBeConsecutive: null,
    });

    expect(outcome.qualifies).toBe(false);
    expect(outcome.blockedReason).toMatch(/has not been decided/i);
  });
});

describe('cards', () => {
  it('names the five reasons, and offers four of them for a reissue', () => {
    expect([...MEMBERSHIP_CARD_REASONS]).toEqual([
      'first_issue',
      'lost',
      'damaged',
      'name_change',
      'expired',
    ]);
    expect(CARD_REISSUE_REASONS).not.toContain('first_issue');
    expect(Object.keys(MEMBERSHIP_CARD_REASON_LABELS).sort()).toEqual(
      [...MEMBERSHIP_CARD_REASONS].sort(),
    );
    expect(isMembershipCardReason('lost')).toBe(true);
    expect(isMembershipCardReason('stolen')).toBe(false);
  });

  it('accepts a verification code of the right shape and nothing else', () => {
    expect(isCardVerificationCode('ABCDEFGHJKLM')).toBe(true);
    expect(isCardVerificationCode('23456789ABCD')).toBe(true);

    // Too short, too long, lower case.
    expect(isCardVerificationCode('ABCDEFGHJKL')).toBe(false);
    expect(isCardVerificationCode('ABCDEFGHJKLMN')).toBe(false);
    expect(isCardVerificationCode('abcdefghjklm')).toBe(false);
  });

  it('excludes the four characters that are misread over a phone', () => {
    // I/1 and O/0 are the pairs somebody reading a card aloud gets wrong, so
    // the alphabet leaves all four out. A code containing one is not a code
    // this system minted.
    for (const forbidden of ['I', 'O', '0', '1']) {
      expect(
        CARD_VERIFICATION_CODE_PATTERN.test(`${forbidden}BCDEFGHJKLM`),
        `${forbidden} should not be in the alphabet`,
      ).toBe(false);
    }
  });
});

describe('reference number shapes', () => {
  it('matches what the database actually mints', () => {
    // Prefix, two-digit business year, padded sequence. The samples are the
    // shapes `next_reference` produced against a real database.
    expect(SAVINGS_ACCOUNT_NUMBER_PATTERN.test('SA260040')).toBe(true);
    expect(SAVINGS_TRANSACTION_NUMBER_PATTERN.test('SV2600065')).toBe(true);
    expect(WITHDRAWAL_REQUEST_NUMBER_PATTERN.test('WD2600001')).toBe(true);
    expect(MEMBERSHIP_FEE_RECEIPT_NUMBER_PATTERN.test('MF260001')).toBe(true);
    expect(MEMBERSHIP_CARD_NUMBER_PATTERN.test('MC260005')).toBe(true);
  });

  it('still matches once a sequence has overflowed its padding', () => {
    // `formatReference` lets the sequence run past its padding rather than
    // wrapping, so a business in its hundred-thousandth transaction still has
    // valid numbers.
    expect(SAVINGS_TRANSACTION_NUMBER_PATTERN.test('SV26123456')).toBe(true);
    expect(SAVINGS_ACCOUNT_NUMBER_PATTERN.test('SA2612345')).toBe(true);
  });

  it('refuses the wrong prefix and a missing year', () => {
    expect(SAVINGS_ACCOUNT_NUMBER_PATTERN.test('SV260040')).toBe(false);
    expect(SAVINGS_TRANSACTION_NUMBER_PATTERN.test('SV00065')).toBe(false);
    expect(MEMBERSHIP_CARD_NUMBER_PATTERN.test('MC0005')).toBe(false);
  });
});
