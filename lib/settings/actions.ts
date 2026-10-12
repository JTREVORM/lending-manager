'use server';

/**
 * Changing the business's own settings.
 *
 * Three subjects, three actions: the company's identity, the lending rules
 * and the finance thresholds. Each does the same four things in order —
 * capability, rate limit, shape, then the database, which runs as the caller
 * so Row Level Security and every trigger apply whatever this module
 * believes.
 *
 * ## Why these are three actions and not one
 *
 * They are gated by two different capabilities (`settings:update` and
 * `finance:settings`), audited as two different subjects, and read by
 * different parts of the product. One action with a `section` parameter
 * would be one capability check somebody has to get right per branch.
 *
 * ## What the database decides, not this module
 *
 *   - Whether the new lending rules still contain every active loan product.
 *     `business_settings_keep_products_valid` refuses a change that would
 *     strand one, and names it. A check here would be against the products
 *     as they were a moment earlier.
 *   - Whether the figures are internally consistent. Every relationship —
 *     a maximum not below a minimum, a term range the right way round — is a
 *     CHECK on the table as well as a rule in the schema, so a write that
 *     somehow skipped validation still cannot land.
 *   - Who changed what. `audit_settings_change` records both settings rows,
 *     with the before and after values, from the session. Nothing here
 *     writes an audit record, which is why nothing here can forget to.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { parseSafely } from '@/lib/validation/validate';
import {
  companyIdentitySchema,
  financeSettingsSchema,
  lendingRulesSchema,
} from '@/lib/validation/settings';
import type { ActionResult } from '@/lib/auth/actions';
import type { Permission } from '@/lib/permissions';
import type { RateLimitedAction } from '@/lib/security/rate-limit';

export type SettingsActionResult = ActionResult;

const INVALID = 'Please check the highlighted fields.';

/** Every screen that renders something out of the settings rows. */
function revalidateSettings(): void {
  revalidatePath(ROUTES.settings);
  // The shell renders the company's name and mark on every page, and the
  // product screens show the lending rules a product has to sit inside.
  revalidatePath(ROUTES.loanProducts);
  revalidatePath(ROUTES.dashboard);
}

