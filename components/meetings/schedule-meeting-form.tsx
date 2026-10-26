'use client';

import { useActionState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import { ROUTES } from '@/config/app';
import type { BranchOption } from '@/lib/data/products';
import { scheduleMeetingAction, type MeetingActionResult } from '@/lib/meetings/actions';
import {
  MEETING_TYPES,
  MEETING_TYPE_DESCRIPTIONS,
  MEETING_TYPE_LABELS,
} from '@/lib/domain/meetings';

/**
 * Convening a meeting.
 *
 * ## No weekday, no hour, no quorum
 *
 * The client's documents say the membership meets monthly and say nothing
 * about which day, what time, or how many people make it count. So this form
 * imposes none of those, and the absence is the design rather than an
 * omission: a default weekday would become the rule by accident, and a quorum
 * field would be a policy invented by a form.
 *
 * What the database does enforce is one monthly general meeting per branch per
 * calendar month, which is the one rule the client's documents do state. A
 * second one is refused with that sentence.
 *
 * ## The time is read in Kampala, not in the browser's zone
 *
 * `datetime-local` sends no offset. A meeting at 00:30 on 1 November
 * announced as November's would be filed in October if the value were read as
 * UTC — and `meeting_date` is a generated column, so that mistake would be
 * permanent. The schema appends `+03:00`.
 *
 * ## The venue is free text, and required
 *
 * Free text because a venue here is a description rather than an address —
 * "the back room at the Kyanja office", "Mukasa's compound" — and a
 * structured address field would be filled with one of those anyway.
 * Required because a meeting nobody can find is not a meeting.
 */
export function ScheduleMeetingForm({
  branches,
}: {
  readonly branches: readonly BranchOption[];
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await scheduleMeetingAction(previous, formData);

    if (next.ok && next.meetingId !== undefined) {
      router.replace(`${ROUTES.meetings}/${next.meetingId}?scheduled=1`);
    }

    return next;
  }, undefined);

  if (branches.length === 0) {
    return (
      <Alert tone="warning" title="No branch to meet at">
        A meeting belongs to a branch, and none can be read with your permissions — or
        none is active. Ask somebody who can see the branches to schedule it.
      </Alert>
    );
  }

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> Opening the meeting…
      </Alert>
    );
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <Card>
        <div className="space-y-4">
          <SelectField
            label="Which branch is meeting?"
            name="branchId"
            required
            placeholder="Choose a branch…"
            options={branches.map((branch) => ({
              value: branch.id,
              label: `${branch.branchCode} · ${branch.name}`,
            }))}
            error={result?.fieldErrors?.branchId?.[0]}
            hint="The members expected at the register are that branch's live memberships."
          />

          <SelectField
            label="What kind of meeting?"
            name="meetingType"
            required
            defaultValue="monthly_general"
            options={MEETING_TYPES.map((type) => ({
              value: type,
              label: MEETING_TYPE_LABELS[type],
            }))}
            error={result?.fieldErrors?.meetingType?.[0]}
            hint={MEETING_TYPE_DESCRIPTIONS.monthly_general}
          />

          <Field
            label="Title"
            name="title"
            type="text"
            autoComplete="off"
            required
            autoFocus
            error={result?.fieldErrors?.title?.[0]}
            hint="What members will recognise it by — “November general meeting”."
          />

          <Field
            label="When"
            name="scheduledAt"
            type="datetime-local"
            required
            error={result?.fieldErrors?.scheduledAt?.[0]}
            hint="In Kampala time. Nothing here requires a particular day or hour."
          />

          <Field
            label="Where"
            name="venue"
            type="text"
            autoComplete="off"
            required
            error={result?.fieldErrors?.venue?.[0]}
            hint="Somewhere a member could find without asking. A description is fine."
          />

          <div className="min-w-0 space-y-1.5">
            <label
              htmlFor="meeting-agenda"
              className="text-text block text-sm font-medium"
            >
              Agenda (optional)
            </label>
            <textarea
              id="meeting-agenda"
              name="agenda"
              rows={6}
              className="border-border-strong bg-surface text-text focus-visible:border-accent w-full rounded-lg border px-4 py-3 text-base focus-visible:[box-shadow:var(--ring-focus)] focus-visible:outline-none md:rounded-sm md:px-2.5 md:py-1.5 md:text-[13px]"
            />
            <p className="text-text-muted text-xs">
              One field rather than a list of items, because an agenda is read aloud —
              nothing joins to it.
            </p>
            {result?.fieldErrors?.agenda?.[0] === undefined ? null : (
              <p className="text-danger text-xs font-medium">
                {result.fieldErrors.agenda[0]}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4">
          <Button type="submit" disabled={pending}>
            {pending ? 'Scheduling…' : 'Schedule the meeting'}
          </Button>
        </div>
      </Card>
    </form>
  );
}
