import { Banknote } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';

import {
  CashCountForm,
  CashCountRegister,
} from '@/components/agency/reconciliation-forms';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyCashCounts } from '@/lib/data/agency';
import { getLedgerAccounts } from '@/lib/data/finance';

export const metadata = { title: 'Physical cash reconciliation' };

/**
 * Counting the drawer the agency counter works out of.
 *
 * Two officers, as everywhere else that money is certified: one counts and
 * records the reading, a second certifies it. Writing a difference into the
 * ledger is a third thing again and needs the Owner's own capability, which
 * is why the write-off appears as a checkbox inside certification rather than
 * as a button of its own.
 *
 * The register shows the balance the books held when the count was taken and
 * the balance they hold now, side by side, because a count whose account has
 * moved since cannot be certified - its difference no longer describes
 * anything. That refusal is the database's; this screen only spares the
 * officer from walking into it.
 */
export default async function AgencyCashReconciliationPage() {
  const context = await guardPermission(ROUTES.agencyCashCount, 'agency:reconcile');

  const [rows, accounts] = await Promise.all([
    getAgencyCashCounts({ limit: 100 }),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  // Cash at hand only, and only where it belongs to a branch. The database
  // refuses a bank account, a mobile money wallet and an agency float till -
  // offering one here would be offering a refusal.
  const countable = accounts
    .filter((a) => a.cashKind === 'cash_at_hand' && a.branchId !== null)
    .map((a) => ({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      branchId: a.branchId,
    }));

  const canAdjust = contextCan(context, 'agency:variance_adjustment');

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Agency Banking"
        icon={Banknote}
        title="Physical cash reconciliation"
        description="Count the drawer, and have a second officer certify the reading."
        back={{ href: ROUTES.agency, label: 'Agency Services' }}
      />

      <Alert tone="info">
        A count is a reading, not a correction. Certifying one leaves the difference
        outstanding unless an Owner writes it off, which posts it to the shortages and
        overages account.
      </Alert>

      <CashCountForm accounts={countable} />

      {rows.ok ? (
        <CashCountRegister
          rows={rows.rows}
          profileId={context.profileId}
          canAdjust={canAdjust}
        />
      ) : (
        <AgencyReadError failure={rows} />
      )}
    </div>
  );
}
