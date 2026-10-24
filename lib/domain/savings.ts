/**
 * The savings domain: the vocabulary, the contribution arithmetic, and the
 * rules that are pure enough to state in TypeScript.
 *
 * ## Savings are money the business owes, not money it earned
 *
 * This is the one fact worth stating at the top of the file, because getting
 * it wrong is invisible and then catastrophic. A deposit increases a
 * **liability**: the business holds the member's money and will give it back.
 * It is not a sale, it must not reach a profit figure, and `post_savings_deposit`
 * credits `2100 Member Savings` for exactly that reason. Crediting an income
 * account instead would overstate the year's surplus by the whole savings book
 * and, in Phase 5, pay a profit share out of members' own deposits — a mistake
 * nobody would notice until the money could not be returned.
 *
 * Nothing in this module computes a balance that anything relies on. The
 * balance is `sum(signed_amount)` over `savings_transactions`, read from
 * `member_savings_balances`, and `signed_amount` is a generated column so the
 * direction of a movement is not a field anybody sets. What is here is the
 * arithmetic a *screen* needs — a progress bar, a shortfall, a month's label —
 * and a second opinion on the qualification the database already computed.
 *
 * ## The values live in the policy, not here
 *
 * The monthly minimum (UGX 50,000 today), the registration fee (UGX 5,000) and
 * the qualifying period (six months) are columns on
 * `public.membership_policy_versions`, effective-dated, and a savings account
 * references the version its membership was enrolled under. They are
 * deliberately not constants in this file: a constant cannot be
 * effective-dated, and a member who joined in March keeps March's terms when
 * the business changes them in June. Every function below that needs one takes
 * it as an argument.
 *
 * ## Two rules are the client's and are not invented here
 *
 * Whether the qualifying months must run consecutively, and whether savings may
 * be withdrawn while a loan is live, are both undecided. Savings do not open at
 * all until they are answered — through the Phase 1 activity-specific readiness
 * gate, which lets ordinary enrolment carry on meanwhile — so by the time there
 * is a contribution history to judge, the rules exist. Both arms of each are
 * implemented; neither has a default.
 *
 * See docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md.
 */

import { UGX_ZERO, type UgxAmount, toUgx } from './money';

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/**
 * Savings account statuses.
 *
 *   - `active`  — takes deposits, allows withdrawals.
 *   - `dormant` — nothing has moved for a long time. Still takes deposits;
 *                 this is a reporting state, not a restriction.
 *   - `closed`  — terminal. The account holds financial history, so it is
 *                 closed and never deleted.
 *
 * Mirrors the `savings_account_status_valid` CHECK constraint.
 */
export const SAVINGS_ACCOUNT_STATUSES = ['active', 'dormant', 'closed'] as const;

export type SavingsAccountStatus = (typeof SAVINGS_ACCOUNT_STATUSES)[number];

export function isSavingsAccountStatus(value: unknown): value is SavingsAccountStatus {
  return (
    typeof value === 'string' &&
    (SAVINGS_ACCOUNT_STATUSES as readonly string[]).includes(value)
  );
}

export const SAVINGS_ACCOUNT_STATUS_LABELS: Readonly<
  Record<SavingsAccountStatus, string>
> = {
  active: 'Active',
  dormant: 'Dormant',
  closed: 'Closed',
};

export const SAVINGS_ACCOUNT_STATUS_DESCRIPTIONS: Readonly<
  Record<SavingsAccountStatus, string>
> = {
  active: 'Takes deposits and allows withdrawals.',
  dormant: 'Nothing has moved for a long time. Deposits are still accepted.',
  closed: 'Closed for good. The history stays.',
};

/** Only an active account may be withdrawn from. */
export function allowsWithdrawal(status: SavingsAccountStatus): boolean {
  return status === 'active';
}

/** A closed account takes nothing further. */
export function allowsDeposit(status: SavingsAccountStatus): boolean {
  return status !== 'closed';
}

