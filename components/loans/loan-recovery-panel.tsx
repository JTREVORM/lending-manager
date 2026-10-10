'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { SelectField } from '@/components/clients/select-field';
import { formatRecordedDate } from '@/lib/domain/client';
import {
  PROMISE_STATUS_DESCRIPTIONS,
  PROMISE_STATUS_LABELS,
  RECORDABLE_RECOVERY_KINDS,
  RECOVERY_ACTION_KIND_LABELS,
  RECOVERY_OUTCOMES,
  RECOVERY_OUTCOME_LABELS,
  recoveryKindTakesOutcome,
  type RecordableRecoveryKind,
} from '@/lib/domain/security';
import {
  correctRecoveryActionAction,
  recordRecoveryActionAction,
} from '@/lib/recovery/actions';
import type { RecoveryAction, RecoveryStatusRow } from '@/lib/data/security';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * The chase: what has been done about this loan, and what is promised.
 *
 * ## Why nothing can be edited
 *
 * `loan_recovery_actions` refuses every UPDATE and DELETE, so there is no edit
 * control to offer. A mistake is corrected by appending a correction, and the
 * panel shows the original struck through with the correction beneath it —
 * which is what makes a recovery file worth reading when somebody is later
 * asked to justify a decision made from it.
 *
 * ## A promise is not a rescheduling
 *
 * The form says so, and the panel is careful never to present a promise beside
 * the installment it is about. "He will pay 200,000 on Friday" changes no due
 * date, no arrears figure and no penalty clock — and a staff member who
 * believes otherwise will stop chasing a loan that is still running late.
 *
 * Whether a promise was kept is read from the posted payments, so a reversal
 * un-keeps one without anybody remembering to.
 */
