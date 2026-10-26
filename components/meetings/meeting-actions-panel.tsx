'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Field, SelectField } from '@/components/ui/field';
import {
  addActionItemAction,
  updateActionItemAction,
  type MeetingActionResult,
} from '@/lib/meetings/actions';
import type { MeetingActionItem, MeetingAssignee } from '@/lib/data/meetings';
import {
  MEETING_ACTION_STATUSES,
  MEETING_ACTION_STATUS_LABELS,
  meetingActionIsClosed,
  meetingActionIsOverdue,
} from '@/lib/domain/meetings';
import { MeetingActionBadge } from './meeting-badges';

/**
 * What the meeting decided somebody would do.
 *
 * ## An assignee is a staff account, not a typed name
 *
 * "Somebody will look into it" is how an action item becomes nobody's, and a
 * free-text name cannot be notified, listed on a dashboard, or checked
 * against an account that still exists. So the field is a profile, and
 * `add_meeting_action_item` refuses one whose account is not active.
 *
 * When the staff list cannot be read — a Secretary/Treasurer does not hold
 * `users:view`, and they are usually the person writing the minutes — the
 * form says so and records the item unassigned, which is a real and ordinary
 * state. It does not reach around the policy with a privileged read.
 *
 * ## Overdue is computed from the business date, not the browser's
 *
 * The date is passed in from the server, in Africa/Kampala. At 23:30 UTC it is
 * already tomorrow in Kampala, and an action list that disagreed with the
 * business about which day it is would call things overdue a day early.
 */
export function MeetingActionsPanel({
  meetingId,
  actions,
  assignees,
  businessDate,
  canManage,
}: {
  readonly meetingId: string;
  readonly actions: readonly MeetingActionItem[];
  readonly assignees: readonly MeetingAssignee[];
  readonly businessDate: string;
  readonly canManage: boolean;
}) {
  const [adding, setAdding] = useState(false);

  const [result, submit, pending] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(addActionItemAction, undefined);

  const open = actions.filter((action) => !meetingActionIsClosed(action.status));

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">What is to be done</h2>
      <p className="text-text-muted mt-1 text-sm">
        {actions.length === 0
          ? 'Nothing has been recorded yet.'
          : `${String(open.length)} of ${String(actions.length)} still open.`}
      </p>

      {actions.length === 0 ? null : (
        <ul className="divide-border/60 mt-3 divide-y">
          {actions.map((action) => (
            <ActionRow
              key={action.id}
              action={action}
              businessDate={businessDate}
              canManage={canManage}
            />
          ))}
        </ul>
      )}

      {canManage ? (
        adding ? (
          <form
            action={submit}
            className="border-border mt-4 min-w-0 space-y-3 border-t pt-4"
          >
            <input type="hidden" name="meetingId" value={meetingId} />

            {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

            <Field
              label="What is to be done?"
              name="description"
              type="text"
              required
              autoFocus
              error={result?.fieldErrors?.description?.[0]}
              hint="One thing, said plainly. The detail belongs in the minutes."
            />

            {assignees.length === 0 ? (
              <p className="text-text-muted text-sm">
                The staff list cannot be read with your permissions, so this item will be
                recorded unassigned. Somebody holding the staff directory permission can
                give it an owner.
              </p>
            ) : (
              <SelectField
                label="Who is doing it? (optional)"
                name="assignedTo"
                placeholder="Nobody in particular yet"
                options={assignees.map((assignee) => ({
                  value: assignee.profileId,
                  label: assignee.fullName,
                }))}
                error={result?.fieldErrors?.assignedTo?.[0]}
              />
            )}

            <Field
              label="By when? (optional)"
              name="dueOn"
              type="date"
              error={result?.fieldErrors?.dueOn?.[0]}
              hint="An item with no date is not more urgent than one with a date — it simply has no date."
            />

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Recording…' : 'Add it'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setAdding(false);
                }}
              >
                Never mind
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add an action item
            </Button>
          </div>
        )
      ) : null}
    </Card>
  );
}

function ActionRow({
  action,
  businessDate,
  canManage,
}: {
  readonly action: MeetingActionItem;
  readonly businessDate: string;
  readonly canManage: boolean;
}) {
  const [result, submit, pending] = useActionState<
    MeetingActionResult | undefined,
    FormData
  >(updateActionItemAction, undefined);

  const [open, setOpen] = useState(false);

  const overdue = meetingActionIsOverdue(action.status, action.dueOn, businessDate);
  const closed = meetingActionIsClosed(action.status);

  return (
    <li className="min-w-0 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text text-sm break-words">{action.description}</p>
          <p className="text-text-muted text-xs">
            {action.assignedToLabel ?? 'Unassigned'}
            {action.dueOn === null ? '' : ' · due '}
            {action.dueOn === null ? null : <DateValue value={action.dueOn} />}
            {` · recorded by ${action.createdByLabel}`}
          </p>
          {action.completionNote === null ? null : (
            <p className="text-text mt-1 text-sm">{action.completionNote}</p>
          )}
          {action.completedAt === null ? null : (
            <p className="text-text-muted text-xs">
              Closed by {action.completedByLabel ?? 'an archived account'} on{' '}
              <DateValue value={action.completedAt} variant="datetime" />
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <MeetingActionBadge status={action.status} overdue={overdue} />
          {canManage && !closed ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? 'Close' : 'Update'}
            </Button>
          ) : null}
        </div>
      </div>

      {open && canManage ? (
        <form
          action={submit}
          className="border-border mt-3 min-w-0 space-y-3 rounded-lg border p-3"
        >
          <input type="hidden" name="actionId" value={action.id} />

          {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

          <SelectField
            label="Where has it got to?"
            name="status"
            required
            defaultValue={action.status}
            options={MEETING_ACTION_STATUSES.map((status) => ({
              value: status,
              label: MEETING_ACTION_STATUS_LABELS[status],
            }))}
            error={result?.fieldErrors?.status?.[0]}
            hint="Done and dropped are both final — an item does not come back from either."
          />

          <Field
            label="A note (optional)"
            name="note"
            type="text"
            autoComplete="off"
            error={result?.fieldErrors?.note?.[0]}
            hint="What was done, or why it was dropped."
          />

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Recording…' : 'Record it'}
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
    </li>
  );
}
