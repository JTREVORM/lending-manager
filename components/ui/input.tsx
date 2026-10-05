import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export interface InputProps extends ComponentProps<'input'> {
  /** Renders the error styling and sets `aria-invalid`. */
  readonly invalid?: boolean;
}

/**
 * A text input.
 *
 * Note the 16px base font size on small screens: iOS Safari zooms the whole
 * page when a focused input's text is smaller than that, which on a form is
 * both jarring and a layout break.
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
        // A softly sunken well — the reference's "inset layer" — so a field
        // reads as somewhere to type into. One subtle inner shadow, not a glow
        // around every edge.
        'min-h-touch w-full rounded-md border px-3 py-2',
        'bg-surface-sunken text-text placeholder:text-text-muted',
        '[box-shadow:var(--inset-soft)]',
        'text-base sm:text-sm',
        'transition-[color,background-color,border-color,box-shadow] duration-150',
        'focus-visible:border-accent focus-visible:[box-shadow:var(--inset-soft),0_0_0_3px_var(--color-accent-surface)]',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-danger focus-visible:outline-danger' : 'border-border-strong',
        className,
      )}
      {...props}
    />
  );
}
