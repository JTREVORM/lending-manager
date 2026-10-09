import { PackageOpen } from 'lucide-react';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { ProductForm } from '@/components/settings/product-form';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getBranchOptions, getCadenceOptions, getLoanProduct } from '@/lib/data/products';
import { PRODUCT_STATUS_LABELS, labelFor } from '@/lib/domain/loan-product';

export const metadata = { title: 'Loan product' };

/**
 * Changing a product's terms.
 *
 * ## What cannot be changed here
 *
 * The product code, because it appears on every approved loan's snapshot and
 * on every export — renaming it would relabel history. The form shows it and
 * disables it, and `loan_products_stamp_actor` restores it if a request
 * carries one anyway.
 *
 * ## What changing the terms does to existing loans
 *
 * Nothing. Their terms were snapshotted at approval onto
 * `loan_product_snapshots`, which is append-only. The screen says so, and the
 * count of loans already written against the product is shown beside it so an
 * Owner can see what they are not changing.
 */
export default async function EditLoanProductPage({
  params,
}: {
  readonly params: Promise<{ readonly productId: string }>;
}) {
  const { productId } = await params;

  await guardPermission(`${ROUTES.loanProducts}/${productId}`, 'products:manage');

  const [product, branches, cadences] = await Promise.all([
    getLoanProduct(productId),
    getBranchOptions(),
    getCadenceOptions(),
  ]);

  if (product === null) notFound();

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Lending"
        icon={PackageOpen}
        back={{ href: ROUTES.loanProducts, label: 'Loan products' }}
        title={product.name}
        description={<span className="font-mono">{product.productCode}</span>}
        status={
          <span className="flex flex-wrap gap-1.5">
            {product.isDefault ? <Badge tone="info">Default</Badge> : null}
            <Badge tone={product.status === 'active' ? 'success' : 'neutral'}>
              {labelFor(PRODUCT_STATUS_LABELS, product.status)}
            </Badge>
          </span>
        }
      />

      {product.loansWritten === 0 ? null : (
        <Alert
          tone="info"
          title={`${String(product.loansWritten)} loans are written against this product`}
        >
          Each of them keeps the terms it was approved under. Nothing you change here
          reaches them.
        </Alert>
      )}

      <ProductForm product={product} branches={branches} cadences={cadences} />
    </div>
  );
}
