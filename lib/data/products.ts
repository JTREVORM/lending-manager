import 'server-only';

/**
 * Reading the loan products.
 *
 * Reads `loan_product_catalogue`, a `security_invoker` view, so Row Level
 * Security decides what comes back: `products:view` opens it, and a borrower
 * holds no such capability. The view also carries the two facts the table
 * cannot — which branches may sell a product, and how many loans have been
 * written against it — so a list screen needs one query rather than three.
 *
 * Nothing here caches. A product holds the rate the business lends at, and a
 * cached rate is the one thing a lending system must never show.
 */

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { LoanProduct, ProductStatus } from '@/lib/domain/loan-product';

const CATALOGUE_COLUMNS = `product_id, product_code, name, description, status, sort_order, is_default, min_amount, max_amount, default_interest_rate_bps, min_interest_rate_bps, max_interest_rate_bps, interest_method, interest_override_allowed, interest_override_roles, min_term_months, max_term_months, allowed_term_months, allowed_repayment_frequencies, default_repayment_frequency, grace_period_days, penalty_rate_bps, penalty_method, guarantor_required, min_guarantors, collateral_required, early_repayment, extra_payment, application_profile, requires_supporting_documents, branch_ids, loans_written, created_at, updated_at`;

interface CatalogueRow {
  readonly product_id: string;
  readonly product_code: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly sort_order: number;
  readonly is_default: boolean;
  readonly min_amount: number;
  readonly max_amount: number;
  readonly default_interest_rate_bps: number;
  readonly min_interest_rate_bps: number;
  readonly max_interest_rate_bps: number;
  readonly interest_method: string;
  readonly interest_override_allowed: boolean;
  readonly interest_override_roles: string[];
  readonly min_term_months: number;
  readonly max_term_months: number;
  readonly allowed_term_months: number[] | null;
  readonly allowed_repayment_frequencies: string[];
  readonly default_repayment_frequency: string;
  readonly grace_period_days: number;
  readonly penalty_rate_bps: number;
  readonly penalty_method: string;
  readonly guarantor_required: boolean;
  readonly min_guarantors: number;
  readonly collateral_required: boolean;
  readonly early_repayment: string;
  readonly extra_payment: string;
  readonly application_profile: string;
  readonly requires_supporting_documents: boolean;
  readonly branch_ids: string[] | null;
  readonly loans_written: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toProduct(row: CatalogueRow): LoanProduct {
  return {
    productId: row.product_id,
    productCode: row.product_code,
    name: row.name,
    description: row.description,
    status: row.status as ProductStatus,
    sortOrder: row.sort_order,
    isDefault: row.is_default,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    defaultInterestRateBps: row.default_interest_rate_bps,
    minInterestRateBps: row.min_interest_rate_bps,
    maxInterestRateBps: row.max_interest_rate_bps,
    interestMethod: row.interest_method,
    interestOverrideAllowed: row.interest_override_allowed,
    interestOverrideRoles: row.interest_override_roles,
    minTermMonths: row.min_term_months,
    maxTermMonths: row.max_term_months,
    allowedTermMonths: row.allowed_term_months,
    allowedRepaymentFrequencies: row.allowed_repayment_frequencies,
    defaultRepaymentFrequency: row.default_repayment_frequency,
    gracePeriodDays: row.grace_period_days,
    penaltyRateBps: row.penalty_rate_bps,
    penaltyMethod: row.penalty_method,
    guarantorRequired: row.guarantor_required,
    minGuarantors: row.min_guarantors,
    collateralRequired: row.collateral_required,
    earlyRepayment: row.early_repayment,
    extraPayment: row.extra_payment,
    applicationProfile: row.application_profile,
    requiresSupportingDocuments: row.requires_supporting_documents,
    branchIds: row.branch_ids,
    loansWritten: row.loans_written,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Every product the caller may see, in the order the business sells them.
 *
 * Withdrawn products are included and marked. A settings screen that hid them
 * would hide the one a report is grouping 33 loans under.
 */
export async function getLoanProducts(): Promise<readonly LoanProduct[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_product_catalogue')
    .select(CATALOGUE_COLUMNS)
    .order('status', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (error !== null) {
    logger.warn('The loan products could not be read.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => toProduct(row as CatalogueRow));
}

/** One product, or null when the caller may not see it or it does not exist. */
export async function getLoanProduct(productId: string): Promise<LoanProduct | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_product_catalogue')
    .select(CATALOGUE_COLUMNS)
    .eq('product_id', productId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('A loan product could not be read.', { code: error.code });
    return null;
  }

  return data === null ? null : toProduct(data);
}

export interface BranchOption {
  readonly id: string;
  readonly branchCode: string;
  readonly name: string;
}

/**
 * The branches a product can be assigned to.
 *
 * Needs `branches:view`; a caller without it gets an empty list and the form
 * says so rather than silently offering "every branch" as the only choice.
 */
export async function getBranchOptions(): Promise<readonly BranchOption[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('branches')
    .select('id, branch_code, name')
    .eq('status', 'active')
    .order('branch_code', { ascending: true });

  if (error !== null) {
    logger.warn('The branches could not be read.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    branchCode: row.branch_code,
    name: row.name,
  }));
}

export interface CadenceOption {
  readonly key: string;
  readonly label: string;
  readonly intervalDays: number;
}

/** The repayment cadences a product may offer. Only active ones are listed. */
export async function getCadenceOptions(): Promise<readonly CadenceOption[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('repayment_frequencies')
    .select('key, label, interval_days')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (error !== null) {
    logger.warn('The repayment cadences could not be read.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => ({
    key: row.key,
    label: row.label,
    intervalDays: row.interval_days,
  }));
}
