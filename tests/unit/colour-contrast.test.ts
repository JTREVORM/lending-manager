import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Text contrast, recomputed from `app/globals.css`.
 *
 * ## Why this is a test and not a review note
 *
 * An axe sweep found that three of the four status colours failed WCAG AA in
 * light mode (success 4.11, info 4.30, warning 3.02 against their own badge
 * tints) and that **all four** failed in dark mode (2.74 to 3.13), because
 * the dark block redefined the surfaces and left the text colours at their
 * light-mode values. None of it looked obviously wrong in a screenshot — a
 * badge at 4.1:1 is perfectly legible to the person who chose the colour, on
 * the screen they chose it on.
 *
 * So the floor is asserted arithmetically, from the same declarations the
 * browser reads. A token nudged for aesthetic reasons fails here rather than
 * in a review, or in daylight on a counter in Kampala.
 *
 * ## 4.5:1, not 3:1
 *
 * The badges are 12px at normal weight, which is below WCAG's large-text
 * threshold in both dimensions, so the large-text allowance does not apply to
 * any of them.
 */

const CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

/** WCAG AA for text below 18pt / 14pt bold. */
const FLOOR = 4.5;

// ---------------------------------------------------------------------------
// oklch -> sRGB -> relative luminance -> contrast ratio
//
// Implemented here rather than pulled in as a dependency: it is twenty lines
// of published matrix arithmetic, and a colour library would be a runtime
// dependency carried for one test.
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

function oklchToSrgb(lightness: number, chroma: number, hueDeg: number): Rgb {
  const hue = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  const encode = (v: number): number =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

  const [r, g, b2] = linear.map((v) => Math.min(1, Math.max(0, encode(v))));
  return [r ?? 0, g ?? 0, b2 ?? 0];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number): number =>
    v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// Reading the tokens out of the stylesheet
// ---------------------------------------------------------------------------

/**
 * Split the stylesheet into its light block and its dark block.
 *
 * Dark mode is an override, so a token declared in both has two values.
 * Reading the file in halves is what makes "the dark value" a thing this test
 * can talk about, and every assertion below depends on finding the right
 * half.
 *
 * The dark half is the palette block **and nothing after it**. It used to run
 * to the end of the file, which was the same thing right up until a component
 * rule scoped a token to itself — `.record-surface` darkens
 * `--color-text-muted` on its tinted panel, and a naive "last declaration in
 * the file" read mistook that for the dark theme's value and reported a
 * 2.35:1 that no viewer ever sees. A theme value lives in the theme block;
 * reading only that block is what the test always meant.
 *
 * The marker is the palette's own selector. It was
 * `@media (prefers-color-scheme: dark)` until the palette stopped being
 * applied from the system preference and became opt-in under
 * `data-theme="dark"`. The old string still occurs in the file — in the
 * comment explaining that change — and `blockAt` would still have landed on
 * the right block from there, by luck. Matching the selector is the same
 * assertion made deliberately instead of by coincidence, and it does not
 * survive someone rewording a comment.
 *
 * Nothing else here changed: the palette is still held to WCAG AA on every
 * pair, whether or not anything switches it on today.
 */
const DARK_MARKER = ":root[data-theme='dark'] {";

/** The `{ … }` block that opens at or after `from`, with its braces matched. */
function blockAt(source: string, from: number): string {
  const open = source.indexOf('{', from);
  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }

  throw new Error('Unbalanced braces in app/globals.css.');
}

const lightSource = CSS.slice(0, CSS.indexOf(DARK_MARKER));
const darkSource = blockAt(CSS, CSS.indexOf(DARK_MARKER));

function readOklch(source: string, token: string): Rgb {
  // The last declaration wins, which is what the cascade does too.
  const matches = [
    ...source.matchAll(
      new RegExp(
        `--${token}:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`,
        'g',
      ),
    ),
  ];

  const last = matches.at(-1);
  if (last === undefined) {
    throw new Error(`--${token} is not declared as an oklch() colour.`);
  }

  return oklchToSrgb(Number(last[1]), Number(last[2]), Number(last[3]));
}

/** Text token, the tint it is read on, and what it is for. */
const BADGE_PAIRS = [
  ['color-success', 'color-success-surface', 'a cleared loan, a posted payment'],
  ['color-warning', 'color-warning-surface', 'a grace period, arrears'],
  ['color-danger', 'color-danger-surface', 'a reversal, a penalty due'],
  ['color-info', 'color-info-surface', 'a draft, a pending decision'],
] as const;

