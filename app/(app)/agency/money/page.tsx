import { Smartphone } from 'lucide-react';
import Link from 'next/link';

import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyMoneyConsolidated, getAgencyMoneyDashboard } from '@/lib/data/agency';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Mobile Money' };

/**
 * Mobile Money across every provider and branch.
 *
 * ## Why this is a reading screen and nothing else
 *
 * A deposit or a withdrawal is still recorded at `/agency/record`, on the
 * Phase 4B engine. Phase 4E added the operations *around* the counter —
 * buying and selling float, taking commission in, reconciling a statement —
 * and those live on each provider's own screen, reached from the table
 * below. Nothing here posts.
 *
 * ## Why the per-provider screens are one page with a parameter
 *
 * MTN and Airtel differ in their commission source, their fee handling and
 * their ceilings, and every one of those differences is configuration the
 * database holds. They do not differ in what the accounting does, so there
 * is one screen driven by the provider's own row rather than two screens
 * that would drift apart.
 */
export default async function AgencyMoneyPage() {
  await guardPermission(ROUTES.agencyMoney, 'agency:reports');

  const [providers, lines] = await Promise.all([
    getAgencyMoneyConsolidated(),
    getAgencyMoneyDashboard(),
  ]);

  const header = (
    <PageHeader
      eyebrow="Agency Banking"
      icon={Smartphone}
      title="Mobile Money"
      description="Float held, commission owed and today's activity on every agent line."
      back={{ href: ROUTES.agency, label: 'Agency Services' }}
    />
  );

  if (!providers.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={providers} />
      </div>
    );
  }

  const floatHeld = providers.rows.reduce((sum, r) => sum + r.floatHeld, 0);
  const commission = providers.rows.reduce((sum, r) => sum + r.commissionOutstanding, 0);
  const recovery = providers.rows.reduce((sum, r) => sum + r.recoveryOwed, 0);

  // One provider appears once per branch. The links go to the provider's
  // screen, so the codes are de-duplicated rather than one link per row.
  const codes = [...new Set(providers.rows.map((r) => r.providerCode))];

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <MoneyStat
          label="Float held"
          amount={toUgx(floatHeld)}
          note="On the agent lines"
        />
        <MoneyStat
          label="Commission owed to us"
          amount={toUgx(commission)}
          note="Earned, not yet paid in"
        />
        <MoneyStat
          label="Owed back to providers"
          amount={toUgx(recovery)}
          note="Commission recovered after reversals"
          tone={recovery > 0 ? 'warning' : undefined}
        />
      </div>

      {codes.length > 0 ? (
        <nav aria-label="Providers" className="flex min-w-0 flex-wrap gap-2">
          {codes.map((code) => (
            <Link
              key={code}
              href={`${ROUTES.agencyMoney}/${code}`}
              className="border-border bg-surface hover:bg-surface-sunken focus-visible:ring-brand rounded-lg border px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              {providers.rows.find((r) => r.providerCode === code)?.providerName ?? code}
            </Link>
          ))}
        </nav>
      ) : null}

      <DataTable caption="Float and commission by provider and branch" stickyHeader>
        <thead>
          <tr>
            <TableHead width="name">Provider</TableHead>
            <TableHead width="ref">Branch</TableHead>
            <TableHead align="numeric">Lines</TableHead>
            <TableHead align="numeric" width="money">
              Float held
            </TableHead>
            <TableHead align="numeric" width="money">
              Commission owed
            </TableHead>
            <TableHead align="numeric" width="money">
              Float bought
            </TableHead>
            <TableHead align="numeric" width="money">
              Float sold
            </TableHead>
            <TableHead align="numeric" width="money">
              Moved between lines
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {providers.rows.length === 0 ? (
            <EmptyTableRow colSpan={8}>
              No Mobile Money line is registered at a branch you can see.
            </EmptyTableRow>
          ) : (
            providers.rows.map((r) => (
              <TableRow key={`${r.providerId}-${r.branchId}`}>
                <TableCell header>
                  <Link
                    href={`${ROUTES.agencyMoney}/${r.providerCode}`}
                    className="hover:underline"
                  >
                    {r.providerName}
                  </Link>
                </TableCell>
                <TableCell>{r.branchCode}</TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">{r.activeLines}</span>
                  {r.suspendedLines > 0 ? (
                    <span className="ml-2">
                      <Badge tone="warning">{r.suspendedLines} suspended</Badge>
                    </span>
                  ) : null}
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.floatHeld} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.commissionOutstanding} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.floatPurchased} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={r.floatSold} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  {/* Transfers are shown on their own because they are not a
                      purchase or a sale: float moves between our own lines and
                      the provider's total is unchanged. */}
                  <span className="tabular-nums">
                    <Money amount={r.floatTransferredOut} />
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </tbody>
      </DataTable>

      {lines.ok ? (
        <DataTable caption="Today, by agent line" stickyHeader>
          <thead>
            <tr>
              <TableHead width="name">Line</TableHead>
              <TableHead width="ref">Branch</TableHead>
              <TableHead>Status</TableHead>
              <TableHead align="numeric" width="money">
                Float
              </TableHead>
              <TableHead align="numeric">Deposits</TableHead>
              <TableHead align="numeric">Withdrawals</TableHead>
              <TableHead align="numeric" width="money">
                Commission today
              </TableHead>
              <TableHead align="numeric">Waiting</TableHead>
            </tr>
          </thead>
          <tbody>
            {lines.rows.length === 0 ? (
              <EmptyTableRow colSpan={8}>
                No agent line is registered at a branch you can see.
              </EmptyTableRow>
            ) : (
              lines.rows.map((l) => {
                const waiting =
                  l.pendingTrades +
                  l.transactionsInFlight +
                  l.openCommissionReconciliations;
                return (
                  <TableRow key={l.floatAccountId}>
                    <TableCell header>
                      {l.label ?? l.tillName}
                      <span className="text-muted ml-2 text-xs">{l.providerName}</span>
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
                      <span className="tabular-nums">
                        <Money amount={l.floatBalance} />
                      </span>
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="tabular-nums">{l.depositsToday}</span>
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="tabular-nums">{l.withdrawalsToday}</span>
                    </TableCell>
                    <TableCell align="numeric">
                      <span className="tabular-nums">
                        <Money amount={l.commissionToday} />
                      </span>
                    </TableCell>
                    <TableCell align="numeric">
                      {waiting === 0 ? (
                        <span className="text-muted text-xs">nothing</span>
                      ) : (
                        <Badge tone="warning">{waiting}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </tbody>
        </DataTable>
      ) : (
        <AgencyReadError failure={lines} />
      )}

      <Alert tone="info">
        A customer deposit or withdrawal is recorded on the{' '}
        <Link href={ROUTES.agencyRecord} className="underline">
          record a transaction
        </Link>{' '}
        screen. This page reads what has already been posted.
      </Alert>
    </div>
  );
}