// ---------------------------------------------------------------------------
// The subledger
// ---------------------------------------------------------------------------

/**
 * The four kinds of savings transaction.
 *
 * There are four rather than two because **a reversal is a row, not a status**.
 * Marking the original `reversed` would mean the record of what happened
 * changes after the fact, and a statement printed last week would no longer
 * agree with one printed today. Instead a contra row is appended, with its own
 * contra journal entry, and the original is untouched for good.
 *
 * Mirrors the `savings_transaction_kind_valid` CHECK constraint.
 */
export const SAVINGS_TRANSACTION_KINDS = [
  'deposit',
  'withdrawal',
  'deposit_reversal',
  'withdrawal_reversal',
] as const;

export type SavingsTransactionKind = (typeof SAVINGS_TRANSACTION_KINDS)[number];

export function isSavingsTransactionKind(
  value: unknown,
): value is SavingsTransactionKind {
  return (
    typeof value === 'string' &&
    (SAVINGS_TRANSACTION_KINDS as readonly string[]).includes(value)
  );
}

export const SAVINGS_TRANSACTION_KIND_LABELS: Readonly<
  Record<SavingsTransactionKind, string>
> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  deposit_reversal: 'Deposit reversed',
  withdrawal_reversal: 'Withdrawal reversed',
};

/** The two kinds a caller can ask for. The other two are written by a reversal. */
export const POSTABLE_SAVINGS_KINDS: readonly SavingsTransactionKind[] = [
  'deposit',
  'withdrawal',
];

/** Whether this kind of row is itself a reversal of another. */
export function isReversalKind(kind: SavingsTransactionKind): boolean {
  return kind === 'deposit_reversal' || kind === 'withdrawal_reversal';
}

/**
 * The sign a kind carries in the balance.
 *
 * This mirrors the `signed_amount` generated column, and it is here so a
 * component can render a statement row without a second trip. The column is
 * the authority: a disagreement between the two is a bug in this function, and
 * `tests/db/savings.test.ts` asserts the column's values directly.
 */
export function savingsSignOf(kind: SavingsTransactionKind): 1 | -1 {
  return kind === 'deposit' || kind === 'withdrawal_reversal' ? 1 : -1;
}

/** The signed effect of a movement on the balance. */
export function signedSavingsAmount(
  kind: SavingsTransactionKind,
  amount: UgxAmount,
): UgxAmount {
  return toUgx(savingsSignOf(kind) * amount);
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

/**
 * The withdrawal lifecycle.
 *
 * `pending -> approved | rejected | cancelled`, then `approved -> paid |
 * cancelled`. Nothing moves backwards, and `rejected` and `paid` are final.
 *
 * The lifecycle exists because taking money out is three acts by (at least)
 * two people: preparing the request, deciding it, and handing over the cash.
 * `decide_savings_withdrawal` refuses a decision from whoever prepared it, so
 * the split holds even for a Manager who holds both capabilities.
 *
 * Mirrors the `savings_withdrawal_status_valid` CHECK constraint.
 */
export const WITHDRAWAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paid',
  'cancelled',
] as const;

export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export function isWithdrawalStatus(value: unknown): value is WithdrawalStatus {
  return (
    typeof value === 'string' &&
    (WITHDRAWAL_STATUSES as readonly string[]).includes(value)
  );
}

export const WITHDRAWAL_STATUS_LABELS: Readonly<Record<WithdrawalStatus, string>> = {
  pending: 'Awaiting a decision',
  approved: 'Approved, not yet paid',
  rejected: 'Rejected',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

/** A request that still occupies the account: an account has one of these at a time. */
export const LIVE_WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  'pending',
  'approved',
];

export function isLiveWithdrawal(status: WithdrawalStatus): boolean {
  return LIVE_WITHDRAWAL_STATUSES.includes(status);
}

