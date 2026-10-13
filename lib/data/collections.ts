import 'server-only';

import { logger } from '@/lib/logger';
import { type BusinessDate } from '@/lib/domain/datetime';
import { toUgx, type UgxAmount } from '@/lib/domain/money';
import { isPaymentMethod, type PaymentMethod } from '@/lib/domain/payment';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * The Collection Summary: what came in over a period, cut five ways.
 *
 * ## One query, sliced in memory
 *
 * ADR-042's doctrine, and the reason for it is visible here more than
 * anywhere. Collections by Method, by Staff, by Branch, by Product and by day
 * are five presentations of the same rows. Five `group by` queries would be
 * five chances for the figures to disagree — a reversal posted between query
 * two and query four, and the method totals no longer add up to the staff
 * totals, with nothing on the screen to say why. One read, summed five ways,
 * cannot do that: every slice is a partition of the same list.
 *
 * ## What is counted
 *
 * `effective_amount` and the `*_collected` columns, which `payment_register`
 * already zeroes for a reversed payment. So a reversal removes its payment
 * from every slice without this module remembering to filter, and the
 * reversal count is reported separately — a day with eight receipts and one
 * reversal is a different day from one with seven receipts, and a summary that
 * showed only the net would hide the correction that was made.
 *
 * The branch and the product come from the loan, not from the receipt: they
 * say which lending the money belongs to, not which counter took it in.
 */

export interface CollectionSlice {
  /** The key being sliced on. `null` only where the underlying row has none. */
  readonly key: string | null;
  readonly label: string;
  readonly paymentCount: number;
  readonly reversedCount: number;
  readonly totalCollected: UgxAmount;
  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;
}

export interface CollectionSummary {
  readonly from: BusinessDate;
  readonly to: BusinessDate;
  readonly paymentCount: number;
  readonly reversedCount: number;
  readonly totalCollected: UgxAmount;
  readonly principalCollected: UgxAmount;
  readonly interestCollected: UgxAmount;
  readonly penaltyCollected: UgxAmount;
  readonly byMethod: readonly CollectionSlice[];
  readonly byStaff: readonly CollectionSlice[];
  readonly byBranch: readonly CollectionSlice[];
  readonly byProduct: readonly CollectionSlice[];
  readonly byDay: readonly CollectionSlice[];
  /**
   * Whether the period was read in full.
   *
   * A summary built from a truncated read is a wrong summary, not a partial
   * one, so it says so rather than rendering a figure somebody banks on.
   */
  readonly complete: boolean;
}

/** How many rows one summary will read before it declines to be trusted. */
const ROW_CEILING = 5_000;

const SUMMARY_COLUMNS = `
  payment_id, business_date, payment_method, status, is_effective,
  effective_amount, principal_collected, interest_collected, penalty_collected,
  recorded_by, recorded_by_label, branch_id, branch_name, loan_product_id,
  product_code, product_name
`;

interface Bucket {
  key: string | null;
  label: string;
  paymentCount: number;
  reversedCount: number;
  total: number;
  principal: number;
  interest: number;
  penalty: number;
}

function emptyBucket(key: string | null, label: string): Bucket {
  return {
    key,
    label,
    paymentCount: 0,
    reversedCount: 0,
    total: 0,
    principal: 0,
    interest: 0,
    penalty: 0,
  };
}

function freeze(bucket: Bucket): CollectionSlice {
  return {
    key: bucket.key,
    label: bucket.label,
    paymentCount: bucket.paymentCount,
    reversedCount: bucket.reversedCount,
    totalCollected: toUgx(bucket.total),
    principalCollected: toUgx(bucket.principal),
    interestCollected: toUgx(bucket.interest),
    penaltyCollected: toUgx(bucket.penalty),
  };
}

/** Largest first, which is the order somebody reading a summary wants. */
function byValue(left: CollectionSlice, right: CollectionSlice): number {
  if (right.totalCollected !== left.totalCollected) {
    return right.totalCollected - left.totalCollected;
  }
  return left.label.localeCompare(right.label);
}

const EMPTY_SUMMARY = (from: BusinessDate, to: BusinessDate): CollectionSummary => ({
  from,
  to,
  paymentCount: 0,
  reversedCount: 0,
  totalCollected: toUgx(0),
  principalCollected: toUgx(0),
  interestCollected: toUgx(0),
  penaltyCollected: toUgx(0),
  byMethod: [],
  byStaff: [],
  byBranch: [],
  byProduct: [],
  byDay: [],
  complete: true,
});

/**
 * Collections over a period, by method, staff, branch, product and day.
 *
 * Inclusive of both dates, in business days — `payment_register.business_date`
 * is already the business day the receipt belongs to, so a payment taken at
 * 23:50 lands where the cash drawer says it did.
 */
