'use server';

/**
 * Authentication Server Actions: signing in, signing out, changing a password.
 *
 * None of these needs the privileged Supabase client. Signing in is done with
 * the publishable key, and changing a password uses the caller's own session —
 * which is correct, because Supabase then requires the session to be valid and
 * the operation is bounded to that one account.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { ROUTES } from '@/config/app';
import { getAuthContext } from '@/lib/auth/context';
import { landingPathFor } from '@/lib/auth/routing';
import { IdentityError, authEmailForIdentifier } from '@/lib/auth/identity';
import { safeNextPath } from '@/lib/auth/routing';
import { logger, maskPhone } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  changePasswordSchema,
  signInSchema,
  updateOwnDetailsSchema,
} from '@/lib/validation/auth';
import { parseSafely } from '@/lib/validation/validate';
import type { FieldErrors } from '@/lib/errors';

/** What a form gets back. Never carries a cause or a stack. */
export interface ActionResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly fieldErrors?: FieldErrors;
}

/**
 * The single message every failed sign-in returns, whatever went wrong.
 *
 * Distinguishing "no such number" from "wrong password" would let anyone with
 * the login page enumerate which phone numbers belong to the business's staff
 * and clients — a list worth having if you intend to target them. It would
 * also reveal, by elimination, who banks here.
 *
 * The cost is a slightly less helpful message for someone who mistyped their
 * number. That is the right trade for a financial system.
 */
const GENERIC_SIGN_IN_FAILURE =
  'Those login details are not correct. Please check and try again.';

/**
 * Sign in with a phone number and password.
 *
 * On success this **redirects** rather than returning, so the browser lands on
 * the role-appropriate page with the session cookie already set. The redirect
 * is thrown by Next.js, which is why it sits outside the try block.
 */
export async function signInAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseSafely(signInSchema, {
    identifier: formData.get('identifier'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please complete both fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { identifier, password } = parsed.data;

  let authEmail: string;
  try {
    authEmail = authEmailForIdentifier(identifier);
  } catch (error) {
    if (error instanceof IdentityError) {
      // A malformed number cannot match any account, so this is reported the
      // same way as a wrong password. Saying "that is not a valid number"
      // would confirm the format of identifiers that do exist.
      return { ok: false, message: GENERIC_SIGN_IN_FAILURE };
    }
    throw error;
  }

  const supabase = await createSupabaseServerClient();

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  });

  if (signInError !== null) {
    // Masked, so the log helps a support call without becoming a list of the
    // business's phone numbers if it is ever shipped off-site.
    logger.info('Sign-in failed.', {
      identifier: maskPhone(identifier),
      reason: signInError.code ?? 'unknown',
    });
    return { ok: false, message: GENERIC_SIGN_IN_FAILURE };
  }

  // Authentication succeeded. Authorization is a separate question: the
  // account may be suspended, unlinked, or hold no role. Leaving a user
  // authenticated-but-unauthorized is exactly the partially-authorized state
  // to avoid, so the session is torn down before returning.
  const result = await getAuthContext();

  if (!result.ok) {
    await supabase.auth.signOut();

    logger.warn('Sign-in refused after authentication.', {
      reason: result.reason,
      identifier: maskPhone(identifier),
    });

    // The reason is recorded for an administrator, not shown to the browser.
    await recordSecurityEvent('auth.sign_in_denied', { reason: result.reason });

    return {
      ok: false,
      message:
        result.reason === 'no_roles'
          ? 'Your account has not been given a role yet. Please contact your administrator.'
          : 'Your account is not active. Please contact your administrator.',
    };
  }

  await stampSignIn();
  await recordSecurityEvent('auth.signed_in');

  // Return them to where they were heading, if that was a real in-site path
  // and nothing more urgent is owed. A forced password change always wins:
  // until it is done, somebody other than the account holder knows the
  // password, so nothing else may be reached.
  //
  // Sanitised again here rather than trusting the hidden field, because it is
  // client-supplied input and this is the point at which it becomes a
  // redirect. If the destination turns out to be one this user may not open,
  // the route guard sends them on to a page they can.
  // `FormData.get` can return a File, whose stringification is useless. Only
  // a genuine string is considered.
  const rawNext = formData.get('next');
  const requested = safeNextPath(typeof rawNext === 'string' ? rawNext : null);
  const landing = landingPathFor(result.context);

  redirect(
    requested !== null && !result.context.mustChangePassword ? requested : landing,
  );
}

