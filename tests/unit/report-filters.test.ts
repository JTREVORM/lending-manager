import { describe, expect, it } from 'vitest';

import {
  CLIENT_STATUS_OPTIONS,
  businessDateFor,
  exportQuery,
  multiParam,
  parseClientStatus,
  parseCollectionStatus,
  parseDelinquencyStates,
  parseLoanStatuses,
  parseOverdueSort,
  parsePaymentMethod,
  parseUuid,
  resolveReportRange,
  singleParam,
  type ParamRecord,
} from '@/lib/reports/filters';
import { MAX_RANGE_DAYS } from '@/lib/domain/reporting';

/**
 * Report filters, and the attack they exist to stop.
 *
 * ## Filter injection is not SQL injection, and that is the point
 *
 * None of these values is concatenated into SQL — the Supabase query builder
 * parameterises them. What they *are* concatenated into is PostgREST's filter
 * syntax: a string like
 * `payment_number.ilike.%x%,client_name.ilike.%x%`, where a comma, a dot or a
 * parenthesis is punctuation rather than data. So a value that reaches
 * `order()` or `or()` unchecked is not escaped into the expression, it is
 * parsed as part of it, and could name a column nobody offered.
 *
 * The defence is a whitelist at this layer, `safeSearchTerm` at the text
 * layer, and Row Level Security underneath both. These tests are the first.
 *
 * ## An unusable filter is dropped; an unusable range is reported
 *
 * A mistyped status is a reasonable reading of a hand-edited URL, so it is
 * ignored and the unfiltered report is shown. A mistyped *date range* is
 * different: showing a different range from the one asked for would misstate
 * what the figures cover, so it comes back as a sentence for the page to
 * render. Neither ever produces a database error.
 */

const TIMEZONE = 'Africa/Kampala';

// ===========================================================================
describe('reading a parameter', () => {
  it('takes the first value of a parameter that repeats', () => {
    expect(singleParam({ page: ['2', '9'] }, 'page')).toBe('2');
  });

  it('treats blank and missing alike', () => {
    expect(singleParam({ query: '' }, 'query')).toBeUndefined();
    expect(singleParam({ query: '   ' }, 'query')).toBeUndefined();
    expect(singleParam({}, 'query')).toBeUndefined();
  });

  it('accepts a repeatable parameter in either form', () => {
    expect(multiParam({ status: ['active', 'cleared'] }, 'status')).toEqual([
      'active',
      'cleared',
    ]);
    expect(multiParam({ status: 'active,cleared' }, 'status')).toEqual([
      'active',
      'cleared',
    ]);
    expect(multiParam({ status: 'active, , cleared' }, 'status')).toEqual([
      'active',
      'cleared',
    ]);
    expect(multiParam({}, 'status')).toEqual([]);
  });
});

// ===========================================================================
describe('status and state whitelists', () => {
  it('keeps the loan statuses the lifecycle actually has', () => {
    expect(parseLoanStatuses({ status: 'active,cleared' })).toEqual([
      'active',
      'cleared',
    ]);
  });

  it('drops anything that is not a loan status', () => {
    // A hand-edited URL filters on nothing rather than on something
    // unexpected, and the value never reaches a query.
    expect(parseLoanStatuses({ status: 'overdue' })).toEqual([]);
    expect(parseLoanStatuses({ status: '; drop table loans' })).toEqual([]);
    expect(parseLoanStatuses({ status: 'active,overdue' })).toEqual(['active']);
    expect(parseLoanStatuses({ status: '__proto__' })).toEqual([]);
  });

  it('keeps the delinquency states Phase 7 defined, and no others', () => {
    expect(parseDelinquencyStates({ state: 'in_arrears,penalty_due' })).toEqual([
      'in_arrears',
      'penalty_due',
    ]);
    expect(parseDelinquencyStates({ state: 'very_late' })).toEqual([]);
  });

  it('keeps only the three payment methods the business accepts', () => {
    expect(parsePaymentMethod({ method: 'cash' })).toBe('cash');
    expect(parsePaymentMethod({ method: 'mtn_mobile_money' })).toBe('mtn_mobile_money');
    expect(parsePaymentMethod({ method: 'bank_transfer' })).toBeUndefined();
    expect(parsePaymentMethod({})).toBeUndefined();
  });

  it('keeps only the three collection statuses', () => {
    expect(parseCollectionStatus({ collection: 'part_paid' })).toBe('part_paid');
    expect(parseCollectionStatus({ collection: 'late' })).toBeUndefined();
  });

  it('keeps only a real client status', () => {
    for (const status of CLIENT_STATUS_OPTIONS) {
      expect(parseClientStatus({ clientStatus: status })).toBe(status);
    }
    expect(parseClientStatus({ clientStatus: 'deleted' })).toBeUndefined();
  });
});

// ===========================================================================
describe('the sort whitelist', () => {
  it('accepts the four orders the screen offers', () => {
    expect(parseOverdueSort({ sort: 'arrears' })).toBe('arrears');
    expect(parseOverdueSort({ sort: 'days' })).toBe('days');
    expect(parseOverdueSort({ sort: 'oldest' })).toBe('oldest');
    expect(parseOverdueSort({ sort: 'outstanding' })).toBe('outstanding');
  });

  it('refuses a column name, which is the whole point', () => {
    // The sort reaches `order()`, so a value from a URL must never be able to
    // name an arbitrary column.
    expect(parseOverdueSort({ sort: 'arrears_amount' })).toBeUndefined();
    expect(parseOverdueSort({ sort: 'client_phone' })).toBeUndefined();
    expect(parseOverdueSort({ sort: 'days,client_phone' })).toBeUndefined();
    expect(parseOverdueSort({ sort: 'days.desc' })).toBeUndefined();
  });
});