export async function getCollectionSummary(
  from: BusinessDate,
  to: BusinessDate,
  filter: {
    readonly method?: PaymentMethod | null;
    readonly branchId?: string | null;
    readonly productId?: string | null;
    readonly recordedBy?: string | null;
  } = {},
): Promise<CollectionSummary> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('payment_register')
    .select(SUMMARY_COLUMNS)
    .gte('business_date', from)
    .lte('business_date', to)
    // One past the ceiling, so a truncated read is detectable rather than
    // silently the same shape as a complete one.
    .range(0, ROW_CEILING);

  if (filter.method != null) query = query.eq('payment_method', filter.method);
  if (filter.branchId != null) query = query.eq('branch_id', filter.branchId);
  if (filter.productId != null) query = query.eq('loan_product_id', filter.productId);
  if (filter.recordedBy != null) query = query.eq('recorded_by', filter.recordedBy);

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the collection summary.', { code: error.code });
    return EMPTY_SUMMARY(from, to);
  }

  const rows = data ?? [];
  const complete = rows.length <= ROW_CEILING;

  if (!complete) {
    logger.error('A collection summary read more rows than it will summarise.', {
      from,
      to,
      ceiling: ROW_CEILING,
    });
  }

  const method = new Map<string, Bucket>();
  const staff = new Map<string, Bucket>();
  const branch = new Map<string, Bucket>();
  const product = new Map<string, Bucket>();
  const day = new Map<string, Bucket>();

  let paymentCount = 0;
  let reversedCount = 0;
  let total = 0;
  let principal = 0;
  let interest = 0;
  let penalty = 0;

  const add = (
    into: Map<string, Bucket>,
    key: string | null,
    label: string,
    effective: boolean,
    amounts: { total: number; principal: number; interest: number; penalty: number },
  ): void => {
    const mapKey = key ?? '';
    const bucket = into.get(mapKey) ?? emptyBucket(key, label);

    if (effective) {
      bucket.paymentCount += 1;
      bucket.total += amounts.total;
      bucket.principal += amounts.principal;
      bucket.interest += amounts.interest;
      bucket.penalty += amounts.penalty;
    } else {
      bucket.reversedCount += 1;
    }

    into.set(mapKey, bucket);
  };

  for (const row of rows.slice(0, ROW_CEILING)) {
    const effective = Boolean(row.is_effective);
    const amounts = {
      total: Number(row.effective_amount ?? 0),
      principal: Number(row.principal_collected ?? 0),
      interest: Number(row.interest_collected ?? 0),
      penalty: Number(row.penalty_collected ?? 0),
    };

    if (effective) {
      paymentCount += 1;
      total += amounts.total;
      principal += amounts.principal;
      interest += amounts.interest;
      penalty += amounts.penalty;
    } else {
      reversedCount += 1;
    }

    const methodKey = isPaymentMethod(row.payment_method) ? row.payment_method : 'cash';

    add(method, methodKey, methodKey, effective, amounts);
    add(
      staff,
      row.recorded_by === null ? null : String(row.recorded_by),
      // The label frozen on the payment, so a summary stays readable after an
      // account is archived.
      row.recorded_by_label === null ? 'Unattributed' : String(row.recorded_by_label),
      effective,
      amounts,
    );
    add(
      branch,
      row.branch_id === null ? null : String(row.branch_id),
      row.branch_name === null ? 'No branch' : String(row.branch_name),
      effective,
      amounts,
    );
    add(
      product,
      row.loan_product_id === null ? null : String(row.loan_product_id),
      row.product_name === null ? 'No product' : String(row.product_name),
      effective,
      amounts,
    );
    add(
      day,
      row.business_date === null ? null : String(row.business_date),
      row.business_date === null ? 'Undated' : String(row.business_date),
      effective,
      amounts,
    );
  }

  return {
    from,
    to,
    paymentCount,
    reversedCount,
    totalCollected: toUgx(total),
    principalCollected: toUgx(principal),
    interestCollected: toUgx(interest),
    penaltyCollected: toUgx(penalty),
    byMethod: [...method.values()].map(freeze).sort(byValue),
    byStaff: [...staff.values()].map(freeze).sort(byValue),
    byBranch: [...branch.values()].map(freeze).sort(byValue),
    byProduct: [...product.values()].map(freeze).sort(byValue),
    // Chronological, not by value: a day-by-day column read out of order is
    // unreadable.
    byDay: [...day.values()].map(freeze).sort((a, b) => a.label.localeCompare(b.label)),
    complete,
  };
}
