import { ShieldCheck } from 'lucide-react';

import { BenefitClaimRegister } from '@/components/benefits/benefit-claim-register';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { listBenefitClaims } from '@/lib/data/benefits';
import { benefitClaimSearchSchema } from '@/lib/validation/benefits';

export const metadata = { title: 'Benefit approvals' };

/**
 * The approval queue: an Owner's list of decisions.
 *
 * Opens on `assessed` rather than on everything, because this screen exists to
 * be worked through — the same judgement the withdrawal queue made. A queue
 * that opened on the full register would make the common question, "what is
 * waiting for me", the one that needs a filter applied first.
 *
 * The filters still work, so the same screen answers "what did I approve last
 * week" without a second page.
 *
 * ## An empty queue is good news
 *
 * Nothing is waiting for an approver. The register's own empty state says so
 * and offers no action, because there is nothing an Owner should do about it.
 */
export default async function BenefitApprovalsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.benefitApprovals, 'benefits:approve');
  const params = await searchParams;

  const parsed = benefitClaimSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    type: typeof params.type === 'string' ? params.type : 'all',
    status: typeof params.status === 'string' ? params.status : 'assessed',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const filter = parsed.success
    ? parsed.data
    : { query: null, type: 'all' as const, status: 'assessed' as const, page: 1 };

  const page = await listBenefitClaims(filter);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={ShieldCheck}
        title="Benefit approvals"
        description="Assessed claims waiting for a decision. A claim cannot be approved by whoever assessed it, and an approval agrees to the assessed figure exactly — there is nothing to adjust."
        back={{ href: ROUTES.benefits, label: 'Benefits' }}
        secondaryActions={
          <ActionLink href={ROUTES.benefitClaims} variant="secondary">
            Claim register
          </ActionLink>
        }
      />

      <BenefitClaimRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          type: filter.type === 'all' ? '' : filter.type,
          status: filter.status === 'all' ? '' : filter.status,
        }}
      />
    </div>
  );
}
