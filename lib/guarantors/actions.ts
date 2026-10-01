'use server';

/**
 * Guarantor management, as trusted server-side operations.
 *
 * Same five checks as the client actions, and the same principle: every write
 * runs as the caller, so Row Level Security and the column guards are the
 * boundary and these checks exist to produce a decent error message.
 *
 * ## Search before create
 *
 * `findGuarantorByNin` and the guarantor search exist so the registration flow
 * can offer an existing person before making a new record. That matters
 * because the same individual genuinely does guarantee several borrowers, and
 * three copies of them would mean three photographs to keep current and no way
 * to see that one person carries three obligations — which is exactly the
 * exposure a lender wants visible.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { uploadDocument } from '@/lib/storage/documents';
import {
  createGuarantorSchema,
  detachGuarantorSchema,
  linkGuarantorSchema,
  updateGuarantorSchema,
} from '@/lib/validation/client';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface GuarantorActionResult extends ActionResult {
  readonly guarantorId?: string;
}

/**
 * Register a guarantor, and optionally attach them to a client at once.
 *
 * The two are separate database writes with separate capabilities
 * (`guarantors:create` and `guarantors:link`), both of which the Manager
 * holds. The attachment is attempted only after the guarantor exists, and a
 * failure to attach is reported without discarding the guarantor — the person
 * is on record either way, and the attachment can be made from the client's
 * page.
 */
