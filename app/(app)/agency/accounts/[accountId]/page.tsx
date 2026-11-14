import { Landmark, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentAccountStatusBadge } from '@/components/agency/agent-accounts';
import { AgencyReadError } from '@/components/agency/read-failure';
import { AgencyTransactionRegister } from '@/components/agency/transaction-register';
import { FloatTradeRegister } from '@/components/agency/float-trade-register';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyAgentAccount,
  getAgencyFloatTrades,
  getAgencyTransactions,
} from '@/lib/data/agency';
import {
  agentAccountName,
  agentAccountNoun,
  AGENCY_CATEGORY_LABELS,
} from '@/lib/domain/agency';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly accountId: string }>;
}): Promise<{ readonly title: string }> {
  const { accountId } = await params;
  const account = await getAgencyAgentAccount(accountId);
  return {
    title:
      account.ok && account.row !== null
        ? agentAccountName(account.row)
        : 'Agent account',
  };
}

/**
 * One agent account, or one agent line. The same page, deliberately.
 *
 * ## Why there is one of these and not two
 *
 * The client's §4.1 asks for an individual bank agent account page and §5.2
 * for an individual Mobile Money line page, and lists almost the same
 * contents for both: the name or masked number, the provider, the branch, the
 * current float, today's deposits and withdrawals, today's volume, today's
 * commission, what is pending, the recent transactions, the float movements
 * and the reconciliation status.
 *
 * They are the same because the thing is the same: a row of
 * `agency_provider_float_accounts` with its own `1320` ledger account, and
 * every figure below comes from `agency_mobile_money_dashboard`, which joins
 * over every float account whatever its provider's category. Two pages would
 * be two aggregations that could disagree with each other and with the
 * ledger.
 *
 * What differs is the vocabulary and the way back, and both are read from the
 * provider's category rather than from which link the reader followed.
 *
 * ## Why a missing account is a 404 and a failed read is not
 *
 * `getAgencyAgentAccount` returns `null` for an account that does not exist
 * *and* for one this reader may not see — deliberately indistinguishable,
 * because a page that said "exists, but not yours" would confirm the account
 * to somebody with no right to know. A failed read is neither, and is
 * reported as a failure: an officer must not be told their line does not
 * exist because a query timed out.
 */