export const WITHDRAWAL_TRANSITIONS: Readonly<
  Record<WithdrawalStatus, readonly WithdrawalStatus[]>
> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['paid', 'cancelled'],
  rejected: [],
  paid: [],
  cancelled: [],
};

export function canTransitionWithdrawal(
  from: WithdrawalStatus,
  to: WithdrawalStatus,
): boolean {
  return WITHDRAWAL_TRANSITIONS[from].includes(to);
}

/**
 * Why a withdrawal cannot be prepared right now, or `null` if it can.
 *
 * Every refusal here is also enforced by `request_savings_withdrawal`, which
 * is where it counts. This exists so a screen can disable the button and say
 * why, rather than letting somebody fill in a form that was never going to be
 * accepted.
 *
 * The `above_pledged` arm deliberately refuses rather than computing a figure.
 * "The excess over what secures the loan" needs a definition of the pledged
 * amount that the client's documents do not give, and which depends on the
 * savings-to-loan multiplier that is itself undecided. Inventing one here would
 * be inventing the member's security.
 */
export function withdrawalBlockedReason(input: {
  readonly accountStatus: SavingsAccountStatus;
  readonly membershipIsActive: boolean;
  readonly balance: UgxAmount;
  readonly hasLiveWithdrawal: boolean;
  readonly hasLiveLoan: boolean;
  /** `null` while the client has not decided. */
  readonly withdrawalRule: SavingsWithdrawalRuleValue | null;
}): string | null {
  if (!allowsWithdrawal(input.accountStatus)) {
    return `This savings account is ${SAVINGS_ACCOUNT_STATUS_LABELS[
      input.accountStatus
    ].toLowerCase()}. A withdrawal needs an active account.`;
  }

  if (!input.membershipIsActive) {
    return 'A withdrawal needs an active membership.';
  }

  if (input.hasLiveWithdrawal) {
    return 'This account already has a withdrawal awaiting a decision or awaiting payment.';
  }

  if (input.balance <= 0) {
    return 'There is nothing in this account to withdraw.';
  }

  if (input.hasLiveLoan) {
    if (input.withdrawalRule === null) {
      return 'Whether savings may be withdrawn while a loan is running has not been decided. The rule has to be approved before this can be answered.';
    }
    if (input.withdrawalRule === 'blocked') {
      return 'This member holds a live loan, and the membership policy blocks withdrawals while a loan is running.';
    }
    if (input.withdrawalRule === 'above_pledged') {
      return 'The membership policy allows withdrawing only the excess over what secures a live loan, and how much that is has not been defined. Settle the savings-to-loan rule before withdrawing against a live loan.';
    }
  }

  return null;
}

/** The policy's answer to "may savings be withdrawn against a live loan?" */
export type SavingsWithdrawalRuleValue = 'allowed' | 'blocked' | 'above_pledged';

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * How a member's acceptance of the membership terms was taken.
 *
 * Phase 1 recorded a typed signature name and a typed witness name, and its own
 * migration header said what that was worth: *a typed name is not consent*.
 * Anybody with the form could type anybody's name. Phase 2 replaced it with
 * four methods the database can actually check, and
 * `membership_terms_acceptances_guard` sets `verification_status` itself from
 * the evidence — so a caller states the *method*, never the verdict.
 *
 *   - `member_portal`       the member confirmed in their own signed-in
 *                           session. The guard checks the session is theirs.
 *   - `one_time_code`       a code sent to the number already on their client
 *                           record — not one typed into the form, because a
 *                           code sent to a number a staff member chose proves
 *                           nothing about who received it. Only the digest is
 *                           ever stored.
 *   - `signature_document`  an uploaded signature. The guard checks the object
 *                           really exists, under this membership's own path.
 *   - `witnessed_in_branch` a member of staff witnessed it. The guard checks
 *                           they are an active profile and not the person
 *                           recording it.
 *
 * `legacy_typed_name` is the fifth value and is **not** offered: it exists so
 * the Phase 1 rows that already carry a typed name can be labelled honestly as
 * `unverified`, rather than being quietly backfilled into looking verified.
 *
 * Mirrors the `membership_terms_consent_method_valid` CHECK constraint.
 */
