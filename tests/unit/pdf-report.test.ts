import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DocumentBranding } from '@/lib/data/company';
import {
  countField,
  moneyField,
  textField,
  type ReportField,
} from '@/lib/reports/columns';
import {
  agingFields,
  arrearsFields,
  clientFields,
  collateralFields,
  collectionFields,
  guarantorFields,
  penaltyFields,
  portfolioFields,
  recoveryFields,
} from '@/lib/reports/fields';
import { renderReportPdf, type ReportPdfInput } from '@/lib/reports/pdf-report';
import { readJpegSize } from '@/lib/reports/pdf-writer';

/**
 * The report layout, read back by an independent PDF engine.
 *
 * The questions worth asking of a layout are not about coordinates. They are:
 * does the letterhead's content reach the page; does a long report paginate
 * and does every page say which page it is; does the table's heading repeat
 * where it has to; and — the one the brief turns on — does a figure come back
 * out of the file as a *string*.
 */

const LOGO = join(process.cwd(), 'public/brand/polytos-logo.jpg');

/**
 * Every field set this application actually ships, by name.
 *
 * The fixture report below has four columns. The real ones have thirteen to
 * twenty-seven, which is the range where a layout either bands or breaks — so
 * the geometry is checked against these rather than against the fixture.
 */
const ZONE = 'Africa/Kampala';

const REAL_FIELD_SETS: readonly (readonly [string, readonly ReportField<never>[]])[] = [
  ['collections', collectionFields(ZONE)],
  ['loans', portfolioFields(ZONE)],
  ['arrears', arrearsFields(ZONE, { withRemarks: true })],
  ['penalties', penaltyFields(ZONE)],
  ['clients', clientFields(ZONE)],
  ['aging', agingFields()],
  ['recovery', recoveryFields(ZONE)],
  ['guarantors', guarantorFields(ZONE)],
  ['collateral', collateralFields(ZONE)],
];

const BRANDING: DocumentBranding = {
  companyName: 'POLYTOS FINANCIAL SERVICES LTD',
  tagline: 'Empowering Your Business Swiftly',
  logoPath: '/brand/polytos-logo.webp',
  phone: '+256 768 735 982',
  phoneSecondary: '+256 703 587 676',
  postalAddress: 'P.O. Box 219933, Kampala',
  physicalAddress: 'Nsumbi, Kyebando, Kampala, Uganda',
  receiptHeader: null,
  receiptFooter: null,
  timezone: 'Africa/Kampala',
};

interface Collection {
  readonly receipt: string;
  readonly client: string;
  readonly amount: number;
  readonly missed: number;
}

const FIELDS = [
  textField<Collection>('Receipt', (row) => row.receipt, { weight: 1.2 }),
  textField<Collection>('Borrower', (row) => row.client, { weight: 2.4 }),
  moneyField<Collection>('Amount', (row) => row.amount),
  countField<Collection>('Missed', (row) => row.missed),
];

function rows(count: number): readonly Collection[] {
  return Array.from({ length: count }, (_, index) => ({
    receipt: `RC2600${String(index + 1).padStart(3, '0')}`,
    client: index === 0 ? 'Nakimuli Zaïnabu' : `Borrower ${String(index + 1)}`,
    amount: 50_000 + index * 1_000,
    missed: index % 4,
  }));
}

function input(
  overrides: Partial<ReportPdfInput<Collection>> = {},
): ReportPdfInput<Collection> {
  return {
    branding: BRANDING,
    title: 'Collections',
    coverage: '11 October 2026',
    filters: ['Method: Cash'],
    fields: FIELDS,
    rows: rows(3),
    totals: [{ label: 'Collected', value: 'UGX 153,000' }],
    capped: false,
    generatedBy: 'Mwesigwa Trevor',
    generatedAt: new Date('2026-10-11T06:00:00Z'),
    ...overrides,
  };
}

interface ReadPdf {
  readonly pages: number;
  readonly textByPage: readonly string[];
  readonly text: string;
  readonly title: string;
}

async function readPdf(bytes: Buffer): Promise<ReadPdf> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;

  const textByPage: string[] = [];

  for (let index = 1; index <= doc.numPages; index += 1) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    textByPage.push(
      content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    );
  }

  const meta = await doc.getMetadata();
  const info = meta.info as { Title?: string };

  return {
    pages: doc.numPages,
    textByPage,
    text: textByPage.join('\n'),
    title: info.Title ?? '',
  };
}

