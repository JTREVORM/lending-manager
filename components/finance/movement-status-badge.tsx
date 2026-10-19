import { StatusText, type StatusTone } from '@/components/ui/status-text';
import {
  MOVEMENT_STATUS_LABELS,
  RECONCILIATION_STATUS_LABELS,
  type MovementStatus,
  type ReconciliationStatus,
} from '@/lib/domain/finance';

const MOVEMENT_TONES: Readonly<Record<MovementStatus, StatusTone>> = {
  pending_approval: 'attention',
  posted: 'positive',
  rejected: 'neutral',
  reversed: 'critical',
};

/**
 * What became of a transfer, an expense or a payment of income.
 *
 * `rejected` is neutral rather than red on purpose: nothing went wrong and
 * nothing was posted. Red is reserved for `reversed`, where money did move
 * and then had to be taken back — which is the one a reader should stop at.
 */
export function MovementStatusBadge({ status }: { readonly status: MovementStatus }) {
  return (
    <StatusText tone={MOVEMENT_TONES[status]}>
      {MOVEMENT_STATUS_LABELS[status]}
    </StatusText>
  );
}

const RECONCILIATION_TONES: Readonly<Record<ReconciliationStatus, StatusTone>> = {
  balanced: 'positive',
  // Amber, not red: an unresolved difference is a thing to deal with today,
  // not a failure. It turns red only if nobody does.
  submitted: 'attention',
  approved: 'neutral',
  rejected: 'critical',
};

export function ReconciliationStatusBadge({
  status,
}: {
  readonly status: ReconciliationStatus;
}) {
  return (
    <StatusText tone={RECONCILIATION_TONES[status]}>
      {RECONCILIATION_STATUS_LABELS[status]}
    </StatusText>
  );
}
