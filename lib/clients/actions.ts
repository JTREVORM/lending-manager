'use server';

/**
 * Client management, as trusted server-side operations.
 *
 * Every function here performs the five checks the specification asks for, in
 * this order:
 *
 *   1. a session exists  —  `requirePermission` resolves it
 *   2. the account is active  —  `current_profile_id()` only resolves active
 *      profiles, so an inactive account resolves to no identity at all
 *   3. the capability is held  —  `requirePermission`
 *   4. the input validates  —  a Zod schema, against raw `FormData`
 *   5. the target is authorised  —  the write runs **as the caller**, so Row
 *      Level Security and the column guards decide, per row and per column
 *
 * Step 5 is the one worth dwelling on. None of these actions uses the
 * privileged client, with exactly one exception — linking a portal login,
 * which calls a `service_role`-only database function. Everything else goes
 * through the caller's own session, so if the capability check at step 3 were
 * somehow wrong, the database would still refuse. The checks here exist to
 * give a decent error message, not to be the boundary.
 *
 * ## Allowlists, not object spreading
 *
 * Each update names its columns literally. Nothing spreads a parsed payload
 * into `.update()`, because a schema that gains a field would then silently
 * gain the ability to write a column. The column guards in the database would
 * catch the privileged ones, but the general principle is cheaper than relying
 * on that.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { uploadDocument } from '@/lib/storage/documents';
import {
  changeClientStatusSchema,
  createClientSchema,
  createRemarkSchema,
  linkClientProfileSchema,
  retractRemarkSchema,
  updateClientIdentitySchema,
  updateClientSchema,
} from '@/lib/validation/client';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

/** A created client's id, so the caller can be sent to its page. */
export interface ClientActionResult extends ActionResult {
  readonly clientId?: string;
}

/**
 * Register a client.
 *
 * The order of operations is chosen so that no failure leaves a half-record:
 *
 *   1. the client row, which mints the client number atomically
 *   2. the identity row, if a NIN was given
 *   3. the photograph and identity document, if files were given
 *
 * Steps 2 and 3 can fail without invalidating step 1 — a client with no NIN
 * recorded yet is a normal state, and so is one whose photograph did not
 * upload. So a failure there is **reported but not rolled back**, and the
 * caller lands on the client's page with a message saying what still needs
 * doing. The alternative — deleting the client because a photograph failed —
 * would discard a client number that has already been issued, and would be a
 * worse outcome than a missing photograph.
 */
