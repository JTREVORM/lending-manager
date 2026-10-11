/**
 * A small PDF writer: pages, text, rules, fills and one image.
 *
 * No `server-only` marker, for the reason `csv.ts` gives. This module is pure
 * byte assembly — it touches no database and holds no credential — and the
 * properties that matter about it (that a figure in the file is *text* and not
 * a picture of text, that a long name is truncated at a character boundary,
 * that the byte offsets in the cross-reference table are right) are the kind
 * of thing that has to be asserted directly rather than inferred from a route.
 *
 * ## Why this is written rather than installed
 *
 * The brief's constraint is that an export must not be a screenshot of a
 * browser. That rules out the usual shortcut — render the page, rasterise it,
 * wrap the bitmap in a PDF — and it rules it out for good reasons: a bitmap
 * cannot be searched, cannot be copied out of, prints at whatever resolution
 * it was captured at, and weighs megabytes per page. What it leaves is a PDF
 * whose text is text.
 *
 * Producing that needs four things: a page tree, a content stream of text and
 * graphics operators, font metrics to measure strings with, and a
 * cross-reference table of byte offsets. All four are small and completely
 * specified. The one part that usually forces a dependency — embedding a font
 * programme — is not needed here, because Helvetica and Helvetica-Bold are two
 * of the fourteen standard faces every conforming reader already carries. So
 * the whole writer is this file, the generated metrics table beside it, and no
 * addition to the ten runtime dependencies this application has.
 *
 * ## Bytes, not strings
 *
 * Everything is assembled as `Buffer` in `latin1`, never `utf8`. The
 * cross-reference table is a list of *byte* offsets into the file, so a single
 * multi-byte character written through a utf8 encoder would shift every offset
 * after it and produce a file that readers reject. The same reason the JPEG is
 * concatenated as bytes and never passed through a string.
 *
 * ## WinAnsi, and what happens outside it
 *
 * The fonts are declared `/WinAnsiEncoding`, which covers Latin-1 plus the
 * typographic characters a name like Nakimuli Zaïnabu needs. A character
 * outside it — a character this application has no font programme for — is
 * replaced before measurement, not after, so the width the layout used is the
 * width the reader will draw. Dropping it silently after measuring would push
 * a column out of alignment for the one row that needed care.
 */

import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS } from './helvetica-metrics';

/** The two faces a report uses. Named for the resource keys they are given. */
export type PdfFont = 'regular' | 'bold';

/** A4, in PostScript points (1/72 inch). */
export const A4_PORTRAIT = { width: 595.28, height: 841.89 } as const;
export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const;

/**
 * What a character outside WinAnsi becomes.
 *
 * A question mark rather than nothing: a name that silently loses a character
 * is a name that may no longer identify the borrower, and a visible
 * substitution tells the reader the document could not represent something.
 */
const SUBSTITUTE = '?';

const WIDTHS: Readonly<Record<PdfFont, readonly number[]>> = {
  regular: HELVETICA_WIDTHS,
  bold: HELVETICA_BOLD_WIDTHS,
};

/**
 * Reduce a string to characters the declared encoding can draw.
 *
 * Runs before measuring, so `measureText` and the content stream always agree
 * about what is on the page. Newlines and tabs become spaces: a cell is one
 * line by construction, and a stray control character in a content stream is
 * a corrupt file rather than a layout surprise.
 *
 * ## It is idempotent, and that is not decoration
 *
 * A string passes through here more than once in the normal path: `fitText`
 * converts before measuring, `measureText` converts again, and `PdfPage.text`
 * converts once more before writing. The first version treated the 0x80–0x9F
 * band as unmappable, so a second pass turned an already-encoded em dash into
 * `?` — which put a question mark in every "nothing recorded" money cell of
 * every report, visible only by looking at a rendered page. So a character
 * that is *already* one of this band's glyphs passes through unchanged.
 */
export function toWinAnsi(value: string): string {
  let out = '';

  for (const character of value.replace(/[\r\n\t]+/g, ' ')) {
    const code = character.codePointAt(0) ?? 0;
    // WinAnsi is Latin-1 for 0x20–0xFF apart from the 0x80–0x9F band, which
    // holds the typographic characters rather than control codes. Those are
    // mapped individually below; everything else above 0xFF has no code.
    if (code >= 0x20 && code <= 0x7e) {
      out += character;
    } else if (code >= 0xa0 && code <= 0xff) {
      out += character;
    } else if (ENCODED_HIGH_BAND.has(code)) {
      // Already encoded by an earlier pass. Re-encoding is a no-op, not a
      // failure to recognise it.
      out += character;
    } else {
      out += HIGH_BAND[code] ?? SUBSTITUTE;
    }
  }

  return out;
}

