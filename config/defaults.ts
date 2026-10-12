/**
 * Fallback values for settings that are owned by the database.
 *
 * `company_settings` and `business_settings` are the single sources of truth
 * at runtime. These constants exist for exactly two reasons:
 *
 *  1. Rendering the shell before/if those rows can be read (for example on the
 *     public sign-in page, where Row Level Security denies the read).
 *  2. Seeding the initial database rows, so the SQL seed and the application
 *     agree on day-one values.
 *
 * They are NOT used by financial calculations. Any future loan or penalty
 * computation must read the live row from `business_settings` (or the terms
 * snapshotted onto the loan) so that changing a rate in the UI actually
 * changes behaviour. See docs/DECISIONS.md (ADR-002, ADR-008).
 */

import { BUSINESS_TIMEZONE, DEFAULT_CURRENCY_CODE, DEFAULT_LOCALE } from './app';

/**
 * Branding fallbacks — the company, not the software.
 *
 * ## Why these are the real details and no longer the product's own name
 *
 * Until Phase 12 this held `APP_NAME`, because the client's registration was
 * in progress and there was no company to name. There is now, and these
 * values are character-for-character what migration 20261012000100 wrote to
 * `company_settings`. That agreement is the point: the sign-in screen is
 * rendered for a caller with no session, `company_settings` is behind
 * `settings:view`, and so sign-in *cannot* read the row. Before, that showed
 * a borrower the name of the software where the lender's name belongs.
 *
 * `company_settings` remains the single source of truth. Every signed-in
 * surface reads it, and a business that renames itself changes one row — this
 * file is the one screen's fallback, not a second configuration.
 *
 * The one test that matters here is `tests/db/schema.test.ts`, which asserts
 * the seeded row and these constants still say the same thing.
 */
export const COMPANY_DEFAULTS = {
  companyName: 'Polytos Financial Services Ltd',
  legalName: 'Polytos Financial Services Limited',
  tagline: 'Empowering Your Business Swiftly',
  currencyCode: DEFAULT_CURRENCY_CODE,
  locale: DEFAULT_LOCALE,
  timezone: BUSINESS_TIMEZONE,
  phone: '+256768735982',
  phoneSecondary: '+256703587676',
  email: null,
  postalAddress: 'P.O. Box 219933, Kampala',
  addressLine1: 'Nsumbi, Kyebando',
  addressLine2: null,
  city: 'Kampala',
  country: 'Uganda',
  /**
   * The supplied mark, under `public/`. Stored without a leading slash,
   * which is the shape `company_settings.logo_path`'s CHECK describes.
   */
  logoPath: 'brand/polytos-logo.webp',
} as const;

/**
 * Day-one lending rules, as confirmed by the business.
 *
 * Monetary values are whole Ugandan shillings (see lib/domain/money.ts).
 * Rates are integer basis points: 1 bp = 0.01%, so 1500 bp = 15%.
 */
export const BUSINESS_DEFAULTS = {
  /** UGX 100,000 — smallest loan the business will issue. */
  minLoanAmount: 100_000,
  /** UGX 20,000,000 — conservative ceiling; the Owner/Admin can raise it. */
  maxLoanAmount: 20_000_000,
  /** 15% per month, applied to the reducing principal (engine is Phase 3). */
  defaultMonthlyInterestRateBps: 1_500,
  /** Shortest loan term in whole months. */
  minLoanTermMonths: 1,
  /** Longest loan term in whole months. */
  maxLoanTermMonths: 3,
  /** Days after loan expiry before a penalty may be applied. */
  gracePeriodDays: 3,
  /** 50% of the remaining outstanding debt, applied once after the grace period. */
  penaltyRateBps: 5_000,
  /** The business currently permits one active loan per client. */
  maxActiveLoansPerClient: 1,
  /** Default repayment cadence for new loans. */
  defaultRepaymentFrequency: 'daily',
} as const;

/**
 * Repayment cadences the business supports today. `intervalDays` is the gap
 * between consecutive installments.
 */
export const REPAYMENT_FREQUENCY_DEFAULTS = [
  { key: 'daily', label: 'Daily', intervalDays: 1, sortOrder: 1 },
  { key: 'every_2_days', label: 'Every 2 days', intervalDays: 2, sortOrder: 2 },
  { key: 'every_3_days', label: 'Every 3 days', intervalDays: 3, sortOrder: 3 },
] as const;

export type RepaymentFrequencyKey = (typeof REPAYMENT_FREQUENCY_DEFAULTS)[number]['key'];
