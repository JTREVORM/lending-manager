import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

const VARIANTS = {
  // Primary — the dark-teal accent, a raised neumorphic key. Hover sinks the
  // teal a shade; :active presses it in with an inner shadow.
  primary:
    'bg-accent text-accent-contrast [box-shadow:var(--elevate-2)] hover:bg-accent-hover active:[box-shadow:inset_0_3px_8px_rgba(0,0,0,0.3)] disabled:bg-brand-300 disabled:shadow-none',
  // Secondary — the reference's neutral raised layer, on the gradient fill.
  secondary:
    'text-text [background:var(--surface-raised-fill)] [box-shadow:var(--elevate-2)] hover:text-accent active:[box-shadow:var(--inset-press)]',
  // Outline — a quiet second action: a border, no lift.
  outline: 'bg-transparent text-text border border-border-strong hover:bg-surface-hover',
  // Ghost — lowest emphasis, no chrome until hovered.
  ghost: 'bg-transparent text-text hover:bg-surface-hover',
  // Destructive — accessible danger fill, same raised/pressed language.
  danger:
    'bg-danger text-white [box-shadow:var(--elevate-2)] hover:bg-danger/90 active:[box-shadow:inset_0_3px_8px_rgba(0,0,0,0.3)]',
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
