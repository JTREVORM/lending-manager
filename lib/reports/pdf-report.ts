/**
 * A report, as a branded PDF.
 *
 * ## What this is not
 *
 * Not a picture of a web page. Every figure here is drawn as text with a
 * standard font, so the file can be searched, copied out of, and printed at
 * whatever resolution the printer has rather than at whatever resolution a
 * screen was captured at. `tests/unit/pdf-report.test.ts` reads the generated
 * files back with an independent PDF engine and asserts the names and figures
 * come out as strings, which is that property as a test rather than a promise.
 *
 * ## The letterhead is the same letterhead
 *
 * `DocumentBranding` is the shape the receipt and the loan statement already
 * use, and its own comment anticipated this file. A borrower holding a receipt
 * and a manager holding an arrears report are looking at the same mark, the
 * same registered name, the same tagline, the same two published numbers and
 * the same addresses — because all three read one row of `company_settings`
 * and none of them writes any of it into a component.
 *
 * ## What a page says about itself
 *
 * Every page carries, in its footer, who ran the report and when, and every
 * document says what it covers and which filters were applied. A figure
 * circulated without those is a figure nobody can reproduce — and a report
 * that is printed, photographed and forwarded is exactly the kind of document
 * that gets quoted back months later.
 *
 * ## The export ceiling, and the totals
 *
 * A filtered set that hits `MAX_EXPORT_ROWS` keeps its rows and **loses its
 * totals**, with the reason printed where the totals would have been. This is
 * ADR-042, and it matters more in a PDF than in a CSV: a CSV is reopened in a
 * spreadsheet that totals the column itself, while a PDF's printed total is
 * the figure somebody circulates. A partial total presented as a total is
 * worse than no total.
 *
 * ## No `server-only` marker
 *
 * The same reason `csv.ts` and `pdf-writer.ts` give, and it was tested the
 * hard way: the marker was here first, and it made every assertion below
 * impossible — `server-only` throws in the environment that can read a
 * generated file back. This module touches no database and holds no
 * credential. It takes branding, fields and rows and returns bytes, and its
 * three properties worth guaranteeing are exactly the kind that have to be
 * checked rather than inferred: that the letterhead's whole identity reaches
 * the page, that a long report paginates and every page says which page it is,
 * and that a capped selection loses its totals. The `DocumentBranding` import
 * is type-only and erased at build time.
 */

import type { DocumentBranding } from '@/lib/data/company';
import { formatInstant } from '@/lib/domain/datetime';

import {
  fitText,
  measureText,
  wrapText,
  A4_LANDSCAPE,
  A4_PORTRAIT,
  buildPdf,
  PdfPage,
  type PdfColor,
  type PdfImage,
} from './pdf-writer';
import { totalWeight, type FieldKind, type ReportField } from './columns';

/** The working navy and amber, matching `--color-navy` and the active amber. */
const NAVY: PdfColor = [0.043, 0.263, 0.58];
const INK: PdfColor = [0.1, 0.11, 0.13];
const MUTED: PdfColor = [0.38, 0.41, 0.46];
const RULE: PdfColor = [0.8, 0.83, 0.87];
const ZEBRA: PdfColor = [0.965, 0.973, 0.98];
const WHITE: PdfColor = [1, 1, 1];

const MARGIN = { left: 36, right: 36, top: 40, bottom: 46 } as const;

/** Row geometry. 8pt text in a 13pt band reads at arm's length on paper. */
const BODY_SIZE = 8;
const ROW_HEIGHT = 13;
const HEADER_SIZE = 7;
const HEADER_HEIGHT = 28;

/** The band the capped-selection notice needs: a bold line and a wrapped one. */
const CAPPED_NOTICE_HEIGHT = 26;

/**
 * Where the table stops being readable in portrait.
 *
 * Measured in total field weight rather than field count: six money columns
 * need less room than six note columns. A portfolio report has to go
 * landscape; a grace-period report does not, and forcing every report
 * landscape to spare this decision would waste a third of every page.
 */
/**
 * Where the table stops being readable in portrait.
 *
 * Measured in total field weight rather than field count: six money columns
 * need less room than six note columns.
 */
