/**
 * Aging and portfolio at risk.
 *
 * Pure. Both figures come out of the database — `loan_aging` buckets a loan
 * from `days_past_due` and `portfolio_at_risk` divides outstanding principal
 * past due by outstanding principal — and this module is the vocabulary for
 * them plus the one arithmetic the screens genuinely need, which is turning a
 * basis-point ratio into something a person reads.
 *
 * ## Why the buckets are not computed here
 *
 * A bucket is a `case` over one column in one view, deliberately, so that a
 * screen and a report cannot disagree about whether a loan is 30 days late or
 * 31. `bucketForDaysPastDue` exists to mirror it for previews and for the
 * parity test that holds the two definitions together — not as a second
 * opinion a page may prefer.
 */

export const AGING_BUCKETS = [
  'current',
  '1_7',
  '8_30',
  '31_60',
  '61_90',
  '90_plus',
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function isAgingBucket(value: unknown): value is AgingBucket {
  return (
    typeof value === 'string' && (AGING_BUCKETS as readonly string[]).includes(value)
  );
}

export const AGING_BUCKET_LABELS: Readonly<Record<AgingBucket, string>> = {
  current: 'Current',
  '1_7': '1–7 days',
  '8_30': '8–30 days',
  '31_60': '31–60 days',
  '61_90': '61–90 days',
  '90_plus': 'Over 90 days',
};

export const AGING_BUCKET_DESCRIPTIONS: Readonly<Record<AgingBucket, string>> = {
  current: 'Nothing past due, counting the grace period.',
  '1_7': 'Just slipped. Usually a phone call.',
  '8_30': 'Past the grace period on most products. Penalties are running.',
  '31_60': 'A month behind. Field visit territory.',
  '61_90': 'Two months behind. Guarantors and security come into it.',
  '90_plus': 'Three months or more. Treated as doubtful.',
};

/** Ordered as a register shows them, because the labels do not sort. */
export const AGING_BUCKET_ORDER: Readonly<Record<AgingBucket, number>> = {
  current: 0,
  '1_7': 1,
  '8_30': 2,
  '31_60': 3,
  '61_90': 4,
  '90_plus': 5,
};

/** The mirror of the view's `case`. Kept honest by a parity test. */
export function bucketForDaysPastDue(daysPastDue: number | null): AgingBucket {
  if (daysPastDue === null || daysPastDue <= 0) return 'current';
  if (daysPastDue <= 7) return '1_7';
  if (daysPastDue <= 30) return '8_30';
  if (daysPastDue <= 60) return '31_60';
  if (daysPastDue <= 90) return '61_90';
  return '90_plus';
}

/** The thresholds PAR is quoted at, in days. */
export const PAR_THRESHOLDS = [1, 7, 30, 60, 90] as const;

export type ParThreshold = (typeof PAR_THRESHOLDS)[number];

export const PAR_LABELS: Readonly<Record<ParThreshold, string>> = {
  1: 'PAR 1',
  7: 'PAR 7',
  30: 'PAR 30',
  60: 'PAR 60',
  90: 'PAR 90',
};

export const PAR_DESCRIPTIONS: Readonly<Record<ParThreshold, string>> = {
  1: 'Outstanding principal on loans at least one day past due.',
  7: 'Outstanding principal on loans at least a week past due.',
  30: 'Outstanding principal on loans at least thirty days past due.',
  60: 'Outstanding principal on loans at least sixty days past due.',
  90: 'Outstanding principal on loans at least ninety days past due.',
};

/**
 * A ratio in basis points as a percentage string.
 *
 * One decimal place: PAR moves in tenths of a percent on a book this size, and
 * two decimals invite a reader to treat noise as a trend. `null` renders as a
 * dash rather than as 0.0% — a branch with no active loans has no PAR, and
 * zero would read as perfect health.
 */
export function formatRatioBps(bps: number | null): string {
  if (bps === null) return '—';
  return `${(bps / 100).toFixed(1)}%`;
}

/**
 * Is this ratio one to worry about?
 *
 * A presentation hint only, and deliberately not configurable: nothing is
 * decided by it, no figure changes, and a business setting for "what counts as
 * bad" would be a number somebody tunes until the dashboard looks calm.
 */
export function ratioSeverity(bps: number | null): 'unknown' | 'ok' | 'watch' | 'bad' {
  if (bps === null) return 'unknown';
  if (bps >= 1500) return 'bad';
  if (bps >= 500) return 'watch';
  return 'ok';
}
