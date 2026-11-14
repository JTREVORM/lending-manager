/**
 * The Agency reporting model: sections, scopes and the filter they share.
 *
 * ## Why one hub with sections rather than eight report pages
 *
 * The client's §6 asks for seven reports and an export centre, at three
 * levels: one agent account or bank account, one provider or bank, and the
 * whole Agency business. Twenty-one pages is the arithmetic if each
 * combination gets its own route, and every one of them would re-derive the
 * same figures from the same views.
 *
 * They do not differ in what they read. A provider-level transaction report
 * and the consolidated one are the same query with one more equality on it;
 * the levels are a filter. So this declares the filter once, the sections
 * once, and the hub renders the section that is asked for — which is the
 * pattern `lib/reports/registry.ts` already established for the lending
 * reports, and the reason the rail can carry nine entries that are all views
 * of one screen.
 *
 * ## No report computes anything
 *
 * Every figure comes from a Phase 4C/4E view or from the cash banking
 * register. Nothing here sums, nets or apportions. That is not a style
 * preference: GL 1310 and the 2200-series accounts are shared between
 * providers, so a total this layer computed could not be attributed and would
 * silently mix them — which is the mistake the views exist to prevent.
 */

import {
  REPORT_PERIOD_LABELS,
  type DateRange,
  type ReportPeriod,
} from '@/lib/domain/reporting';
import { resolveReportRange, singleParam, type ParamRecord } from '@/lib/reports/filters';
import {
  AGENCY_PROVIDER_CATEGORIES,
  type AgencyProviderCategory,
} from '@/lib/domain/agency';
import { ROUTES } from '@/config/app';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The eight views of the Agency reporting hub.
 *
 * `overview` is the default, so `/agency/reports` with no parameters is a
 * coherent page rather than an empty frame waiting for a section.
 */
export const AGENCY_REPORT_SECTIONS = [
  'overview',
  'transactions',
  'cash-float',
  'commission',
  'settlements',
  'reconciliation',
  'performance',
  'export',
] as const;
export type AgencyReportSection = (typeof AGENCY_REPORT_SECTIONS)[number];

export function isAgencyReportSection(value: unknown): value is AgencyReportSection {
  return (
    typeof value === 'string' &&
    (AGENCY_REPORT_SECTIONS as readonly string[]).includes(value)
  );
}

/** What each section is called, and what it answers. */
export const AGENCY_REPORT_SECTION_META: Readonly<
  Record<AgencyReportSection, { readonly label: string; readonly description: string }>
> = {
  overview: {
    label: 'Overview',
    description:
      'The position across every configured bank and Mobile Money network: float held, cash banked, commission earned against commission received, and the work still outstanding.',
  },
  transactions: {
    label: 'Transaction reports',
    description:
      'Customer deposits and withdrawals, their counts and values, the charges taken, and who recorded and verified each one.',
  },
  'cash-float': {
    label: 'Cash & float reports',
    description:
      'Opening float, verified increases and decreases, closing float; and physical cash received, paid out, banked, counted and the variance.',
  },
  commission: {
    label: 'Commission reports',
    description:
      'Commission earned by day, provider and account, set against what the provider has actually settled — and what is therefore still receivable.',
  },
  settlements: {
    label: 'Settlement reports',
    description:
      'Provider remittances and commission settlements, with the maker, the checker and the reference behind each.',
  },
  reconciliation: {
    label: 'Reconciliation reports',
    description:
      'What the books say against what the statement says, the variance between them, and whether the difference has been resolved.',
  },
  performance: {
    label: 'Agent performance',
    description:
      'What each staff member handled: the accounts they are on, the deposits and withdrawals they recorded, and the transactions that were reversed or corrected.',
  },
  export: {
    label: 'Export centre',
    description:
      'Every report above as a PDF or a spreadsheet-compatible CSV, carrying the filters, the period and the time it was generated.',
  },
};

// ---------------------------------------------------------------------------
// Scope — which module a report is about
// ---------------------------------------------------------------------------

/**
 * `all`, `banking` or `mobile_money`.
 *
 * A scope is the client's Level C against Level B: the whole Agency business,
 * or one of its two modules. It resolves to the provider categories the
 * queries filter on, so no report names a provider code and a bank registered
 * next year is in scope on the day it is configured.
 */
export const AGENCY_REPORT_SCOPES = ['all', 'banking', 'mobile_money'] as const;
export type AgencyReportScope = (typeof AGENCY_REPORT_SCOPES)[number];

export function isAgencyReportScope(value: unknown): value is AgencyReportScope {
  return (
    typeof value === 'string' &&
    (AGENCY_REPORT_SCOPES as readonly string[]).includes(value)
  );
}

export const AGENCY_SCOPE_LABELS: Readonly<Record<AgencyReportScope, string>> = {
  all: 'All agency business',
  banking: 'Agent Banking',
  mobile_money: 'Mobile Money',
};

/**
 * The provider categories a scope covers.
 *
 * `all` returns every category rather than `undefined`, so a caller never has
 * to special-case "no filter" — and so a provider in a category nobody
 * expected (`utility`, `school_fees`) is counted in the consolidated report
 * instead of silently vanishing from it.
 */