const PORTRAIT_WEIGHT_LIMIT = 9;

/**
 * The narrowest a column of each kind may be, in points, before the table
 * stops being a table.
 *
 * These are content floors, not heading floors — a heading wraps to two lines
 * (see `drawTableHeader`), so a long one does not drag its column wide. The
 * numbers are what the *values* need at 8pt Helvetica:
 *
 *   * `1,250,000` measures 35.6pt, so money and counts get 44 with padding.
 *   * `2026-10-11` measures 40.9pt, so a date gets 48.
 *   * `11 Oct 2026, 09:30` measures about 70pt, so an instant gets 76.
 *   * a name is truncated at some point whatever is done, and 56 holds
 *     "Nakimuli Zaï…" — enough to tell two borrowers apart, which is the
 *     column's actual job.
 *
 * ## Why this exists at all
 *
 * The first version of this layout divided the page by weight alone. On the
 * arrears report — 27 columns — that produced 16.7pt per column: two
 * characters, so every cell read `Na…`. It passed the unit tests, which used a
 * four-column fixture, and the browser tests, which checked that *some* text
 * was in the file. A document where every cell is an ellipsis is worse than no
 * document, so the floors are the thing that decides the layout now, and the
 * weights only distribute what is left over.
 */
const MIN_WIDTH: Readonly<Record<FieldKind, number>> = {
  money: 44,
  count: 44,
  percent: 44,
  date: 48,
  instant: 76,
  text: 56,
};

/**
 * The narrowest this column may be: its own override, or its kind's floor.
 *
 * A handful of columns hold a value of fixed shape — a phone number is
 * thirteen characters whatever happens — and for those the kind's floor is the
 * wrong answer in both directions.
 */
function floorFor<Row>(field: ReportField<Row>): number {
  return field.minWidth ?? MIN_WIDTH[field.kind];
}

/** Headings wrap to three lines; one would force the floors much wider. */
const HEADER_LINES = 3;

export interface ReportTotal {
  readonly label: string;
  readonly value: string;
}

export interface ReportPdfInput<Row> {
  readonly branding: DocumentBranding;
  /** "Collections", "Arrears" — what the report is called. */
  readonly title: string;
  /** What it covers: the range, in the words the screen used. */
  readonly coverage: string;
  /** The filters that were applied, each already a sentence fragment. */
  readonly filters: readonly string[];
  readonly fields: readonly ReportField<Row>[];
  readonly rows: readonly Row[];
  /**
   * The figures at the foot. Empty where the report has none, and ignored
   * entirely when `capped` is true.
   */
  readonly totals: readonly ReportTotal[];
  /** True when the row set hit the export ceiling. ADR-042. */
  readonly capped: boolean;
  /** The person who asked for it, by the name their account carries. */
  readonly generatedBy: string;
  readonly generatedAt: Date;
  /** The letterhead mark, where one could be loaded. */
  readonly logo?: PdfImage;
  /** Forced orientation, for a report that knows better than the heuristic. */
  readonly orientation?: 'portrait' | 'landscape';
}

/** The gap between a cell's edge and its text. Both sides, so 2x in the sum. */
const CELL_PAD = 3;

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly contentWidth: number;
}

/**
 * A run of columns that fits one page width, with its own laid-out geometry.
 *
 * ## Why a report is banded rather than squeezed
 *
 * A twenty-seven column arrears report does not fit on an A4 page in any
 * typography — not at 8pt, not at 6pt. The choice is between dropping columns
 * from the document (so it disagrees with the spreadsheet) and splitting them
 * across page widths. A spreadsheet's own print does the second, and so does
 * this: columns 1–13 over however many pages the rows need, then columns 14–27
 * over the same rows again.
 *
 * ## The anchor column repeats
 *
 * Every band after the first begins with the report's **first** field — the
 * loan number, the receipt number, the client number — because without it the
 * second band is a page of figures nobody can line up against the first.
 * `isAnchor` marks it so the band heading can say the column is a repeat
 * rather than a new one.
 */
