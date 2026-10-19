import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';

import { Chevron } from '@/components/ui/chevron';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The top of every page, and the one place a page-level action is styled.
 *
 * ## It used to be a gradient banner
 *
 * Every screen opened with a navy → blue → amber panel carrying a
 * translucent eyebrow chip and white text. It was the loudest thing in the
 * product, repeated forty times, and it pushed the actual content — the
 * register somebody came to read — a couple of hundred pixels down the page.
 *
 * The reference design has none of it: a breadcrumb, a dark title, one line
 * of description, and the page's actions on the right of the same block. The
 * colour in a banking screen should be in the figures that need attention,
 * not behind the heading. So that is what this is now.
 *
 * The props did not change, because forty call sites use them and the
 * meanings still hold — they are simply drawn differently:
 *
 *   - `eyebrow` was the chip above the title; it is now the first segment of
 *     the breadcrumb, which is the same fact (what part of the business this
 *     screen belongs to) in the place a reader looks for it.
 *   - `back` was a link above the banner; it is now the linked parent in the
 *     breadcrumb, which is what a breadcrumb is for.
 *
 * ## Actions
 *
 *   - **Primary action** — one per page at most, the navy fill. The thing a
 *     person came to this page to do.
 *   - **Secondary actions** — bordered white. Export, print, a second route.
 *
 * A page that wants a fourth has outgrown this header and should say so in
 * review rather than inventing one inline.
 */
export interface PageHeaderProps {
  /**
   * The page's heading.
   *
   * A node, not a string: the payment detail page's heading *is* the amount,
   * rendered through `Money` so the currency stays on the same line as the
   * figure and a reversed payment is struck through. A heading that had to be
   * a plain string would mean that page hand-rolling its own `<h1>` and
   * losing the banner.
   */
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Where "back" goes, and what it is called. */
  readonly back?: { readonly href: string; readonly label: string };
  /** Rendered to the right of the title on desktop, below it on a phone. */
  readonly primaryAction?: ReactNode;
  readonly secondaryActions?: ReactNode;
  /** A status chip beside the title — a loan's state, an account's status. */
  readonly status?: ReactNode;
  /**
   * The small translucent chip above the title, naming the part of the
   * business this screen belongs to — "Member Register", "Lending Terms".
   * The reference puts one on every screen.
   */
  readonly eyebrow?: string;
  /**
   * Accepted and ignored. It was the amber glyph inside the eyebrow chip,
   * and the chip is now a breadcrumb segment, which the reference sets in
   * plain text. Kept so the forty call sites that pass one keep compiling.
   *
   * @deprecated The header draws no icon; drop the prop.
   */
  readonly icon?: LucideIcon;
  readonly className?: string;
}

export function PageHeader({
  title,
  description,
  back,
  primaryAction,
  secondaryActions,
  status,
  eyebrow,
  className,
}: PageHeaderProps) {
  const hasActions = primaryAction !== undefined || secondaryActions !== undefined;
  const hasTrail = eyebrow !== undefined || back !== undefined;

  return (
    <div className={cn('mb-5 min-w-0', className)}>
      {hasTrail ? (
        <nav
          aria-label="Breadcrumb"
          className="text-text-muted mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] print:hidden"
        >
          {eyebrow !== undefined ? <span>{eyebrow}</span> : null}
          {eyebrow !== undefined && back !== undefined ? (
            <Chevron direction="right" className="text-border-strong size-3.5" />
          ) : null}
          {back !== undefined ? (
            <Link
              href={back.href}
              className="hover:text-accent underline-offset-2 hover:underline"
            >
              {back.label}
            </Link>
          ) : null}
        </nav>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {/* `text-text`, not white: the banner behind it is gone. */}
            <h1 className="t-page-title text-text min-w-0 break-words">{title}</h1>
            {status}
          </div>

          {description !== undefined ? (
            <p className="text-text-muted mt-1 max-w-3xl text-sm leading-relaxed">
              {description}
            </p>
          ) : null}
        </div>

        {hasActions ? (
          <div className="page-header-actions print:hidden">
            {primaryAction}
            {secondaryActions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two action styles
// ---------------------------------------------------------------------------

/**
 * The reference's page action, measured off `LoanProducts.tsx`:
 * `h-[52px] w-full rounded-lg px-5 text-base font-semibold` on a phone,
 * `h-10 w-auto text-[13px]` from `sm` up. `.page-header-actions` supplies the
 * width; these supply the height, the type and the fill.
 */
const ACTION_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg px-5 text-base font-semibold pressable [&_svg]:size-4 [&_svg]:shrink-0 sm:h-10 sm:rounded-md sm:text-[13px]';

const ACTION_VARIANTS = {
  primary: 'bg-accent text-accent-contrast shadow-xs hover:bg-accent-hover',
  secondary:
    'bg-surface text-text border border-border-strong shadow-xs hover:bg-surface-hover hover:text-accent',
  danger: 'bg-danger text-white shadow-xs hover:bg-danger/90',
} as const;

export interface ActionLinkProps extends ComponentProps<typeof Link> {
  readonly variant?: keyof typeof ACTION_VARIANTS;
}

/**
 * A page action that navigates.
 *
 * A `<Link>`, not a button: it changes the page, and a screen-reader user
 * relies on hearing "link" to know that pressing it will not spend money.
 * Looking like a button is a visual convention, not a semantic one.
 */
export function ActionLink({
  variant = 'primary',
  className,
  ...props
}: ActionLinkProps) {
  return (
    <Link className={cn(ACTION_BASE, ACTION_VARIANTS[variant], className)} {...props} />
  );
}

export interface ActionButtonProps extends ComponentProps<'button'> {
  readonly variant?: keyof typeof ACTION_VARIANTS;
}

/** A page action that submits or opens something in place. */
export function ActionButton({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        ACTION_BASE,
        ACTION_VARIANTS[variant],
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A heading for a section within a page.
 *
 * Distinct from `CardHeader`, which titles one card. This titles a group of
 * them, and is a visible step up in the hierarchy — the pre-Phase-9 dashboard
 * read as one flat list precisely because "Business summary" and the card
 * titles beneath it were nearly the same size.
 */
export interface SectionHeaderProps {
  readonly title: string;
  readonly id?: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly as?: 'h2' | 'h3';
  readonly className?: string;
}

export function SectionHeader({
  title,
  id,
  description,
  action,
  as: Heading = 'h2',
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn('mb-3 flex min-w-0 items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        {/* The reference's `MisPageTitle`: `text-lg font-bold text-slate-900
            md:text-xl`. */}
        <Heading
          {...(id === undefined ? {} : { id })}
          className="t-section-title text-text"
        >
          {title}
        </Heading>
        {description !== undefined ? (
          <p className="text-text-muted mt-0.5 text-xs">{description}</p>
        ) : null}
      </div>
      {action !== undefined ? (
        <div className="shrink-0 text-xs print:hidden">{action}</div>
      ) : null}
    </div>
  );
}
