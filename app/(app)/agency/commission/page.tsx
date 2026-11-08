import { HandCoins } from 'lucide-react';

import { CommissionSettlementRegister } from '@/components/agency/settlement-registers';
import { CommissionSettlementForm } from '@/components/agency/settlement-forms';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { Alert } from '@/components/ui/alert';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyCommission, getAgencyCommissionSettlements } from '@/lib/data/agency';
import { getLedgerAccounts } from '@/lib/data/finance';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Commission' };

/**
 * Commission earned, received and still outstanding.
 *
 * Every column comes from `agency_commission_summary`, which attributes GL
 * 1310 per provider and per branch by source entity — the account is shared
 * between providers, so an account-level total would mix them. Nothing on
 * this page adds a provider's figures up differently from the database.
 */
export default async function AgencyCommissionPage() {
  const context = await guardPermission(ROUTES.agencyCommission, 'agency:reports');

  const [rows, settlements, accounts] = await Promise.all([
    getAgencyCommission(),
    getAgencyCommissionSettlements({ limit: 100 }),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  const receiving = accounts
    .filter((a) => a.cashKind === 'cash_at_hand' || a.cashKind === 'bank')
    .map((a) => ({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      branchId: a.branchId,
    }));

  const earned = rows.reduce((sum, r) => sum + r.earned, 0);
  const received = rows.reduce((sum, r) => sum + r.received, 0);
  const outstanding = rows.reduce((sum, r) => sum + r.outstanding, 0);
  const canSettle = contextCan(context, 'agency:settlements');

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={HandCoins}
        title="Commission"
        description="What the providers owe us, what they have remitted, and what is still due."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <MoneyStat label="Earned" amount={toUgx(earned)} note="Recognised at posting" />
        <MoneyStat label="Received" amount={toUgx(received)} note="Remitted to us" />
        <MoneyStat label="Outstanding" amount={toUgx(outstanding)} note="Still owed" />
      </div>

      <DataTable caption="Commission by provider and branch" stickyHeader>
        <thead>
          <tr>
            <TableHead width="name">Provider</TableHead>
            <TableHead width="ref">Branch</TableHead>
            <TableHead align="numeric" width="money">
              Earned
            </TableHead>
            <TableHead align="numeric" width="money">
              Received
            </TableHead>
            <TableHead align="numeric" width="money">
              Returned
            </TableHead>
            <TableHead align="numeric" width="money">
              Outstanding
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyTableRow colSpan={6}>
              No commission has accrued at a branch you can see.
            </EmptyTableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={`${r.providerId}-${r.branchId}`}>
                <TableCell header>{r.providerName}</TableCell>
                <TableCell>{r.branchCode}</TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.earned} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.received} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.returned} />
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

      {canSettle ? (
        <CommissionSettlementForm rows={rows} accounts={receiving} />
      ) : (
        <Alert tone="info">
          Recording a remittance needs the settlement capability. You can see what is
          outstanding but not clear it.
        </Alert>
      )}

      <CommissionSettlementRegister
        rows={settlements}
        canReverse={contextCan(context, 'agency:reverse')}
      />
    </div>
  );
}
