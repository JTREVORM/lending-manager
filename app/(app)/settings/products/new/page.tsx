import { PackageOpen } from 'lucide-react';

import { PageHeader } from '@/components/ui/page-header';
import { ProductForm } from '@/components/settings/product-form';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getBranchOptions, getCadenceOptions } from '@/lib/data/products';

export const metadata = { title: 'New loan product' };

/**
 * Creating a product.
 *
 * `products:manage`, which only the Owner holds — the same capability the
 * action re-checks and the same one the insert policy requires. Reading the
 * products is a wider capability; writing one is not, because a product holds
 * the rate the business lends at.
 */
export default async function NewLoanProductPage() {
  await guardPermission(ROUTES.newLoanProduct, 'products:manage');

  const [branches, cadences] = await Promise.all([
    getBranchOptions(),
    getCadenceOptions(),
  ]);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Lending"
        icon={PackageOpen}
        back={{ href: ROUTES.loanProducts, label: 'Loan products' }}
        title="New loan product"
        description="The terms this product will carry. Each one is snapshotted onto a loan when it is approved."
      />

      <ProductForm branches={branches} cadences={cadences} />
    </div>
  );
}
