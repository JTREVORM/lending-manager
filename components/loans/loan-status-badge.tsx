import { Badge } from '@/components/ui/badge';
import { LOAN_STATUS_LABELS, type LoanStatus } from '@/lib/domain/loan';

/**
 * Tones carry no meaning alone — the label always states the status in words,
 * so this reads correctly for a colour-blind user and in a printout.
 *
 * `approved` and `active` are deliberately different: approved means the
 * decision is made and the money has *not* moved, which is a distinction
 * somebody handling cash needs to see at a glance.
 */
const TONES: Readonly<
  Record<LoanStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'>
> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  active: 'success',
  cleared: 'neutral',
  cancelled: 'danger',
};

export function LoanStatusBadge({ status }: { readonly status: LoanStatus }) {
  return <Badge tone={TONES[status]}>{LOAN_STATUS_LABELS[status]}</Badge>;
}
