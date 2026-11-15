import { Banknote } from 'lucide-react';

import {
  CashBankingDecision,
  CashBankingForm,
} from '@/components/agency/cash-banking-forms';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { BUSINESS_TIMEZONE, ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyCashBankings,
  getBankAccountOptions,
  getBankingStaffOptions,
  getOperatingBranches,
} from '@/lib/data/agency';
import { getCashPositions } from '@/lib/data/finance';
import { businessToday } from '@/lib/domain/datetime';
import type { AgencyCashBankingStatus } from '@/lib/domain/agency';

export const metadata = { title: 'Cash banking' };

/** How a banking's state reads. */
function StatusBadge({ status }: { readonly status: AgencyCashBankingStatus }) {
  if (status === 'posted') return <Badge tone="success">Posted</Badge>;
  if (status === 'pending') return <Badge tone="warning">Awaiting a checker</Badge>;
  if (status === 'rejected') return <Badge tone="neutral">Rejected</Badge>;
  return <Badge tone="danger">Reversed</Badge>;
}

/**
 * Banking the cash an agent collected, under a maker-checker control.
 *
 * ## The business event, and the three things it is not
 *
 * Client Rule 5: "When an agent deposits collected physical cash into a bank,
 * POLYTOS must record the movement from Cash at Hand to the relevant bank
 * account. This must not be counted as a customer deposit, new revenue or
 * electronic float top-up."
 *
 * This screen is the only place the operation exists, and the database makes
 * the three misclassifications structurally impossible rather than merely
 * discouraged: `agency_cash_bankings` references no provider, no float till
 * and no transaction type, so there is nothing for a commission to attach to
 * and nothing for a float balance to move on.
 *
 * ## Why recording and deciding are on one screen
 *
 * Because the queue is the point. A recorded banking is somebody's cash
 * sitting between a till and a bank with nobody having checked the slip, and
 * the officer who posts it needs to see the figures beside the form that
 * produced them. The database refuses a post from whoever recorded it, so one
 * screen cannot become one person's whole workflow.
 */
export default async function CashBankingPage() {
  const context = await guardPermission(ROUTES.agencyCashBanking, 'agency:write');

  const canPost = contextCan(context, 'agency:settlements');
  const canReverse = contextCan(context, 'agency:reverse');

  const [bankings, accounts, staff, branches, cash] = await Promise.all([
    getAgencyCashBankings({ limit: 100 }),
    getBankAccountOptions(),
    getBankingStaffOptions(),
    getOperatingBranches(context.profileId),
    getCashPositions(),
  ]);

  const today = businessToday(new Date(), BUSINESS_TIMEZONE);

  const ownBranch = branches.ok ? branches.row.own : null;
  const branchChoices = branches.ok ? branches.row.choices : [];

  // What the branch's till holds, to inform the form. The branch is the
  // officer's own where they have one; for Head Office there is no single
  // till to quote, so the figure is omitted rather than guessed.
  //
  // `getCashPositions` returns an array and logs its own failure, so there is
  // no `ok` to check: an empty list and a failed read are the same answer to
  // this form, which is "no figure to quote".
  const cashOnHand =
    ownBranch === null
      ? null
      : (cash.find((r) => r.branchId === ownBranch.id)?.cashAtHand ?? null);

  const pending = bankings.ok ? bankings.rows.filter((r) => r.status === 'pending') : [];
  const bankedToday = bankings.ok
    ? bankings.rows
        .filter((r) => r.status === 'posted' && r.bankingDate === today)
        .reduce((sum, r) => sum + r.netBanked, 0)
    : 0;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agent Banking"
        icon={Banknote}
        title="Cash banking"
        description="An agent takes collected physical cash to the bank. Cash at Hand falls, the company's bank account rises."
        back={{ href: ROUTES.agencyBanking, label: 'Agent Banking' }}
      />

      <Alert tone="info" title="What this is, and what it is not">
        This records the company banking its own collected cash. It is not a
        customer&rsquo;s banking transaction — those are recorded at the counter — it is
        not income, and it does not add electronic float to an agent account. Topping up
        float is a separate operation, because the money comes from somewhere else and
        goes somewhere else.
      </Alert>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <MoneyStat
          label="Banked today"
          amount={bankedToday}
          note="Posted, net of bank charges"
        />
        <MoneyStat
          label="Awaiting a second officer"
          amount={pending.reduce((sum, r) => sum + r.amount, 0)}
          note={`${String(pending.length)} banking${pending.length === 1 ? '' : 's'} recorded and not yet posted`}
          tone={pending.length === 0 ? undefined : 'warning'}
        />
      </div>

      <CashBankingForm
        bankAccounts={accounts.ok ? accounts.rows : []}
        staff={staff.ok ? staff.rows : []}
        branches={branchChoices}
        ownBranch={ownBranch}
        cashOnHand={cashOnHand}
        today={today}
      />

      {accounts.ok ? null : <AgencyReadError failure={accounts} />}

      <Card>
        <CardHeader
          title="Recorded bankings"
          description="Newest first. A posted banking shows the journal it wrote; a rejected one keeps its reason."
        />
        {bankings.ok ? (
          <DataTable caption="Cash bankings">
            <thead>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Banked into</TableHead>
                <TableHead>Banked by</TableHead>
                <TableHead align="numeric">Amount</TableHead>
                <TableHead align="numeric">Charge</TableHead>
                <TableHead align="numeric">Net</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Maker / checker</TableHead>
                <TableHead>Decision</TableHead>
              </TableRow>
            </thead>
            <tbody>
              {bankings.rows.length === 0 ? (
                <EmptyTableRow colSpan={10}>
                  No cash banking has been recorded yet.
                </EmptyTableRow>
              ) : (
                bankings.rows.map((row) => (
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
                    <TableCell>
                      <StatusBadge status={row.status} />
                      {row.rejectedReason === null ? null : (
                        <span className="text-text-muted block text-xs">
                          {row.rejectedReason}
                        </span>
                      )}
                      {row.reversalReason === null ? null : (
                        <span className="text-text-muted block text-xs">
                          {row.reversalReason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell wrap="clamp">
                      <span className="text-xs">
                        {row.createdByName}
                        {row.verifiedByName === null ? '' : ` → ${row.verifiedByName}`}
                      </span>
                    </TableCell>
                    <TableCell wrap="wrap">
                      <CashBankingDecision
                        row={row}
                        canPost={canPost}
                        canReverse={canReverse}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </DataTable>
        ) : (
          <AgencyReadError failure={bankings} />
        )}
      </Card>
    </div>
  );
}
