'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useTransition, type ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Chevron } from '@/components/ui/chevron';
import { PAGE_SIZES, describePage, pageCount } from '@/lib/domain/pagination';
import { cn } from '@/lib/utils/cn';

/**
 * The parts of a register that are not its columns.
 *
 * The loan, client and payment registers each grew their own search box,
 * their own "N loans" line and their own Previous/Next pair, and the three
 * had drifted: different control heights, different labels, one of them
 * reporting the page's row count as though it were the result count. A
 * register is a recognisable thing, so it is one component.
 *
 * ## Filters live in the URL
 *
 * Every control here writes to the query string and lets the server re-run
 * the query. That is not a style preference:
 *
 *   - a filtered view can be reloaded, shared and bookmarked;
 *   - filtering happens in the database, so Row Level Security applies to the
 *     filtered query rather than to a full list trimmed in the browser;
 *   - the browser never holds the whole register, which is what keeps a
 *     20,000-row payment history off a field officer's phone.
 *
 * Changing any filter returns to page one. Staying on page four of a
 * different result set shows an empty screen for no visible reason.
 */

function useQueryFilters(): {
  readonly apply: (key: string, value: string) => void;
  readonly goToPage: (page: number) => void;
  readonly setPageSize: (size: string) => void;
  readonly isPending: boolean;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function write(mutate: (params: URLSearchParams) => void): void {
    const next = new URLSearchParams(searchParams.toString());
    mutate(next);
    const query = next.toString();
    startTransition(() => {
      router.replace(query === '' ? pathname : `${pathname}?${query}`);
    });
  }

  return {
    apply: (key, value) => {
      write((params) => {
        if (value === '') params.delete(key);
        else params.set(key, value);
        params.delete('page');
      });
    },
    goToPage: (page) => {
      write((params) => {
        if (page <= 1) params.delete('page');
        else params.set('page', String(page));
      });
    },
    setPageSize: (size) => {
      write((params) => {
        params.set('pageSize', size);
        // Page four of twenty-row pages is past the end of hundred-row ones.
        params.delete('page');
      });
    },
    isPending,
  };
}

