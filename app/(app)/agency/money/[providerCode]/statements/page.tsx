import { FileCheck } from 'lucide-react';

import {
  CommissionReconciliationDecision,
  CommissionReconciliationForm,
} from '@/components/agency/commission-money-forms';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyCommissionReconciliations,
  getAgencyLineCommission,
} from '@/lib/data/agency';

export const metadata = { title: 'Provider statements' };

/**
 * Reconciling the provider's commission statement.
 *
 * ## What certification is, and is not
 *
 * Decision OD-2 settled this: a reconciliation records our figure, the
 * provider's figure and the difference, and certifying it means a second
 * officer has seen that difference. It writes no journal line of any kind.
 * A real difference is corrected at the transaction that was wrong, or
 * adjusted on the Owner's authority with its own entry — never by this
 * screen, and never silently.
 *
 * ## Why "what the books say now" is a separate column
 *
 * The snapshot is what our books recognised over the statement period at the
 * moment the reconciliation was submitted. If a transaction in that period
 * is reversed afterwards, the period's figure changes and the recorded
 * variance no longer describes the books. The two columns side by side are
 * the only way an officer can tell that has happened.
 */
export default async function AgencyMoneyStatementsPage({
  params,
}: {
  readonly params: Promise<{ readonly providerCode: string }>;
}) {
  const { providerCode } = await params;
  const context = await guardPermission(ROUTES.agencyMoney, 'agency:reports');

  const [rows, lines] = await Promise.all([
    getAgencyCommissionReconciliations({ providerCode, limit: 100 }),
    getAgencyLineCommission({ providerCode }),
  ]);

  const canReconcile = contextCan(context, 'agency:reconcile');

  const header = (
    <PageHeader
      eyebrow="Mobile Money"
      icon={FileCheck}
      title="Provider statements"
      description="What the provider's statement says, what our books say, and the difference between them."
      back={{
        href: `${ROUTES.agencyMoney}/${providerCode}`,
        label: 'Back to the provider',
      }}
    />
  );

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <Alert tone="info">
        Certifying a statement records that a second officer has seen the difference. It
        changes no balance. A real difference has to be corrected at the transaction, or
        adjusted on the Owner&rsquo;s authority.
      </Alert>

      {rows.ok ? (
        <DataTable caption="Statement reconciliations" stickyHeader>
          <thead>
            <tr>
              <TableHead width="ref">Period</TableHead>
              <TableHead width="name">Line</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead align="numeric" width="money">
                Our books
              </TableHead>
              <TableHead align="numeric" width="money">
                The statement
              </TableHead>
              <TableHead align="numeric" width="money">
                Difference
              </TableHead>
              <TableHead align="numeric" width="money">
                Our books now
              </TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Decision</TableHead>
            </tr>
          </thead>
          <tbody>
            {rows.rows.length === 0 ? (
              <EmptyTableRow colSpan={9}>
                No statement has been reconciled for a line you can see.
              </EmptyTableRow>
            ) : (
              rows.rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <DateValue value={r.periodStart} /> to{' '}
                    <DateValue value={r.periodEnd} />
                  </TableCell>
                  <TableCell header>
                    {r.label ?? r.tillName}
                    <span className="text-text-muted block text-xs">{r.branchCode}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{r.statementRef}</span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span className="tabular-nums">
                      <Money amount={r.systemCommissionEarned} />
                    </span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span className="tabular-nums">
                      <Money amount={r.providerReportedCommission} />
                    </span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span
                      className={
                        r.variance === 0
                          ? 'tabular-nums'
                          : 'text-warning font-semibold tabular-nums'
                      }
                    >
                      <Money amount={r.variance} />
                    </span>
                    <span className="text-text-muted block text-xs">
                      {r.varianceMeans}
                    </span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span className="tabular-nums">
                      <Money amount={r.currentSystemEarned} />
                    </span>
                    {r.currentSystemEarned === r.systemCommissionEarned ? null : (
                      <span className="text-warning block text-xs">
                        changed since it was submitted
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      tone={
                        r.status === 'certified'
                          ? r.variance === 0
                            ? 'success'
                            : 'warning'
                          : 'warning'
                      }
                    >
                      {r.status === 'certified'
                        ? r.variance === 0
                          ? 'agreed'
                          : 'certified, still different'
                        : 'open'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <CommissionReconciliationDecision row={r} canCertify={canReconcile} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </tbody>
        </DataTable>
      ) : (
        <AgencyReadError failure={rows} />
      )}

      {!canReconcile ? (
        <Alert tone="info">
          Submitting and certifying a statement needs the reconciliation capability.
        </Alert>
      ) : lines.ok ? (
        <CommissionReconciliationForm lines={lines.rows} />
      ) : (
        <AgencyReadError failure={lines} />
      )}
    </div>
  );
}
