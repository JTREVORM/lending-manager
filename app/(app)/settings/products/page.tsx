import { PackageOpen } from 'lucide-react';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ProductControls } from '@/components/settings/product-controls';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getLoanProducts } from '@/lib/data/products';
import {
  APPLICATION_PROFILE_LABELS,
  PRODUCT_STATUS_LABELS,
  describeTerms,
  labelFor,
} from '@/lib/domain/loan-product';
import { formatBps, toBps } from '@/lib/domain/rate';

export const metadata = { title: 'Loan products' };

/**
 * What the business sells.
 *
 * ## Why this is its own screen and not a Settings section
 *
 * Two reasons. The first is capability: `products:view` is held by the
 * Secretary/Treasurer and the Manager, neither of whom holds
 * `settings:view` — so a product list nested behind the Settings page would
 * be a list they could see in the menu and never open. The second is size: a
 * product has about twenty terms, and four products at twenty terms is not a
 * card on a page about something else.
 *
 * ## Why withdrawn products are still listed
 *
 * Because the loans written under them are still real. `IL-LEGACY` holds the
 * 33 agreements the business made before it had named products, and a screen
 * that hid it would hide what a portfolio report is grouping them under.
 */
export default async function LoanProductsPage() {
  const context = await guardPermission(ROUTES.loanProducts, 'products:view');
  const products = await getLoanProducts();

  const canManage = contextCan(context, 'products:manage');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Lending"
        icon={PackageOpen}
        title="Loan products"
        description="What the business offers, and the terms each product carries."
        primaryAction={
          canManage ? (
            <Link
              href={ROUTES.newLoanProduct}
              className="bg-accent text-accent-contrast hover:bg-accent-hover inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold transition-colors"
            >
              New product
            </Link>
          ) : null
        }
      />

      <Alert tone="info" title="Changing a product does not change an existing loan">
        A loan records the product&apos;s terms at the moment it is approved, and those
        never move afterwards. Repricing a product applies to loans approved{' '}
        <strong>after</strong> the change — which is why a loan from last month can be on
        a different rate from one approved today.
      </Alert>

      {products.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No products could be read. Tell your administrator if this persists.
          </p>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {products.map((product) => (
            <Card key={product.productId} className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-text text-base font-semibold break-words">
                    {canManage ? (
                      <Link
                        href={`${ROUTES.loanProducts}/${product.productId}`}
                        className="hover:text-accent transition-colors"
                      >
                        {product.name}
                      </Link>
                    ) : (
                      product.name
                    )}
                  </h2>
                  <p className="text-text-muted font-mono text-xs">
                    {product.productCode}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap gap-1.5">
                  {product.isDefault ? <Badge tone="info">Default</Badge> : null}
                  <Badge tone={product.status === 'active' ? 'success' : 'neutral'}>
                    {labelFor(PRODUCT_STATUS_LABELS, product.status)}
                  </Badge>
                </div>
              </div>

              {product.description === null ? null : (
                <p className="text-text-muted mt-2 text-sm break-words">
                  {product.description}
                </p>
              )}

              <dl className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                <Term label="Amount">
                  <Money amount={product.minAmount} /> –{' '}
                  <Money amount={product.maxAmount} />
                </Term>
                <Term label="Monthly rate">
                  {formatBps(toBps(product.defaultInterestRateBps))}
                  {product.interestOverrideAllowed ? (
                    <span className="text-text-muted">
                      {' '}
                      (may vary {formatBps(toBps(product.minInterestRateBps))}–
                      {formatBps(toBps(product.maxInterestRateBps))})
                    </span>
                  ) : null}
                </Term>
                <Term label="Duration">{describeTerms(product)}</Term>
                <Term label="Grace and charge">
                  {product.gracePeriodDays} days, then{' '}
                  {formatBps(toBps(product.penaltyRateBps))}
                </Term>
                <Term label="Application">
                  {labelFor(APPLICATION_PROFILE_LABELS, product.applicationProfile)}
                </Term>
                <Term label="Security">
                  {[
                    product.guarantorRequired
                      ? `${String(product.minGuarantors)} guarantor${product.minGuarantors === 1 ? '' : 's'}`
                      : null,
                    product.collateralRequired ? 'collateral' : null,
                  ]
                    .filter((part) => part !== null)
                    .join(' and ') || 'None required'}
                </Term>
                <Term label="Sold at">
                  {product.branchIds === null
                    ? 'Every branch'
                    : `${String(product.branchIds.length)} branch${product.branchIds.length === 1 ? '' : 'es'}`}
                </Term>
                <Term label="Loans written">{product.loansWritten}</Term>
              </dl>

              {canManage ? (
                <div className="border-border mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                  <Link
                    href={`${ROUTES.loanProducts}/${product.productId}`}
                    className="text-accent text-sm font-semibold hover:underline"
                  >
                    Edit terms
                  </Link>
                  <ProductControls
                    productId={product.productId}
                    status={product.status}
                    isDefault={product.isDefault}
                  />
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Term({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}
