import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export interface InputProps extends ComponentProps<'input'> {
  /** Renders the error styling and sets `aria-invalid`. */
  readonly invalid?: boolean;
}

/**
 * A text input.
 *
 * The reference's field, by value. Two things about it are deliberate and
 * easy to lose:
 *
 *   - **It is flat and bordered, not sunken.** A white box with a 1px slate
 *     border, and a 3px navy halo at 15% opacity on focus. The reference's
 *     `.form-field` and its shadcn `Input` agree on this.
 *   - **It changes size at `md`, not just padding.** The reference runs
 *     `0.875rem 1rem` / 16px / `rounded-lg` on a phone and
 *     `0.375rem 0.625rem` / 13px / `rounded-sm` on the desktop, because its
 *     report screens put a filter row above a dense table and a touch-sized
 *     field there would push the table off the fold. The 16px on phones is
 *     also the iOS zoom guard: Safari zooms the page when a focused field's
 *     text is under 16px.
 */
export function Input({
  className,
  invalid = false,
  type = 'text',
  ...props
}: InputProps) {
  return (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        'bg-surface text-text placeholder:text-text-muted w-full border',
        // Phone: roomy and touch-sized.
        'min-h-touch rounded-lg px-4 py-3.5 text-base',
        // Desktop: the reference's compact field.
        'md:min-h-9 md:rounded-sm md:px-2.5 md:py-1.5 md:text-[13px]',
        'transition-[color,background-color,border-color,box-shadow] duration-150',
        // The reference's focus: navy border plus a 3px navy halo.
        'focus-visible:border-accent focus-visible:[box-shadow:var(--ring-focus)] focus-visible:outline-none',
        // The reference's read-only / disabled fill: slate-100 on slate-600.
        'disabled:bg-surface-sunken disabled:text-text-muted disabled:cursor-not-allowed',
        'read-only:bg-surface-sunken',
        invalid ? 'border-danger' : 'border-border-strong',
        className,
      )}
      {...props}
    />
  );
}