export const CONSENT_METHODS = [
  'member_portal',
  'one_time_code',
  'signature_document',
  'witnessed_in_branch',
  'legacy_typed_name',
] as const;

export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export function isConsentMethod(value: unknown): value is ConsentMethod {
  return (
    typeof value === 'string' && (CONSENT_METHODS as readonly string[]).includes(value)
  );
}

/** The four a staff member may actually choose. */
export const OFFERABLE_CONSENT_METHODS: readonly ConsentMethod[] = [
  'witnessed_in_branch',
  'one_time_code',
  'signature_document',
  'member_portal',
];

export const CONSENT_METHOD_LABELS: Readonly<Record<ConsentMethod, string>> = {
  member_portal: 'Confirmed by the member in their own portal',
  one_time_code: 'One-time code sent to the member’s phone',
  signature_document: 'Signed document, uploaded',
  witnessed_in_branch: 'Witnessed in the branch by a member of staff',
  legacy_typed_name: 'Typed name (recorded before consent evidence was required)',
};

export const CONSENT_METHOD_DESCRIPTIONS: Readonly<Record<ConsentMethod, string>> = {
  member_portal:
    'The member signs in and confirms the terms themselves. The strongest evidence available, because nobody else can be in their session.',
  one_time_code:
    'A code is sent to the number already on the member’s client record. They read it back; the system never stores the code itself, only a digest of it.',
  signature_document:
    'A photograph or scan of the signed terms is uploaded against this membership. The file has to be there before the acceptance can be recorded.',
  witnessed_in_branch:
    'A member of staff attests that the member accepted the terms in front of them. It cannot be the same person recording it.',
  legacy_typed_name:
    'Not available for new acceptances. It marks a record taken before verifiable consent was required, and it never counts as verified.',
};

/** What the staff member has to supply alongside each method. */
export const CONSENT_METHOD_REQUIREMENTS: Readonly<
  Record<ConsentMethod, readonly ('signaturePath' | 'witnessProfileId' | 'challengeId')[]>
> = {
  member_portal: [],
  one_time_code: ['challengeId'],
  signature_document: ['signaturePath'],
  witnessed_in_branch: ['witnessProfileId'],
  legacy_typed_name: [],
};

/**
 * Verification statuses.
 *
 * Set by the database, never by a caller. `unverified` is what a Phase 1 typed
 * name is, and it does not satisfy the activation precondition — so those
 * memberships stay exactly as they are until somebody takes real consent.
 *
 * Mirrors the `membership_terms_verification_status_valid` CHECK constraint.
 */
export const CONSENT_VERIFICATION_STATUSES = [
  'unverified',
  'verified',
  'rejected',
] as const;

export type ConsentVerificationStatus = (typeof CONSENT_VERIFICATION_STATUSES)[number];

export const CONSENT_VERIFICATION_STATUS_LABELS: Readonly<
  Record<ConsentVerificationStatus, string>
> = {
  unverified: 'Not verified',
  verified: 'Verified',
  rejected: 'Rejected',
};

/** Only a verified acceptance satisfies the ADR-050 activation precondition. */
export function consentSatisfiesActivation(status: ConsentVerificationStatus): boolean {
  return status === 'verified';
}

// ---------------------------------------------------------------------------
// The registration fee receipt
// ---------------------------------------------------------------------------

export const MEMBERSHIP_FEE_STATUSES = ['posted', 'reversed'] as const;
export type MembershipFeeStatus = (typeof MEMBERSHIP_FEE_STATUSES)[number];

export const MEMBERSHIP_FEE_STATUS_LABELS: Readonly<Record<MembershipFeeStatus, string>> =
  {
    posted: 'Posted',
    reversed: 'Reversed',
  };

