'use server';

/**
 * Creating and changing a loan product.
 *
 * Each action does the same four things in order: confirm a session and its
 * capability, rate-limit the actor, validate the shape of the input, and hand
 * the row to the database — which runs as the caller, so Row Level Security,
 * the guard-rail trigger and the actor stamp all apply whatever this module
 * believes.
 *
 * ## What is deliberately not here
 *
 *   - **No check against `business_settings`.** The guard rail is a trigger
 *     (`loan_products_within_business_rules`), evaluated inside the
 *     transaction against the row as it is then. A check here would be
 *     against a row read a moment earlier, and a caller that could decide
 *     could opt out.
 *   - **No DELETE.** A product with loans written against it is referenced by
 *     every one of their snapshots; retiring is a status change. The
 *     privilege is not granted, so this is not a decision the UI makes.
 *   - **No actor columns.** `created_by` and `updated_by` are stamped from
 *     the session by `loan_products_stamp_actor`, and `product_code` cannot
 *     be changed at all — it appears on every snapshot and export.
 *   - **Nothing that touches an existing loan.** Repricing a product does not
 *     reprice an agreement: the terms were snapshotted at approval and
 *     nothing rewrites them. That is the whole point of the snapshot, and it
 *     is why this module can be as simple as it is.
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
  createLoanProductSchema,
  productDefaultSchema,
  productStatusSchema,
  updateLoanProductSchema,
} from '@/lib/validation/loan-product';
import type { ActionResult } from '@/lib/auth/actions';
import type { Permission } from '@/lib/permissions';
import type { RateLimitedAction } from '@/lib/security/rate-limit';

export interface ProductActionResult extends ActionResult {
  /** The product the action created or changed, for a redirect. */
  readonly productId?: string;
}

const INVALID = 'Please check the highlighted fields.';

function revalidateProducts(): void {
  revalidatePath(ROUTES.settings);
  revalidatePath(ROUTES.loanProducts);
  // A product's terms are what a new application starts from, so the loan
  // screens are showing figures this action changed.
  revalidatePath(ROUTES.loans);
}

/** Capability, then rate limit. The same preamble the finance actions use. */
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

/** The product's own columns, as the table takes them. */
function toRow(input: {
  readonly name: string;
  readonly description?: string | null;
  readonly status: string;
  readonly sortOrder: number;
  readonly isDefault: boolean;
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly defaultInterestRateBps: number;
  readonly minInterestRateBps: number;
  readonly maxInterestRateBps: number;
  readonly interestMethod: string;
  readonly interestOverrideAllowed: boolean;
  readonly interestOverrideRoles: readonly string[];
  readonly minTermMonths: number;
  readonly maxTermMonths: number;
  readonly allowedTermMonths: readonly number[] | null;
  readonly allowedRepaymentFrequencies: readonly string[];
  readonly defaultRepaymentFrequency: string;
  readonly gracePeriodDays: number;
  readonly penaltyRateBps: number;
  readonly penaltyMethod: string;
  readonly guarantorRequired: boolean;
  readonly minGuarantors: number;
  readonly collateralRequired: boolean;
  readonly earlyRepayment: string;
  readonly extraPayment: string;
  readonly applicationProfile: string;
  readonly requiresSupportingDocuments: boolean;
}) {
  return {
    name: input.name,
    description: input.description ?? null,
    status: input.status,
    sort_order: input.sortOrder,
    is_default: input.isDefault,
    min_amount: input.minAmount,
    max_amount: input.maxAmount,
    default_interest_rate_bps: input.defaultInterestRateBps,
    min_interest_rate_bps: input.minInterestRateBps,
    max_interest_rate_bps: input.maxInterestRateBps,
    interest_method: input.interestMethod,
    interest_override_allowed: input.interestOverrideAllowed,
    interest_override_roles: [...input.interestOverrideRoles],
    min_term_months: input.minTermMonths,
    max_term_months: input.maxTermMonths,
    allowed_term_months:
      input.allowedTermMonths === null ? null : [...input.allowedTermMonths],
    allowed_repayment_frequencies: [...input.allowedRepaymentFrequencies],
    default_repayment_frequency: input.defaultRepaymentFrequency,
    grace_period_days: input.gracePeriodDays,
    penalty_rate_bps: input.penaltyRateBps,
    penalty_method: input.penaltyMethod,
    guarantor_required: input.guarantorRequired,
    min_guarantors: input.minGuarantors,
    collateral_required: input.collateralRequired,
    early_repayment: input.earlyRepayment,
    extra_payment: input.extraPayment,
    application_profile: input.applicationProfile,
    requires_supporting_documents: input.requiresSupportingDocuments,
  };
}

