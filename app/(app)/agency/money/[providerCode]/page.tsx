import { Smartphone } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { FloatTradeForm } from '@/components/agency/float-trade-forms';
import { FloatTradeRegister } from '@/components/agency/float-trade-register';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyFloatTrades,
  getAgencyMoneyDashboard,
  getAgencyProviders,
} from '@/lib/data/agency';
import { getLedgerAccounts } from '@/lib/data/finance';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Mobile Money' };

/**
 * One provider's Mobile Money operation.
 *
 * ## Why this screen is driven by the provider's row
 *
 * MTN and Airtel are the same accounting and different configuration: the
 * commission source, the fee handling and the ceilings are all columns, and
 * this screen reads them. Writing a second screen for the second provider
 * would be writing a second set of figures that could disagree with the
 * ledger, which is exactly what the brief asked us not to do.
 *
 * ## Why the float trade form is here and not on the counter screen
 *
 * Buying and selling float is not a customer transaction. It needs a
 * different capability (`agency:float_trade`), it is checked by a second
 * officer before it posts, and it moves our own money rather than a
 * customer's. Keeping it off `/agency/record` keeps the counter screen about
 * the person standing at the counter.
 */
export default async function AgencyMoneyProviderPage({
  params,
}: {
  readonly params: Promise<{ readonly providerCode: string }>;
}) {
  const { providerCode } = await params;
  const context = await guardPermission(ROUTES.agencyMoney, 'agency:reports');

  const [providers, lines, trades, accounts] = await Promise.all([
    getAgencyProviders(),
    getAgencyMoneyDashboard({ providerCode }),
    getAgencyFloatTrades({ providerCode, limit: 100 }),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  // An unknown code is a 404 — but only when the provider register was
  // actually read. A failed read must not become "no such provider".
  if (providers.ok && !providers.rows.some((p) => p.code === providerCode)) {
    notFound();
  }

  const provider = providers.ok
    ? providers.rows.find((p) => p.code === providerCode)
    : undefined;
  const providerName = provider?.name ?? providerCode;

  const header = (
    <PageHeader
      eyebrow="Mobile Money"
      icon={Smartphone}
      title={providerName}
      description="The agent lines, their float, and the float bought, sold and moved between them."
      back={{ href: ROUTES.agencyMoney, label: 'Mobile Money' }}
      status={
        provider === undefined ? null : (
          <Badge tone={provider.isActive ? 'success' : 'warning'}>
            {provider.isActive ? 'active' : 'not activated'}
          </Badge>
        )
      }
    />
  );

  if (!lines.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        {providers.ok ? null : <AgencyReadError failure={providers} />}
        <AgencyReadError failure={lines} />
      </div>
    );
  }

  const floatHeld = lines.rows.reduce((sum, l) => sum + l.floatBalance, 0);
  const commission = lines.rows.reduce((sum, l) => sum + l.commissionOutstanding, 0);
  const recovery = lines.rows.reduce((sum, l) => sum + l.recoveryOwed, 0);

  const settling = accounts
    .filter((a) => a.cashKind === 'cash_at_hand' || a.cashKind === 'bank')
    .map((a) => ({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      branchId: a.branchId,
    }));

  const canTrade = contextCan(context, 'agency:float_trade');

  return (
    <div className="min-w-0 space-y-4">
      {header}

      {providers.ok ? null : <AgencyReadError failure={providers} />}

      <nav aria-label="This provider" className="flex min-w-0 flex-wrap gap-2">
        <Link
          href={`${ROUTES.agencyMoney}/${providerCode}/commission`}
          className="border-border bg-surface hover:bg-surface-sunken focus-visible:ring-brand rounded-lg border px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Commission
        </Link>
        <Link
          href={`${ROUTES.agencyMoney}/${providerCode}/statements`}
          className="border-border bg-surface hover:bg-surface-sunken focus-visible:ring-brand rounded-lg border px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Statements
        </Link>
      </nav>

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <MoneyStat label="Float held" amount={toUgx(floatHeld)} note="On these lines" />
        <MoneyStat
          label="Commission owed to us"
          amount={toUgx(commission)}
          note="Earned, not yet paid in"
        />
        <MoneyStat
          label="Owed back"
          amount={toUgx(recovery)}
          note="Recovered after reversals"
          tone={recovery > 0 ? 'warning' : undefined}
        />
      </div>

      <DataTable caption={`${providerName} agent lines`} stickyHeader>
        <thead>
          <tr>
            <TableHead width="name">Line</TableHead>
            <TableHead width="ref">Branch</TableHead>
            <TableHead>Status</TableHead>
            <TableHead align="numeric" width="money">
              Float
            </TableHead>
            <TableHead align="numeric" width="money">
              Deposits today
            </TableHead>
            <TableHead align="numeric" width="money">
              Withdrawals today
            </TableHead>
            <TableHead align="numeric" width="money">
              Commission today
            </TableHead>
            <TableHead align="numeric" width="money">
              Fees today
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {lines.rows.length === 0 ? (
            <EmptyTableRow colSpan={8}>
              {providerName} has no agent line at a branch you can see.
            </EmptyTableRow>
          ) : (
            lines.rows.map((l) => (
              <TableRow key={l.floatAccountId}>
                <TableCell header>
                  {l.label ?? l.tillName}
                  <span className="text-muted block font-mono text-xs">
                    {l.ledgerAccountCode}
                  </span>
                </TableCell>
                <TableCell>{l.branchCode}</TableCell>
                <TableCell>
                  <Badge
                    tone={
                      l.lineStatus === 'active'
                        ? 'success'
                        : l.lineStatus === 'suspended'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {l.lineStatus}
                  </Badge>
                </TableCell>
                <TableCell align="numeric">
                  <span className="font-semibold tabular-nums">
                    <Money amount={l.floatBalance} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={l.depositValueToday} />
                  </span>
                  <span className="text-muted block text-xs">{l.depositsToday}</span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={l.withdrawalValueToday} />
                  </span>
                  <span className="text-muted block text-xs">{l.withdrawalsToday}</span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={l.commissionToday} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={l.customerFeesToday} />
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </tbody>
      </DataTable>

      {canTrade ? (
        <FloatTradeForm
          lines={lines.rows}
          accounts={settling}
          providerName={providerName}
        />
      ) : (
        <Alert tone="info">
          Buying, selling and moving float needs the float trading capability. You can see
          the register but not add to it.
        </Alert>
      )}

      {trades.ok ? (
        <FloatTradeRegister
          rows={trades.rows}
          canPost={contextCan(context, 'agency:verify')}
          canReverse={contextCan(context, 'agency:reverse')}
        />
      ) : (
        <AgencyReadError failure={trades} />
      )}
    </div>
  );
}
