/**
 * One column definition, two renderings.
 *
 * No `server-only` marker, for the reason `csv.ts` gives: this is the module
 * where the export's security properties live, and they have to be asserted
 * directly.
 *
 * ## The defect this exists to make impossible
 *
 * Before this, a report's CSV columns were one array and its screen was JSX.
 * Adding a column meant touching both and remembering which rendering each
 * needed, and the two drifted in exactly the way that is hardest to notice: a
 * CSV whose heading says one thing and whose cells hold another.
 *
 * So a column is declared once, as a **field**, and the renderings are derived
 * from it. A field knows its heading and how to get the value out of a row; it
 * also knows what *kind* of value it is, which is what decides the two
 * renderings:
 *
 *   - money is `1,250,000` on a page and in a PDF, and `1250000` in a CSV,
 *     because a screen is for reading and a file is for totalling. A thousands
 *     separator in a CSV is a parse failure waiting for a spreadsheet with
 *     different locale settings, and a prefixed number cannot be summed by the
 *     person who asked for the file. The currency is in the heading.
 *   - text is disarmed in a CSV — a leading `=`, `+`, `-` or `@` neutralised
 *     so a spreadsheet shows `=cmd|...` rather than running it — and left
 *     exactly as typed on a page and in a PDF, where there is no formula
 *     engine to defend against and a defensive apostrophe would simply be
 *     wrong.
 *
 * Because both renderings come from one declaration, a heading cannot disagree
 * with itself and a money column cannot accidentally be formatted for reading
 * in the file somebody wants to total.
 *
 * ## No identification number, in any field
 *
 * There is no field constructor for one, and `assertNoIdentityField` refuses a
 * set of fields whose heading looks like one. A NIN is read a record at a time
 * by somebody with a reason to look at that record; a column of them in a file
 * that outlives every access control in this application is a different object
 * entirely. §76.
 */

import { formatInstant, type BusinessDate } from '@/lib/domain/datetime';
import { formatUgx, type UgxAmount } from '@/lib/domain/money';
import { csvNumber, csvText, type CsvColumn } from '@/lib/domain/reporting';

/** How a value is read, which decides how it is written. */
export type FieldKind = 'text' | 'money' | 'count' | 'date' | 'instant' | 'percent';

export interface ReportField<Row> {
  readonly header: string;
  readonly kind: FieldKind;
  /** What a person reads: a page cell, a PDF cell. */
  readonly text: (row: Row) => string;
  /** What a spreadsheet gets. */
  readonly csv: (row: Row) => string;
  /**
   * Relative width, for the one rendering that has to decide widths itself.
   * A page uses CSS and a CSV has no width at all; a PDF has a fixed page and
   * must divide it, so each field carries a weight rather than the PDF layout
   * guessing from the heading's length.
   */
  readonly weight: number;
  /** Figures right-align. Everything else does not. */
  readonly align: 'left' | 'right';
  /**
   * A width in points this column must not go below, overriding the floor its
   * kind would otherwise get.
   *
   * For the handful of columns whose values are a *fixed* shape rather than a
   * variable one. A phone number is thirteen characters: below about 64 points
   * it is not a phone number, it is a prefix, and no amount of extra room
   * beyond that buys anything. The weight is the wrong tool for that — it
   * shares out spare width in proportion, which is exactly right for a name
   * and exactly wrong for a value that has one size.
   */
  readonly minWidth?: number;
}

/** A column of free text: a name, a number, a status, a note. */
export function textField<Row>(
  header: string,
  read: (row: Row) => string | null | undefined,
  options: { readonly weight?: number; readonly minWidth?: number } = {},
): ReportField<Row> {
  return {
    header,
    kind: 'text',
    text: (row) => read(row) ?? '',
    csv: (row) => csvText(read(row)),
    weight: options.weight ?? 2,
    align: 'left',
    minWidth: options.minWidth,
  };
}

/**
 * A telephone number, which is a fixed shape rather than a variable one.
 *
 * `+256768735982` is thirteen characters and always will be. It gets the width
 * that needs and little spare, because a phone column that is half a number is
 * useless while one with room to spare is only wasted — and on a fourteen
 * column report that waste comes out of somebody's name.
 */
export function phoneField<Row>(
  header: string,
  read: (row: Row) => string | null | undefined,
): ReportField<Row> {
  return textField(header, read, { weight: 0.8, minWidth: 66 });
}

/**
 * A column of money.
 *
 * The heading carries the currency, so pass `Principal` and not
 * `Principal (UGX)` — the constructor appends it, which is what stops half a
 * report labelling its currency and half not.
 */
export function moneyField<Row>(
  header: string,
  read: (row: Row) => UgxAmount | number | null | undefined,
  options: { readonly weight?: number; readonly currencyCode?: string } = {},
): ReportField<Row> {
  const code = options.currencyCode ?? 'UGX';

  return {
    header: `${header} (${code})`,
    kind: 'money',
    text: (row) => {
      const value = read(row);
      // An em dash, not `0`: "nothing recorded" and "zero shillings" are
      // different statements, and the screens already draw that distinction.
      if (value === null || value === undefined) return '—';
      return formatUgx(value as UgxAmount, { withCurrency: false });
    },
    csv: (row) => csvNumber(read(row) ?? null),
    weight: options.weight ?? 1.4,
    align: 'right',
  };
}

