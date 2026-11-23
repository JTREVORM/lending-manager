import { PiggyBank } from 'lucide-react';

import { CapitalRegister } from '@/components/finance/capital-register';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getCapitalAccountOptions,
  getCapitalFundings,
  getLedgerAccounts,
  summariseCapital,
} from '@/lib/data/finance';

export const metadata = { title: 'Capital introduced' };

/**
 * The money the business was started and funded with.
 *
 * ## Why this screen exists
 *
 * POLYTOS could account for every shilling that moved through it and not for
 * the shillings it began with. `3000 Owner Capital` has existed since Phase
 * 10 and exactly one thing ever credited it: the Phase 10 backfill, which
 * *derived* an opening balance by finding the deepest the cash position ever
 * reached and crediting the difference so the books would not go negative.
 * That was right for a migration reconstructing history it was not present
 * for. It is not a way to record capital, and there was no other.
 *
 * ## The one distinction the screen is built around
 *
 * Equity is the owner's own money: not repayable, no interest, crediting the
 * 3000 series, and the business's net worth rises by the whole amount.
 * Borrowing is somebody else's: repayable, possibly interest-bearing,
 * crediting a 2300-series liability, and net worth does not change at all.
 * Before this, a lender who advanced 20,000,000 was indistinguishable from an
 * owner who contributed it.
 *
 * ## Why nothing here posts
 *
 * Recording writes a document. A second Owner checks it against the evidence,
 * and that is what writes the journal. Capital is the largest single entry
 * this business will ever make and the least self-correcting: a short till
 * shows up at the next cash count, a float that is wrong shows up at the next
 * reconciliation, and an equity credit that is wrong shows up nowhere. So one
 * person records what the evidence says and a second checks it.
 */
export default async function CapitalPage() {
  const context = await guardPermission(ROUTES.capital, 'capital:view');

  const [fundings, accounts, capitalAccounts] = await Promise.all([
    getCapitalFundings(),
    getLedgerAccounts(),
    getCapitalAccountOptions(),
  ]);

  // Capital arrives as money, so it lands where money is held. The database
  // refuses anything else — `capital_funding_accounts_guard()` checks the
  // kind, the branch and the postability under lock — and this list is the
  // same rule, applied early so the picker offers nothing that would fail.
  const destinations = accounts
    .filter(
      (account) =>
        account.isPostable &&
        (account.cashKind === 'cash_at_hand' || account.cashKind === 'bank'),
    )
    .map((account) => ({
      id: account.accountId,
      code: account.code,
      name: account.name,
    }));

  return (
    <>
      <PageHeader
        icon={PiggyBank}
        eyebrow="Finance"
        title="Capital introduced"
        description="The owner's own money, and the money the business has borrowed. Recording one posts nothing: a second Owner checks it against the evidence, and that writes the journal entry."
      />

      <CapitalRegister
        fundings={fundings}
        position={summariseCapital(fundings)}
        destinations={destinations}
        equityAccounts={capitalAccounts.equity}
        borrowingAccounts={capitalAccounts.borrowings}
        canRecord={contextCan(context, 'capital:record')}
        canVerify={contextCan(context, 'capital:verify')}
        canReverse={contextCan(context, 'capital:reverse')}
        className="mt-6"
      />
    </>
  );
}
