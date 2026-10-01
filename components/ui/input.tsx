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
        'min-h-touch w-full rounded-lg border px-3 py-2',
        'bg-surface text-text placeholder:text-text-muted',
        'text-base sm:text-sm',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-danger focus-visible:outline-danger' : 'border-border-strong',
        className,
      )}
      {...props}
    />
  );
}