/** Everything a form sends about a product, read out of the FormData. */
function readFields(formData: FormData) {
  return {
    name: formData.get('name'),
    description: formData.get('description'),
    status: formData.get('status'),
    sortOrder: formData.get('sortOrder'),
    isDefault: formData.get('isDefault'),
    minAmount: formData.get('minAmount'),
    maxAmount: formData.get('maxAmount'),
    defaultInterestRateBps: formData.get('defaultInterestRate'),
    minInterestRateBps: formData.get('minInterestRate'),
    maxInterestRateBps: formData.get('maxInterestRate'),
    interestMethod: formData.get('interestMethod'),
    interestOverrideAllowed: formData.get('interestOverrideAllowed'),
    interestOverrideRoles: formData.getAll('interestOverrideRoles').map(String),
    minTermMonths: formData.get('minTermMonths'),
    maxTermMonths: formData.get('maxTermMonths'),
    allowedTermMonths: formData.get('allowedTermMonths'),
    allowedRepaymentFrequencies: formData
      .getAll('allowedRepaymentFrequencies')
      .map(String),
    defaultRepaymentFrequency: formData.get('defaultRepaymentFrequency'),
    gracePeriodDays: formData.get('gracePeriodDays'),
    penaltyRateBps: formData.get('penaltyRate'),
    penaltyMethod: formData.get('penaltyMethod'),
    guarantorRequired: formData.get('guarantorRequired'),
    minGuarantors: formData.get('minGuarantors'),
    collateralRequired: formData.get('collateralRequired'),
    earlyRepayment: formData.get('earlyRepayment'),
    extraPayment: formData.get('extraPayment'),
    applicationProfile: formData.get('applicationProfile'),
    requiresSupportingDocuments: formData.get('requiresSupportingDocuments'),
    branchIds: formData.getAll('branchIds').map(String),
  };
}

/**
 * Where a product is sold, rewritten to match what was submitted.
 *
 * Delete-then-insert rather than a diff: the set is at most a handful of
 * rows, the primary key makes a repeat insert fail, and a diff would be more
 * code to get subtly wrong for no gain. An empty set means every branch, so
 * clearing the list is a legitimate instruction rather than a no-op.
 *
 * A failure here is reported as a failure of the whole save even though the
 * product itself is already written, because telling somebody their product
 * saved when its availability did not would be worse than telling them to
 * check it.
 */
async function replaceBranches(
  productId: string,
  branchIds: readonly string[],
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  const removal = await supabase
    .from('loan_product_branches')
    .delete()
    .eq('product_id', productId);

  if (removal.error !== null) {
    logger.warn("A product's branches could not be cleared.", {
      code: removal.error.code,
    });
    return mapDatabaseError(removal.error).message;
  }

  if (branchIds.length === 0) return null;

  const insertion = await supabase
    .from('loan_product_branches')
    .insert(
      branchIds.map((branchId) => ({ product_id: productId, branch_id: branchId })),
    );

  if (insertion.error !== null) {
    logger.warn("A product's branches could not be written.", {
      code: insertion.error.code,
    });
    return mapDatabaseError(insertion.error).message;
  }

  return null;
}

/**
 * Clear whichever product is currently the default.
 *
 * `loan_products_one_default` is a unique index on a constant expression, so
 * two defaults cannot exist even for an instant inside a statement — which
 * means the old one has to be cleared before the new one is set, and in that
 * order. There is a window of one statement in which no product is the
 * default; `loans_stamp_product` raises a clear refusal if a loan is created
 * inside it, which is far better than two products both claiming to be the
 * one a loan gets.
 */
