/**
 * The membership domain: the lifecycle, the policy vocabulary, and the rules
 * that are pure enough to state in TypeScript.
 *
 * ## Membership is a fact about a client, not an identity
 *
 * There is one identity table for the people this business deals with, and it
 * is `clients`. A member is a client with a membership; a non-member is a
 * client without one, and remains a perfectly valid client. Nothing in this
 * module carries a name, a phone number or a National Identification Number
 * — all of those belong to the client record, behind the policies written for
 * them.
 *
 * Membership is also **not a role**. The four roles say what a person may do
 * to the system; membership says what the business owes a customer. A
 * `member` role would mean a borrower whose savings lapse loses their portal
 * login, which is nonsense.
 *
 * ## Where the rules actually live
 *
 * The *values* — the registration fee, the savings minimum, the qualification
 * period, the benefit amounts — are rows in
 * `public.membership_policy_versions`, effective-dated, and a membership
 * references the version it was enrolled under. They are deliberately not
 * constants here: a constant cannot be effective-dated, and a member enrolled
 * in March must keep March's terms when the business changes them in June.
 *
 * What *is* here is the vocabulary those rows are constrained to, the
 * lifecycle the database enforces, and the labels the interface renders —
 * each mirrored by a `CHECK` constraint, with a database test asserting the
 * two representations agree.
 *
 * ## Eight rules are undecided, and stay that way
 *
 * The client has not answered eight questions — whether the advertised 5% is
 * per month or per loan, whether interest is flat or reducing, the
 * savings-to-loan multiplier, whether six qualifying months must be
 * consecutive, whether savings may be withdrawn against a live loan, the
 * profit distribution formula, the medical benefit's cap and claim frequency,
 * and any benefit waiting period. Every one of them is modelled as a nullable
 * field whose `null` means *undecided*, never as a default somebody invented.
 * `isPolicyFinanciallyEnabled` is the single gate that later phases consult,
 * and it is false while any of them is outstanding.
 *
 * See docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md.
 */

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/**
 * Membership statuses.
 *
 *   - `pending`   — an application has been taken. Nothing paid, nothing
 *                   promised.
 *   - `active`    — a member in good standing. Savings accrue, benefits
 *                   apply.
 *   - `suspended` — restricted by a decision of the business, with a reason.
 *                   Still a member; still in the history.
 *   - `withdrawn` — the member left, or the business ended it. Terminal.
 *   - `deceased`  — terminal, and distinct from `withdrawn` because it is the
 *                   state in which the bereavement benefit becomes payable to
 *                   the registered next of kin. Collapsing the two would make
 *                   that benefit unanswerable from the record.
 *
 * Mirrors the `memberships_status_valid` CHECK constraint.
 */
export const MEMBERSHIP_STATUSES = [
  'pending',
  'active',
  'suspended',
  'withdrawn',
  'deceased',
] as const;

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return (
    typeof value === 'string' &&
    (MEMBERSHIP_STATUSES as readonly string[]).includes(value)
  );
}

export const MEMBERSHIP_STATUS_LABELS: Readonly<Record<MembershipStatus, string>> = {
  pending: 'Pending',
  active: 'Active',
  suspended: 'Suspended',
  withdrawn: 'Withdrawn',
  deceased: 'Deceased',
} as const;

export const MEMBERSHIP_STATUS_DESCRIPTIONS: Readonly<Record<MembershipStatus, string>> =
  {
    pending:
      'An application has been taken. The registration fee and the signed terms are what complete it.',
    active: 'A member in good standing. Savings accrue and benefits apply.',
    suspended:
      'Membership is restricted by a decision of the business. The reason is recorded.',
    withdrawn: 'The membership has ended. A new application starts a new membership.',
    deceased:
      'The member has died. The bereavement benefit becomes payable to the registered next of kin.',
  } as const;

