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
  readonly registrationNumber: string | null;
  readonly taxIdentificationNumber: string | null;
  readonly phone: string | null;
  readonly email: string | null;
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

export interface SettingsSnapshot {
  readonly company: CompanyProfile | null;
  readonly rules: LendingRules | null;
  readonly cadences: readonly RepaymentCadence[];
  /** Which reads failed, so the page can say so instead of showing nothing. */
  readonly unavailable: readonly string[];
}

export async function getSettingsSnapshot(): Promise<SettingsSnapshot> {
  const supabase = await createSupabaseServerClient();
  const unavailable: string[] = [];

  const [companyResult, rulesResult, cadenceResult] = await Promise.all([
    supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
    supabase.from('business_settings').select('*').eq('id', 1).maybeSingle(),
    supabase
      .from('repayment_frequencies')
      .select('key, label, interval_days, is_active')
      .order('sort_order', { ascending: true }),
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

  const companyRow = companyResult.data;
  const rulesRow = rulesResult.data;

  return {
    company:
      companyRow === null || companyRow === undefined
        ? null
        : {
            companyName: companyRow.company_name,
            legalName: companyRow.legal_name,
            registrationNumber: companyRow.registration_number,
            taxIdentificationNumber: companyRow.tax_identification_number,
            phone: companyRow.phone,
            email: companyRow.email,
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

    unavailable,
  };
}
