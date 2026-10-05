import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

const VARIANTS = {
  // Primary — the dark-teal accent, filled, lit from above by the highlight.
  primary:
    'bg-accent text-accent-contrast elevation-2 [box-shadow:var(--highlight-top),var(--elevate-2)] hover:bg-accent-hover disabled:bg-brand-300',
  // Secondary — a soft raised neutral, the reference's "raised layer".
  secondary:
    'bg-surface-raised text-text border border-border [box-shadow:var(--highlight-top),var(--elevate-1)] hover:bg-surface-hover',
  // Outline — subtle border, no fill, for a quieter second action.
  outline: 'bg-transparent text-text border border-border-strong hover:bg-surface-hover',
  // Ghost — lowest emphasis, no chrome until hovered.
  ghost: 'bg-transparent text-text hover:bg-surface-hover',
  // Destructive — accessible danger fill.
  danger: 'bg-danger text-white [box-shadow:var(--elevate-2)] hover:bg-danger/90',
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
        'inline-flex items-center justify-center gap-2 rounded-md font-medium',
        // The physical press: scale down a hair on :active, 120ms ease-out,
        // transform only. `pressable` also transitions background and shadow.
        'pressable',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none',
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
