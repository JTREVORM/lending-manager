import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The top of every page, and the one place a page-level action is styled.
 *
 * ## Why this exists
 *
 * Before Phase 9 each page wrote its own header. The results diverged: "Add
 * staff member" was a filled button, "Register client", "New loan" and
 * "Record a payment" were bare text in the same position, and the dashboard's
 * quick actions managed three different button styles side by side. A reader
 * learns what a filled rectangle means on one screen and has to unlearn it on
 * the next.
 *
 * So the pattern is fixed here, and pages supply content rather than styling:
 *
 *   - **Primary action** — one per page at most, a filled accent button. The
 *     thing a person came to this page to do.
 *   - **Secondary actions** — outlined. Export, print, a second route.
 *   - **Back link** — a text link with a left arrow, above the title, never a
 *     button. It navigates; it does not act.
 *
 * `ActionLink` and `ActionButton` below are the only two styles. A page that
 * wants a third is a page that has outgrown this header, and should say so in
 * review rather than inventing one inline.
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
  readonly className?: string;
}

export function PageHeader({
  title,
  description,
  back,
  primaryAction,
  secondaryActions,
  status,
  className,
}: PageHeaderProps) {
  const hasActions = primaryAction !== undefined || secondaryActions !== undefined;

  return (
    <div className={cn('mb-5 min-w-0', className)}>
      {back !== undefined ? (
        <Link
          href={back.href}
          className="text-text-muted hover:text-text mb-2 inline-flex min-h-8 items-center gap-1.5 text-sm print:hidden"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {back.label}
        </Link>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-text min-w-0 break-words">{title}</h1>
            {status}
          </div>
          {description !== undefined ? (
            <p className="text-text-muted mt-1 text-sm sm:text-base">{description}</p>
          ) : null}
        </div>

        {hasActions ? (
          // `shrink-0` so a long title never squeezes the action into two
          // lines; the row wraps underneath instead on a narrow screen.
          <div className="flex shrink-0 flex-wrap items-center gap-2 print:hidden">
            {secondaryActions}
            {primaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two action styles
// ---------------------------------------------------------------------------

const ACTION_BASE =
  'inline-flex min-h-touch items-center justify-center gap-2 rounded-md px-4 text-sm font-medium pressable';

const ACTION_VARIANTS = {
  primary:
    'bg-accent text-accent-contrast [box-shadow:var(--elevate-2)] hover:bg-accent-hover active:[box-shadow:inset_0_3px_8px_rgba(0,0,0,0.3)]',
  secondary:
    'text-text [background:var(--surface-raised-fill)] [box-shadow:var(--elevate-2)] hover:text-accent active:[box-shadow:var(--inset-press)]',
  danger:
    'bg-danger text-white [box-shadow:var(--elevate-2)] hover:bg-danger/90 active:[box-shadow:inset_0_3px_8px_rgba(0,0,0,0.3)]',
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
        <Heading
          {...(id === undefined ? {} : { id })}
          className="text-text text-lg font-semibold tracking-tight sm:text-xl"
        >
          {title}
        </Heading>
        {description !== undefined ? (
          <p className="text-text-muted mt-0.5 text-sm">{description}</p>
        ) : null}
      </div>
      {action !== undefined ? (
        <div className="shrink-0 text-sm print:hidden">{action}</div>
      ) : null}
    </div>
  );
}
