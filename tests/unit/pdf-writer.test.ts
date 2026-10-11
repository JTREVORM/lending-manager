import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  buildPdf,
  fitText,
  measureText,
  PdfPage,
  readJpegSize,
  toWinAnsi,
} from '@/lib/reports/pdf-writer';

/**
 * The PDF writer, read back by a real PDF engine.
 *
 * Asserting the bytes we meant to write would prove the writer agrees with
 * itself. What matters is whether a *reader* agrees — whether the
 * cross-reference offsets land on the objects they claim, whether the content
 * stream parses, and above all whether the figures in the file come back out
 * as **text**. That last one is the brief's constraint made testable: a
 * screenshot has no text to extract, so a test that extracts
 * "UGX 1,250,000" from the file is the proof that the export is not one.
 *
 * `pdfjs-dist` is a development dependency only. It never ships: it is here to
 * be an independent reader, which is the only kind of witness worth having.
 */

const LOGO = join(process.cwd(), 'public/brand/polytos-logo.jpg');

interface ReadPdf {
  readonly pages: number;
  readonly title: string;
  readonly author: string;
  /** Every text run on a page, in the order the stream drew it. */
  readonly textByPage: readonly (readonly string[])[];
  /** Flattened, for a plain "does it say this" assertion. */
  readonly text: string;
  readonly hasImage: boolean;
}

async function readPdf(bytes: Buffer): Promise<ReadPdf> {
  // The legacy build is the one that runs under Node with no DOM.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjs.getDocument({
    // A copy, because pdf.js transfers ownership of the buffer it is given.
    data: new Uint8Array(bytes),
  }).promise;

  const textByPage: string[][] = [];
  let hasImage = false;

  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();

    textByPage.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter((value) => value !== ''),
    );

    const operators = await page.getOperatorList();
    if (operators.fnArray.includes(pdfjs.OPS.paintImageXObject)) hasImage = true;
  }

  const meta = await doc.getMetadata();
  const info = meta.info as { Title?: string; Author?: string };

  return {
    pages: doc.numPages,
    title: info.Title ?? '',
    author: info.Author ?? '',
    textByPage,
    text: textByPage.flat().join('\n'),
    hasImage,
  };
}

const META = {
  title: 'Collections',
  author: 'POLYTOS FINANCIAL SERVICES LTD',
  createdAt: new Date('2026-10-11T06:00:00Z'),
} as const;

describe('measuring text', () => {
  it('uses the standard metrics, so a width is the width the reader draws', () => {
    // Helvetica's space is 278/1000 em and its capital A is 667. At 10pt that
    // is 2.78 and 6.67 points, which is what the reader will advance by.
    expect(measureText(' ', 'regular', 10)).toBeCloseTo(2.78, 5);
    expect(measureText('A', 'regular', 10)).toBeCloseTo(6.67, 5);
    // Bold is wider. If this ever came back equal, the bold table would be a
    // copy of the regular one and every bold heading would overflow.
    expect(measureText('A', 'bold', 10)).toBeGreaterThan(measureText('A', 'regular', 10));
  });

  it('scales linearly with the size', () => {
    expect(measureText('Mukasa', 'regular', 18)).toBeCloseTo(
      measureText('Mukasa', 'regular', 9) * 2,
      5,
    );
  });

  it('measures the empty string as nothing', () => {
    expect(measureText('', 'regular', 9)).toBe(0);
  });
});

