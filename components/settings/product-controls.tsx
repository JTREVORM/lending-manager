'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  setDefaultLoanProductAction,
  setLoanProductStatusAction,
  type ProductActionResult,
} from '@/lib/products/actions';

/**
 * Withdraw a product, offer it again, or make it the default.
 *
 * Three one-field forms rather than three buttons wired to one action with a
 * `mode` parameter: each posts to the action that performs exactly it, so the
 * capability check, the rate-limit bucket and the audit record are the same
 * whether the press came from here or from anywhere else.
 *
 * ## No "delete"
 *
 * There is no such control because there is no such privilege: a product with
 * loans written against it is named by every one of their snapshots, and
 * `loan_products` grants no DELETE to anybody. Withdrawing is what retiring a
 * product means, and it is reversible, which deletion would not be.
 */
export function ProductControls({
  productId,
  status,
  isDefault,
}: {
  readonly productId: string;
  readonly status: string;
  readonly isDefault: boolean;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === 'active' ? (
          <StatusButton
            productId={productId}
            status="inactive"
            label="Withdraw"
            variant="secondary"
          />
        ) : (
          <StatusButton
            productId={productId}
            status="active"
            label="Offer again"
            variant="secondary"
          />
        )}

        {status === 'active' && !isDefault ? (
          <DefaultButton productId={productId} />
        ) : null}
      </div>
    </div>
  );
}

function StatusButton({
  productId,
  status,
  label,
  variant,
}: {
  readonly productId: string;
  readonly status: 'active' | 'inactive';
  readonly label: string;
  readonly variant: 'primary' | 'secondary';
}) {
  const [result, submit, pending] = useActionState<
    ProductActionResult | undefined,
    FormData
  >(setLoanProductStatusAction, undefined);

  return (
    <form action={submit} className="min-w-0">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="status" value={status} />
      <Button type="submit" size="sm" variant={variant} loading={pending}>
        {label}
      </Button>
      {result?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {result.message}
        </Alert>
      ) : null}
    </form>
  );
}

function DefaultButton({ productId }: { readonly productId: string }) {
  const [result, submit, pending] = useActionState<
    ProductActionResult | undefined,
    FormData
  >(setDefaultLoanProductAction, undefined);

  return (
    <form action={submit} className="min-w-0">
      <input type="hidden" name="productId" value={productId} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>
        Make default
      </Button>
      {result?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {result.message}
        </Alert>
      ) : null}
    </form>
  );
}
