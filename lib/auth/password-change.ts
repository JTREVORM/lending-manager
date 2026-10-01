/**
 * The password-change workflow, as orchestration separated from its plumbing.
 *
 * ## Why this is its own module
 *
 * The security property that matters here is an **ordering** one: the forced
 * password-change flag may be cleared only after Supabase Auth has actually
 * accepted a new password, and only after the caller has proved they know the
 * current one. The database cannot check that — it has no visibility into
 * Supabase Auth — so it enforces the next best thing (only a trusted server
 * path may clear the flag at all, see migration 20261002000800) and leaves the
 * ordering to this function.
 *
 * Ordering enforced in application code is only as good as its tests. Keeping
 * the steps behind an injected interface means every path can be driven
 * directly — wrong current password, Supabase refusing the new one, the
 * confirmation failing — and the assertion "the flag was not cleared" is made
 * against a recorded call list rather than inferred.
 *
 * The real wiring lives in `lib/auth/actions.ts`. Nothing in here imports
 * Next.js or Supabase.
 */

import type { FieldErrors } from '@/lib/errors';
import { changePasswordSchema } from '@/lib/validation/auth';
import { parseSafely } from '@/lib/validation/validate';

export interface PasswordChangeInput {
  readonly currentPassword: unknown;
  readonly newPassword: unknown;
  readonly confirmPassword: unknown;
}

export interface PasswordChangeOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly fieldErrors?: FieldErrors;
  /**
   * The change succeeded but the security event could not be recorded.
   *
   * Surfaced rather than swallowed so the caller can log it. It deliberately
   * does not make the outcome a failure: the password really did change, and
   * reporting otherwise would send the user back to an old password that no
   * longer works.
   */
  readonly auditFailed?: boolean;
}

/**
 * The four effects a password change has, in the order they must happen.
 *
 * Each returns rather than throws, so a failure is a decision this function
 * makes rather than an exception that might skip past the ordering.
 */
export interface PasswordChangeSteps {
  /**
   * Prove the caller knows the current password, by re-authenticating with it.
   *
   * `updateUser` alone does not require the current password, so without this
   * anyone reaching an unlocked browser could take the account over
   * permanently.
   */
  verifyCurrentPassword(password: string): Promise<boolean>;

  /** Ask Supabase Auth to set the new password. */
  updatePassword(password: string): Promise<{ readonly ok: boolean }>;

  /**
   * Clear the forced-change flag and stamp `password_set_at`.
   *
   * Reaches `public.confirm_password_change`, which is callable only by
   * `service_role` — so this step is impossible from a browser however the
   * request is crafted.
   */
  confirmChange(): Promise<{ readonly ok: boolean }>;

  /** Record the security event. Never receives the password. */
  recordChange(): Promise<void>;
}

/**
 * Run a password change.
 *
 * Returns at the first failure, so a later step cannot run on the strength of
 * an earlier one having failed. In particular `confirmChange` is unreachable
 * unless `verifyCurrentPassword` returned true **and** `updatePassword`
 * succeeded.
 */
export async function performPasswordChange(
  input: PasswordChangeInput,
  steps: PasswordChangeSteps,
): Promise<PasswordChangeOutcome> {
  // 1 — Validate. A new password that fails the policy must never reach
  //     Supabase, and must certainly never reach the confirmation step.
  const parsed = parseSafely(changePasswordSchema, input);

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { currentPassword, newPassword } = parsed.data;

  // 2 — Prove they know the current password.
  if (!(await steps.verifyCurrentPassword(currentPassword))) {
    return {
      ok: false,
      message: 'Your current password is not correct.',
      fieldErrors: { currentPassword: ['That is not your current password.'] },
    };
  }

  // 3 — Change it. Until this succeeds, nothing has changed anywhere.
  const updated = await steps.updatePassword(newPassword);

  if (!updated.ok) {
    return {
      ok: false,
      // Supabase's own message can name its policy, which is useful, but it is
      // not echoed verbatim in case it carries anything else.
      message: 'That password was not accepted. Try a longer one.',
      fieldErrors: { newPassword: ['That password was not accepted.'] },
    };
  }

  // 4 — Only now may the requirement be cleared.
  const confirmed = await steps.confirmChange();

  if (!confirmed.ok) {
    // The password HAS changed; the flag has not cleared. Saying "that didn't
    // work" would be a lie that leaves the user signing in with a password the
    // interface told them was never set.
    return {
      ok: false,
      message:
        'Your password was changed, but the system could not record that you had done so. Please sign in with your new password and tell your administrator.',
    };
  }

  // 5 — Audit. A failure here must not fail the change, which has already
  //     happened. The real `recordChange` logs and swallows its own errors, so
  //     reaching this catch means a programming fault rather than an audit
  //     outage — and even then, a 500 after a successful change is the worst
  //     available outcome: it would tell the user their new password was never
  //     set. Reported through the outcome instead, for the caller to log.
  try {
    await steps.recordChange();
  } catch {
    return {
      ok: true,
      message: 'Your password has been changed.',
      auditFailed: true,
    };
  }

  return { ok: true, message: 'Your password has been changed.' };
}