/**
 * Sign out.
 *
 * The audit record is written before the session is destroyed, because after
 * `signOut()` there is no session for the database to attribute the event to.
 */
export async function signOutAction(): Promise<never> {
  await recordSecurityEvent('auth.signed_out');

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  redirect(ROUTES.login);
}

/**
 * Change one's own password.
 *
 * The current password is verified by re-authenticating with it, because
 * `updateUser` alone does not require it — without this check, anyone who
 * reached an unlocked browser could change the password and take the account
 * over permanently.
 */
export async function changePasswordAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const result = await getAuthContext();

  if (!result.ok) {
    return { ok: false, message: 'Please sign in again.' };
  }

  const parsed = parseSafely(changePasswordSchema, {
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
    confirmPassword: formData.get('confirmPassword'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: authEmailForIdentifier(result.context.phone),
    password: parsed.data.currentPassword,
  });

  if (reauthError !== null) {
    return {
      ok: false,
      message: 'Your current password is not correct.',
      fieldErrors: { currentPassword: ['That is not your current password.'] },
    };
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });

  if (updateError !== null) {
    logger.warn('Password update refused by Supabase Auth.', {
      code: updateError.code ?? 'unknown',
    });
    return {
      ok: false,
      // Supabase's own message can name its password policy, which is useful,
      // but it is not echoed verbatim in case it carries anything else.
      message: 'That password was not accepted. Try a longer one.',
      fieldErrors: { newPassword: ['That password was not accepted.'] },
    };
  }

  // Only now, with Supabase having confirmed the change, is the forced-change
  // flag cleared. The function acts on the calling user's own row only.
  const { error: clearError } = await supabase.rpc('complete_password_change');

  if (clearError !== null) {
    logger.warn('Could not clear the password-change requirement.', {
      code: clearError.code,
    });
  }

  await recordSecurityEvent('auth.password_changed');

  return { ok: true, message: 'Your password has been changed.' };
}

/** Update one's own name and contact email. Never role or status. */
export async function updateOwnDetailsAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const result = await getAuthContext();

  if (!result.ok) {
    return { ok: false, message: 'Please sign in again.' };
  }

  const parsed = parseSafely(updateOwnDetailsSchema, {
    fullName: formData.get('fullName'),
    email: formData.get('email'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  // Written as the user, so Row Level Security and the column guard both
  // apply. Even if this action were called with a crafted payload, the
  // database would refuse anything beyond these two columns on this one row.
  const { error } = await supabase
    .from('profiles')
    .update({ full_name: parsed.data.fullName, email: parsed.data.email ?? null })
    .eq('id', result.context.profileId);

  if (error !== null) {
    logger.warn('Self-service profile update failed.', { code: error.code });
    return { ok: false, message: 'Your details could not be saved. Please try again.' };
  }

  return { ok: true, message: 'Your details have been saved.' };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Record a security event.
 *
 * Failures are logged and swallowed deliberately: a sign-in must not fail
 * because the audit insert did. The row-change audit triggers are the
 * guarantee-carrying path; these session events are supplementary, and the
 * database refuses any action name outside a closed vocabulary.
 */
async function recordSecurityEvent(
  action:
    | 'auth.signed_in'
    | 'auth.signed_out'
    | 'auth.password_changed'
    | 'auth.sign_in_denied',
  metadata?: Record<string, string>,
): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    const requestHeaders = await headers();

    const { error } = await supabase.rpc('record_security_event', {
      p_action: action,
      // No token, no password, no identifier — only the user agent, which an
      // administrator needs to recognise an unfamiliar device.
      p_metadata: {
        ...(metadata ?? {}),
        user_agent: requestHeaders.get('user-agent')?.slice(0, 200) ?? 'unknown',
      },
    });

    if (error !== null) {
      logger.warn('Could not record a security event.', { action, code: error.code });
    }
  } catch (error) {
    logger.warn('Could not record a security event.', { action, error });
  }
}

/** Stamp `last_sign_in_at`. Best-effort, for the same reason. */
async function stampSignIn(): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc('record_sign_in');
    if (error !== null) {
      logger.warn('Could not stamp the sign-in time.', { code: error.code });
    }
  } catch (error) {
    logger.warn('Could not stamp the sign-in time.', { error });
  }
}
