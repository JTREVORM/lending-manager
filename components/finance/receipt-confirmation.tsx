'use client';

import { useActionState, useState } from 'react';
import { CheckCheck } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import {
  confirmCashReceiptsAction,
  type FinanceActionResult,
} from '@/lib/finance/actions';
import { RECEIPT_SOURCE_LABELS, type PendingReceiptRow } from '@/lib/domain/finance';
import { cn } from '@/lib/utils/cn';

export interface ReceiptConfirmationProps {
  readonly receipts: readonly PendingReceiptRow[];
  readonly canConfirm: boolean;
  readonly className?: string;
}

/**
 * The drawer, waiting to be counted.
 *
 * Confirming is a batch because that is how the work happens: a supervisor
 * counts a till at the end of the day, not one receipt at a time. The
 * database performs every per-receipt check inside the batch all the same —
 * a receipt this officer recorded themselves is refused by name and the rest
 * are confirmed — so the action reports both numbers rather than claiming a
 * clean sweep.
 *
 * Nothing here decides who may confirm. The button is hidden without the
 * capability; the refusal of a person confirming their own receipt is a
 * CHECK constraint and a function raise, and would stop this form even if
 * somebody reached it.
 */
export function ReceiptConfirmation({
  receipts,
  canConfirm,
  className,
}: ReceiptConfirmationProps) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [result, submit, pending] = useActionState<
    FinanceActionResult | undefined,
    FormData
  >(confirmCashReceiptsAction, undefined);

  const toggle = (id: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const total = receipts
    .filter((r) => chosen.has(r.id))
    .reduce((sum, r) => sum + r.amount, 0);

  return (
    <section
      aria-labelledby="pending-receipts-heading"
      className={cn('min-w-0', className)}
    >
      <h2 id="pending-receipts-heading" className="text-text text-sm font-semibold">
        Awaiting confirmation
      </h2>

      {result !== undefined ? (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mt-3">
          {result.message}
        </Alert>
      ) : null}

      {receipts.length === 0 ? (
        <Card className="mt-3 p-4">
          <p className="text-text-muted text-sm">
            Nothing is waiting. Every receipt recorded so far has been counted, so the
            ledger balance and the available balance are the same figure.
          </p>
        </Card>
      ) : (
        <form action={submit} className="mt-3 space-y-3">
          <Card className="divide-border min-w-0 divide-y p-0">
            {receipts.map((receipt) => (
              <label
                key={receipt.id}
                className="flex min-w-0 cursor-pointer items-start gap-3 p-4"
              >
                <input
                  type="checkbox"
                  name="confirmationIds"
                  value={receipt.id}
                  checked={chosen.has(receipt.id)}
                  onChange={() => {
                    toggle(receipt.id);
                  }}
                  disabled={!canConfirm || pending}
                  className="mt-1 size-4 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="text-text block text-sm font-medium tabular-nums">
                    <Money amount={receipt.amount} />
                  </span>
                  <span className="text-text-muted block text-xs">
                    {RECEIPT_SOURCE_LABELS[receipt.sourceType] ?? receipt.sourceType} ·{' '}
                    {receipt.accountName} · recorded by {receipt.recordedByLabel}
                  </span>
                </span>
              </label>
            ))}
          </Card>

          {canConfirm ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={chosen.size === 0 || pending}>
                <CheckCheck aria-hidden="true" className="size-4" />
                {pending
                  ? 'Confirming…'
                  : `Confirm ${String(chosen.size)} receipt${chosen.size === 1 ? '' : 's'}`}
              </Button>
              {chosen.size > 0 ? (
                <p className="text-text-muted text-xs">
                  Releasing <Money amount={total} /> for payout.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-text-muted text-xs">
              Counting the drawer is a Manager&rsquo;s or the Owner&rsquo;s act, and never
              the person who recorded the money.
            </p>
          )}
        </form>
      )}
    </section>
  );
}
