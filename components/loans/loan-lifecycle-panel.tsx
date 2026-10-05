'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useFocusWhen } from '@/components/ui/focus-on-appear';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import {
  approveLoanAction,
  cancelLoanAction,
  disburseLoanAction,
  returnLoanToDraftAction,
  submitLoanAction,
} from '@/lib/loans/actions';
import {
  describeLoanApprovalFailure,
  type LoanApprovalFailure,
  type LoanStatus,
} from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import type { ActionResult } from '@/lib/auth/actions';

export interface LoanCapabilities {
  readonly canSubmit: boolean;
  readonly canApprove: boolean;
  readonly canDisburse: boolean;
  readonly canCancel: boolean;
}

/**
 * The lifecycle controls for one loan.
 *
 * ## Double submission
 *
 * Every button disables itself while its action is in flight, via
 * `useActionState`'s pending flag. That handles the impatient double tap.
 *
 * It is not the protection, though — a slow network, a reload at the wrong
 * moment or a crafted request all get past it. The real guard is that each
 * lifecycle function locks the loan row and refuses a loan that is not in the
 * expected state, so a second approval finds the loan already approved and
 * says so. The disabled button is a courtesy; the state machine is the
 * guarantee.
 *
 * ## Nothing optimistic
 *
 * No control shows its result before the server confirms it. For a status or a
 * disbursement that would be actively misleading — a staff member who saw
 * "Active" and handed over cash on the strength of it would have no way to
 * know the write had failed.
 */
