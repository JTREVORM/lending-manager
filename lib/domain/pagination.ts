/**
 * How a register is paged.
 *
 * ## Why the page size is a fixed set
 *
 * It arrives from the query string and becomes a PostgREST `range`. An
 * arbitrary number there is an invitation to ask a free-tier database for
 * fifty thousand rows in one request, from a URL anybody can edit. Four
 * sizes cover the real uses — a glance, a working page, a long read, a
 * reconciliation — and nothing else is honoured.
 */
export const PAGE_SIZES = [20, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 20;

/** Narrow an unknown value to a page size, falling back to the default. */
export function toPageSize(value: unknown): PageSize {
  const size = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(size)
    ? (size as PageSize)
    : DEFAULT_PAGE_SIZE;
}

/**
 * What a page of a register is showing, in words.
 *
 * `Showing 1–20 of 35 loans`, and `Showing 21–35 of 35 loans` on the last
 * page. The range is computed from the page and the rows actually returned,
 * not from the page size: the final page is shorter, and saying `21–40 of
 * 35` would be both wrong and the kind of wrong that makes a reader distrust
 * the figures beside it.
 *
 * `total` is optional because not every register can afford an exact count.
 * Without one the sentence says what it honestly knows — how many rows are
 * on this page, and whether there are more — rather than implying a total it
 * has not been given.
 */
export function describePage({
  page,
  pageSize,
  rows,
  total,
  noun,
  pluralNoun,
}: {
  readonly page: number;
  readonly pageSize: number;
  readonly rows: number;
  readonly total?: number | null;
  readonly noun: string;
  readonly pluralNoun?: string;
}): string {
  const plural = pluralNoun ?? `${noun}s`;

  if (rows === 0) {
    return total === 0 || total === undefined || total === null
      ? `No ${plural}`
      : `No ${plural} on this page`;
  }

  const first = (page - 1) * pageSize + 1;
  const last = first + rows - 1;
  const range = `${first.toLocaleString('en-UG')}–${last.toLocaleString('en-UG')}`;

  if (total === undefined || total === null) {
    return `Showing ${range} ${rows === 1 ? noun : plural}`;
  }

  return `Showing ${range} of ${total.toLocaleString('en-UG')} ${total === 1 ? noun : plural}`;
}

/** How many pages a total divides into. Zero rows is still one page. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
