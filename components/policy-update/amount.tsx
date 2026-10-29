import { Money } from '@/components/ui/money';
import { fromDatabaseAmount } from '@/lib/domain/money';

export function PolicyAmount({ value }: { readonly value: number | string | null | undefined }) {
  const amount = fromDatabaseAmount(value ?? null);
  return amount === null ? <span>Not available</span> : <Money amount={amount} />;
}
