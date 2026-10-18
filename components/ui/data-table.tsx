import { isValidElement } from 'react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The shell every data table in this application sits in.
 *
 * ## The defect this layer exists to prevent
 *
 * A `<table class="w-full">` under auto layout distributes the container's
 * width by what each column would *like*. When the preferred widths add up to
 * more than the container — which ten columns of a loan register always do on
 * a laptop — the browser does not overflow. It compresses whichever column
 * compresses most, and that column wraps. In practice that is always the
 * borrower's name or the product's, because a date and a figure are short and
 * a name is not.
 *
 * Before this layer, fourteen registers wrote their own table and every one of
 * them hit it the same way: `whitespace-nowrap` on the header cells and
 * nothing on the body cells, so the headings held their width and the *data*
 * broke. "Nakabugo Ssemakula" over two lines, `UGX` on one line and the figure
 * on the next, a status pill folded in half.
 *
 * Two rules fix it, and they are the reason this file exists rather than a
 * convention each screen is asked to remember:
 *
 *   1. **A body cell does not wrap unless it says so.** A figure, a date, a
 *      reference, a badge is read across a row; a reader would rather scroll
 *      the table than decode a folded number.
 *   2. **Every column carries a minimum width** from the shared scale below.
 *      A column that cannot reach its minimum pushes the table past its
 *      container, and the container scrolls. The table overflows; it never
 *      squeezes.
 *
 * Together they move the cost of a too-narrow viewport from "the data is
 * mangled" to "the table scrolls sideways", which is the trade an enterprise
 * register should make.
 *
 * ## What else it owns
 *
 *   - **Horizontal overflow belongs to the table, never the page.** The
 *     wrapper scrolls; `body { overflow-x: hidden }` means a table that
 *     escaped its wrapper would silently clip instead of scrolling, so the
 *     wrapper is not optional.
 *   - **The scroller is focusable and named.** A box that scrolls and cannot
 *     be focused cannot be scrolled from a keyboard at all — axe calls it
 *     `scrollable-region-focusable` and it is a violation, not a nicety.
 *   - **A caption.** Tables are announced by their caption; a screen-reader
 *     user arriving at an unlabelled grid of numbers has to read cells to work
 *     out what they are looking at. Visually hidden, always present.
 *   - **Numeric columns are right-aligned with tabular figures**, through
 *     `align="numeric"` rather than a `text-right` remembered per cell.
 *   - **Two densities, one scale.** A six-column register is read all day and
 *     gets 13px; an eighteen-column aging report needs 11px to fit at all.
 *     Both come from here so there are two deliberate densities rather than
 *     the three accidental ones the registers had grown.
 */

/* ===========================================================================
   Column width scale
   ===========================================================================
   The minimum width a column of each kind needs, in pixels, measured for the
   comfortable density (13px Inter, `px-3` cells) against the longest value
   each kind realistically holds: a Ugandan three-part name, `UGX
   123,456,789`, `14 Oct 2026`, a `LN-2026-000042` reference.

   They are minimums, not shares. A table whose minimums add up to more than
   the viewport is a table that scrolls, and that is the intended outcome —
   see the note above. Columns that should take the slack (a name, a note)
   simply have a larger minimum than the ones that should not.
   =========================================================================== */
export const TABLE_COLUMN_WIDTHS = {
  /** A loan, client, receipt or transfer number. Set in mono. */
  ref: 124,
  /** A person's or a business's full name. Three Ugandan names fit on two. */
  name: 184,
  /** A name that is the row's whole subject, e.g. the client register. */
  'name-wide': 224,
  /** A loan product's name, with its code beneath. */
  product: 168,
  /** `UGX 123,456,789`. */
  money: 124,
  /** A grand total, which runs longer than any single row. */
  'money-wide': 148,
  /** `14 Oct 2026`. */
  date: 104,
  /** `14 Oct 2026, 14:32`. */
  datetime: 144,
  /** One status badge. */
  status: 128,
  /** A badge with a long label — "Awaiting disbursement". */
  'status-wide': 160,
  /** A small whole number: a term in months, a count, days late. */
  count: 76,
  /** A percentage. */
  rate: 88,
  phone: 136,
  /** A village and a district. */
  place: 168,
  /** Free text that is allowed to wrap: a note, a reason, a remark. */
  prose: 240,
  /** A strip of row actions. */
  actions: 104,
} as const;

