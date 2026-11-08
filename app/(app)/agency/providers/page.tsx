import { Settings2 } from 'lucide-react';

import { ProviderReadinessBadge } from '@/components/agency/badges';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyProviders, getAgencyServiceTypes } from '@/lib/data/agency';
import { providerBlockedReason } from '@/lib/domain/agency';

export const metadata = { title: 'Providers and services' };

/**
 * The commercial terms every posting is computed from.
 *
 * ## Why nothing here can be edited
 *
 * There is no authorized workflow to change a provider's terms. The database
 * grants `authenticated` nothing but SELECT on `agency_service_providers` and
 * `agency_transaction_types`, and no function exists that writes either -
 * every other agency write goes through a SECURITY DEFINER function with a
 * capability check, and these two have none because approving a provider's
 * commercial terms is a Policy 2.0 decision that has not been taken.
 *
 * So this screen shows the terms and says who can change them, rather than
 * offering a control that would fail. Adding one would mean inventing the
 * approval workflow the decision is waiting on, which the Phase 4D brief
 * rules out: no provider activation.
 *
 * ## `requires_approval_above`
 *
 * Shown because it is configured and somebody will ask what it does, and
 * marked as not enforced because it is not. Decision L - whether a threshold
 * should gate verification - is unresolved, and the posting engine does not
 * read this column. A screen that presented it as a working control would be
 * claiming a protection the system does not have.
 */

/** Basis points as a percentage, exactly: 150 becomes 1.50%. */
function ratePercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${String(whole)}.${String(fraction).padStart(2, '0')}%`;
}

export default async function AgencyProvidersPage() {
  await guardPermission(ROUTES.agencyProviders, 'agency:providers');

  const [providers, types] = await Promise.all([
    getAgencyProviders(),
    getAgencyServiceTypes(),
  ]);

  const thresholded = types.filter((t) => t.requiresApprovalAbove !== null);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Settings2}
        title="Providers and services"
        description="The terms every commission figure is computed from."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <Alert tone="info">
        Read-only. Registering a provider, approving its commercial terms or making it
        live is not a screen in this release: the database has no function that writes
        these tables, and the approval workflow for commercial terms has not been decided.
        Ask the Owner, who changes them directly with the change recorded.
      </Alert>

      <Card>
        <h2 className="text-sm font-semibold">Providers</h2>
        <div className="mt-2 min-w-0">
          <DataTable caption="Registered agency providers and their commission terms">
            <thead>
              <tr>
                <TableHead width="ref">Code</TableHead>
                <TableHead width="name">Provider</TableHead>
                <TableHead width="ref">Category</TableHead>
                <TableHead width="name">Money model</TableHead>
                <TableHead width="name">Commission</TableHead>
                <TableHead width="prose">Readiness</TableHead>
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 ? (
                <EmptyTableRow colSpan={6}>No provider is registered.</EmptyTableRow>
              ) : (
                providers.map((p) => {
                  const blocked = providerBlockedReason(p);
                  return (
                    <TableRow key={p.id}>
                      <TableCell header>
                        <span className="font-mono text-xs">{p.code}</span>
                      </TableCell>
                      <TableCell>{p.name}</TableCell>
                      <TableCell>{p.category}</TableCell>
                      <TableCell>
                        {p.floatModel === 'provider_float'
                          ? 'Electronic float'
                          : 'Cash, payable to the provider'}
                        <span className="text-text-muted mt-0.5 block text-[10px]">
                          {p.commissionModel === 'deferred'
                            ? 'Commission receivable until settled'
                            : 'Commission received at once'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {/*
                          Exactly one of the two is set - the table refuses a
                          provider carrying both - so whichever it is, is the
                          headline rather than a footnote under an empty line.
                        */}
                        {p.commissionRateBps !== null ? (
                          <span className="tabular-nums">
                            {ratePercent(p.commissionRateBps)} of the amount
                          </span>
                        ) : p.commissionFixed !== null ? (
                          <span className="tabular-nums">
                            <Money amount={p.commissionFixed} /> a transaction
                          </span>
                        ) : (
                          <span className="text-text-muted">No terms recorded</span>
                        )}
                      </TableCell>
                      <TableCell wrap="wrap">
                        <ProviderReadinessBadge
                          isActive={p.isActive}
                          isProvisional={p.isProvisional}
                        />
                        {/*
                          The badge says the state; this says what it means for
                          the counter, which is the question an officer is
                          actually asking when they open this screen.
                        */}
                        <span className="text-text-muted mt-1 block text-[10px]">
                          {blocked ?? 'Can be posted against.'}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Transaction types</h2>
        <p className="text-text-muted mt-1 text-xs">
          What each provider offers, and the single-transaction ceiling the database
          enforces on it. A type with no ceiling cannot be posted past draft at all.
        </p>
        <div className="mt-2 min-w-0">
          <DataTable caption="Agency transaction types and their limits">
            <thead>
              <tr>
                <TableHead width="ref">Code</TableHead>
                <TableHead width="name">Provider</TableHead>
                <TableHead width="name">Service</TableHead>
                <TableHead width="ref">Direction</TableHead>
                <TableHead align="numeric" width="money">
                  Maximum one transaction
                </TableHead>
                <TableHead align="numeric" width="money">
                  Approval threshold
                </TableHead>
                <TableHead width="status">Active</TableHead>
              </tr>
            </thead>
            <tbody>
              {types.length === 0 ? (
                <EmptyTableRow colSpan={7}>No service type is configured.</EmptyTableRow>
              ) : (
                types.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell header>
                      <span className="font-mono text-xs">{t.code}</span>
                    </TableCell>
                    <TableCell>{t.providerName}</TableCell>
                    <TableCell>{t.name}</TableCell>
                    <TableCell>{t.direction}</TableCell>
                    <TableCell align="numeric">
                      {t.maxSingleTransaction === null ? (
                        <span className="text-text-muted">None set</span>
                      ) : (
                        <Money amount={t.maxSingleTransaction} />
                      )}
                    </TableCell>
                    <TableCell align="numeric">
                      {t.requiresApprovalAbove === null ? (
                        <span className="text-text-muted">—</span>
                      ) : (
                        <span className="text-text-muted line-through">
                          <Money amount={t.requiresApprovalAbove} />
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge tone={t.isActive ? 'success' : 'neutral'} shape="pill">
                        {t.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        </div>
      </Card>

      <Alert tone="warning">
        <strong>The approval threshold is not enforced.</strong> The column is struck
        through above because the posting engine does not read it:{' '}
        {thresholded.length === 0
          ? 'no service type currently carries one.'
          : thresholded.length === 1
            ? 'one service type carries a figure that does nothing.'
            : `${String(thresholded.length)} service types carry a figure that does nothing.`}{' '}
        Whether a threshold should gate verification is an open decision, and until it is
        taken, a transaction above this figure posts exactly like one below it. The
        protection that does hold is the maximum above, which the database refuses past.
      </Alert>
    </div>
  );
}