async function authorize(
  permission: Permission,
  bucket: RateLimitedAction,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let actor;
  try {
    actor = await requirePermission(permission);
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit(bucket, actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

export async function updateCompanyIdentityAction(
  _previous: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  const allowed = await authorize('settings:update', 'settings.update');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(companyIdentitySchema, {
    companyName: formData.get('companyName'),
    legalName: formData.get('legalName'),
    tagline: formData.get('tagline'),
    registrationNumber: formData.get('registrationNumber'),
    taxIdentificationNumber: formData.get('taxIdentificationNumber'),
    phone: formData.get('phone'),
    phoneSecondary: formData.get('phoneSecondary'),
    email: formData.get('email'),
    postalAddress: formData.get('postalAddress'),
    addressLine1: formData.get('addressLine1'),
    addressLine2: formData.get('addressLine2'),
    city: formData.get('city'),
    country: formData.get('country'),
    locale: formData.get('locale'),
    timezone: formData.get('timezone'),
    logoPath: formData.get('logoPath'),
    brandPrimaryColor: formData.get('brandPrimaryColor'),
    receiptHeader: formData.get('receiptHeader'),
    receiptFooter: formData.get('receiptFooter'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // `?? null` on every optional field: a form that posts an empty box means
  // "there is no second phone number", and writing `undefined` would leave
  // whatever was there before — which is the opposite of what the person
  // just did.
  const { error } = await supabase
    .from('company_settings')
    .update({
      company_name: input.companyName,
      legal_name: input.legalName ?? null,
      tagline: input.tagline ?? null,
      registration_number: input.registrationNumber ?? null,
      tax_identification_number: input.taxIdentificationNumber ?? null,
      phone: input.phone,
      phone_secondary: input.phoneSecondary,
      email: input.email ?? null,
      postal_address: input.postalAddress ?? null,
      address_line1: input.addressLine1 ?? null,
      address_line2: input.addressLine2 ?? null,
      city: input.city ?? null,
      country: input.country ?? null,
      locale: input.locale,
      timezone: input.timezone,
      logo_path: input.logoPath,
      brand_primary_color: input.brandPrimaryColor,
      receipt_header: input.receiptHeader ?? null,
      receipt_footer: input.receiptFooter ?? null,
    })
    .eq('id', 1);

  if (error !== null) {
    logger.warn('The company record could not be updated.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateSettings();

  return {
    ok: true,
    message:
      'Company details saved. They appear on the sign-in screen, in the header and on every receipt and statement from now on.',
  };
}

// ---------------------------------------------------------------------------
// The lending rules
// ---------------------------------------------------------------------------

export async function updateLendingRulesAction(
  _previous: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  const allowed = await authorize('settings:update', 'settings.update');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(lendingRulesSchema, {
    minLoanAmount: formData.get('minLoanAmount'),
    maxLoanAmount: formData.get('maxLoanAmount'),
    multiMonthMinAmount: formData.get('multiMonthMinAmount'),
    defaultMonthlyInterestRateBps: formData.get('defaultMonthlyInterestRate'),
    minLoanTermMonths: formData.get('minLoanTermMonths'),
    maxLoanTermMonths: formData.get('maxLoanTermMonths'),
    gracePeriodDays: formData.get('gracePeriodDays'),
    penaltyRateBps: formData.get('penaltyRate'),
    maxActiveLoansPerClient: formData.get('maxActiveLoansPerClient'),
    minGuarantorsRequired: formData.get('minGuarantorsRequired'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('business_settings')
    .update({
      min_loan_amount: input.minLoanAmount,
      max_loan_amount: input.maxLoanAmount,
      multi_month_min_amount: input.multiMonthMinAmount,
      default_monthly_interest_rate_bps: input.defaultMonthlyInterestRateBps,
      min_loan_term_months: input.minLoanTermMonths,
      max_loan_term_months: input.maxLoanTermMonths,
      grace_period_days: input.gracePeriodDays,
      penalty_rate_bps: input.penaltyRateBps,
      max_active_loans_per_client: input.maxActiveLoansPerClient,
      min_guarantors_required: input.minGuarantorsRequired,
    })
    .eq('id', 1);

  if (error !== null) {
    logger.warn('The lending rules could not be updated.', { code: error.code });
    // The refusal that matters here is the guard rail's, and it names the
    // product and what to do about it. It is passed through rather than
    // summarised.
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateSettings();

  return {
    ok: true,
    message:
      'Lending rules saved. They bound what a product may offer, and apply to loans approved from now on.',
  };
}

// ---------------------------------------------------------------------------
// The finance thresholds
// ---------------------------------------------------------------------------

export async function updateFinanceSettingsAction(
  _previous: SettingsActionResult | undefined,
  formData: FormData,
): Promise<SettingsActionResult> {
  // `finance:settings`, not `settings:update`: the capability already exists
  // for exactly this, and the two sets of settings are different jobs.
  const allowed = await authorize('finance:settings', 'settings.update');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(financeSettingsSchema, {
    transferApprovalThreshold: formData.get('transferApprovalThreshold'),
    expenseApprovalThreshold: formData.get('expenseApprovalThreshold'),
    allowNegativeCash: formData.get('allowNegativeCash'),
    reconciliationRequiresReview: formData.get('reconciliationRequiresReview'),
    lowBalanceCashAtHand: formData.get('lowBalanceCashAtHand'),
    lowBalanceMtn: formData.get('lowBalanceMtn'),
    lowBalanceAirtel: formData.get('lowBalanceAirtel'),
    lowBalanceBank: formData.get('lowBalanceBank'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('finance_settings')
    .update({
      transfer_approval_threshold: input.transferApprovalThreshold,
      expense_approval_threshold: input.expenseApprovalThreshold,
      allow_negative_cash: input.allowNegativeCash,
      reconciliation_requires_review: input.reconciliationRequiresReview,
      low_balance_cash_at_hand: input.lowBalanceCashAtHand,
      low_balance_mtn_mobile_money: input.lowBalanceMtn,
      low_balance_airtel_money: input.lowBalanceAirtel,
      low_balance_bank: input.lowBalanceBank,
    })
    .eq('id', 1);

  if (error !== null) {
    logger.warn('The finance settings could not be updated.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateSettings();
  revalidatePath(ROUTES.finance);

  return {
    ok: true,
    message:
      'Finance settings saved. The posting functions read these themselves, so they take effect on the next movement.',
  };
}
