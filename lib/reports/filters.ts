/**
 * No `server-only` marker here, for the same reason as `csv.ts`: this module
 * is the filter-whitelisting layer, which is a security control, and a control
 * that cannot be unit-tested is a control nobody can be sure of. It touches no
 * database and holds no credential — it reads a query string and returns
 * values the layer below is allowed to use.
 */

import { businessToday, type BusinessDate } from '@/lib/domain/datetime';
import {
  assertRangeWithinLimit,
  isOverdueSort,
  isReportPeriod,
  resolveDateRange,
  ReportingError,
  type DateRange,
  type OverdueSort,
  type ReportPeriod,
} from '@/lib/domain/reporting';
import { isDelinquencyState, type DelinquencyState } from '@/lib/domain/delinquency';
import { isPaymentMethod, type PaymentMethod } from '@/lib/domain/payment';
import { isLoanStatus, type LoanStatus } from '@/lib/domain/loan';
import { CLIENT_STATUSES, isClientStatus } from '@/lib/domain/client';
import { isCollectionStatus, type CollectionStatus } from '@/lib/domain/reporting';
import { isAgingBucket, type AgingBucket } from '@/lib/domain/risk';
import {
  isCollateralStatus,
  isGuaranteeStatus,
  isPromiseStatus,
  isRecoveryActionKind,
  type CollateralStatus,
  type GuaranteeStatus,
  type PromiseStatus,
  type RecoveryActionKind,
} from '@/lib/domain/security';

/**
 * Turning a query string into report filters.
 *
 * ## Every value is whitelisted, and the whitelist is the type
 *
 * A filter arriving from a URL is a string somebody can type. None of them is
 * passed through to a query: each is tested against the set of values the
 * report actually offers, and anything else is dropped. So `?status=; drop
 * table` filters on nothing rather than on something, and `?sort=password` can
 * never become a column name — `OVERDUE_SORTS` maps the four sorts the screen
 * offers to the four columns they mean, and nothing else is reachable.
 *
 * That is the answer to filter injection at this layer. The layer below adds
 * two more: the Supabase query builder parameterises values, and
 * `safeSearchTerm` reduces a free-text search to characters that cannot be
 * read as PostgREST filter syntax.
 *
 * ## An unusable filter is dropped, an unusable range is reported
 *
 * A bad `status` is simply ignored: the person sees the unfiltered report,
 * which is a reasonable reading of a mistyped URL. A bad *date range* is
 * different — showing a different range from the one asked for would be
 * misleading about what the figures cover — so it returns an error the page
 * renders as a sentence. Neither case ever produces a database error, let
 * alone one shown to a user.
 */

export type ParamRecord = Readonly<Record<string, string | string[] | undefined>>;

/** The first value of a parameter that may legitimately repeat. */
export function singleParam(params: ParamRecord, key: string): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim() === '' ? undefined : first;
}