// ---------------------------------------------------------------------------
// Membership cards
// ---------------------------------------------------------------------------

export const MEMBERSHIP_CARD_STATUSES = ['active', 'superseded', 'cancelled'] as const;
export type MembershipCardStatus = (typeof MEMBERSHIP_CARD_STATUSES)[number];

export const MEMBERSHIP_CARD_STATUS_LABELS: Readonly<
  Record<MembershipCardStatus, string>
> = {
  active: 'Current',
  superseded: 'Replaced',
  cancelled: 'Cancelled',
};

/**
 * Why a card is being issued.
 *
 * `first_issue` is refused when the membership already has a live card, and
 * every other reason is refused when it does not — so the reason cannot be a
 * free-text note that quietly produces two current cards.
 *
 * Mirrors the `membership_card_reason_valid` CHECK constraint.
 */
export const MEMBERSHIP_CARD_REASONS = [
  'first_issue',
  'lost',
  'damaged',
  'name_change',
  'expired',
] as const;

export type MembershipCardReason = (typeof MEMBERSHIP_CARD_REASONS)[number];

export function isMembershipCardReason(value: unknown): value is MembershipCardReason {
  return (
    typeof value === 'string' &&
    (MEMBERSHIP_CARD_REASONS as readonly string[]).includes(value)
  );
}

export const MEMBERSHIP_CARD_REASON_LABELS: Readonly<
  Record<MembershipCardReason, string>
> = {
  first_issue: 'First card',
  lost: 'Replacing a lost card',
  damaged: 'Replacing a damaged card',
  name_change: 'Name changed',
  expired: 'Replacing an expired card',
};

/** The reasons offered when the membership already holds a card. */
export const CARD_REISSUE_REASONS: readonly MembershipCardReason[] = [
  'lost',
  'damaged',
  'name_change',
  'expired',
];

// ---------------------------------------------------------------------------
// Contributions and qualification
// ---------------------------------------------------------------------------

/**
 * One calendar month of contributions, as `member_savings_contributions`
 * reports it.
 *
 * `contributed` is net of reversals **attributed back to the month of the
 * deposit they correct**, not the month the correction was made. A deposit
 * posted in March in error and reversed in July stops counting for March; it
 * does not make July negative.
 */
export interface ContributionMonth {
  /** The first day of the month, in the business timezone. */
  readonly month: string;
  readonly contributed: UgxAmount;
  readonly depositCount: number;
  readonly meetsMinimum: boolean;
  readonly shortfall: UgxAmount;
}

/**
 * How far through the month a member is, for a progress bar.
 *
 * Capped at 100: a member who saved UGX 80,000 against a UGX 50,000 minimum has
 * met it, and a bar that read 160% would invite the reading that they have
 * banked three months. They have not — the qualification engine counts months,
 * not shillings, which is the whole point of a monthly minimum.
 */
export function contributionProgressPercent(
  contributed: UgxAmount,
  monthlyMinimum: UgxAmount,
): number {
  if (monthlyMinimum <= 0) return 0;
  return Math.min(100, Math.floor((contributed / monthlyMinimum) * 100));
}

/** What is still needed this month, or zero. */
export function monthlyShortfall(
  contributed: UgxAmount,
  monthlyMinimum: UgxAmount,
): UgxAmount {
  const remaining = monthlyMinimum - contributed;
  return remaining > 0 ? toUgx(remaining) : UGX_ZERO;
}

/**
 * The longest unbroken run of qualifying months, in months.
 *
 * Takes the qualifying months in ascending order and counts the longest run of
 * calendar-consecutive ones. A month that fell short is not merely skipped: it
 * **breaks** the run, which is the entire difference the consecutive rule
 * makes.
 *
 * This mirrors `member_savings_qualification`, which is the authority — it runs
 * against the subledger with an "as of" date and a row lock. This version is
 * for a screen that already has the months in hand, and
 * `tests/unit/savings.test.ts` checks the two agree on the cases that matter.
 */
