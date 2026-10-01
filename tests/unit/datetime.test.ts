import { describe, expect, it } from 'vitest';

import { BUSINESS_TIMEZONE } from '@/config/app';
import {
  DateTimeError,
  addBusinessDays,
  businessDateToUtcMidnight,
  businessReferenceYear,
  businessToday,
  compareBusinessDates,
  daysBetween,
  endOfBusinessDayExclusive,
  formatBusinessDate,
  formatInstant,
  instantToBusinessDate,
  isBusinessDate,
  startOfBusinessDay,
  timezoneOffsetMinutes,
  toBusinessDate,
  toDatabaseTimestamp,
} from '@/lib/domain/datetime';

describe('the business timezone', () => {
  it('is Kampala and is resolved from the IANA database, not hard-coded', () => {
    expect(BUSINESS_TIMEZONE).toBe('Africa/Kampala');
    // Uganda is UTC+03:00 with no daylight saving. Asserting the value the
    // platform resolves — rather than a constant in our own code — means a
    // future rule change is picked up instead of silently ignored.
    expect(timezoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'))).toBe(180);
    expect(timezoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'))).toBe(180);
  });

  it('reports a zero offset for UTC itself', () => {
    expect(timezoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('instantToBusinessDate', () => {
  it('does not drift backwards during the first three Kampala hours', () => {
    // This is the bug the whole module exists to prevent. At 01:00 UTC it is
    // already 04:00 in Kampala, so a payment recorded then belongs to the new
    // day — `toISOString().slice(0, 10)` would have filed it under yesterday.
    expect(instantToBusinessDate(new Date('2026-01-01T01:00:00Z'))).toBe('2026-01-01');
    expect(instantToBusinessDate(new Date('2026-06-15T00:30:00Z'))).toBe('2026-06-15');
  });

  it('rolls over to the next day at 21:00 UTC', () => {
    expect(instantToBusinessDate(new Date('2025-12-31T20:59:59Z'))).toBe('2025-12-31');
    // 21:00 UTC is midnight in Kampala — a new business day, and a new year.
    expect(instantToBusinessDate(new Date('2025-12-31T21:00:00Z'))).toBe('2026-01-01');
  });

  it('is unaffected by the host timezone, because the zone is explicit', () => {
    const instant = new Date('2026-03-10T22:30:00Z');
    expect(instantToBusinessDate(instant)).toBe('2026-03-11');
    expect(instantToBusinessDate(instant, 'UTC')).toBe('2026-03-10');
  });

  it('rejects an invalid Date', () => {
    expect(() => instantToBusinessDate(new Date('nonsense'))).toThrow(DateTimeError);
  });
});

describe('businessReferenceYear', () => {
  it('supplies the two digits used in a reference number', () => {
    // CL26001 — the 26 comes from here.
    expect(businessReferenceYear(new Date('2026-06-15T09:00:00Z'))).toBe(26);
  });

  it('turns over with the Kampala year, not the UTC year', () => {
    // 22:00 UTC on 31 December 2025 is already 01:00 on 1 January 2026 in
    // Kampala, so a client registered then must be CL26..., not CL25....
    expect(businessReferenceYear(new Date('2025-12-31T22:00:00Z'))).toBe(26);
    expect(businessReferenceYear(new Date('2025-12-31T18:00:00Z'))).toBe(25);
  });
});

describe('businessToday', () => {
  it('agrees with instantToBusinessDate for the same instant', () => {
    const now = new Date('2026-02-14T19:45:00Z');
    expect(businessToday(now)).toBe(instantToBusinessDate(now));
  });
});

describe('isBusinessDate and toBusinessDate', () => {
  it('accepts real dates in YYYY-MM-DD form', () => {
    expect(isBusinessDate('2026-01-14')).toBe(true);
    expect(isBusinessDate('2024-02-29')).toBe(true); // a leap year
  });

  it('rejects dates that match the pattern but do not exist', () => {
    expect(isBusinessDate('2026-02-30')).toBe(false);
    expect(isBusinessDate('2026-13-01')).toBe(false);
    expect(isBusinessDate('2025-02-29')).toBe(false); // not a leap year
  });

  it('rejects wrong formats', () => {
    expect(isBusinessDate('14/01/2026')).toBe(false);
    expect(isBusinessDate('2026-1-4')).toBe(false);
    expect(isBusinessDate('2026-01-14T00:00:00Z')).toBe(false);
    expect(isBusinessDate(null)).toBe(false);
  });

  it('throws with a useful message on bad input', () => {
    expect(() => toBusinessDate('2026-02-30')).toThrow(/not a valid calendar date/);
  });
});

describe('addBusinessDays', () => {
  it('adds and subtracts whole days', () => {
    expect(addBusinessDays(toBusinessDate('2026-01-14'), 1)).toBe('2026-01-15');
    expect(addBusinessDays(toBusinessDate('2026-01-14'), -1)).toBe('2026-01-13');
    expect(addBusinessDays(toBusinessDate('2026-01-14'), 0)).toBe('2026-01-14');
  });

  it('crosses month, year and leap-day boundaries', () => {
    expect(addBusinessDays(toBusinessDate('2026-01-31'), 1)).toBe('2026-02-01');
    expect(addBusinessDays(toBusinessDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addBusinessDays(toBusinessDate('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addBusinessDays(toBusinessDate('2025-02-28'), 1)).toBe('2025-03-01');
  });

  it('spans the three-day grace period the business uses', () => {
    expect(addBusinessDays(toBusinessDate('2026-04-28'), 3)).toBe('2026-05-01');
  });

  it('rejects a fractional offset', () => {
    expect(() => addBusinessDays(toBusinessDate('2026-01-14'), 1.5)).toThrow(
      /whole number/,
    );
  });
});

describe('daysBetween', () => {
  it('counts days in both directions', () => {
    expect(daysBetween(toBusinessDate('2026-01-14'), toBusinessDate('2026-01-17'))).toBe(
      3,
    );
    expect(daysBetween(toBusinessDate('2026-01-17'), toBusinessDate('2026-01-14'))).toBe(
      -3,
    );
    expect(daysBetween(toBusinessDate('2026-01-14'), toBusinessDate('2026-01-14'))).toBe(
      0,
    );
  });

  it('counts across a year boundary and a leap year', () => {
    expect(daysBetween(toBusinessDate('2025-12-30'), toBusinessDate('2026-01-02'))).toBe(
      3,
    );
    expect(daysBetween(toBusinessDate('2024-01-01'), toBusinessDate('2025-01-01'))).toBe(
      366,
    );
  });

  it('is consistent with addBusinessDays over a long span', () => {
    const start = toBusinessDate('2026-01-01');
    for (const offset of [1, 7, 30, 90, 365]) {
      expect(daysBetween(start, addBusinessDays(start, offset))).toBe(offset);
    }
  });
});

describe('compareBusinessDates', () => {
  it('orders dates', () => {
    expect(
      compareBusinessDates(toBusinessDate('2026-01-01'), toBusinessDate('2026-01-02')),
    ).toBe(-1);
    expect(
      compareBusinessDates(toBusinessDate('2026-01-02'), toBusinessDate('2026-01-01')),
    ).toBe(1);
    expect(
      compareBusinessDates(toBusinessDate('2026-01-01'), toBusinessDate('2026-01-01')),
    ).toBe(0);
  });
});

describe('day boundaries', () => {
  it('starts a Kampala day at 21:00 UTC the previous day', () => {
    expect(startOfBusinessDay(toBusinessDate('2026-01-15')).toISOString()).toBe(
      '2026-01-14T21:00:00.000Z',
    );
  });

  it('ends exclusively at the start of the following day', () => {
    expect(endOfBusinessDayExclusive(toBusinessDate('2026-01-15')).toISOString()).toBe(
      '2026-01-15T21:00:00.000Z',
    );
  });

  it('produces a window exactly 24 hours wide', () => {
    const start = startOfBusinessDay(toBusinessDate('2026-01-15'));
    const end = endOfBusinessDayExclusive(toBusinessDate('2026-01-15'));
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it('contains every instant that maps to that business date', () => {
    const date = toBusinessDate('2026-01-15');
    const start = startOfBusinessDay(date).getTime();
    const end = endOfBusinessDayExclusive(date).getTime();

    expect(instantToBusinessDate(new Date(start))).toBe(date);
    expect(instantToBusinessDate(new Date(end - 1))).toBe(date);
    expect(instantToBusinessDate(new Date(start - 1))).not.toBe(date);
    expect(instantToBusinessDate(new Date(end))).not.toBe(date);
  });

  it('anchors UTC midnight for counting, which is not the Kampala day start', () => {
    expect(businessDateToUtcMidnight(toBusinessDate('2026-01-15')).toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
  });
});

describe('display formatting', () => {
  it('formats a calendar date without shifting it', () => {
    expect(formatBusinessDate(toBusinessDate('2026-01-14'))).toMatch(/14/);
    expect(formatBusinessDate(toBusinessDate('2026-01-14'))).toMatch(/2026/);
  });

  it('renders an instant in Kampala time, not the host zone', () => {
    // 06:30 UTC is 09:30 in Kampala.
    const formatted = formatInstant(new Date('2026-01-14T06:30:00Z'));
    expect(formatted).toMatch(/09:30/);
    expect(formatted).toMatch(/14/);
  });

  it('can omit the time', () => {
    const formatted = formatInstant(new Date('2026-01-14T06:30:00Z'), {
      withTime: false,
    });
    expect(formatted).not.toMatch(/09:30/);
  });

  it('honours an explicit timezone override', () => {
    expect(formatInstant(new Date('2026-01-14T06:30:00Z'), { timeZone: 'UTC' })).toMatch(
      /06:30/,
    );
  });

  it('accepts an ISO string, as read from a timestamptz column', () => {
    expect(formatInstant('2026-01-14T06:30:00Z')).toMatch(/09:30/);
  });

  it('rejects an invalid instant instead of printing "Invalid Date"', () => {
    expect(() => formatInstant('not a date')).toThrow(DateTimeError);
  });
});

describe('toDatabaseTimestamp', () => {
  it('always serialises as UTC ISO 8601', () => {
    expect(toDatabaseTimestamp(new Date('2026-01-14T06:30:00Z'))).toBe(
      '2026-01-14T06:30:00.000Z',
    );
  });

  it('rejects an invalid Date', () => {
    expect(() => toDatabaseTimestamp(new Date('nonsense'))).toThrow(DateTimeError);
  });
});
