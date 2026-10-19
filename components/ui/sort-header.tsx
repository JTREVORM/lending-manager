'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Chevron } from '@/components/ui/chevron';
import { cn } from '@/lib/utils/cn';

/**
 * A column header that sorts.
 *
 * ## It sorts the register, not the page
 *
 * The sort goes into the URL, the server reads it, and the database applies
 * `ORDER BY` **before** the page is cut. Sorting the twenty rows already
 * fetched would reorder what is on screen and quietly lie: "largest
 * principal" would mean "largest of the twenty oldest", which on a register
 * of four thousand loans is not an answer to the question asked.
 *
 * It is a link, not a button. A sorted register is a URL you can share,
 * reload and go back from, and that is what a link means.
 *
 * ## Only columns that really sort get a caret
 *
 * A header with no caret is a header that does not sort. That is a more
 * honest interface than one which appears to and does nothing, and it is why
 * this is opt-in per column rather than applied to every header at once.
 * A column can only sort if the database can order by it — a figure the view
 * computes per row can; a label assembled in TypeScript cannot.
 */

export type SortDirection = 'asc' | 'desc';

export function SortHeader({
  /** The column's key, as the server's sort parameter expects it. */
  column,
  /** Which column the register is currently sorted by, if any. */
  active,
  direction,
  children,
  /**
   * Which way the first click sorts. A date or an amount is most useful
   * largest-first; a name is most useful A–Z.
   */
  defaultDirection = 'asc',
  numeric = false,
}: {
  readonly column: string;
  readonly active: string | null;
  readonly direction: SortDirection;
  readonly children: string;
  readonly defaultDirection?: SortDirection;
  readonly numeric?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const isActive = active === column;
  const next: SortDirection = isActive
    ? direction === 'asc'
      ? 'desc'
      : 'asc'
    : defaultDirection;

  const query = new URLSearchParams(params.toString());
  query.set('sort', column);
  query.set('dir', next);
  // A re-sort returns to the first page. Page four of a differently ordered
  // register is a different set of rows, shown without saying so.
  query.delete('page');

  const glyph = isActive ? (direction === 'asc' ? 'up' : 'down') : 'both';

  return (
    <a
      href={`${pathname}?${query.toString()}`}
      onClick={(event) => {
        // Let a modified click open a new tab the way any link would.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        startTransition(() => {
          router.replace(`${pathname}?${query.toString()}`);
        });
      }}
      // The column header *is* the sort control, so the state belongs on the
      // `<th>` around it — `aria-sort` is what a screen reader reads to say
      // "sorted ascending". The caller puts it there; this says which way.
      data-sort-direction={isActive ? direction : 'none'}
      className={cn(
        'group focus-visible:outline-accent inline-flex items-center gap-1 rounded focus-visible:outline-2 focus-visible:outline-offset-2',
        numeric ? 'flex-row-reverse' : undefined,
        isActive ? 'text-text' : 'hover:text-text',
        isPending ? 'opacity-60' : undefined,
      )}
    >
      {children}
      <Chevron
        direction={glyph}
        className={cn(
          'size-3 shrink-0',
          isActive ? 'opacity-100' : 'opacity-40 group-hover:opacity-70',
        )}
      />
      <span className="sr-only">
        {isActive
          ? `, sorted ${direction === 'asc' ? 'ascending' : 'descending'}. Activate to sort ${next === 'asc' ? 'ascending' : 'descending'}.`
          : `, not sorted. Activate to sort ${next === 'asc' ? 'ascending' : 'descending'}.`}
      </span>
    </a>
  );
}

/** What a `<th>` should report to a screen reader for a given column. */
export function ariaSortFor(
  column: string,
  active: string | null,
  direction: SortDirection,
): 'ascending' | 'descending' | 'none' {
  if (active !== column) return 'none';
  return direction === 'asc' ? 'ascending' : 'descending';
}
