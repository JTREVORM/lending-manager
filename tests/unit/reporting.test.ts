import { describe, expect, it } from 'vitest';

import { toBusinessDate } from '@/lib/domain/datetime';
import {
  DEFAULT_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  MAX_PAGE_SIZE,
  MAX_RANGE_DAYS,
  METRIC_DEFINITIONS,
  OVERDUE_SORTS,
  REPORT_PERIODS,
  REPORT_PERIOD_LABELS,
  ReportingError,
  assertRangeWithinLimit,
  businessWeekday,
  csvNumber,
  csvText,
  describeRange,
  eachBusinessDate,
  endOfBusinessMonth,
  endOfBusinessWeek,
  endOfBusinessYear,
  exportFilename,
  isMetricKey,
  isOverdueSort,
  isReportPeriod,
  metricDefinition,
  monthKey,
  pageWindow,
  rangeLength,
  resolveDateRange,
  resolvePageRequest,
  safeSearchTerm,
  sanitizeCsvText,
  startOfBusinessMonth,
  startOfBusinessWeek,
  startOfBusinessYear,
  takePage,
  toCsv,
  weekKey,
  type DateRange,
} from '@/lib/domain/reporting';

const d = (value: string) => toBusinessDate(value);

/**
 * The reporting primitives.
 *
 * Every expected value here is a literal worked out by hand from a calendar,
 * not a figure produced by calling another function in the module. A test that
 * computes its own expectation with the code under test proves only that the
 * code is consistent with itself.
 */