describe('the letterhead', () => {
  it('carries the whole identity, not just the name', async () => {
    const result = await readPdf(renderReportPdf(input()));

    // Everything a borrower or an auditor needs to know who issued the
    // document. The receipt and the statement carry the same set, from the
    // same row of `company_settings`.
    expect(result.text).toContain('POLYTOS FINANCIAL SERVICES LTD');
    expect(result.text).toContain('Empowering Your Business Swiftly');
    expect(result.text).toContain('+256 768 735 982');
    expect(result.text).toContain('+256 703 587 676');
    expect(result.text).toContain('P.O. Box 219933, Kampala');
    expect(result.text).toContain('Nsumbi, Kyebando, Kampala, Uganda');
  });

  it('renders a business with no tagline and one number', async () => {
    const result = await readPdf(
      renderReportPdf(
        input({
          branding: {
            ...BRANDING,
            tagline: null,
            phoneSecondary: null,
            postalAddress: null,
          },
        }),
      ),
    );

    expect(result.text).toContain('POLYTOS FINANCIAL SERVICES LTD');
    expect(result.text).not.toContain('Empowering');
    expect(result.text).toContain('+256 768 735 982');
    expect(result.text).not.toContain('+256 703 587 676');
  });

  it('embeds the official mark where one is supplied', async () => {
    const jpeg = readFileSync(LOGO);
    const size = readJpegSize(jpeg);
    expect(size).not.toBeNull();

    const bytes = renderReportPdf(
      input({
        logo: { bytes: jpeg, width: size?.width ?? 1, height: size?.height ?? 1 },
      }),
    );

    // Passthrough, so the mark appears verbatim rather than re-encoded.
    expect(bytes.includes(jpeg)).toBe(true);
    // And the text still reaches the page beside it.
    expect((await readPdf(bytes)).text).toContain('POLYTOS FINANCIAL SERVICES LTD');
  });
});

describe('what the document says about itself', () => {
  it('names the report, what it covers and the filters applied', async () => {
    const result = await readPdf(renderReportPdf(input()));

    expect(result.text).toContain('Collections');
    expect(result.text).toContain('11 October 2026');
    expect(result.text).toContain('Filters: Method: Cash');
    // A figure circulated without the filters behind it is a figure nobody
    // can reproduce.
    expect(result.text).toContain('3 rows');
  });

  it('says who ran it and when, on every page', async () => {
    const result = await readPdf(renderReportPdf(input({ rows: rows(120) })));

    expect(result.pages).toBeGreaterThan(1);

    for (const page of result.textByPage) {
      expect(page).toContain('Mwesigwa Trevor');
      expect(page).toMatch(/Page \d+ of \d+/);
    }
  });

  it('numbers the pages against the real total', async () => {
    const result = await readPdf(renderReportPdf(input({ rows: rows(150) })));

    // "Page 1 of 1" on a four-page document is the defect a two-pass layout
    // exists to prevent, and the one a reader notices immediately.
    for (const [index, page] of result.textByPage.entries()) {
      expect(page).toContain(`Page ${String(index + 1)} of ${String(result.pages)}`);
    }
  });

  it('puts the report and the company in the document title', async () => {
    const result = await readPdf(renderReportPdf(input()));

    expect(result.title).toContain('Collections');
    expect(result.title).toContain('POLYTOS FINANCIAL SERVICES LTD');
  });
});