export async function createClientAction(
  _previous: ClientActionResult | undefined,
  formData: FormData,
): Promise<ClientActionResult> {
  try {
    await requirePermission('clients:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(createClientSchema, {
    fullName: formData.get('fullName'),
    sex: formData.get('sex'),
    dateOfBirth: formData.get('dateOfBirth'),
    phone: formData.get('phone'),
    alternativePhone: formData.get('alternativePhone'),
    occupation: formData.get('occupation'),
    businessType: formData.get('businessType'),
    villageArea: formData.get('villageArea'),
    district: formData.get('district'),
    nin: formData.get('nin'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // --- 1. The client row -------------------------------------------------
  // `client_number` is absent: the trigger mints it and refuses a supplied
  // value. `status` is absent: it defaults to active, and the insert policy
  // would refuse a restricted one anyway.
  const { data: created, error: insertError } = await supabase
    .from('clients')
    .insert({
      full_name: input.fullName,
      sex: input.sex,
      date_of_birth: input.dateOfBirth,
      phone: input.phone,
      alternative_phone: input.alternativePhone,
      occupation: input.occupation,
      business_type: input.businessType,
      village_area: input.villageArea,
      district: input.district,
      notes: input.notes,
    })
    .select('id, client_number')
    .single();

  if (insertError !== null) {
    logger.warn('Could not register a client.', { code: insertError.code });
    return { ok: false, message: friendlyClientError(insertError) };
  }

  const clientId = created.id;
  const warnings: string[] = [];

  // --- 2. The identity row -----------------------------------------------
  if (input.nin !== null) {
    const { error: identityError } = await supabase
      .from('client_identities')
      .insert({ client_id: clientId, nin: input.nin });

    if (identityError !== null) {
      logger.warn('Could not record a client identity number.', {
        code: identityError.code,
      });
      warnings.push(
        identityError.code === '23505'
          ? 'That National Identification Number is already recorded against another client, so it was not saved.'
          : 'The National Identification Number could not be saved. Add it from the client page.',
      );
    }
  }

  // --- 3. The documents ---------------------------------------------------
  const photo = formData.get('photo');

  if (photo instanceof File && photo.size > 0) {
    const outcome = await uploadDocument('clients', clientId, 'photo', photo);

    if (outcome.ok && outcome.path !== undefined) {
      const { error } = await supabase
        .from('clients')
        .update({ photo_path: outcome.path })
        .eq('id', clientId);

      if (error !== null) {
        warnings.push('The photograph was uploaded but could not be attached.');
      }
    } else {
      warnings.push(outcome.message ?? 'The photograph could not be uploaded.');
    }
  }

  const document = formData.get('idDocument');

  if (document instanceof File && document.size > 0) {
    const outcome = await uploadDocument('clients', clientId, 'id', document);

    if (outcome.ok && outcome.path !== undefined) {
      // Upsert, because the identity row may not exist yet when no NIN was
      // given — the document and the number are recorded independently.
      const { error } = await supabase
        .from('client_identities')
        .upsert(
          { client_id: clientId, id_document_path: outcome.path },
          { onConflict: 'client_id' },
        );

      if (error !== null) {
        warnings.push('The identity document was uploaded but could not be attached.');
      }
    } else {
      warnings.push(outcome.message ?? 'The identity document could not be uploaded.');
    }
  }

  revalidatePath(ROUTES.clients);

  // A warning does not make this a failure: the client exists and holds a
  // number. The message says what is still outstanding.
  return {
    ok: true,
    clientId,
    message:
      warnings.length === 0
        ? `${input.fullName} is registered as ${created.client_number}.`
        : `${input.fullName} is registered as ${created.client_number}, but: ${warnings.join(' ')}`,
  };
}

/** Change a client's ordinary details. */
export async function updateClientAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('clients:update');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(updateClientSchema, {
    clientId: formData.get('clientId'),
    fullName: formData.get('fullName'),
    sex: formData.get('sex'),
    dateOfBirth: formData.get('dateOfBirth'),
    phone: formData.get('phone'),
    alternativePhone: formData.get('alternativePhone'),
    occupation: formData.get('occupation'),
    businessType: formData.get('businessType'),
    villageArea: formData.get('villageArea'),
    district: formData.get('district'),
    notes: formData.get('notes'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  // An explicit column list. Note the absence of `client_number`, `status`,
  // `profile_id` and `photo_path` — each has its own operation and capability,
  // and the database guard would refuse them here regardless.
  const { error } = await supabase
    .from('clients')
    .update({
      full_name: input.fullName,
      sex: input.sex,
      date_of_birth: input.dateOfBirth,
      phone: input.phone,
      alternative_phone: input.alternativePhone,
      occupation: input.occupation,
      business_type: input.businessType,
      village_area: input.villageArea,
      district: input.district,
      notes: input.notes,
    })
    .eq('id', input.clientId);

  if (error !== null) {
    logger.warn('Could not update a client.', { code: error.code });
    return { ok: false, message: friendlyClientError(error) };
  }

  revalidatePath(`${ROUTES.clients}/${input.clientId}`);
  revalidatePath(ROUTES.clients);

  return { ok: true, message: 'The client record has been updated.' };
}

/** Correct a client's National Identification Number. Requires reading it. */
export async function updateClientIdentityAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    // Both: writing an identity number without being able to read it would be
    // a blind overwrite of evidence.
    await requirePermission('clients:view_nin');
    await requirePermission('clients:update');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(updateClientIdentitySchema, {
    clientId: formData.get('clientId'),
    nin: formData.get('nin'),
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
    .from('client_identities')
    .upsert(
      { client_id: parsed.data.clientId, nin: parsed.data.nin },
      { onConflict: 'client_id' },
    );

  if (error !== null) {
    logger.warn('Could not update a client identity.', { code: error.code });
    return {
      ok: false,
      message:
        error.code === '23505'
          ? 'That National Identification Number is already recorded against another client.'
          : friendlyClientError(error),
    };
  }

  revalidatePath(`${ROUTES.clients}/${parsed.data.clientId}`);

  return { ok: true, message: 'The identity details have been updated.' };
}

/**
 * Change a client's status.
 *
 * The capability required depends on the status, and the decision is made by
 * the database guard rather than here — this check is the narrower of the two
 * so the error message is useful. Blacklisting needs `clients:blacklist`,
 * which only the Owner holds.
 */
export async function changeClientStatusAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseSafely(changeClientStatusSchema, {
    clientId: formData.get('clientId'),
    status: formData.get('status'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;

  const required =
    input.status === 'blacklisted'
      ? 'clients:blacklist'
      : input.status === 'archived'
        ? 'clients:archive'
        : 'clients:status';

  try {
    await requirePermission(required);
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const supabase = await createSupabaseServerClient();

  // Lifting a blacklisting also needs `clients:blacklist`, which the guard
  // enforces by inspecting the *old* status — something this action cannot see
  // without a read, and should not rely on seeing.
  const { error } = await supabase
    .from('clients')
    .update({ status: input.status, status_reason: input.reason })
    .eq('id', input.clientId);

  if (error !== null) {
    logger.warn('Could not change a client status.', { code: error.code });
    return { ok: false, message: friendlyClientError(error) };
  }

  revalidatePath(`${ROUTES.clients}/${input.clientId}`);
  revalidatePath(ROUTES.clients);

  return { ok: true, message: 'The client status has been changed.' };
}

/**
 * Replace a client's photograph or identity document.
 *
 * The new file is uploaded **before** the database is repointed, and the old
 * object is left in place. So a failed upload leaves the record pointing at
 * the previous file, which still exists — there is no window in which the
 * database names a file that is not there.
 */
export async function replaceClientDocumentAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('clients:documents');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const clientId = formData.get('clientId');
  const kindRaw = formData.get('kind');
  const file = formData.get('file');

  if (typeof clientId !== 'string' || clientId === '') {
    return { ok: false, message: 'No client was named.' };
  }

  if (kindRaw !== 'photo' && kindRaw !== 'id') {
    return { ok: false, message: 'That document kind is not recognised.' };
  }

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose a file to upload.' };
  }

  if (kindRaw === 'id') {
    try {
      await requirePermission('clients:view_nin');
    } catch (error) {
      return { ok: false, message: toPublicError(error).message };
    }
  }

  const outcome = await uploadDocument('clients', clientId, kindRaw, file);

  if (!outcome.ok || outcome.path === undefined) {
    return { ok: false, message: outcome.message ?? 'The upload failed.' };
  }

  const supabase = await createSupabaseServerClient();

  const { error } =
    kindRaw === 'photo'
      ? await supabase
          .from('clients')
          .update({ photo_path: outcome.path })
          .eq('id', clientId)
      : await supabase
          .from('client_identities')
          .upsert(
            { client_id: clientId, id_document_path: outcome.path },
            { onConflict: 'client_id' },
          );

  if (error !== null) {
    logger.warn('Could not attach an uploaded document.', { code: error.code });
    // The upload succeeded, so the previous file is still in place and still
    // referenced. Saying so plainly beats a generic failure.
    return {
      ok: false,
      message:
        'The file uploaded but could not be attached to the record. The previous one is still in place.',
    };
  }

  revalidatePath(`${ROUTES.clients}/${clientId}`);

  return {
    ok: true,
    message:
      kindRaw === 'photo'
        ? 'The photograph has been replaced.'
        : 'The identity document has been replaced.',
  };
}

/**
 * Link a client record to a portal login.
 *
 * The one operation here that uses the privileged client, because
 * `link_client_profile` is callable only by `service_role`. That is
 * deliberate: this decides which login can read which client's data, so it
 * must not be reachable from a browser session however the request is crafted.
 * Every invariant — the client is unlinked, the profile is active and unused —
 * is checked inside the function under an advisory lock, so two concurrent
 * links cannot both pass and both commit.
 */
export async function linkClientProfileAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('clients:link_auth');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(linkClientProfileSchema, {
    clientId: formData.get('clientId'),
    profileId: formData.get('profileId'),
  });

  if (!parsed.success) {
    return { ok: false, message: 'Choose a client and an account to link.' };
  }

  try {
    const admin = createSupabaseAdminClient('link a client record to a portal login');

    const { error } = await admin.rpc('link_client_profile', {
      p_client_id: parsed.data.clientId,
      p_profile_id: parsed.data.profileId,
    });

    if (error !== null) {
      logger.warn('Could not link a client to a profile.', { code: error.code });
      // These messages come from the function's own invariant checks and are
      // safe to show: each describes a state the operator can act on.
      return { ok: false, message: error.message };
    }
  } catch (error) {
    logger.error('The client linking path is unavailable.', { error });
    return {
      ok: false,
      message: 'Linking is not available. Please contact your administrator.',
    };
  }

  revalidatePath(`${ROUTES.clients}/${parsed.data.clientId}`);

  return { ok: true, message: 'The portal login has been linked.' };
}

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

/** Add a remark. Append-only: this is the only way to write one. */
export async function createRemarkAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('clients:remarks_create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(createRemarkSchema, {
    clientId: formData.get('clientId'),
    body: formData.get('body'),
    category: formData.get('category'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  // `created_by` and `created_by_label` are absent: a trigger derives both
  // from the session, so a remark cannot be attributed to somebody else.
  const { error } = await supabase.from('client_remarks').insert({
    client_id: parsed.data.clientId,
    body: parsed.data.body,
    category: parsed.data.category,
  });

  if (error !== null) {
    logger.warn('Could not add a remark.', { code: error.code });
    return { ok: false, message: friendlyClientError(error) };
  }

  revalidatePath(`${ROUTES.clients}/${parsed.data.clientId}`);

  return { ok: true, message: 'The remark has been added.' };
}

/**
 * Withdraw a remark by appending a retraction.
 *
 * Nothing is edited or removed: the original stays exactly as written, and a
 * new remark records that it was withdrawn and why. That is what makes the
 * history trustworthy — a remark that could be quietly reworded afterwards
 * would be worthless as evidence of what was known at the time.
 */
export async function retractRemarkAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('clients:remarks_create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(retractRemarkSchema, {
    clientId: formData.get('clientId'),
    remarkId: formData.get('remarkId'),
    body: formData.get('body'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Say why this remark is being withdrawn.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from('client_remarks').insert({
    client_id: parsed.data.clientId,
    body: parsed.data.body,
    category: 'retraction',
    retracts_remark_id: parsed.data.remarkId,
  });

  if (error !== null) {
    logger.warn('Could not retract a remark.', { code: error.code });
    return { ok: false, message: friendlyClientError(error) };
  }

  revalidatePath(`${ROUTES.clients}/${parsed.data.clientId}`);

  return { ok: true, message: 'The remark has been withdrawn.' };
}

/** Register a client and go straight to their page. */
export async function createClientAndRedirect(
  previous: ClientActionResult | undefined,
  formData: FormData,
): Promise<ClientActionResult> {
  const result = await createClientAction(previous, formData);

  if (result.ok && result.clientId !== undefined) {
    redirect(`${ROUTES.clients}/${result.clientId}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Turn a database error into something a person can act on.
 *
 * The guards and constraints raise messages written for exactly this purpose,
 * so `P0001` is passed through. Everything else goes through
 * `mapDatabaseError`, which never exposes SQL or a constraint name.
 */
function friendlyClientError(error: { code?: string; message?: string }): string {
  if (error.code === 'P0001' && typeof error.message === 'string') {
    return error.message;
  }

  if (error.code === '42501') {
    return 'You do not have permission to do that.';
  }

  return toPublicError(mapDatabaseError(error, 'client')).message;
}