/** A column of counts: days late, collections missed, loans held. */
export function countField<Row>(
  header: string,
  read: (row: Row) => number | null | undefined,
  options: { readonly weight?: number } = {},
): ReportField<Row> {
  return {
    header,
    kind: 'count',
    text: (row) => {
      const value = read(row);
      return value === null || value === undefined ? '—' : String(value);
    },
    csv: (row) => csvNumber(read(row) ?? null),
    weight: options.weight ?? 0.8,
    align: 'right',
  };
}

/**
 * A rate held in basis points, shown as a percentage.
 *
 * Basis points are how every rate is stored — an integer, so a rate cannot
 * drift by a rounding error — and a percentage is what a person reads.
 */
export function percentField<Row>(
  header: string,
  readBps: (row: Row) => number | null | undefined,
  options: { readonly weight?: number } = {},
): ReportField<Row> {
  const show = (bps: number): string => {
    const percent = bps / 100;
    return `${percent.toFixed(Number.isInteger(percent) ? 0 : 1)}%`;
  };

  return {
    header: `${header} (%)`,
    kind: 'percent',
    text: (row) => {
      const bps = readBps(row);
      return bps === null || bps === undefined ? '—' : show(bps);
    },
    // The number, not the rendered percentage: a column of `15.0%` cannot be
    // averaged. `15` is the percentage as a number, which can be.
    csv: (row) => {
      const bps = readBps(row);
      return bps === null || bps === undefined ? '' : csvNumber(bps / 100);
    },
    weight: options.weight ?? 0.7,
    align: 'right',
  };
}

/**
 * A business date — a day with no time in it.
 *
 * ISO in both renderings, deliberately. `2026-10-11` sorts correctly as text
 * in a spreadsheet, is unambiguous between the day-first and month-first
 * conventions, and is what every other date in this system is written as.
 */
export function dateField<Row>(
  header: string,
  read: (row: Row) => BusinessDate | string | null | undefined,
  options: { readonly weight?: number } = {},
): ReportField<Row> {
  const show = (row: Row): string => read(row) ?? '';

  return {
    header,
    kind: 'date',
    text: show,
    csv: (row) => show(row),
    weight: options.weight ?? 0.9,
    align: 'left',
  };
}

/**
 * A moment in time, rendered in the business timezone.
 *
 * Never the server's timezone and never the browser's. A receipt timed 23:40
 * on the 10th in UTC was written at 02:40 on the 11th in Kampala, and the
 * person reading the report is in Kampala.
 */
export function instantField<Row>(
  header: string,
  read: (row: Row) => string | null | undefined,
  timeZone: string,
  options: { readonly weight?: number } = {},
): ReportField<Row> {
  const show = (row: Row): string => {
    const value = read(row);
    return value === null || value === undefined || value === ''
      ? ''
      : formatInstant(value, { timeZone });
  };

  return {
    header,
    kind: 'instant',
    text: show,
    csv: (row) => csvText(show(row)),
    weight: options.weight ?? 1.5,
    align: 'left',
  };
}

// ---------------------------------------------------------------------------
// Deriving the renderings
// ---------------------------------------------------------------------------

/** The CSV columns a field set implies. */
export function csvColumns<Row>(
  fields: readonly ReportField<Row>[],
): readonly CsvColumn<Row>[] {
  return fields.map((field) => ({ header: field.header, cell: field.csv }));
}

/**
 * Headings that would mean an identification number.
 *
 * Matched on the heading rather than the value, because the value is a string
 * like any other and the heading is where the intent is. Deliberately broad:
 * a report that wants one of these has to argue with this list rather than
 * quietly ship.
 */
const FORBIDDEN_HEADERS = [
  /\bnin\b/i,
  /national\s*id/i,
  /identification\s*number/i,
  /passport/i,
];

/**
 * Refuse a field set that would export an identification number.
 *
 * Called by the registry when it is built, so a report cannot be added with
 * such a column at all — the failure is at module load and in a test, not in a
 * file somebody has already downloaded. §76.
 */
export function assertNoIdentityField<Row>(
  reportId: string,
  fields: readonly ReportField<Row>[],
): void {
  for (const field of fields) {
    for (const pattern of FORBIDDEN_HEADERS) {
      if (pattern.test(field.header)) {
        throw new Error(
          `Report "${reportId}" declares a column "${field.header}", which reads as an ` +
            `identification number. No report exports one — §76. A NIN is read a record ` +
            `at a time by somebody with a reason to look at that record.`,
        );
      }
    }
  }
}

/** The total of the weights, for dividing a PDF's usable width. */
export function totalWeight<Row>(fields: readonly ReportField<Row>[]): number {
  return fields.reduce((sum, field) => sum + field.weight, 0);
}