/**
 * Statuses in which a client is occupying their one membership slot.
 *
 * Mirrors the partial unique index `memberships_one_live_per_client`. A client
 * who withdrew and later rejoins keeps both rows, which is why the index is
 * partial rather than a unique constraint on `client_id`.
 */
export const LIVE_MEMBERSHIP_STATUSES: readonly MembershipStatus[] = [
  'pending',
  'active',
  'suspended',
];

/** Statuses from which nothing follows. */
export const TERMINAL_MEMBERSHIP_STATUSES: readonly MembershipStatus[] = [
  'withdrawn',
  'deceased',
];

/** Does this status occupy the client's single live membership slot? */
export function isLiveMembershipStatus(status: MembershipStatus): boolean {
  return LIVE_MEMBERSHIP_STATUSES.includes(status);
}

export function isTerminalMembershipStatus(status: MembershipStatus): boolean {
  return TERMINAL_MEMBERSHIP_STATUSES.includes(status);
}

/**
 * Statuses that may not be entered without a stated reason.
 *
 * `deceased` is deliberately absent: the reason is the status. Mirrors
 * `memberships_restricted_status_has_reason`.
 */
export const MEMBERSHIP_STATUSES_REQUIRING_REASON: readonly MembershipStatus[] = [
  'suspended',
  'withdrawn',
];

export function membershipStatusRequiresReason(status: MembershipStatus): boolean {
  return MEMBERSHIP_STATUSES_REQUIRING_REASON.includes(status);
}

/**
 * Valid transitions, mirroring `memberships_guard_transition`.
 *
 * Reactivating a withdrawn membership is deliberately not one. It is a new
 * enrolment, which mints a new number and a new row — because the savings
 * qualification clock and the benefit waiting period both restart, and a
 * reused row could not express that.
 */
export const MEMBERSHIP_TRANSITIONS: Readonly<
  Record<MembershipStatus, readonly MembershipStatus[]>
> = {
  pending: ['active', 'withdrawn', 'deceased'],
  active: ['suspended', 'withdrawn', 'deceased'],
  suspended: ['active', 'withdrawn', 'deceased'],
  withdrawn: [],
  deceased: [],
} as const;

export function canTransitionMembership(
  from: MembershipStatus,
  to: MembershipStatus,
): boolean {
  return MEMBERSHIP_TRANSITIONS[from].includes(to);
}

/** Every status a membership in `from` may be moved to. */
export function membershipTransitionsFrom(
  from: MembershipStatus,
): readonly MembershipStatus[] {
  return MEMBERSHIP_TRANSITIONS[from];
}

/**
 * The capability a transition requires.
 *
 * One capability for every transition, which is what the column guard
 * enforces. Stated as a function rather than a constant so that Polytos
 * Phase 2 — which adds the registration-fee precondition on activation — has
 * one place to narrow it.
 */
export const MEMBERSHIP_STATUS_CAPABILITY = 'membership:manage_status' as const;

/**
 * What a transition needs beyond the capability, in the words a form would
 * use.
 *
 * Returns the empty list where the database asks for nothing further. The
 * dates each transition stamps are supplied by the database, never by the
 * caller, so they never appear here.
 */
export function membershipTransitionRequirements(
  to: MembershipStatus,
): readonly string[] {
  return membershipStatusRequiresReason(to) ? ['A reason, which is recorded.'] : [];
}

// ---------------------------------------------------------------------------
// The policy vocabulary
// ---------------------------------------------------------------------------

/** Lifecycle of a membership policy version. */
export const MEMBERSHIP_POLICY_STATUSES = ['draft', 'active', 'superseded'] as const;
export type MembershipPolicyStatus = (typeof MEMBERSHIP_POLICY_STATUSES)[number];

export function isMembershipPolicyStatus(
  value: unknown,
): value is MembershipPolicyStatus {
  return (
    typeof value === 'string' &&
    (MEMBERSHIP_POLICY_STATUSES as readonly string[]).includes(value)
  );
}