interface Band<Row> {
  readonly fields: readonly ReportField<Row>[];
  /** The x offset and width of each of this band's columns, left to right. */
  readonly columns: readonly { readonly x: number; readonly width: number }[];
  /** True for the repeated anchor column, which is not a column of its own. */
  readonly anchored: boolean;
  /** 1-based, for "Columns 14 to 27 of 27". */
  readonly firstFieldNumber: number;
  readonly lastFieldNumber: number;
}

function geometryFor(orientation: 'portrait' | 'landscape'): Geometry {
  const page = orientation === 'landscape' ? A4_LANDSCAPE : A4_PORTRAIT;

  return {
    width: page.width,
    height: page.height,
    contentWidth: page.width - MARGIN.left - MARGIN.right,
  };
}

/**
 * Lay a run of fields out across the available width.
 *
 * Each column takes its floor first; whatever is left over is shared by
 * weight. So the weights decide the *extra* room rather than the whole, which
 * is what keeps a date column readable on a report that also has a note
 * column three times its weight.
 */
function layOut<Row>(
  fields: readonly ReportField<Row>[],
  contentWidth: number,
): readonly { readonly x: number; readonly width: number }[] {
  const floors = fields.map(floorFor);
  const floorTotal = floors.reduce((sum: number, value: number) => sum + value, 0);

  const spare = Math.max(0, contentWidth - floorTotal);
  const weight = totalWeight(fields);

  let x = MARGIN.left;

  return fields.map((field, index) => {
    const floor = floors[index] ?? MIN_WIDTH.text;
    const width = floor + (weight === 0 ? 0 : (spare * field.weight) / weight);
    const column = { x, width };
    x += width;
    return column;
  });
}

/**
 * Split a report's fields into bands that each fit the page.
 *
 * Two steps, and the second one matters more than it looks.
 *
 * **How many bands.** Walk the fields adding floors until the next one will
 * not fit, counting a band each time. One band is the common case for a narrow
 * report and costs nothing: the anchor is not repeated and the result is the
 * single table it would have been anyway.
 *
 * **Where to cut.** Not where the greedy walk ran out of room. Filling the
 * first band to the brim leaves the last one with whatever is left over, and
 * the leftovers are what make a document look broken: the recovery report's
 * fifteen columns split 14 and 1, so the second band was one column and an
 * anchor sitting alone on a landscape page. So once the count is known the
 * fields are divided as evenly as the floors allow — 8 and 7 rather than 14
 * and 1 — and each band's columns then share the whole page width.
 */
function bandsFor<Row>(
  fields: readonly ReportField<Row>[],
  contentWidth: number,
): readonly Band<Row>[] {
  const anchor = fields[0];
  if (anchor === undefined) return [];

  const anchorFloor = floorFor(anchor);
  const floors = fields.map(floorFor);

  /** How many bands a greedy walk needs. */
  const countBands = (): number => {
    let bands = 1;
    let used = 0;

    floors.forEach((floor, index) => {
      const overhead = bands > 1 ? anchorFloor : 0;

      if (index > 0 && used + floor + overhead > contentWidth) {
        bands += 1;
        used = 0;
      }

      used += floor;
    });

    return bands;
  };

  const bandCount = countBands();

  /** Cut points that divide the floors as evenly as the fields allow. */
  const cuts: number[] = [];

  if (bandCount > 1) {
    const total = floors.reduce((sum: number, value: number) => sum + value, 0);
    const target = total / bandCount;

    let used = 0;
    let soFar = 0;

    floors.forEach((floor, index) => {
      if (index === 0) {
        used = floor;
        return;
      }

      const remainingBands = bandCount - cuts.length - 1;
      const overhead = cuts.length > 0 ? anchorFloor : 0;
      const wouldOverflow = used + floor + overhead > contentWidth;
      const pastTarget = soFar + used + floor > target * (cuts.length + 1);
      const fieldsLeft = floors.length - index;

      // An overflow always cuts, whatever the even-split arithmetic wanted:
      // the greedy count is a prediction and the split is a preference, and a
      // band that does not fit the page would squeeze its columns below their
      // floors — which is the whole defect this function exists to prevent.
      // A cut for *balance* is the one that waits for a band to be left.
      if (
        wouldOverflow ||
        (remainingBands > 0 && pastTarget && fieldsLeft > remainingBands)
      ) {
        cuts.push(index);
        soFar += used;
        used = floor;
        return;
      }

      used += floor;
    });
  }

  const boundaries = [0, ...cuts, fields.length];
  const bands: Band<Row>[] = [];

  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const from = boundaries[index] ?? 0;
    const to = boundaries[index + 1] ?? fields.length;
    const run = fields.slice(from, to);
    if (run.length === 0) continue;

    const anchored = index > 0;
    const laid = anchored ? [anchor, ...run] : [...run];

    bands.push({
      fields: laid,
      columns: layOut(laid, contentWidth),
      anchored,
      firstFieldNumber: from + 1,
      lastFieldNumber: to,
    });
  }

  return bands;
}

