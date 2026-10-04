'use server';

/**
 * User administration.
 *
 * ## Where the privileged client is genuinely needed, and where it is not
 *
 * Creating an account needs the Supabase **Admin API**: there is no way to
 * provision an `auth.users` row on somebody else's behalf with the publishable
 * key, and a self-service sign-up flow would let anyone create an account. So
 * the three operations that touch Supabase Auth for another person — create,
 * reset password, and the auth-side of linking — use the privileged client.
 *
 * Everything else deliberately does not. Granting a role, revoking one and
 * changing a status all run as the **acting administrator**, through their own
 * session, so Row Level Security and the database triggers apply to them. That
 * is the important part: the escalation rules in migration 20261002000400 only
 * bite when the statement carries the actor's identity. Using the privileged
 * client for those would bypass precisely the protections that make them safe.
 *
 * ## Every action checks four things
 *
 * An authenticated session, an active account, the required capability, and
 * validated input — in that order, before touching anything. The database then
 * re-checks the parts it can, which is what makes a crafted request fail even
 * if it somehow reached past this layer.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { authEmailForPhone } from '@/lib/auth/identity';
import { mapDatabaseError } from '@/lib/db-errors';
import { AuthorizationError, toPublicError } from '@/lib/errors';
import { logger, maskPhone } from '@/lib/logger';
import { ROLES } from '@/lib/permissions';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  assignRoleSchema,
  createStaffUserSchema,
  resetUserPasswordSchema,
  revokeRoleSchema,
  setUserStatusSchema,
  updateUserDetailsSchema,
} from '@/lib/validation/auth';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';
import { checkActorRateLimit } from '@/lib/security/rate-limit';

/**
 * Create a staff account and its authentication identity.
 *
 * The order matters. The profile is written first, as the acting
 * administrator, so Row Level Security authorises the insert and the audit
 * trigger records who did it. Only then is the Supabase Auth user created and
 * linked. If the auth step fails, the profile is removed again — leaving a
 * profile that can never be signed into would be a confusing half-account, and
 * it is the one place in this system where deleting a row is correct, because
 * the row never represented a real account.
 */
export async function createStaffUserAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actorId: string;
  try {
    const actor = await requirePermission('users:create');
    actorId = actor.profileId;
  } catch (error) {
    return failure(error);
  }

  const limit = await checkActorRateLimit('users.create', actorId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(createStaffUserSchema, {
    fullName: formData.get('fullName'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    roleKey: formData.get('roleKey'),
    temporaryPassword: formData.get('temporaryPassword'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const { fullName, phone, email, roleKey, temporaryPassword } = parsed.data;

  const supabase = await createSupabaseServerClient();

  // Step 1 — the profile, as the administrator. The INSERT policy pins the
  // new row to a non-privileged shape: active or inactive, no auth link yet,
  // and already requiring a password change.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .insert({
      full_name: fullName,
      phone,
      email: email ?? null,
      status: 'active',
      must_change_password: true,
    })
    .select('id')
    .single();

  if (profileError !== null) {
    logger.info('Staff profile creation refused.', {
      code: profileError.code,
      phone: maskPhone(phone),
    });
    return {
      ok: false,
      message: mapDatabaseError(profileError, 'staff member').userMessage,
    };
  }

  // Step 2 — the role, still as the administrator, so the escalation guard
  // applies. An Owner may grant up to Owner; nobody may grant above their own
  // rank, and nobody may grant to themselves.
  const { error: roleError } = await supabase
    .from('user_roles')
    .insert({ profile_id: profile.id, role_key: roleKey });

  if (roleError !== null) {
    await rollbackProfile(profile.id, 'role assignment failed');
    logger.info('Role assignment during staff creation refused.', {
      code: roleError.code,
      roleKey,
    });
    return { ok: false, message: mapDatabaseError(roleError, 'role').userMessage };
  }

  // Step 3 — the authentication identity. Privileged, because provisioning an
  // account for somebody else has no unprivileged equivalent.
  const admin = createSupabaseAdminClient('create a staff authentication identity');
  const authEmail = authEmailForPhone(phone);

  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: authEmail,
    password: temporaryPassword,
    // No mail can reach an unroutable `.invalid` address, and the account is
    // being created by an administrator who has already verified the person.
    email_confirm: true,
  });

  if (authError !== null || created.user === null) {
    await rollbackProfile(profile.id, 'auth user creation failed');
    logger.warn('Supabase Auth user creation failed.', {
      code: authError?.code ?? 'unknown',
    });
    return {
      ok: false,
      message:
        'The login for this staff member could not be created. No account was saved.',
    };
  }

  // Step 4 — link them. Privileged, because `auth_user_id` is refused on every
  // session path by the column guard: being able to re-point it would let one
  // profile adopt another person's login.
  const { error: linkError } = await admin
    .from('profiles')
    .update({ auth_user_id: created.user.id })
    .eq('id', profile.id);

  if (linkError !== null) {
    await admin.auth.admin.deleteUser(created.user.id);
    await rollbackProfile(profile.id, 'auth link failed');
    logger.warn('Linking a staff profile to its auth user failed.', {
      code: linkError.code,
    });
    return { ok: false, message: 'The staff account could not be completed.' };
  }

  logger.info('Staff account created.', {
    actorId,
    roleKey,
    phone: maskPhone(phone),
  });

  revalidatePath(ROUTES.users);

  return {
    ok: true,
    message: `${fullName} can now sign in with their phone number and the temporary password. They will be asked to change it.`,
  };
}

