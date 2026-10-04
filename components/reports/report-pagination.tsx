'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';

/**
 * Previous and next, and nothing else.
 *
 * No total page count, deliberately. Knowing there are 47 pages helps nobody
 * clicking through a collection report, and an exact count means a second
 * `count(*)` over the whole filtered set on every page view. "Is there
 * another page" is answered by fetching one row more than the page needs —
 * the Phase 7 overdue list's approach.
 */
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
    <nav
      aria-label="Report pages"
      className="flex flex-wrap items-center justify-between gap-3 print:hidden"
    >
      <p className="text-text-muted text-sm" aria-live="polite">
        Page {page} · {rowsShown} {rowsShown === 1 ? 'row' : 'rows'} shown
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => {
            go(page - 1);
          }}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!hasMore}
          onClick={() => {
            go(page + 1);
          }}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
