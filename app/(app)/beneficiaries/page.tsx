import { UserRoundCheck } from 'lucide-react';

import { BeneficiaryRegister } from '@/components/benefits/beneficiary-register';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listBeneficiaries } from '@/lib/data/benefits';
import { beneficiarySearchSchema } from '@/lib/validation/benefits';

export const metadata = { title: 'Next of kin' };

/**
 * The beneficiary register.
 *
 * ## Why this is a section of its own and not only a panel
 *
 * It is both. The panel on a membership profile answers "who is this member's
 * next of kin", which is where a beneficiary is registered and read. This
 * register answers the opposite question — *which* members have nobody
 * checked — and that question has no home on any one member's page.
 *
 * It is the question that matters: an unverified beneficiary is a bereavement
 * benefit that cannot be paid, and it is discovered on the worst possible day
 * unless somebody can list them.
 *
 * ## Guarded by `beneficiaries:view`, not `benefits:view`
 *
 * Different work. Recording next of kin is counter work a Secretary does all
 * day; assessing a claim is not. So the capability is its own, and this route
 * is reachable by somebody who holds no benefit capability beyond opening a
 * claim.
 */
export default async function BeneficiariesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.beneficiaries, 'beneficiaries:view');
  const params = await searchParams;

  const parsed = beneficiarySearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    verification: typeof params.verification === 'string' ? params.verification : 'all',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const filter = parsed.success
    ? parsed.data
    : { query: null, verification: 'all' as const, page: 1 };

  const page = await listBeneficiaries(filter);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={UserRoundCheck}
        title="Next of kin"
        description="Every member's registered beneficiary and whether anybody has checked it. A beneficiary's name and telephone number are on the record itself, not in this list."
        primaryAction={
          contextCan(context, 'beneficiaries:manage') ? (
            <ActionLink href={`${ROUTES.beneficiaries}/new`}>
              Register a beneficiary
            </ActionLink>
          ) : undefined
        }
        secondaryActions={
          contextCan(context, 'benefits:view') ? (
            <ActionLink href={ROUTES.benefits} variant="secondary">
              Benefits
            </ActionLink>
          ) : undefined
        }
      />

      <BeneficiaryRegister
        page={page}
        filter={{
          query: filter.query ?? '',
          verification: filter.verification === 'all' ? '' : filter.verification,
        }}
      />
    </div>
  );
}