/**
 * The column heading band, with headings wrapped to two lines.
 *
 * Wrapping rather than truncating, because a heading is the one place in a
 * report where the whole phrase matters: "Oldest missed collection" over a
 * date column is three words that sit on two lines, and "Oldest mis…" would
 * leave the reader guessing what the column holds. It is also what lets the
 * column floors be driven by the *values* rather than by the longest heading.
 */
/**
 * A money column's heading, without the currency.
 *
 * A field's heading is one string, shared by the spreadsheet and the document,
 * because two headings are two things that drift. But `(UGX)` on fourteen
 * columns of a wide report is fourteen repetitions of a fact the page can
 * state once — and it was what pushed "Contract outstanding (UGX)" past three
 * lines, so the reader saw "Contract outstandin…" and lost the unit anyway.
 *
 * So the suffix is stripped here, mechanically, and the intro says "All
 * amounts in UGX." That is a rendering of the one heading, not a second one:
 * nothing is declared twice and the CSV is untouched.
 */
function headingFor<Row>(field: ReportField<Row>): string {
  return field.kind === 'money'
    ? field.header.replace(/\s*\([^)]*\)\s*$/, '')
    : field.header;
}

function drawTableHeader<Row>(
  page: PdfPage,
  band: Band<Row>,
  geometry: Geometry,
  top: number,
): number {
  const height = HEADER_HEIGHT;

  page.rect({
    x: MARGIN.left,
    y: top - height,
    width: geometry.contentWidth,
    height,
    color: NAVY,
  });

  band.fields.forEach((field, index) => {
    const column = band.columns[index];
    if (column === undefined) return;

    const budget = column.width - CELL_PAD * 2;
    const lines = wrapText(headingFor(field), 'bold', HEADER_SIZE, budget, HEADER_LINES);

    lines.forEach((line, lineIndex) => {
      const baseline = top - 7.5 - lineIndex * (HEADER_SIZE + 1.5);
      const options = {
        y: baseline,
        font: 'bold' as const,
        size: HEADER_SIZE,
        color: WHITE,
      };

      if (field.align === 'right') {
        page.textRight(line, { ...options, x: column.x + column.width - CELL_PAD });
      } else {
        page.text(line, { ...options, x: column.x + CELL_PAD });
      }
    });
  });

  return top - height;
}

/**
 * The line above a band that is not the whole report.
 *
 * Only drawn where there is more than one band: on a single-band report it
 * would be a sentence saying "columns 1 to 13 of 13", which is noise.
 */
function drawBandLabel<Row>(
  page: PdfPage,
  band: Band<Row>,
  total: number,
  top: number,
): number {
  const range =
    band.firstFieldNumber === band.lastFieldNumber
      ? `Column ${String(band.firstFieldNumber)}`
      : `Columns ${String(band.firstFieldNumber)} to ${String(band.lastFieldNumber)}`;

  const anchorNote = band.anchored
    ? `, with ${band.fields[0]?.header ?? 'the first column'} repeated`
    : '';

  page.text(`${range} of ${String(total)}${anchorNote}. The same rows throughout.`, {
    x: MARGIN.left,
    y: top - 8,
    font: 'bold',
    size: 8,
    color: NAVY,
  });

  return top - 14;
}