export type ColumnWidth = keyof typeof TABLE_COLUMN_WIDTHS;

function minWidthStyle(width: ColumnWidth | undefined): CSSProperties | undefined {
  if (width === undefined) return undefined;
  return { minWidth: `${String(TABLE_COLUMN_WIDTHS[width])}px` };
}

/**
 * Hide a secondary column below a breakpoint.
 *
 * The brief's laptop rule — "prioritize the most useful columns" — with a
 * mechanism. A loan's interest rate matters on a wide screen and is the first
 * thing a loan officer can do without at 1024px, where the alternative is
 * scrolling past it to reach the status.
 *
 * Only ever applied to a column whose value is also reachable somewhere else:
 * the row's detail view, or the record panel the same screen renders on a
 * phone. Nothing is hidden that is needed to identify the record.
 */
const HIDE_BELOW = {
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

export type HideBelow = keyof typeof HIDE_BELOW;

const DENSITY = {
  /** Registers and worklists: read all day, six to ten columns. */
  comfortable: { text: 'text-[13px]', padX: '0.75rem', padY: '0.625rem' },
  /** Reports and schedules: twelve to eighteen columns, read in a sitting. */
  compact: { text: 'text-[11px]', padX: '0.5rem', padY: '0.5rem' },
} as const;

export type TableDensity = keyof typeof DENSITY;

export interface DataTableProps {
  /**
   * What this table is, for a screen reader, and the accessible name of the
   * scrolling region around it. Visually hidden — the visible section heading
   * usually says the same thing, but a table must carry its own label because
   * it can be navigated to directly.
   */
  readonly caption: string;
  /**
   * Keeps the header row visible while the body scrolls.
   *
   * Only has an effect together with `maxHeight`. A sticky header needs a
   * scroll container to stick inside, and the wrapper here scrolls
   * horizontally — an element with `overflow-x: auto` computes `overflow-y`
   * to `auto` as well, which clips a sticky header to a box that never
   * scrolls vertically. Capping the height gives it that box. Without a cap
   * the table scrolls with the page and the browser has nothing to stick to.
   */
  readonly stickyHeader?: boolean;
  /**
   * Cap the table's height and scroll its body, e.g. `'70vh'`. Turns
   * `stickyHeader` into something that works. Reserved for the long ones —
   * an audit log, a sixty-row repayment schedule — because a capped table
   * inside a scrolling page is two scrollbars to reason about.
   */
  readonly maxHeight?: string;
  readonly density?: TableDensity;
  readonly children: ReactNode;
  readonly className?: string;
  /** Applied to the scrolling wrapper. */
  readonly containerClassName?: string;
}

export function DataTable({
  caption,
  stickyHeader = false,
  maxHeight,
  density = 'comfortable',
  children,
  className,
  containerClassName,
}: DataTableProps) {
  const capped = maxHeight !== undefined;

  return (
    <div
      className={cn(
        'border-border bg-surface scroll-area min-w-0 rounded-lg border shadow-xs',
        capped ? 'scroll-both' : 'scroll-x',
        containerClassName,
      )}
      // A scrollable box has to be reachable from a keyboard, and a focusable
      // box has to say what it is. Both halves, or neither counts.
      tabIndex={0}
      role="region"
      aria-label={caption}
      data-data-table=""
      {...(capped ? { style: { maxHeight } } : {})}
    >
      {/* `data-sticky-header` is read by one rule in globals.css. It has to be
          the `<th>` that is sticky, not the `<thead>` — a sticky thead does
          nothing in most browsers — and keying off an attribute means callers
          keep writing ordinary `<th>` elements. */}
      <table
        {...(stickyHeader && capped ? { 'data-sticky-header': '' } : {})}
        className={cn(
          // `table-auto` with per-column minimums: columns size to their
          // content, and the table grows past the wrapper rather than
          // squeezing a column below its floor.
          'w-full table-auto border-collapse text-left',
          DENSITY[density].text,
          className,
        )}
        data-density={density}
        // The cells read their padding from here. Set as a style rather than
        // a class so a cell that genuinely needs its own padding — an empty
        // state spanning the table — can still override it.
        style={
          {
            '--table-pad-x': DENSITY[density].padX,
            '--table-pad-y': DENSITY[density].padY,
          } as CSSProperties
        }
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
  /** The minimum width this column may be squeezed to. */
  readonly width?: ColumnWidth;
  /** Drop this column below a breakpoint. See `HIDE_BELOW`. */
  readonly hideBelow?: HideBelow;
  readonly colSpan?: number;
  /**
   * Accepted for the callers that pass it, and ignored: a header cell is
   * always `nowrap`. Kept rather than removed so the `<TableHead nowrap>`
   * call sites keep compiling and the intent they express is still the
   * behaviour they get.
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
  width,
  hideBelow,
  colSpan,
}: TableHeadProps) {
  return (
    <th
      scope={scope}
      {...(hideBelow === undefined ? {} : { 'data-hide-below': hideBelow })}
      className={cn(
        't-th border-border bg-surface-sunken border-b whitespace-nowrap',
        // Padding comes from the density the table declares, through a CSS
        // variable the table sets, so a header does not have to be told which
        // density it is in.
        'px-(--table-pad-x) py-(--table-pad-y)',
        ALIGN[align],
        hideBelow === undefined ? undefined : HIDE_BELOW[hideBelow],
        className,
      )}
      style={minWidthStyle(width)}
      {...(colSpan === undefined ? {} : { colSpan })}
    >
      {children}
    </th>
  );
}

/**
 * How a cell handles a value too long for its column.
 *
 *   - `nowrap` (the default) — the column widens and the table scrolls.
 *   - `wrap`   — free text that is allowed to run to as many lines as it
 *                needs. For a remark or a reason in a table with room.
 *   - `clamp`  — wraps, then stops at two lines. For a name or a product in
 *                a dense register, where a six-line cell would set the height
 *                of every other row. **Always pair with `title`**, or with a
 *                row that links to a view holding the full value: a clamped
 *                value the reader cannot get to in full is a silent
 *                truncation, and this system does not do those to anything
 *                that identifies a record.
 *
 * `clamp` is for a single run of text. A cell holding a stacked pair — a name
 * over a client number — takes `wrap`, because the pair is three lines by
 * design and an outer clamp over it would cut the identifier underneath
 * rather than the name it was aimed at. `TableLead` clamps its own first
 * line, which is where the clamp belongs; see the guard in `TableCell`.
 */
const WRAP = {
  nowrap: 'whitespace-nowrap',
  wrap: 'break-words',
  clamp: 'break-words',
} as const;

export type CellWrap = keyof typeof WRAP;

export interface TableCellProps {
  readonly children: ReactNode;
  readonly align?: keyof typeof ALIGN;
  readonly className?: string;
  readonly colSpan?: number;
  /** Renders as a `<th scope="row">` — the cell that names the row. */
  readonly header?: boolean;
  readonly width?: ColumnWidth;
  readonly hideBelow?: HideBelow;
  /** See `WRAP`. Defaults to `nowrap`. */
  readonly wrap?: CellWrap;
  /**
   * The full value, as a tooltip. Required in practice whenever
   * `wrap="clamp"` is used on something a reader may need in full.
   */
  readonly title?: string;
  /**
   * Keeps the cell on one line. On by default.
   *
   * @deprecated Superseded by `wrap`. `nowrap={false}` is read as
   * `wrap="wrap"` so the existing call sites keep their behaviour.
   */
  readonly nowrap?: boolean;
}

export function TableCell({
  children,
  align = 'text',
  className,
  colSpan,
  header = false,
  width,
  hideBelow,
  wrap,
  title,
  nowrap,
}: TableCellProps) {
  const mode: CellWrap = wrap ?? (nowrap === false ? 'wrap' : 'nowrap');

  const classes = cn(
    'border-border/60 border-b align-middle',
    'px-(--table-pad-x) py-(--table-pad-y)',
    WRAP[mode],
    ALIGN[align],
    // A column of figures only lines up on the thousands separator if the
    // digits are one width. Stated here so a numeric column cannot forget it.
    align === 'numeric' ? 'tabular' : undefined,
    header ? 'text-text font-semibold' : 'text-text',
    className,
  );

  /*
    A clamp over a stacked pair would cut the identifier, not the name.

    `TableLead` renders two blocks and clamps the first itself. Wrapping both
    in a second `line-clamp-2` counts the pair's three lines together and
    truncates whichever falls third — the client number, which is the one
    thing in the cell that must never be cut. So a cell whose content is a
    lead keeps its own clamping and the outer one is dropped.

    Caught by the layout sweep in `scripts/table-audit.mjs` rather than by
    reading the code, which is why it is a guard here and not a note in a
    style guide: eight call sites had it, and the ninth would have too.
  */
  const isLead =
    isValidElement(children) &&
    (children as { readonly type?: unknown }).type === TableLead;

  const body =
    mode === 'clamp' && !isLead ? (
      <span className="line-clamp-2 break-words">{children}</span>
    ) : (
      children
    );

  const attrs = {
    className: classes,
    style: minWidthStyle(width),
    ...(hideBelow === undefined ? {} : { 'data-hide-below': hideBelow }),
    ...(colSpan === undefined ? {} : { colSpan }),
    ...(title === undefined ? {} : { title }),
  };

  const hidden = hideBelow === undefined ? undefined : HIDE_BELOW[hideBelow];

  if (header) {
    return (
      <th scope="row" {...attrs} className={cn(classes, hidden)}>
        {body}
      </th>
    );
  }

  return (
    <td {...attrs} className={cn(classes, hidden)}>
      {body}
    </td>
  );
}

/**
 * The cell that names a row: a primary value with its identifier beneath.
 *
 * Eight registers render the same two-line pair — a borrower's name over a
 * client number, a product's name over its code — and before this each wrote
 * it slightly differently. One shape, one clamp, one place to change it.
 *
 * The primary line clamps at two lines and carries the full value as its
 * tooltip; the secondary line never wraps, because an identifier split across
 * two lines stops being an identifier.
 */
export function TableLead({
  primary,
  secondary,
  mono = false,
}: {
  readonly primary: string;
  readonly secondary?: ReactNode;
  /** Set the primary line in mono — for a reference rather than a name. */
  readonly mono?: boolean;
}) {
  return (
    <span className="block min-w-0">
      <span
        className={cn('text-text line-clamp-2 break-words', mono ? 'font-mono' : '')}
        title={primary}
      >
        {primary}
      </span>
      {secondary === undefined ? null : (
        <span className="text-text-muted mt-0.5 block font-mono text-[11px] whitespace-nowrap">
          {secondary}
        </span>
      )}
    </span>
  );
}

/**
 * "Nothing was recorded here", as distinct from a recorded zero.
 *
 * `Money` already draws this distinction for a sum; this is the same marker
 * for everything that is not a sum — a date that was never set, a decision
 * nobody has taken. Marked up so a screen reader says "not recorded" rather
 * than reading an em dash as a pause, and toned down so a glance can tell an
 * absent value from a real one without reading it.
 */
export function NotRecorded({ className }: { readonly className?: string }) {
  return (
    <span className={cn('text-text-muted', className)} aria-label="Not recorded">
      —
    </span>
  );
}

/**
 * A totals cell that is deliberately not a total.
 *
 * A running balance — an opening or closing principal — is a position at a
 * point in time, not a series that sums to anything; adding the column up
 * would produce a figure with no meaning. The cell under it was left blank,
 * which in a row of bold figures reads as a zero.
 *
 * So it says what it is. Visibly a dash, audibly "not totalled", and titled
 * for anyone who hovers to ask why this one column has no total.
 */
export function NotTotalled({ className }: { readonly className?: string }) {
  return (
    <span
      className={cn('text-text-muted font-normal', className)}
      title="This column is a running balance and does not total"
      aria-label="Not totalled"
    >
      —
    </span>
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
        // Every row of a result set hovers, not only the ones that link out —
        // it is how a reader keeps their place across ten columns.
        // `interactive` additionally marks the pointer.
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
 * How a table renders on a phone: not a shrunken table and not one that
 * scrolls sideways under a thumb — below `md` each row becomes a `#eaf1f8`
 * panel, every column a `Label :Value` line, and the row's action buttons
 * gather into a right-aligned strip at the foot of the panel.
 *
 * Ten columns of currency cannot be read on a 390px screen as a table, and a
 * horizontally scrolling one is worse: you lose the row you were on.
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
 * `h-11 w-11 rounded-lg` with a 20px icon on a phone, collapsing to
 * `h-7 w-7 rounded` with a 14px icon inside a dense desktop table row. The
 * tones tell one row action from another at a glance.
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
        'md:h-7 md:w-7 md:rounded md:[&>svg]:size-3.5',
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