export const MEMBERSHIP_POLICY_STATUS_LABELS: Readonly<
  Record<MembershipPolicyStatus, string>
> = {
  draft: 'Draft',
  active: 'In force',
  superseded: 'Superseded',
} as const;

/** Whether the advertised member rate is charged per month or once per loan. */
export const MEMBER_INTEREST_BASES = ['per_month', 'per_loan'] as const;
export type MemberInterestBasis = (typeof MEMBER_INTEREST_BASES)[number];

export const MEMBER_INTEREST_BASIS_LABELS: Readonly<Record<MemberInterestBasis, string>> =
  {
    per_month: 'Per month',
    per_loan: 'Once per loan',
  } as const;

/** How interest is computed on a member loan. */
export const MEMBER_INTEREST_METHODS = ['flat', 'reducing_balance_monthly'] as const;
export type MemberInterestMethod = (typeof MEMBER_INTEREST_METHODS)[number];

export const MEMBER_INTEREST_METHOD_LABELS: Readonly<
  Record<MemberInterestMethod, string>
> = {
  flat: 'Flat on the original principal',
  reducing_balance_monthly: 'Reducing balance, monthly',
} as const;

/** Whether a member may withdraw savings while holding an active member loan. */
export const SAVINGS_WITHDRAWAL_RULES = ['allowed', 'blocked', 'above_pledged'] as const;
export type SavingsWithdrawalRule = (typeof SAVINGS_WITHDRAWAL_RULES)[number];

export const SAVINGS_WITHDRAWAL_RULE_LABELS: Readonly<
  Record<SavingsWithdrawalRule, string>
> = {
  allowed: 'Allowed',
  blocked: 'Blocked while a member loan is active',
  above_pledged: 'Only the amount above what secures the loan',
} as const;

/** How the year's distributable profit is shared between members. */
export const PROFIT_DISTRIBUTION_BASES = [
  'pro_rata_savings',
  'pro_rata_savings_months',
  'equal_shares',
] as const;
export type ProfitDistributionBasis = (typeof PROFIT_DISTRIBUTION_BASES)[number];

export const PROFIT_DISTRIBUTION_BASIS_LABELS: Readonly<
  Record<ProfitDistributionBasis, string>
> = {
  pro_rata_savings: 'In proportion to savings held',
  pro_rata_savings_months: 'In proportion to savings weighted by months held',
  equal_shares: 'Equal shares between members',
} as const;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The eight rules the client has not decided, in the order they appear on the
 * configuration screen.
 *
 * Exported because three places need the same list and must not drift: the
 * gate below, the read-only configuration screen, and
 * `docs/POLYTOS-MEMBERSHIP-POLICY-DECISIONS.md`, which a test holds to the
 * same count.
 */
export const UNDECIDED_POLICY_RULES = [
  'interestBasis',
  'interestMethod',
  'savingsToLoanMultiplierBps',
  'qualifyingMonthsConsecutive',
  'savingsWithdrawalWithActiveLoan',
  'profitDistributionBasis',
  'medicalBenefitAnnualCap',
  'medicalBenefitClaimsPerYear',
  'benefitWaitingPeriodDays',
] as const;

export type UndecidedPolicyRule = (typeof UNDECIDED_POLICY_RULES)[number];

/** What each outstanding decision is, in the words a person would use. */
export const UNDECIDED_POLICY_RULE_LABELS: Readonly<Record<UndecidedPolicyRule, string>> =
  {
    interestBasis: 'Whether the 5% member rate is charged per month or once per loan',
    interestMethod: 'Whether member loan interest is flat or on a reducing balance',
    savingsToLoanMultiplierBps: 'How much a member may borrow against their savings',
    qualifyingMonthsConsecutive:
      'Whether the six qualifying months of savings must be consecutive',
    savingsWithdrawalWithActiveLoan:
      'Whether savings may be withdrawn while a member loan is active',
    profitDistributionBasis: 'How the year-end profit share is calculated',
    medicalBenefitAnnualCap: 'The most the medical benefit pays one member in a year',
    medicalBenefitClaimsPerYear: 'How many medical claims a member may make in a year',
    benefitWaitingPeriodDays: 'How long after enrolment a benefit may first be claimed',
  } as const;

