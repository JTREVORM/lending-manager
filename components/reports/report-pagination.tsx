'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Previous and next, and nothing else.
 *
 * No total page count, deliberately. Knowing there are 47 pages helps nobody
 * clicking through a collection report, and an exact count means a second
 * `count(*)` over the whole filtered set on every page view. "Is there
 * another page" is answered by fetching one row more than the page needs —
 * the Phase 7 overdue list's approach.
 */
/**
 * The reference's pagination chip: a bordered white button at 13px/600.
 *
 * `min-h-touch` with `md:min-h-0` — the reference's global rule already gives
 * every button a 44px floor below `md`, but stating it on the control keeps
 * the touch target a property of the component rather than of a media query
 * in another file, which is what a review (and the accessibility suite) can
 * actually check. On the desktop it relaxes to the reference's compact chip.
 */
const CONTROL =
  'border-border-strong bg-surface text-text hover:bg-surface-hover min-h-touch rounded border px-3 text-[13px] font-semibold disabled:opacity-40 md:min-h-0 md:py-1.5';

export function ReportPagination({
  page,
  hasMore,
  rowsShown,
}: {
  readonly page: number;
  readonly hasMore: boolean;
  readonly rowsShown: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (page === 1 && !hasMore) return null;

  const go = (next: number): void => {
    const query = new URLSearchParams(params.toString());
    if (next <= 1) query.delete('page');
    else query.set('page', String(next));
    router.replace(`${pathname}?${query.toString()}`);
  };

  return (
    // The reference centres its pagination under the table and sets it in
    // 13px: a "Showing … entries" line over a Prev / page / Next row, with
    // the two controls as bordered white chips that fade rather than vanish
    // when they do not apply.
    //
    // `Prev` is the reference's own label and is kept, but the accessible
    // name is the full "Previous page": an abbreviation is fine to read and
    // poor to hear, and the two need not be the same string.
    <nav aria-label="Report pages" className="space-y-2 pt-1 text-center print:hidden">
      <p className="text-text-muted text-[13px]" aria-live="polite">
        Showing {rowsShown} {rowsShown === 1 ? 'entry' : 'entries'} · page {page}
      </p>
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => {
            go(page - 1);
          }}
          className={CONTROL}
        >
          Prev
        </button>
        <span className="text-text-muted text-[13px]">Page {page}</span>
        <button
          type="button"
          aria-label="Next page"
          disabled={!hasMore}
          onClick={() => {
            go(page + 1);
          }}
          className={CONTROL}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