function drawRow<Row>(
  page: PdfPage,
  band: Band<Row>,
  geometry: Geometry,
  row: Row,
  top: number,
  zebra: boolean,
): number {
  if (zebra) {
    page.rect({
      x: MARGIN.left,
      y: top - ROW_HEIGHT,
      width: geometry.contentWidth,
      height: ROW_HEIGHT,
      color: ZEBRA,
    });
  }

  band.fields.forEach((field, index) => {
    const column = band.columns[index];
    if (column === undefined) return;

    const budget = column.width - CELL_PAD * 2;
    const baseline = top - ROW_HEIGHT + 4;
    const text = fitText(field.text(row), 'regular', BODY_SIZE, budget);

    if (field.align === 'right') {
      page.textRight(text, {
        x: column.x + column.width - CELL_PAD,
        y: baseline,
        size: BODY_SIZE,
        color: INK,
      });
    } else {
      page.text(text, {
        x: column.x + CELL_PAD,
        y: baseline,
        size: BODY_SIZE,
        color: INK,
      });
    }
  });

  return top - ROW_HEIGHT;
}

/**
 * The letterhead, on the first page only.
 *
 * Repeating it on page nine of a portfolio report would waste a third of every
 * page to say something the first page already said. Later pages get the
 * running head below instead: the company, the report and the coverage on one
 * line, so a page that has been separated from the others still identifies
 * itself.
 */
function drawLetterhead(
  page: PdfPage,
  input: ReportPdfInput<unknown>,
  top: number,
): number {
  const { branding } = input;
  let textLeft = MARGIN.left;

  if (input.logo !== undefined) {
    const markWidth = 54;
    const markHeight = (markWidth * input.logo.height) / input.logo.width;
    page.image({
      x: MARGIN.left,
      y: top - markHeight,
      width: markWidth,
      height: markHeight,
    });
    textLeft = MARGIN.left + markWidth + 12;
  }

  let y = top - 12;

  page.text(branding.companyName, {
    x: textLeft,
    y,
    font: 'bold',
    size: 13,
    color: NAVY,
  });

  if (branding.tagline !== null && branding.tagline.trim() !== '') {
    y -= 11;
    page.text(branding.tagline, { x: textLeft, y, size: 8.5, color: MUTED });
  }

  const contacts = [branding.phone, branding.phoneSecondary]
    .filter((value): value is string => value !== null && value.trim() !== '')
    .join('  ·  ');

  if (contacts !== '') {
    y -= 10;
    page.text(contacts, { x: textLeft, y, size: 8, color: INK });
  }

  const addresses = [branding.postalAddress, branding.physicalAddress]
    .filter((value): value is string => value !== null && value.trim() !== '')
    .join('  ·  ');

  if (addresses !== '') {
    y -= 10;
    page.text(addresses, { x: textLeft, y, size: 8, color: MUTED });
  }

  // The rule clears whichever is lower, the mark or the text block.
  const markBottom =
    input.logo === undefined ? y : top - (54 * input.logo.height) / input.logo.width;
  const ruleY = Math.min(y, markBottom) - 10;

  page.line({
    x1: MARGIN.left,
    y1: ruleY,
    x2: page.width - MARGIN.right,
    y2: ruleY,
    width: 1,
    color: NAVY,
  });

  return ruleY - 18;
}

/** The one-line head on a continuation page. */
function drawRunningHead(
  page: PdfPage,
  input: ReportPdfInput<unknown>,
  top: number,
): number {
  page.text(`${input.branding.companyName} · ${input.title}`, {
    x: MARGIN.left,
    y: top - 9,
    font: 'bold',
    size: 8.5,
    color: NAVY,
  });

  page.textRight(input.coverage, {
    x: page.width - MARGIN.right,
    y: top - 9,
    size: 8,
    color: MUTED,
  });

  const ruleY = top - 15;
  page.line({
    x1: MARGIN.left,
    y1: ruleY,
    x2: page.width - MARGIN.right,
    y2: ruleY,
    width: 0.5,
    color: RULE,
  });

  return ruleY - 12;
}