export function longestConsecutiveRun(qualifyingMonths: readonly string[]): number {
  const sorted = [...qualifyingMonths].sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;

  for (const month of sorted) {
    run = previous !== null && isNextMonth(previous, month) ? run + 1 : 1;
    previous = month;
    if (run > best) best = run;
  }

  return best;
}

/** Whether `later` is the calendar month immediately after `earlier`. */
export function isNextMonth(earlier: string, later: string): boolean {
  const a = parseMonth(earlier);
  const b = parseMonth(later);
  if (a === null || b === null) return false;
  return (b.year - a.year) * 12 + (b.month - a.month) === 1;
}

function parseMonth(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})/.exec(value);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

/**
 * Whether a member qualifies, and why not when they do not.
 *
 * A second opinion, deliberately. `member_savings_qualification` is what Phase
 * 3 will approve loans against, because it is the one that can take an "as of"
 * date and read the subledger under a lock. This is what a screen shows while
 * the member is standing at the counter, and it says the same thing for the
 * same reasons — including refusing to answer at all while the consecutive rule
 * is undecided, rather than guessing the lenient reading.
 */
export function qualificationOutcome(input: {
  readonly qualifyingMonths: readonly string[];
  readonly monthsRequired: number;
  /** `null` while the client has not decided. */
  readonly mustBeConsecutive: boolean | null;
}): { readonly qualifies: boolean; readonly blockedReason: string | null } {
  if (input.mustBeConsecutive === null) {
    return {
      qualifies: false,
      blockedReason:
        'Whether the qualifying months must be consecutive has not been decided, so nobody can be shown as qualified.',
    };
  }

  if (input.mustBeConsecutive) {
    const best = longestConsecutiveRun(input.qualifyingMonths);
    return best >= input.monthsRequired
      ? { qualifies: true, blockedReason: null }
      : {
          qualifies: false,
          blockedReason: `The longest unbroken run of qualifying months is ${best} of the ${input.monthsRequired} required.`,
        };
  }

  const count = input.qualifyingMonths.length;
  return count >= input.monthsRequired
    ? { qualifies: true, blockedReason: null }
    : {
        qualifies: false,
        blockedReason: `${count} of the ${input.monthsRequired} qualifying months have been saved.`,
      };
}

// ---------------------------------------------------------------------------
// Reference numbers
// ---------------------------------------------------------------------------

// Each is the prefix, the two-digit business year and the padded sequence, so
// the minimum digit count is the padding plus two. Stated as `{n,}` rather than
// `{n}` because the sequence overflows its padding rather than wrapping — see
// `formatReference` — and a number that has run past it is still valid.
export const SAVINGS_ACCOUNT_NUMBER_PATTERN = /^SA\d{6,}$/;
export const SAVINGS_TRANSACTION_NUMBER_PATTERN = /^SV\d{7,}$/;
export const WITHDRAWAL_REQUEST_NUMBER_PATTERN = /^WD\d{7,}$/;
export const MEMBERSHIP_FEE_RECEIPT_NUMBER_PATTERN = /^MF\d{6,}$/;
export const MEMBERSHIP_CARD_NUMBER_PATTERN = /^MC\d{6,}$/;

/**
 * A card's verification code.
 *
 * Twelve characters from a 32-symbol alphabet that excludes I, O, 0 and 1, so a
 * code read off a card over the phone cannot be mistyped into a different valid
 * one. It is opaque and random: it is not a token, not a key, and not derived
 * from any identifier, so a QR code encoding it tells a stranger nothing.
 */
export const CARD_VERIFICATION_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/;

export function isCardVerificationCode(value: unknown): value is string {
  return typeof value === 'string' && CARD_VERIFICATION_CODE_PATTERN.test(value);
}