// ===========================================================================
describe('date ranges', () => {
  const today = d('2026-10-04'); // a Sunday

  it('covers exactly one day for today', () => {
    const range = resolveDateRange('today', today);
    expect(range).toEqual({ from: '2026-10-04', to: '2026-10-04' });
    expect(rangeLength(range)).toBe(1);
  });

  it('counts a week from Monday to Sunday', () => {
    // 4 October 2026 is a Sunday, so its week began on Monday 28 September.
    // A Sunday-first week would make this range start on the 4th itself and
    // report a single day, which is the bug this asserts against.
    expect(businessWeekday(d('2026-09-28'))).toBe(0);
    expect(businessWeekday(today)).toBe(6);
    expect(startOfBusinessWeek(today)).toBe('2026-09-28');
    expect(endOfBusinessWeek(today)).toBe('2026-10-04');
    expect(rangeLength(resolveDateRange('week', today))).toBe(7);
  });

  it('counts a month to its real last day', () => {
    expect(startOfBusinessMonth(today)).toBe('2026-10-01');
    expect(endOfBusinessMonth(today)).toBe('2026-10-31');
    expect(endOfBusinessMonth(d('2026-11-15'))).toBe('2026-11-30');
    expect(endOfBusinessMonth(d('2026-02-03'))).toBe('2026-02-28');
    // 2028 is a leap year.
    expect(endOfBusinessMonth(d('2028-02-03'))).toBe('2028-02-29');
    expect(rangeLength(resolveDateRange('month', today))).toBe(31);
  });

  it('counts a year from 1 January to 31 December', () => {
    expect(startOfBusinessYear(today)).toBe('2026-01-01');
    expect(endOfBusinessYear(today)).toBe('2026-12-31');
    expect(rangeLength(resolveDateRange('year', today))).toBe(365);
    expect(rangeLength(resolveDateRange('year', d('2028-06-01')))).toBe(366);
  });

  it('accepts a custom range and includes both ends', () => {
    const range = resolveDateRange('custom', today, {
      from: '2026-10-01',
      to: '2026-10-03',
    });
    expect(range).toEqual({ from: '2026-10-01', to: '2026-10-03' });
    expect(rangeLength(range)).toBe(3);
  });

  it('accepts a single-day custom range', () => {
    const range = resolveDateRange('custom', today, {
      from: '2026-10-02',
      to: '2026-10-02',
    });
    expect(rangeLength(range)).toBe(1);
  });

  it('refuses a reversed custom range rather than swapping it', () => {
    // Swapping would answer a different question from the one asked, and hide
    // a typo the person needs to see.
    expect(() =>
      resolveDateRange('custom', today, { from: '2026-10-05', to: '2026-10-01' }),
    ).toThrow(ReportingError);
  });

  it('refuses a custom range whose dates are not dates', () => {
    expect(() => resolveDateRange('custom', today, { from: '2026-13-01' })).toThrow();
    expect(() => resolveDateRange('custom', today, { to: 'last Tuesday' })).toThrow();
  });

  it('spans a month end and a year end correctly', () => {
    expect(
      rangeLength(
        resolveDateRange('custom', today, { from: '2026-10-30', to: '2026-11-02' }),
      ),
    ).toBe(4);
    expect(
      rangeLength(
        resolveDateRange('custom', today, { from: '2026-12-30', to: '2027-01-02' }),
      ),
    ).toBe(4);
  });

  it('spans a leap day', () => {
    const range = resolveDateRange('custom', today, {
      from: '2028-02-27',
      to: '2028-03-01',
    });
    expect(eachBusinessDate(range)).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('enumerates every day in a range, ascending', () => {
    expect(eachBusinessDate({ from: d('2026-10-04'), to: d('2026-10-07') })).toEqual([
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
  });

  it('caps a range at five years', () => {
    const tooLong: DateRange = { from: d('2020-01-01'), to: d('2026-01-01') };
    expect(rangeLength(tooLong)).toBeGreaterThan(MAX_RANGE_DAYS);
    expect(() => {
      assertRangeWithinLimit(tooLong);
    }).toThrow(ReportingError);

    expect(() => {
      assertRangeWithinLimit({ from: d('2026-01-01'), to: d('2026-12-31') });
    }).not.toThrow();
  });

  it('describes one day differently from a span', () => {
    const show = (value: string) => value;
    expect(describeRange({ from: d('2026-10-04'), to: d('2026-10-04') }, show)).toBe(
      '2026-10-04',
    );
    expect(describeRange({ from: d('2026-10-01'), to: d('2026-10-31') }, show)).toBe(
      '2026-10-01 – 2026-10-31',
    );
  });

  it('buckets by month and by the week containing a date', () => {
    expect(monthKey(d('2026-10-04'))).toBe('2026-10');
    expect(monthKey(d('2026-01-31'))).toBe('2026-01');
    // Both days fall in the week beginning Monday 28 September.
    expect(weekKey(d('2026-09-30'))).toBe('2026-09-28');
    expect(weekKey(d('2026-10-04'))).toBe('2026-09-28');
    expect(weekKey(d('2026-10-05'))).toBe('2026-10-05');
  });

  it('names every period it offers', () => {
    for (const period of REPORT_PERIODS) {
      expect(REPORT_PERIOD_LABELS[period].length).toBeGreaterThan(0);
    }
    expect(isReportPeriod('month')).toBe(true);
    expect(isReportPeriod('fortnight')).toBe(false);
    expect(isReportPeriod(null)).toBe(false);
  });
});

// ===========================================================================
describe('pagination', () => {
  it('defaults to the first page at the default size', () => {
    expect(resolvePageRequest()).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('ignores anything unusable from a query string', () => {
    // A stray link must not become an error screen.
    for (const page of ['abc', '', '0', '-3', '1.5', null, undefined, {}]) {
      expect(resolvePageRequest({ page }).page).toBe(1);
    }
  });

  it('clamps the page size so a URL cannot ask for the whole table', () => {
    expect(resolvePageRequest({ pageSize: '1000000' }).pageSize).toBe(MAX_PAGE_SIZE);
    expect(resolvePageRequest({ pageSize: '10' }).pageSize).toBe(10);
    expect(resolvePageRequest({ pageSize: '-1' }).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('asks for one row more than the page needs', () => {
    // That extra row is how "is there a next page" is answered without a
    // second count over the whole filtered set.
    expect(pageWindow({ page: 1, pageSize: 25 })).toEqual({ from: 0, to: 25 });
    expect(pageWindow({ page: 3, pageSize: 10 })).toEqual({ from: 20, to: 30 });
  });

  it('splits an over-fetched result into the page and the knowledge of more', () => {
    const rows = [1, 2, 3, 4];
    expect(takePage(rows, { page: 1, pageSize: 3 })).toEqual({
      rows: [1, 2, 3],
      page: 1,
      pageSize: 3,
      hasMore: true,
    });
    expect(takePage([1, 2], { page: 1, pageSize: 3 }).hasMore).toBe(false);
    expect(takePage([], { page: 1, pageSize: 3 }).rows).toEqual([]);
  });
});

// ===========================================================================
describe('CSV export', () => {
  it('neutralises every character that makes a cell a formula', () => {
    // A formula cell in a downloaded report is remote code execution in a
    // spreadsheet. Each of these is disarmed with a leading quote.
    expect(sanitizeCsvText('=1+1')).toBe("'=1+1");
    expect(sanitizeCsvText('+1')).toBe("'+1");
    expect(sanitizeCsvText('-1+1')).toBe("'-1+1");
    expect(sanitizeCsvText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(sanitizeCsvText('\t=cmd')).toBe("'\t=cmd");
    // A carriage return is flattened to a space first, so what reaches the
    // check is " =cmd" — which some spreadsheets strip and then evaluate. The
    // first *non-space* character is what decides.
    expect(sanitizeCsvText('\r=cmd')).toBe("' =cmd");
    expect(sanitizeCsvText('   =cmd')).toBe("'   =cmd");
  });

  it('disarms the classic command-injection payload', () => {
    const payload = "=cmd|' /C calc'!A0";
    const cell = csvText(payload);
    expect(cell.startsWith("'=cmd")).toBe(true);
    // The content survives: nothing is stripped, only prevented from running.
    expect(cell).toContain('calc');
  });

  it('does not strip or alter a name that merely starts with a symbol', () => {
    // A client genuinely called "=Mukasa" must still appear in the report.
    expect(sanitizeCsvText('=Mukasa')).toBe("'=Mukasa");
    expect(sanitizeCsvText('Mukasa')).toBe('Mukasa');
    expect(sanitizeCsvText("O'Brien")).toBe("O'Brien");
  });

  it('quotes a cell containing a comma, a quote or a newline', () => {
    expect(csvText('Kampala, Central')).toBe('"Kampala, Central"');
    expect(csvText('He said "hello"')).toBe('"He said ""hello"""');
    // Newlines are flattened to spaces so one record stays one row.
    expect(csvText('line one\nline two')).toBe('line one line two');
    expect(csvText('line one\r\nline two')).toBe('line one line two');
  });

  it('renders an empty cell for nothing at all', () => {
    expect(csvText(null)).toBe('');
    expect(csvText(undefined)).toBe('');
    expect(csvText('')).toBe('');
  });

  it('never prefixes a number, because a number carries no formula', () => {
    // Prefixing would corrupt a figure to defend against an attack numbers
    // cannot carry, and a column of "'50000" cannot be totalled.
    expect(csvNumber(50_000)).toBe('50000');
    expect(csvNumber(0)).toBe('0');
    expect(csvNumber(-250)).toBe('-250');
    expect(csvNumber(null)).toBe('');
    expect(csvNumber(Number.NaN)).toBe('');
  });

  it('emits money without separators or a currency symbol', () => {
    // The screen is for reading; the file is for totalling.
    expect(csvNumber(1_250_000)).toBe('1250000');
    expect(csvNumber(1_250_000)).not.toContain(',');
    expect(csvNumber(1_250_000)).not.toContain('UGX');
  });

  it('writes a byte-order mark and CRLF line endings', () => {
    const csv = toCsv(
      [
        { header: 'Name', cell: (row: { name: string }) => csvText(row.name) },
        { header: 'Amount (UGX)', cell: () => csvNumber(4000) },
      ],
      [{ name: 'Nakimuli' }],
    );

    // Without the BOM a spreadsheet opens the file in the machine's local code
    // page, and a name with an accent arrives as mojibake.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv).toContain('Name,Amount (UGX)');
    expect(csv).toContain('Nakimuli,4000');
  });

  it('carries non-ASCII names through unchanged', () => {
    const csv = toCsv(
      [{ header: 'Name', cell: (row: { name: string }) => csvText(row.name) }],
      [{ name: 'Nakimuli Zaïnabu' }, { name: 'Ssemakula Kyagaba' }],
    );
    expect(csv).toContain('Nakimuli Zaïnabu');
    expect(csv).toContain('Ssemakula Kyagaba');
  });

  it('builds a filename that names the range', () => {
    expect(
      exportFilename('collections', { from: d('2026-10-04'), to: d('2026-10-04') }),
    ).toBe('collections-2026-10-04.csv');
    expect(
      exportFilename('Loan Portfolio', { from: d('2026-10-01'), to: d('2026-10-31') }),
    ).toBe('loan-portfolio-2026-10-01-to-2026-10-31.csv');
  });

  it('caps an export at a size that will actually download', () => {
    expect(MAX_EXPORT_ROWS).toBeGreaterThan(1000);
    expect(MAX_EXPORT_ROWS).toBeLessThanOrEqual(10_000);
  });
});

// ===========================================================================
describe('search terms', () => {
  it('removes every character that is PostgREST filter syntax', () => {
    // These do not get *escaped* into an `or(...)` expression — they get
    // parsed as part of it. A whitelist is the only safe answer.
    expect(safeSearchTerm('a,b')).toBe('a b');
    expect(safeSearchTerm('x.ilike.y')).toBe('x ilike y');
    expect(safeSearchTerm('(or(id.eq.1))')).toBe('or id eq 1');
    expect(safeSearchTerm('name.eq.x,or(role.eq.owner)')).toBe(
      'name eq x or role eq owner',
    );
  });

  it('removes the like wildcards so a search cannot become a full scan', () => {
    expect(safeSearchTerm('%')).toBe(null);
    expect(safeSearchTerm('%_%')).toBe(null);
    expect(safeSearchTerm('a%b')).toBe('a b');
  });

  it('keeps what a name, number or reference actually contains', () => {
    expect(safeSearchTerm('Nakimuli Zaïnabu')).toBe('Nakimuli Zaïnabu');
    expect(safeSearchTerm("O'Brien")).toBe("O'Brien");
    expect(safeSearchTerm('CL-2026-00042')).toBe('CL-2026-00042');
    expect(safeSearchTerm('RC/2026/1')).toBe('RC/2026/1');
  });

  it('reads nothing usable as no search at all', () => {
    expect(safeSearchTerm('')).toBe(null);
    expect(safeSearchTerm('   ')).toBe(null);
    expect(safeSearchTerm(';;;')).toBe(null);
    expect(safeSearchTerm(null)).toBe(null);
    expect(safeSearchTerm(42)).toBe(null);
  });

  it('bounds the length', () => {
    expect(safeSearchTerm('a'.repeat(500))?.length).toBe(60);
  });
});

// ===========================================================================
describe('sort whitelist', () => {
  it('maps each offered sort to a real column', () => {
    expect(Object.keys(OVERDUE_SORTS).sort()).toEqual([
      'arrears',
      'days',
      'oldest',
      'outstanding',
    ]);

    for (const sort of Object.values(OVERDUE_SORTS)) {
      expect(sort.column).toMatch(/^[a-z_]+$/);
      expect(sort.label.length).toBeGreaterThan(0);
    }
  });

  it('refuses anything that is not one of them', () => {
    // The sort reaches a query builder's `order()`, so a value from a URL
    // must never be able to name an arbitrary column.
    expect(isOverdueSort('days')).toBe(true);
    expect(isOverdueSort('password')).toBe(false);
    expect(isOverdueSort('arrears_amount')).toBe(false);
    expect(isOverdueSort('__proto__')).toBe(false);
    expect(isOverdueSort(null)).toBe(false);
  });
});

// ===========================================================================
describe('metric definitions', () => {
  const keys = Object.keys(METRIC_DEFINITIONS);

  it('gives every metric a label, a definition and a source', () => {
    for (const key of keys) {
      const definition = metricDefinition(key as keyof typeof METRIC_DEFINITIONS);
      expect(definition.label.length, key).toBeGreaterThan(0);
      // A sentence, not a restatement of the label.
      expect(definition.definition.length, key).toBeGreaterThan(20);
      expect(definition.source.length, key).toBeGreaterThan(0);
    }
  });

  /**
   * The unsupported accounting claims.
   *
   * A definition may *mention* one of these, because several of them exist
   * precisely to say "this is not that" — "not cash at hand", "never called
   * profit". What no definition may do is make the claim. So a mention is
   * allowed only when it is negated in the same breath, and a *label* may
   * never contain one at all: a card title has no room for a disclaimer.
   */
  const UNSUPPORTED = [
    'profit',
    'cash at hand',
    'cash balance',
    'wallet',
    'cash in hand',
  ];

  it('never puts an unsupported accounting claim in a label', () => {
    for (const key of keys) {
      const label =
        METRIC_DEFINITIONS[key as keyof typeof METRIC_DEFINITIONS].label.toLowerCase();
      for (const claim of UNSUPPORTED) {
        expect(label, `${key} label`).not.toContain(claim);
      }
    }
  });

  it('only mentions an unsupported claim in order to deny it', () => {
    // The system models no costs and no cash accounting, so profit and a cash
    // position are both inventions. Several definitions say so out loud; none
    // asserts one.
    for (const key of keys) {
      const definition =
        METRIC_DEFINITIONS[
          key as keyof typeof METRIC_DEFINITIONS
        ].definition.toLowerCase();

      for (const claim of UNSUPPORTED) {
        if (!definition.includes(claim)) continue;

        const clause =
          definition.split(/[.;]/).find((part) => part.includes(claim)) ?? definition;

        expect(clause, `${key}: "${claim}"`).toMatch(/\bnot\b|\bnever\b|\bno\b/);
      }
    }
  });

  it('says plainly that the method figures are not a balance', () => {
    // Each of the four says what it is not, and now says where the balance
    // *is*: before Phase 10 the answer was "this system does not track it",
    // and `branch_cash_position` has made that false.
    expect(METRIC_DEFINITIONS.cash_received.definition).toMatch(
      /not the Cash at Hand balance/i,
    );
    expect(METRIC_DEFINITIONS.mtn_received.definition).toMatch(/not a wallet balance/i);
    expect(METRIC_DEFINITIONS.airtel_received.definition).toMatch(
      /not a wallet balance/i,
    );
    expect(METRIC_DEFINITIONS.bank_received.definition).toMatch(
      /not the Cash at Bank balance/i,
    );
    for (const key of ['cash_received', 'bank_received'] as const) {
      expect(METRIC_DEFINITIONS[key].definition, key).toMatch(
        /branch_cash_position answers/i,
      );
    }
  });

  it('says plainly that interest collected is not profit', () => {
    expect(METRIC_DEFINITIONS.interest_collected.definition).toMatch(
      /never called profit/i,
    );
  });

  it('keeps assessed and collected as separate metrics', () => {
    // Booking an assessed penalty as income would recognise money that may
    // never arrive.
    expect(METRIC_DEFINITIONS.penalty_assessed.definition).toMatch(/not cash received/i);
    expect(METRIC_DEFINITIONS.penalty_collected.definition).toMatch(/received/i);
    expect(METRIC_DEFINITIONS.contractual_interest.definition).toMatch(
      /not what has been received/i,
    );
  });

  it('says that total collected is not a sum of scheduled amounts', () => {
    expect(METRIC_DEFINITIONS.total_collected.definition).toMatch(
      /never a sum of scheduled/i,
    );
    expect(METRIC_DEFINITIONS.total_collected.definition).toMatch(/excluding reversals/i);
  });

  it('warns that expected minus collected is not what remains', () => {
    expect(METRIC_DEFINITIONS.remaining_today.definition).toMatch(
      /not expected minus collected/i,
    );
  });

  it('says a prepaid collection is not expected again', () => {
    expect(METRIC_DEFINITIONS.expected_today.definition).toMatch(/paid ahead/i);
  });

  it('says a penalised loan is still an active loan', () => {
    // Lifecycle and delinquency are separate axes; mixing the counts
    // double-counts the same loan.
    expect(METRIC_DEFINITIONS.loans_active.definition).toMatch(
      /penalised loan is still an active loan/i,
    );
  });

  it('says which counts overlap', () => {
    expect(METRIC_DEFINITIONS.loans_with_arrears.definition).toMatch(/overlaps/i);
  });

  it('says a report never raises a pending penalty', () => {
    expect(METRIC_DEFINITIONS.loans_penalty_pending.definition).toMatch(
      /reading a report never raises it/i,
    );
  });

  it('recognises its own keys and nothing else', () => {
    expect(isMetricKey('total_collected')).toBe(true);
    expect(isMetricKey('profit')).toBe(false);
    expect(isMetricKey('__proto__')).toBe(false);
  });
});
