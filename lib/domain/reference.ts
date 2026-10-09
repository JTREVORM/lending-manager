/**
 * Human-readable reference numbers: `CL26001`, `LN260001`, `PAY260001`.
 *
 * ## Where they come from
 *
 * **The database generates them, not this module.** `public.next_reference(scope)`
 * performs an atomic upsert against `public.reference_sequences` and returns
 * the formatted value. That is the only safe place for it: two cashiers
 * registering a client at the same moment must not be able to receive the same
 * number, and nothing running in application code can guarantee that.
 *
 * Specifically rejected as approaches:
 *
 *   - `SELECT count(*) + 1` — two concurrent transactions read the same count.
 *   - A timestamp — collides within the same millisecond, and leaks timing.
 *   - Client-side random or UUID — not sequential, not human-quotable, and a
 *     malicious client controls it.
 *
 * ## What this module is for
 *
 * Formatting, parsing and validation on the TypeScript side: rendering a
 * reference, checking one typed into a search box, and testing that the
 * application and the database agree on the shape. Every function here is pure.
 *
 * ## The format
 *
 *   `<PREFIX><YY><SEQUENCE padded to width>`
 *
 * The prefix, the padding width and the next value are **rows in
 * `reference_sequences`**, not constants, so the business can change them
 * without a code change. The values below mirror the seeded defaults and are
 * used for formatting and tests.
 *
 * See docs/DECISIONS.md (ADR-005).
 */

import { businessReferenceYear } from './datetime';

/** Entity kinds that carry a reference number. */
export const REFERENCE_SCOPES = [
  'client',
  'loan',
  'payment',
  // Phase 10.
  'branch',
  'journal',
  // Phase 11. The four documents that move money without being a loan.
  'transfer',
  'expense',
  'other_income',
  'reconciliation',
] as const;
export type ReferenceScope = (typeof REFERENCE_SCOPES)[number];

/**
 * What each scope numbers, in the words a person would use.
 *
 * Phase 12. The settings screen lists the counters so an Owner can see what
 * numbering is in use, and `other_income` on a screen reads as a column name
 * rather than as a thing the business does.
 */
export const REFERENCE_SCOPE_LABELS: Readonly<Record<ReferenceScope, string>> = {
  client: 'Clients',
  loan: 'Loans',
  payment: 'Payments',
  branch: 'Branches',
  journal: 'Journal entries',
  transfer: 'Transfers',
  expense: 'Expenses',
  other_income: 'Other income',
  reconciliation: 'Daily counts',
};

export interface ReferenceFormat {
  readonly scope: ReferenceScope;
  readonly prefix: string;
  /** Minimum digits in the sequence portion, left-padded with zeros. */
  readonly padding: number;
}

/**
 * Seeded defaults, matching migration `0006_seed_reference_data.sql`.
 *
 * A test asserts these stay in step with the database rows.
 */
export const REFERENCE_FORMAT_DEFAULTS: Readonly<
  Record<ReferenceScope, ReferenceFormat>
> = {
  client: { scope: 'client', prefix: 'CL', padding: 3 },
  loan: { scope: 'loan', prefix: 'LN', padding: 4 },
  payment: { scope: 'payment', prefix: 'PAY', padding: 4 },
  branch: { scope: 'branch', prefix: 'BR', padding: 2 },
  // 'JV' for journal voucher, the name the printed ledger uses.
  journal: { scope: 'journal', prefix: 'JV', padding: 5 },
  transfer: { scope: 'transfer', prefix: 'TF', padding: 5 },
  expense: { scope: 'expense', prefix: 'EX', padding: 5 },
  other_income: { scope: 'other_income', prefix: 'OI', padding: 5 },
  reconciliation: { scope: 'reconciliation', prefix: 'RC', padding: 5 },
} as const;

export class ReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceError';
  }
}

/**
 * Format a reference from its parts.
 *
 * ```
 * formatReference('client', 26, 1)    // 'CL26001'
 * formatReference('loan', 26, 1)      // 'LN260001'
 * formatReference('payment', 26, 1)   // 'PAY260001'
 * formatReference('client', 26, 1234) // 'CL261234'  — overflows the padding
 * ```
 *
 * A sequence wider than the padding is **not** truncated; the reference simply
 * grows. Truncating would produce duplicates.
 */
export function formatReference(
  scope: ReferenceScope,
  twoDigitYear: number,
  sequence: number,
  format: ReferenceFormat = REFERENCE_FORMAT_DEFAULTS[scope],
): string {
  if (!Number.isInteger(twoDigitYear) || twoDigitYear < 0 || twoDigitYear > 99) {
    throw new ReferenceError(
      `Year must be a two-digit number between 0 and 99, received ${String(twoDigitYear)}.`,
    );
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new ReferenceError(
      `Sequence must be a positive whole number, received ${String(sequence)}.`,
    );
  }

  const year = String(twoDigitYear).padStart(2, '0');
  const serial = String(sequence).padStart(format.padding, '0');

  return `${format.prefix}${year}${serial}`;
}

export interface ParsedReference {
  readonly scope: ReferenceScope;
  readonly prefix: string;
  readonly twoDigitYear: number;
  readonly sequence: number;
}

/**
 * Parse a reference back into its parts, tolerating lowercase and surrounding
 * whitespace so a value pasted from a receipt still matches.
 *
 * Returns `null` rather than throwing — this is used on search input, where a
 * non-match is an ordinary outcome.
 */
export function parseReference(value: string): ParsedReference | null {
  const normalised = value.trim().toUpperCase();

  // Longest prefix first, so 'PAY' is not mistaken for a shorter prefix.
  const formats = Object.values(REFERENCE_FORMAT_DEFAULTS).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );

  for (const format of formats) {
    if (!normalised.startsWith(format.prefix)) continue;

    const remainder = normalised.slice(format.prefix.length);

    // Two year digits followed by at least one sequence digit.
    if (!/^\d{3,}$/.test(remainder)) continue;

    const twoDigitYear = Number(remainder.slice(0, 2));
    const sequence = Number(remainder.slice(2));

    if (sequence < 1) continue;

    return { scope: format.scope, prefix: format.prefix, twoDigitYear, sequence };
  }

  return null;
}

/** Is this a well-formed reference of any known scope? */
export function isValidReference(value: string): boolean {
  return parseReference(value) !== null;
}

/** Is this a well-formed reference of a specific scope? */
export function isValidReferenceForScope(value: string, scope: ReferenceScope): boolean {
  return parseReference(value)?.scope === scope;
}

/**
 * The reference a given scope's *next* number would have, were the sequence at
 * `sequence`.
 *
 * Preview and test helper only. Never write the result anywhere — the
 * authoritative value comes from `public.next_reference`, which also advances
 * the sequence.
 */
export function previewReference(
  scope: ReferenceScope,
  sequence: number,
  now: Date = new Date(),
): string {
  return formatReference(scope, businessReferenceYear(now), sequence);
}
