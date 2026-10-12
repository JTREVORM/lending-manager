import { Badge } from '@/components/ui/badge';
import {
  MOVEMENT_STATUS_LABELS,
  RECONCILIATION_STATUS_LABELS,
  type MovementStatus,
  type ReconciliationStatus,
} from '@/lib/domain/finance';

const MOVEMENT_TONES: Readonly<
  Record<MovementStatus, 'neutral' | 'success' | 'warning' | 'danger'>
> = {
  pending_approval: 'warning',
  posted: 'success',
  rejected: 'neutral',
  reversed: 'danger',
};

/**
 * What became of a transfer, an expense or a payment of income.
 *
 * `rejected` is neutral rather than red on purpose: nothing went wrong and
 * nothing was posted. Red is reserved for `reversed`, where money did move
 * and then had to be taken back — which is the one a reader should stop at.
 */
export function MovementStatusBadge({ status }: { readonly status: MovementStatus }) {
  return <Badge tone={MOVEMENT_TONES[status]}>{MOVEMENT_STATUS_LABELS[status]}</Badge>;
}

const RECONCILIATION_TONES: Readonly<
  Record<ReconciliationStatus, 'neutral' | 'success' | 'warning' | 'danger'>
> = {
  balanced: 'success',
  // Amber, not red: an unresolved difference is a thing to deal with today,
  // not a failure. It turns red only if nobody does.
  submitted: 'warning',
  approved: 'neutral',
  rejected: 'danger',
};

export function ReconciliationStatusBadge({
  status,
}: {
  readonly status: ReconciliationStatus;
}) {
  return (
    <Badge tone={RECONCILIATION_TONES[status]}>
      {RECONCILIATION_STATUS_LABELS[status]}
    </Badge>
  );
}
