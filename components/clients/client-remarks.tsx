'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { SelectField } from './select-field';
import { createRemarkAction, retractRemarkAction } from '@/lib/clients/actions';
import {
  COMPOSABLE_REMARK_CATEGORIES,
  REMARK_CATEGORY_LABELS,
  formatRecordedDate,
  isRemarkCategory,
} from '@/lib/domain/client';
import type { ClientRemark } from '@/lib/data/clients';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Internal staff remarks on a client.
 *
 * Append-only, and the interface says so plainly rather than hiding it: a
 * person about to write something permanent should know that it is permanent.
 * The table refuses UPDATE and DELETE by trigger and holds no such privilege,
 * so there is no edit control to build.
 *
 * A mistake is corrected by withdrawing the remark, which **appends** a
 * retraction rather than touching the original. The original stays visible,
 * struck through, with the withdrawal beneath it. That is the honest
 * presentation: hiding a withdrawn remark would make the history look like it
 * never happened.
 *
 * Every remark body is rendered as text through JSX, never as HTML. React
 * escapes it, so a client named `<script>` or a remark containing one is
 * displayed rather than executed.
 */
export function ClientRemarks({
  clientId,
  remarks,
  canCreate,
}: {
  readonly clientId: string;
  readonly remarks: readonly ClientRemark[];
  readonly canCreate: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    createRemarkAction,
    undefined,
  );

  const [retractingId, setRetractingId] = useState<string | null>(null);

  // Retractions are shown beneath the remark they withdraw, not as entries of
  // their own — two rows for one event reads as two events.
  const retractionFor = new Map(
    remarks
      .filter((remark) => remark.retractsRemarkId !== null)
      .map((remark) => [remark.retractsRemarkId!, remark]),
  );

  const primary = remarks.filter((remark) => remark.retractsRemarkId === null);

  return (
    <div className="space-y-4">
      {canCreate ? (
        <Card className="space-y-4">
          <form action={formAction} className="space-y-4" noValidate>
            <input type="hidden" name="clientId" value={clientId} />

            {state?.message !== undefined ? (
              <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
            ) : null}

            <SelectField
              label="Category"
              name="category"
              required
              defaultValue="general"
              options={COMPOSABLE_REMARK_CATEGORIES.map((category) => ({
                value: category,
                label: REMARK_CATEGORY_LABELS[category],
              }))}
              error={state?.fieldErrors?.category?.[0]}
            />

            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="remark-body">
                Remark
                <span aria-hidden="true" className="text-danger ml-0.5">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </Label>
              <textarea
                id="remark-body"
                name="body"
                rows={3}
                maxLength={2000}
                required
                aria-describedby="remark-body-hint"
                aria-invalid={state?.fieldErrors?.body !== undefined}
                className="border-border bg-surface text-text focus-visible:outline-accent aria-invalid:border-danger w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
              />
              <p id="remark-body-hint" className="text-text-muted text-sm">
                This is recorded permanently with your name and cannot be edited or
                deleted. A mistake can be withdrawn, which adds a note rather than
                removing this one.
              </p>
              {state?.fieldErrors?.body?.[0] !== undefined ? (
                <p role="alert" className="text-danger text-sm">
                  {state.fieldErrors.body[0]}
                </p>
              ) : null}
            </div>

            <Button type="submit" disabled={pending}>
              {pending ? 'Adding…' : 'Add remark'}
            </Button>
          </form>
        </Card>
      ) : null}

      {primary.length === 0 ? (
        <Card>
          <p className="text-text-muted">No remarks have been recorded.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {primary.map((remark) => {
            const retraction = retractionFor.get(remark.id);
            const withdrawn = retraction !== undefined;

            return (
              <li
                key={remark.id}
                className="border-border bg-surface min-w-0 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={remark.category === 'payment_concern' ? 'warning' : 'neutral'}
                  >
                    {isRemarkCategory(remark.category)
                      ? REMARK_CATEGORY_LABELS[remark.category]
                      : remark.category}
                  </Badge>
                  {withdrawn ? <Badge tone="danger">Withdrawn</Badge> : null}
                  <span className="text-text-muted text-sm">
                    {remark.authorLabel} · {formatRecordedDate(remark.createdAt)}
                  </span>
                </div>

                <p
                  className={`text-text mt-2 break-words whitespace-pre-wrap ${
                    withdrawn ? 'line-through opacity-60' : ''
                  }`}
                >
                  {remark.body}
                </p>

                {withdrawn ? (
                  <p className="border-border text-text-muted mt-2 border-l-2 pl-3 text-sm break-words whitespace-pre-wrap">
                    <span className="font-medium">Withdrawn:</span> {retraction.body}
                    <span className="block text-xs">
                      {retraction.authorLabel} ·{' '}
                      {formatRecordedDate(retraction.createdAt)}
                    </span>
                  </p>
                ) : canCreate ? (
                  retractingId === remark.id ? (
                    <RetractForm
                      clientId={clientId}
                      remarkId={remark.id}
                      onCancel={() => {
                        setRetractingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRetractingId(remark.id);
                      }}
                      className="text-accent focus-visible:outline-accent mt-3 min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      Withdraw this remark
                    </button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Appending a retraction. Its own form, so its own pending state. */
function RetractForm({
  clientId,
  remarkId,
  onCancel,
}: {
  readonly clientId: string;
  readonly remarkId: string;
  readonly onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    retractRemarkAction,
    undefined,
  );

  return (
    <form action={formAction} className="mt-3 space-y-3" noValidate>
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="remarkId" value={remarkId} />

      {state?.message !== undefined && !state.ok ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={`retract-${remarkId}`}>Why is this being withdrawn?</Label>
        <textarea
          id={`retract-${remarkId}`}
          name="body"
          rows={2}
          maxLength={2000}
          required
          className="border-border bg-surface text-text focus-visible:outline-accent w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Withdrawing…' : 'Confirm withdrawal'}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