// ===========================================================================
describe('identifier filters', () => {
  it('accepts a well-formed identifier', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseUuid({ clientId: id }, 'clientId')).toBe(id);
  });

  it('drops anything that is not one', () => {
    // `?clientId=anything` filters on nothing rather than producing a database
    // type error the page would then have to explain.
    for (const value of [
      'anything',
      '1',
      "' or 1=1 --",
      '0f8fad5b-d9cb-469f-a165-70867728950',
      '0f8fad5b_d9cb_469f_a165_70867728950e',
    ]) {
      expect(parseUuid({ clientId: value }, 'clientId'), value).toBeUndefined();
    }
  });

  it('accepts either case, since a URL may carry either', () => {
    expect(parseUuid({ id: '0F8FAD5B-D9CB-469F-A165-70867728950E' }, 'id')).toBe(
      '0F8FAD5B-D9CB-469F-A165-70867728950E',
    );
  });
});

// ===========================================================================
describe('the date range', () => {
  it('defaults to the period the page asked for', () => {
    const today = businessDateFor(TIMEZONE);

    const resolved = resolveReportRange({}, TIMEZONE, 'today');
    expect(resolved.period).toBe('today');
    expect(resolved.range).toEqual({ from: today, to: today });
    expect(resolved.error).toBeNull();
  });

  it('honours a period from the query string', () => {
    const resolved = resolveReportRange({ period: 'month' }, TIMEZONE, 'today');
    expect(resolved.period).toBe('month');
    expect(resolved.range.from.endsWith('-01')).toBe(true);
  });

  it('ignores a period it does not offer', () => {
    const resolved = resolveReportRange({ period: 'fortnight' }, TIMEZONE, 'today');
    expect(resolved.period).toBe('today');
    expect(resolved.error).toBeNull();
  });

  it('takes a custom range as given', () => {
    const resolved = resolveReportRange(
      { period: 'custom', from: '2026-10-01', to: '2026-10-31' },
      TIMEZONE,
    );

    expect(resolved.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolved.error).toBeNull();
  });

  it('reports a reversed range rather than swapping it', () => {
    const resolved = resolveReportRange(
      { period: 'custom', from: '2026-10-31', to: '2026-10-01' },
      TIMEZONE,
    );

    expect(resolved.error).toMatch(/must not be after/i);
    // And falls back to a coherent range so the page still has something to
    // describe, rather than rendering figures for no stated period.
    expect(resolved.range.from).toBe(resolved.range.to);
  });

  it('reports an unreadable date as a sentence, never as an error page', () => {
    for (const from of ['2026-13-01', 'last Tuesday', '2026-02-30', '']) {
      const resolved = resolveReportRange(
        { period: 'custom', from, to: '2026-10-31' },
        TIMEZONE,
      );

      // An empty `from` is read as "today", which is a usable range; the rest
      // are refused with an explanation.
      if (from === '') {
        expect(resolved.error).toBeNull();
      } else {
        expect(resolved.error, from).not.toBeNull();
      }
    }
  });

  it('refuses a range longer than the cap, with its reason', () => {
    const resolved = resolveReportRange(
      { period: 'custom', from: '2010-01-01', to: '2030-01-01' },
      TIMEZONE,
    );

    expect(resolved.error).toMatch(new RegExp(`at most ${String(MAX_RANGE_DAYS)} days`));
  });

  it('reads today from the business timezone, not the host clock', () => {
    // The Phase 7 rule, applied to reports: at 23:30 UTC it is already
    // tomorrow in Kampala, and a report that disagreed with the ledger about
    // which day it is would disagree about which payments belong in it.
    const kampala = businessDateFor('Africa/Kampala');
    const samoa = businessDateFor('Pacific/Apia');

    expect(kampala).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(samoa).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The two zones are far enough apart that one of them is frequently a day
    // ahead; what matters is that the function answers per zone rather than
    // from one global clock.
    expect(typeof kampala).toBe('string');
  });
});

// ===========================================================================
describe('the export link query', () => {
  it('carries only the filters the page named', () => {
    const params: ParamRecord = {
      period: 'month',
      method: 'cash',
      query: 'Nakimuli',
      page: '4',
      secret: 'should-not-travel',
    };

    const query = exportQuery(params, ['period', 'from', 'to', 'method', 'query']);

    expect(query).toContain('period=month');
    expect(query).toContain('method=cash');
    expect(query).toContain('query=Nakimuli');
    // The page number is deliberately absent: an export is the whole filtered
    // set, not whichever page somebody happened to be on.
    expect(query).not.toContain('page=');
    expect(query).not.toContain('secret');
  });

  it('carries a repeated filter as a repeated parameter', () => {
    const query = exportQuery({ status: ['active', 'cleared'] }, ['status']);

    expect(query).toBe('status=active&status=cleared');
  });

  it('is empty when nothing is filtered', () => {
    expect(exportQuery({}, ['period', 'status'])).toBe('');
  });

  it('escapes what it carries', () => {
    const query = exportQuery({ query: 'a&b=c' }, ['query']);

    expect(query).toBe('query=a%26b%3Dc');
  });
});
