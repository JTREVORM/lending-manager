import { Landmark } from 'lucide-react';
import Link from 'next/link';

import { AgentAccountTable } from '@/components/agency/agent-accounts';
import { ProviderReadinessBadge } from '@/components/agency/badges';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyAgentAccounts,
  getAgencyCashBankings,
  getAgencyProvidersByCategory,
} from '@/lib/data/agency';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Agent Banking' };

/**
 * Agent Banking across every configured bank.
 *
 * ## Why this screen exists
 *
 * The schema has distinguished Agent Banking from Mobile Money since Phase 4A
 * — `agency_service_providers.category` — and nothing in the application read
 * the distinction. There was no overview of the banking side, no register of a
 * bank's agent accounts and no page for one account, so "how is Stanbic doing"
 * was a question the data could answer and the application could not.
 *
 * ## Why nothing here is a total of its own
 *
 * Every figure is read from the view that produced it. The three headline
 * figures are sums over the rows the database returned for *this* reader,
 * which is why they sit above the table rather than in a footer implying a
 * total of something wider than what is shown — a branch-scoped officer's
 * "float held" is their branch's float, and saying otherwise would be a
 * figure nobody could reconcile.
 *
 * ## Why a bank with no accounts is still listed
 *
 * A bank the Owner has configured and not yet staffed is a real state, and
 * one worth seeing: the empty state is how somebody discovers that the
 * configuration is done and the registration is not. Omitting it would make
 * it indistinguishable from a bank nobody set up.
 */
export default async function AgentBankingPage() {
  await guardPermission(ROUTES.agencyBanking, 'agency:reports');

  const [banks, accounts, bankings] = await Promise.all([
    getAgencyProvidersByCategory(['agency_banking']),
    getAgencyAgentAccounts({ categories: ['agency_banking'] }),
    getAgencyCashBankings({ statuses: ['pending'], limit: 50 }),
  ]);

  const header = (
    <PageHeader
      eyebrow="Agency"
      icon={Landmark}
      title="Agent Banking"
      description="Every configured bank, the agent accounts registered against it, and the float and commission on each."
      back={{ href: ROUTES.agency, label: 'Agency Services' }}
    />
  );

  if (!banks.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={banks} />
      </div>
    );
  }

  const rows = accounts.ok ? accounts.rows : [];
  const floatHeld = rows.reduce((sum, r) => sum + r.floatBalance, 0);
  const commissionOwed = rows.reduce((sum, r) => sum + r.commissionOutstanding, 0);
  const todayIn = rows.reduce((sum, r) => sum + r.depositValueToday, 0);

  const countFor = (code: string): number =>
    rows.filter((r) => r.providerCode === code).length;

  return (
    <div className="min-w-0 space-y-4">
      {header}

      {banks.rows.length === 0 ? (
        <EmptyState
          icon={Landmark}
          title="No bank is configured yet"
          description="Agent Banking needs a banking provider on the register before an agent account can be opened against it. Registering one is the Owner's, on the provider register."
          action={{ href: ROUTES.agencyProviders, label: 'Providers & services' }}
        />
      ) : (
        <>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <MoneyStat
              label="Electronic float held"
              amount={toUgx(floatHeld)}
              note="On the bank agent accounts you can see"
            />
            <MoneyStat
              label="Commission owed by banks"
              amount={toUgx(commissionOwed)}
              note="Earned and not yet settled"
            />
            <MoneyStat
              label="Customer deposits today"
              amount={toUgx(todayIn)}
              note="Cash taken in over the counter"
            />
          </div>

          {/* A pending cash banking is somebody's money sitting between a till
              and a bank with nobody having checked the slip. It belongs at the
              top of this screen, not inside a report. */}
          {bankings.ok && bankings.rows.length > 0 ? (
            <Alert tone="warning" title="Cash bankings waiting for a second officer">
              {bankings.rows.length === 1
                ? 'One cash banking has been recorded and not yet posted.'
                : `${String(bankings.rows.length)} cash bankings have been recorded and not yet posted.`}{' '}
              <Link href={ROUTES.agencyCashBanking} className="font-semibold underline">
                Review them
              </Link>
              .
            </Alert>
          ) : null}

          <Card>
            <CardHeader
              title="Configured banks"
              description="A bank becomes available to the counter once its commercial configuration is confirmed."
            />
            <DataTable caption="Configured banking providers">
              <thead>
                <TableRow>
                  <TableHead>Bank</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead align="numeric">Agent accounts</TableHead>
                  <TableHead>Float model</TableHead>
                  <TableHead>Commission</TableHead>
                  <TableHead>Readiness</TableHead>
                </TableRow>
              </thead>
              <tbody>
                {banks.rows.map((bank) => (
                  <TableRow key={bank.id}>
                    <TableCell>
                      <Link
                        href={`${ROUTES.agencyBankingAccounts}?provider=${bank.code}`}
                        className="text-link font-semibold hover:underline"
                      >
                        {bank.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="text-text-muted text-xs">{bank.code}</span>
                    </TableCell>
                    <TableCell align="numeric">{countFor(bank.code)}</TableCell>
                    <TableCell>
                      {bank.floatModel === 'provider_float'
                        ? 'Electronic float'
                        : 'Cash payable'}
                    </TableCell>
                    <TableCell>
                      {bank.commissionModel === 'immediate'
                        ? 'At the point of sale'
                        : 'Accrued and settled'}
                    </TableCell>
                    <TableCell>
                      <ProviderReadinessBadge
                        isActive={bank.isActive}
                        isProvisional={bank.isProvisional}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </Card>

          <Card>
            <CardHeader
              title="Agent accounts"
              description="Each account holds its own electronic float and its own commission position."
            />
            {accounts.ok ? (
              <AgentAccountTable
                rows={rows}
                category="agency_banking"
                caption="Bank agent accounts"
                emptyMessage="No agent account is registered against any bank yet."
              />
            ) : (
              <AgencyReadError failure={accounts} />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
