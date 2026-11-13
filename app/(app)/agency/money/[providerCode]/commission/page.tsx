import { HandCoins } from 'lucide-react';

import {
  CommissionPayoutForm,
  CommissionRecoveryForm,
} from '@/components/agency/commission-money-forms';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money, MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyTableRow } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyCommissionMonths, getAgencyLineCommission } from '@/lib/data/agency';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Mobile Money commission' };

/**
 * Commission on one provider's agent lines.
 *
 * ## Why the per-line figures and the provider figure are both shown
 *
 * GL 1310 is shared: every provider's commission receivable sits in the same
 * account, attributed by source entity. Phase 4E added the per-line view on
 * top of that attribution, and the two must agree — the sum of the lines at
 * a branch is the provider's figure at that branch. The database tests
 * assert that; this screen shows both so a discrepancy would be visible to
 * an officer rather than only to a test.
 *
 * ## Why a payout raises float rather than cash
 *
 * MTN and Airtel settle commission by crediting the agent line, not by
 * handing over money. So the payout debits the line's float account and
 * clears the receivable, and no cash account is touched. The form says so,
 * because an officer expecting the drawer to rise will count it as missing.
 */
export default async function AgencyMoneyCommissionPage({
  params,
}: {
  readonly params: Promise<{ readonly providerCode: string }>;
}) {
  const { providerCode } = await params;
  const context = await guardPermission(ROUTES.agencyMoney, 'agency:reports');

  const [lines, months] = await Promise.all([
    getAgencyLineCommission({ providerCode }),
    getAgencyCommissionMonths({ providerCode, limit: 60 }),
  ]);

  const header = (
    <PageHeader
      eyebrow="Mobile Money"
      icon={HandCoins}
      title="Commission"
      description="What each agent line has earned, what the provider has paid in, and what has to go back."
      back={{
        href: `${ROUTES.agencyMoney}/${providerCode}`,
        label: 'Back to the provider',
      }}
    />
  );

  if (!lines.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={lines} />
      </div>
    );
  }

  const outstanding = lines.rows.reduce((sum, l) => sum + l.commissionOutstanding, 0);
  const owedBack = lines.rows.reduce((sum, l) => sum + l.recoveryOwed, 0);
  const floatHeld = lines.rows.reduce((sum, l) => sum + l.floatBalance, 0);

  const canSettle = contextCan(context, 'agency:settlements');

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <MoneyStat
          label="Owed to us"
          amount={toUgx(outstanding)}
          note="Earned, not yet paid in"
        />
        <MoneyStat
          label="Owed back"
          amount={toUgx(owedBack)}
          note="Recovered after reversals"
          tone={owedBack > 0 ? 'warning' : undefined}
        />
        <MoneyStat label="Float held" amount={toUgx(floatHeld)} note="On these lines" />
      </div>

      <DataTable caption="Commission by agent line" stickyHeader>
        <thead>
          <tr>
            <TableHead width="name">Line</TableHead>
            <TableHead width="ref">Branch</TableHead>
            <TableHead align="numeric" width="money">
              Owed to us
            </TableHead>
            <TableHead align="numeric" width="money">
              Owed back
            </TableHead>
            <TableHead align="numeric" width="money">
              Float
            </TableHead>
          </tr>
        </thead>
        <tbody>
          {lines.rows.length === 0 ? (
            <EmptyTableRow colSpan={5}>
              No agent line for this provider at a branch you can see.
            </EmptyTableRow>
          ) : (
            lines.rows.map((l) => (
              <TableRow key={l.floatAccountId}>
                <TableCell header>{l.label ?? l.tillName}</TableCell>
                <TableCell>{l.branchCode}</TableCell>
                <TableCell align="numeric">
                  <span className="font-semibold tabular-nums">
                    <Money amount={l.commissionOutstanding} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={l.recoveryOwed} />
                  </span>
                </TableCell>
                <TableCell align="numeric">
                  <span className="tabular-nums">
                    <Money amount={l.floatBalance} />
                  </span>
                </TableCell>
              </TableRow>
            ))
          )}
        </tbody>
      </DataTable>

      {canSettle ? (
        <>
          <CommissionPayoutForm lines={lines.rows} />
          <CommissionRecoveryForm lines={lines.rows} />
        </>
      ) : (
        <Alert tone="info">
          Recording a payout or a recovery needs the settlement capability. You can see
          what is outstanding but not clear it.
        </Alert>
      )}

      {months.ok ? (
        <DataTable caption="Commission earned by calendar month" stickyHeader>
          <thead>
            <tr>
              <TableHead width="ref">Month</TableHead>
              <TableHead width="name">Line</TableHead>
              <TableHead align="numeric">Transactions</TableHead>
              <TableHead align="numeric" width="money">
                Value
              </TableHead>
              <TableHead align="numeric" width="money">
                Customer fees
              </TableHead>
              <TableHead align="numeric" width="money">
                Commission
              </TableHead>
            </tr>
          </thead>
          <tbody>
            {months.rows.length === 0 ? (
              <EmptyTableRow colSpan={6}>
                Nothing has been posted on a line you can see.
              </EmptyTableRow>
            ) : (
              months.rows.map((m) => (
                <TableRow key={`${m.floatAccountId}-${m.monthStart}`}>
                  <TableCell>
                    <DateValue value={m.monthStart} />
                  </TableCell>
                  <TableCell header>{m.label ?? m.tillName}</TableCell>
                  <TableCell align="numeric">
                    <span className="tabular-nums">{m.transactions}</span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span className="tabular-nums">
                      <Money amount={m.principal} />
                    </span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span className="tabular-nums">
                      <Money amount={m.customerFees} />
                    </span>
                  </TableCell>
                  <TableCell align="numeric">
                    <span className="font-semibold tabular-nums">
                      <Money amount={m.commissionEarned} />
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </tbody>
        </DataTable>
      ) : (
        <AgencyReadError failure={months} />
      )}

      <Alert tone="info">
        The calendar month above is a management report. The provider&rsquo;s own
        statement period is reconciled separately, on the statements screen, because the
        two rarely cover the same days.
      </Alert>
    </div>
  );
}
