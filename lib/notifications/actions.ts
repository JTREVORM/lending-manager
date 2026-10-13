'use server';

/**
 * Marking notifications read.
 *
 * The only write this module offers, and the only one the schema permits: the
 * stream is append-only and a receipt is insert-only. There is no "dismiss",
 * because read *is* dismissal — a second state would be a second thing to
 * explain and nobody asked for it — and no "delete", because nothing in this
 * system deletes history.
 *
 * ## Why this is a function call and not an insert
 *
 * The row a client would have to supply is its own `profile_id`, and a client
 * that chooses whose receipt it writes can clear somebody else's bell.
 * `mark_notifications_read` derives the profile from the session, so the ids a
 * caller passes can only ever narrow what *they* can already see.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { markNotificationsReadSchema } from '@/lib/validation/notification';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Mark the notifications named in the form read, or all of them.
 *
 * A missing `ids` field means "everything I can see", which is what the
 * "mark all read" control submits. An id the caller cannot see is skipped
 * rather than refused: the honest answer to "mark this read" for something
 * you cannot read is that there was nothing to mark.
 */
export async function markNotificationsReadAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('notifications:view');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  // `getAll` so one control can submit several ids, and an absent field is an
  // empty array — which is why the absence has to be checked before parsing.
  const raw = formData.getAll('notificationId').filter((value) => value !== '');

  const parsed = parseSafely(markNotificationsReadSchema, {
    ids: raw.length === 0 ? null : raw,
  });

  if (!parsed.success) {
    return { ok: false, message: 'Those notifications were not recognised.' };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('mark_notifications_read', {
    p_ids: parsed.data.ids,
  });

  if (error !== null) {
    logger.warn('Could not mark notifications read.', { code: error.code });
    return { ok: false, message: toPublicError(mapDatabaseError(error, 'loan')).message };
  }

  // The bell lives in the shell, so every page carries it. Revalidating the
  // layout's own path is not enough — the count is read in the layout, which
  // Next.js caches per route — so the two screens that show it are refreshed
  // explicitly along with the page the control was on.
  revalidatePath(ROUTES.notifications);
  revalidatePath(ROUTES.dashboard);

  const marked = Number(data ?? 0);

  return {
    ok: true,
    message:
      marked === 0
        ? 'There was nothing left to mark.'
        : marked === 1
          ? 'One notification marked read.'
          : `${String(marked)} notifications marked read.`,
  };
}