export function categoriesForScope(
  scope: AgencyReportScope,
): readonly AgencyProviderCategory[] {
  if (scope === 'banking') return ['agency_banking'];
  if (scope === 'mobile_money') return ['mobile_money'];
  return AGENCY_PROVIDER_CATEGORIES;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/**
 * Everything the hub, its sections and its exports read from the URL.
 *
 * `error` is a sentence to show *instead of* the figures when the request was
 * unusable — an unreadable custom range, say. A report that silently fell
 * back to today and showed numbers would be the worst outcome: the reader
 * would act on figures for a period they did not ask for.
 */
export interface AgencyReportFilter {
  readonly section: AgencyReportSection;
  readonly scope: AgencyReportScope;
  readonly categories: readonly AgencyProviderCategory[];
  readonly providerCode: string | null;
  readonly accountId: string | null;
  readonly branchId: string | null;
  readonly staffId: string | null;
  readonly period: ReportPeriod;
  readonly range: DateRange;
  readonly error: string | null;
}

/** A provider code as a URL may carry it: the database's own shape, or nothing. */
function providerCode(params: ParamRecord): string | null {
  const raw = singleParam(params, 'provider');
  if (raw === undefined) return null;
  // `agency_providers_code_shape`: upper case, digits and underscores, 2–32.
  return /^[A-Z0-9_]{2,32}$/.test(raw) ? raw : null;
}

function uuid(params: ParamRecord, key: string): string | null {
  const raw = singleParam(params, key);
  if (raw === undefined) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

/**
 * Read the filter a request asks for.
 *
 * A malformed value falls back rather than erroring, for the reason the loan
 * register gives: a filter is a convenience, not a control. What a reader may
 * see is decided by the capability on the route and by Row Level Security on
 * every view beneath it, and neither is affected by anything in this
 * function. A reader who hand-types `?provider=SOMEBODY_ELSE` gets that
 * provider's name in a heading and no rows.
 *
 * The default period is `month`, not `today`. An agency report is read to
 * reconcile a provider's statement and to see commission against settlement,
 * and both are monthly questions; a hub that opened on one day's figures would
 * be answering a question nobody asked and would look empty every morning.
 */
export function readAgencyReportFilter(
  params: ParamRecord,
  timeZone: string,
): AgencyReportFilter {
  const sectionRaw = singleParam(params, 'section');
  const section = isAgencyReportSection(sectionRaw) ? sectionRaw : 'overview';

  const scopeRaw = singleParam(params, 'scope');
  const scope = isAgencyReportScope(scopeRaw) ? scopeRaw : 'all';

  const resolved = resolveReportRange(params, timeZone, 'month');

  return {
    section,
    scope,
    categories: categoriesForScope(scope),
    providerCode: providerCode(params),
    accountId: uuid(params, 'account'),
    branchId: uuid(params, 'branch'),
    staffId: uuid(params, 'staff'),
    period: resolved.period,
    range: resolved.range,
    error: resolved.error,
  };
}

/**
 * The parameters an Agency report reads.
 *
 * Exported because two things need the same list and must not disagree: the
 * export link, which carries the filters and nothing else, and the navigation
 * parity test, which asserts that a rail entry may only pin a parameter its
 * destination actually reads.
 */
export const AGENCY_REPORT_PARAMS = [
  'section',
  'scope',
  'provider',
  'account',
  'branch',
  'staff',
  'period',
  'from',
  'to',
] as const;

/** The query string for a link that keeps the current filter. */
export function agencyReportQuery(
  filter: AgencyReportFilter,
  overrides?: {
    readonly section?: AgencyReportSection;
    readonly scope?: AgencyReportScope;
    readonly provider?: string | null;
  },
): string {
  const query = new URLSearchParams();

  const section = overrides?.section ?? filter.section;
  if (section !== 'overview') query.set('section', section);

  const scope = overrides?.scope ?? filter.scope;
  if (scope !== 'all') query.set('scope', scope);

  const provider =
    overrides?.provider === undefined ? filter.providerCode : overrides.provider;
  if (provider !== null) query.set('provider', provider);

  if (filter.accountId !== null) query.set('account', filter.accountId);
  if (filter.branchId !== null) query.set('branch', filter.branchId);
  if (filter.staffId !== null) query.set('staff', filter.staffId);

  query.set('period', filter.period);
  if (filter.period === 'custom') {
    query.set('from', filter.range.from);
    query.set('to', filter.range.to);
  }

  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** A link to one section of the hub, keeping the rest of the filter. */
export function agencyReportHref(
  filter: AgencyReportFilter,
  section: AgencyReportSection,
): string {
  return `${ROUTES.agencyReports}${agencyReportQuery(filter, { section })}`;
}

/** How the period reads in a heading and in an export's header block. */
export function agencyPeriodLabel(filter: AgencyReportFilter): string {
  return filter.period === 'custom'
    ? `${filter.range.from} to ${filter.range.to}`
    : REPORT_PERIOD_LABELS[filter.period];
}

/** What the filter is about, as one line under a report's heading. */
export function agencyScopeLabel(filter: AgencyReportFilter): string {
  if (filter.providerCode !== null) return filter.providerCode;
  return AGENCY_SCOPE_LABELS[filter.scope];
}

/** Re-exported so a page need not import from two modules to read a filter. */
export type { ParamRecord };
