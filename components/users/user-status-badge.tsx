import { StatusText, type StatusTone } from '@/components/ui/status-text';
import { PROFILE_STATUS_LABELS, type ProfileStatus } from '@/lib/domain/status';

const TONES: Readonly<Record<ProfileStatus, StatusTone>> = {
  active: 'positive',
  inactive: 'neutral',
  suspended: 'critical',
  archived: 'attention',
};

/**
 * An account's status.
 *
 * The word is always present; colour only reinforces it, so the badge works
 * for a colour-blind reader and in a printout.
 */
export function UserStatusBadge({ status }: { readonly status: ProfileStatus }) {
  return <StatusText tone={TONES[status]}>{PROFILE_STATUS_LABELS[status]}</StatusText>;
}
