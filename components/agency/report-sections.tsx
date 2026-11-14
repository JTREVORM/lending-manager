import Link from 'next/link';

import { AgencyReadError } from '@/components/agency/read-failure';
import { AgencyTransactionRegister } from '@/components/agency/transaction-register';
import { AgentAccountTable } from '@/components/agency/agent-accounts';
import { VarianceBadge } from '@/components/agency/badges';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money, MoneyStat } from '@/components/ui/money';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { toUgx } from '@/lib/domain/money';
import {
  AGENCY_REPORT_SECTIONS,
  AGENCY_REPORT_SECTION_META,
  agencyPeriodLabel,
  agencyReportHref,
  agencyScopeLabel,
  tallyAgentPerformance,
  type AgencyReportFilter,
} from '@/lib/agency/reporting';
import type {
  AgencyAgentAccountRow,
  AgencyCashBankingRow,
  AgencyCashCountRow,
  AgencyCashMovementRow,
  AgencyCommissionRow,
  AgencyCommissionSettlementRow,
  AgencyFloatStatementRow,
  AgencyPayableRow,
  AgencyPayableSettlementRow,
  AgencyTransactionRow,
  AgencyVarianceRow,
} from '@/lib/domain/agency';
import type { AgencyRows } from '@/lib/data/agency';

/**
 * Everything a section may need, read once by the page.
 *
 * One object rather than a prop per reader, because the sections overlap: the
 * overview shows a figure from almost all of them, the cash and float section
 * shows the cash movement and the counts, and the reconciliation section shows
 * the counts again beside the variances. Passing the reads around means each
 * is performed once per request however many sections name it.
 */
export interface AgencyReportData {
  readonly accounts: AgencyRows<AgencyAgentAccountRow>;
  readonly transactions: AgencyRows<AgencyTransactionRow>;
  readonly commission: AgencyRows<AgencyCommissionRow>;
  readonly payables: AgencyRows<AgencyPayableRow>;
  readonly movement: AgencyRows<AgencyCashMovementRow>;
  readonly variances: AgencyRows<AgencyVarianceRow>;
  readonly cashCounts: AgencyRows<AgencyCashCountRow>;
  readonly floatStatements: AgencyRows<AgencyFloatStatementRow>;
  readonly commissionSettlements: AgencyRows<AgencyCommissionSettlementRow>;
  readonly payableSettlements: AgencyRows<AgencyPayableSettlementRow>;
  readonly bankings: AgencyRows<AgencyCashBankingRow>;
}

