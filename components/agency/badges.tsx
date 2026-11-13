import { Badge } from '@/components/ui/badge';
import type {
  AgencyDirection,
  AgencyReconciliationStatus,
  AgencySettlementStatus,
  AgencyStatus,
} from '@/lib/domain/agency';

const STATUS_TONE: Readonly<
  Record<
    AgencyStatus,
    { tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; label: string }
  >
> = {
  draft: { tone: 'neutral', label: 'Draft' },
  awaiting_verification: { tone: 'info', label: 'Awaiting verification' },
  returned: { tone: 'warning', label: 'Returned' },
  posted: { tone: 'success', label: 'Posted' },
  reversed: { tone: 'danger', label: 'Reversed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};

export function AgencyStatusBadge({ status }: { readonly status: AgencyStatus }) {
  const { tone, label } = STATUS_TONE[status];
  return (
    <Badge tone={tone} shape="pill">
      {label}
    </Badge>
  );
}

const DIRECTION_LABEL: Readonly<Record<AgencyDirection, string>> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  payment: 'Payment',
};

export function AgencyDirectionBadge({
  direction,
}: {
  readonly direction: AgencyDirection | null;
}) {
  if (direction === null) return null;
  return <Badge tone="neutral">{DIRECTION_LABEL[direction]}</Badge>;
}

/**
 * Why a provider cannot be posted against.
 *
 * Shown wherever a provider appears in a list, so an officer learns it before
 * choosing rather than from a refusal afterwards. The rule itself lives in the
 * database and fails closed there; this is an explanation, not a gate.
 */
export function ProviderReadinessBadge({
  isActive,
  isProvisional,
}: {
  readonly isActive: boolean;
  readonly isProvisional: boolean;
}) {
  if (isProvisional) {
    return (
      <Badge tone="warning" shape="pill">
        Provisional
      </Badge>
    );
  }
  if (!isActive) {
    return (
      <Badge tone="neutral" shape="pill">
        Inactive
      </Badge>
    );
  }
  return (
    <Badge tone="success" shape="pill">
      Live
    </Badge>
  );
}

/** What a reconciliation variance's sign means, carried from the database. */
export function VarianceBadge({
  variance,
  means,
}: {
  readonly variance: number;
  readonly means: string;
}) {
  if (variance === 0) {
    return (
      <Badge tone="success" shape="pill">
        Agrees
      </Badge>
    );
  }
  return (
    <Badge tone="warning" shape="pill" title={means}>
      {variance > 0 ? '+' : ''}
      {variance.toLocaleString('en-UG')}
    </Badge>
  );
}

const RECONCILIATION_TONE: Readonly<
  Record<
    AgencyReconciliationStatus,
    { tone: 'neutral' | 'info' | 'success' | 'warning'; label: string }
  >
> = {
  open: { tone: 'info', label: 'Awaiting certification' },
  reconciled: { tone: 'success', label: 'Certified' },
  adjusted: { tone: 'warning', label: 'Difference written off' },
};

export function AgencyReconciliationBadge({
  status,
}: {
  readonly status: AgencyReconciliationStatus;
}) {
  const { tone, label } = RECONCILIATION_TONE[status];
  return (
    <Badge tone={tone} shape="pill">
      {label}
    </Badge>
  );
}

export function AgencySettlementBadge({
  status,
}: {
  readonly status: AgencySettlementStatus;
}) {
  return status === 'reversed' ? (
    <Badge tone="danger" shape="pill">
      Reversed
    </Badge>
  ) : (
    <Badge tone="success" shape="pill">
      Posted
    </Badge>
  );
}