/** Every value of a repeatable parameter, also accepting `a,b` in one. */
export function multiParam(params: ParamRecord, key: string): readonly string[] {
  const value = params[key];
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export interface ResolvedRange {
  readonly period: ReportPeriod;
  readonly range: DateRange;
  /** A sentence to show instead of the report, when the request was unusable. */
  readonly error: string | null;
}

/**
 * The date range a report covers.
 *
 * "Today" comes from the business timezone, never from the browser or the
 * server's own clock — the Phase 7 rule. A report run at 23:30 UTC covers
 * tomorrow in Kampala, because in Kampala it already is tomorrow, and the
 * ledger agrees.
 */
export function resolveReportRange(
  params: ParamRecord,
  timeZone: string,
  defaultPeriod: ReportPeriod = 'today',
): ResolvedRange {
  const today = businessToday(new Date(), timeZone);
  const raw = singleParam(params, 'period');
  const period = isReportPeriod(raw) ? raw : defaultPeriod;

  try {
    const range = resolveDateRange(period, today, {
      from: singleParam(params, 'from'),
      to: singleParam(params, 'to'),
    });

    assertRangeWithinLimit(range);

    return { period, range, error: null };
  } catch (error) {
    const message =
      error instanceof ReportingError
        ? error.message
        : 'That date range could not be read. Please choose dates in the form 2026-10-04.';

    // Fall back to the default period so the page still has a coherent range to
    // describe, and say plainly that the request was not honoured.
    return {
      period: defaultPeriod,
      range: resolveDateRange(defaultPeriod, today),
      error: message,
    };
  }
}

export function businessDateFor(timeZone: string): BusinessDate {
  return businessToday(new Date(), timeZone);
}

export function parseLoanStatuses(params: ParamRecord): readonly LoanStatus[] {
  return multiParam(params, 'status').filter(isLoanStatus);
}

export function parseDelinquencyStates(params: ParamRecord): readonly DelinquencyState[] {
  return multiParam(params, 'state').filter(isDelinquencyState);
}

export function parsePaymentMethod(params: ParamRecord): PaymentMethod | undefined {
  const value = singleParam(params, 'method');
  return isPaymentMethod(value) ? value : undefined;
}

export function parseCollectionStatus(params: ParamRecord): CollectionStatus | undefined {
  const value = singleParam(params, 'collection');
  return isCollectionStatus(value) ? value : undefined;
}

export function parseOverdueSort(params: ParamRecord): OverdueSort | undefined {
  const value = singleParam(params, 'sort');
  return isOverdueSort(value) ? value : undefined;
}

export function parseClientStatus(params: ParamRecord): string | undefined {
  const value = singleParam(params, 'clientStatus');
  return isClientStatus(value) ? value : undefined;
}

export const CLIENT_STATUS_OPTIONS = CLIENT_STATUSES;

/**
 * A UUID from a query string, or nothing.
 *
 * Checked for shape before it reaches a query, so `?clientId=anything` filters
 * on nothing rather than producing a database type error the page would have
 * to explain.
 */
export function parseUuid(params: ParamRecord, key: string): string | undefined {
  const value = singleParam(params, key);
  if (value === undefined) return undefined;

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

/** The query string to carry into an export link: the filters, nothing else. */
export function exportQuery(params: ParamRecord, keys: readonly string[]): string {
  const query = new URLSearchParams();

  for (const key of keys) {
    for (const value of multiParam(params, key)) query.append(key, value);
  }

  return query.toString();
}

// ---------------------------------------------------------------------------
// Phase 16 — the Debt & Security reports' filters
//
// Each one whitelisted against the set its report actually offers, the way
// every parser above is. So `?bucket=; drop table` filters on nothing rather
// than on something, and `?guaranteeStatus=anything` shows the unfiltered
// register rather than producing a database error the page would have to
// explain.
// ---------------------------------------------------------------------------

export function parseAgingBucket(params: ParamRecord): AgingBucket | undefined {
  const value = singleParam(params, 'bucket');
  return isAgingBucket(value) ? value : undefined;
}

export function parseRecoveryKind(params: ParamRecord): RecoveryActionKind | undefined {
  const value = singleParam(params, 'kind');
  return isRecoveryActionKind(value) ? value : undefined;
}

export function parsePromiseStatus(params: ParamRecord): PromiseStatus | undefined {
  const value = singleParam(params, 'promiseStatus');
  return isPromiseStatus(value) ? value : undefined;
}

export function parseGuaranteeStatus(params: ParamRecord): GuaranteeStatus | undefined {
  const value = singleParam(params, 'guaranteeStatus');
  return isGuaranteeStatus(value) ? value : undefined;
}

export function parseCollateralStatusFilter(
  params: ParamRecord,
): CollateralStatus | undefined {
  const value = singleParam(params, 'status');
  return isCollateralStatus(value) ? value : undefined;
}

/**
 * Whether a guarantor is an existing borrower or somebody from outside.
 *
 * Two values and no type guard in the domain for them, because the view
 * derives the distinction rather than storing it — so the whitelist is here,
 * written out, which is what a whitelist is for.
 */
export function parseSubjectKind(params: ParamRecord): 'client' | 'external' | undefined {
  const value = singleParam(params, 'subjectKind');
  return value === 'client' || value === 'external' ? value : undefined;
}
