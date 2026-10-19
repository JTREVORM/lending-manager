import { StatusText, type StatusTone } from '@/components/ui/status-text';
import { CLIENT_STATUS_LABELS, type ClientStatus } from '@/lib/domain/client';

/**
 * Tones carry no meaning on their own — the label always states the status in
 * words, so this reads correctly for a colour-blind user and in a printout.
 *
 * `blacklisted` and `suspended` are both restrictions, and they are
 * deliberately given different tones: a suspension is temporary and expected
 * to be resolved, while a blacklisting is a standing decision. Showing them
 * identically would flatten a distinction the business cares about.
 */
const TONES: Readonly<Record<ClientStatus, StatusTone>> = {
  active: 'positive',
  inactive: 'neutral',
  suspended: 'attention',
  blacklisted: 'critical',
  archived: 'neutral',
};

export function ClientStatusBadge({ status }: { readonly status: ClientStatus }) {
  return <StatusText tone={TONES[status]}>{CLIENT_STATUS_LABELS[status]}</StatusText>;
}
