import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * Variants ported from the reference's shadcn "new-york" button, with its
 * palette: `#0B4394` navy as the default fill, the slate-50 secondary, and a
 * bordered outline. The geometry is the reference's too — `h-9 px-4 py-2`,
 * `rounded-md`, `text-sm font-medium`, `[&_svg]:size-4`.
 */
const VARIANTS = {
  // The reference's primary action: solid navy, `shadow-xs`, darkening on
  // hover to `#093672`. Used for "New loan product", "Search", every page's
  // one real action.
  primary: 'bg-accent text-accent-contrast shadow-xs hover:bg-accent-hover',
  // The reference's `secondary`: the slate fill, used for a second action in
  // the same row.
  secondary:
    'bg-surface-sunken text-text border border-border shadow-xs hover:bg-surface-hover',
  // The reference's `outline`: a hairline border on the page surface.
  outline:
    'border border-border-strong bg-surface text-text shadow-xs hover:bg-surface-hover',
  // The reference's `ghost`: no chrome until hovered.
  ghost: 'bg-transparent text-text hover:bg-surface-hover',
  // The reference's `destructive`, on its `#D32F2F` red.
  danger: 'bg-danger text-white shadow-xs hover:bg-danger/90',
  /**
   * The reference's amber save button (`.btn-save`): a full-width pill in
   * `#fbbf24` with near-black text, used at the foot of a form.
   */
  save: 'bg-accent-2 text-brand-900 rounded-full font-bold hover:bg-[#f59e0b]',
} as const;

/**
 * Sizes ported from the reference: `default h-9 px-4 py-2`, `sm h-8 px-3
 * text-xs`, `lg h-10 px-8`, `icon h-9 w-9`.
 *
 * The one addition is the mobile floor. The reference enforces
 * `min-height: 2.75rem` on every `button` below `md` through a global rule —
 * which this application also carries in `globals.css` — so a 36px desktop
 * button is still a 44px target on a phone. It is expressed here as well so
 * the intent is visible at the component rather than only in a media query
 * four files away.
 */
const SIZES = {
  sm: 'min-h-touch px-3 text-xs md:min-h-8',
  md: 'min-h-touch px-4 py-2 text-sm md:min-h-9',
  lg: 'min-h-touch px-8 text-sm md:min-h-10',
  icon: 'min-h-touch w-11 md:min-h-9 md:w-9',
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
        'inline-flex cursor-pointer items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap',
        '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        'pressable',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
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
