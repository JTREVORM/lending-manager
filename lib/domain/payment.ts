/**
 * The payment allocation engine.
 *
 * Pure. No React, no Supabase, no database, no clock, no browser state — the
 * same discipline as `lib/domain/loan.ts` and
 * `lib/domain/repayment-schedule.ts`, and for the same reason: the payment
 * ledger is financial evidence, and a duplicated payment, a wrong allocation
 * or a wrong balance is a false claim about what a borrower has paid.
 *
 * ## Which implementation is authoritative
 *
 * The database. `public.post_payment` writes the rows, inside one
 * transaction, and accepts no allocation from its caller — a caller who could
 * supply allocations could credit a borrower's principal without paying the
 * interest. This module computes the preview staff see before confirming, and
 * is tested exhaustively in isolation.
 * `tests/db/payment-parity.test.ts` drives several hundred cases through both.
 *
 * ## Why there is no floating point, and no division at all
 *
 * Every amount is a whole number of shillings. More than that: this engine
 * performs **no division**. Allocation is a walk of `min()` operations over
 * integers, so there is no rounding step anywhere and no remainder to place.
 * That is a consequence of the interest-first rule below, and it is one of the
 * main reasons for choosing it.
 *
 * ## What this engine must never do
 *
 * **It never recalculates interest.** Interest is contractually fixed by
 * Phase 4 and allocated across collection dates by Phase 5. A payment does not
 * change what is owed — it changes how much of it remains. Charging interest
 * because a borrower paid late, or discounting it because they paid early,
 * would make the contract a function of behaviour rather than of agreement,
 * and Phase 7 owns late-payment consequences.
 *
 * **It never rewrites the schedule.** `loan_installments` is immutable. A
 * Monday scheduled at UGX 4,000 stays UGX 4,000 forever; payment coverage is a
 * separate fact, recorded in `payment_allocations`. See ADR-026.
 */

import { compareBusinessDates, type BusinessDate } from '@/lib/domain/datetime';
import { sumUgx, toUgx, type UgxAmount } from '@/lib/domain/money';

/**
 * How a payment reached the business.
 *
 * A closed vocabulary, mirrored by a CHECK constraint on
 * `loan_payments.payment_method`. Free text would let a typo —
 * `'MTN Momo'`, `'mtn momo'`, `'momo'` — fracture the collection totals that
 * the business reconciles its cash against.
 *
 * Phase 6 records these manually. No MTN or Airtel API is called.
 *
 * Phase 10 adds `bank`. It arrived with the ledger rather than with
 * Collections because the ledger needed a fourth cash account — Cash at
 * Bank — and an account money can reach is an account a payment can land in.
 */