export function LoanLifecyclePanel({
  loanId,
  loanNumber,
  status,
  clientName,
  principal,
  totalExpected,
  proposedDate,
  approvalFailures,
  capabilities,
}: {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly status: LoanStatus;
  readonly clientName: string;
  readonly principal: number;
  readonly totalExpected: number;
  readonly proposedDate: string;
  readonly approvalFailures: readonly {
    readonly code: LoanApprovalFailure;
    readonly detail: string | null;
  }[];
  readonly capabilities: LoanCapabilities;
}) {
  const blocked = approvalFailures.length > 0;

  return (
    <div className="min-w-0 space-y-4">
      {/* --- Eligibility, shown wherever a decision is pending ----------- */}
      {(status === 'pending_approval' || status === 'draft') && blocked ? (
        <Alert tone="warning">
          <p className="font-medium">This loan cannot be approved as it stands:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {approvalFailures.map((failure) => (
              <li key={failure.code}>
                {describeLoanApprovalFailure(failure.code, failure.detail)}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {status === 'pending_approval' && !blocked ? (
        <Alert tone="success">
          Every lending rule is satisfied. The figures below are the ones that will be
          recorded.
        </Alert>
      ) : null}

      {status === 'draft' && capabilities.canSubmit ? (
        <SubmitForm loanId={loanId} />
      ) : null}

      {status === 'pending_approval' && capabilities.canApprove ? (
        <ApproveForm loanId={loanId} blocked={blocked} />
      ) : null}

      {status === 'pending_approval' && capabilities.canApprove ? (
        <ReturnForm loanId={loanId} />
      ) : null}

      {status === 'approved' && capabilities.canDisburse ? (
        <DisburseForm
          loanId={loanId}
          loanNumber={loanNumber}
          clientName={clientName}
          principal={principal}
          totalExpected={totalExpected}
          proposedDate={proposedDate}
        />
      ) : null}

      {status === 'approved' && !capabilities.canDisburse ? (
        <Alert tone="info">
          This loan is approved and waiting for disbursement. Releasing the money is done
          by an Owner or Administrator.
        </Alert>
      ) : null}

      {(status === 'draft' || status === 'pending_approval' || status === 'approved') &&
      capabilities.canCancel ? (
        <CancelForm loanId={loanId} status={status} />
      ) : null}
    </div>
  );
}

function SubmitForm({ loanId }: { readonly loanId: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    submitLoanAction,
    undefined,
  );

  return (
    <Card className="space-y-3">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="loanId" value={loanId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <div>
          <h3 className="text-text font-medium">Submit for approval</h3>
          <p className="text-text-muted mt-1 text-sm">
            The loan can no longer be edited once submitted. A reviewer can return it if
            something needs changing.
          </p>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? 'Submitting…' : 'Submit for approval'}
        </Button>
      </form>
    </Card>
  );
}

function ApproveForm({
  loanId,
  blocked,
}: {
  readonly loanId: string;
  readonly blocked: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    approveLoanAction,
    undefined,
  );

  const [confirming, setConfirming] = useState(false);
  const confirmRef = useFocusWhen<HTMLFormElement>(confirming);

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="text-text font-medium">Approve this loan</h3>
        <p className="text-text-muted mt-1 text-sm">
          Approving records the terms permanently and captures the client and guarantor
          details as they are now. The amounts are recalculated by the system at this
          point.
        </p>
      </div>

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {blocked ? (
        <p className="text-text-muted text-sm">
          Resolve the points above before approving.
        </p>
      ) : !confirming ? (
        <Button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Approve…
        </Button>
      ) : (
        // Takes focus when it appears: the "Approve…" button is unmounted by
        // now, so the browser would drop focus to `<body>`. See
        // `useFocusWhen`.
        <form action={formAction} className="space-y-3" ref={confirmRef} tabIndex={-1}>
          <input type="hidden" name="loanId" value={loanId} />

          <Alert tone="info">
            Confirm that you have checked the client, the guarantors and the figures
            below.
          </Alert>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Approving…' : 'Yes, approve this loan'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Not yet
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

function ReturnForm({ loanId }: { readonly loanId: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    returnLoanToDraftAction,
    undefined,
  );

  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="text-accent focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Return for correction instead
      </button>
    );
  }

  return (
    <Card className="space-y-3">
      <form action={formAction} className="space-y-3" noValidate>
        <input type="hidden" name="loanId" value={loanId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="review-note">What needs changing?</Label>
          <textarea
            id="review-note"
            name="reviewNote"
            rows={3}
            maxLength={500}
            required
            aria-invalid={state?.fieldErrors?.reviewNote !== undefined}
            className="border-border bg-surface text-text focus-visible:outline-accent aria-invalid:border-danger w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
          />
          <p className="text-text-muted text-sm">Shown to whoever corrects the draft.</p>
          {state?.fieldErrors?.reviewNote?.[0] !== undefined ? (
            <p role="alert" className="text-danger text-sm">
              {state.fieldErrors.reviewNote[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Returning…' : 'Return to draft'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Disbursement confirmation.
 *
 * Restates the loan number, the borrower, the amount being handed over and the
 * contractual total before asking. This is the moment real money leaves the
 * business, and it is the one screen where repeating facts the user has
 * already seen is the right thing to do.
 */
function DisburseForm({
  loanId,
  loanNumber,
  clientName,
  principal,
  totalExpected,
  proposedDate,
}: {
  readonly loanId: string;
  readonly loanNumber: string;
  readonly clientName: string;
  readonly principal: number;
  readonly totalExpected: number;
  readonly proposedDate: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    disburseLoanAction,
    undefined,
  );

  const [confirming, setConfirming] = useState(false);
  const confirmRef = useFocusWhen<HTMLFormElement>(confirming);

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="text-text font-medium">Release the money</h3>
        <p className="text-text-muted mt-1 text-sm">
          This marks the loan as active and records who released it. It cannot be undone —
          an active loan cannot be cancelled.
        </p>
      </div>

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {!confirming ? (
        <Button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Disburse…
        </Button>
      ) : (
        // Takes focus when it appears, for the same reason the approval
        // confirmation does — and with more at stake, because the next press
        // hands cash over.
        <form action={formAction} className="space-y-3" ref={confirmRef} tabIndex={-1}>
          <input type="hidden" name="loanId" value={loanId} />

          <dl className="border-border bg-surface-raised min-w-0 space-y-2 rounded-lg border p-3 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Loan</dt>
              <dd className="text-text font-mono">{loanNumber}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Borrower</dt>
              <dd className="text-text min-w-0 text-right break-words">{clientName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Handing over</dt>
              <dd className="text-text font-semibold tabular-nums">
                <Money amount={toUgx(principal)} />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Total repayable</dt>
              <dd className="text-text tabular-nums">
                <Money amount={toUgx(totalExpected)} />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-text-muted">Intended date</dt>
              <dd className="text-text">{proposedDate}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Releasing…' : 'Yes, the money has been handed over'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Not yet
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

function CancelForm({
  loanId,
  status,
}: {
  readonly loanId: string;
  readonly status: LoanStatus;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    cancelLoanAction,
    undefined,
  );

  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="text-danger focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Cancel this loan
      </button>
    );
  }

  return (
    <Card className="space-y-3">
      <form action={formAction} className="space-y-3" noValidate>
        <input type="hidden" name="loanId" value={loanId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <Alert tone="warning">
          A cancelled loan stays in the register as history and cannot be reopened.
          {status === 'approved'
            ? ' This loan has already been approved; cancelling reverses that decision.'
            : ''}
        </Alert>

        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="cancel-reason">
            Reason
            <span aria-hidden="true" className="text-danger ml-0.5">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </Label>
          <textarea
            id="cancel-reason"
            name="reason"
            rows={2}
            maxLength={500}
            required
            aria-invalid={state?.fieldErrors?.reason !== undefined}
            className="border-border bg-surface text-text focus-visible:outline-accent aria-invalid:border-danger w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
          />
          {state?.fieldErrors?.reason?.[0] !== undefined ? (
            <p role="alert" className="text-danger text-sm">
              {state.fieldErrors.reason[0]}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Cancelling…' : 'Confirm cancellation'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Keep the loan
          </button>
        </div>
      </form>
    </Card>
  );
}
