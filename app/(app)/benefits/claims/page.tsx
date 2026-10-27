import { HeartHandshake } from 'lucide-react';

import { BenefitClaimRegister } from '@/components/benefits/benefit-claim-register';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { listBenefitClaims } from '@/lib/data/benefits';
import { benefitClaimSearchSchema } from '@/lib/validation/benefits';

export const metadata = { title: 'Benefit claims' };

/**
 * The claim register.
 *
 * Filters are read from the query string and parsed with
 * `benefitClaimSearchSchema`; a malformed one falls back to the default view
 * rather than erroring, because a filter is a convenience and not a control —
 * which rows a caller may see is decided by Row Level Security whatever the
 * URL says.
 */
export default async function BenefitClaimsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.benefitClaims, 'benefits:view');
  const params = await searchParams;

  const parsed = benefitClaimSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    type: typeof params.type === 'string' ? params.type : 'all',
    status: typeof params.status === 'string' ? params.status : 'all',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const filter = parsed.success
    ? parsed.data
    : { query: null, type: 'all' as const, status: 'all' as const, page: 1 };

  const page = await listBenefitClaims(filter);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={HeartHandshake}
        title="Benefit claims"
        description="Every medical, family condolence and member bereavement claim. Search by claim number, membership number, member name or client number."
        back={{ href: ROUTES.benefits, label: 'Benefits' }}
        primaryAction={
          contextCan(context, 'benefits:claim') ? (
            <ActionLink href={ROUTES.newBenefitClaim}>Open a claim</ActionLink>
          ) : undefined
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