function drawFooter(
  page: PdfPage,
  input: ReportPdfInput<unknown>,
  pageNumber: number,
  pageCount: number,
): void {
  const y = MARGIN.bottom - 24;

  page.line({
    x1: MARGIN.left,
    y1: y + 12,
    x2: page.width - MARGIN.right,
    y2: y + 12,
    width: 0.5,
    color: RULE,
  });

  const stamp = formatInstant(input.generatedAt.toISOString(), {
    timeZone: input.branding.timezone,
  });

  page.text(`Run by ${input.generatedBy} · ${stamp}`, {
    x: MARGIN.left,
    y,
    size: 7.5,
    color: MUTED,
  });

  page.textRight(`Page ${String(pageNumber)} of ${String(pageCount)}`, {
    x: page.width - MARGIN.right,
    y,
    size: 7.5,
    color: MUTED,
  });
}

/**
 * The block of figures at the foot of the last page.
 *
 * Or, where the row set hit the ceiling, the sentence that says why there are
 * none. The sentence is not an apology: it is the report telling the reader
 * that the figure they were about to quote would have been wrong.
 */
function drawTotals<Row>(
  page: PdfPage,
  input: ReportPdfInput<Row>,
  geometry: Geometry,
  top: number,
): void {
  if (input.capped) {
    page.rect({
      x: MARGIN.left,
      y: top - CAPPED_NOTICE_HEIGHT,
      width: geometry.contentWidth,
      height: CAPPED_NOTICE_HEIGHT,
      color: ZEBRA,
    });

    page.text('Totals are not shown for this selection.', {
      x: MARGIN.left + CELL_PAD,
      y: top - 11,
      font: 'bold',
      size: 8,
      color: INK,
    });

    page.text(
      'It reached the export ceiling, so these rows are not all of them and a ' +
        'total of part of a selection is a figure nobody should circulate. ' +
        'Narrow the range or the filters and run it again.',
      { x: MARGIN.left + CELL_PAD, y: top - 21, size: 7.5, color: MUTED },
    );

    return;
  }

  if (input.totals.length === 0) return;

  page.rect({
    x: MARGIN.left,
    y: top - HEADER_HEIGHT,
    width: geometry.contentWidth,
    height: HEADER_HEIGHT,
    color: NAVY,
  });

  // Right to left, so the last total sits at the right edge the figures
  // themselves are aligned to.
  let right = MARGIN.left + geometry.contentWidth - CELL_PAD;

  for (const total of [...input.totals].reverse()) {
    page.textRight(total.value, {
      x: right,
      y: top - HEADER_HEIGHT + 4.5,
      font: 'bold',
      size: BODY_SIZE,
      color: WHITE,
    });

    const valueWidth = measureText(total.value, 'bold', BODY_SIZE);
    right -= valueWidth + 6;

    page.textRight(`${total.label}:`, {
      x: right,
      y: top - HEADER_HEIGHT + 4.5,
      size: BODY_SIZE,
      color: WHITE,
    });

    right -= measureText(`${total.label}:`, 'regular', BODY_SIZE) + 16;
  }
}

/**
 * Render the report.
 *
 * Rows down the page, columns across bands. A narrow report is one band and
 * reads as the single table it always was; a wide one repeats its rows under
 * each band of columns, with the anchor column carried into every band and a
 * line saying which columns this is and that the rows are the same throughout.
 *
 * One pass. The only thing that needs to know how long the document is, is the
 * footer's "Page 3 of 7", and footers are drawn after everything else — so the
 * count is in hand by the time anything needs it. A reader holding a printout
 * needs that denominator more than anything else on the page: without it, a
 * page separated from the others cannot be told from the last one.
 */