describe('status colours in light mode', () => {
  for (const [text, surface, what] of BADGE_PAIRS) {
    it(`${text} on ${surface} is readable (${what})`, () => {
      const ratio = contrastRatio(
        readOklch(lightSource, text),
        readOklch(lightSource, surface),
      );

      expect(
        ratio,
        `${ratio.toFixed(2)}:1, needs ${String(FLOOR)}:1`,
      ).toBeGreaterThanOrEqual(FLOOR);
    });
  }

  it('each status colour is also readable on the page itself', () => {
    // The same tokens are used for text outside a badge — a figure in a
    // summary, a line of explanation — where the background is the surface.
    const page = readOklch(lightSource, 'color-surface');

    for (const [text] of BADGE_PAIRS) {
      const ratio = contrastRatio(readOklch(lightSource, text), page);
      expect(ratio, `${text} on the page: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        FLOOR,
      );
    }
  });
});

describe('status colours in dark mode', () => {
  // The defect this block exists for: the dark override redefined the four
  // surfaces and left the four text colours at their light-mode values, so
  // every status badge was dark ink on a dark tint and all four failed.
  for (const [text, surface, what] of BADGE_PAIRS) {
    it(`${text} on ${surface} is readable (${what})`, () => {
      const ratio = contrastRatio(
        readOklch(darkSource, text),
        readOklch(darkSource, surface),
      );

      expect(
        ratio,
        `${ratio.toFixed(2)}:1, needs ${String(FLOOR)}:1`,
      ).toBeGreaterThanOrEqual(FLOOR);
    });
  }

  it('every status colour the dark block redefines a surface for is itself redefined', () => {
    // The structural version of the same claim: a surface given a dark value
    // without its text colour is the shape of the original bug, and it would
    // pass the ratio tests above only by coincidence.
    for (const [text, surface] of BADGE_PAIRS) {
      expect(darkSource, `--${surface} has no dark value`).toContain(`--${surface}:`);
      expect(darkSource, `--${text} has no dark value`).toContain(`--${text}:`);
    }
  });
});

describe('the body text and the accent', () => {
  it('body text clears AA on the page in both modes', () => {
    for (const [name, source] of [
      ['light', lightSource],
      ['dark', darkSource],
    ] as const) {
      const ratio = contrastRatio(
        readOklch(source, 'color-text'),
        readOklch(source, 'color-surface'),
      );

      expect(ratio, `${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(7);
    }
  });

  it('muted text clears AA on the page in both modes', () => {
    // Muted is where a contrast floor is usually lost, because "muted" is the
    // whole point of the token.
    for (const [name, source] of [
      ['light', lightSource],
      ['dark', darkSource],
    ] as const) {
      const ratio = contrastRatio(
        readOklch(source, 'color-text-muted'),
        readOklch(source, 'color-surface'),
      );

      expect(ratio, `${name}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it('the accent clears AA on the page, and its contrast colour on the accent', () => {
    for (const [name, source] of [
      ['light', lightSource],
      ['dark', darkSource],
    ] as const) {
      const onPage = contrastRatio(
        readOklch(source, 'color-accent'),
        readOklch(source, 'color-surface'),
      );
      expect(
        onPage,
        `${name}, accent on page: ${onPage.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(FLOOR);

      const onAccent = contrastRatio(
        readOklch(source, 'color-accent-contrast'),
        readOklch(source, 'color-accent'),
      );
      expect(
        onAccent,
        `${name}, text on accent: ${onAccent.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(FLOOR);
    }
  });
});

describe('muted text on every ground it lands on', () => {
  /*
    The gap this closes.

    Muted text was slate-500, which clears AA on white — and the suite only
    ever checked it on white, because that is where most content sits. It is
    4.34:1 on the `#F1F5F9` application shell and 4.18:1 on the `#eaf1f8`
    record panel, so `/offline`, which sits straight on the shell, and the
    guarantor register's phone panels both failed an axe sweep that the unit
    tests had passed.

    Muted text is not confined to white surfaces. The floor is now asserted
    against every ground it is actually used on.
  */
  function hexToSrgb(hex: string): Rgb {
    const value = hex.replace('#', '');
    return [
      Number.parseInt(value.slice(0, 2), 16) / 255,
      Number.parseInt(value.slice(2, 4), 16) / 255,
      Number.parseInt(value.slice(4, 6), 16) / 255,
    ];
  }

  it('clears AA on the application shell', () => {
    // `.app-shell` paints `#f1f5f9` under every staff screen, and a page with
    // no card of its own — `/offline`, an empty state — puts text on it.
    const ratio = contrastRatio(
      readOklch(lightSource, 'color-text-muted'),
      hexToSrgb('#f1f5f9'),
    );

    expect(ratio, `${ratio.toFixed(2)}:1 on the shell`).toBeGreaterThanOrEqual(FLOOR);
  });

  it('clears AA on the record panel', () => {
    // The phone rendering of every register: a row becomes a panel on the
    // reference's `#eaf1f8` tint.
    const ratio = contrastRatio(
      readOklch(lightSource, 'color-text-muted'),
      hexToSrgb('#eaf1f8'),
    );

    expect(ratio, `${ratio.toFixed(2)}:1 on the record panel`).toBeGreaterThanOrEqual(
      FLOOR,
    );
  });

  it('clears AA on the sunken surface', () => {
    // Table headers and read-only fields.
    const ratio = contrastRatio(
      readOklch(lightSource, 'color-text-muted'),
      readOklch(lightSource, 'color-surface-sunken'),
    );

    expect(ratio, `${ratio.toFixed(2)}:1 on the sunken surface`).toBeGreaterThanOrEqual(
      FLOOR,
    );
  });

  it("the record tint is the reference's own", () => {
    expect(lightSource).toContain('--color-record: #eaf1f8');
  });
});
