'use server';

/**
 * Member-loan applications, as trusted server-side operations.
 *
 * ## Nothing here decides eligibility
 *
 * No function in this module counts a qualifying month, computes a ceiling or
 * prices a loan. The database does: `member_loan_eligibility_of` assesses, and
 * `validate_loan_for_approval` re-assesses from the loan's **own** figures at
 * the moment of approval. These actions pass identifiers and read results
 * back.
 *
 * That split is the whole point. An eligibility check performed here would be
 * stale the moment the form was submitted — another deposit, a withdrawal, a
 * suspension, a policy published — and a stale check that *passes* is the
 * expensive direction. So the check below is advisory, said in so many words,
 * and the control is the one at approval.
 *
 * ## Nothing here submits for approval either
 *
 * Creating a member-loan application leaves it a **draft**, exactly as
 * `createLoanAction` does. Submitting it is `submitLoanAction`, approving it
 * is `approveLoanAction`, disbursing it is `disburseLoanAction`, and
 * collecting it is the payment module — because a member loan is a loan, and a
 * second lifecycle would be a second set of controls to keep in step.
 *
 * ## Double submission
 *
 * Idempotent by state, as the rest of the lifecycle is: a second tap on
 * approval finds the loan already approved and is refused cleanly. The rate
 * limiter below is a brake on volume rather than the protection against a
 * double tap.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { memberLoanApplicationSchema } from '@/lib/validation/member-loan';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface MemberLoanActionResult extends ActionResult {
  readonly loanId?: string;
  /**
   * Why the application could not be opened, where the reason is a policy
   * decision rather than a mistake in the form.
   *
   * Separate from `message` so the interface can present it as a state of the
   * programme rather than as something the person entering the loan did wrong
   * — because it is not.
   */
  readonly blockingReasons?: readonly string[];
}

const FIELD_ERROR_MESSAGE = 'Please check the highlighted fields.';

/**
 * Open a member-loan application.
 *
 * Writes a draft against the member loan product. It does not name the
 * membership: `loans.membership_id` is written by `approve_loan` from the
 * client's live membership and frozen there, so an application cannot assert
 * whose savings it is lent against.
 *
 * The placeholder price columns are the same arrangement `createLoanAction`
 * uses and for the same reason: they are NOT NULL, a draft has to be savable,
 * and approval overwrites every one of them — here from the borrower's own
 * frozen policy version rather than from business settings.
 */
export async function createMemberLoanApplicationAction(
  _previous: MemberLoanActionResult | undefined,
  formData: FormData,
): Promise<MemberLoanActionResult> {
  let actor;
  try {
    actor = await requirePermission('member_loans:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('member_loan.create', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(memberLoanApplicationSchema, {
    clientId: formData.get('clientId'),
    amount: formData.get('amount'),
    termMonths: formData.get('termMonths'),
    repaymentFrequency: formData.get('repaymentFrequency'),
    proposedDisbursementDate: formData.get('proposedDisbursementDate'),
    purpose: formData.get('purpose'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // --- The product, read server-side ---------------------------------------
  // Never from the form. A caller who could name the product could open an
  // ordinary-loan application through this route and skip every member rule.
  const { data: product, error: productError } = await supabase
    .from('loan_products')
    .select('id, status, min_amount, max_amount, min_term_months, max_term_months')
    .eq('product_code', 'ML')
    .maybeSingle();

  if (productError !== null || product === null) {
    logger.error('The member loan product could not be read.', {
      code: productError?.code,
    });
    return {
      ok: false,
      message: 'The member loan product could not be read. Contact your administrator.',
    };
  }

  if (product.status !== 'active') {
    return {
      ok: false,
      message: 'Member lending is not open.',
      blockingReasons: [
        'The member loan product is not active. Its price depends on decisions the ' +
          'client has not made: whether the 5% is charged per month or once over the ' +
          'loan, whether it is flat or on a reducing balance, and what multiple of ' +
          'savings a member may borrow.',
      ],
    };
  }

  // --- Eligibility, advisory ------------------------------------------------
  // Said in so many words: this is so the person entering the application is
  // told now rather than at the approval counter. The control is
  // `validate_loan_for_approval`, which asks the same question again from the
  // loan's own figures at the moment the business decides — so a balance that
  // falls in between still refuses the approval.
  const { data: assessment, error: assessmentError } = await supabase.rpc(
    'assess_member_loan_eligibility',
    {
      p_client_id: input.clientId,
      p_amount: input.amount,
      p_term_months: input.termMonths,
      p_repayment_frequency: input.repaymentFrequency,
      p_as_of: null,
    },
  );

  if (assessmentError !== null) {
    logger.warn('A member loan eligibility assessment could not be read.', {
      code: assessmentError.code,
    });
    return { ok: false, message: mapDatabaseError(assessmentError).message };
  }

  const eligibility = (assessment ?? [])[0];

  if (eligibility === undefined) {
    return { ok: false, message: 'This client could not be assessed.' };
  }

  if (!eligibility.may_proceed) {
    return {
      ok: false,
      message: 'This member cannot take a loan on these terms.',
      blockingReasons: eligibility.blocking_reasons,
    };
  }

  // `loan_number` is absent: the trigger mints it and refuses a supplied
  // value. So is `status`, which defaults to draft — and the insert policy
  // would refuse anything else. So are `membership_id` and `interest_basis`,
  // which approval writes and the guard then freezes.
  const { data: created, error: insertError } = await supabase
    .from('loans')
    .insert({
      client_id: input.clientId,
      loan_product_id: product.id,
      principal_amount: input.amount,
      loan_term_months: input.termMonths,
      repayment_frequency: input.repaymentFrequency,
      proposed_disbursement_date: input.proposedDisbursementDate,
      notes: input.purpose,
      // Placeholders the approval overwrites from the member's own policy
      // version. Present because the columns are NOT NULL.
      interest_rate_bps: 0,
      interest_method: 'reducing_balance_monthly',
      min_loan_amount_applied: product.min_amount,
      max_loan_amount_applied: product.max_amount,
      grace_period_days_applied: 0,
      penalty_rate_bps_applied: 0,
    })
    .select('id')
    .single();

  if (insertError !== null || created === null) {
    logger.warn('A member loan application could not be opened.', {
      code: insertError?.code,
    });
    return { ok: false, message: mapDatabaseError(insertError, 'loan').message };
  }

  revalidatePath(ROUTES.memberLoans);
  revalidatePath(ROUTES.loans);
  revalidatePath(`${ROUTES.clients}/${input.clientId}`);

  return {
    ok: true,
    message: 'Member loan application opened as a draft.',
    loanId: created.id,
  };
}