export function renderReportPdf<Row>(input: ReportPdfInput<Row>): Buffer {
  const orientation =
    input.orientation ??
    (totalWeight(input.fields) > PORTRAIT_WEIGHT_LIMIT ? 'landscape' : 'portrait');

  const geometry = geometryFor(orientation);
  const bands = bandsFor(input.fields, geometry.contentWidth);
  const anyInput = input as unknown as ReportPdfInput<unknown>;

  /** The floor the table must stop above, leaving the footer its band. */
  const floor = MARGIN.bottom;

  const pages: PdfPage[] = [];

  const startPage = (first: boolean): { page: PdfPage; y: number } => {
    const page = new PdfPage(geometry.width, geometry.height);
    pages.push(page);

    const y = first
      ? drawIntro(
          page,
          anyInput,
          geometry,
          drawLetterhead(page, anyInput, page.height - MARGIN.top),
        )
      : drawRunningHead(page, anyInput, page.height - MARGIN.top);

    return { page, y };
  };

  let page: PdfPage;
  let y: number;

  bands.forEach((band, bandIndex) => {
    // A new band starts a new page: carrying on under the previous band's last
    // rows would put two different column sets on one page with nothing but a
    // heading between them.
    ({ page, y } = startPage(bandIndex === 0));

    if (bands.length > 1) {
      y = drawBandLabel(page, band, input.fields.length, y);
    }

    y = drawTableHeader(page, band, geometry, y);

    let zebra = false;

    for (const row of input.rows) {
      if (y - ROW_HEIGHT < floor) {
        ({ page, y } = startPage(false));
        if (bands.length > 1) {
          y = drawBandLabel(page, band, input.fields.length, y);
        }
        y = drawTableHeader(page, band, geometry, y);
        zebra = false;
      }

      y = drawRow(page, band, geometry, row, y, zebra);
      zebra = !zebra;
    }

    // The totals go once, after the last band. Repeating the same three
    // figures under every band would be noise, and putting them under the
    // first would leave the document ending on a page that looks unfinished.
    if (bandIndex < bands.length - 1) return;

    const totalsHeight = input.capped
      ? CAPPED_NOTICE_HEIGHT
      : input.totals.length === 0
        ? 0
        : HEADER_HEIGHT;

    if (totalsHeight === 0) return;

    // Where it does not fit, it starts a page rather than running off the
    // bottom: a total that is not on the page is worse than a page holding
    // only the total.
    if (y - totalsHeight - 6 < floor) {
      ({ page, y } = startPage(false));
    }

    drawTotals(page, input, geometry, y - 6);
  });

  // An empty report still has a page, a letterhead and its headings, because
  // an empty report should look like the report it is rather than like a
  // blank sheet.
  if (pages.length === 0) {
    ({ page, y } = startPage(true));
    const only = bands[0];
    if (only !== undefined) drawTableHeader(page, only, geometry, y);
  }

  pages.forEach((drawn, index) => {
    drawFooter(drawn, anyInput, index + 1, pages.length);
  });

  return buildPdf(
    pages,
    {
      title: `${input.title} \u2014 ${input.branding.companyName}`,
      author: input.branding.companyName,
      createdAt: input.generatedAt,
    },
    input.logo,
  );
}

/** The title, what the report covers, and the filters that were applied. */
function drawIntro(
  page: PdfPage,
  input: ReportPdfInput<unknown>,
  geometry: Geometry,
  top: number,
): number {
  let y = top;

  page.text(input.title, { x: MARGIN.left, y, font: 'bold', size: 15, color: INK });

  y -= 13;
  page.text(input.coverage, { x: MARGIN.left, y, size: 9, color: MUTED });

  if (input.filters.length > 0) {
    y -= 11;
    const line = fitText(
      `Filters: ${input.filters.join('; ')}`,
      'regular',
      8,
      geometry.contentWidth,
    );
    page.text(line, { x: MARGIN.left, y, size: 8, color: MUTED });
  }

  y -= 11;

  // The currency, once, because the column headings no longer carry it. Taken
  // from a money field's own heading rather than written here, so a business
  // reporting in anything else gets its own code.
  const currency = input.fields
    .find((field) => field.kind === 'money')
    ?.header.match(/\(([^)]*)\)\s*$/)?.[1];

  page.text(
    `${String(input.rows.length)} ${input.rows.length === 1 ? 'row' : 'rows'}. ` +
      (currency === undefined ? '' : `All amounts in ${currency}. `) +
      'Figures are as at the moment this was run.',
    { x: MARGIN.left, y, size: 8, color: MUTED },
  );

  return y - 12;
}
