'use server';

/**
 * Membership meetings, attendance, minutes and actions, as trusted
 * server-side operations.
 *
 * Every function here performs the same checks in the same order: a session
 * exists, the account is active, the capability is held, the rate limit
 * permits it, the input validates — and then the database decides the rest,
 * by running as the caller.
 *
 * ## The branch rule is the database's
 *
 * Nothing in this module checks which branch a caller may convene a meeting
 * at or mark a register for. Each function it calls checks
 * `user_can_see_branch` itself, and it must: a SECURITY DEFINER function has
 * no policies applied to it, so a check made out here would be the only one
 * and a caller going straight to PostgREST would meet none.
 *
 * ## Nothing here derives a consequence from attendance
 *
 * No function in this module — and none in the database — reads the register
 * to decide anything about a membership, its savings, its loans or its
 * benefits. The client's documents say monthly meetings happen and say
 * nothing about a penalty for missing one, so the module records attendance
 * and affects nothing else. `tests/db/meetings.test.ts` asserts that absence
 * mechanically, because an absence that is only documented is one somebody
 * builds a feature on top of next year.
 *
 * ## Two asymmetries the database owns
 *
 * Marking a register twice with the *same* answer is a no-op; marking it with
 * a different one is a correction and needs a reason. Writing minutes is
 * free; changing finalised minutes needs a note saying what changed. Neither
 * can be decided at this layer, because both depend on what the record
 * already says — so the same submission succeeds or is refused depending on
 * state the database holds, and `mark_meeting_attendance` and
 * `record_meeting_minutes` are what tell the cases apart.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { checkActorRateLimit } from '@/lib/security/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  addActionItemSchema,
  cancelMeetingSchema,
  finaliseMinutesSchema,
  markAttendanceSchema,
  recordMinutesSchema,
  rescheduleMeetingSchema,
  scheduleMeetingSchema,
  updateActionItemSchema,
} from '@/lib/validation/meetings';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

export interface MeetingActionResult extends ActionResult {
  readonly meetingId?: string;
  readonly attendanceId?: string;
  readonly actionId?: string;
}

const FIELD_ERROR_MESSAGE = 'Please check the highlighted fields.';

function revalidateMeetingRoutes(meetingId?: string): void {
  revalidatePath(ROUTES.meetings);

  if (meetingId !== undefined) {
    revalidatePath(`${ROUTES.meetings}/${meetingId}`);
  }

  // The meeting counts appear on the benefits dashboard, which is where the
  // membership programme's work is summarised.
  revalidatePath(ROUTES.benefits);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Schedule a meeting.
 *
 * One monthly general meeting per branch per month, enforced by a partial
 * unique index rather than by a check here — two staff scheduling at once
 * would both pass a check. A special meeting in the same month is permitted,
 * because the index is on the monthly one: that is the meeting the programme
 * promises.
 */
