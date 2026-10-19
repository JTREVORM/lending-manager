'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
 * What this page is showing, and out of what.
 *
 * Deliberately does not claim a total it was not given. A register is paged
 * server-side and knows only its own rows plus whether another page exists;
 * an exact "of 4,812" would mean a second `count(*)` over the whole filtered
 * set on every page view, which on these tables is the expensive query, not
 * the cheap one. So the honest sentence is the one it can afford: how many
 * rows are on this page, which page it is, and that there are more.
 *
 * `total` exists for the few callers whose query already returns a count as
 * part of the answer — a report that aggregates anyway. Nothing computes one
 * merely to fill this line in.
 */
export function RegisterCount({
  shown,
  page,
  hasMore,
  noun,
  total,
}: {
  readonly shown: number;
  readonly page: number;
  readonly hasMore: boolean;
  /** Singular; pluralised with an `s`. */
  readonly noun: string;
  /** Only when the query already knew it. */
  readonly total?: number;
}) {
  const label = shown === 1 ? noun : `${noun}s`;

  if (total !== undefined) {
    return (
      <>
        Showing {shown} of {total} {total === 1 ? noun : `${noun}s`}
        {page > 1 ? ` · page ${String(page)}` : ''}
      </>
    );
  }

  return (
    <>
      {shown} {label} on this page
      {page > 1 ? ` · page ${String(page)}` : ''}
      {hasMore ? ' · more to come' : ''}
    </>
  );
}

const CONTROL =
  'border-border-strong bg-surface text-text hover:bg-surface-hover focus-visible:outline-accent min-h-touch rounded-lg border px-4 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 md:min-h-0 md:py-2';

/**
 * Previous and next, and nothing else.
 *
 * No total page count, for the reason `RegisterCount` gives: "is there
 * another page" is answered by fetching one row more than the page needs,
 * and an exact page count is a second full scan.
 *
 * The visible label and the accessible name are the same words. An
 * `aria-label` that paraphrases visible text is two strings to keep in step,
 * and it breaks voice control for anyone who says what they can see.
 */
export function RegisterPagination({
  page,
  hasMore,
}: {
  readonly page: number;
  readonly hasMore: boolean;
}) {
  const { goToPage } = useQueryFilters();

  if (page <= 1 && !hasMore) return null;

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 print:hidden"
    >
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => {
          goToPage(page - 1);
        }}
        className={CONTROL}
      >
        Previous
      </button>

      <span className="text-text-muted text-[13px]">Page {String(page)}</span>

      <button
        type="button"
        disabled={!hasMore}
        onClick={() => {
          goToPage(page + 1);
        }}
        className={CONTROL}
      >
        Next
      </button>
    </nav>
  );
}