describe('the encoding', () => {
  it('keeps the characters a Ugandan name actually contains', () => {
    // Latin-1 covers ï, and the writer must not mangle a borrower's name.
    expect(toWinAnsi('Nakimuli Zaïnabu')).toBe('Nakimuli Zaïnabu');
    expect(toWinAnsi("Ssemakula's loan")).toBe("Ssemakula's loan");
  });

  it('maps the typographic characters that get pasted into free text', () => {
    // A curly apostrophe and an en dash are what a note copied out of a word
    // processor contains, and both have WinAnsi codes.
    expect(toWinAnsi('’')).toBe('\u0092');
    expect(toWinAnsi('–')).toBe('\u0096');
    expect(toWinAnsi('…')).toBe('\u0085');
  });

  it('substitutes visibly rather than dropping a character it cannot draw', () => {
    // Dropping it would shorten the name silently; the width the layout
    // measured would then be wrong too, because substitution happens first.
    const substituted = toWinAnsi('Mukasa 中');
    expect(substituted).toBe('Mukasa ?');
    expect(measureText('Mukasa 中', 'regular', 9)).toBeCloseTo(
      measureText('Mukasa ?', 'regular', 9),
      5,
    );
  });

  it('flattens newlines and tabs, because a cell is one line', () => {
    expect(toWinAnsi('two\nlines\there')).toBe('two lines here');
  });

  it('is idempotent, because a string passes through it three times', () => {
    // `fitText` converts before measuring, `measureText` converts again, and
    // `PdfPage.text` converts once more before writing. The first version
    // treated the 0x80–0x9F band as unmappable on the way back in, so the
    // second pass turned an already-encoded em dash into `?` — which put a
    // question mark in every "nothing recorded" money cell of every report.
    for (const character of [
      '\u2014',
      '\u2013',
      '\u2026',
      '\u2019',
      '\u201c',
      '\u2022',
    ]) {
      const once = toWinAnsi(character);
      expect(toWinAnsi(once), character).toBe(once);
      expect(toWinAnsi(toWinAnsi(once)), character).toBe(once);
    }
  });

  it('still substitutes a code the encoding leaves undefined', () => {
    // Five slots in that band have no glyph in WinAnsi. Passing one through
    // would write a byte the reader cannot draw; it has to stay visible.
    for (const code of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) {
      expect(toWinAnsi(String.fromCharCode(code)), code.toString(16)).toBe('?');
    }
  });

  it('renders an em dash as an em dash, all the way to the bytes', () => {
    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    // What a money column shows where nothing is recorded, which is a
    // different statement from zero.
    page.textRight('\u2014', { x: 500, y: 700 });

    const stream = buildPdf([page], META).toString('latin1');

    // 0x97 is WinAnsi's em dash. A `?` here is the defect above.
    expect(stream).toContain('(\u0097) Tj');
    expect(stream).not.toContain('(?) Tj');
  });
});

describe('fitting text to a column', () => {
  it('leaves a string that fits alone', () => {
    expect(fitText('Mukasa', 'regular', 9, 200)).toBe('Mukasa');
  });

  it('truncates to within the budget, marker included', () => {
    const long = 'Nakato Winnie Birungi of Kyebando Trading Centre';
    const fitted = fitText(long, 'regular', 9, 60);

    expect(fitted).not.toBe(long);
    expect(fitted.endsWith('…')).toBe(true);
    // The whole point: the result fits. A marker that pushed the cell over
    // the width it was announcing would be worse than no marker.
    expect(measureText(fitted, 'regular', 9)).toBeLessThanOrEqual(60);
  });

  it('returns nothing when even the marker will not fit', () => {
    expect(fitText('Mukasa', 'regular', 9, 1)).toBe('');
  });
});

describe('reading a JPEG header', () => {
  it('reads the official mark’s dimensions', () => {
    const size = readJpegSize(readFileSync(LOGO));

    expect(size).not.toBeNull();
    expect(size?.width).toBeGreaterThan(0);
    expect(size?.height).toBeGreaterThan(0);
    // The mark is wider than it is tall, which is what the letterhead's box
    // assumes when it scales by width.
    expect(size?.width ?? 0).toBeGreaterThan(size?.height ?? 0);
  });

  it('refuses something that is not a JPEG', () => {
    expect(readJpegSize(Buffer.from('%PDF-1.4', 'latin1'))).toBeNull();
    expect(readJpegSize(Buffer.alloc(0))).toBeNull();
  });
});

