import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The reference's status pill: a 50-level tint, a 200-level `ring-1` outline
 * and 700/800-level text, at `text-[10px] font-bold uppercase tracking-wide`.
 * Its `StaffUi` badges, its loan-product status chips and its table state
 * cells are all this shape.
 */
const TONES = {
  neutral: 'bg-surface-sunken text-text-muted ring-border',
  success: 'bg-success-surface text-success ring-success/25',
  warning: 'bg-warning-surface text-warning ring-warning/25',
  danger: 'bg-danger-surface text-danger ring-danger/25',
  info: 'bg-info-surface text-info ring-info/25',
} as const;

export interface BadgeProps extends ComponentProps<'span'> {
  readonly tone?: keyof typeof TONES;
  /**
   * The reference uses a square-ish `rounded` chip for a role and a
   * `rounded-full` pill with a leading dot for a live status. `pill` picks the
   * second shape.
   */
  readonly shape?: 'chip' | 'pill';
}

/**
 * A status pill.
 *
 * Colour alone never carries the meaning — the label always states it in
 * words, so the badge works for a colour-blind reader and in a printout.
 */
export function Badge({
  className,
  tone = 'neutral',
  shape = 'pill',
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[10px] font-bold tracking-wide whitespace-nowrap uppercase ring-1',
        shape === 'pill' ? 'rounded-full px-2.5 py-0.5' : 'rounded px-2 py-0.5',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
