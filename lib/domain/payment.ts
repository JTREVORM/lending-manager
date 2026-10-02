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
 */
export const PAYMENT_METHODS = ['cash', 'mtn_mobile_money', 'airtel_money'] as const;

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
 * One scheduled collection, with how much of it prior payments have covered.
 *
 * The `allocated*` figures count **posted** payments only. A reversed
 * payment's allocations remain in the database as history but are excluded
 * here, which is exactly how a reversal restores the balance without anything
 * being deleted.
 */
export interface InstallmentObligation {
  readonly installmentId: string;
  readonly installmentNumber: number;
  readonly dueDate: BusinessDate;
  readonly expectedAmount: UgxAmount;
  readonly scheduledPrincipal: UgxAmount;
  readonly scheduledInterest: UgxAmount;
  readonly allocatedAmount: UgxAmount;
  readonly allocatedPrincipal: UgxAmount;
  readonly allocatedInterest: UgxAmount;
}

/** What one payment contributes to one installment. */
export interface PlannedAllocation {
  readonly installmentId: string;
  readonly installmentNumber: number;
  readonly allocatedAmount: UgxAmount;
  readonly allocatedPrincipal: UgxAmount;
  readonly allocatedInterest: UgxAmount;
}

export interface AllocationPlan {
  readonly allocations: readonly PlannedAllocation[];
  readonly amount: UgxAmount;
  readonly totalPrincipal: UgxAmount;
  readonly totalInterest: UgxAmount;
  /** The loan's outstanding balance before this payment. */
  readonly outstandingBefore: UgxAmount;
  /** After it. Zero means the loan is fully repaid and should clear. */
  readonly outstandingAfter: UgxAmount;
  /** Does this payment settle the loan completely? */
  readonly clearsLoan: boolean;
}

/** What remains unpaid on an installment. */
export function remainingAmount(obligation: InstallmentObligation): UgxAmount {
  return toUgx(obligation.expectedAmount - obligation.allocatedAmount);
}

export function remainingPrincipal(obligation: InstallmentObligation): UgxAmount {
  return toUgx(obligation.scheduledPrincipal - obligation.allocatedPrincipal);
}

export function remainingInterest(obligation: InstallmentObligation): UgxAmount {
  return toUgx(obligation.scheduledInterest - obligation.allocatedInterest);
}

/**
 * Obligations in the order a payment is applied to them.
 *
 * **Earliest due date first**, and where two collections somehow fell on one
 * date, the lower installment number first. Deterministic, so the same payment
 * against the same state always produces the same allocation — which is what
 * makes the plan shown at the counter the plan that gets written.
 *
 * Returns a new array; the input is not mutated.
 */
export function inAllocationOrder(
  obligations: readonly InstallmentObligation[],
): readonly InstallmentObligation[] {
  return [...obligations].sort((left, right) => {
    const byDate = compareBusinessDates(left.dueDate, right.dueDate);
    if (byDate !== 0) return byDate;
    return left.installmentNumber - right.installmentNumber;
  });
}

