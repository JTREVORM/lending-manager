'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import {
  cancelMeetingAction,
  rescheduleMeetingAction,
  type MeetingActionResult,
} from '@/lib/meetings/actions';
import type { MeetingSummary } from '@/lib/data/meetings';

/**
 * Moving a meeting, or calling it off.
 *
 * ## A meeting people attended cannot be cancelled
 *
 * `cancel_membership_meeting` checks the register **before** it checks the
 * status, so the refusal says "people attended, so it happened" rather than
 * "it is already held". The distinction matters to whoever is reading the
 * message: one is a fact about the afternoon, the other is a fact about a
 * column.
 *
 * ## Both need a reason, and the reason is the point
 *
 * Members arrange their day around a meeting. A move with no reason recorded
 * is an announcement nobody can explain at the next one, and the reason is
 * carried into the notification members receive.
 */
export function MeetingDecisionPanel({
  meeting,
  canManage,
}: {
  readonly meeting: MeetingSummary;
  readonly canManage: boolean;
}) {
  const [moveResult, move, moving] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(rescheduleMeetingAction, undefined);

  const [cancelResult, cancel, cancelling] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(cancelMeetingAction, undefined);

  const [movingOpen, setMovingOpen] = useState(false);
  const [cancellingOpen, setCancellingOpen] = useState(false);

  const movable = meeting.status === 'scheduled' || meeting.status === 'postponed';
  const cancellable = movable && meeting.attendanceRecorded === 0;

  if (!canManage || (!movable && !cancellable)) return null;

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">Change the arrangement</h2>

      <div className="mt-3 min-w-0 space-y-4">
        {movable ? (
          movingOpen ? (
            <form
              action={move}
              className="border-border min-w-0 space-y-3 rounded-lg border p-3"
            >
              <input type="hidden" name="meetingId" value={meeting.id} />

              {moveResult?.ok === false ? (
                <Alert tone="danger">{moveResult.message}</Alert>
              ) : null}

              <Field
                label="The new date and time"
                name="scheduledAt"
                type="datetime-local"
                required
                autoFocus
                error={moveResult?.fieldErrors?.scheduledAt?.[0]}
                hint="In Kampala time."
              />

              <Field
                label="A new venue (optional)"
                name="venue"
                type="text"
                autoComplete="off"
                error={moveResult?.fieldErrors?.venue?.[0]}
                hint="Leave it empty to keep the same place."
              />

              <Field
                label="Why is it moving?"
                name="reason"
                type="text"
                required
                error={moveResult?.fieldErrors?.reason?.[0]}
                hint="Members will have arranged their day around the old arrangement, and this reason reaches them."
              />

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={moving}>
                  {moving ? 'Moving…' : 'Move the meeting'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={moving}
                  onClick={() => {
                    setMovingOpen(false);
                  }}
                >
                  Never mind
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setMovingOpen(true);
              }}
            >
              Move this meeting
            </Button>
          )
        ) : null}

        {cancellable ? (
          cancellingOpen ? (
            <form
              action={cancel}
              className="border-border min-w-0 space-y-3 rounded-lg border p-3"
            >
              <input type="hidden" name="meetingId" value={meeting.id} />

              {cancelResult?.ok === false ? (
                <Alert tone="danger">{cancelResult.message}</Alert>
              ) : null}

              <Field
                label="Why is it being called off?"
                name="reason"
                type="text"
                required
                autoFocus
                error={cancelResult?.fieldErrors?.reason?.[0]}
                hint="Kept on the meeting and sent to the members who were expecting it."
              />

              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="danger" disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Call it off'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={cancelling}
                  onClick={() => {
                    setCancellingOpen(false);
                  }}
                >
                  Never mind
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCancellingOpen(true);
              }}
            >
              Call this meeting off
            </Button>
          )
        ) : movable ? (
          <p className="text-text-muted text-sm">
            Somebody has already been marked on the register, so this meeting cannot be
            cancelled — it happened. Move it only if the register was marked in error.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
