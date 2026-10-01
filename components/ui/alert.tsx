import type { ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

const TONES = {
  info: 'bg-info-surface border-info/30',
  success: 'bg-success-surface border-success/30',
  warning: 'bg-warning-surface border-warning/30',
  danger: 'bg-danger-surface border-danger/30',
} as const;

export interface AlertProps {
  readonly tone?: keyof typeof TONES;
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * An inline message.
 *
 * `danger` and `warning` use `role="alert"`, which interrupts a screen reader
 * so a problem is not missed. `info` and `success` use `role="status"`, which
 * waits for a pause — appropriate for confirmation, wrong for a failure.
 */
export function Alert({ tone = 'info', title, children, className }: AlertProps) {
  const isUrgent = tone === 'danger' || tone === 'warning';

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      className={cn('rounded-lg border p-3 text-sm sm:p-4', TONES[tone], className)}
    >
      {title !== undefined ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="text-text [&_p]:text-text">{children}</div>
    </div>
  );
}
