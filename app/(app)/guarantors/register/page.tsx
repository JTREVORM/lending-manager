import { HeartHandshake } from 'lucide-react';

import { PageHeader } from '@/components/ui/page-header';
import { GuarantorExposureRegister } from '@/components/guarantors/guarantor-exposure-register';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { requirePermission } from '@/lib/auth/context';
import { getLoanProducts } from '@/lib/data/products';
import { listGuarantorExposure } from '@/lib/data/security';
import { guarantorRegisterSearchSchema } from '@/lib/validation/security';

export const metadata = { title: 'Guarantor register' };

/**
 * The guarantor register: every guarantee, with its exposure.
 *
 * ## Two capabilities, not one
 *
 * The route map puts this behind `guarantors:view`, which is the floor for
 * anything under `/guarantors`. But a register that names a borrower, their
 * loan and what is still owed on it is a view of the loan book as much as of
 * the guarantor directory — so the page also requires `loans:view`, checked
 * here because a prefix map cannot express a conjunction.
 *
 * The policies on `loan_guarantors`, `loans` and `clients` decide which rows
 * come back and would refuse a caller who reached the data another way. This
 * check is so that somebody who cannot see loans is turned away at the door
 * rather than shown an empty table and left wondering.
 */
export default async function GuarantorRegisterPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.guarantorRegister, 'guarantors:view');
  await requirePermission('loans:view');

  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // An unrecognised filter falls back to the unfiltered register rather than
  // erroring: a hand-edited query string should show the rows, not a crash.
  const parsed = guarantorRegisterSearchSchema.safeParse({
    query: single('query'),
    subjectKind: single('subjectKind'),
    guaranteeStatus: single('guaranteeStatus'),
    productId: single('productId'),
    page: single('page'),
  });

  const filter = parsed.success
    ? parsed.data
    : {
        query: null,
        subjectKind: null,
        guaranteeStatus: null,
        productId: null,
        page: 1 as const,
      };

  const [register, products] = await Promise.all([
    listGuarantorExposure(filter),
    getLoanProducts(),
  ]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Debt & Security"
        icon={HeartHandshake}
        back={{ href: ROUTES.guarantors, label: 'Guarantors' }}
        title="Guarantor register"
        description="Who stands for whom, for how much, and whether the undertaking still binds."
      />

      <GuarantorExposureRegister
        rows={register.rows}
        page={register.page}
        hasMore={register.hasMore}
        products={products.map((product) => ({
          id: product.productId,
          label: `${product.productCode} — ${product.name}`,
        }))}
      />
    </div>
  );
}
