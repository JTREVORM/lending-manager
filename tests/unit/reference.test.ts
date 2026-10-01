import { describe, expect, it } from 'vitest';

import {
  REFERENCE_FORMAT_DEFAULTS,
  REFERENCE_SCOPES,
  ReferenceError as ReferenceFormatError,
  formatReference,
  isValidReference,
  isValidReferenceForScope,
  parseReference,
  previewReference,
} from '@/lib/domain/reference';

describe('formatReference', () => {
  it('produces exactly the formats the business specified', () => {
    expect(formatReference('client', 26, 1)).toBe('CL26001');
    expect(formatReference('loan', 26, 1)).toBe('LN260001');
    expect(formatReference('payment', 26, 1)).toBe('PAY260001');
  });

  it('pads the sequence to the configured width', () => {
    expect(formatReference('client', 26, 42)).toBe('CL26042');
    expect(formatReference('client', 26, 999)).toBe('CL26999');
    expect(formatReference('loan', 26, 9_999)).toBe('LN269999');
  });

  it('grows past the padding rather than truncating', () => {
    // Truncating would reintroduce duplicates, which is the one outcome the
    // whole reference design exists to prevent.
    expect(formatReference('client', 26, 1_000)).toBe('CL261000');
    expect(formatReference('client', 26, 123_456)).toBe('CL26123456');
  });

  it('pads a single-digit year', () => {
    expect(formatReference('client', 7, 1)).toBe('CL07001');
    expect(formatReference('client', 0, 1)).toBe('CL00001');
  });

  it('rejects an out-of-range year', () => {
    expect(() => formatReference('client', 2026, 1)).toThrow(/two-digit/);
    expect(() => formatReference('client', -1, 1)).toThrow(/two-digit/);
  });

  it('rejects a sequence below one or fractional', () => {
    expect(() => formatReference('client', 26, 0)).toThrow(/positive whole number/);
    expect(() => formatReference('client', 26, 1.5)).toThrow(ReferenceFormatError);
  });

  it('honours a custom format, so the prefix stays configurable', () => {
    expect(
      formatReference('client', 26, 1, { scope: 'client', prefix: 'CUST', padding: 5 }),
    ).toBe('CUST2600001');
  });
});

describe('parseReference', () => {
  it('round-trips every scope', () => {
    for (const scope of REFERENCE_SCOPES) {
      const reference = formatReference(scope, 26, 7);
      expect(parseReference(reference)).toEqual({
        scope,
        prefix: REFERENCE_FORMAT_DEFAULTS[scope].prefix,
        twoDigitYear: 26,
        sequence: 7,
      });
    }
  });

  it('tolerates lowercase and whitespace, as pasted from a receipt', () => {
    expect(parseReference('  cl26001  ')?.scope).toBe('client');
    expect(parseReference('pay260001')?.scope).toBe('payment');
  });

  it('does not confuse PAY with a shorter prefix', () => {
    // Prefixes are matched longest-first; otherwise 'PAY260001' could be read
    // as some other scope plus a stray character.
    expect(parseReference('PAY260001')?.scope).toBe('payment');
    expect(parseReference('PAY260001')?.sequence).toBe(1);
  });

  it('returns null for a non-match instead of throwing', () => {
    // Used on search input, where a miss is an ordinary outcome.
    expect(parseReference('')).toBeNull();
    expect(parseReference('XX26001')).toBeNull();
    expect(parseReference('CL26')).toBeNull();
    expect(parseReference('CL26000')).toBeNull(); // sequence zero
    expect(parseReference('CLABC001')).toBeNull();
  });
});

describe('validity helpers', () => {
  it('reports validity overall and per scope', () => {
    expect(isValidReference('CL26001')).toBe(true);
    expect(isValidReference('nonsense')).toBe(false);

    expect(isValidReferenceForScope('CL26001', 'client')).toBe(true);
    expect(isValidReferenceForScope('CL26001', 'loan')).toBe(false);
  });
});

describe('previewReference', () => {
  it('uses the business year for the given instant', () => {
    expect(previewReference('client', 1, new Date('2026-06-15T09:00:00Z'))).toBe(
      'CL26001',
    );
    // 22:00 UTC on 31 December is already the new year in Kampala.
    expect(previewReference('client', 1, new Date('2025-12-31T22:00:00Z'))).toBe(
      'CL26001',
    );
  });
});

describe('the defaults mirror the seeded database rows', () => {
  it('covers every scope with a sane prefix and padding', () => {
    // A database test asserts these equal the rows in reference_formats; this
    // one guards the shape.
    for (const scope of REFERENCE_SCOPES) {
      const format = REFERENCE_FORMAT_DEFAULTS[scope];
      expect(format.scope).toBe(scope);
      expect(format.prefix).toMatch(/^[A-Z]{1,6}$/);
      expect(format.padding).toBeGreaterThanOrEqual(1);
      expect(format.padding).toBeLessThanOrEqual(12);
    }
  });
});
