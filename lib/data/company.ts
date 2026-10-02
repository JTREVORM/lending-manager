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
  currencyCode: COMPANY_DEFAULTS.currencyCode,
  locale: COMPANY_DEFAULTS.locale,
  timezone: COMPANY_DEFAULTS.timezone,
  logoPath: COMPANY_DEFAULTS.logoPath,
};

/** The company fields a printed receipt shows. */
export interface ReceiptBranding {
  readonly companyName: string;
  readonly companyPhone: string | null;
  readonly receiptHeader: string | null;
  readonly receiptFooter: string | null;
  readonly timezone: string;
}

/**
 * Company details for a receipt, from the current settings.
 *
 * Deliberately **not** snapshotted onto the payment. A receipt reprinted next
 * year showing this year's phone number is helpful; one showing a disconnected
 * number is not. The figures that must not move — the amount, the balances,
 * the borrower's name, the actor — are snapshotted on the payment row itself.
 *
 * Never throws, for the same reason `getCompanyBranding` does not: a receipt
 * must not fail to render because a settings read failed.
 */
export async function getReceiptBranding(): Promise<ReceiptBranding> {
  const fallback: ReceiptBranding = {
    companyName: COMPANY_DEFAULTS.companyName,
    companyPhone: null,
    receiptHeader: null,
    receiptFooter: null,
    timezone: COMPANY_DEFAULTS.timezone,
  };

  try {
    const supabase = await createSupabaseServerClient();

    const { data, error } = await supabase
      .from('company_settings')
      .select('company_name, phone, receipt_header, receipt_footer, timezone')
      .eq('id', 1)
      .maybeSingle();

    if (error !== null || data === null) {
      logger.debug('Receipt branding unreadable; using configured defaults.');
      return fallback;
    }

    return {
      companyName: String(data.company_name),
      companyPhone: data.phone === null ? null : String(data.phone),
      receiptHeader: data.receipt_header === null ? null : String(data.receipt_header),
      receiptFooter: data.receipt_footer === null ? null : String(data.receipt_footer),
      timezone: String(data.timezone),
    };
  } catch {
    return fallback;
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
      .select('company_name, currency_code, locale, timezone, logo_path')
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
