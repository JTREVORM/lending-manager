import { Banknote, Landmark, Smartphone, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { cn } from '@/lib/utils/cn';
import {
  CASH_KIND_LABELS,
  type BranchCashPosition,
  type CashKind,
} from '@/lib/domain/finance';
import type { UgxAmount } from '@/lib/domain/money';

const ICONS: Readonly<Record<CashKind, LucideIcon>> = {
  cash_at_hand: Banknote,
  mtn_mobile_money: Smartphone,
  airtel_money: Smartphone,
  bank: Landmark,
};

export interface CashPositionProps {
  readonly positions: readonly BranchCashPosition[];
  /**
   * What counts as low, per kind. A float below its threshold is flagged —
   * amber, and in words, because a cashier who cannot see the colour still
   * has to know before they set out for the day.
   */
  readonly lowBalances?: Readonly<Record<CashKind, UgxAmount>>;
  readonly className?: string;
}

/**
 * Where the company's money is.
 *
 * Reads `branch_cash_position`, which reads the ledger. No figure on this
 * component is added up from payment rows: the whole point of Phase 10 was
 * that a cash balance is an accounting fact rather than a sum over
 * operational records, and a card that re-derived it would be a second
 * answer to a question that already has one.
 */
export function CashPosition({ positions, lowBalances, className }: CashPositionProps) {
  if (positions.length === 0) return null;

  // One branch today. The totals row is rendered only when there is more than
  // one, because a total of one thing is noise.
  const multi = positions.length > 1;

  const totals = positions.reduce(
    (sum, p) => ({
      cash_at_hand: sum.cash_at_hand + p.cashAtHand,
      mtn_mobile_money: sum.mtn_mobile_money + p.mtnMobileMoney,
      airtel_money: sum.airtel_money + p.airtelMoney,
      bank: sum.bank + p.cashAtBank,
      total: sum.total + p.totalLiquidity,
    }),
    { cash_at_hand: 0, mtn_mobile_money: 0, airtel_money: 0, bank: 0, total: 0 },
  );

  const shown: readonly { kind: CashKind; amount: number }[] = [
    { kind: 'cash_at_hand', amount: totals.cash_at_hand },
    { kind: 'mtn_mobile_money', amount: totals.mtn_mobile_money },
    { kind: 'airtel_money', amount: totals.airtel_money },
    { kind: 'bank', amount: totals.bank },
  ];

  return (
    <div className={cn('min-w-0 space-y-3', className)}>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {shown.map(({ kind, amount }) => {
          const Icon = ICONS[kind];
          const threshold = lowBalances?.[kind];
          const low = threshold !== undefined && amount < threshold;

          return (
            <Card key={kind} className="min-w-0 p-4">
              <div className="flex min-w-0 items-start justify-between gap-2">
                <p className="text-text-muted text-xs font-medium">
                  {CASH_KIND_LABELS[kind]}
                </p>
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'size-4 shrink-0',
                    low ? 'text-warning' : 'text-text-muted',
                  )}
                />
              </div>
              <p className="text-text mt-1 text-lg font-semibold tabular-nums">
                <Money amount={amount} />
              </p>
              {low ? (
                // Said in words as well as colour. A printed cash sheet is
                // black and white, and so is a colour-blind reader's screen.
                <p className="text-warning mt-1 text-[11px] font-medium">Running low</p>
              ) : null}
            </Card>
          );
        })}

        <Card className="bg-surface-sunken min-w-0 p-4">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <p className="text-text-muted text-xs font-medium">Total liquidity</p>
            <Wallet aria-hidden="true" className="text-accent size-4 shrink-0" />
          </div>
          <p className="text-text mt-1 text-lg font-semibold tabular-nums">
            <Money amount={totals.total} />
          </p>
          <p className="text-text-muted mt-1 text-[11px]">
            {multi
              ? `Across ${String(positions.length)} branches`
              : positions[0]?.branchName}
          </p>
        </Card>
      </div>

      {multi ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {positions.map((position) => (
            <Card key={position.branchId} className="min-w-0 p-4">
              <p className="text-text text-sm font-semibold">{position.branchName}</p>
              <dl className="mt-2 space-y-1">
                {(
                  [
                    ['cash_at_hand', position.cashAtHand],
                    ['mtn_mobile_money', position.mtnMobileMoney],
                    ['airtel_money', position.airtelMoney],
                    ['bank', position.cashAtBank],
                  ] as const
                ).map(([kind, amount]) => (
                  <div key={kind} className="flex min-w-0 justify-between gap-2 text-xs">
                    <dt className="text-text-muted truncate">{CASH_KIND_LABELS[kind]}</dt>
                    <dd className="text-text shrink-0 tabular-nums">
                      <Money amount={amount} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