/**
 * The WinAnsi 0x80–0x9F band: the characters Windows put where Latin-1 has
 * control codes. Only the ones text in this application plausibly contains —
 * a pasted en dash, a curly apostrophe in a client's name, an ellipsis.
 */
const HIGH_BAND: Readonly<Record<number, string>> = {
  0x20ac: '\u0080', // €
  0x201a: '\u0082',
  0x0192: '\u0083',
  0x201e: '\u0084',
  0x2026: '\u0085', // …
  0x2020: '\u0086',
  0x2021: '\u0087',
  0x02c6: '\u0088',
  0x2030: '\u0089',
  0x0160: '\u008a',
  0x2039: '\u008b',
  0x0152: '\u008c',
  0x017d: '\u008e',
  0x2018: '\u0091', // ‘
  0x2019: '\u0092', // ’
  0x201c: '\u0093', // “
  0x201d: '\u0094', // ”
  0x2022: '\u0095', // •
  0x2013: '\u0096', // –
  0x2014: '\u0097', // —
  0x02dc: '\u0098',
  0x2122: '\u0099', // ™
  0x0161: '\u009a',
  0x203a: '\u009b',
  0x0153: '\u009c',
  0x017e: '\u009e',
  0x0178: '\u009f',
};

/**
 * The codes `HIGH_BAND` produces, so a second pass recognises its own output.
 *
 * Not simply `0x80`–`0x9F`: five of those codes are undefined in WinAnsi, and
 * a byte with no glyph should still become a visible substitution rather than
 * be written into a content stream.
 */
const ENCODED_HIGH_BAND: ReadonlySet<number> = new Set(
  Object.values(HIGH_BAND).map((character) => character.charCodeAt(0)),
);

/** The width of a string at a size, in points. */
export function measureText(value: string, font: PdfFont, size: number): number {
  const widths = WIDTHS[font];
  let total = 0;

  for (const character of toWinAnsi(value)) {
    total += widths[character.charCodeAt(0)] ?? 0;
  }

  return (total * size) / 1000;
}

/**
 * Shorten a string to fit a width, ending in an ellipsis.
 *
 * Truncation happens at a character boundary and the ellipsis is measured as
 * part of the budget, so the result genuinely fits — a column that overflowed
 * by the width of the marker that said it had overflowed would be the worst of
 * both.
 */
export function fitText(
  value: string,
  font: PdfFont,
  size: number,
  maxWidth: number,
): string {
  const text = toWinAnsi(value);
  if (measureText(text, font, size) <= maxWidth) return text;

  const ellipsis = '…';
  const budget = maxWidth - measureText(ellipsis, font, size);
  if (budget <= 0) return '';

  let out = '';
  for (const character of text) {
    if (measureText(out + character, font, size) > budget) break;
    out += character;
  }

  return out === '' ? '' : `${out}${ellipsis}`;
}

/**
 * Break a string into at most `maxLines` lines that each fit `maxWidth`.
 *
 * Used for column headings, which is the one place in a report where wrapping
 * is better than truncating: a heading like "Oldest missed collection" over a
 * date column is three words that can sit on two lines, and shortening it to
 * "Oldest mis…" would leave the reader guessing what the column holds.
 *
 * Breaks on spaces. A single word longer than the width is truncated with an
 * ellipsis rather than broken mid-word, because a hyphenless break in a
 * heading reads as two different words. The last line is truncated if there is
 * more text than `maxLines` can hold, so the result always fits the box it was
 * measured for.
 */
export function wrapText(
  value: string,
  font: PdfFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): readonly string[] {
  const text = toWinAnsi(value).trim();
  if (text === '') return [];
  if (maxLines <= 1) return [fitText(text, font, size, maxWidth)];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;

    if (measureText(candidate, font, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current !== '') lines.push(current);

    if (lines.length === maxLines - 1) {
      // The last line takes whatever is left, truncated to fit.
      const rest = [word, ...words.slice(words.indexOf(word) + 1)].join(' ');
      lines.push(fitText(rest, font, size, maxWidth));
      return lines;
    }

    current = fitText(word, font, size, maxWidth);
  }

  if (current !== '') lines.push(current);

  return lines.slice(0, maxLines);
}

// ---------------------------------------------------------------------------
// Content stream
// ---------------------------------------------------------------------------

