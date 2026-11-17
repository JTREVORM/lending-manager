import { Landmark } from 'lucide-react';

import { BankDepositRegister } from '@/components/finance/bank-deposit-register';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getBankDeposits,
  getCashAvailability,
  getLedgerAccounts,
} from '@/lib/data/finance';

export const metadata = { title: 'Bank deposits' };

/**
 * Cash on its way to the bank, and what the bank did with it.
 *
 * A deposit used to be a transfer: it left the till and arrived in the bank
 * in the same instant, spendable before any bank had seen it. It is now three
 * states and two people — recorded by one officer, cleared by another against
 * the bank's own reference and value date — and in between it sits in Cash in
 * Transit, which belongs to the company and can be spent by nobody.
 */
export default async function DepositsPage() {
  const context = await guardPermission(ROUTES.deposits, 'deposits:view');

  const [deposits, accounts, availability] = await Promise.all([
    getBankDeposits(),
    getLedgerAccounts(),
    getCashAvailability(),
  ]);

  return (
    <>
      <PageHeader
        icon={Landmark}
        eyebrow="Finance"
        title="Bank deposits"
        description="Cash taken from a till to the bank. Until a different officer verifies the bank's clearance, it is in transit and nobody can spend it."
      />

      <BankDepositRegister
        deposits={deposits}
        accounts={accounts}
        availability={availability}
        canRecord={contextCan(context, 'deposits:create')}
        canVerify={contextCan(context, 'deposits:verify')}
        canReverse={contextCan(context, 'deposits:reverse')}
        className="mt-6"
      />
    </>
  );
}
