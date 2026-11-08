import { FileBarChart } from 'lucide-react';

import { VarianceBadge } from '@/components/agency/badges';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyCashMovement,
  getAgencyCommission,
  getAgencyPayables,
  getAgencyVariances,
} from '@/lib/data/agency';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Agency reports' };

/**
 * The four Phase 4C reporting views, on one screen.
 *
 * Nothing here adds anything up. Each figure is read from the view that
 * produced it, which attributes GL 1310 and the 2200-series per provider and
 * per branch by source entity - those accounts are shared, so an
 * account-level total would mix providers. The two headline figures are the
 * database's own column sums over the rows it returned, which is why they are
 * `MoneyStat`s above the tables rather than a footer row implying a total of
 * something wider than what is shown.
 *
 * Read-only, by design: a report that could post would be a form.
 */
export default async function AgencyReportsPage() {
  await guardPermission(ROUTES.agencyReports, 'agency:reports');

  const [commission, payables, movement, variances] = await Promise.all([
    getAgencyCommission(),
    getAgencyPayables(),
    getAgencyCashMovement({ limit: 60 }),
    getAgencyVariances({ limit: 60 }),
  ]);

  // Summing rows the database already produced, for a heading. Integer
  // addition over integer shillings: no rounding happens here because there
  // is nothing to round.
  const commissionOutstanding = toUgx(
    commission.reduce((total, row) => total + row.outstanding, 0),
  );
  const payableOutstanding = toUgx(
    payables.reduce((total, row) => total + row.outstanding, 0),
  );

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={FileBarChart}
        title="Agency reports"
        description="Commission, provider remittances, daily cash movement and variances."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <MoneyStat
          label="Commission owed to us"
          amount={commissionOutstanding}
          note="Earned and not yet received, across every provider and branch you can see."
        />
        <MoneyStat
          label="Collections owed to providers"
          amount={payableOutstanding}
          note="Customer money held and not yet remitted."
        />
      </div>

      <Card>
        <h2 className="text-sm font-semibold">Commission by provider and branch</h2>
        <div className="mt-2 min-w-0">
          <DataTable
            caption="Commission earned, received and outstanding"
            density="compact"
          >
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
                  Reversed
                </TableHead>
                <TableHead align="numeric" width="money">
                  Outstanding
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {commission.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  No commission has been earned at a branch you can see.
                </EmptyTableRow>
              ) : (
                commission.map((row) => (
                  <TableRow key={`${row.providerId}|${row.branchId}`}>
                    <TableCell header>{row.providerName}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.earned} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.received} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.returned} />
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="font-semibold">
                        <Money amount={row.outstanding} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Provider remittances</h2>
        <div className="mt-2 min-w-0">
          <DataTable
            caption="Customer money collected, remitted and outstanding"
            density="compact"
          >
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
                  Outstanding
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {payables.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  Nothing has been collected on a provider&rsquo;s behalf at a branch you
                  can see.
                </EmptyTableRow>
              ) : (
                payables.map((row) => (
                  <TableRow key={`${row.providerId}|${row.branchId}`}>
                    <TableCell header>{row.providerName}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.collected} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.remitted} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.remittanceReversed} />
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="font-semibold">
                        <Money amount={row.outstanding} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Daily cash movement</h2>
        <p className="text-text-muted mt-1 text-xs">
          Agency money through the branch&rsquo;s own cash accounts, by day and by what
          moved it. Lending movement is not here: this view reads agency sources only.
        </p>
        <div className="mt-2 min-w-0">
          <DataTable caption="Agency cash in and out by day and source" density="compact">
            <thead>
              <tr>
                <TableHead width="date">Date</TableHead>
                <TableHead width="ref">Branch</TableHead>
                <TableHead width="ref">Account</TableHead>
                <TableHead width="name">Source</TableHead>
                <TableHead align="numeric" width="money">
                  In
                </TableHead>
                <TableHead align="numeric" width="money">
                  Out
                </TableHead>
                <TableHead align="numeric" width="money">
                  Net
                </TableHead>
              </tr>
            </thead>
            <tbody>
              {movement.length === 0 ? (
                <EmptyTableRow colSpan={7}>
                  No agency cash has moved at a branch you can see.
                </EmptyTableRow>
              ) : (
                movement.map((row) => (
                  <TableRow
                    key={`${row.branchId}|${row.entryDate}|${row.cashAccountCode}|${row.sourceType}`}
                  >
                    <TableCell header>
                      <DateValue value={row.entryDate} />
                    </TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{row.cashAccountCode}</span>
                    </TableCell>
                    <TableCell>{row.sourceType}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.cashIn} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.cashOut} />
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="tabular-nums">
                        {row.netMovement.toLocaleString('en-UG')}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Reconciliation variances</h2>
        <p className="text-text-muted mt-1 text-xs">
          Cash counts and provider statements together. What a variance&rsquo;s sign means
          is the database&rsquo;s own statement, carried into each badge rather than
          restated here.
        </p>
        <div className="mt-2 min-w-0">
          <DataTable caption="Cash and float reconciliation variances" density="compact">
            <thead>
              <tr>
                <TableHead width="date">Date</TableHead>
                <TableHead width="ref">Kind</TableHead>
                <TableHead width="name">Provider or account</TableHead>
                <TableHead width="ref">Branch</TableHead>
                <TableHead align="numeric" width="money">
                  Books
                </TableHead>
                <TableHead align="numeric" width="money">
                  Counted
                </TableHead>
                <TableHead width="ref">Variance</TableHead>
                <TableHead align="numeric" width="money">
                  Written off
                </TableHead>
                <TableHead width="status">Status</TableHead>
              </tr>
            </thead>
            <tbody>
              {variances.length === 0 ? (
                <EmptyTableRow colSpan={9}>
                  Nothing has been reconciled at a branch you can see.
                </EmptyTableRow>
              ) : (
                variances.map((row) => (
                  <TableRow key={`${row.kind}|${row.id}`}>
                    <TableCell header>
                      <DateValue value={row.reconciliationDate} />
                    </TableCell>
                    <TableCell>{row.kind === 'cash' ? 'Cash count' : 'Float'}</TableCell>
                    <TableCell>{row.providerName ?? 'Cash at hand'}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.systemClosingBalance} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.countedOrStatement} />
                    </TableCell>
                    <TableCell>
                      <VarianceBadge variance={row.variance} means={row.varianceMeans} />
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="tabular-nums">
                        {row.varianceWrittenOff.toLocaleString('en-UG')}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.status === 'open' ? 'Awaiting certification' : 'Certified'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Alert tone="info">
        These figures are the database&rsquo;s. Nothing on this page recalculates a
        balance, and no column here is a total of anything wider than the rows shown.
      </Alert>
    </div>
  );
}