export function LoanRecoveryPanel({
  loanId,
  status,
  actions,
  canRecord,
  today,
}: {
  readonly loanId: string;
  readonly status: RecoveryStatusRow | null;
  readonly actions: readonly RecoveryAction[];
  readonly canRecord: boolean;
  readonly today: string;
}) {
  // Keyed by the action each correction points at, so a row can find the
  // correction that supersedes it without a second pass per row.
  const corrections = new Map<string, RecoveryAction>();

  for (const action of actions) {
    if (action.correctsActionId !== null) {
      corrections.set(action.correctsActionId, action);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      {status === null ? null : <RecoveryHeadline status={status} />}

      {actions.length === 0 ? (
        <Card>
          <p className="text-text-muted">
            Nothing has been recorded against this loan yet.
          </p>
        </Card>
      ) : (
        <ol className="min-w-0 space-y-2">
          {actions
            // A correction is shown under the action it corrects, not as a
            // separate entry in the timeline — two rows saying the same thing
            // in different words is how a file becomes unreadable.
            .filter((action) => action.correctsActionId === null)
            .map((action) => (
              <li key={action.id}>
                <ActionRow
                  loanId={loanId}
                  action={action}
                  correction={corrections.get(action.id) ?? null}
                  canRecord={canRecord}
                  today={today}
                />
              </li>
            ))}
        </ol>
      )}

      {canRecord ? <RecordForm loanId={loanId} today={today} /> : null}
    </div>
  );
}

/** Where this loan stands: arrears, when it was last worked, what is promised. */
function RecoveryHeadline({ status }: { readonly status: RecoveryStatusRow }) {
  return (
    <Card>
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">In arrears</dt>
          <dd className="text-text text-xl font-semibold tabular-nums">
            {status.arrearsAmount === null ? (
              '—'
            ) : (
              <Money amount={status.arrearsAmount} />
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">Days past due</dt>
          <dd className="text-text text-xl font-semibold tabular-nums">
            {status.daysPastDue ?? 0}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">Actions recorded</dt>
          <dd className="text-text text-xl font-semibold tabular-nums">
            {status.actionCount}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">Last worked</dt>
          <dd className="text-text text-xl font-semibold">
            {status.lastActionDate === null
              ? 'Never'
              : formatRecordedDate(status.lastActionDate)}
          </dd>
        </div>
      </dl>

      {status.overdueFollowUpOn === null ? null : (
        <Alert tone="warning" className="mt-3">
          A follow-up was due on {formatRecordedDate(status.overdueFollowUpOn)} and has
          not been recorded.
        </Alert>
      )}

      {status.openPromiseAmount === null || status.openPromiseOn === null ? null : (
        <Alert
          tone={
            status.openPromiseStatus === 'kept'
              ? 'success'
              : status.openPromiseStatus === 'broken'
                ? 'danger'
                : 'info'
          }
          className="mt-3"
        >
          Promised <Money amount={status.openPromiseAmount} /> by{' '}
          {formatRecordedDate(status.openPromiseOn)} —{' '}
          {status.openPromiseStatus === null
            ? 'status unknown'
            : PROMISE_STATUS_LABELS[status.openPromiseStatus].toLowerCase()}
          .{' '}
          {status.openPromiseStatus === null
            ? ''
            : PROMISE_STATUS_DESCRIPTIONS[status.openPromiseStatus]}
        </Alert>
      )}
    </Card>
  );
}

const PROMISE_TONES = {
  pending: 'info',
  kept: 'success',
  broken: 'danger',
} as const;

function ActionRow({
  loanId,
  action,
  correction,
  canRecord,
  today,
}: {
  readonly loanId: string;
  readonly action: RecoveryAction;
  readonly correction: RecoveryAction | null;
  readonly canRecord: boolean;
  readonly today: string;
}) {
  const [correcting, setCorrecting] = useState(false);

  return (
    <div className="border-border bg-surface min-w-0 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text font-medium">
            {RECOVERY_ACTION_KIND_LABELS[action.actionKind]}
            {action.outcome === null
              ? ''
              : ` — ${RECOVERY_OUTCOME_LABELS[action.outcome]}`}
          </p>
          <p className="text-text-muted text-sm">
            {formatRecordedDate(action.actionDate)} · {action.createdByLabel}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {action.isCorrected ? <Badge tone="warning">Corrected</Badge> : null}
          {action.promiseStatus === null ? null : (
            <Badge tone={PROMISE_TONES[action.promiseStatus]}>
              {PROMISE_STATUS_LABELS[action.promiseStatus]}
            </Badge>
          )}
        </div>
      </div>

      <p
        className={
          action.isCorrected
            ? 'text-text-muted mt-2 text-sm break-words line-through'
            : 'text-text mt-2 text-sm break-words'
        }
      >
        {action.notes}
      </p>

      {action.promisedAmount === null || action.promisedOn === null ? null : (
        <p className="text-text-muted mt-2 text-sm">
          Promised <Money amount={action.promisedAmount} /> by{' '}
          {formatRecordedDate(action.promisedOn)}
          {action.promisePaidAmount === null ? null : (
            <>
              {' '}
              · paid <Money amount={action.promisePaidAmount} /> in that window
            </>
          )}
        </p>
      )}

      {action.followUpOn === null ? null : (
        <p className="text-text-muted mt-1 text-sm">
          Follow up on {formatRecordedDate(action.followUpOn)}
        </p>
      )}

      {correction === null ? null : (
        <div className="border-warning/30 bg-warning-surface mt-3 min-w-0 rounded-md border p-2">
          <p className="text-text text-sm font-medium">Correction</p>
          <p className="text-text mt-1 text-sm break-words">{correction.notes}</p>
          <p className="text-text-muted mt-1 text-sm">
            {formatRecordedDate(correction.actionDate)} · {correction.createdByLabel}
          </p>
        </div>
      )}

      {canRecord && !action.isCorrected && action.actionKind !== 'correction' ? (
        <div className="mt-3 min-w-0">
          {correcting ? (
            <CorrectionForm
              loanId={loanId}
              action={action}
              today={today}
              onCancel={() => {
                setCorrecting(false);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setCorrecting(true);
              }}
              className="text-brand-700 focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Correct this entry
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CorrectionForm({
  loanId,
  action,
  today,
  onCancel,
}: {
  readonly loanId: string;
  readonly action: RecoveryAction;
  readonly today: string;
  readonly onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    correctRecoveryActionAction,
    undefined,
  );

  return (
    <form action={formAction} className="min-w-0 space-y-3" noValidate>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="correctsActionId" value={action.id} />
      <input type="hidden" name="actionDate" value={today} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <Alert tone="info">
        The original stays exactly as it was written. This appends a correction beneath
        it.
      </Alert>

      <Field
        label="What was wrong"
        name="notes"
        required
        error={state?.fieldErrors?.notes?.[0]}
      />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Appending…' : 'Append the correction'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RecordForm({
  loanId,
  today,
}: {
  readonly loanId: string;
  readonly today: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    recordRecoveryActionAction,
    undefined,
  );

  const [kind, setKind] = useState<RecordableRecoveryKind>('call');

  const takesOutcome = recoveryKindTakesOutcome(kind);
  const isPromise = kind === 'promise';

  return (
    <Card className="min-w-0 space-y-3">
      <h3 className="text-text font-medium">Record what was done</h3>

      <form action={formAction} className="min-w-0 space-y-4" noValidate>
        <input type="hidden" name="loanId" value={loanId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <SelectField
            label="What was done"
            name="actionKind"
            required
            defaultValue={kind}
            options={RECORDABLE_RECOVERY_KINDS.map((value) => ({
              value,
              label: RECOVERY_ACTION_KIND_LABELS[value],
            }))}
            error={state?.fieldErrors?.actionKind?.[0]}
            onValueChange={(value) => {
              setKind(value as RecordableRecoveryKind);
            }}
          />

          <Field
            label="When"
            name="actionDate"
            type="date"
            required
            defaultValue={today}
            hint="The day it happened, not the day you are typing it."
            error={state?.fieldErrors?.actionDate?.[0]}
          />

          {/* A note has no outcome — it is one. */}
          {takesOutcome ? (
            <SelectField
              label="What came of it"
              name="outcome"
              options={[
                { value: '', label: 'Not recorded' },
                ...RECOVERY_OUTCOMES.map((value) => ({
                  value,
                  label: RECOVERY_OUTCOME_LABELS[value],
                })),
              ]}
              error={state?.fieldErrors?.outcome?.[0]}
            />
          ) : null}

          <Field
            label="Follow up on"
            name="followUpOn"
            type="date"
            hint="Optional. Puts this loan on the follow-up worklist."
            error={state?.fieldErrors?.followUpOn?.[0]}
          />

          {isPromise ? (
            <>
              <Field
                label="Amount promised"
                name="promisedAmount"
                inputMode="numeric"
                required
                error={state?.fieldErrors?.promisedAmount?.[0]}
              />
              <Field
                label="Promised by"
                name="promisedOn"
                type="date"
                required
                error={state?.fieldErrors?.promisedOn?.[0]}
              />
            </>
          ) : null}
        </div>

        <Field
          label="What happened"
          name="notes"
          required
          hint="In the borrower's words where you have them. This cannot be edited afterwards."
          error={state?.fieldErrors?.notes?.[0]}
        />

        {isPromise ? (
          <Alert tone="info">
            A promise changes nothing contractual: the installment is still due when it
            was due, and the penalty clock keeps its own time. Whether it is kept is read
            from the payments posted before the date.
          </Alert>
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record it'}
        </Button>
      </form>
    </Card>
  );
}
