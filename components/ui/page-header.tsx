import Link from 'next/link';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The top of every page, and the one place a page-level action is styled.
 *
 * ## The reference's page banner
 *
 * Every screen in the reference project opens with the same block: a navy →
 * blue → amber gradient panel (`.page-banner`) carrying a small translucent
 * "eyebrow" chip, the title in `text-2xl font-bold tracking-tight`, and one
 * line of explanation in `text-[13px] text-blue-100`. It is the single most
 * recognisable thing about the design, and it is what makes forty unrelated
 * screens read as one product. `PageHeader` is that banner.
 *
 * The gradient is defined once in `globals.css`, with the amber stop pushed
 * to 118% so the right-hand end reads as the sign-in screen's warm edge
 * rather than desaturating to grey, plus a blurred white bloom in the
 * top-right corner. In print it collapses to a plain heading with a rule
 * under it — a block of ink is not a report.
 *
 * ## Actions
 *
 * Actions sit *below* the banner rather than inside it, which is where the
 * reference puts them (`LoanProducts.tsx`, `Clients.tsx`): full-width and
 * 52px tall on a phone, auto-width and 40px on the desktop, via
 * `.page-header-actions`. Three styles exist and no more:
 *
 *   - **Primary action** — one per page at most, the navy fill. The thing a
 *     person came to this page to do.
 *   - **Secondary actions** — bordered white. Export, print, a second route.
 *   - **Back link** — a text link with a left arrow, above the banner, never
 *     a button. It navigates; it does not act.
 *
 * A page that wants a fourth is a page that has outgrown this header, and
 * should say so in review rather than inventing one inline.
 */
export interface PageHeaderProps {
  readonly title: string;
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
  /** The amber icon inside the eyebrow chip. */
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
  icon: Icon,
  className,
}: PageHeaderProps) {
  const hasActions = primaryAction !== undefined || secondaryActions !== undefined;

  return (
    <div className={cn('mb-4 min-w-0 space-y-3', className)}>
      {back !== undefined ? (
        <Link
          href={back.href}
          className="text-text-muted hover:text-accent inline-flex min-h-8 items-center gap-1.5 text-xs font-medium print:hidden"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
      ) : null}

      {/* The banner. `p-5 sm:p-6` is the reference's own padding. */}
      <div className="page-banner p-5 sm:p-6">
        {/* The eyebrow chip: a translucent white pill with an amber icon,
            naming the area of the business this screen belongs to. */}
        {eyebrow !== undefined ? (
          <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold text-blue-100">
            {Icon === undefined ? null : (
              <Icon aria-hidden="true" className="size-3.5 text-amber-400" />
            )}
            {eyebrow}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="t-page-title min-w-0 break-words text-white">{title}</h1>
          {status}
        </div>

        {description !== undefined ? (
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-blue-100">
            {description}
          </p>
        ) : null}
      </div>

      {hasActions ? (
        // `.page-header-actions` is the reference's rule: stacked and
        // thumb-sized on a phone, inline and compact from `md` up.
        <div className="page-header-actions print:hidden">
          {primaryAction}
          {secondaryActions}
        </div>
      ) : null}
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
