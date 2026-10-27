'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Field } from '@/components/ui/field';
import {
  finaliseMinutesAction,
  recordMinutesAction,
  type MeetingActionResult,
} from '@/lib/meetings/actions';
import type { MeetingSummary } from '@/lib/data/meetings';

/**
 * The minutes.
 *
 * ## Finalising is a one-way door, and amending leaves a mark
 *
 * Before anybody finalises them, minutes are a draft and can be rewritten
 * freely — that is what a draft is for. Once finalised,
 * `record_meeting_minutes` refuses a silent edit: an amendment needs a note
 * saying what changed, and the row keeps `minutes_amended_at` and the note
 * for good. So the history of a disputed decision is readable, which is the
 * only reason minutes exist.
 *
 * The form therefore shows a different control after finalisation, and the
 * amendment note is required there rather than optional. The database says
 * the same thing; this says it where somebody can read it before typing.
 *
 * ## One textarea, not a structured record of motions
 *
 * Minutes are prose that gets read aloud and signed. A table of motions and
 * seconds would be a data model nothing joins to, filled in by whoever was
 * fastest, and it would make the common case — writing down what was agreed —
 * harder than a notebook.
 */
export function MeetingMinutesPanel({
  meeting,
  canManage,
}: {
  readonly meeting: MeetingSummary;
  readonly canManage: boolean;
}) {
  const [result, submit, pending] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(recordMinutesAction, undefined);

  const [finaliseResult, finalise, finalising] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(finaliseMinutesAction, undefined);

  const [editing, setEditing] = useState(false);

  const finalised = meeting.minutesFinalisedAt !== null;

  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-text text-sm font-semibold">Minutes</h2>
        {finalised ? (
          <p className="text-text-muted text-xs">
            Finalised <DateValue value={meeting.minutesFinalisedAt} variant="datetime" />{' '}
            by {meeting.minutesFinalisedByLabel ?? 'an archived account'}
          </p>
        ) : meeting.minutes === null ? null : (
          <p className="text-text-muted text-xs">A draft. Nobody has finalised it.</p>
        )}
      </div>

      {meeting.minutes === null ? (
        <p className="text-text-muted mt-2 text-sm">Nothing has been written yet.</p>
      ) : (
        // `whitespace-pre-wrap` so paragraphs and lists survive as typed. The
        // text is rendered as text, never as markup: minutes are somebody's
        // words, and interpreting them as HTML would be both wrong and unsafe.
        <p className="text-text mt-2 text-sm whitespace-pre-wrap">{meeting.minutes}</p>
      )}

      {meeting.minutesAmendedAt === null ? null : (
        <Alert tone="info" className="mt-3" title="These minutes were amended">
          {meeting.minutesAmendmentNote ?? 'No note was recorded.'}{' '}
          <span className="block">
            Amended <DateValue value={meeting.minutesAmendedAt} variant="datetime" />.
          </span>
        </Alert>
      )}

      {canManage ? (
        editing ? (
          <form action={submit} className="mt-4 min-w-0 space-y-3">
            <input type="hidden" name="meetingId" value={meeting.id} />

            {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

            <div className="min-w-0 space-y-1.5">
              <label
                htmlFor="meeting-minutes"
                className="text-text block text-sm font-medium"
              >
                What was decided?
              </label>
              <textarea
                id="meeting-minutes"
                name="minutes"
                rows={12}
                required
                defaultValue={meeting.minutes ?? ''}
                className="border-border-strong bg-surface text-text focus-visible:border-accent w-full rounded-lg border px-4 py-3 text-base focus-visible:[box-shadow:var(--ring-focus)] focus-visible:outline-none md:rounded-sm md:px-2.5 md:py-1.5 md:text-[13px]"
              />
              {result?.fieldErrors?.minutes?.[0] === undefined ? null : (
                <p className="text-danger text-xs font-medium">
                  {result.fieldErrors.minutes[0]}
                </p>
              )}
            </div>

            {finalised ? (
              <Field
                label="What is being changed, and why?"
                name="amendmentNote"
                type="text"
                required
                error={result?.fieldErrors?.amendmentNote?.[0]}
                hint="These minutes have been finalised, so an edit is an amendment. The note is kept on the record for good — a silent rewrite of a finalised record is refused."
              />
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending
                  ? 'Saving…'
                  : finalised
                    ? 'Amend the minutes'
                    : 'Save the minutes'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                }}
              >
                Never mind
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(true);
              }}
            >
              {meeting.minutes === null
                ? 'Write the minutes'
                : finalised
                  ? 'Amend the minutes'
                  : 'Edit the draft'}
            </Button>

            {!finalised && meeting.minutes !== null ? (
              <form action={finalise} className="contents">
                <input type="hidden" name="meetingId" value={meeting.id} />
                <Button type="submit" disabled={finalising}>
                  {finalising ? 'Finalising…' : 'Finalise them'}
                </Button>
              </form>
            ) : null}
          </div>
        )
      ) : null}

      {finaliseResult?.ok === false ? (
        <Alert tone="danger" className="mt-3">
          {finaliseResult.message}
        </Alert>
      ) : null}

      {!finalised && meeting.minutes !== null && canManage ? (
        <p className="text-text-muted mt-3 text-xs">
          Finalising fixes the record. Afterwards an edit is an amendment that has to say
          what changed, and both the amendment and its note stay on the meeting.
        </p>
      ) : null}
    </Card>
  );
}