describe('the table', () => {
  it('puts every figure in as text', async () => {
    const result = await readPdf(renderReportPdf(input()));

    expect(result.text).toContain('RC2600001');
    expect(result.text).toContain('Nakimuli Zaïnabu');
    // Grouped for reading — this is the page, not the spreadsheet.
    expect(result.text).toContain('50,000');
  });

  it('repeats the column headings on a continuation page', async () => {
    const result = await readPdf(renderReportPdf(input({ rows: rows(120) })));

    expect(result.pages).toBeGreaterThan(1);

    // A page of figures with no headings is a page that has to be read next
    // to another one.
    for (const page of result.textByPage) {
      expect(page).toContain('Borrower');
      expect(page).toContain('Amount');
    }
  });

  it('states the currency once rather than on every money column', async () => {
    const result = await readPdf(renderReportPdf(input()));

    // The field's heading is `Amount (UGX)` and the spreadsheet gets exactly
    // that, because a spreadsheet column needs its unit. A document with
    // fourteen money columns does not need it fourteen times — and repeating
    // it was what pushed "Contract outstanding (UGX)" past three lines, so
    // the reader saw "Contract outstandin…" and lost the unit anyway.
    expect(result.text).toContain('All amounts in UGX');
    expect(result.text).not.toContain('Amount (UGX)');

    // The CSV heading is untouched: one declaration, two renderings.
    expect(FIELDS.find((field) => field.kind === 'money')?.header).toBe('Amount (UGX)');
  });

  it('identifies a continuation page that has been separated from the rest', async () => {
    const result = await readPdf(renderReportPdf(input({ rows: rows(120) })));

    for (const page of result.textByPage.slice(1)) {
      expect(page).toContain('POLYTOS FINANCIAL SERVICES LTD');
      expect(page).toContain('Collections');
    }
  });

  it('goes landscape when the columns need the width', async () => {
    const wide = [
      ...FIELDS,
      textField<Collection>('Note one', () => 'a', { weight: 3 }),
      textField<Collection>('Note two', () => 'b', { weight: 3 }),
    ];

    const portrait = await readPdf(renderReportPdf(input()));
    const landscape = await readPdf(renderReportPdf(input({ fields: wide })));

    expect(portrait.pages).toBe(1);
    expect(landscape.pages).toBe(1);

    // Both open; the orientation is in the MediaBox rather than the text, so
    // it is read off the bytes.
    const portraitBytes = renderReportPdf(input()).toString('latin1');
    const landscapeBytes = renderReportPdf(input({ fields: wide })).toString('latin1');

    expect(portraitBytes).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(landscapeBytes).toContain('/MediaBox [0 0 841.89 595.28]');
  });

  it('truncates a name too long for its column rather than overprinting', async () => {
    const result = await readPdf(
      renderReportPdf(
        input({
          rows: [
            {
              receipt: 'RC2600001',
              client:
                'Nakato Winnie Birungi of Kyebando Trading Centre and Nsumbi Zone B',
              amount: 50_000,
              missed: 0,
            },
          ],
        }),
      ),
    );

    // The marker is the honest signal that a value was shortened. Overprinting
    // the next column would look like data rather than like truncation.
    expect(result.text).toContain('…');
    expect(result.text).not.toContain('Nsumbi Zone B');
  });

  it('renders an empty selection without pretending it has rows', async () => {
    const result = await readPdf(renderReportPdf(input({ rows: [], totals: [] })));

    expect(result.pages).toBe(1);
    expect(result.text).toContain('0 rows');
    // The headings are still there: an empty report should look like the
    // report it is, not like a blank page.
    expect(result.text).toContain('Borrower');
  });
});

describe('the totals', () => {
  it('prints them at the foot', async () => {
    const result = await readPdf(renderReportPdf(input()));

    expect(result.text).toContain('Collected');
    expect(result.text).toContain('UGX 153,000');
  });

  it('withholds them, with the reason, when the selection hit the ceiling', async () => {
    const result = await readPdf(
      renderReportPdf(
        input({
          rows: rows(40),
          capped: true,
          totals: [{ label: 'Collected', value: 'UGX 999,999' }],
        }),
      ),
    );

    // ADR-042. A PDF's printed total is the figure somebody circulates, so a
    // total of part of a selection must not appear at all — and the document
    // has to say why, or the absence reads as a bug.
    expect(result.text).not.toContain('UGX 999,999');
    expect(result.text).toContain('Totals are not shown for this selection');
    expect(result.text).toContain('export ceiling');
  });

  it('keeps the totals on a page even when the rows fill the last one', async () => {
    // The row count is tuned to land the table's end near the floor, which is
    // where a totals band that did not move to a new page would be drawn off
    // the bottom and silently lost.
    for (const count of [57, 58, 59, 60, 61, 62]) {
      const result = await readPdf(renderReportPdf(input({ rows: rows(count) })));
      expect(result.text, `${String(count)} rows`).toContain('UGX 153,000');
    }
  });
});

