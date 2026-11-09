import { PiggyBank } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

import { ProviderReadinessBadge } from '@/components/agency/badges';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money, MoneyStat } from '@/components/ui/money';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyFloatBalances } from '@/lib/data/agency';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Float and tills' };

/**
 * Electronic float, per provider and per till.
 *
 * Each balance is the ledger's balance of that till's own 1320-series
 * account, read from `agency_float_balances`. A provider with several tills
 * appears once per till, because they are funded and reconciled separately.
 */
export default async function AgencyFloatPage() {
  const context = await guardPermission(ROUTES.agencyFloat, 'agency:reports');
  const read = await getAgencyFloatBalances();

  const header = (
    <PageHeader
      eyebrow="Agency Banking"
      icon={PiggyBank}
      title="Float and till balances"
      description="Electronic value held with each provider, by till."
      back={{ href: ROUTES.agency, label: 'Agency Services' }}
      primaryAction={
        contextCan(context, 'agency:settlements') ? (
          <ActionLink href={ROUTES.agencyReplenish}>Top up a till</ActionLink>
        ) : undefined
      }
    />
  );

  // Every figure on this screen comes from the one read. If it did not
  // happen there is nothing honest left to render: a zero float and an
  // empty till list would both be claims about money.
  if (!read.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={read} />
      </div>
    );
  }

  const rows = read.rows;
  const total = rows.reduce((sum, r) => sum + r.balance, 0);
  const empty = rows.filter(
    (r) => r.tillIsActive && r.providerIsActive && r.balance <= 0,
  );

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <MoneyStat
          label="Float held"
          amount={toUgx(total)}
          note={`${String(rows.length)} till${rows.length === 1 ? '' : 's'}`}
        />
        <MoneyStat
          label="Tills that have run dry"
          amount={toUgx(0)}
          note={
            empty.length === 0
              ? 'None'
              : `${String(empty.length)} active till${empty.length === 1 ? '' : 's'} at zero`
          }
          tone={empty.length === 0 ? undefined : 'warning'}
        />
      </div>

      <DataTable caption="Agency float balances by provider and till" stickyHeader>
        <thead>
          <tr>
            <TableHead width="name">Provider</TableHead>
            <TableHead width="name">Till</TableHead>
            <TableHead width="ref">Branch</TableHead>
            <TableHead width="ref">Ledger account</TableHead>
            <TableHead align="numeric" width="money">
              Balance
            </TableHead>
            <TableHead width="name">Provider status</TableHead>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyTableRow colSpan={6}>
              No float till is registered at a branch you can see.
            </EmptyTableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.floatAccountId}>
                <TableCell header>{r.providerName}</TableCell>
                <TableCell>
                  {r.tillName}
                  {r.tillIsActive ? null : (
                    <span className="text-text-muted block text-[10px]">
                      Inactive till
                    </span>
                  )}
                </TableCell>
                <TableCell>{r.branchCode}</TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{r.ledgerAccountCode}</span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.balance} />
                  </span>
                </TableCell>
                <TableCell>
                  <ProviderReadinessBadge
                    isActive={r.providerIsActive}
                    isProvisional={r.providerIsProvisional}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </tbody>
      </DataTable>
    </div>
  );
}