function assertObligationsSound(obligations: readonly InstallmentObligation[]): void {
  for (const obligation of obligations) {
    const label = `installment ${String(obligation.installmentNumber)}`;

    if (
      obligation.expectedAmount !==
      obligation.scheduledPrincipal + obligation.scheduledInterest
    ) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} expects ${String(obligation.expectedAmount)}, which is not its scheduled principal plus interest.`,
      );
    }

    if (
      obligation.allocatedAmount !==
      obligation.allocatedPrincipal + obligation.allocatedInterest
    ) {
      throw new PaymentAllocationError(
        'obligations_inconsistent',
        `${label} has an allocated total that is not its allocated principal plus interest.`,
      );
    }

    // Over-allocation is the failure this engine exists to make impossible,
    // so an input that already shows it is refused rather than built upon.
    if (
      obligation.allocatedAmount > obligation.expectedAmount ||
      obligation.allocatedPrincipal > obligation.scheduledPrincipal ||
      obligation.allocatedInterest > obligation.scheduledInterest
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

/** The loan's outstanding balance: everything scheduled, less everything covered. */
export function outstandingFrom(
  obligations: readonly InstallmentObligation[],
): UgxAmount {
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
 */
export function minimumAcceptablePayment(
  obligations: readonly InstallmentObligation[],
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
 * Deliberately **not** called arrears. This is a sum of unpaid scheduled
 * amounts whose dates have passed, and nothing more — no grace period, no
 * carry-forward, no penalty. Phase 7 owns the interpretation of an unpaid
 * collection, and borrowing its vocabulary now would mean this phase appeared
 * to make a judgement it has no basis for.
 */
export function unpaidScheduledDue(
  obligations: readonly InstallmentObligation[],
  today: BusinessDate,
): UgxAmount {
  return sumUgx(
    obligations
      .filter((obligation) => compareBusinessDates(obligation.dueDate, today) <= 0)
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
  obligations: readonly InstallmentObligation[],
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
      return `The smallest payment accepted now is ${amount(detail)} — the amount still outstanding on the earliest unpaid collection.`;
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
 * @throws PaymentAllocationError if the amount is refused by
 *   `validatePaymentAmount`, or if the obligations are internally inconsistent.
 */
export function allocatePayment(input: {
  readonly amount: UgxAmount;
  readonly obligations: readonly InstallmentObligation[];
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

    // Interest first. No division, so no rounding.
    const interest = Math.min(remainingInterest(obligation), take);
    const principal = take - interest;

    /* c8 ignore next 6 -- unreachable by construction; see the note above. */
    if (principal > remainingPrincipal(obligation)) {
      throw new PaymentAllocationError(
        'reconciliation_failed',
        `Allocating ${String(take)} to installment ${String(obligation.installmentNumber)} would exceed its remaining principal.`,
      );
    }

    allocations.push({
      installmentId: obligation.installmentId,
      installmentNumber: obligation.installmentNumber,
      allocatedAmount: toUgx(take),
      allocatedPrincipal: toUgx(principal),
      allocatedInterest: toUgx(interest),
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
  obligations: readonly InstallmentObligation[],
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

  if (principal !== plan.totalPrincipal) {
    fail('the reported principal total is not the sum of the allocations.');
  }

  if (interest !== plan.totalInterest) {
    fail('the reported interest total is not the sum of the allocations.');
  }

  if (principal + interest !== plan.amount) {
    fail('the allocated principal and interest do not sum to the payment amount.');
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

  // --- No installment is over-allocated -----------------------------------
  const byId = new Map(
    obligations.map((obligation) => [obligation.installmentId, obligation]),
  );
  const seen = new Set<string>();

  for (const entry of plan.allocations) {
    const label = `installment ${String(entry.installmentNumber)}`;
    const obligation = byId.get(entry.installmentId);

    if (obligation === undefined) {
      fail(`${label} is not one of this loan's collections.`);
      continue;
    }

    // One allocation per installment per payment. Two would still reconcile
    // on totals while making the per-installment caps harder to reason about.
    if (seen.has(entry.installmentId)) {
      fail(`${label} is allocated to twice by one payment.`);
    }
    seen.add(entry.installmentId);

    if (entry.allocatedAmount <= 0) {
      fail(`${label} has a non-positive allocation.`);
    }

    if (entry.allocatedPrincipal < 0 || entry.allocatedInterest < 0) {
      fail(`${label} has a negative component.`);
    }

    if (entry.allocatedPrincipal + entry.allocatedInterest !== entry.allocatedAmount) {
      fail(`${label}'s components do not sum to its allocated amount.`);
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
  }

  // --- Oldest first, and interest before principal ------------------------
  const order = inAllocationOrder(obligations);
  const positionOf = new Map(
    order.map((obligation, index) => [obligation.installmentId, index]),
  );

  let previousPosition = -1;

  for (const entry of plan.allocations) {
    const position = positionOf.get(entry.installmentId) ?? -1;

    if (position <= previousPosition) {
      fail(
        `installment ${String(entry.installmentNumber)} is allocated to out of due-date order.`,
      );
    }

    // Every installment skipped over must already have been settled —
    // otherwise the payment jumped an unpaid earlier collection.
    for (let index = previousPosition + 1; index < position; index += 1) {
      const skipped = order[index];
      if (skipped !== undefined && remainingAmount(skipped) > 0) {
        fail(
          `installment ${String(skipped.installmentNumber)} was skipped while still unpaid.`,
        );
      }
    }

    previousPosition = position;

    // Interest-first, stated as a property of the result: principal may only
    // be touched once this installment's interest is fully covered.
    const obligation = byId.get(entry.installmentId);

    if (obligation !== undefined && entry.allocatedPrincipal > 0) {
      const interestAfter = obligation.allocatedInterest + entry.allocatedInterest;

      if (interestAfter !== obligation.scheduledInterest) {
        fail(
          `installment ${String(entry.installmentNumber)} received principal while interest remained unpaid.`,
        );
      }
    }
  }

  // Every allocation but the last must settle its installment completely,
  // because the payment only moves on once an installment is full.
  for (const [index, entry] of plan.allocations.entries()) {
    const isLast = index === plan.allocations.length - 1;
    const obligation = byId.get(entry.installmentId);

    if (!isLast && obligation !== undefined) {
      if (entry.allocatedAmount !== remainingAmount(obligation)) {
        fail(
          `installment ${String(entry.installmentNumber)} was left partly unpaid while the payment moved on.`,
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
  readonly contractualPrincipal: UgxAmount;
  readonly contractualInterest: UgxAmount;
  readonly totalExpectedRepayment: UgxAmount;
  readonly totalPaid: UgxAmount;
  readonly outstanding: UgxAmount;
  readonly principalPaid: UgxAmount;
  readonly principalRemaining: UgxAmount;
  readonly interestPaid: UgxAmount;
  readonly interestRemaining: UgxAmount;
  /** Is every scheduled collection fully covered? */
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
  obligations: readonly InstallmentObligation[],
): LoanBalance {
  assertObligationsSound(obligations);

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

  const totalExpectedRepayment = toUgx(contractualPrincipal + contractualInterest);
  const totalPaid = toUgx(principalPaid + interestPaid);

  return {
    contractualPrincipal,
    contractualInterest,
    totalExpectedRepayment,
    totalPaid,
    outstanding: toUgx(totalExpectedRepayment - totalPaid),
    principalPaid,
    principalRemaining: toUgx(contractualPrincipal - principalPaid),
    interestPaid,
    interestRemaining: toUgx(contractualInterest - interestPaid),
    fullyRepaid: totalPaid === totalExpectedRepayment,
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

  if (balance.totalPaid + balance.outstanding !== balance.totalExpectedRepayment) {
    fail('paid plus outstanding is not the contractual total.');
  }

  if (balance.outstanding < 0) {
    fail(`the outstanding balance is ${String(balance.outstanding)}.`);
  }

  if (balance.totalPaid < 0) {
    fail('the total paid is negative.');
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

  if (balance.fullyRepaid !== (balance.outstanding === 0)) {
    fail('the fully-repaid flag disagrees with the outstanding balance.');
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
  // was not paid, and none is paid that is not allocated.
  if (postedPaymentTotal !== undefined && postedPaymentTotal !== balance.totalPaid) {
    fail(
      `posted payments total ${String(postedPaymentTotal)} but allocations total ${String(balance.totalPaid)}.`,
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
  obligations: readonly InstallmentObligation[],
  plan: AllocationPlan,
): readonly InstallmentObligation[] {
  const byInstallment = new Map(
    plan.allocations.map((entry) => [entry.installmentId, entry]),
  );

  return obligations.map((obligation) => {
    const entry = byInstallment.get(obligation.installmentId);

    if (entry === undefined) return obligation;

    return {
      ...obligation,
      allocatedAmount: toUgx(obligation.allocatedAmount + entry.allocatedAmount),
      allocatedPrincipal: toUgx(obligation.allocatedPrincipal + entry.allocatedPrincipal),
      allocatedInterest: toUgx(obligation.allocatedInterest + entry.allocatedInterest),
    };
  });
}