/** The shape the gate reads. A subset of the full policy version. */
export interface PolicyDecisionState {
  readonly status: MembershipPolicyStatus;
  readonly approvedAt: string | null;
  readonly interestBasis: MemberInterestBasis | null;
  readonly interestMethod: MemberInterestMethod | null;
  readonly savingsToLoanMultiplierBps: number | null;
  readonly qualifyingMonthsConsecutive: boolean | null;
  readonly savingsWithdrawalWithActiveLoan: SavingsWithdrawalRule | null;
  readonly profitDistributionBasis: ProfitDistributionBasis | null;
  readonly medicalBenefitAnnualCap: number | null;
  readonly medicalBenefitClaimsPerYear: number | null;
  readonly benefitWaitingPeriodDays: number | null;
}

/**
 * Which of the eight rules are still outstanding on this version.
 *
 * `false` is a decision; only `null` is an absence. That distinction is the
 * reason this is written out rather than expressed as a falsy check —
 * `qualifyingMonthsConsecutive: false` means the client decided the months
 * need not be consecutive, and treating it as undecided would hold up a
 * programme that is ready to run.
 */
export function outstandingPolicyDecisions(
  policy: PolicyDecisionState,
): readonly UndecidedPolicyRule[] {
  return UNDECIDED_POLICY_RULES.filter((rule) => policy[rule] === null);
}

/**
 * May financial operations run against this policy version?
 *
 * Three conditions, all of them necessary: the version is in force, the
 * business has formally approved it, and every outstanding decision has been
 * made. The database computes the same answer as a stored generated column on
 * `membership_policy_versions`, which is the authoritative one — a generated
 * column cannot be ticked on an incomplete policy, whereas a flag could.
 *
 * This function exists so the interface can explain *why* the answer is no
 * without a second round trip, and a database test asserts the two agree.
 */
export function isPolicyFinanciallyEnabled(policy: PolicyDecisionState): boolean {
  return (
    policy.status === 'active' &&
    policy.approvedAt !== null &&
    outstandingPolicyDecisions(policy).length === 0
  );
}

/**
 * Why a policy cannot yet carry financial operations, as a sentence.
 *
 * Returns `null` when it can. Written here rather than in a component so the
 * register, the configuration screen and any later phase that refuses a
 * posting all give the same reason.
 */
export function policyBlockedReason(policy: PolicyDecisionState): string | null {
  if (policy.status === 'draft') {
    return 'This policy version is a draft. No membership transaction can run against it.';
  }

  if (policy.status === 'superseded') {
    return 'This policy version has been superseded.';
  }

  if (policy.approvedAt === null) {
    return 'This policy version has not been approved. No membership transaction can run against it.';
  }

  const outstanding = outstandingPolicyDecisions(policy);

  if (outstanding.length > 0) {
    const count = outstanding.length;
    return `${String(count)} membership ${count === 1 ? 'rule has' : 'rules have'} not been decided. No membership transaction can run against this version until they are.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The membership number
// ---------------------------------------------------------------------------

/**
 * The shape a membership number takes: `MB` then a two-digit year then at
 * least four digits.
 *
 * Mirrors the `memberships_number_shape` CHECK constraint. The number itself
 * is minted by `public.next_reference('membership')` inside a BEFORE INSERT
 * trigger — never here, because two enrolments at once must not be able to
 * receive the same number and nothing in application code can guarantee that.
 */
export const MEMBERSHIP_NUMBER_PATTERN = /^MB\d{5,}$/;

export function isMembershipNumber(value: unknown): value is string {
  return typeof value === 'string' && MEMBERSHIP_NUMBER_PATTERN.test(value);
}
