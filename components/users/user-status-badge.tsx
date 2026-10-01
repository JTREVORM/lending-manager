import { Badge } from '@/components/ui/badge';
import { PROFILE_STATUS_LABELS, type ProfileStatus } from '@/lib/domain/status';

const TONES: Readonly<
  Record<ProfileStatus, 'success' | 'neutral' | 'danger' | 'warning'>
> = {
  active: 'success',
  inactive: 'neutral',
  suspended: 'danger',
  archived: 'warning',
};

/**
 * An account's status.
 *
 * The word is always present; colour only reinforces it, so the badge works
 * for a colour-blind reader and in a printout.
 */
export function UserStatusBadge({ status }: { readonly status: ProfileStatus }) {
  return <Badge tone={TONES[status]}>{PROFILE_STATUS_LABELS[status]}</Badge>;
}
