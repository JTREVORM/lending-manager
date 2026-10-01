import 'server-only';

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type {
  ClientOption,
  FrequencyOption,
  LoanFormSettings,
} from '@/components/loans/loan-form';

/**
 * Everything the loan form needs, read authoritatively server-side.
 *
 * One function rather than three calls from the page, so the loan screens
 * cannot diverge on which settings they believe. The settings in particular
 * decide the minimum amount and which periods are available — a form told its
 * own rules by the browser would be no check at all.
 */
export interface LoanFormData {
  readonly clients: readonly ClientOption[];
  readonly frequencies: readonly FrequencyOption[];
  readonly settings: LoanFormSettings;
}

/**
 * Sensible fallbacks if settings cannot be read.
 *
 * Deliberately conservative: the minimum is high rather than zero, and only a
 * single month is offered. If the settings row is unreachable the right
 * failure is a form that refuses plausible loans, not one that accepts
 * anything. The page shows a warning, and the database would refuse the
 * approval regardless.
 */
const FALLBACK_SETTINGS: LoanFormSettings = {
  defaultMonthlyInterestRateBps: 1_500,
  minLoanAmount: 100_000,
  maxLoanAmount: null,
  minLoanTermMonths: 1,
  maxLoanTermMonths: 1,
  multiMonthMinAmount: Number.MAX_SAFE_INTEGER,
  defaultRepaymentFrequency: 'daily',
};

export async function loadLoanFormData(): Promise<LoanFormData> {
  const supabase = await createSupabaseServerClient();

  const [settingsResult, frequenciesResult, clientsResult, activeLoansResult] =
    await Promise.all([
      supabase
        .from('business_settings')
        .select(
          'default_monthly_interest_rate_bps, min_loan_amount, max_loan_amount, min_loan_term_months, max_loan_term_months, multi_month_min_amount, default_repayment_frequency',
        )
        .eq('id', 1)
        .maybeSingle(),
      supabase
        .from('repayment_frequencies')
        .select('key, label')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      // Only active clients: Phase 3's `canBorrow` rule, applied as a filter
      // so an ineligible client is not offered at all.
      supabase
        .from('clients')
        .select('id, full_name, client_number')
        .eq('status', 'active')
        .order('full_name', { ascending: true })
        .limit(500),
      supabase.from('loans').select('client_id').eq('status', 'active'),
    ]);

  if (settingsResult.error !== null) {
    logger.error('Lending settings could not be read for the loan form.', {
      code: settingsResult.error.code,
    });
  }

  const row = settingsResult.data;

  const settings: LoanFormSettings =
    row === null || row === undefined
      ? FALLBACK_SETTINGS
      : {
          defaultMonthlyInterestRateBps: row.default_monthly_interest_rate_bps,
          minLoanAmount: row.min_loan_amount,
          maxLoanAmount: row.max_loan_amount,
          minLoanTermMonths: row.min_loan_term_months,
          maxLoanTermMonths: row.max_loan_term_months,
          multiMonthMinAmount: row.multi_month_min_amount,
          defaultRepaymentFrequency: row.default_repayment_frequency,
        };

  const withActiveLoan = new Set(
    (activeLoansResult.data ?? []).map((loan) => loan.client_id),
  );

  return {
    settings,
    frequencies: (frequenciesResult.data ?? []).map((frequency) => ({
      key: frequency.key,
      label: frequency.label,
    })),
    clients: (clientsResult.data ?? []).map((client) => ({
      id: client.id,
      label: `${client.full_name} (${client.client_number})`,
      // Flagged rather than filtered out, so a staff member looking for
      // somebody is told why they cannot be chosen instead of finding them
      // mysteriously absent.
      hasActiveLoan: withActiveLoan.has(client.id),
    })),
  };
}
