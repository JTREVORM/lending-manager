import { Receipt } from 'lucide-react';

import { BenefitPaymentRegister } from '@/components/benefits/benefit-payment-register';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listBenefitPayments } from '@/lib/data/benefits';
import { isBenefitClaimType } from '@/lib/domain/benefits';

export const metadata = { title: 'Benefit payments' };

/**
 * What has actually been paid out.
 *
 * ## Why this is a separate screen from the approval queue
 *
 * They are different people's work and different questions. An approver asks
 * "should this be paid"; whoever holds `benefits:pay` asks "has it been, and
 * does the ledger agree". A single screen would serve one of them badly.
 *
 * Paying happens on the claim rather than here, because a payment needs the
 * assessment, the frozen payee and the approved figure in front of the person
 * recording it — and because the idempotency key has to be minted for one
 * specific claim as its form renders. This register is the record afterwards.
 *
 * ## A reader without `membership:view_sensitive` sees fewer rows
 *
 * The policy withholds payments whose payee is a beneficiary, since the row
 * carries their name. That is stated on the page rather than left to be
 * noticed, because a reconciliation that is quietly missing rows is worse
 * than one that says which rows it cannot show.
 */
export default async function BenefitPaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.benefitPayments, 'benefits:pay');
  const params = await searchParams;

  const type = typeof params.type === 'string' ? params.type : '';
  const pageParam = typeof params.page === 'string' ? Number(params.page) : 1;

  const page = await listBenefitPayments({
    page: Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1,
    ...(isBenefitClaimType(type) ? { claimType: type } : {}),
  });

  const seesEverything = contextCan(context, 'membership:view_sensitive');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={Receipt}
        title="Benefit payments"
        description="Every benefit the business has paid, with the journal entry behind it. A payment is recorded on the claim; this is the record afterwards."
        back={{ href: ROUTES.benefits, label: 'Benefits' }}
        secondaryActions={
          <ActionLink href={ROUTES.benefitApprovals} variant="secondary">
            Approval queue
          </ActionLink>
        }
      />

      {seesEverything ? null : (
        <p className="text-text-muted text-sm">
          Payments made to a registered next of kin are not listed for you: the row
          carries the payee&rsquo;s name, which needs the sensitive-detail permission.
          Medical and family condolence payments are all here.
        </p>
      )}

      <BenefitPaymentRegister
        page={page}
        filter={{ type: isBenefitClaimType(type) ? type : '', from: '', to: '' }}
      />
    </div>
  );
}
