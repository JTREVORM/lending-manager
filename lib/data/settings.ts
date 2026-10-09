import 'server-only';

import { COMPANY_DEFAULTS } from '@/config/defaults';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Reading the settings the Settings screen shows.
 *
 * Both rows run as the caller, so Row Level Security decides visibility:
 * `settings:view` is what opens them, and a borrower holds no such
 * capability. Nothing here is cached or defaulted silently — a settings
 * screen that quietly shows a fallback is a settings screen that tells an
 * Owner their interest rate is 15% when the database says something else.
 *
 * So a failed read reports itself, and the page says the value is unavailable
 * rather than inventing one.
 */

export interface CompanyProfile {
  readonly companyName: string;
  readonly legalName: string | null;
  /** Phase 12. The line under the name on a document or the sign-in screen. */
  readonly tagline: string | null;
  readonly registrationNumber: string | null;
  readonly taxIdentificationNumber: string | null;
  readonly phone: string | null;
  readonly phoneSecondary: string | null;
  readonly email: string | null;
  readonly postalAddress: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly currencyCode: string;
  readonly locale: string;
  readonly timezone: string;
  readonly receiptHeader: string | null;
  readonly receiptFooter: string | null;
  readonly brandPrimaryColor: string | null;
  readonly logoPath: string | null;
}

export interface LendingRules {
  readonly minLoanAmount: number;
  readonly maxLoanAmount: number;
  readonly multiMonthMinAmount: number;
  readonly defaultMonthlyInterestRateBps: number;
  readonly defaultInterestMethod: string;
  readonly minLoanTermMonths: number;
  readonly maxLoanTermMonths: number;
  readonly gracePeriodDays: number;
  readonly penaltyRateBps: number;
  readonly maxActiveLoansPerClient: number;
  readonly minGuarantorsRequired: number;
  readonly defaultRepaymentFrequency: string;
}

export interface RepaymentCadence {
  readonly key: string;
  readonly label: string;
  readonly intervalDays: number;
  readonly isActive: boolean;
}

/** A branch, for the settings screen's branch section. */
export interface BranchSummary {
  readonly id: string;
  readonly branchCode: string;
  readonly name: string;
  readonly location: string | null;
  readonly district: string | null;
  readonly phone: string | null;
  readonly status: string;
  readonly openedOn: string | null;
}

/** A reference sequence, so the Owner can see what numbering is in use. */
export interface ReferenceSequence {
  readonly scope: string;
  /** Two digits, the way the reference itself is written: `CL26001`. */
  readonly periodYear: number;
  readonly lastValue: number;
}

export interface SettingsSnapshot {
  readonly company: CompanyProfile | null;
  readonly rules: LendingRules | null;
  readonly cadences: readonly RepaymentCadence[];
  readonly branches: readonly BranchSummary[];
  readonly sequences: readonly ReferenceSequence[];
  /** Which reads failed, so the page can say so instead of showing nothing. */
  readonly unavailable: readonly string[];
}

export async function getSettingsSnapshot(): Promise<SettingsSnapshot> {
  const supabase = await createSupabaseServerClient();
  const unavailable: string[] = [];

  const [companyResult, rulesResult, cadenceResult, branchResult, sequenceResult] =
    await Promise.all([
      supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('business_settings').select('*').eq('id', 1).maybeSingle(),
      supabase
        .from('repayment_frequencies')
        .select('key, label, interval_days, is_active')
        .order('sort_order', { ascending: true }),
      // Phase 12. Both need their own capability — `branches:view` and
      // `settings:view` — so either can come back empty for a caller who
      // holds one and not the other, and the page says so rather than
      // implying the business has no branches.
      supabase
        .from('branches')
        .select('id, branch_code, name, location, district, phone, status, opened_on')
        .order('branch_code', { ascending: true }),
      supabase
        .from('reference_sequences')
        .select('scope, period_year, last_value')
        .order('scope', { ascending: true })
        .order('period_year', { ascending: false }),
    ]);

  if (companyResult.error !== null) {
    logger.warn('Company settings unreadable.', { code: companyResult.error.code });
    unavailable.push('company');
  }

  if (rulesResult.error !== null) {
    logger.warn('Lending rules unreadable.', { code: rulesResult.error.code });
    unavailable.push('rules');
  }

  if (cadenceResult.error !== null) {
    logger.warn('Repayment cadences unreadable.', { code: cadenceResult.error.code });
    unavailable.push('cadences');
  }

  if (branchResult.error !== null) {
    logger.warn('Branches unreadable.', { code: branchResult.error.code });
    unavailable.push('branches');
  }

  if (sequenceResult.error !== null) {
    logger.warn('Reference sequences unreadable.', { code: sequenceResult.error.code });
    unavailable.push('sequences');
  }

  const companyRow = companyResult.data;
  const rulesRow = rulesResult.data;

  return {
    company:
      companyRow === null || companyRow === undefined
        ? null
        : {
            companyName: companyRow.company_name,
            legalName: companyRow.legal_name,
            tagline: companyRow.tagline,
            registrationNumber: companyRow.registration_number,
            taxIdentificationNumber: companyRow.tax_identification_number,
            phone: companyRow.phone,
            phoneSecondary: companyRow.phone_secondary,
            email: companyRow.email,
            postalAddress: companyRow.postal_address,
            addressLine1: companyRow.address_line1,
            addressLine2: companyRow.address_line2,
            city: companyRow.city,
            country: companyRow.country,
            currencyCode: companyRow.currency_code,
            locale: companyRow.locale,
            timezone: companyRow.timezone ?? COMPANY_DEFAULTS.timezone,
            receiptHeader: companyRow.receipt_header,
            receiptFooter: companyRow.receipt_footer,
            brandPrimaryColor: companyRow.brand_primary_color,
            logoPath: companyRow.logo_path,
          },

    rules:
      rulesRow === null || rulesRow === undefined
        ? null
        : {
            minLoanAmount: rulesRow.min_loan_amount,
            maxLoanAmount: rulesRow.max_loan_amount,
            multiMonthMinAmount: rulesRow.multi_month_min_amount,
            defaultMonthlyInterestRateBps: rulesRow.default_monthly_interest_rate_bps,
            defaultInterestMethod: rulesRow.default_interest_method,
            minLoanTermMonths: rulesRow.min_loan_term_months,
            maxLoanTermMonths: rulesRow.max_loan_term_months,
            gracePeriodDays: rulesRow.grace_period_days,
            penaltyRateBps: rulesRow.penalty_rate_bps,
            maxActiveLoansPerClient: rulesRow.max_active_loans_per_client,
            minGuarantorsRequired: rulesRow.min_guarantors_required,
            defaultRepaymentFrequency: rulesRow.default_repayment_frequency,
          },

    cadences: (cadenceResult.data ?? []).map((row) => ({
      key: row.key,
      label: row.label,
      intervalDays: row.interval_days,
      isActive: row.is_active,
    })),

    branches: (branchResult.data ?? []).map((row) => ({
      id: row.id,
      branchCode: row.branch_code,
      name: row.name,
      location: row.location,
      district: row.district,
      phone: row.phone,
      status: row.status,
      openedOn: row.opened_on,
    })),

    sequences: (sequenceResult.data ?? []).map((row) => ({
      scope: row.scope,
      periodYear: row.period_year,
      lastValue: row.last_value,
    })),

    unavailable,
  };
}