/** The period and scope a report covers, stated above every one of them. */
export function ReportScopeLine({ filter }: { readonly filter: AgencyReportFilter }) {
  return (
    <p className="text-text-muted text-xs">
      {agencyScopeLabel(filter)} · {agencyPeriodLabel(filter)} · {filter.range.from} to{' '}
      {filter.range.to}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Overview({
  filter,
  data,
}: {
  readonly filter: AgencyReportFilter;
  readonly data: AgencyReportData;
}) {
  const accounts = data.accounts.ok ? data.accounts.rows : [];
  const posted = data.transactions.ok
    ? data.transactions.rows.filter((t) => t.status === 'posted')
    : [];

  const deposits = posted.filter((t) => t.direction === 'deposit');
  const withdrawals = posted.filter((t) => t.direction === 'withdrawal');

  const sum = (rows: readonly AgencyTransactionRow[]): number =>
    rows.reduce((total, row) => total + row.principalAmount, 0);

  const floatHeld = accounts.reduce((total, row) => total + row.floatBalance, 0);
  const commissionOwed = accounts.reduce(
    (total, row) => total + row.commissionOutstanding,
    0,
  );
  const banked = data.bankings.ok
    ? data.bankings.rows
        .filter((b) => b.status === 'posted')
        .reduce((total, b) => total + b.netBanked, 0)
    : 0;

  return (
    <div className="min-w-0 space-y-4">
      {/* Transaction volume and the company's own position are deliberately
          in two groups. The client's §6.5 is explicit: "Do not treat the full
          monetary volume of customer transactions as profit." A deposit volume
          beside a commission figure in one row of tiles invites exactly that
          reading. */}
      <Card>
        <CardHeader
          title="Service volume"
          description="What customers moved through the counter. This is not the company's money and it is not income — the company's income is the commission below."
        />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MoneyStat
            label="Customer deposits"
            amount={toUgx(sum(deposits))}
            note={`${String(deposits.length)} posted`}
          />
          <MoneyStat
            label="Customer withdrawals"
            amount={toUgx(sum(withdrawals))}
            note={`${String(withdrawals.length)} posted`}
          />
          <MoneyStat
            label="Charges collected"
            amount={toUgx(posted.reduce((t, r) => t + r.customerFee, 0))}
            note="Kept separate from the principal"
          />
          <MoneyStat
            label="Cash banked"
            amount={toUgx(banked)}
            note="Collected cash taken to the bank, net of charges"
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The company's position"
          description="What the business holds and what it is owed. Float and commission come from the ledger, per account, so they reconcile to the journal."
        />
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MoneyStat label="Electronic float held" amount={toUgx(floatHeld)} />
          <MoneyStat
            label="Commission receivable"
            amount={toUgx(commissionOwed)}
            note="Earned and not yet settled"
          />
          <MoneyStat
            label="Commission earned today"
            amount={toUgx(accounts.reduce((t, r) => t + r.commissionToday, 0))}
          />
          <MoneyStat
            label="Owed back to providers"
            amount={toUgx(accounts.reduce((t, r) => t + r.recoveryOwed, 0))}
            note="Recoveries outstanding"
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Work outstanding"
          description="Anything recorded and not yet posted is in none of the figures above, because nothing is in the book until it is verified."
        />
        <ul className="text-text space-y-1 text-sm">
          <li>
            <Link href={ROUTES.agencyPending} className="text-link hover:underline">
              {accounts.reduce((t, r) => t + r.transactionsInFlight, 0)} transactions
            </Link>{' '}
            awaiting verification
          </li>
          <li>
            <Link href={ROUTES.agencyTransfers} className="text-link hover:underline">
              {accounts.reduce((t, r) => t + r.pendingTrades, 0)} float movements
            </Link>{' '}
            awaiting a second officer
          </li>
          <li>
            <Link href={ROUTES.agencyCashBanking} className="text-link hover:underline">
              {data.bankings.ok
                ? data.bankings.rows.filter((b) => b.status === 'pending').length
                : 0}{' '}
              cash bankings
            </Link>{' '}
            awaiting a second officer
          </li>
          <li>
            {accounts.reduce((t, r) => t + r.openCommissionReconciliations, 0)} statement
            periods unreconciled
          </li>
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="By account"
          description="Each account holds its own float and its own commission position, so a total across them is a sum of separate books rather than one balance."
        />
        {data.accounts.ok ? (
          <AgentAccountTable
            rows={accounts}
            category={filter.scope === 'banking' ? 'agency_banking' : 'mobile_money'}
            caption="Agency accounts and lines"
            emptyMessage="No agent account or agent line is registered in this scope yet."
          />
        ) : (
          <AgencyReadError failure={data.accounts} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transactions — §6.1
// ---------------------------------------------------------------------------

function Transactions({ data }: { readonly data: AgencyReportData }) {
  if (!data.transactions.ok) return <AgencyReadError failure={data.transactions} />;

  const rows = data.transactions.rows;
  const counts = {
    posted: rows.filter((r) => r.status === 'posted').length,
    pending: rows.filter(
      (r) => r.status === 'awaiting_verification' || r.status === 'draft',
    ).length,
    reversed: rows.filter((r) => r.status === 'reversed').length,
  };

  const value = rows
    .filter((r) => r.status === 'posted')
    .reduce((total, r) => total + r.principalAmount, 0);
  const fees = rows
    .filter((r) => r.status === 'posted')
    .reduce((total, r) => total + r.customerFee, 0);

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MoneyStat
          label="Posted value"
          amount={toUgx(value)}
          note={`${String(counts.posted)} transactions`}
        />
        <MoneyStat
          label="Charges"
          amount={toUgx(fees)}
          note="Separate from the principal"
        />
        <MoneyStat
          label="Reversed"
          amount={toUgx(
            rows
              .filter((r) => r.status === 'reversed')
              .reduce((t, r) => t + r.principalAmount, 0),
          )}
          note={`${String(counts.reversed)} transactions`}
          tone={counts.reversed === 0 ? undefined : 'warning'}
        />
        <MoneyStat
          label="Not yet posted"
          amount={toUgx(0)}
          note={`${String(counts.pending)} recorded, none in the book`}
        />
      </div>

      <Card>
        <CardHeader
          title="Every transaction in the period"
          description="With its reference, its charge, and the officers who recorded and verified it."
        />
        <AgencyTransactionRegister
          rows={rows}
          caption="Agency transaction report"
          emptyMessage="No transaction was recorded in this period for this scope."
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cash & float — §6.2 and §6.3
// ---------------------------------------------------------------------------

function CashAndFloat({ data }: { readonly data: AgencyReportData }) {
  return (
    <div className="min-w-0 space-y-4">
      <Alert tone="info" title="How the float figures are arrived at">
        Opening float, plus verified increases, less verified decreases, equals closing
        float — and every one of those comes from the journal rather than from a running
        total kept beside it. A float balance on this page is the balance of that
        account&rsquo;s own ledger account.
      </Alert>

      <Card>
        <CardHeader
          title="Float by account"
          description="Each account's own 1320-series ledger account, with what it holds now."
        />
        {data.accounts.ok ? (
          <DataTable caption="Electronic float by account">
            <thead>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Ledger account</TableHead>
                <TableHead align="numeric">Float held</TableHead>
                <TableHead align="numeric">In today</TableHead>
                <TableHead align="numeric">Out today</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.accounts.rows.length === 0 ? (
                <EmptyTableRow colSpan={7}>
                  No account holds electronic float in this scope.
                </EmptyTableRow>
              ) : (
                data.accounts.rows.map((row) => (
                  <TableRow key={row.floatAccountId}>
                    <TableCell>{row.providerName}</TableCell>
                    <TableCell>{row.label ?? row.tillName}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell>{row.ledgerAccountCode}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.floatBalance} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.depositValueToday} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.withdrawalValueToday} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.accounts} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Daily cash movement"
          description="Cash received, paid out and banked, by branch and day, from the Phase 4C view."
        />
        {data.movement.ok ? (
          <DataTable caption="Daily agency cash movement">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Source</TableHead>
                <TableHead align="numeric">Received</TableHead>
                <TableHead align="numeric">Paid out</TableHead>
                <TableHead align="numeric">Net</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.movement.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  No agency cash moved in this period.
                </EmptyTableRow>
              ) : (
                data.movement.rows.map((row) => (
                  <TableRow key={`${row.branchId}-${row.entryDate}-${row.sourceType}`}>
                    <TableCell>
                      <DateValue value={row.entryDate} />
                    </TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell>{row.sourceType}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.cashIn} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.cashOut} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={toUgx(row.netMovement)} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.movement} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Cash banked"
          description="Collected cash taken to the company's own bank accounts. Not a customer's banking, and not income."
        />
        {data.bankings.ok ? (
          <DataTable caption="Cash banked in the period">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Into</TableHead>
                <TableHead>Banked by</TableHead>
                <TableHead align="numeric">Amount</TableHead>
                <TableHead align="numeric">Charge</TableHead>
                <TableHead align="numeric">Net</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.bankings.rows.length === 0 ? (
                <EmptyTableRow colSpan={8}>
                  No cash was banked in this period.
                </EmptyTableRow>
              ) : (
                data.bankings.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <DateValue value={row.bankingDate} />
                    </TableCell>
                    <TableCell>{row.depositReference}</TableCell>
                    <TableCell wrap="clamp" title={row.bankAccountName}>
                      {row.bankAccountName}
                    </TableCell>
                    <TableCell>{row.bankedByName}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.amount} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.charge} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.netBanked} />
                    </TableCell>
                    <TableCell>{row.status}</TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.bankings} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Cash counts and variance"
          description="What was counted against what the book says, and whether the difference was certified."
        />
        {data.cashCounts.ok ? (
          <DataTable caption="Agency cash counts">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead align="numeric">Book</TableHead>
                <TableHead align="numeric">Counted</TableHead>
                <TableHead align="numeric">Variance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.cashCounts.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  No cash count was recorded in this period.
                </EmptyTableRow>
              ) : (
                data.cashCounts.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <DateValue value={row.reconciliationDate} />
                    </TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.systemClosingBalance} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.physicalCount} />
                    </TableCell>
                    <TableCell align="numeric">
                      {/* The sign convention comes from the database per
                          row: cash is the count less the books, float is the
                          books less the statement, and a screen that stated
                          either from memory would eventually state it
                          backwards. */}
                      <VarianceBadge variance={row.variance} means={row.varianceMeans} />
                    </TableCell>
                    <TableCell>{row.status}</TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.cashCounts} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commission — §6.4
// ---------------------------------------------------------------------------

function Commission({ data }: { readonly data: AgencyReportData }) {
  return (
    <div className="min-w-0 space-y-4">
      <Alert tone="info" title="Earned is not received">
        Client Rule 3: commission is earned every day, and that does not mean it is paid
        every day. Earned, settled and outstanding are three columns because they are
        three facts, and the provider&rsquo;s payment schedule is not yet confirmed.
      </Alert>

      <Card>
        <CardHeader
          title="By provider and branch"
          description="Attributed by source entity rather than by account, because GL 1310 is shared between providers and an account-level total would mix them."
        />
        {data.commission.ok ? (
          <DataTable caption="Commission earned, received and outstanding">
            <thead>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead align="numeric">Earned</TableHead>
                <TableHead align="numeric">Received</TableHead>
                <TableHead align="numeric">Returned</TableHead>
                <TableHead align="numeric">Outstanding</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.commission.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  No commission has been recognised yet.
                </EmptyTableRow>
              ) : (
                data.commission.rows.map((row) => (
                  <TableRow key={`${row.providerId}-${row.branchId}`}>
                    <TableCell>{row.providerName}</TableCell>
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
                      <Money amount={row.outstanding} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.commission} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="By account"
          description="Per agent account or agent line: what the provider still owes it, and what it owes back."
        />
        {data.accounts.ok ? (
          <DataTable caption="Commission by account">
            <thead>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead align="numeric">Earned today</TableHead>
                <TableHead align="numeric">Receivable</TableHead>
                <TableHead align="numeric">Owed back</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.accounts.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>
                  No account is registered in this scope.
                </EmptyTableRow>
              ) : (
                data.accounts.rows.map((row) => (
                  <TableRow key={row.floatAccountId}>
                    <TableCell>{row.providerName}</TableCell>
                    <TableCell>
                      <Link
                        href={`${ROUTES.agencyAccounts}/${row.floatAccountId}`}
                        className="text-link font-semibold hover:underline"
                      >
                        {row.label ?? row.tillName}
                      </Link>
                    </TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.commissionToday} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.commissionOutstanding} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.recoveryOwed} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.accounts} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlements — §6.6, the settlement half
// ---------------------------------------------------------------------------

function Settlements({ data }: { readonly data: AgencyReportData }) {
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader
          title="Commission settlements"
          description="What a provider has actually paid, with the officer who recorded it and the one who posted it."
        />
        {data.commissionSettlements.ok ? (
          <DataTable caption="Commission settlements">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Statement</TableHead>
                <TableHead align="numeric">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Settled into</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.commissionSettlements.rows.length === 0 ? (
                <EmptyTableRow colSpan={7}>
                  No commission settlement has been recorded.
                </EmptyTableRow>
              ) : (
                data.commissionSettlements.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <DateValue value={row.settlementDate} />
                    </TableCell>
                    <TableCell>{row.providerName}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell>{row.providerStatementRef ?? '—'}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.settlementAmount} />
                    </TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell wrap="wrap">
                      {/* The register carries the settlement account and the
                          reversal's reason; the maker and checker are on the
                          settlement's own screen, where the decision is made.
                          Inventing names here would mean a second join that
                          could disagree with that screen. */}
                      <span className="text-text-muted text-xs">
                        {row.settlementAccountCode}
                        {row.reversalReason === null
                          ? ''
                          : ` · reversed: ${row.reversalReason}`}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.commissionSettlements} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Provider remittances"
          description="Money collected on a provider's behalf and paid onward. Not commission — this is the customer's money leaving."
        />
        {data.payables.ok ? (
          <DataTable caption="Provider payable position">
            <thead>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead align="numeric">Collected</TableHead>
                <TableHead align="numeric">Remitted</TableHead>
                <TableHead align="numeric">Reversed</TableHead>
                <TableHead align="numeric">Outstanding</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.payables.rows.length === 0 ? (
                <EmptyTableRow colSpan={6}>No provider payable has arisen.</EmptyTableRow>
              ) : (
                data.payables.rows.map((row) => (
                  <TableRow key={`${row.providerId}-${row.branchId}`}>
                    <TableCell>{row.providerName}</TableCell>
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
                      <Money amount={row.outstanding} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.payables} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reconciliation — §6.6, the reconciliation half
// ---------------------------------------------------------------------------

function Reconciliation({ data }: { readonly data: AgencyReportData }) {
  return (
    <div className="min-w-0 space-y-4">
      <Alert tone="info" title="Two conventions, each stated per row">
        A cash variance is the count less the books; a float variance is the books less
        the provider&rsquo;s statement. The database states which it is on every row, and
        this report carries that statement through rather than inferring it from the sign.
      </Alert>

      <Card>
        <CardHeader
          title="Every variance"
          description="System balance against counted or statement balance, with whether it has been resolved."
        />
        {data.variances.ok ? (
          <DataTable caption="Agency variance report">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead align="numeric">System</TableHead>
                <TableHead align="numeric">Counted / statement</TableHead>
                <TableHead align="numeric">Variance</TableHead>
                <TableHead align="numeric">Written off</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Maker / checker</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.variances.rows.length === 0 ? (
                <EmptyTableRow colSpan={10}>
                  Nothing has been reconciled in this period, so there is no variance to
                  report.
                </EmptyTableRow>
              ) : (
                data.variances.rows.map((row) => (
                  <TableRow key={`${row.kind}-${row.id}`}>
                    <TableCell>
                      <DateValue value={row.reconciliationDate} />
                    </TableCell>
                    <TableCell>{row.kind === 'cash' ? 'Cash' : 'Float'}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell>{row.providerName ?? '—'}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.systemClosingBalance} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.countedOrStatement} />
                    </TableCell>
                    <TableCell align="numeric">
                      <VarianceBadge variance={row.variance} means={row.varianceMeans} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={toUgx(row.varianceWrittenOff)} />
                    </TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell wrap="clamp">
                      <span className="text-xs">
                        {row.createdBy ?? '—'}
                        {row.reconciledBy === null ? '' : ` → ${row.reconciledBy}`}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.variances} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Float statements"
          description="A provider's own statement balance against the account's ledger balance."
        />
        {data.floatStatements.ok ? (
          <DataTable caption="Agency float reconciliations">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Statement</TableHead>
                <TableHead align="numeric">Book</TableHead>
                <TableHead align="numeric">Statement balance</TableHead>
                <TableHead align="numeric">Variance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {data.floatStatements.rows.length === 0 ? (
                <EmptyTableRow colSpan={8}>
                  No float statement has been reconciled in this period.
                </EmptyTableRow>
              ) : (
                data.floatStatements.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <DateValue value={row.reconciliationDate} />
                    </TableCell>
                    <TableCell>{row.providerName}</TableCell>
                    <TableCell>{row.branchCode}</TableCell>
                    <TableCell>{row.providerStatementRef ?? '—'}</TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.systemClosingBalance} />
                    </TableCell>
                    <TableCell align="numeric">
                      <Money amount={row.providerStatementBalance} />
                    </TableCell>
                    <TableCell align="numeric">
                      <VarianceBadge variance={row.variance} means={row.varianceMeans} />
                    </TableCell>
                    <TableCell>{row.status}</TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={data.floatStatements} />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent performance — §6.5
// ---------------------------------------------------------------------------

/**
 * What each staff member handled in the period.
 *
 * ## Why this is counted here and not in the database
 *
 * Every figure below is a **count or a sum of the rows the database already
 * returned**, grouped by the officer named on each. That is reporting, not a
 * financial calculation: no balance is derived, nothing is apportioned, and
 * the amounts are the principals the journal already holds.
 *
 * The client's §6.5 is explicit about the line this must not cross: "Do not
 * treat the full monetary volume of customer transactions as profit." So the
 * volume columns are labelled as service volume and the commission column is
 * absent — commission is earned by an *account*, not by the officer who
 * happened to key the transaction, and attributing it to a person would be
 * inventing an allocation rule the business has not stated.
 */
function Performance({ data }: { readonly data: AgencyReportData }) {
  if (!data.transactions.ok) return <AgencyReadError failure={data.transactions} />;

  // The same tally the exported file uses, so the table and the download
  // cannot disagree about what "handled" means. See
  // `tallyAgentPerformance`.
  const rows = tallyAgentPerformance(data.transactions.rows);

  return (
    <div className="min-w-0 space-y-4">
      <Alert tone="info" title="Service volume is not profit">
        The values below are what customers moved through the counter. None of it is the
        company&rsquo;s money or its income. Commission is earned by an account rather
        than by the officer who keyed the transaction, so it is reported per account and
        is deliberately absent from this table.
      </Alert>

      <Card>
        <CardHeader
          title="By staff member"
          description="Counted over the transactions in this period, grouped by the officer named on each. Recording and verifying are separate columns, because verifying is a control rather than counter work."
        />
        <DataTable caption="Agent performance">
          <thead>
            <TableRow>
              <TableHead>Staff member</TableHead>
              <TableHead align="numeric">Recorded</TableHead>
              <TableHead align="numeric">Verified</TableHead>
              <TableHead align="numeric">Deposits</TableHead>
              <TableHead align="numeric">Deposit value</TableHead>
              <TableHead align="numeric">Withdrawals</TableHead>
              <TableHead align="numeric">Withdrawal value</TableHead>
              <TableHead align="numeric">Reversed</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyTableRow colSpan={8}>
                No transaction was recorded in this period, so there is nothing to
                attribute.
              </EmptyTableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell>{row.name}</TableCell>
                  <TableCell align="numeric">{row.recorded}</TableCell>
                  <TableCell align="numeric">{row.verified}</TableCell>
                  <TableCell align="numeric">{row.deposits}</TableCell>
                  <TableCell align="numeric">
                    <Money amount={toUgx(row.depositValue)} />
                  </TableCell>
                  <TableCell align="numeric">{row.withdrawals}</TableCell>
                  <TableCell align="numeric">
                    <Money amount={toUgx(row.withdrawalValue)} />
                  </TableCell>
                  <TableCell align="numeric">{row.reversed}</TableCell>
                </TableRow>
              ))
            )}
          </tbody>
        </DataTable>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export centre — §6.8
// ---------------------------------------------------------------------------

/**
 * Every report as a file, carrying the filter that produced it.
 *
 * ## Why the links carry the filter rather than offering their own controls
 *
 * Because the file has to be the report. A reader who has narrowed to one
 * bank and one month and then downloads a file covering everything has a file
 * that does not answer the question they were looking at, and nothing on the
 * page would have told them.
 *
 * So each link is the current filter with one section substituted, and the
 * export route reads the same filter the page did — through the same
 * `readAgencyReportFilter`, so the two cannot drift.
 */
function ExportCentre({ filter }: { readonly filter: AgencyReportFilter }) {
  const downloadable = AGENCY_REPORT_SECTIONS.filter(
    (section) => section !== 'overview' && section !== 'export',
  );

  return (
    <div className="min-w-0 space-y-4">
      <Alert tone="info" title="What a file carries">
        Every download carries its own heading, the period it covers, the filters that
        produced it and the moment it was generated — so a file that has left the screen
        can still be read for what it is. A spreadsheet file is CSV, which Excel and
        LibreOffice both open; money is written as plain digits with no separators, so a
        spreadsheet reads it as a number.
      </Alert>

      <Card>
        <CardHeader title="Download" />
        <ReportScopeLine filter={filter} />
        <DataTable caption="Agency report exports">
          <thead>
            <TableRow>
              <TableHead>Report</TableHead>
              <TableHead>What it holds</TableHead>
              <TableHead>Download</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {downloadable.map((section) => {
              const query = agencyReportHref(filter, section).split('?')[1] ?? '';
              const base = `${ROUTES.agencyReports}/export?${query}`;
              return (
                <TableRow key={section}>
                  <TableCell>{AGENCY_REPORT_SECTION_META[section].label}</TableCell>
                  <TableCell wrap="wrap">
                    <span className="text-text-muted text-xs">
                      {AGENCY_REPORT_SECTION_META[section].description}
                    </span>
                  </TableCell>
                  <TableCell wrap="wrap">
                    <span className="flex flex-wrap gap-2">
                      <a
                        href={`${base}&format=csv`}
                        className="text-link text-xs font-semibold hover:underline"
                      >
                        Spreadsheet (CSV)
                      </a>
                      <a
                        href={`${base}&format=pdf`}
                        className="text-link text-xs font-semibold hover:underline"
                      >
                        PDF
                      </a>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </tbody>
        </DataTable>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * The section the filter asks for.
 *
 * A `switch` over the declared section ids rather than a lookup object, so
 * adding a section to `AGENCY_REPORT_SECTIONS` without rendering it is a
 * compile error rather than a blank page.
 */
export function AgencyReportSection({
  filter,
  data,
}: {
  readonly filter: AgencyReportFilter;
  readonly data: AgencyReportData;
}) {
  switch (filter.section) {
    case 'overview':
      return <Overview filter={filter} data={data} />;
    case 'transactions':
      return <Transactions data={data} />;
    case 'cash-float':
      return <CashAndFloat data={data} />;
    case 'commission':
      return <Commission data={data} />;
    case 'settlements':
      return <Settlements data={data} />;
    case 'reconciliation':
      return <Reconciliation data={data} />;
    case 'performance':
      return <Performance data={data} />;
    case 'export':
      return <ExportCentre filter={filter} />;
  }
}