/** A greyscale or RGB colour, each component 0–1. */
export type PdfColor = readonly [number, number, number];

export const BLACK: PdfColor = [0, 0, 0];

function num(value: number): string {
  // Three decimals is finer than a printer resolves and keeps the stream small.
  // `Number` rather than a template, so `-0` does not reach the file.
  return String(Number(value.toFixed(3)));
}

/** Escape a string for a PDF literal: the three characters that delimit one. */
function literal(value: string): string {
  return value.replace(/[\\()]/g, (match) => `\\${match}`);
}

/**
 * One page's drawing operations, accumulated as content-stream text.
 *
 * The coordinate system is the one a reader uses: the origin is the *bottom*
 * left of the page and y grows upwards. Every call here takes a y measured
 * that way, and the layout above converts once, in one place, rather than
 * flipping coordinates at each call site.
 */
export class PdfPage {
  private readonly parts: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  text(
    value: string,
    options: {
      readonly x: number;
      readonly y: number;
      readonly font?: PdfFont;
      readonly size?: number;
      readonly color?: PdfColor;
    },
  ): void {
    const text = toWinAnsi(value);
    if (text === '') return;

    const font = options.font ?? 'regular';
    const size = options.size ?? 9;
    const color = options.color ?? BLACK;

    this.parts.push(
      `${num(color[0])} ${num(color[1])} ${num(color[2])} rg`,
      'BT',
      `/${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf`,
      `${num(options.x)} ${num(options.y)} Td`,
      `(${literal(text)}) Tj`,
      'ET',
    );
  }

  /** Text whose *right* edge sits at `x`. What a column of figures needs. */
  textRight(
    value: string,
    options: {
      readonly x: number;
      readonly y: number;
      readonly font?: PdfFont;
      readonly size?: number;
      readonly color?: PdfColor;
    },
  ): void {
    const width = measureText(value, options.font ?? 'regular', options.size ?? 9);
    this.text(value, { ...options, x: options.x - width });
  }

  rect(options: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly color: PdfColor;
  }): void {
    this.parts.push(
      `${num(options.color[0])} ${num(options.color[1])} ${num(options.color[2])} rg`,
      `${num(options.x)} ${num(options.y)} ${num(options.width)} ${num(options.height)} re f`,
    );
  }

  line(options: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly width?: number;
    readonly color?: PdfColor;
  }): void {
    const color = options.color ?? BLACK;

    this.parts.push(
      `${num(color[0])} ${num(color[1])} ${num(color[2])} RG`,
      `${num(options.width ?? 0.5)} w`,
      `${num(options.x1)} ${num(options.y1)} m ${num(options.x2)} ${num(options.y2)} l S`,
    );
  }

  /** Draw the document's one image, scaled into the given box. */
  image(options: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): void {
    this.parts.push(
      'q',
      `${num(options.width)} 0 0 ${num(options.height)} ${num(options.x)} ${num(options.y)} cm`,
      '/Im0 Do',
      'Q',
    );
  }

  stream(): string {
    return this.parts.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/** A baseline JPEG, ready to be embedded by passthrough. */
export interface PdfImage {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

export interface PdfDocumentMeta {
  readonly title: string;
  readonly author: string;
  /** Fixed in tests so the bytes are reproducible. */
  readonly createdAt: Date;
}

/**
 * Read a baseline JPEG's pixel dimensions from its SOF marker.
 *
 * PDF embeds a JPEG by passing the compressed bytes straight through
 * `DCTDecode`, which is why the letterhead costs 70KB rather than a decoded
 * bitmap's two megabytes — but the image dictionary has to declare the size,
 * and only the file knows it. Returns null for anything that is not a
 * baseline or extended-sequential JPEG, because those are the two a reader is
 * guaranteed to handle through `DCTDecode`; a progressive file would be
 * accepted here and fail in the reader.
 */
export function readJpegSize(
  bytes: Buffer,
): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1] ?? 0;

    // SOF0 is baseline, SOF1 extended sequential. Both decode through
    // DCTDecode everywhere; SOF2 (progressive) does not, reliably.
    if (marker === 0xc0 || marker === 0xc1) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    // Markers with no payload, and the start of scan, end the useful header.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    if (marker === 0xda || marker === 0xd9) return null;

    offset += 2 + bytes.readUInt16BE(offset + 2);
  }

  return null;
}

/** A PDF date string: `D:YYYYMMDDHHmmSS+HH'mm'`, in UTC. */
function pdfDate(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, '0');

  return (
    `D:${String(value.getUTCFullYear())}${pad(value.getUTCMonth() + 1)}` +
    `${pad(value.getUTCDate())}${pad(value.getUTCHours())}` +
    `${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`
  );
}

