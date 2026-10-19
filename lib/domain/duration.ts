/**
 * Durations, written the way a person says them.
 *
 * The register used to print `1 mo`. Three characters saved, and a reader who
 * has to decode them — on a screen whose whole job is to be read quickly by
 * somebody with a borrower in front of them. An abbreviation is a cost moved
 * from the designer to the reader, and in a financial register that is the
 * wrong direction.
 *
 * Singular and plural are decided here and nowhere else. Done per screen it
 * drifts: `1 months` appears, then `1 month(s)`, then somebody adds `1 mo` to
 * make the column fit again.
 *
 * These return plain strings. A column that is too narrow for `12 months` is
 * a column with the wrong minimum width, not a reason to shorten the words —
 * see `TABLE_COLUMN_WIDTHS` in `components/ui/data-table.tsx`.
 */

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

/** `1 month`, `6 months`. */
export function formatMonths(months: number): string {
  return plural(months, 'month');
}

/** `1 day`, `45 days`. */
export function formatDays(days: number): string {
  return plural(days, 'day');
}

/** `1 week`, `3 weeks`. */
export function formatWeeks(weeks: number): string {
  return plural(weeks, 'week');
}

/** `1 year`, `2 years`. */
export function formatYears(years: number): string {
  return plural(years, 'year');
}

/**
 * A count of records, with its noun — `1 loan`, `35 loans`.
 *
 * The irregular plurals this application needs are passed in rather than
 * guessed at: `plural` would turn "entry" into "entrys".
 */
export function formatCount(
  count: number,
  singular: string,
  pluralForm?: string,
): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count.toLocaleString('en-UG')} ${word}`;
}

/**
 * How late something is, in words — `4 days late`, `1 day late`, `Not late`.
 *
 * Zero is a real answer and says so, rather than printing `0 days late`,
 * which reads for a moment as though it were late.
 */
export function formatDaysLate(days: number): string {
  if (days <= 0) return 'Not late';
  return `${formatDays(days)} late`;
}
