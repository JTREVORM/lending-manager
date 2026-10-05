import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

const TONES = {
  neutral: 'bg-surface-raised text-text-muted border-border',
  success: 'bg-success-surface text-success border-success/30',
  warning: 'bg-warning-surface text-warning border-warning/30',
  danger: 'bg-danger-surface text-danger border-danger/30',
  info: 'bg-info-surface text-info border-info/30',
} as const;

export interface BadgeProps extends ComponentProps<'span'> {
  readonly tone?: keyof typeof TONES;
}

/**
 * A status pill.
 *
 * Colour alone never carries the meaning — the label always states it in
 * words, so the badge works for a colour-blind reader and in a printout.
 */
export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