/** Change another user's name and contact email. Never their role or status. */
export async function updateUserDetailsAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('users:update');
  } catch (error) {
    return failure(error);
  }

  const parsed = parseSafely(updateUserDetailsSchema, {
    profileId: formData.get('profileId'),
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

  const { error } = await supabase
    .from('profiles')
    .update({ full_name: parsed.data.fullName, email: parsed.data.email ?? null })
    .eq('id', parsed.data.profileId);

  if (error !== null) {
    return { ok: false, message: mapDatabaseError(error, 'staff member').userMessage };
  }

  revalidatePath(ROUTES.users);
  return { ok: true, message: 'Details saved.' };
}

/**
 * Activate, deactivate or suspend an account.
 *
 * Run as the administrator, so the column guard checks the capability and the
 * last-owner trigger refuses to deactivate the final Owner. Those checks are
 * the protection; this function's job is to carry the actor's identity to them.
 */
export async function setUserStatusAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actorId: string;
  try {
    const actor = await requirePermission('users:disable');
    actorId = actor.profileId;
  } catch (error) {
    return failure(error);
  }

  const parsed = parseSafely(setUserStatusSchema, {
    profileId: formData.get('profileId'),
    status: formData.get('status'),
  });

  if (!parsed.success) {
    return { ok: false, message: 'Choose a valid account status.' };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('profiles')
    .update({
      status: parsed.data.status,
      archived_at: null,
    })
    .eq('id', parsed.data.profileId);

  if (error !== null) {
    logger.info('Account status change refused.', { code: error.code, actorId });
    return { ok: false, message: mapDatabaseError(error, 'account').userMessage };
  }

  revalidatePath(ROUTES.users);

  return {
    ok: true,
    message:
      parsed.data.status === 'active'
        ? 'The account is active again.'
        : 'The account has been deactivated. Access stops immediately, including any session already open.',
  };
}

/** Grant a role. The database decides whether this administrator may. */
export async function assignRoleAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('users:assign_role');
  } catch (error) {
    return failure(error);
  }

  const parsed = parseSafely(assignRoleSchema, {
    profileId: formData.get('profileId'),
    roleKey: formData.get('roleKey'),
  });

  if (!parsed.success) {
    return { ok: false, message: 'Choose a valid role.' };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('user_roles')
    .insert({ profile_id: parsed.data.profileId, role_key: parsed.data.roleKey });

  if (error !== null) {
    return { ok: false, message: mapDatabaseError(error, 'role assignment').userMessage };
  }

  revalidatePath(ROUTES.users);
  return {
    ok: true,
    message: `Granted the ${ROLES[parsed.data.roleKey]?.label ?? parsed.data.roleKey} role.`,
  };
}

