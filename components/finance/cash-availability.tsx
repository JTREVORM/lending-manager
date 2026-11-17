import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { cn } from '@/lib/utils/cn';
import type { CashAccountAvailability } from '@/lib/domain/finance';

export interface CashAvailabilityProps {
  readonly accounts: readonly CashAccountAvailability[];
  readonly className?: string;
}

/**
 * Booked, restricted and available, per account.
 *
 * Deliberately per account and with no total. A branch's liquidity is never a
 * funding source — the money has to be in the account it is leaving — and a
 * total on this card is exactly the figure somebody would reason from.
 */
export function CashAvailability({ accounts, className }: CashAvailabilityProps) {
  const shown = accounts.filter(
    (a) =>
      a.cashKind !== 'agency_float' && (a.booked !== 0 || a.pendingConfirmation !== 0),
  );

  if (shown.length === 0) return null;

  return (
    <section aria-labelledby="availability-heading" className={cn('min-w-0', className)}>
      <h2 id="availability-heading" className="text-text text-sm font-semibold">
        What each account can pay out
      </h2>
      <p className="text-text-muted mt-1 text-xs">
        Available is the ledger balance less the receipts nobody has confirmed yet. It is
        the only figure a payout is measured against.
      </p>

      <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((account) => {
          const restricted = account.pendingConfirmation > 0;
          return (
            <Card key={account.accountId} className="min-w-0 p-4">
              <p className="text-text-muted text-xs font-medium">{account.name}</p>
              <p className="text-text mt-1 text-lg font-semibold tabular-nums">
                <Money amount={account.available} />
              </p>
              <p className="text-text-muted mt-1 text-[11px]">available to pay out</p>

              {restricted ? (
                <p className="text-warning mt-2 text-[11px] font-medium">
                  <Money amount={account.pendingConfirmation} /> of{' '}
                  <Money amount={account.booked} /> is awaiting confirmation
                  {account.pendingReceipts > 0
                    ? ` (${String(account.pendingReceipts)} receipt${
                        account.pendingReceipts === 1 ? '' : 's'
                      })`
                    : ''}
                </p>
              ) : (
                <p className="text-text-muted mt-2 text-[11px]">
                  Ledger balance <Money amount={account.booked} />
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
