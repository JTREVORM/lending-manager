'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import {
  authoriseCommissionExceptionAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import { toUgx } from '@/lib/domain/money';

/**
 * The Owner's commission exception.
 *
 * Its own control, not a field on the recording form, and that split is the
 * point: an operator-typed commission is how recognised income becomes
 * whatever somebody entered, so the counter has no commission field at all
 * and a difference from the provider's configured terms is a decision an
 * Owner makes, with a reason and something checkable to point at.
 *
 * Three things the database does and this form does not:
 *
 *  - It refuses anybody without `agency:commission_exception` with SQLSTATE
 *    42501, before it reads the transaction. Rendering this control only for
 *    an Owner is a courtesy; it is not the control.
 *  - It **pins** the authorised figure and the figure the terms produced at
 *    that moment, and `post_agency_transaction` refuses to post if either has
 *    moved since. An authorisation of 1,800 cannot become a posting of
 *    50,000, whether through a later edit or a provider re-rating.
 *  - It writes the figure **before** and after into the audit trail, so a
 *    change made after the transaction was submitted is visible to the
 *    officer who verifies it rather than quiet.
 *
 * Verification is untouched: the Owner authorises the difference, a Manager
 * still posts it, and the database still refuses an officer verifying their
 * own entry.
 */
export function CommissionExceptionForm({
  transactionId,
  computed,
  supplied,
  alreadyAuthorised,
}: {
  readonly transactionId: string;
  /** What the provider's configured terms produce. */
  readonly computed: number | null;
  /** What the transaction currently carries, if anything. */
  readonly supplied: number | null;
  readonly alreadyAuthorised: boolean;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(authoriseCommissionExceptionAction, undefined);

  if (alreadyAuthorised) {
    return (
      <Alert tone="info">
        A difference has already been authorised on this transaction. Authorising again is
        refused; the figures are pinned and the posting engine checks them.
      </Alert>
    );
  }

  return (
    <form
      action={submit}
      className="border-border bg-surface-sunken min-w-0 space-y-3 rounded-lg border p-3"
    >
      <input type="hidden" name="transactionId" value={transactionId} />

      <div className="min-w-0">
        <p className="text-text-muted text-xs font-medium">
          The configured terms produce
        </p>
        <p className="mt-0.5 text-sm font-semibold">
          {computed === null ? '—' : <Money amount={toUgx(computed)} />}
        </p>
        {supplied === null ? null : (
          <p className="text-text-muted mt-1 text-xs">
            Currently carries <Money amount={toUgx(supplied)} />.
          </p>
        )}
      </div>

      <Field
        label="Commission to authorise (UGX)"
        name="proposedAmount"
        inputMode="numeric"
        required
        hint="A whole number of shillings. Must differ from the figure above, and cannot exceed the principal."
        error={result?.fieldErrors?.proposedAmount?.[0]}
      />

      <Field
        label="Reason"
        name="reason"
        required
        autoComplete="off"
        hint="Why the provider's terms do not describe this one."
        error={result?.fieldErrors?.reason?.[0]}
      />

      <Field
        label="External evidence"
        name="evidence"
        required
        autoComplete="off"
        hint="A provider statement number, a handset reference, a ticket — something somebody else could check."
        error={result?.fieldErrors?.evidence?.[0]}
      />

      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Authorise this difference
      </Button>
      <p className="text-text-muted text-xs">
        The figure and the terms are both recorded now. If either changes afterwards,
        posting is refused until it is authorised again.
      </p>

      {result === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      )}
    </form>
  );
}
