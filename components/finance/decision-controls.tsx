'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import type { FinanceActionResult } from '@/lib/finance/actions';

type Action = (
  previous: FinanceActionResult | undefined,
  formData: FormData,
) => Promise<FinanceActionResult>;

export interface DecisionControlsProps {
  /** The hidden field the action reads, e.g. `transferId`. */
  readonly idField: string;
  readonly recordId: string;
  readonly approve?: { readonly action: Action; readonly label: string };
  readonly reject?: { readonly action: Action; readonly label: string };
  readonly reverse?: { readonly action: Action; readonly label: string };
}

/**
 * Approve, reject or reverse — the three decisions a finance document can
 * receive.
 *
 * ## Why rejecting and reversing ask for a reason inline
 *
 * Both are refused by the database without one, so a control that submitted
 * immediately would produce a refusal rather than an outcome. Opening the
 * reason field first turns "press the button, read the error, press it
 * again" into one step, and the reason ends up on the document where the
 * next person reads it.
 *
 * Approving asks for nothing, because agreeing with what is already written
 * adds no information.
 */
export function DecisionControls({
  idField,
  recordId,
  approve,
  reject,
  reverse,
}: DecisionControlsProps) {
  const [open, setOpen] = useState<'reject' | 'reverse' | null>(null);

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap gap-2">
        {approve !== undefined ? (
          <SimpleDecision
            action={approve.action}
            label={approve.label}
            idField={idField}
            recordId={recordId}
            variant="primary"
          />
        ) : null}

        {reject !== undefined ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen(open === 'reject' ? null : 'reject');
            }}
          >
            {reject.label}
          </Button>
        ) : null}

        {reverse !== undefined ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => {
              setOpen(open === 'reverse' ? null : 'reverse');
            }}
          >
            {reverse.label}
          </Button>
        ) : null}
      </div>

      {open === 'reject' && reject !== undefined ? (
        <ReasonedDecision
          action={reject.action}
          submitLabel={reject.label}
          idField={idField}
          recordId={recordId}
          hint="Say why. It is recorded on the document and nothing is posted."
        />
      ) : null}

      {open === 'reverse' && reverse !== undefined ? (
        <ReasonedDecision
          action={reverse.action}
          submitLabel={reverse.label}
          idField={idField}
          recordId={recordId}
          hint="Say why. The original posting stands and a contra entry cancels it."
        />
      ) : null}
    </div>
  );
}

function SimpleDecision({
  action,
  label,
  idField,
  recordId,
  variant,
}: {
  readonly action: Action;
  readonly label: string;
  readonly idField: string;
  readonly recordId: string;
  readonly variant: 'primary' | 'secondary' | 'danger';
}) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(action, undefined);

  return (
    <form action={submit} className="min-w-0">
      <input type="hidden" name={idField} value={recordId} />
      <Button type="submit" size="sm" variant={variant} loading={pending}>
        {label}
      </Button>
      {result?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {result.message}
        </Alert>
      ) : null}
    </form>
  );
}

function ReasonedDecision({
  action,
  submitLabel,
  idField,
  recordId,
  hint,
}: {
  readonly action: Action;
  readonly submitLabel: string;
  readonly idField: string;
  readonly recordId: string;
  readonly hint: string;
}) {
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(action, undefined);

  return (
    <form
      action={submit}
      className="border-border bg-surface-sunken min-w-0 space-y-2 rounded-lg border p-3"
    >
      <input type="hidden" name={idField} value={recordId} />
      <Field
        label="Reason"
        name="reason"
        required
        autoComplete="off"
        hint={hint}
        error={result?.fieldErrors?.reason?.[0]}
      />
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}
      <Button type="submit" size="sm" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
