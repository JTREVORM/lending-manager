import type { ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The reference's inline message: a 50-level tint behind a 300-level border,
 * with the text in the matching dark tone at `text-xs font-semibold`. Its
 * sign-in error (`border-red-300 bg-red-50 text-red-800`) is the pattern.
 */
const TONES = {
  info: 'bg-info-surface border-info/35 text-info',
  success: 'bg-success-surface border-success/35 text-success',
  warning: 'bg-warning-surface border-warning/35 text-warning',
  danger: 'bg-danger-surface border-danger/35 text-danger',
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
      className={cn('rounded-lg border p-3 text-[13px] sm:p-4', TONES[tone], className)}
    >
      {title !== undefined ? <p className="mb-1 font-bold">{title}</p> : null}
      {/* The body stays in the page's text colour: a paragraph of explanation
          set in the status tone is harder to read than the same paragraph in
          black, and the tint plus the border already carry the signal. */}
      <div className="text-text [&_p]:text-text">{children}</div>
    </div>
  );
}
