import { Landmark } from 'lucide-react';
import Link from 'next/link';

import { AgentAccountTable } from '@/components/agency/agent-accounts';
import { ProviderReadinessBadge } from '@/components/agency/badges';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Card, CardHeader } from '@/components/ui/card';
import { MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyAgentAccounts, getAgencyProvidersByCategory } from '@/lib/data/agency';
import { toUgx } from '@/lib/domain/money';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The bank a request asks for, or `null` for all of them.
 *
 * Validated against the database's own code shape and nothing else. A code
 * that is not on the register produces a heading naming it and no rows, which
 * is the honest answer: the filter is a convenience, and what a reader may see
 * is decided by the route's capability and by Row Level Security on the view.
 */
function readProvider(params: SearchParams): string | null {
  const raw = params.provider;
  if (typeof raw !== 'string') return null;
  return /^[A-Z0-9_]{2,32}$/.test(raw) ? raw : null;
}

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<{ readonly title: string }> {
  const code = readProvider(await searchParams);
  return { title: code === null ? 'Banks & agent accounts' : `${code} agent accounts` };
}

/**
 * Every bank and its registered agent accounts, or one bank's.
 *
 * ## Why `?provider=` rather than a route per bank
 *
 * The rail carries a row for each configured bank, and each points here with
 * the bank's code. A route per bank would be a route that has to be created
 * when a bank is registered, which is exactly the restructuring the client's
 * requirements rule out — "support future providers without restructuring
 * application code". This page reads the code, so a bank registered next year
 * has a working page the moment it is on the register.
 *
 * ## Why the accounts table is the same component as Mobile Money's
 *
 * Because a bank agent account and a Mobile Money line are the same row with
 * the same figures behind them. See `AgentAccountTable`.
 */
export default async function BankAgentAccountsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  await guardPermission(ROUTES.agencyBankingAccounts, 'agency:reports');
  const providerCode = readProvider(await searchParams);

  const [banks, accounts] = await Promise.all([
    getAgencyProvidersByCategory(['agency_banking']),
    getAgencyAgentAccounts({
      categories: ['agency_banking'],
      ...(providerCode === null ? {} : { providerCode }),
    }),
  ]);

  const bank =
    banks.ok && providerCode !== null
      ? (banks.rows.find((p) => p.code === providerCode) ?? null)
      : null;

  const title =
    providerCode === null
      ? 'Banks & agent accounts'
      : (bank?.name ?? `${providerCode} — not on the register`);

  const header = (
    <PageHeader
      eyebrow="Agent Banking"
      icon={Landmark}
      title={title}
      description={
        providerCode === null
          ? 'Every configured bank, and the agent accounts registered against each.'
          : 'The agent accounts registered against this bank, with the float and commission on each.'
      }
      back={{ href: ROUTES.agencyBanking, label: 'Agent Banking' }}
      status={
        bank === null ? undefined : (
          <ProviderReadinessBadge
            isActive={bank.isActive}
            isProvisional={bank.isProvisional}
          />
        )
      }
    />
  );

  if (!accounts.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={accounts} />
      </div>
    );
  }

  const rows = accounts.rows;
  const floatHeld = rows.reduce((sum, r) => sum + r.floatBalance, 0);
  const commissionOwed = rows.reduce((sum, r) => sum + r.commissionOutstanding, 0);
  const commissionToday = rows.reduce((sum, r) => sum + r.commissionToday, 0);
  const pending = rows.reduce((sum, r) => sum + r.transactionsInFlight, 0);

  // A code that is not on the register is a different thing from a bank with
  // no accounts, and the reader needs to be told which they are looking at.
  const unknownBank = providerCode !== null && banks.ok && bank === null;

  return (
    <div className="min-w-0 space-y-4">
      {header}

      {unknownBank ? (
        <EmptyState
          icon={Landmark}
          title={`No bank is registered under the code ${providerCode}`}
          description="The code in the address does not match any banking provider on the register. It may have been renamed, or the link may be out of date."
          action={{ href: ROUTES.agencyBankingAccounts, label: 'All banks & accounts' }}
        />
      ) : (
        <>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <MoneyStat label="Electronic float held" amount={toUgx(floatHeld)} />
            <MoneyStat label="Commission owed" amount={toUgx(commissionOwed)} />
            {/* The note carries the count rather than a second tile showing
                "UGX 0": a transaction in flight has no value in the book yet,
                because nothing is posted until it is verified. */}
            <MoneyStat
              label="Commission earned today"
              amount={toUgx(commissionToday)}
              note={
                pending === 0
                  ? 'Nothing is waiting for verification'
                  : `${String(pending)} transaction${pending === 1 ? '' : 's'} recorded and not yet posted`
              }
            />
          </div>

          <Card>
            <CardHeader
              title="Registered agent accounts"
              description="Each account holds its own electronic float, its own commission position and its own history."
              action={
                <Link
                  href={ROUTES.agencyLines}
                  className="text-link text-xs font-semibold hover:underline"
                >
                  Register an account
                </Link>
              }
            />
            <AgentAccountTable
              rows={rows}
              category="agency_banking"
              caption={
                providerCode === null
                  ? 'Bank agent accounts'
                  : `${providerCode} agent accounts`
              }
              showProvider={providerCode === null}
              emptyMessage={
                providerCode === null
                  ? 'No agent account is registered against any bank yet.'
                  : 'No agent account is registered against this bank yet.'
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}
