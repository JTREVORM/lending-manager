import { HeartHandshake } from 'lucide-react';

import { GuarantorDirectory } from '@/components/guarantors/guarantor-directory';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { listGuarantors } from '@/lib/data/guarantors';
import { guarantorSearchSchema } from '@/lib/validation/client';

export const metadata = { title: 'Guarantors' };

/**
 * The guarantor directory.
 *
 * Reachable with `guarantors:view`, which no borrower holds — so this screen
 * does not exist for them at any URL, not merely in their navigation.
 */
export default async function GuarantorsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.guarantors, 'guarantors:view');
  const params = await searchParams;

  const parsed = guarantorSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const filter = parsed.success ? parsed.data : { query: null, page: 1 };
  const page = await listGuarantors(filter);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Loan Security"
        icon={HeartHandshake}
        title="Guarantors"
        description="Search before registering someone new — the same person often stands for more than one client."
      />

      <GuarantorDirectory page={page} query={filter.query ?? ''} />
    </div>
  );
}