export interface RegisterSelect {
  readonly id: string;
  readonly label: string;
  /** The query-string key this control writes. */
  readonly param: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/**
 * The filter bar: a search field and up to two selects, over the result line.
 *
 * The search commits on Enter and on blur rather than on every keystroke. A
 * register's search re-runs a server query against a live financial table;
 * debounced per-keystroke search would put ten queries behind one word, which
 * on a Supabase free tier is the difference between a register that answers
 * and one that times out.
 */
export function RegisterFilters({
  search,
  selects = [],
  summary,
  children,
}: {
  readonly search?: {
    readonly id: string;
    readonly label: string;
    readonly param: string;
    readonly value: string;
    readonly placeholder: string;
  };
  readonly selects?: readonly RegisterSelect[];
  /** The result line. Usually a `<RegisterCount>`. */
  readonly summary?: ReactNode;
  /** Anything the register needs beside the filters — an export control. */
  readonly children?: ReactNode;
}) {
  const { apply, isPending } = useQueryFilters();

  const columns =
    selects.length === 0
      ? 'sm:grid-cols-1'
      : selects.length === 1
        ? 'sm:grid-cols-[2fr_1fr]'
        : 'sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]';

  return (
    <Card className="min-w-0 space-y-4 print:hidden">
      <div className={cn('grid min-w-0 gap-4', columns)}>
        {search === undefined ? null : (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor={search.id}>{search.label}</Label>
            <Input
              id={search.id}
              type="search"
              inputMode="search"
              defaultValue={search.value}
              placeholder={search.placeholder}
              onBlur={(event) => {
                apply(search.param, event.target.value.trim());
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  apply(search.param, event.currentTarget.value.trim());
                }
              }}
            />
          </div>
        )}

        {selects.map((select) => (
          <div key={select.id} className="min-w-0 space-y-1.5">
            <Label htmlFor={select.id}>{select.label}</Label>
            <select
              id={select.id}
              defaultValue={select.value}
              onChange={(event) => {
                apply(select.param, event.target.value);
              }}
              className="border-border bg-surface text-text focus-visible:outline-accent h-11 w-full min-w-0 rounded-lg border px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {select.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {children}

      {summary === undefined ? null : (
        <div aria-live="polite" className="text-text-muted text-[13px]">
          {isPending ? 'Searching…' : summary}
        </div>
      )}
    </Card>
  );
}

/**
 * The pagination bar: what is on screen, how much fits, and the way through.
 *
 * ```
 * Showing 1–20 of 35 loans        Rows per page [20 ▾]   ‹ 1 2 ›
 * ```
 *
 * ## The total is only claimed when it is known
 *
 * `total` comes from PostgREST's `count=exact`, on the same request as the
 * rows. Where a register can afford that, the line reads "of 35" and the
 * page numbers are real. Where it cannot, `total` is null and the line says
 * only what it knows — the range on this page — with Previous and Next. A
 * figure printed after the word "of" has to be right, so a register never
 * estimates one.
 *
 * ## The page numbers
 *
 * Shown only with a total, because without one there is no last page to
 * number. Long registers get a window around the current page with the first
 * and last always reachable, rather than four hundred buttons.
 */
function pageWindow(current: number, last: number): readonly (number | 'gap')[] {
  if (last <= 7) {
    return Array.from({ length: last }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, last, current]);
  for (const offset of [-1, 1]) {
    const near = current + offset;
    if (near > 1 && near < last) pages.add(near);
  }
  // Keep the window the same width wherever it sits, so the control does not
  // change size as a reader pages through it.
  if (current <= 3) pages.add(2).add(3).add(4);
  if (current >= last - 2)
    pages
      .add(last - 1)
      .add(last - 2)
      .add(last - 3);

  const ordered = [...pages]
    .filter((page) => page >= 1 && page <= last)
    .sort((a, b) => a - b);

  const out: (number | 'gap')[] = [];
  let previous = 0;
  for (const page of ordered) {
    if (previous !== 0 && page - previous > 1) out.push('gap');
    out.push(page);
    previous = page;
  }
  return out;
}

const STEP =
  'border-border-strong bg-surface text-text hover:bg-surface-hover focus-visible:outline-accent inline-flex size-8 items-center justify-center rounded-md border focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-35';

const NUMBER =
  'focus-visible:outline-accent inline-flex size-8 items-center justify-center rounded-md border text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2';

export function RegisterPagination({
  page,
  pageSize,
  rows,
  hasMore,
  total,
  noun,
  pluralNoun,
}: {
  readonly page: number;
  readonly pageSize: number;
  /** How many rows this page actually returned. */
  readonly rows: number;
  readonly hasMore: boolean;
  /** Null where the register does not buy an exact count. */
  readonly total?: number | null;
  readonly noun: string;
  readonly pluralNoun?: string;
}) {
  const { goToPage, setPageSize } = useQueryFilters();
  const sizeId = useId();

  const last = total === undefined || total === null ? null : pageCount(total, pageSize);
  const summary = describePage({
    page,
    pageSize,
    rows,
    ...(total === undefined ? {} : { total }),
    noun,
    ...(pluralNoun === undefined ? {} : { pluralNoun }),
  });

  return (
    <nav
      aria-label="Pagination"
      className="border-border flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t px-4 py-3 print:hidden"
    >
      <p aria-live="polite" className="text-text-muted text-[13px]">
        {summary}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          {/*
            The label is there on every width and visible from `sm` up. On a
            375px phone the bar is already two rows, and "Rows per page"
            wrapping to three lines beside a 60px select is the control
            taking more room than the thing it controls. Hidden, not
            removed: the select keeps the label as its accessible name.
          */}
          <label
            htmlFor={sizeId}
            className="text-text-muted sr-only text-[13px] sm:not-sr-only"
          >
            Rows per page
          </label>
          <select
            id={sizeId}
            value={pageSize}
            onChange={(event) => {
              setPageSize(event.target.value);
            }}
            /*
              `pr-7` leaves room for the native caret. Without it the glyph
              is drawn over the last digit, and `100` reads as `10`.
            */
            className="border-border-strong bg-surface text-text focus-visible:outline-accent h-8 rounded-md border py-0 pr-7 pl-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => {
              goToPage(page - 1);
            }}
            className={STEP}
          >
            <Chevron direction="left" className="size-4" />
          </button>

          {last === null ? (
            <span className="text-text-muted px-2 text-[13px]">Page {page}</span>
          ) : (
            pageWindow(page, last).map((entry, index) =>
              entry === 'gap' ? (
                <span
                  key={`gap-${String(index)}`}
                  aria-hidden="true"
                  className="text-text-muted px-1 text-[13px]"
                >
                  …
                </span>
              ) : (
                <button
                  key={entry}
                  type="button"
                  aria-label={`Page ${String(entry)}`}
                  aria-current={entry === page ? 'page' : undefined}
                  onClick={() => {
                    goToPage(entry);
                  }}
                  className={cn(
                    NUMBER,
                    entry === page
                      ? 'border-accent bg-accent text-accent-contrast'
                      : 'border-border-strong bg-surface text-text hover:bg-surface-hover',
                  )}
                >
                  {entry}
                </button>
              ),
            )
          )}

          <button
            type="button"
            aria-label="Next page"
            disabled={last === null ? !hasMore : page >= last}
            onClick={() => {
              goToPage(page + 1);
            }}
            className={STEP}
          >
            <Chevron direction="right" className="size-4" />
          </button>
        </div>
      </div>
    </nav>
  );
}
