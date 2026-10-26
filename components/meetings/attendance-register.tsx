'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import { DateValue } from '@/components/ui/data-value';
import { markAttendanceAction, type MeetingActionResult } from '@/lib/meetings/actions';
import type {
  AttendanceCorrection,
  AttendanceRow,
  ExpectedMember,
} from '@/lib/data/meetings';
import {
  MEETING_ABSENCE_REASONS,
  MEETING_ABSENCE_REASON_LABELS,
  MEETING_ATTENDANCE_LABELS,
  MEETING_ATTENDANCE_VALUES,
  attendanceMayCarryReason,
  attendanceRate,
  type MeetingAttendance,
} from '@/lib/domain/meetings';
import { AttendanceBadge } from './meeting-badges';

/**
 * The attendance register: every expected member, and what was recorded.
 *
 * ## It lists everybody, always
 *
 * Marked and unmarked together, in one order that does not change as people
 * are marked. A register that only listed the unmarked would lose its place
 * on every tap, which is unusable for the actual job: one person with a phone,
 * working down a room.
 *
 * ## Marking the same answer again is not a correction
 *
 * `mark_meeting_attendance` treats an identical answer as a no-op and a
 * *different* one as a correction needing a reason — the previous entry is
 * kept in `meeting_attendance_corrections`, which is append-only. So the form
 * asks for a reason only when the answer is being changed, and whether it is
 * being changed is something only the database can say for certain. This
 * screen asks whenever a row already has an answer and the new one differs,
 * and the database has the last word.
 *
 * ## Nothing here attaches a consequence to absence
 *
 * Because the client has not decided there is one. No warning tone on
 * `absent`, no cumulative count of misses, no flag. What the register does is
 * record what happened; what it costs a member is the business's to settle,
 * and a screen that implied an answer would be inventing policy.
 */
export function AttendanceRegister({
  meetingId,
  expected,
  marked,
  corrections,
  presentCount,
  canManage,
  meetingStatus,
}: {
  readonly meetingId: string;
  readonly expected: readonly ExpectedMember[];
  readonly marked: readonly AttendanceRow[];
  readonly corrections: readonly AttendanceCorrection[];
  readonly presentCount: number;
  readonly canManage: boolean;
  readonly meetingStatus: string;
}) {
  const byMembership = new Map(marked.map((row) => [row.membershipId, row]));
  const rate = attendanceRate(presentCount, expected.length);

  const correctionsByMembership = new Map<string, AttendanceCorrection[]>();
  for (const correction of corrections) {
    const list = correctionsByMembership.get(correction.membershipId) ?? [];
    list.push(correction);
    correctionsByMembership.set(correction.membershipId, list);
  }

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">The register</h2>
      <p className="text-text-muted mt-1 text-sm tabular-nums">
        {marked.length} of {expected.length} marked · {presentCount} present
        {rate === null ? '' : ` · ${String(rate)}%`}
      </p>

      {expected.length === 0 ? (
        <p className="text-text-muted mt-4 text-sm">
          No live membership belongs to this branch, so there is nobody to mark.
        </p>
      ) : (
        <ul className="divide-border/60 mt-4 divide-y">
          {expected.map((member) => (
            <MemberRow
              key={member.membershipId}
              meetingId={meetingId}
              member={member}
              row={byMembership.get(member.membershipId)}
              corrections={correctionsByMembership.get(member.membershipId) ?? []}
              canManage={canManage && meetingStatus !== 'cancelled'}
            />
          ))}
        </ul>
      )}

      {meetingStatus === 'cancelled' ? (
        <p className="text-text-muted mt-4 text-xs">
          This meeting was cancelled, so the register is closed. A meeting people actually
          attended cannot be cancelled — the database refuses it — so anything recorded
          here happened before the cancellation.
        </p>
      ) : null}
    </Card>
  );
}

