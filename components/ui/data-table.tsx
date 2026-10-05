import type { ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The shell every data table in this application sits in.
 *
 * It does not own the rows — each screen knows its own columns and its own
 * mobile card layout — but it owns the things that went wrong when each table
 * owned them separately:
 *
 *   - **Horizontal overflow belongs to the table, never the page.** The
 *     wrapper scrolls; `body { overflow-x: hidden }` means a table that
 *     escaped its wrapper would silently clip instead of scrolling, so the
 *     wrapper is not optional.
 *   - **A sticky header** once a list is long enough to scroll past it.
 *     Reading the eleventh row of a payments register and having to scroll up
 *     to remember which column is the amount is a real cost.
 *   - **A caption.** Tables are announced by their caption; a screen-reader
 *     user arriving at an unlabelled grid of numbers has to read cells to work
 *     out what they are looking at. Visually hidden, always present.
 *   - **Numeric columns are right-aligned**, through `align="numeric"` rather
 *     than a `text-right` remembered per cell.
 */

export interface DataTableProps {
  /**
   * What this table is, for a screen reader. Visually hidden — the visible
   * section heading usually says the same thing, but a table must carry its
   * own label because it can be navigated to directly.
   */
  readonly caption: string;
  /** Keeps the header row visible while the body scrolls. */
  readonly stickyHeader?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  /** Applied to the scrolling wrapper, e.g. a max height. */
  readonly containerClassName?: string;
}

export function DataTable({
  caption,
  stickyHeader = false,
  children,
  className,
  containerClassName,
}: DataTableProps) {
  return (
    <div
      className={cn(
        'border-border bg-surface elevation-1 min-w-0 overflow-x-auto rounded-lg border',
        containerClassName,
      )}
      data-data-table=""
    >
      {/* `data-sticky-header` is read by one rule in globals.css. It has to be
          the `<th>` that is sticky, not the `<thead>` — a sticky thead does
          nothing in most browsers — and keying off an attribute means callers
          keep writing ordinary `<th>` elements. */}
      <table
        {...(stickyHeader ? { 'data-sticky-header': '' } : {})}
        className={cn('w-full border-collapse text-left text-sm', className)}
      >
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

const ALIGN = {
  text: 'text-left',
  numeric: 'text-right',
  center: 'text-center',
} as const;

export interface TableHeadProps {
  readonly children: ReactNode;
  readonly align?: keyof typeof ALIGN;
  readonly scope?: 'col' | 'row';
  readonly className?: string;
  /** Keeps a short heading on one line, e.g. "Days late". */
  readonly nowrap?: boolean;
}

export function TableHead({
  children,
  align = 'text',
  scope = 'col',
  className,
  nowrap = false,
}: TableHeadProps) {
  return (
    <th
      scope={scope}
      className={cn(
        'text-text-muted border-border bg-surface-raised border-b px-3 py-2.5 text-xs font-semibold tracking-wide uppercase',
        ALIGN[align],
        nowrap ? 'whitespace-nowrap' : undefined,
        className,
      )}
    >
      {children}
    </th>
  );
}

export interface TableCellProps {
  readonly children: ReactNode;
  readonly align?: keyof typeof ALIGN;
  readonly className?: string;
  readonly colSpan?: number;
  /** Renders as a `<th scope="row">` — the cell that names the row. */
  readonly header?: boolean;
}

export function TableCell({
  children,
  align = 'text',
  className,
  colSpan,
  header = false,
}: TableCellProps) {
  const classes = cn(
    'border-border border-b px-3 py-2.5 align-middle',
    ALIGN[align],
    header ? 'text-text font-medium' : 'text-text',
    className,
  );

  if (header) {
    return (
      <th scope="row" className={classes} {...(colSpan === undefined ? {} : { colSpan })}>
        {children}
      </th>
    );
  }

  return (
    <td className={classes} {...(colSpan === undefined ? {} : { colSpan })}>
      {children}
    </td>
  );
}

/** A row. `interactive` adds the hover affordance for a row that links out. */
export function TableRow({
  children,
  interactive = false,
  className,
}: {
  readonly children: ReactNode;
  readonly interactive?: boolean;
  readonly className?: string;
}) {
  return (
    <tr
      className={cn(
        'last:[&>td]:border-b-0 last:[&>th]:border-b-0',
        interactive ? 'hover:bg-surface-hover transition-colors duration-150' : undefined,
        className,
      )}
    >
      {children}
    </tr>
  );
}

/**
 * The totals row.
 *
 * Visually separated and marked with `data-total`, which the parity tests use
 * to prove the figure in the footer is the one the query returned rather than
 * a sum the component worked out for itself.
 */
export function TableFootRow({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <tr
      data-total=""
      className={cn(
        'bg-surface-raised [&>td]:border-b-0 [&>td]:font-semibold [&>th]:border-b-0 [&>th]:font-semibold',
        className,
      )}
    >
      {children}
    </tr>
  );
}
