import type { ReactNode } from 'react';

import { ReportTable, type ReportColumn } from '@/components/reports/report-table';
import type { ReportField } from '@/lib/reports/columns';

/**
 * A report's table, rendered from the same fields its downloads use.
 *
 * ## The third copy, removed
 *
 * A report's columns existed three times: as CSV column builders, as JSX in
 * the page, and (for the newer reports) nowhere at all. The field sets took
 * care of the first two formats; this takes care of the screen. So a report's
 * table, its spreadsheet and its PDF now show the same columns in the same
 * order with the same headings, because all three read one array.
 *
 * ## What the screen does that a file cannot
 *
 * Money goes through `<Money>` rather than the field's own text, because a
 * figure on a screen needs `whitespace-nowrap` and `tabular-nums` to keep
 * `UGX` attached to its number and a column lined up on the thousands
 * separator — the Phase 9 defect that put `UGX` on one line and `148,705` on
 * the next, on every row of the payment register. The *value* is the field's;
 * only the box around it is the screen's.
 *
 * Everything else is the field's `text` exactly, which is what makes the three
 * renderings agree.
 *
 * ## Widths
 *
 * A field's `weight` is a relative hint the PDF divides a page by. The table
 * takes the same hint: a note column that is three times a date column in the
 * document is three times it on screen too, so the two look like the same
 * report. `ReportTable` reads the hint as a minimum under `table-auto`, not as
 * a share of the width.
 */
export function FieldTable<Row>({
  fields,
  rows,
  rowKey,
  caption,
  footer,
  rowTone,
  /**
   * Fields to leave off the stacked phone rendering.
   *
   * A twenty-column report on a 320px screen is a card nobody scrolls to the
   * bottom of. The table keeps every column; the card keeps the ones somebody
   * standing in a doorway needs, by heading, so the choice is made per report
   * rather than by position.
   */
  compactFor = [],
}: {
  readonly fields: readonly ReportField<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly caption: string;
  readonly footer?: ReactNode;
  readonly rowTone?: (row: Row) => 'muted' | undefined;
  readonly compactFor?: readonly string[];
}) {
  const columns: readonly ReportColumn<Row>[] = fields.map((field, index) => ({
    key: `${String(index)}-${field.header}`,
    header: field.header,
    numeric: field.align === 'right',
    width: Math.round(field.weight * 10),
    // Prose wraps; a figure, a date or a reference is read across a row and
    // wrapping one is harder to follow than a table the reader scrolls.
    wrap: field.kind === 'text' && field.weight >= 2.4,
    primary: index === 0,
    hideOnMobile: compactFor.length > 0 && !compactFor.includes(field.header),
    cell: (row) =>
      field.kind === 'money' ? <MoneyCell value={field.text(row)} /> : field.text(row),
  }));

  return (
    <ReportTable
      columns={columns}
      rows={rows}
      rowKey={rowKey}
      caption={caption}
      footer={footer}
      rowTone={rowTone}
    />
  );
}

/**
 * A money field's already-formatted text, in the box money needs.
 *
 * The field did the formatting — grouped, no currency code, an em dash where
 * nothing is recorded — because that is the rendering the PDF uses too. What
 * the screen adds is the typography: the digits stay one width and the value
 * does not break across lines.
 *
 * `<Money>` is deliberately not used here. It takes a *number* and formats it
 * itself, which would put the amount through two formatters and let the screen
 * and the document disagree about an edge case. The em dash for "nothing
 * recorded" is the field's, and it is the same em dash `<Money>` produces —
 * `<Money>` remains the component for a dashboard card or a detail panel,
 * where there is a number to hand rather than a report field.
 */
function MoneyCell({ value }: { readonly value: string }) {
  return (
    <span className="whitespace-nowrap tabular-nums">{value === '' ? '—' : value}</span>
  );
}
