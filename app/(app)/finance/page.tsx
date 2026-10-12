import { ArrowLeftRight, Landmark, Receipt, Scale, ScrollText } from 'lucide-react';
import Link from 'next/link';

import { CashPosition } from '@/components/finance/cash-position';
import { Card } from '@/components/ui/card';
import { PageHeader, SectionHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCashPositions, getFinanceSettings } from '@/lib/data/finance';
import { CASH_KIND_LABELS } from '@/lib/domain/finance';
import { toUgx } from '@/lib/domain/money';
import type { CashKind } from '@/lib/domain/finance';
import type { UgxAmount } from '@/lib/domain/money';

export const metadata = { title: 'Finance' };

/**
 * Where the money is, and the four ways it moves.
 *
 * The liquidity cards read `branch_cash_position`, which reads the ledger.
 * Nothing on this page adds up payment rows to reach a balance: that was the
 * whole point of giving the business a ledger, and a card that re-derived it
 * would be a second answer to a question that already has one.
 */
export default async function FinancePage() {
  const context = await guardPermission(ROUTES.finance, 'ledger:view');

  const [positions, settings] = await Promise.all([
    getCashPositions(),
    getFinanceSettings(),
  ]);

  const lowBalances: Readonly<Record<CashKind, UgxAmount>> | undefined =
    settings === null
      ? undefined
      : {
          cash_at_hand: settings.lowBalanceCashAtHand,
          mtn_mobile_money: settings.lowBalanceMtn,
          airtel_money: settings.lowBalanceAirtel,
          bank: settings.lowBalanceBank,
        };

  const destinations = [
    {
      href: ROUTES.transfers,
      label: 'Transfers',
      description: 'Move money between the company’s own accounts.',
      icon: ArrowLeftRight,
      visible: contextCan(context, 'transfers:view'),
    },
    {
      href: ROUTES.expenses,
      label: 'Expenses',
      description: 'What the business spent, and out of which account.',
      icon: Receipt,
      visible: contextCan(context, 'expenses:view'),
    },
    {
      href: ROUTES.otherIncome,
      label: 'Other income',
      description: 'Fees and income that is not interest or a penalty.',
      icon: Landmark,
      visible: contextCan(context, 'income:view'),
    },
    {
      href: ROUTES.reconciliation,
      label: 'Reconciliation',
      description: 'Count an account against what the ledger says.',
      icon: Scale,
      visible: contextCan(context, 'reconciliation:view'),
    },
    {
      href: ROUTES.ledger,
      label: 'General ledger',
      description: 'Every posting, with the event behind it.',
      icon: ScrollText,
      visible: contextCan(context, 'ledger:view'),
    },
  ].filter((entry) => entry.visible);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Landmark}
        title="Finance"
        description="Where the money is, and everything that moved it."
      />

      <section className="min-w-0 space-y-3">
        <SectionHeader title="Cash position" />
        <CashPosition positions={positions} lowBalances={lowBalances} />
        <p className="text-text-muted text-xs">
          Read from the ledger. Every figure is the sum of its account’s postings, so it
          agrees with the trial balance by construction.
        </p>
      </section>

      <section className="min-w-0 space-y-3">
        <SectionHeader title="Money movement" />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {destinations.map(({ href, label, description, icon: Icon }) => (
            <Link key={href} href={href} className="min-w-0">
              <Card className="hover:border-accent/40 min-w-0 p-4 transition-colors">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="bg-accent-surface text-accent grid size-9 shrink-0 place-items-center rounded-lg">
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-text text-sm font-semibold">{label}</p>
                    <p className="text-text-muted mt-0.5 text-xs">{description}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      {settings === null ? null : (
        <section className="min-w-0 space-y-3">
          <SectionHeader title="Controls in force" />
          <Card className="min-w-0 p-4">
            <dl className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Control
                label="Transfers need approval above"
                value={
                  settings.transferApprovalThreshold === null
                    ? 'Never'
                    : formatThreshold(settings.transferApprovalThreshold)
                }
              />
              <Control
                label="Expenses need approval above"
                value={
                  settings.expenseApprovalThreshold === null
                    ? 'Never'
                    : formatThreshold(settings.expenseApprovalThreshold)
                }
              />
              <Control
                label="An account may go overdrawn"
                value={settings.allowNegativeCash ? 'Yes' : 'No'}
              />
              <Control
                label="A difference needs a second person"
                value={settings.reconciliationRequiresReview ? 'Yes' : 'No'}
              />
            </dl>
            <p className="text-text-muted mt-3 text-xs">
              Low-float warnings:{' '}
              {(
                [
                  ['cash_at_hand', settings.lowBalanceCashAtHand],
                  ['mtn_mobile_money', settings.lowBalanceMtn],
                  ['airtel_money', settings.lowBalanceAirtel],
                  ['bank', settings.lowBalanceBank],
                ] as const
              )
                .map(
                  ([kind, amount]) =>
                    `${CASH_KIND_LABELS[kind]} ${formatThreshold(amount)}`,
                )
                .join(' · ')}
            </p>
          </Card>
        </section>
      )}
    </div>
  );
}

function formatThreshold(amount: UgxAmount): string {
  return new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency: 'UGX',
    maximumFractionDigits: 0,
  }).format(toUgx(amount));
}

function Control({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm font-semibold">{value}</dd>
    </div>
  );
}
