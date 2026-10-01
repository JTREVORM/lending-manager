/**
 * Centralised application configuration.
 *
 * These are *build-time* constants: identity, locale and conventions that the
 * application needs before it can talk to the database. Anything the business
 * must be able to change at runtime (company name, interest rates, loan
 * limits) lives in the database instead — see `config/defaults.ts` for the
 * fallbacks used when the database has not been read yet.
 *
 * Rule of thumb: if the Owner/Admin should be able to edit it from a screen,
 * it does not belong in this file.
 */

/**
 * Working application name.
 *
 * TEMPORARY: the client's company registration is still in progress. The
 * authoritative, user-facing company name is `company_settings.company_name`
 * in the database and is read through `lib/data/company.ts`. This constant is
 * only the fallback used before/if that row is unavailable, plus the name of
 * the software itself.
 */
export const APP_NAME = 'Money Lending Management System' as const;

/** Short form used in tight spaces (mobile header, PWA name later). */
export const APP_SHORT_NAME = 'Lending Manager' as const;

export const APP_DESCRIPTION =
  'Loan, repayment and client management for a Ugandan money lending business.' as const;

/** ISO 4217 currency code. The business operates exclusively in Ugandan shillings. */
export const DEFAULT_CURRENCY_CODE = 'UGX' as const;

/** BCP 47 locale used for number and date formatting. */
export const DEFAULT_LOCALE = 'en-UG' as const;

/**
 * IANA timezone of the business.
 *
 * All timestamps are stored in UTC (`timestamptz`); this is the zone used to
 * render them and to decide what "today" means for business purposes such as
 * reference-number year rollover and (in later phases) repayment due dates.
 */
export const BUSINESS_TIMEZONE = 'Africa/Kampala' as const;

/** Deployment environments the application understands. */
export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

/** Log levels, ordered from most to least verbose. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Delivery phase of this codebase. Used by the UI to label functionality that
 * is deliberately not built yet, so staff are never shown a dead control.
 */
export const CURRENT_PHASE = 1 as const;

/** Canonical route paths, so links are never hand-typed across the codebase. */
export const ROUTES = {
  dashboard: '/',
  clients: '/clients',
  loans: '/loans',
  payments: '/payments',
  settings: '/settings',
} as const;

export type RouteKey = keyof typeof ROUTES;