async function clearDefaultExcept(productId: string | null): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('loan_products')
    .update({ is_default: false })
    .eq('is_default', true);

  if (productId !== null) query = query.neq('id', productId);

  const { error } = await query;

  if (error !== null) {
    logger.warn('The existing default product could not be cleared.', {
      code: error.code,
    });
    return mapDatabaseError(error).message;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createLoanProductAction(
  _previous: ProductActionResult | undefined,
  formData: FormData,
): Promise<ProductActionResult> {
  const allowed = await authorize('products:manage', 'settings.product');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(createLoanProductSchema, {
    productCode: formData.get('productCode'),
    ...readFields(formData),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;

  if (input.isDefault) {
    const cleared = await clearDefaultExcept(null);
    if (cleared !== null) return { ok: false, message: cleared };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('loan_products')
    .insert({ product_code: input.productCode, ...toRow(input) })
    .select('id')
    .single();

  if (error !== null) {
    logger.warn('A loan product could not be created.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  const branchFailure = await replaceBranches(data.id, input.branchIds);
  if (branchFailure !== null) return { ok: false, message: branchFailure };

  revalidateProducts();

  return {
    ok: true,
    message: `${input.name} created. It applies to loans approved from now on; nothing already agreed changes.`,
    productId: data.id,
  };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export async function updateLoanProductAction(
  _previous: ProductActionResult | undefined,
  formData: FormData,
): Promise<ProductActionResult> {
  const allowed = await authorize('products:manage', 'settings.product');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(updateLoanProductSchema, {
    productId: formData.get('productId'),
    ...readFields(formData),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const input = parsed.data;

  if (input.isDefault) {
    const cleared = await clearDefaultExcept(input.productId);
    if (cleared !== null) return { ok: false, message: cleared };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('loan_products')
    .update(toRow(input))
    .eq('id', input.productId);

  if (error !== null) {
    logger.warn('A loan product could not be updated.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  const branchFailure = await replaceBranches(input.productId, input.branchIds);
  if (branchFailure !== null) return { ok: false, message: branchFailure };

  revalidateProducts();

  return {
    ok: true,
    message: `${input.name} updated. Loans already approved keep the terms they were agreed under.`,
    productId: input.productId,
  };
}

// ---------------------------------------------------------------------------
// Retire and re-offer
// ---------------------------------------------------------------------------

export async function setLoanProductStatusAction(
  _previous: ProductActionResult | undefined,
  formData: FormData,
): Promise<ProductActionResult> {
  const allowed = await authorize('products:manage', 'settings.product');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(productStatusSchema, {
    productId: formData.get('productId'),
    status: formData.get('status'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const { productId, status } = parsed.data;
  const supabase = await createSupabaseServerClient();

  // Withdrawing the default product also clears the flag, because a CHECK
  // refuses an inactive default — and refusing the withdrawal instead would
  // mean the business cannot retire a product without first nominating its
  // replacement in a separate step it was given no prompt to take.
  const update = status === 'inactive' ? { status, is_default: false } : { status };

  const { error } = await supabase
    .from('loan_products')
    .update(update)
    .eq('id', productId);

  if (error !== null) {
    logger.warn("A loan product's status could not be changed.", { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateProducts();

  return {
    ok: true,
    message:
      status === 'active'
        ? 'Product offered again. It can be chosen for a new application.'
        : 'Product withdrawn. Existing loans are untouched; it cannot be chosen for a new application.',
    productId,
  };
}

// ---------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------

export async function setDefaultLoanProductAction(
  _previous: ProductActionResult | undefined,
  formData: FormData,
): Promise<ProductActionResult> {
  const allowed = await authorize('products:manage', 'settings.product');
  if (!allowed.ok) return { ok: false, message: allowed.message };

  const parsed = parseSafely(productDefaultSchema, {
    productId: formData.get('productId'),
  });

  if (!parsed.success) {
    return { ok: false, message: INVALID, fieldErrors: parsed.error.fieldErrors };
  }

  const { productId } = parsed.data;

  const cleared = await clearDefaultExcept(productId);
  if (cleared !== null) return { ok: false, message: cleared };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('loan_products')
    .update({ is_default: true })
    .eq('id', productId);

  if (error !== null) {
    logger.warn('The default loan product could not be set.', { code: error.code });
    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateProducts();

  return {
    ok: true,
    message: 'Default product set. A new loan that names no product will use it.',
    productId,
  };
}
