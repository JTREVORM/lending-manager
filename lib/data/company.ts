/**
 * Reading company branding.
 *
 * `company_settings` is the single source of truth for the company's name and
 * branding — the name is never a constant in a component. When registration
 * completes, one UPDATE renames the system everywhere.
 *
 * ## Why this degrades rather than throws
 *
 * In Phase 1 the row is **not readable**: `company_settings` has RLS enabled
 * with no policies, because Phase 2 decides who may read it (the row also
 * holds the tax and registration numbers, so it is not simply public). The
 * application shell still has to render a name.
 *
 * So this function reports where its answer came from, via a `source`
 * discriminator, and the UI surfaces that. This is not a swallowed error: the
 * outcome is part of the return type, the reason is logged, and
 * `config/defaults.ts` holds exactly the same name that migration 0008 seeded,
 * so the fallback and the database agree.
 *
 * Phase 2 replaces the `'defaults'` path with a real read once a policy
 * exists; the call sites do not change.
 */

import 'server-only';

import { unstable_rethrow } from 'next/navigation';

import { COMPANY_DEFAULTS } from '@/config/defaults';
import { mapDatabaseError } from '@/lib/db-errors';
import { isAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/** The branding fields the application shell needs. */
export interface CompanyBranding {
  readonly companyName: string;
  /**
   * The line that sits under the name. Phase 12: the business has one, it is
   * on its own flyer, and the sign-in screen is where a borrower first reads
   * it. Nullable because a company need not have one.
   */
  readonly tagline: string | null;
  readonly currencyCode: string;
  readonly locale: string;
  readonly timezone: string;
  readonly logoPath: string | null;
}

export interface CompanyBrandingResult {
  readonly branding: CompanyBranding;
  /**
   * `'database'` — read from `company_settings`.
   * `'defaults'` — the row was unreadable (no policy yet, or Supabase is not
   *   configured), so `config/defaults.ts` was used.
   */
  readonly source: 'database' | 'defaults';
  /** Why the fallback was used. Diagnostic; safe to display to staff. */
  readonly fallbackReason?: string;
}

const DEFAULT_BRANDING: CompanyBranding = {
  companyName: COMPANY_DEFAULTS.companyName,
  tagline: COMPANY_DEFAULTS.tagline,
  currencyCode: COMPANY_DEFAULTS.currencyCode,
  locale: COMPANY_DEFAULTS.locale,
  timezone: COMPANY_DEFAULTS.timezone,
  logoPath: COMPANY_DEFAULTS.logoPath,
};

/**
 * The company fields a document the business hands out carries.
 *
 * ## Why one shape for a receipt and a statement
 *
 * Phase 12 put the company's real identity on both, and before that each
 * assembled its own header from whichever fields its page happened to pass —
 * the receipt had the name and one phone number, the statement had the name
 * alone. A borrower holding a statement and a receipt from the same lender
 * read two different letterheads. One shape, one component
 * (`DocumentLetterhead`), and a Phase 7 PDF will carry the same one.
 */
export interface DocumentBranding {
  readonly companyName: string;
  readonly tagline: string | null;
  readonly logoPath: string | null;
  readonly phone: string | null;
  readonly phoneSecondary: string | null;
  /** The P.O. Box. A letter goes here. */
  readonly postalAddress: string | null;
  /** Where the office is, assembled from the address lines and the city. */
  readonly physicalAddress: string | null;
  readonly receiptHeader: string | null;
  readonly receiptFooter: string | null;
  readonly timezone: string;
}

/**
 * Company details for a document, from the current settings.
 *
 * Deliberately **not** snapshotted onto the payment. A receipt reprinted next
 * year showing this year's phone number is helpful; one showing a disconnected
 * number is not. The figures that must not move — the amount, the balances,
 * the borrower's name, the actor — are snapshotted on the payment row itself.
 *
 * ## Which table it reads, and why that is not the obvious one
 *
 * `company_identity`, not `company_settings`. A staff member holds
 * `settings:view` and could read either; a borrower holds neither, and
 * Phase 12 is the phase where a borrower's own statement started carrying the
 * letterhead. The view publishes exactly the fields a document needs and
 * keeps the registration and tax numbers out, so one function serves both
 * audiences and neither gets more than it should.
 *
 * `receipt_header` and `receipt_footer` are the exception: they are not on the
 * view, because they are the business's own wording for its documents rather
 * than its published identity. They are read separately and simply come back
 * null for a borrower, which the letterhead renders as their absence.
 *
 * Never throws, for the same reason `getCompanyBranding` does not: a receipt
 * must not fail to render because a settings read failed.
 */
export async function getDocumentBranding(): Promise<DocumentBranding> {
  const fallback: DocumentBranding = {
    companyName: COMPANY_DEFAULTS.companyName,
    tagline: COMPANY_DEFAULTS.tagline,
    logoPath: COMPANY_DEFAULTS.logoPath,
    phone: COMPANY_DEFAULTS.phone,
    phoneSecondary: COMPANY_DEFAULTS.phoneSecondary,
    postalAddress: COMPANY_DEFAULTS.postalAddress,
    physicalAddress: joinAddress([
      COMPANY_DEFAULTS.addressLine1,
      COMPANY_DEFAULTS.addressLine2,
      COMPANY_DEFAULTS.city,
      COMPANY_DEFAULTS.country,
    ]),
    receiptHeader: null,
    receiptFooter: null,
    timezone: COMPANY_DEFAULTS.timezone,
  };

  try {
    const supabase = await createSupabaseServerClient();

    const [identity, wording] = await Promise.all([
      supabase
        .from('company_identity')
        .select(
          `company_name, tagline, logo_path, phone, phone_secondary, postal_address, address_line1, address_line2, city, country, timezone`,
        )
        .maybeSingle(),
      supabase
        .from('company_settings')
        .select('receipt_header, receipt_footer')
        .eq('id', 1)
        .maybeSingle(),
    ]);

    if (identity.error !== null || identity.data === null) {
      logger.debug('Document branding unreadable; using configured defaults.');
      return fallback;
    }

    const row = identity.data;

    return {
      companyName: String(row.company_name),
      tagline: row.tagline === null ? null : String(row.tagline),
      logoPath: row.logo_path === null ? null : String(row.logo_path),
      phone: row.phone === null ? null : String(row.phone),
      phoneSecondary: row.phone_secondary === null ? null : String(row.phone_secondary),
      postalAddress: row.postal_address === null ? null : String(row.postal_address),
      physicalAddress: joinAddress([
        row.address_line1,
        row.address_line2,
        row.city,
        row.country,
      ]),
      receiptHeader: wording.data?.receipt_header ?? null,
      receiptFooter: wording.data?.receipt_footer ?? null,
      timezone: String(row.timezone),
    };
  } catch (error) {
    unstable_rethrow(error);
    return fallback;
  }
}

/** The address lines that are actually recorded, as one line. */
function joinAddress(parts: readonly (string | null)[]): string | null {
  const joined = parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(', ');

  return joined === '' ? null : joined;
}

/**
 * The company's identity, for a borrower.
 *
 * Reads `company_identity` rather than `company_settings`: a borrower holds
 * no `settings:view`, so the full row is invisible to them and the portal
 * header fell back to the name of the *software* — which is what the
 * pre-Phase-9 screenshots show. The view exposes the name, locale, timezone
 * and logo and nothing else. See migration 20261009000100.
 *
 * Never throws, for the same reason the staff version does not: a header must
 * not be able to fail the page.
 */
export async function getPortalBranding(): Promise<CompanyBranding> {
  try {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase
      .from('company_identity')
      .select('company_name, tagline, currency_code, locale, timezone, logo_path')
      .maybeSingle();

    if (error !== null || data === null) {
      logger.debug('Company identity unreadable; using configured defaults.');
      return DEFAULT_BRANDING;
    }

    return {
      companyName: String(data.company_name),
      tagline: data.tagline === null ? null : String(data.tagline),
      currencyCode: String(data.currency_code),
      locale: String(data.locale),
      timezone: String(data.timezone),
      logoPath: data.logo_path === null ? null : String(data.logo_path),
    };
  } catch (error) {
    unstable_rethrow(error);
    return DEFAULT_BRANDING;
  }
}

/**
 * Company branding, from the database where possible.
 *
 * Never throws. A caller rendering a page header must not be able to fail
 * because of a settings read, and the `source` field makes the degradation
 * explicit rather than invisible.
 */
export async function getCompanyBranding(): Promise<CompanyBrandingResult> {
  try {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase
      .from('company_settings')
      .select('company_name, tagline, currency_code, locale, timezone, logo_path')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      const mapped = mapDatabaseError(error, 'company settings');
      logger.debug('Company settings unreadable; using configured defaults.', {
        code: mapped.code,
      });
      return {
        branding: DEFAULT_BRANDING,
        source: 'defaults',
        fallbackReason:
          'Company settings are not readable yet. Read access is defined in Phase 2.',
      };
    }

    if (data === null) {
      // The seed migration has not run against this database.
      logger.warn('company_settings row 1 is missing; using configured defaults.');
      return {
        branding: DEFAULT_BRANDING,
        source: 'defaults',
        fallbackReason: 'No company settings row was found. Run the database migrations.',
      };
    }

    return {
      branding: {
        companyName: data.company_name,
        tagline: data.tagline,
        currencyCode: data.currency_code,
        locale: data.locale,
        timezone: data.timezone,
        logoPath: data.logo_path,
      },
      source: 'database',
    };
  } catch (error) {
    // Next.js signals control flow by throwing: `redirect()`, `notFound()`,
    // and the dynamic-rendering marker that `cookies()` raises during a static
    // prerender all arrive here as exceptions. Swallowing one would break
    // routing or silently mislabel a route's rendering mode, so they are
    // re-thrown before anything else is considered.
    unstable_rethrow(error);

    // What remains is a genuine failure — most often that Supabase is not
    // configured, which makes `getPublicEnv()` throw a ConfigurationError.
    // Narrow in effect: the reason is returned to the caller and logged, not
    // discarded.
    const reason = isAppError(error)
      ? error.userMessage
      : 'Could not reach the database.';

    logger.warn('Falling back to configured company defaults.', {
      reason,
      error,
    });

    return {
      branding: DEFAULT_BRANDING,
      source: 'defaults',
      fallbackReason: reason,
    };
  }
}