/** Revoke a role. Refused by the database if it would remove the last Owner. */
export async function revokeRoleAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('users:assign_role');
  } catch (error) {
    return failure(error);
  }

  const parsed = parseSafely(revokeRoleSchema, {
    profileId: formData.get('profileId'),
    roleKey: formData.get('roleKey'),
  });

  if (!parsed.success) {
    return { ok: false, message: 'Choose a valid role.' };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('user_roles')
    .delete()
    .eq('profile_id', parsed.data.profileId)
    .eq('role_key', parsed.data.roleKey);

  if (error !== null) {
    return { ok: false, message: mapDatabaseError(error, 'role assignment').userMessage };
  }

  revalidatePath(ROUTES.users);
  return { ok: true, message: 'Role revoked.' };
}

/**
 * Issue a temporary password for another user.
 *
 * Needs the privileged client, because setting somebody else's password has no
 * unprivileged equivalent. The flag forcing a change is set first, as the
 * administrator, so the database records who ordered the reset.
 *
 * The password itself is never logged, never returned in the audit metadata,
 * and never persisted anywhere. It is shown once to the administrator, who
 * passes it to the staff member in person — see docs/AUTHENTICATION.md.
 */
export async function resetUserPasswordAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let actorId: string;
  try {
    const actor = await requirePermission('users:reset_password');
    actorId = actor.profileId;
  } catch (error) {
    return failure(error);
  }

  const limit = await checkActorRateLimit('users.reset-password', actorId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(resetUserPasswordSchema, {
    profileId: formData.get('profileId'),
    temporaryPassword: formData.get('temporaryPassword'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data: target, error: readError } = await supabase
    .from('profiles')
    .select('id, auth_user_id, full_name')
    .eq('id', parsed.data.profileId)
    .maybeSingle();

  if (readError !== null || target === null) {
    return { ok: false, message: 'That staff member could not be found.' };
  }

  if (target.auth_user_id === null) {
    return {
      ok: false,
      message: 'That account has no login to reset.',
    };
  }

  // As the administrator, so the audit trigger attributes the reset correctly
  // and the column guard confirms the capability.
  const { error: flagError } = await supabase
    .from('profiles')
    // `password_set_at` is deliberately not supplied: the database stamps it
    // from its own clock when the flag is raised, so it cannot be backdated
    // and cannot drift from the application server's clock.
    .update({ must_change_password: true })
    .eq('id', target.id);

  if (flagError !== null) {
    return { ok: false, message: mapDatabaseError(flagError, 'account').userMessage };
  }

  const admin = createSupabaseAdminClient('reset a staff password');

  const { error: authError } = await admin.auth.admin.updateUserById(
    target.auth_user_id,
    {
      password: parsed.data.temporaryPassword,
    },
  );

  if (authError !== null) {
    logger.warn('Password reset refused by Supabase Auth.', {
      code: authError.code ?? 'unknown',
      actorId,
    });
    return { ok: false, message: 'That password was not accepted. Try a longer one.' };
  }

  logger.info('Administrator reset a password.', { actorId, targetId: target.id });

  revalidatePath(ROUTES.users);

  return {
    ok: true,
    message: `${target.full_name} must now sign in with the temporary password and choose a new one. Give it to them in person — it is not shown again.`,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Remove a profile created moments ago whose account could not be completed.
 *
 * The one sanctioned delete in this system. ADR-006 forbids deleting business
 * records; a profile that never acquired a login is not one — it represents no
 * person, no history and no money, and leaving it would show an administrator
 * a staff member who can never sign in.
 */
async function rollbackProfile(profileId: string, reason: string): Promise<void> {
  try {
    const admin = createSupabaseAdminClient('roll back an incomplete staff account');
    const { error } = await admin.from('profiles').delete().eq('id', profileId);

    if (error !== null) {
      logger.error('Could not roll back an incomplete staff profile.', {
        profileId,
        reason,
        code: error.code,
      });
    }
  } catch (error) {
    logger.error('Could not roll back an incomplete staff profile.', {
      profileId,
      reason,
      error,
    });
  }
}

/** Turn a thrown authorization failure into a form result, leaking nothing. */
function failure(error: unknown): ActionResult {
  const publicError = toPublicError(error);

  if (!(error instanceof AuthorizationError)) {
    logger.warn('User administration action failed.', { error });
  }

  return { ok: false, message: publicError.message };
}