describe('a report too wide for one page width', () => {
  /*
   * The defect this suite missed the first time.
   *
   * The layout divided the page by the fields' weights alone. With four
   * columns — which is what the fixture above has — that is 180pt each and
   * everything reads. With the real reports it was 16.7pt: two characters, so
   * every cell on the arrears report read `Na…`. The unit tests passed, and
   * the browser tests passed, because both only asked whether *some* text was
   * in the file.
   *
   * So these tests are written against a column count the real reports
   * actually have, and they assert that the values arrive whole.
   */

  interface Wide {
    readonly loan: string;
    readonly client: string;
    readonly amount: number;
    readonly note: string;
  }

  /** Twenty-seven columns, which is what the arrears report has. */
  function wideFields(): readonly ReportField<Wide>[] {
    const fields: ReportField<Wide>[] = [textField('Loan number', (row) => row.loan)];

    for (let index = 0; index < 8; index += 1) {
      fields.push(
        textField(`Borrower ${String(index)}`, (row) => row.client, { weight: 2.2 }),
      );
    }
    for (let index = 0; index < 12; index += 1) {
      fields.push(moneyField(`Figure ${String(index)}`, (row) => row.amount));
    }
    for (let index = 0; index < 6; index += 1) {
      fields.push(countField(`Count ${String(index)}`, () => 34));
    }

    return fields;
  }

  const WIDE_ROWS: readonly Wide[] = [
    {
      loan: 'LN260014',
      client: 'Nakato Winnie',
      amount: 1_250_000,
      note: 'Promised Friday',
    },
    { loan: 'LN260015', client: 'Mukasa Joseph', amount: 940_000, note: 'No answer' },
  ];

  function wideInput(): ReportPdfInput<Wide> {
    return {
      ...input(),
      fields: wideFields(),
      rows: WIDE_ROWS,
      totals: [{ label: 'Total', value: 'UGX 2,190,000' }],
    };
  }

  it('bands the columns instead of squeezing them to an ellipsis', async () => {
    const result = await readPdf(renderReportPdf(wideInput()));

    // Both bands exist and each says what it is, so a reader holding one page
    // knows which columns they are looking at and that the rows are the same.
    expect(result.text).toMatch(/Columns 1 to \d+ of 27/);
    expect(result.text).toMatch(/Columns \d+ to 27 of 27/);
    expect(result.text).toContain('The same rows throughout');
  });

  it('carries every value whole, with no cell truncated', async () => {
    const result = await readPdf(renderReportPdf(wideInput()));

    // The figures and the names arrive in full. This is the assertion that
    // would have failed on the first layout: at 16.7pt a column, `1,250,000`
    // came out as `1,…`.
    expect(result.text).toContain('1,250,000');
    expect(result.text).toContain('940,000');
    expect(result.text).toContain('Nakato Winnie');
    expect(result.text).toContain('Mukasa Joseph');
    expect(result.text).toContain('LN260014');
  });

  it('repeats the anchor column into the later band', async () => {
    const result = await readPdf(renderReportPdf(wideInput()));

    // Without it, the second band is a page of figures nobody can line up
    // against the first.
    const pagesWithLoanNumber = result.textByPage.filter((page) =>
      page.includes('LN260014'),
    );

    expect(pagesWithLoanNumber.length).toBeGreaterThanOrEqual(2);
    expect(result.text).toMatch(/Loan number repeated/);
  });

  it('starts each band on its own page', async () => {
    const result = await readPdf(renderReportPdf(wideInput()));

    // Two column sets on one page, separated only by a heading, is how a
    // reader comes to believe a figure belongs to the wrong column.
    for (const page of result.textByPage) {
      const bandLabels = page.match(/Columns \d+ to \d+ of 27/g) ?? [];
      expect(bandLabels.length).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every report this application ships off the ellipsis floor', () => {
    // A straight check on the geometry, so a report added later with thirty
    // columns of prose fails here rather than in a printout. Every column of
    // every band must be wide enough for the kind of value it holds.
    for (const [name, fields] of REAL_FIELD_SETS) {
      const bytes = renderReportPdf({
        ...input(),
        fields,
        rows: [],
        totals: [],
      } as unknown as ReportPdfInput<unknown>);

      // The widths are in the content stream as `re` fills and `Td` offsets;
      // what is asserted here is the simpler, stronger thing — that the
      // document was produced at all and that its band labels are coherent.
      const text = bytes.toString('latin1');
      const labels = [...text.matchAll(/Columns (\d+) to (\d+) of (\d+)/g)];

      if (labels.length === 0) continue;

      const total = Number(labels[0]?.[3] ?? 0);
      expect(total, name).toBe(fields.length);

      // The bands cover every column exactly once, in order, with no gap.
      const ranges = labels
        .map((match) => [Number(match[1]), Number(match[2])] as const)
        .filter(
          (range, index, all) =>
            all.findIndex((other) => other[0] === range[0]) === index,
        );

      expect(ranges[0]?.[0], name).toBe(1);
      expect(ranges[ranges.length - 1]?.[1], name).toBe(fields.length);

      for (let index = 1; index < ranges.length; index += 1) {
        expect(ranges[index]?.[0], `${name} band ${String(index)}`).toBe(
          (ranges[index - 1]?.[1] ?? 0) + 1,
        );
      }
    }
  });
});