export async function scheduleMeetingAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  let actor;
  try {
    actor = await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('meeting.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(scheduleMeetingSchema, {
    branchId: formData.get('branchId'),
    meetingType: formData.get('meetingType'),
    title: formData.get('title'),
    venue: formData.get('venue'),
    scheduledAt: formData.get('scheduledAt'),
    agenda: formData.get('agenda'),
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

  const { data, error } = await supabase.rpc('schedule_membership_meeting', {
    p_branch_id: input.branchId,
    p_meeting_type: input.meetingType,
    p_title: input.title,
    p_venue: input.venue,
    p_scheduled_at: input.scheduledAt,
    p_agenda: input.agenda ?? null,
  });

  if (error !== null) {
    logger.warn('A membership meeting could not be scheduled.', {
      code: error.code,
      branchId: input.branchId,
      meetingType: input.meetingType,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes();

  return {
    ok: true,
    message: 'Meeting scheduled. Everybody who may see meetings has been notified.',
    meetingId: typeof data === 'string' ? data : undefined,
  };
}

/**
 * Move a scheduled meeting.
 *
 * The first announced date is kept, not the previous one: a meeting moved
 * twice has one original that members remember.
 */
export async function rescheduleMeetingAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  let actor;
  try {
    actor = await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('meeting.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(rescheduleMeetingSchema, {
    meetingId: formData.get('meetingId'),
    scheduledAt: formData.get('scheduledAt'),
    reason: formData.get('reason'),
    venue: formData.get('venue'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('reschedule_membership_meeting', {
    p_meeting_id: parsed.data.meetingId,
    p_scheduled_at: parsed.data.scheduledAt,
    p_reason: parsed.data.reason,
    p_venue: parsed.data.venue ?? null,
  });

  if (error !== null) {
    logger.warn('A membership meeting could not be moved.', {
      code: error.code,
      meetingId: parsed.data.meetingId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes(parsed.data.meetingId);

  return {
    ok: true,
    message: 'Meeting moved. The new date has been announced.',
    meetingId: parsed.data.meetingId,
  };
}

/**
 * Cancel a scheduled meeting.
 *
 * Refused for a meeting people attended: a meeting that took place is marked
 * held, whatever anybody wants the record to say afterwards. Cancelling it
 * would leave attendance rows for an afternoon the register says never
 * happened.
 */
export async function cancelMeetingAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  let actor;
  try {
    actor = await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('meeting.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(cancelMeetingSchema, {
    meetingId: formData.get('meetingId'),
    reason: formData.get('reason'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('cancel_membership_meeting', {
    p_meeting_id: parsed.data.meetingId,
    p_reason: parsed.data.reason,
  });

  if (error !== null) {
    logger.warn('A membership meeting could not be cancelled.', {
      code: error.code,
      meetingId: parsed.data.meetingId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes(parsed.data.meetingId);

  return {
    ok: true,
    message: 'Meeting cancelled. The month’s slot is free for a replacement.',
    meetingId: parsed.data.meetingId,
  };
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

/**
 * Mark or correct one member's attendance.
 *
 * Marking the first member present moves the meeting to `held`, derived from
 * the register rather than set by hand — a meeting with a register and a
 * `scheduled` status would be two statements about one afternoon.
 */
export async function markAttendanceAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  let actor;
  try {
    actor = await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('meeting.attendance', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(markAttendanceSchema, {
    meetingId: formData.get('meetingId'),
    membershipId: formData.get('membershipId'),
    attendance: formData.get('attendance'),
    absenceReason: formData.get('absenceReason'),
    note: formData.get('note'),
    correctionReason: formData.get('correctionReason'),
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

  const { data, error } = await supabase.rpc('mark_meeting_attendance', {
    p_meeting_id: input.meetingId,
    p_membership_id: input.membershipId,
    p_attendance: input.attendance,
    p_absence_reason: input.absenceReason ?? null,
    p_note: input.note ?? null,
    p_correction_reason: input.correctionReason ?? null,
  });

  if (error !== null) {
    logger.warn('Attendance could not be marked.', {
      code: error.code,
      meetingId: input.meetingId,
      attendance: input.attendance,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes(input.meetingId);

  return {
    ok: true,
    message:
      (input.correctionReason ?? null) === null
        ? 'Attendance marked.'
        : 'Attendance corrected. The previous entry is kept, with the reason.',
    meetingId: input.meetingId,
    attendanceId: typeof data === 'string' ? data : undefined,
  };
}

// ---------------------------------------------------------------------------
// Minutes
// ---------------------------------------------------------------------------

export async function recordMinutesAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  let actor;
  try {
    actor = await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('meeting.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(recordMinutesSchema, {
    meetingId: formData.get('meetingId'),
    minutes: formData.get('minutes'),
    amendmentNote: formData.get('amendmentNote'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('record_meeting_minutes', {
    p_meeting_id: parsed.data.meetingId,
    p_minutes: parsed.data.minutes,
    p_amendment_note: parsed.data.amendmentNote ?? null,
  });

  if (error !== null) {
    // The minutes themselves are not logged. They are a record of what the
    // membership decided, readable behind `meetings:view`, and an application
    // log is a wider audience.
    logger.warn('Meeting minutes could not be recorded.', {
      code: error.code,
      meetingId: parsed.data.meetingId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes(parsed.data.meetingId);

  return {
    ok: true,
    message:
      (parsed.data.amendmentNote ?? null) === null
        ? 'Minutes saved.'
        : 'Minutes amended. What changed and why is on the record.',
    meetingId: parsed.data.meetingId,
  };
}

/**
 * Finalise minutes.
 *
 * A separate act from writing them, because a set of minutes everybody can
 * still edit is not a record of what was decided. Amending them afterwards
 * needs a note saying what changed, and the note stays on the row.
 */
export async function finaliseMinutesAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  try {
    await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(finaliseMinutesSchema, {
    meetingId: formData.get('meetingId'),
  });

  if (!parsed.success) return { ok: false, message: FIELD_ERROR_MESSAGE };

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('finalise_meeting_minutes', {
    p_meeting_id: parsed.data.meetingId,
  });

  if (error !== null) {
    logger.warn('Meeting minutes could not be finalised.', {
      code: error.code,
      meetingId: parsed.data.meetingId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes(parsed.data.meetingId);

  return {
    ok: true,
    message: 'Minutes finalised. Changing them now leaves an amendment note.',
    meetingId: parsed.data.meetingId,
  };
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

export async function addActionItemAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  let actor;
  try {
    actor = await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const limit = await checkActorRateLimit('meeting.manage', actor.profileId);
  if (!limit.allowed) return { ok: false, message: limit.message };

  const parsed = parseSafely(addActionItemSchema, {
    meetingId: formData.get('meetingId'),
    description: formData.get('description'),
    assignedTo: formData.get('assignedTo'),
    dueOn: formData.get('dueOn'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('add_meeting_action_item', {
    p_meeting_id: parsed.data.meetingId,
    p_description: parsed.data.description,
    p_assigned_to: parsed.data.assignedTo ?? null,
    p_due_on: parsed.data.dueOn ?? null,
  });

  if (error !== null) {
    logger.warn('A meeting action could not be recorded.', {
      code: error.code,
      meetingId: parsed.data.meetingId,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidateMeetingRoutes(parsed.data.meetingId);

  return {
    ok: true,
    message:
      (parsed.data.assignedTo ?? null) === null
        ? 'Action recorded. Nobody has been assigned to it yet.'
        : 'Action recorded and the assignee notified.',
    meetingId: parsed.data.meetingId,
    actionId: typeof data === 'string' ? data : undefined,
  };
}

export async function updateActionItemAction(
  _previous: MeetingActionResult | undefined,
  formData: FormData,
): Promise<MeetingActionResult> {
  try {
    await requirePermission('meetings:manage');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(updateActionItemSchema, {
    actionId: formData.get('actionId'),
    status: formData.get('status'),
    note: formData.get('note'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: FIELD_ERROR_MESSAGE,
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.rpc('update_meeting_action_item', {
    p_action_id: parsed.data.actionId,
    p_status: parsed.data.status,
    p_note: parsed.data.note ?? null,
  });

  if (error !== null) {
    logger.warn('A meeting action could not be updated.', {
      code: error.code,
      actionId: parsed.data.actionId,
      status: parsed.data.status,
    });

    return { ok: false, message: mapDatabaseError(error).message };
  }

  revalidatePath(ROUTES.meetings);
  revalidatePath(ROUTES.benefits);

  return {
    ok: true,
    message: 'Action updated.',
    actionId: parsed.data.actionId,
  };
}
