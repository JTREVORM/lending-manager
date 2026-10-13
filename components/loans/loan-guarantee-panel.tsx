'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { formatRecordedDate } from '@/lib/domain/client';
import { GUARANTOR_SUBJECT_LABELS } from '@/lib/domain/guarantor';
import {
  GUARANTEE_STATUS_DESCRIPTIONS,
  GUARANTEE_STATUS_LABELS,
  type GuaranteeStatus,
} from '@/lib/domain/security';
import { releaseGuarantorAction } from '@/lib/recovery/actions';
import type { GuarantorExposureRow } from '@/lib/data/security';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Who is standing for this loan, and for how much.
 *
 * ## The exposure shown is the loan's, undivided
 *
 * A guarantee in this business is joint over the whole loan — nobody signs for
 * a slice of it. So two guarantors on one loan both show the full outstanding
 * figure, and the panel says so in words rather than leaving a reader to
 * assume the two add up to the debt. Dividing it would be inventing a term
 * nobody agreed to.
 *
 * ## Releasing is a decision, not a tidy-up
 *
 * The control appears only for a holder of `guarantors:release`, and only on a
 * live loan — a draft's guarantors are *removed* from the application, and a
 * guarantee on a cleared loan ended when the borrower paid. The reason is
 * required because the guarantor is the person who will come back and ask.
 */
export function LoanGuaranteePanel({
  loanId,
  guarantees,
  canRelease,
}: {
  readonly loanId: string;
  readonly guarantees: readonly GuarantorExposureRow[];
  readonly canRelease: boolean;
}) {
  const live = guarantees.filter((row) => !row.isReleased);

  return (
    <div className="min-w-0 space-y-4">
      {guarantees.length === 0 ? (
        <Card>
          <p className="text-text-muted">No guarantors are attached to this loan.</p>
        </Card>
      ) : (
        <>
          {live.length > 1 ? (
            <Alert tone="info">
              {live.length} guarantors stand for this loan jointly. Each is shown against
              the whole outstanding balance, because that is what each of them signed for
              — the figures are not a division of the debt.
            </Alert>
          ) : null}

          <ul className="min-w-0 space-y-2">
            {guarantees.map((row) => (
              <li key={row.loanGuarantorId}>
                <GuaranteeRow
                  loanId={loanId}
                  row={row}
                  canRelease={canRelease && !row.isReleased}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const STATUS_TONES: Readonly<
  Record<GuaranteeStatus, 'neutral' | 'info' | 'success' | 'warning'>
> = {
  proposed: 'neutral',
  unsigned: 'warning',
  binding: 'info',
  released: 'neutral',
  discharged: 'success',
  void: 'neutral',
};

function GuaranteeRow({
  loanId,
  row,
  canRelease,
}: {
  readonly loanId: string;
  readonly row: GuarantorExposureRow;
  readonly canRelease: boolean;
}) {
  const [releasing, setReleasing] = useState(false);

  return (
    <div className="border-border bg-surface min-w-0 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text font-medium break-words">{row.guarantorName}</p>
          <p className="text-text-muted text-sm break-words">
            {GUARANTOR_SUBJECT_LABELS[row.subjectKind]} · {row.relationshipToClient} ·{' '}
            {row.guarantorPhone}
            {row.guarantorClientNumber === null ? '' : ` · ${row.guarantorClientNumber}`}
          </p>
        </div>

        <Badge tone={STATUS_TONES[row.guaranteeStatus]}>
          {GUARANTEE_STATUS_LABELS[row.guaranteeStatus]}
        </Badge>
      </div>

      <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">Guaranteed</dt>
          <dd className="text-text font-semibold tabular-nums">
            <Money amount={row.guaranteedAmount} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">Still outstanding</dt>
          <dd className="text-text font-semibold tabular-nums">
            {row.outstandingBalance === null ? (
              '—'
            ) : (
              <Money amount={row.outstandingBalance} />
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-text-muted text-sm">Signed</dt>
          <dd className="text-text font-semibold">
            {row.guaranteeDate === null
              ? 'Not signed'
              : formatRecordedDate(row.guaranteeDate)}
          </dd>
        </div>
      </dl>

      <p className="text-text-muted mt-2 text-sm break-words">
        {GUARANTEE_STATUS_DESCRIPTIONS[row.guaranteeStatus]}
      </p>

      {row.releasedAt === null ? null : (
        <p className="text-text-muted mt-1 text-sm break-words">
          Released {formatRecordedDate(row.releasedAt)}
          {row.releaseReason === null ? '' : ` — ${row.releaseReason}`}
        </p>
      )}

      {canRelease ? (
        <div className="mt-3 min-w-0">
          {releasing ? (
            <ReleaseForm
              loanId={loanId}
              row={row}
              onCancel={() => {
                setReleasing(false);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setReleasing(true);
              }}
              className="text-brand-700 focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Release this guarantor
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ReleaseForm({
  loanId,
  row,
  onCancel,
}: {
  readonly loanId: string;
  readonly row: GuarantorExposureRow;
  readonly onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    releaseGuarantorAction,
    undefined,
  );

  return (
    <form action={formAction} className="min-w-0 space-y-3" noValidate>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="loanGuarantorId" value={row.loanGuarantorId} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <Alert tone="warning">
        This discharges {row.guarantorName}&apos;s liability on money already lent. It
        cannot be undone or reworded afterwards, and the loan must keep the number of
        guarantors its product requires.
      </Alert>

      <Field
        label="Why they are being released"
        name="releaseReason"
        required
        hint="Security substituted, a replacement guarantor, a decision on appeal — say which."
        error={state?.fieldErrors?.releaseReason?.[0]}
      />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? 'Releasing…' : 'Release the guarantor'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
