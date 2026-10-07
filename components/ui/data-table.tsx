import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The shell every data table in this application sits in.
 *
 * ## The reference's table
 *
 * Measured off `MisKit.tsx`, which is what every list screen in the reference
 * project renders through:
 *
 *   - wrapper `rounded-lg border border-slate-200 bg-white shadow-xs`,
 *     horizontally scrollable;
 *   - body at `text-[11px]`, cells `px-2 py-2.5`;
 *   - header `bg-slate-50 text-[10px] font-bold uppercase tracking-wide
 *     text-slate-500`;
 *   - rows separated by `divide-slate-100`, not a border per cell, and
 *     `hover:bg-slate-50`;
 *   - `whitespace-nowrap` on both header and body cells, with the wrapper
 *     scrolling rather than the text wrapping — a repayment schedule is read
 *     across, and a wrapped figure column is unreadable.
 *
 * That density is the point of it. These screens put twelve columns of
 * currency in front of a loan officer, and 11px with 10px uppercase headers is
 * what fits them on a laptop without a horizontal scroll.
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
        // The reference's panel + its horizontal scroll, and the shared
        // scrollbar skin so this region looks like every other scroller.
        'border-border bg-surface scroll-area scroll-x min-w-0 rounded-lg border shadow-xs',
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
        className={cn(
          // `text-[11px]` is the reference's table size; `divide-y` on the
          // body replaces a border on every cell.
          'w-full border-collapse text-left text-[11px]',
          className,
        )}
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
  /**
   * Accepted for the callers that pass it, and ignored: a header cell is
   * always `nowrap` now, as it is in the reference. Kept rather than removed
   * so the thirty-odd `<TableHead nowrap>` call sites keep compiling and the
   * intent they express is still the behaviour they get.
   *
   * @deprecated Header cells never wrap; drop the prop.
   */
  readonly nowrap?: boolean;
}

export function TableHead({
  children,
  align = 'text',
  scope = 'col',
  className,
}: TableHeadProps) {
  return (
    <th
      scope={scope}
      className={cn(
        // The reference's header cell: slate-50 fill, 10px bold uppercase in
        // the muted grey, `px-2 py-2.5`. It never wraps — a two-line header
        // row above an eleven-column table is what the nowrap prevents.
        't-th border-border bg-surface-sunken border-b px-2 py-2.5 whitespace-nowrap',
        ALIGN[align],
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
  /**
   * Keeps the cell on one line. On by default, as in the reference: a
   * currency or date column that wraps is harder to read than one the table
   * scrolls to reach. Pass `false` for a free-text column such as a remark.
   */
  readonly nowrap?: boolean;
}

export function TableCell({
  children,
  align = 'text',
  className,
  colSpan,
  header = false,
  nowrap = true,
}: TableCellProps) {
  const classes = cn(
    // `px-2 py-2.5`, the reference's cell padding, with its hairline row rule.
    'border-border/60 border-b px-2 py-2.5 align-middle',
    ALIGN[align],
    header ? 'text-text font-semibold' : 'text-text',
    nowrap ? 'whitespace-nowrap' : undefined,
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
        // The reference hovers every row of a result set, not only the ones
        // that link out — it is how you keep your place reading across twelve
        // columns. `interactive` additionally marks the pointer.
        'hover:bg-surface-hover transition-colors duration-150',
        interactive ? 'cursor-pointer' : undefined,
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
        // The reference's footer strip: the slate-50 fill at 60%, above a
        // slate-200 rule.
        'border-border bg-surface-sunken/60 border-t',
        '[&>td]:border-b-0 [&>td]:font-bold [&>th]:border-b-0 [&>th]:font-bold',
        className,
      )}
    >
      {children}
    </tr>
  );
}

/**
 * One record as a pale blue panel of "Label :Value" lines.
 *
 * This is how the reference renders a table on a phone: it does not shrink the
 * table or let it scroll sideways under a thumb — below `md` each row becomes
 * a `#eaf1f8` panel, every column a `Label :Value` line in 13px, and the row's
 * action buttons gather into a right-aligned strip at the foot of the panel.
 *
 * Twelve columns of currency cannot be read on a 390px screen as a table, and
 * a horizontally scrolling table is worse: you lose the row you were on. The
 * panel is the reference's answer and this is it, available to the screens
 * that already build their own mobile lists.
 *
 * The desktop table and this panel are two renderings of the same data, so
 * only one is ever visible — the caller hides the table below `md` and this
 * above it. `globals.css` also hides `.md\:hidden` when printing, so a
 * printed report carries the table and not both.
 */
export function RecordPanel({
  rows,
  actions,
  className,
}: {
  readonly rows: readonly { readonly label: string; readonly value: ReactNode }[];
  /** The row's action buttons, as a right-aligned strip at the foot. */
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('record-panel', className)}>
      {rows.map((row) => (
        <p key={row.label}>
          <span className="font-bold">{row.label} :</span>
          <span className="ml-1 break-words">{row.value}</span>
        </p>
      ))}
      {actions === undefined ? null : (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * A square icon action, sized for the context it appears in.
 *
 * The reference's `ActionButton`: `h-11 w-11 rounded-lg` with a 20px icon on a
 * phone, collapsing to `h-6 w-6 rounded` with a 14px icon inside a dense
 * desktop table row. The tones are its five — the navy, the sky blue, amber,
 * emerald and red it uses to tell one row action from another at a glance.
 */
const ACTION_TONES = {
  navy: 'bg-accent hover:bg-accent-hover',
  blue: 'bg-sky-500 hover:bg-sky-600',
  amber: 'bg-accent-2 hover:bg-[#f59e0b]',
  green: 'bg-emerald-500 hover:bg-emerald-600',
  red: 'bg-danger hover:opacity-90',
} as const;

export function RowAction({
  tone = 'navy',
  label,
  className,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-label'> & {
  readonly tone?: keyof typeof ACTION_TONES;
  /** Required: an icon-only control must still say what it does. */
  readonly label: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-11 w-11 items-center justify-center rounded-lg text-white [&>svg]:size-5',
        'md:h-6 md:w-6 md:rounded md:[&>svg]:size-3.5',
        'pressable disabled:cursor-not-allowed disabled:opacity-50',
        ACTION_TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
