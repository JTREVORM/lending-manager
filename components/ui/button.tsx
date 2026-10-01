import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

const VARIANTS = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-300',
  secondary:
    'bg-surface text-text border border-border-strong hover:bg-surface-raised active:bg-surface-raised',
  danger: 'bg-danger text-white hover:opacity-90 active:opacity-80',
  ghost: 'bg-transparent text-text hover:bg-surface-raised',
} as const;

const SIZES = {
  /* Still 44px tall: a "small" button is visually tighter, never harder to
     tap. Horizontal padding shrinks, the touch target does not. */
  sm: 'min-h-touch px-3 text-sm',
  md: 'min-h-touch px-4 text-sm',
  lg: 'min-h-touch px-6 text-base sm:min-h-12',
} as const;

export interface ButtonProps extends ComponentProps<'button'> {
  readonly variant?: keyof typeof VARIANTS;
  readonly size?: keyof typeof SIZES;
  /** Shows a spinner and blocks interaction. Prefer this over disabling. */
  readonly loading?: boolean;
}

/**
 * The application's button.
 *
 * A real `<button>` — never a styled `<div>` — so it is keyboard-operable,
 * announced correctly and submits forms. For navigation, use a `<Link>`
 * instead: a control that changes the page is a link, and screen-reader users
 * rely on that distinction.
 */
export function Button({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled === true || loading;

  return (
    <button
      type={type}
      disabled={isDisabled}
      // Announces the pending state to assistive technology, which a visual
      // spinner alone does not.
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
