import { StatusText, type StatusTone } from '@/components/ui/status-text';
import { LOAN_STATUS_LABELS, type LoanStatus } from '@/lib/domain/loan';

/**
 * Tones carry no meaning alone — the label always states the status in words,
 * so this reads correctly for a colour-blind user and in a printout.
 *
 * `approved` and `active` are deliberately different: approved means the
 * decision is made and the money has *not* moved, which is a distinction
 * somebody handling cash needs to see at a glance.
 */
const TONES: Readonly<Record<LoanStatus, StatusTone>> = {
  draft: 'neutral',
  pending_approval: 'attention',
  approved: 'positive',
  active: 'positive',
  cleared: 'neutral',
  cancelled: 'critical',
};

export function LoanStatusBadge({ status }: { readonly status: LoanStatus }) {
  return <StatusText tone={TONES[status]}>{LOAN_STATUS_LABELS[status]}</StatusText>;
}
