import { Landmark } from 'lucide-react';

import { PayableSettlementRegister } from '@/components/agency/settlement-registers';
import { PayableSettlementForm } from '@/components/agency/settlement-forms';
import { Alert } from '@/components/ui/alert';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyPayables, getAgencyPayableSettlements } from '@/lib/data/agency';
import { getLedgerAccounts } from '@/lib/data/finance';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Provider remittances' };

/**
 * Money collected on a provider's behalf, and what has been handed over.
 *
 * Attributed per provider and per branch by `agency_payable_summary`, never
 * from the shared 2200-series accounts: every partner bank posts to 2220, so
 * one bank's collections must never appear to fund another's remittance.
 */
export default async function AgencyPayablesPage() {
  const context = await guardPermission(ROUTES.agencyPayables, 'agency:reports');

  const [rows, settlements, accounts] = await Promise.all([
    getAgencyPayables(),
    getAgencyPayableSettlements({ limit: 100 }),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  const paying = accounts
    .filter((a) => a.cashKind === 'cash_at_hand' || a.cashKind === 'bank')
    .map((a) => ({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      branchId: a.branchId,
    }));

  const collected = rows.reduce((sum, r) => sum + r.collected, 0);
  const remitted = rows.reduce((sum, r) => sum + r.remitted, 0);
  const outstanding = rows.reduce((sum, r) => sum + r.outstanding, 0);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Landmark}
        title="Provider remittances"
        description="Collected at the counter on somebody else's behalf, and owed out."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <MoneyStat
          label="Collected"
          amount={toUgx(collected)}
          note="On providers' behalf"
        />
        <MoneyStat label="Remitted" amount={toUgx(remitted)} note="Handed over" />
        <MoneyStat
          label="Still held"
          amount={toUgx(outstanding)}
          note="Owed out, not ours"
        />
      </div>

      <DataTable caption="Provider payables by provider and branch" stickyHeader>
        <thead>
          <tr>
            <TableHead width="name">Provider</TableHead>
            <TableHead width="ref">Branch</TableHead>
            <TableHead align="numeric" width="money">
              Collected
            </TableHead>
            <TableHead align="numeric" width="money">
              Remitted
            </TableHead>
            <TableHead align="numeric" width="money">
              Reversed
            </TableHead>
            <TableHead align="numeric" width="money">
              Still held
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyTableRow colSpan={6}>
              Nothing has been collected on a provider&rsquo;s behalf at a branch you can
              see.
            </EmptyTableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={`${r.providerId}-${r.branchId}`}>
                <TableCell header>{r.providerName}</TableCell>
                <TableCell>{r.branchCode}</TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.collected} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.remitted} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.remittanceReversed} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="font-semibold tabular-nums">
                    <Money amount={r.outstanding} />
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </tbody>
      </DataTable>

      {contextCan(context, 'agency:settlements') ? (
        <PayableSettlementForm rows={rows} accounts={paying} />
      ) : (
        <Alert tone="info">
          Handing collections over needs the settlement capability.
        </Alert>
      )}

      <PayableSettlementRegister
        rows={settlements}
        canReverse={contextCan(context, 'agency:reverse')}
      />
    </div>
  );
}
