import { FileBarChart } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

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

  // Every section reports its own read. A report is read to make a
  // decision, so one failed query must leave a gap that says so rather than
  // a zero that does not.
  const failures = [commission, payables, movement, variances].filter((r) => !r.ok);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={FileBarChart}
        title="Agency reports"
        description="Commission, provider remittances, daily cash movement and variances."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      {failures.map((failure) =>
        failure.ok ? null : <AgencyReadError key={failure.what} failure={failure} />,
      )}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {commission.ok ? (
          <MoneyStat
            label="Commission owed to us"
            amount={toUgx(commission.rows.reduce((t, row) => t + row.outstanding, 0))}
            note="Earned and not yet received, across every provider and branch you can see."
          />
        ) : null}
        {payables.ok ? (
          <MoneyStat
            label="Collections owed to providers"
            amount={toUgx(payables.rows.reduce((t, row) => t + row.outstanding, 0))}
            note="Customer money held and not yet remitted."
          />
        ) : null}
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
              {!commission.ok ? (
                <EmptyTableRow colSpan={6}>
                  Not read. The panel above says why; this is not an empty section.
                </EmptyTableRow>
              ) : commission.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  No commission has been earned at a branch you can see.
                </EmptyTableRow>
              ) : (
                commission.rows.map((row) => (
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
              {!payables.ok ? (
                <EmptyTableRow colSpan={6}>
                  Not read. The panel above says why; this is not an empty section.
                </EmptyTableRow>
              ) : payables.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  Nothing has been collected on a provider&rsquo;s behalf at a branch you
                  can see.
                </EmptyTableRow>
              ) : (
                payables.rows.map((row) => (
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
              {!movement.ok ? (
                <EmptyTableRow colSpan={7}>
                  Not read. The panel above says why; this is not an empty section.
                </EmptyTableRow>
              ) : movement.rows.length === 0 ? (
                <EmptyTableRow colSpan={7}>
                  No agency cash has moved at a branch you can see.
                </EmptyTableRow>
              ) : (
                movement.rows.map((row) => (
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
              {!variances.ok ? (
                <EmptyTableRow colSpan={9}>
                  Not read. The panel above says why; this is not an empty section.
                </EmptyTableRow>
              ) : variances.rows.length === 0 ? (
                <EmptyTableRow colSpan={9}>
                  Nothing has been reconciled at a branch you can see.
                </EmptyTableRow>
              ) : (
                variances.rows.map((row) => (
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