export async function createGuarantorAction(
  _previous: GuarantorActionResult | undefined,
  formData: FormData,
): Promise<GuarantorActionResult> {
  try {
    await requirePermission('guarantors:create');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(createGuarantorSchema, {
    fullName: formData.get('fullName'),
    sex: formData.get('sex'),
    dateOfBirth: formData.get('dateOfBirth'),
    phone: formData.get('phone'),
    alternativePhone: formData.get('alternativePhone'),
    occupation: formData.get('occupation'),
    location: formData.get('location'),
    district: formData.get('district'),
    nin: formData.get('nin'),
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

  const { data: created, error: insertError } = await supabase
    .from('guarantors')
    .insert({
      full_name: input.fullName,
      sex: input.sex,
      date_of_birth: input.dateOfBirth,
      phone: input.phone,
      alternative_phone: input.alternativePhone,
      occupation: input.occupation,
      location: input.location,
      district: input.district,
    })
    .select('id')
    .single();

  if (insertError !== null) {
    logger.warn('Could not register a guarantor.', { code: insertError.code });
    return { ok: false, message: friendlyError(insertError) };
  }

  const guarantorId = created.id;
  const warnings: string[] = [];

  if (input.nin !== null) {
    const { error } = await supabase
      .from('guarantor_identities')
      .insert({ guarantor_id: guarantorId, nin: input.nin });

    if (error !== null) {
      warnings.push(
        error.code === '23505'
          ? 'That National Identification Number is already recorded against another guarantor, so it was not saved. The same person may already be on record.'
          : 'The National Identification Number could not be saved.',
      );
    }
  }

  const photo = formData.get('photo');

  if (photo instanceof File && photo.size > 0) {
    const outcome = await uploadDocument('guarantors', guarantorId, 'photo', photo);

    if (outcome.ok && outcome.path !== undefined) {
      const { error } = await supabase
        .from('guarantors')
        .update({ photo_path: outcome.path })
        .eq('id', guarantorId);

      if (error !== null) {
        warnings.push('The photograph was uploaded but could not be attached.');
      }
    } else {
      warnings.push(outcome.message ?? 'The photograph could not be uploaded.');
    }
  }

  // Attaching to a client, when the flow came from a client's page.
  const clientId = formData.get('clientId');
  const relationship = formData.get('relationshipToClient');

  if (typeof clientId === 'string' && clientId !== '') {
    const link = parseSafely(linkGuarantorSchema, {
      clientId,
      guarantorId,
      relationshipToClient: relationship,
    });

    if (!link.success) {
      warnings.push(
        'The guarantor was registered but not attached: the relationship was missing.',
      );
    } else {
      const { error } = await supabase.from('client_guarantors').insert({
        client_id: link.data.clientId,
        guarantor_id: link.data.guarantorId,
        relationship_to_client: link.data.relationshipToClient,
      });

      if (error !== null) {
        warnings.push('The guarantor was registered but could not be attached.');
      } else {
        revalidatePath(`${ROUTES.clients}/${clientId}`);
      }
    }
  }

  revalidatePath(ROUTES.guarantors);

  return {
    ok: true,
    guarantorId,
    message:
      warnings.length === 0
        ? `${input.fullName} is registered as a guarantor.`
        : `${input.fullName} is registered, but: ${warnings.join(' ')}`,
  };
}

/** Change a guarantor's details. */
export async function updateGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('guarantors:update');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(updateGuarantorSchema, {
    guarantorId: formData.get('guarantorId'),
    fullName: formData.get('fullName'),
    sex: formData.get('sex'),
    dateOfBirth: formData.get('dateOfBirth'),
    phone: formData.get('phone'),
    alternativePhone: formData.get('alternativePhone'),
    occupation: formData.get('occupation'),
    location: formData.get('location'),
    district: formData.get('district'),
    nin: formData.get('nin'),
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

  const { error } = await supabase
    .from('guarantors')
    .update({
      full_name: input.fullName,
      sex: input.sex,
      date_of_birth: input.dateOfBirth,
      phone: input.phone,
      alternative_phone: input.alternativePhone,
      occupation: input.occupation,
      location: input.location,
      district: input.district,
    })
    .eq('id', input.guarantorId);

  if (error !== null) {
    logger.warn('Could not update a guarantor.', { code: error.code });
    return { ok: false, message: friendlyError(error) };
  }

  // The identity number is a separate table with its own policy, so writing it
  // needs the capability to read it too.
  if (input.nin !== null) {
    try {
      await requirePermission('guarantors:view_nin');

      const { error: ninError } = await supabase
        .from('guarantor_identities')
        .upsert(
          { guarantor_id: input.guarantorId, nin: input.nin },
          { onConflict: 'guarantor_id' },
        );

      if (ninError !== null) {
        return {
          ok: true,
          message:
            ninError.code === '23505'
              ? 'The details were saved, but that National Identification Number is already recorded against another guarantor.'
              : 'The details were saved, but the identity number could not be updated.',
        };
      }
    } catch {
      return {
        ok: true,
        message:
          'The details were saved. You do not have permission to change the identity number.',
      };
    }
  }

  revalidatePath(`${ROUTES.guarantors}/${input.guarantorId}`);
  revalidatePath(ROUTES.guarantors);

  return { ok: true, message: 'The guarantor record has been updated.' };
}

/** Attach an existing guarantor to a client. */
export async function linkGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('guarantors:link');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(linkGuarantorSchema, {
    clientId: formData.get('clientId'),
    guarantorId: formData.get('guarantorId'),
    relationshipToClient: formData.get('relationshipToClient'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Choose a guarantor and say how they know the client.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from('client_guarantors').insert({
    client_id: parsed.data.clientId,
    guarantor_id: parsed.data.guarantorId,
    relationship_to_client: parsed.data.relationshipToClient,
  });

  if (error !== null) {
    logger.warn('Could not attach a guarantor.', { code: error.code });

    // The partial unique index on (client_id, guarantor_id) WHERE active.
    if (error.code === '23505') {
      return {
        ok: false,
        message: 'That guarantor already stands for this client.',
      };
    }

    return { ok: false, message: friendlyError(error) };
  }

  revalidatePath(`${ROUTES.clients}/${parsed.data.clientId}`);
  revalidatePath(`${ROUTES.guarantors}/${parsed.data.guarantorId}`);

  return { ok: true, message: 'The guarantor has been attached.' };
}

/**
 * Detach a guarantor from a client.
 *
 * Deactivates rather than deletes, and the database refuses to revive a
 * detached association — a new one must be made instead. That keeps the
 * history legible: Phase 4 will issue loans against these associations, and
 * "the record was deleted" is not an explanation of what the business relied
 * on at the time.
 */
export async function detachGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('guarantors:link');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(detachGuarantorSchema, {
    linkId: formData.get('linkId'),
    clientId: formData.get('clientId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return { ok: false, message: 'That association was not recognised.' };
  }

  const supabase = await createSupabaseServerClient();

  // `detached_at` and `detached_by` are absent: the guard trigger stamps both,
  // so the attribution cannot be forged or omitted.
  const { error } = await supabase
    .from('client_guarantors')
    .update({ active: false, detached_reason: parsed.data.reason })
    .eq('id', parsed.data.linkId);

  if (error !== null) {
    logger.warn('Could not detach a guarantor.', { code: error.code });
    return { ok: false, message: friendlyError(error) };
  }

  revalidatePath(`${ROUTES.clients}/${parsed.data.clientId}`);

  return { ok: true, message: 'The guarantor has been detached.' };
}

function friendlyError(error: { code?: string; message?: string }): string {
  if (error.code === 'P0001' && typeof error.message === 'string') {
    return error.message;
  }

  if (error.code === '42501') {
    return 'You do not have permission to do that.';
  }

  return toPublicError(mapDatabaseError(error, 'guarantor')).message;
}