describe('building a document', () => {
  it('produces a file a real PDF engine opens', async () => {
    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.text('POLYTOS FINANCIAL SERVICES LTD', {
      x: 40,
      y: 800,
      font: 'bold',
      size: 14,
    });

    const result = await readPdf(buildPdf([page], META));

    expect(result.pages).toBe(1);
    expect(result.title).toBe('Collections');
    expect(result.author).toBe('POLYTOS FINANCIAL SERVICES LTD');
  });

  it('puts the figures in as text, which is what a screenshot cannot do', async () => {
    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.text('Nakimuli Zaïnabu', { x: 40, y: 700 });
    page.textRight('UGX 1,250,000', { x: 550, y: 700 });

    const result = await readPdf(buildPdf([page], META));

    // Extracted from the file, not read off a picture of it. This is the
    // brief's "not a browser screenshot" constraint, as an assertion.
    expect(result.text).toContain('Nakimuli Zaïnabu');
    expect(result.text).toContain('UGX 1,250,000');
  });

  it('survives the three characters that delimit a PDF string', async () => {
    // An unescaped bracket ends the string early and corrupts every operator
    // after it, so a client called "Mukasa (Jr)" would break the whole page.
    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.text('Mukasa (Jr) \\ and ) alone', { x: 40, y: 700 });

    const result = await readPdf(buildPdf([page], META));

    expect(result.text).toContain('Mukasa (Jr) \\ and ) alone');
  });

  it('right-aligns a figure at the edge it was given', () => {
    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.textRight('1,250,000', { x: 500, y: 700 });
    page.textRight('900', { x: 500, y: 686 });

    const bytes = buildPdf([page], META);
    const stream = bytes.toString('latin1');

    // Both runs end at x=500, so the longer one starts further left. A column
    // of figures that does not line up is the single most obvious defect in a
    // financial document.
    const positions = [...stream.matchAll(/([\d.]+) 700 Td/g)].map((match) =>
      Number(match[1]),
    );
    const shortPositions = [...stream.matchAll(/([\d.]+) 686 Td/g)].map((match) =>
      Number(match[1]),
    );

    expect(positions[0]).toBeLessThan(shortPositions[0] ?? 0);
    expect((positions[0] ?? 0) + measureText('1,250,000', 'regular', 9)).toBeCloseTo(
      500,
      1,
    );
  });

  it('embeds the letterhead mark as an image rather than redrawing it', async () => {
    const jpeg = readFileSync(LOGO);
    const size = readJpegSize(jpeg);
    expect(size).not.toBeNull();

    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.image({ x: 40, y: 760, width: 60, height: 40 });

    const result = await readPdf(
      buildPdf([page], META, {
        bytes: jpeg,
        width: size?.width ?? 1,
        height: size?.height ?? 1,
      }),
    );

    expect(result.hasImage).toBe(true);
  });

  it('carries the image bytes through untouched, not re-encoded', () => {
    const jpeg = readFileSync(LOGO);
    const size = readJpegSize(jpeg);

    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.image({ x: 40, y: 760, width: 60, height: 40 });

    const bytes = buildPdf([page], META, {
      bytes: jpeg,
      width: size?.width ?? 1,
      height: size?.height ?? 1,
    });

    // `DCTDecode` is a passthrough, so the JPEG appears in the file verbatim.
    // That is why a letterhead costs 70KB rather than a decoded bitmap's two
    // megabytes, and it is checked because a stray string conversion would
    // silently corrupt the bytes while leaving the file openable.
    expect(bytes.includes(jpeg)).toBe(true);
    expect(bytes.toString('latin1')).toContain('/Filter /DCTDecode');
  });

  it('numbers every object it allocates, with no gap', () => {
    // A gap would be a free entry in the cross-reference table that is not in
    // the free list — malformed, even where a reader forgives it. The writer
    // throws rather than emitting one, so this asserts the no-image case,
    // which is where a fixed object map would have left a hole.
    const page = new PdfPage(A4_PORTRAIT.width, A4_PORTRAIT.height);
    page.text('No letterhead here', { x: 40, y: 700 });

    const stream = buildPdf([page], META).toString('latin1');
    const declared = Number(/\/Size (\d+)/.exec(stream)?.[1] ?? 0);
    const written = [...stream.matchAll(/^(\d+) 0 obj$/gm)].map((match) =>
      Number(match[1]),
    );

    expect(written.sort((a, b) => a - b)).toStrictEqual(
      Array.from({ length: declared - 1 }, (_, index) => index + 1),
    );
  });

  it('opens a multi-page document and keeps each page’s own content', async () => {
    const pages = ['First page', 'Second page', 'Third page'].map((label) => {
      const page = new PdfPage(A4_LANDSCAPE.width, A4_LANDSCAPE.height);
      page.text(label, { x: 40, y: 500 });
      return page;
    });

    const result = await readPdf(buildPdf(pages, META));

    expect(result.pages).toBe(3);
    expect(result.textByPage[0]?.join('')).toContain('First page');
    expect(result.textByPage[2]?.join('')).toContain('Third page');
  });

  it('refuses to build a document with no pages', () => {
    expect(() => buildPdf([], META)).toThrow(/at least one page/i);
  });
});
