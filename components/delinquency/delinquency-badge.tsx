import { Badge } from '@/components/ui/badge';
import {
  DELINQUENCY_STATE_DESCRIPTIONS,
  DELINQUENCY_STATE_LABELS,
  type DelinquencyState,
} from '@/lib/domain/delinquency';

/**
 * A loan's operational state.
 *
 * ## Colour is never the message
 *
 * Every badge states the condition in words — "In arrears", "Penalty due" —
 * and the tone only reinforces it. A collection list read on a cheap phone in
 * sunlight, printed in black and white, or by somebody colour-blind has to say
 * the same thing, and a red dot does not.
 *
 * The `title` carries the exact predicate behind the state, so a staff member
 * who is unsure what "Expired, unpaid" means can find out from the thing
 * itself rather than from a manual.
 */
const TONES: Readonly<
  Record<DelinquencyState, 'neutral' | 'success' | 'warning' | 'danger' | 'info'>
> = {
  current: 'success',
  due_today: 'info',
  in_arrears: 'warning',
  grace_period: 'warning',
  expired_unpaid: 'danger',
  penalty_due: 'danger',
  cleared: 'neutral',
};

export function DelinquencyBadge({ state }: { readonly state: DelinquencyState }) {
  return (
    <Badge tone={TONES[state]} title={DELINQUENCY_STATE_DESCRIPTIONS[state]}>
      {DELINQUENCY_STATE_LABELS[state]}
    </Badge>
  );
}