function MemberRow({
  meetingId,
  member,
  row,
  corrections,
  canManage,
}: {
  readonly meetingId: string;
  readonly member: ExpectedMember;
  readonly row: AttendanceRow | undefined;
  readonly corrections: readonly AttendanceCorrection[];
  readonly canManage: boolean;
}) {
  const [result, submit, pending] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(markAttendanceAction, undefined);

  const [open, setOpen] = useState(false);
  const [attendance, setAttendance] = useState<MeetingAttendance>(
    row?.attendance ?? 'present',
  );

  // A correction is a *different* answer on a row that already has one. The
  // database decides for certain; this decides whether to ask for a reason.
  const isCorrection = row !== undefined && row.attendance !== attendance;

  return (
    <li className="min-w-0 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text text-sm font-medium break-words">{member.memberName}</p>
          <p className="text-text-muted font-mono text-xs">
            {member.membershipNumber}
            {member.membershipStatus === 'suspended' ? ' · suspended' : ''}
          </p>
          {row === undefined ? null : (
            <p className="text-text-muted text-xs">
              Marked by {row.markedByLabel}
              {row.absenceReason === null
                ? ''
                : ` · ${MEETING_ABSENCE_REASON_LABELS[row.absenceReason]}`}
              {row.correctionCount === 0
                ? ''
                : ` · corrected ${String(row.correctionCount)} ${
                    row.correctionCount === 1 ? 'time' : 'times'
                  }`}
            </p>
          )}
          {row?.note === null || row?.note === undefined ? null : (
            <p className="text-text mt-1 text-sm">{row.note}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {row === undefined ? (
            <span className="text-text-muted text-xs">Not marked</span>
          ) : (
            <AttendanceBadge value={row.attendance} />
          )}

          {canManage ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? 'Close' : row === undefined ? 'Mark' : 'Change'}
            </Button>
          ) : null}
        </div>
      </div>

      {corrections.length === 0 ? null : (
        <ul className="text-text-muted mt-2 space-y-1 text-xs">
          {corrections.map((correction) => (
            <li key={correction.id}>
              Was {MEETING_ATTENDANCE_LABELS[correction.previousAttendance]}, changed to{' '}
              {MEETING_ATTENDANCE_LABELS[correction.newAttendance]} by{' '}
              {correction.correctedByLabel} —&nbsp;{correction.reason}
            </li>
          ))}
        </ul>
      )}

      {open && canManage ? (
        <form
          action={submit}
          className="border-border mt-3 min-w-0 space-y-3 rounded-lg border p-3"
        >
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="membershipId" value={member.membershipId} />

          {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

          <fieldset className="min-w-0">
            <legend className="text-text mb-2 text-sm font-medium">Did they come?</legend>
            <div className="flex min-w-0 flex-wrap gap-2">
              {MEETING_ATTENDANCE_VALUES.map((value) => (
                <label
                  key={value}
                  className={`focus-within:outline-accent inline-flex min-h-11 cursor-pointer items-center rounded-lg border px-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 ${
                    attendance === value
                      ? 'border-accent bg-accent-surface text-accent'
                      : 'border-border text-text'
                  }`}
                >
                  <input
                    type="radio"
                    name="attendance"
                    value={value}
                    checked={attendance === value}
                    onChange={() => {
                      setAttendance(value);
                    }}
                    className="sr-only"
                  />
                  {MEETING_ATTENDANCE_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>

          {attendanceMayCarryReason(attendance) ? (
            <SelectField
              label="Why were they away? (optional)"
              name="absenceReason"
              placeholder="Not recorded"
              options={MEETING_ABSENCE_REASONS.map((reason) => ({
                value: reason,
                label: MEETING_ABSENCE_REASON_LABELS[reason],
              }))}
              error={result?.fieldErrors?.absenceReason?.[0]}
              hint="A closed list, so the register can be counted. Nothing in this system penalises any of them."
            />
          ) : null}

          <Field
            label="A note (optional)"
            name="note"
            type="text"
            autoComplete="off"
            error={result?.fieldErrors?.note?.[0]}
          />

          {isCorrection ? (
            <Field
              label="Why is this being changed?"
              name="correctionReason"
              type="text"
              required
              error={result?.fieldErrors?.correctionReason?.[0]}
              hint="The previous entry is kept with this reason beside it. A register that could be silently rewritten would not be evidence of anything."
            />
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending
                ? 'Recording…'
                : isCorrection
                  ? 'Record the correction'
                  : 'Record it'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setOpen(false);
              }}
            >
              Never mind
            </Button>
          </div>
        </form>
      ) : null}

      {row === undefined ? null : (
        <p className="sr-only">
          Marked <DateValue value={row.markedAt} variant="datetime" />
        </p>
      )}
    </li>
  );
}
