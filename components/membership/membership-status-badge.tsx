import { Badge } from '@/components/ui/badge';
import { MEMBERSHIP_STATUS_LABELS, type MembershipStatus } from '@/lib/domain/membership';

/**
 * Tones carry no meaning on their own — the label always states the status in
 * words, so this reads correctly for a colour-blind user and in a printout.
 *
 * `withdrawn` and `deceased` are both terminal and are deliberately given
 * different tones. One is a decision somebody took; the other is a fact about
 * a person, and it is the state in which the bereavement benefit becomes
 * payable. Showing them identically would flatten a distinction the business
 * pays money on.
 */
const TONES: Readonly<
  Record<MembershipStatus, 'success' | 'neutral' | 'warning' | 'danger' | 'info'>
> = {
  pending: 'info',
  active: 'success',
  suspended: 'warning',
  withdrawn: 'neutral',
  deceased: 'danger',
};

export function MembershipStatusBadge({ status }: { readonly status: MembershipStatus }) {
  return <Badge tone={TONES[status]}>{MEMBERSHIP_STATUS_LABELS[status]}</Badge>;
}