/**
 * Assemble the pages into a file.
 *
 * Objects are numbered in the order they are written and the cross-reference
 * table records each one's byte offset, so the body is built first and the
 * table from the offsets it produced. A reader that cannot parse this table
 * cannot open the file at all, which is why `pdf-writer.test.ts` reads every
 * fixture back with a real PDF engine rather than asserting on the bytes it
 * expected to write.
 */
export function buildPdf(
  pages: readonly PdfPage[],
  meta: PdfDocumentMeta,
  image?: PdfImage,
): Buffer {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (value: string | Buffer): void => {
    const buffer = typeof value === 'string' ? Buffer.from(value, 'latin1') : value;
    chunks.push(buffer);
    length += buffer.length;
  };

  /** Open an object, recording where it starts. */
  const open = (id: number): void => {
    offsets[id] = length;
    push(`${String(id)} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  // A comment of high bytes, which is what tells a transfer that decides
  // text-versus-binary by sniffing that this file is binary.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object numbers are allocated as they are needed rather than from a fixed
  // map, so a document with no letterhead image has no gap in the sequence. A
  // gap would mean a free entry in the cross-reference table that is not in
  // the free list, which is malformed even though most readers forgive it.
  let nextId = 1;
  const allocate = (): number => {
    const id = nextId;
    nextId += 1;
    return id;
  };

  const catalogId = allocate();
  const pagesId = allocate();
  const regularId = allocate();
  const boldId = allocate();
  const imageId = image === undefined ? null : allocate();
  const pageIds = pages.map(() => ({ page: allocate(), content: allocate() }));
  const infoId = allocate();

  open(catalogId);
  push(`<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>\nendobj\n`);

  open(pagesId);
  push(
    `<< /Type /Pages /Count ${String(pages.length)} /Kids [` +
      `${pageIds.map(({ page }) => `${String(page)} 0 R`).join(' ')}] >>\nendobj\n`,
  );

  open(regularId);
  push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ' +
      '/Encoding /WinAnsiEncoding >>\nendobj\n',
  );

  open(boldId);
  push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ' +
      '/Encoding /WinAnsiEncoding >>\nendobj\n',
  );

  if (image !== undefined && imageId !== null) {
    open(imageId);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${String(image.width)} ` +
        `/Height ${String(image.height)} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${String(image.bytes.length)} >>\nstream\n`,
    );
    push(image.bytes);
    push('\nendstream\nendobj\n');
  }

  pages.forEach((page, index) => {
    const ids = pageIds[index];
    if (ids === undefined) return;

    const resources =
      imageId === null
        ? `<< /Font << /F1 ${String(regularId)} 0 R /F2 ${String(boldId)} 0 R >> >>`
        : `<< /Font << /F1 ${String(regularId)} 0 R /F2 ${String(boldId)} 0 R >> ` +
          `/XObject << /Im0 ${String(imageId)} 0 R >> >>`;

    open(ids.page);
    push(
      `<< /Type /Page /Parent ${String(pagesId)} 0 R ` +
        `/MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources ${resources} /Contents ${String(ids.content)} 0 R >>\nendobj\n`,
    );

    const stream = Buffer.from(page.stream(), 'latin1');
    open(ids.content);
    push(`<< /Length ${String(stream.length)} >>\nstream\n`);
    push(stream);
    push('\nendstream\nendobj\n');
  });

  open(infoId);
  push(
    `<< /Title (${literal(toWinAnsi(meta.title))}) ` +
      `/Author (${literal(toWinAnsi(meta.author))}) ` +
      `/Producer (${literal(toWinAnsi(meta.author))}) ` +
      `/CreationDate (${pdfDate(meta.createdAt)}) >>\nendobj\n`,
  );

  // One past the highest object number: `/Size` counts the free entry too.
  const size = nextId;
  const xrefAt = length;

  push(`xref\n0 ${String(size)}\n`);
  // The head of the free list. Exactly twenty bytes, like every other entry.
  push('0000000000 65535 f \n');

  for (let id = 1; id < size; id += 1) {
    const offset = offsets[id];
    if (offset === undefined) {
      throw new Error(`PDF object ${String(id)} was allocated but never written.`);
    }
    push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }

  push(
    `trailer\n<< /Size ${String(size)} /Root ${String(catalogId)} 0 R ` +
      `/Info ${String(infoId)} 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}