export const PAYMENT_METHODS = [
  'cash',
  'mtn_mobile_money',
  'airtel_money',
  'bank',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return (
    typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  cash: 'Cash',
  mtn_mobile_money: 'MTN Mobile Money',
  airtel_money: 'Airtel Money',
  bank: 'Bank Transfer',
};

/** Methods that arrive with a transaction reference from the network. */
export const MOBILE_MONEY_METHODS: readonly PaymentMethod[] = [
  'mtn_mobile_money',
  'airtel_money',
];

export function isMobileMoney(method: PaymentMethod): boolean {
  return MOBILE_MONEY_METHODS.includes(method);
}

/**
 * Whether this method arrives with somebody else's reference on it.
 *
 * Everything but cash does: a network transaction id, or the reference on a
 * bank statement. Without it a posting cannot be matched back to the other
 * side's record, which is the whole of reconciliation — so `post_payment`
 * refuses the payment, and the form asks for it before the staff member can
 * submit.
 *
 * Stated as "not cash" rather than as a list, because that is how the
 * database states it and a second list would be a second rule to keep in
 * step. `isMobileMoney` remains separate: it answers a different question —
 * which methods came through a mobile network — and a bank transfer did not.
 */
export function requiresExternalReference(method: PaymentMethod): boolean {
  return method !== 'cash';
}

/**
 * A payment's lifecycle.
 *
 *   - `posted` — recorded and effective. Its allocations count toward the
 *     balance.
 *   - `reversed` — recorded in error and withdrawn. The row, its amount and
 *     its allocations all remain exactly as posted; they simply stop counting.
 *
 * Two values, and no more. A `pending` or `failed` status would imply this
 * phase talks to a payment network, which it deliberately does not: a staff
 * member records a payment they have already received, so there is no moment
 * at which the outcome is unknown.
 *
 * A reversal is **never** a delete. See ADR-028.
 */
export const PAYMENT_STATUSES = ['posted', 'reversed'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === 'string' && (PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}

export const PAYMENT_STATUS_LABELS: Readonly<Record<PaymentStatus, string>> = {
  posted: 'Posted',
  reversed: 'Reversed',
};

export class PaymentAllocationError extends Error {
  readonly code: PaymentFailureCode;

  constructor(code: PaymentFailureCode, message: string) {
    super(message);
    this.name = 'PaymentAllocationError';
    this.code = code;
  }
}

/**
 * Why a payment cannot be accepted.
 *
 * Machine-readable rather than prose, so the database states the rule and the
 * interface decides how to say it — and so a test can assert which rule fired
 * rather than matching on a sentence somebody may later reword. Mirrors the
 * codes `public.post_payment` raises.
 */
export const PAYMENT_FAILURE_CODES = [
  'amount_not_positive',
  'below_minimum',
  'exceeds_outstanding',
  'nothing_outstanding',
  'obligations_inconsistent',
  'reconciliation_failed',
] as const;

export type PaymentFailureCode = (typeof PAYMENT_FAILURE_CODES)[number];

/**
 * What a payment can be applied to.
 *
 * ## Why this is not called an installment
 *
 * Phase 6 had one kind of obligation, a scheduled collection, and named the
 * type after it. Phase 7 adds a second: the expiry penalty. Rather than
 * retrofit penalty fields onto a type called `InstallmentObligation` — which
 * would have left every reader to discover that an "installment" is sometimes
 * a penalty — the type says what it is, and `kind` says which.
 *
 * The shape mirrors the database's `loan_obligations` view field for field, on
 * purpose: the two engines allocate the same way, and a parity test compares
 * them row by row. A difference in vocabulary between them would be a place
 * for a difference in behaviour to hide.
 *
 * ## The components
 *
 * A collection has a principal part and an interest part and no penalty part.
 * A penalty is entirely penalty: no principal, no interest. The database
 * enforces exactly this with CHECK constraints, because a penalty recorded as
 * interest would misstate what a borrower was charged for.
 *
 * The `allocated*` figures count **posted** payments only. A reversed
 * payment's allocations remain in the database as history but are excluded
 * here, which is exactly how a reversal restores the balance without anything
 * being deleted.
 */
export const OBLIGATION_KINDS = ['installment', 'penalty'] as const;

export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export interface PaymentObligation {
  /** The installment's id, or the penalty's. The allocation target. */
  readonly obligationId: string;
  readonly kind: ObligationKind;
  /**
   * 1-based within its kind: the collection number, or 1 for the single
   * penalty. Used to break an ordering tie and to label a message, never to
   * imply that a penalty is the first of a series.
   */
  readonly sequenceNumber: number;
  /**
   * When the obligation falls due: a collection's due date, or the penalty's
   * effective date. The ordering key, and the reason oldest-first needs no
   * special case for penalties — a penalty's effective date is the day after
   * the grace period, so it is necessarily later than every collection.
   */
  readonly effectiveDate: BusinessDate;
  readonly expectedAmount: UgxAmount;
  readonly scheduledPrincipal: UgxAmount;
  readonly scheduledInterest: UgxAmount;
  readonly scheduledPenalty: UgxAmount;
  readonly allocatedAmount: UgxAmount;
  readonly allocatedPrincipal: UgxAmount;
  readonly allocatedInterest: UgxAmount;
  readonly allocatedPenalty: UgxAmount;
}

/** What one payment contributes to one obligation. */
export interface PlannedAllocation {
  readonly obligationId: string;
  readonly kind: ObligationKind;
  readonly sequenceNumber: number;
  readonly allocatedAmount: UgxAmount;
  readonly allocatedPrincipal: UgxAmount;
  readonly allocatedInterest: UgxAmount;
  readonly allocatedPenalty: UgxAmount;
}

export interface AllocationPlan {
  readonly allocations: readonly PlannedAllocation[];
  readonly amount: UgxAmount;
  readonly totalPrincipal: UgxAmount;
  readonly totalInterest: UgxAmount;
  readonly totalPenalty: UgxAmount;
  /** The loan's total outstanding balance before this payment, penalty included. */
  readonly outstandingBefore: UgxAmount;
  /** After it. Zero means nothing at all is owed and the loan should clear. */
  readonly outstandingAfter: UgxAmount;
  /** Does this payment settle the loan completely, penalty included? */
  readonly clearsLoan: boolean;
}

/** A readable name for an obligation, for a message somebody will act on. */
export function describeObligation(obligation: {
  readonly kind: ObligationKind;
  readonly sequenceNumber: number;
}): string {
  return obligation.kind === 'penalty'
    ? 'the penalty'
    : `collection ${String(obligation.sequenceNumber)}`;
}

/** Collections before penalties, where two obligations share a date. */
function obligationRank(kind: ObligationKind): number {
  return kind === 'penalty' ? 1 : 0;
}

/** What remains unpaid on an obligation. */
export function remainingAmount(obligation: PaymentObligation): UgxAmount {
  return toUgx(obligation.expectedAmount - obligation.allocatedAmount);
}

export function remainingPrincipal(obligation: PaymentObligation): UgxAmount {
  return toUgx(obligation.scheduledPrincipal - obligation.allocatedPrincipal);
}

export function remainingInterest(obligation: PaymentObligation): UgxAmount {
  return toUgx(obligation.scheduledInterest - obligation.allocatedInterest);
}

export function remainingPenalty(obligation: PaymentObligation): UgxAmount {
  return toUgx(obligation.scheduledPenalty - obligation.allocatedPenalty);
}

/**
 * Obligations in the order a payment is applied to them.
 *
 * **Earliest effective date first**; where two obligations share a date, a
 * collection before a penalty; and where two collections share a date, the
 * lower number first. Deterministic, so the same payment against the same
 * state always produces the same allocation — which is what makes the plan
 * shown at the counter the plan that gets written.
 *
 * The penalty needs no rule of its own. Its effective date is the day after
 * the grace period, which is after every collection's due date, so ordinary
 * oldest-first covers the whole contract before it touches the charge.
 *
 * Returns a new array; the input is not mutated.
 */
export function inAllocationOrder(
  obligations: readonly PaymentObligation[],
): readonly PaymentObligation[] {
  return [...obligations].sort((left, right) => {
    const byDate = compareBusinessDates(left.effectiveDate, right.effectiveDate);
    if (byDate !== 0) return byDate;

    const byKind = obligationRank(left.kind) - obligationRank(right.kind);
    if (byKind !== 0) return byKind;

    return left.sequenceNumber - right.sequenceNumber;
  });
}

function assertObligationsSound(obligations: readonly PaymentObligation[]): void {
  for (const obligation of obligations) {
    const label = describeObligation(obligation);

    if (
      obligation.expectedAmount !==
      obligation.scheduledPrincipal +
        obligation.scheduledInterest +
        obligation.scheduledPenalty
    ) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} expects ${String(obligation.expectedAmount)}, which is not its scheduled components.`,
      );
    }

    if (
      obligation.allocatedAmount !==
      obligation.allocatedPrincipal +
        obligation.allocatedInterest +
        obligation.allocatedPenalty
    ) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} has an allocated total that is not the sum of its allocated components.`,
      );
    }

    // A penalty is neither principal nor contractual interest, and a
    // collection carries no penalty. Checked here as well as in the database,
    // because this is the engine that builds what the database stores.
    if (obligation.kind === 'penalty') {
      if (obligation.scheduledPrincipal !== 0 || obligation.scheduledInterest !== 0) {
        throw new PaymentAllocationError(
          'obligations_inconsistent',
          `${label} carries a principal or interest component; a penalty is neither.`,
        );
      }
    } else if (obligation.scheduledPenalty !== 0) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} carries a penalty component; a collection has none.`,
      );
    }

    // Over-allocation is the failure this engine exists to make impossible,
    // so an input that already shows it is refused rather than built upon.
    if (
      obligation.allocatedAmount > obligation.expectedAmount ||
      obligation.allocatedPrincipal > obligation.scheduledPrincipal ||
      obligation.allocatedInterest > obligation.scheduledInterest ||
      obligation.allocatedPenalty > obligation.scheduledPenalty
    ) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} is already over-allocated.`,
      );
    }

    if (obligation.allocatedAmount < 0 || obligation.expectedAmount < 0) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} carries a negative amount.`,
      );
    }
  }
}

/**
 * Everything the borrower owes: every obligation, less everything covered.
 *
 * Penalties included — this is the figure a payment is capped at and the one
 * that must reach zero for a loan to clear. `deriveLoanBalance` separates the
 * contractual part from the penalty part for the screens that need both.
 */
export function outstandingFrom(obligations: readonly PaymentObligation[]): UgxAmount {
  return sumUgx(obligations.map(remainingAmount));
}

/**
 * The smallest payment the business will accept, or `null` when nothing is
 * outstanding.
 *
 * ## The rule
 *
 * **The remaining amount of the earliest unpaid installment.**
 *
 * The business rule is that a borrower should not pay less than an
 * installment. Stated against the *remaining* amount rather than the original
 * one, which matters in the case the specification calls out: an installment
 * nominally UGX 4,000 that a previous overpayment already covered UGX 2,500 of
 * accepts UGX 1,500, because UGX 1,500 is what is actually left of it.
 *
 * It also quietly handles the final payment of a loan. When the whole
 * remaining balance is less than a nominal installment, the earliest unpaid
 * installment's *remaining* is that smaller figure, so the borrower can settle
 * without being asked for more than they owe. No special case is needed —
 * the outstanding balance is by definition the sum of the remainders, so it
 * can never be smaller than the first of them.
 *
 * ## With a penalty
 *
 * The rule is unchanged and is stated over obligations rather than
 * collections, which gives the right answer in both cases without a branch:
 * while any collection is unpaid the minimum is that collection's remainder,
 * because a penalty sorts after every collection; once the contract is settled
 * and only the penalty is left, the minimum is what remains of the penalty.
 */
export function minimumAcceptablePayment(
  obligations: readonly PaymentObligation[],
): UgxAmount | null {
  for (const obligation of inAllocationOrder(obligations)) {
    const remaining = remainingAmount(obligation);
    if (remaining > 0) return remaining;
  }

  return null;
}

/**
 * What is due now: scheduled collections dated today or earlier, less what has
 * been covered.
 *
 * **Scheduled** collections only: a penalty is not part of the schedule, and
 * folding it in would make this figure impossible to compare against the
 * contract. `lib/domain/delinquency.ts` is where arrears, due-today and
 * current-due live, and it reports the penalty beside them rather than inside
 * them.
 */
export function unpaidScheduledDue(
  obligations: readonly PaymentObligation[],
  today: BusinessDate,
): UgxAmount {
  return sumUgx(
    obligations
      .filter(
        (obligation) =>
          obligation.kind === 'installment' &&
          compareBusinessDates(obligation.effectiveDate, today) <= 0,
      )
      .map(remainingAmount),
  );
}

/**
 * Why this amount cannot be accepted against these obligations, or `null`.
 *
 * Separated from `allocatePayment` so the interface can explain a refusal
 * before the staff member commits, and so the database and the browser can
 * apply the same four rules.
 */
export function validatePaymentAmount(
  amount: number,
  obligations: readonly PaymentObligation[],
): { readonly code: PaymentFailureCode; readonly detail: UgxAmount | null } | null {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { code: 'amount_not_positive', detail: null };
  }

  const outstanding = outstandingFrom(obligations);

  if (outstanding === 0) {
    return { code: 'nothing_outstanding', detail: null };
  }

  // Checked before the minimum, so a borrower offering more than they owe is
  // told the balance rather than told about an installment.
  if (amount > outstanding) {
    return { code: 'exceeds_outstanding', detail: outstanding };
  }

  const minimum = minimumAcceptablePayment(obligations);

  if (minimum !== null && amount < minimum) {
    return { code: 'below_minimum', detail: minimum };
  }

  return null;
}

/** What to tell the person at the counter. */
export function describePaymentFailure(
  code: PaymentFailureCode,
  detail: number | null,
): string {
  const amount = (value: number | null): string =>
    value === null
      ? 'the required amount'
      : `UGX ${Number(value).toLocaleString('en-UG')}`;

  switch (code) {
    case 'amount_not_positive':
      return 'Enter a payment amount greater than zero.';
    case 'below_minimum':
      return `The smallest payment accepted now is ${amount(detail)} — the amount still outstanding on the earliest unpaid obligation.`;
    case 'exceeds_outstanding':
      return `That is more than this loan still owes. The outstanding balance is ${amount(detail)}.`;
    case 'nothing_outstanding':
      return 'This loan is fully repaid. There is nothing left to pay.';
    case 'obligations_inconsistent':
      return 'This loan’s schedule and payment history do not agree. Report this before taking any payment.';
    case 'reconciliation_failed':
      return 'The payment could not be allocated consistently and was not recorded. Report this.';
  }
}

/**
 * Work out exactly how a payment is applied.
 *
 * ## The allocation rules, in one place
 *
 * **Across installments: oldest first.** The payment fills the earliest
 * unpaid collection completely, then the next, and so on until it is
 * exhausted. This is what makes overpayment work without a separate
 * mechanism: a borrower paying UGX 12,000 against three UGX 4,000 collections
 * simply covers all three, and the future collections keep their original
 * dates and amounts.
 *
 * **Within an installment: interest first, then principal.**
 *
 * The alternative considered was pro-rata — splitting each part-payment in the
 * installment's own principal-to-interest ratio. It was rejected because it
 * requires a division and therefore a rounding decision on every partial
 * allocation, and two part-payments that together settle an installment could
 * then produce components that do not sum back to the scheduled components.
 * Interest-first needs no division at all: the components are `min()` results
 * over integers, so `principal + interest = amount` holds exactly, always,
 * with nothing to round and no remainder to place.
 *
 * It is also the conventional order in lending, and the specification asks for
 * the simpler consistent model where the business has not specified one.
 *
 * A useful property falls out of it: `principal` can never exceed the
 * installment's remaining principal. Either the whole part-payment is absorbed
 * by interest, or interest is exhausted and what is left is at most
 * `remaining − remainingInterest`, which is the remaining principal. That is
 * asserted rather than assumed.
 *
 * **A penalty takes the whole of what it receives as penalty.** It has no
 * interest and no principal, so the same three-way split below puts every
 * shilling in the penalty component with nothing left over. Phase 7 therefore
 * adds a component rather than a rule: the loop is the Phase 6 loop.
 *
 * @throws PaymentAllocationError if the amount is refused by
 *   `validatePaymentAmount`, or if the obligations are internally inconsistent.
 */
export function allocatePayment(input: {
  readonly amount: UgxAmount;
  readonly obligations: readonly PaymentObligation[];
}): AllocationPlan {
  const { amount, obligations } = input;

  assertObligationsSound(obligations);

  const failure = validatePaymentAmount(amount, obligations);

  if (failure !== null) {
    throw new PaymentAllocationError(
      failure.code,
      describePaymentFailure(failure.code, failure.detail),
    );
  }

  const outstandingBefore = outstandingFrom(obligations);

  const allocations: PlannedAllocation[] = [];
  let unallocated: number = amount;

  for (const obligation of inAllocationOrder(obligations)) {
    if (unallocated === 0) break;

    const remaining = remainingAmount(obligation);
    if (remaining === 0) continue;

    const take = Math.min(remaining, unallocated);

    // Interest first, then penalty, then principal — each a `min()` of two
    // integers, so no division and no rounding. An obligation is either
    // contractual or a penalty, never both, so at most one of the first two
    // terms is non-zero for any obligation:
    //
    //   a collection -> penalty is 0, so interest then principal
    //   a penalty    -> interest is 0, so the whole take is penalty
    //
    // Principal is the remainder, which is what keeps a penalty from ever
    // being recorded as principal.
    const interest = Math.min(remainingInterest(obligation), take);
    const penalty = Math.min(remainingPenalty(obligation), take - interest);
    const principal = take - interest - penalty;

    /* c8 ignore next 6 -- unreachable by construction; see the note above. */
    if (principal > remainingPrincipal(obligation)) {
      throw new PaymentAllocationError(
        'reconciliation_failed',
        `Allocating ${String(take)} to ${describeObligation(obligation)} would exceed its remaining principal.`,
      );
    }

    allocations.push({
      obligationId: obligation.obligationId,
      kind: obligation.kind,
      sequenceNumber: obligation.sequenceNumber,
      allocatedAmount: toUgx(take),
      allocatedPrincipal: toUgx(principal),
      allocatedInterest: toUgx(interest),
      allocatedPenalty: toUgx(penalty),
    });

    unallocated -= take;
  }

  /* c8 ignore next 6 -- unreachable: validatePaymentAmount capped the amount
     at the outstanding balance, which is the sum of the remainders. */
  if (unallocated !== 0) {
    throw new PaymentAllocationError(
      'reconciliation_failed',
      `${String(unallocated)} shillings of this payment could not be allocated.`,
    );
  }

  const plan: AllocationPlan = {
    allocations,
    amount,
    totalPrincipal: sumUgx(allocations.map((entry) => entry.allocatedPrincipal)),
    totalInterest: sumUgx(allocations.map((entry) => entry.allocatedInterest)),
    totalPenalty: sumUgx(allocations.map((entry) => entry.allocatedPenalty)),
    outstandingBefore,
    outstandingAfter: toUgx(outstandingBefore - amount),
    clearsLoan: outstandingBefore === amount,
  };

  // Checked on every call rather than only in tests, for the reason the loan
  // engine gives: the cost is a few additions, and the alternative is a wrong
  // allocation reaching the ledger because some future change broke an
  // invariant nobody re-ran.
  assertAllocationInvariants(plan, obligations);

  return plan;
}

/**
 * Every invariant an allocation must satisfy.
 *
 * Exported so the database parity test can apply exactly these checks to
 * allocations that did **not** come from `allocatePayment` — including rows
 * read back out of PostgreSQL.
 *
 * @throws PaymentAllocationError naming the first invariant that fails.
 */
export function assertAllocationInvariants(
  plan: AllocationPlan,
  obligations: readonly PaymentObligation[],
): void {
  const fail = (message: string): never => {
    throw new PaymentAllocationError(
      'reconciliation_failed',
      `Allocation invariant violated: ${message}`,
    );
  };

  // --- No money appears or disappears -------------------------------------
  // Checked first: the per-allocation walk below implies much of it, so
  // conservation checked afterwards could never fire.
  const allocated = plan.allocations.reduce(
    (total, entry) => total + entry.allocatedAmount,
    0,
  );

  if (allocated !== plan.amount) {
    fail(
      `the allocations sum to ${String(allocated)}, not the payment amount ${String(plan.amount)}.`,
    );
  }

  const principal = plan.allocations.reduce(
    (total, entry) => total + entry.allocatedPrincipal,
    0,
  );
  const interest = plan.allocations.reduce(
    (total, entry) => total + entry.allocatedInterest,
    0,
  );
  const penalty = plan.allocations.reduce(
    (total, entry) => total + entry.allocatedPenalty,
    0,
  );

  if (principal !== plan.totalPrincipal) {
    fail('the reported principal total is not the sum of the allocations.');
  }

  if (interest !== plan.totalInterest) {
    fail('the reported interest total is not the sum of the allocations.');
  }

  if (penalty !== plan.totalPenalty) {
    fail('the reported penalty total is not the sum of the allocations.');
  }

  if (principal + interest + penalty !== plan.amount) {
    fail('the allocated components do not sum to the payment amount.');
  }

  if (plan.outstandingAfter !== plan.outstandingBefore - plan.amount) {
    fail('the outstanding balance after does not follow from the amount paid.');
  }

  if (plan.outstandingAfter < 0) {
    fail(
      `the payment would leave an outstanding balance of ${String(plan.outstandingAfter)}.`,
    );
  }

  if (plan.clearsLoan !== (plan.outstandingAfter === 0)) {
    fail('the clearance flag disagrees with the resulting balance.');
  }

  // --- No obligation is over-allocated ------------------------------------
  const byId = new Map(
    obligations.map((obligation) => [obligation.obligationId, obligation]),
  );
  const seen = new Set<string>();

  for (const entry of plan.allocations) {
    const label = describeObligation(entry);
    const obligation = byId.get(entry.obligationId);

    if (obligation === undefined) {
      fail(`${label} is not one of this loan's obligations.`);
      continue;
    }

    if (obligation.kind !== entry.kind) {
      fail(`${label} is allocated to as the wrong kind of obligation.`);
    }

    // One allocation per obligation per payment. Two would still reconcile
    // on totals while making the per-obligation caps harder to reason about.
    if (seen.has(entry.obligationId)) {
      fail(`${label} is allocated to twice by one payment.`);
    }
    seen.add(entry.obligationId);

    if (entry.allocatedAmount <= 0) {
      fail(`${label} has a non-positive allocation.`);
    }

    if (
      entry.allocatedPrincipal < 0 ||
      entry.allocatedInterest < 0 ||
      entry.allocatedPenalty < 0
    ) {
      fail(`${label} has a negative component.`);
    }

    if (
      entry.allocatedPrincipal + entry.allocatedInterest + entry.allocatedPenalty !==
      entry.allocatedAmount
    ) {
      fail(`${label}'s components do not sum to its allocated amount.`);
    }

    // A penalty is not interest and not principal. This is the classification
    // rule the specification is emphatic about, asserted on every allocation.
    if (entry.kind === 'penalty') {
      if (entry.allocatedPrincipal !== 0 || entry.allocatedInterest !== 0) {
        fail('the penalty received principal or interest, which it does not have.');
      }

      if (entry.allocatedPenalty !== entry.allocatedAmount) {
        fail('a penalty allocation must be entirely penalty.');
      }
    } else if (entry.allocatedPenalty !== 0) {
      fail(`${label} received a penalty component, which a collection does not have.`);
    }

    if (entry.allocatedAmount > remainingAmount(obligation)) {
      fail(
        `${label} would receive ${String(entry.allocatedAmount)} against ${String(remainingAmount(obligation))} remaining.`,
      );
    }

    if (entry.allocatedPrincipal > remainingPrincipal(obligation)) {
      fail(`${label} would receive more principal than it has remaining.`);
    }

    if (entry.allocatedInterest > remainingInterest(obligation)) {
      fail(`${label} would receive more interest than it has remaining.`);
    }

    if (entry.allocatedPenalty > remainingPenalty(obligation)) {
      fail(`${label} would receive more penalty than it has remaining.`);
    }
  }

  // --- Oldest first, and interest before principal ------------------------
  const order = inAllocationOrder(obligations);
  const positionOf = new Map(
    order.map((obligation, index) => [obligation.obligationId, index]),
  );

  let previousPosition = -1;

  for (const entry of plan.allocations) {
    const position = positionOf.get(entry.obligationId) ?? -1;

    if (position <= previousPosition) {
      fail(`${describeObligation(entry)} is allocated to out of date order.`);
    }

    // Every obligation skipped over must already have been settled —
    // otherwise the payment jumped an unpaid earlier one. This is also what
    // proves the contract is covered before the penalty: the penalty is last
    // in the order, so reaching it requires everything before it to be full.
    for (let index = previousPosition + 1; index < position; index += 1) {
      const skipped = order[index];
      if (skipped !== undefined && remainingAmount(skipped) > 0) {
        fail(`${describeObligation(skipped)} was skipped while still unpaid.`);
      }
    }

    previousPosition = position;

    // Interest-first, stated as a property of the result: principal may only
    // be touched once this collection's interest is fully covered.
    const obligation = byId.get(entry.obligationId);

    if (obligation !== undefined && entry.allocatedPrincipal > 0) {
      const interestAfter = obligation.allocatedInterest + entry.allocatedInterest;

      if (interestAfter !== obligation.scheduledInterest) {
        fail(
          `${describeObligation(entry)} received principal while interest remained unpaid.`,
        );
      }
    }
  }

  // Every allocation but the last must settle its obligation completely,
  // because the payment only moves on once an obligation is full.
  for (const [index, entry] of plan.allocations.entries()) {
    const isLast = index === plan.allocations.length - 1;
    const obligation = byId.get(entry.obligationId);

    if (!isLast && obligation !== undefined) {
      if (entry.allocatedAmount !== remainingAmount(obligation)) {
        fail(
          `${describeObligation(entry)} was left partly unpaid while the payment moved on.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/**
 * A loan's financial position.
 *
 * Every figure is **derived** from the contract and the allocations of posted
 * payments. None of it is stored as a mutable column, so none of it can go
 * stale: reversing a payment changes the answer immediately, because the
 * reversed payment's allocations simply stop being counted.
 *
 * The one place balances *are* stored is `loan_payments.outstanding_before`
 * and `outstanding_after`, and those are not balances — they are a record of
 * what the receipt said at the counter. See ADR-029.
 */
export interface LoanBalance {
  // --- The contract, as agreed. A penalty never alters any of these. ------
  readonly contractualPrincipal: UgxAmount;
  readonly contractualInterest: UgxAmount;
  readonly totalExpectedRepayment: UgxAmount;
  readonly totalPaid: UgxAmount;
  readonly contractualOutstanding: UgxAmount;
  readonly principalPaid: UgxAmount;
  readonly principalRemaining: UgxAmount;
  readonly interestPaid: UgxAmount;
  readonly interestRemaining: UgxAmount;

  // --- The penalty, separately --------------------------------------------
  readonly penaltyAssessed: UgxAmount;
  readonly penaltyPaid: UgxAmount;
  readonly penaltyRemaining: UgxAmount;

  // --- What the borrower owes, and what was collected ---------------------
  /** Contractual outstanding plus unpaid penalties. The figure to quote. */
  readonly totalOutstanding: UgxAmount;
  /** Contract and penalty money together. What reconciles against payments. */
  readonly totalCollected: UgxAmount;
  /** Is everything covered, penalty included? */
  readonly fullyRepaid: boolean;
}

/**
 * Derive a loan's position from its obligations.
 *
 * The contractual figures come from the schedule rather than from `loans`,
 * because Phase 5 guarantees the installments sum to the contractual total —
 * so deriving both sides from one source means the reconciliation below is a
 * real check rather than a tautology. `assertBalanceInvariants` then compares
 * it against the loan's own stored totals.
 */
export function deriveLoanBalance(
  obligations: readonly PaymentObligation[],
): LoanBalance {
  assertObligationsSound(obligations);

  // Summing the components rather than filtering by kind, which gives the
  // same answer with one fewer assumption: a collection's penalty component is
  // zero and a penalty's principal and interest components are zero, and
  // `assertObligationsSound` has just refused any input where that is untrue.
  const contractualPrincipal = sumUgx(
    obligations.map((obligation) => obligation.scheduledPrincipal),
  );
  const contractualInterest = sumUgx(
    obligations.map((obligation) => obligation.scheduledInterest),
  );
  const principalPaid = sumUgx(
    obligations.map((obligation) => obligation.allocatedPrincipal),
  );
  const interestPaid = sumUgx(
    obligations.map((obligation) => obligation.allocatedInterest),
  );
  const penaltyAssessed = sumUgx(
    obligations.map((obligation) => obligation.scheduledPenalty),
  );
  const penaltyPaid = sumUgx(
    obligations.map((obligation) => obligation.allocatedPenalty),
  );

  const totalExpectedRepayment = toUgx(contractualPrincipal + contractualInterest);
  const totalPaid = toUgx(principalPaid + interestPaid);
  const contractualOutstanding = toUgx(totalExpectedRepayment - totalPaid);
  const penaltyRemaining = toUgx(penaltyAssessed - penaltyPaid);

  return {
    contractualPrincipal,
    contractualInterest,
    totalExpectedRepayment,
    totalPaid,
    contractualOutstanding,
    principalPaid,
    principalRemaining: toUgx(contractualPrincipal - principalPaid),
    interestPaid,
    interestRemaining: toUgx(contractualInterest - interestPaid),
    penaltyAssessed,
    penaltyPaid,
    penaltyRemaining,
    totalOutstanding: toUgx(contractualOutstanding + penaltyRemaining),
    totalCollected: toUgx(totalPaid + penaltyPaid),
    fullyRepaid: contractualOutstanding === 0 && penaltyRemaining === 0,
  };
}

/**
 * Every reconciliation invariant the specification requires.
 *
 * Applied to figures read back from the database as well as to computed ones,
 * so a corrupt ledger is caught at the point it is read rather than believed.
 *
 * @throws PaymentAllocationError naming the first invariant that fails.
 */
export function assertBalanceInvariants(
  balance: LoanBalance,
  options: {
    /** The loan's own stored total, for a cross-check against the schedule. */
    readonly storedTotalExpectedRepayment?: number;
    /** The sum of posted payment amounts, which must equal the allocations. */
    readonly postedPaymentTotal?: number;
  } = {},
): void {
  const fail = (message: string): never => {
    throw new PaymentAllocationError(
      'reconciliation_failed',
      `Balance invariant violated: ${message}`,
    );
  };

  if (
    balance.totalPaid + balance.contractualOutstanding !==
    balance.totalExpectedRepayment
  ) {
    fail('paid plus outstanding is not the contractual total.');
  }

  if (balance.contractualOutstanding < 0) {
    fail(
      `the contractual outstanding balance is ${String(balance.contractualOutstanding)}.`,
    );
  }

  if (balance.totalPaid < 0) {
    fail('the total paid is negative.');
  }

  // --- The penalty reconciles, and does not contaminate the contract ------
  if (balance.penaltyPaid + balance.penaltyRemaining !== balance.penaltyAssessed) {
    fail('penalty paid plus penalty remaining is not the penalty assessed.');
  }

  if (balance.penaltyRemaining < 0) {
    fail(`the penalty remaining is ${String(balance.penaltyRemaining)}.`);
  }

  if (balance.penaltyPaid < 0 || balance.penaltyAssessed < 0) {
    fail('a penalty figure is negative.');
  }

  if (
    balance.contractualOutstanding + balance.penaltyRemaining !==
    balance.totalOutstanding
  ) {
    fail('contractual outstanding plus penalty remaining is not the total outstanding.');
  }

  if (balance.totalPaid + balance.penaltyPaid !== balance.totalCollected) {
    fail('contractual paid plus penalty paid is not the total collected.');
  }

  if (
    balance.principalPaid + balance.principalRemaining !==
    balance.contractualPrincipal
  ) {
    fail('principal paid plus principal remaining is not the contractual principal.');
  }

  if (balance.interestPaid + balance.interestRemaining !== balance.contractualInterest) {
    fail('interest paid plus interest remaining is not the contractual interest.');
  }

  if (balance.principalPaid + balance.interestPaid !== balance.totalPaid) {
    fail('principal paid plus interest paid is not the total paid.');
  }

  if (balance.principalRemaining < 0 || balance.interestRemaining < 0) {
    fail('a remaining component is negative.');
  }

  // Penalty included: a loan with a charge outstanding is not fully repaid,
  // which is what makes the clearance rule in the database checkable here.
  if (balance.fullyRepaid !== (balance.totalOutstanding === 0)) {
    fail('the fully-repaid flag disagrees with the total outstanding balance.');
  }

  const { storedTotalExpectedRepayment, postedPaymentTotal } = options;

  if (
    storedTotalExpectedRepayment !== undefined &&
    storedTotalExpectedRepayment !== balance.totalExpectedRepayment
  ) {
    fail(
      `the schedule totals ${String(balance.totalExpectedRepayment)} against the loan's stored ${String(storedTotalExpectedRepayment)}.`,
    );
  }

  // The specification's headline reconciliation: no money is allocated that
  // was not paid, and none is paid that is not allocated. Phase 7 compares
  // against `totalCollected` — contract and penalty together — because a
  // payment may now satisfy either, and comparing against the contractual
  // figure alone would report a penalty payment as missing money.
  if (postedPaymentTotal !== undefined && postedPaymentTotal !== balance.totalCollected) {
    fail(
      `posted payments total ${String(postedPaymentTotal)} but allocations total ${String(balance.totalCollected)}.`,
    );
  }
}

/**
 * Apply a plan to a set of obligations, returning the resulting state.
 *
 * Used by the preview and by tests to express "and then", without touching the
 * database. Pure: the input is not mutated.
 */
export function applyPlan(
  obligations: readonly PaymentObligation[],
  plan: AllocationPlan,
): readonly PaymentObligation[] {
  const byObligation = new Map(
    plan.allocations.map((entry) => [entry.obligationId, entry]),
  );

  return obligations.map((obligation) => {
    const entry = byObligation.get(obligation.obligationId);

    if (entry === undefined) return obligation;

    return {
      ...obligation,
      allocatedAmount: toUgx(obligation.allocatedAmount + entry.allocatedAmount),
      allocatedPrincipal: toUgx(obligation.allocatedPrincipal + entry.allocatedPrincipal),
      allocatedInterest: toUgx(obligation.allocatedInterest + entry.allocatedInterest),
      allocatedPenalty: toUgx(obligation.allocatedPenalty + entry.allocatedPenalty),
    };
  });
}