export default async function AgentAccountPage({
  params,
}: {
  readonly params: Promise<{ readonly accountId: string }>;
}) {
  const { accountId } = await params;
  await guardPermission(ROUTES.agencyAccounts, 'agency:reports');

  const account = await getAgencyAgentAccount(accountId);

  if (!account.ok) {
    return (
      <div className="min-w-0 space-y-4">
        <PageHeader
          eyebrow="Agency"
          title="Agent account"
          back={{ href: ROUTES.agency, label: 'Agency Services' }}
        />
        <AgencyReadError failure={account} />
      </div>
    );
  }

  if (account.row === null) notFound();

  const row = account.row;
  const isMoney = row.providerCategory === 'mobile_money';
  const noun = agentAccountNoun(row.providerCategory);

  const [transactions, trades] = await Promise.all([
    getAgencyTransactions({ floatAccountId: accountId, limit: 50 }),
    getAgencyFloatTrades({ providerCode: row.providerCode, limit: 50 }),
  ]);

  // The float trade register is per provider, so a line's page shows the
  // trades that touched *this* line — either side of a transfer counts,
  // because a transfer in is as much a movement on this line as a transfer
  // out.
  const ownTrades = trades.ok
    ? trades.rows.filter(
        (t) => t.floatAccountId === accountId || t.counterFloatAccountId === accountId,
      )
    : [];

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow={AGENCY_CATEGORY_LABELS[row.providerCategory]}
        icon={isMoney ? Smartphone : Landmark}
        title={agentAccountName(row)}
        description={`${row.providerName} · ${row.branchName} (${row.branchCode})`}
        status={<AgentAccountStatusBadge status={row.lineStatus} />}
        back={
          isMoney
            ? {
                href: `${ROUTES.agencyMoney}/${row.providerCode}`,
                label: row.providerName,
              }
            : {
                href: `${ROUTES.agencyBankingAccounts}?provider=${row.providerCode}`,
                label: row.providerName,
              }
        }
      />

      {row.lineStatus === 'suspended' ? (
        <Alert tone="warning" title={`This ${noun.singular} is suspended`}>
          It takes no new transactions. Its float, its commission and its history remain,
          and the operations that recover them are still available to whoever holds the
          capability for them.
        </Alert>
      ) : null}

      {row.lineStatus === 'closed' ? (
        <Alert tone="info" title={`This ${noun.singular} is closed`}>
          It was closed on <DateValue value={row.closedOn} /> and takes no further
          business. Its history is kept, because the transactions it posted are part of
          the book.
        </Alert>
      ) : null}

      {/* The position: what the account holds and what it is owed, which is
          the first question anybody asks about a line. */}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MoneyStat
          label="Electronic float"
          amount={row.floatBalance}
          note={row.ledgerAccountCode}
        />
        <MoneyStat
          label="Commission owed to us"
          amount={row.commissionOutstanding}
          note="Earned and not yet settled"
        />
        <MoneyStat
          label="Commission we owe back"
          amount={row.recoveryOwed}
          note="Recoveries outstanding"
        />
        <MoneyStat
          label="Commission earned today"
          amount={row.commissionToday}
          note={`${String(row.transactionsToday)} transaction${row.transactionsToday === 1 ? '' : 's'} posted`}
        />
      </div>

      {/* Today at the counter. Deposits and withdrawals separately, because
          they move the float in opposite directions and a combined "volume"
          figure hides which way. */}
      <Card>
        <CardHeader
          title="Today"
          description="Posted transactions only. Nothing recorded and awaiting verification is counted here, because nothing is in the book until it is posted."
        />
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <MoneyStat
            label="Customer deposits"
            amount={row.depositValueToday}
            note={`${String(row.depositsToday)} received`}
          />
          <MoneyStat
            label="Customer withdrawals"
            amount={row.withdrawalValueToday}
            note={`${String(row.withdrawalsToday)} paid out`}
          />
          <MoneyStat
            label="Charges collected"
            amount={row.customerFeesToday}
            note="Kept separate from the principal"
          />
        </div>

        {/* Not a fourth tile. Work in flight has no value in the book — a
            `MoneyStat` would read "UGX 0" in the same type as three real
            figures beside it, which says the opposite of what is true. */}
        {row.transactionsInFlight > 0 || row.pendingTrades > 0 ? (
          <p className="text-text-muted mt-3 text-xs">
            Waiting for a second officer:{' '}
            <Link
              href={ROUTES.agencyPending}
              className="text-link font-semibold hover:underline"
            >
              {row.transactionsInFlight} transaction
              {row.transactionsInFlight === 1 ? '' : 's'}
            </Link>{' '}
            and {row.pendingTrades} float trade
            {row.pendingTrades === 1 ? '' : 's'}. Neither is in the book yet.
          </p>
        ) : (
          <p className="text-text-muted mt-3 text-xs">
            Nothing is waiting for verification.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Registration" as="h2" />
        <DataTable caption={`${agentAccountName(row)} registration`}>
          <thead>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </thead>
          <tbody>
            <TableRow>
              <TableCell header>Provider</TableCell>
              <TableCell>
                {row.providerName} ({row.providerCode})
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Branch</TableCell>
              <TableCell>
                {row.branchName} ({row.branchCode})
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>{isMoney ? 'Line number' : 'Agent number'}</TableCell>
              <TableCell>
                {/* Masked in the view and nowhere unmasked. The full number is
                    reachable only through the administration path that guards
                    `agency:providers`. */}
                {row.lineMsisdnMasked ?? row.agentCode ?? '—'}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Provider&rsquo;s own code</TableCell>
              <TableCell>{row.agentCode ?? '—'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Float ledger account</TableCell>
              <TableCell>{row.ledgerAccountCode}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Till</TableCell>
              <TableCell>{row.tillName}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Opened</TableCell>
              <TableCell>
                <DateValue value={row.openedOn} />
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Closed</TableCell>
              <TableCell>
                {row.closedOn === null ? '—' : <DateValue value={row.closedOn} />}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell header>Open reconciliations</TableCell>
              <TableCell>
                {row.openCommissionReconciliations === 0 ? (
                  'None'
                ) : (
                  <Link
                    href={`${ROUTES.agencyMoney}/${row.providerCode}/statements`}
                    className="text-link font-semibold hover:underline"
                  >
                    {row.openCommissionReconciliations} statement period
                    {row.openCommissionReconciliations === 1 ? '' : 's'} unreconciled
                  </Link>
                )}
              </TableCell>
            </TableRow>
          </tbody>
        </DataTable>
      </Card>

      <Card>
        <CardHeader
          title="Recent transactions"
          description={`Every transaction recorded against this ${noun.singular}, newest first.`}
        />
        {transactions.ok ? (
          <AgencyTransactionRegister
            rows={transactions.rows}
            caption={`${agentAccountName(row)} transactions`}
            emptyMessage={`No transaction has been recorded against this ${noun.singular} yet.`}
          />
        ) : (
          <AgencyReadError failure={transactions} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Float movements"
          description="Float bought, sold and moved between accounts. A transfer appears on both accounts it touched."
        />
        {/* Read-only here: posting and reversing a float trade are actions on
            the provider's own screen, where the capability is resolved and the
            form that produced the trade lives. A second set of controls on an
            account page would be a second path into the same posting
            function. */}
        {trades.ok ? (
          <FloatTradeRegister rows={ownTrades} canPost={false} canReverse={false} />
        ) : (
          <AgencyReadError failure={trades} />
        )}
      </Card>
    </div>
  );
}
