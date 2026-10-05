import Link from 'next/link';
import {
  AlertTriangle,
  Inbox,
  Loader2,
  Lock,
  SearchX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';
import { ActionLink } from './page-header';

/**
 * Empty, loading and error states, written once.
 *
 * A list with nothing in it is a sentence the application has to say, and
 * before Phase 9 each screen said it differently — or said nothing, leaving a
 * bordered box with a dash in it. Three things matter and are fixed here:
 *
 *   - **Say which emptiness it is.** "No payments yet" and "No payments match
 *     this filter" are different facts and lead to different next steps.
 *   - **Offer the next step where there is one.** An empty client list on a
 *     new installation should offer to register a client.
 *   - **Never imply a figure.** An empty state says nothing about money. It
 *     does not render `UGX 0`, because "no rows" is not "zero shillings" —
 *     that distinction is the same one `Money` makes for a null amount.
 */

const TONES = {
  neutral: { icon: 'text-text-muted', surface: 'bg-surface-raised' },
  danger: { icon: 'text-danger', surface: 'bg-danger-surface' },
  warning: { icon: 'text-warning', surface: 'bg-warning-surface' },
} as const;

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** Defaults to an inbox; pass `SearchX` for a filter that matched nothing. */
  readonly icon?: LucideIcon;
  readonly action?: { readonly href: string; readonly label: string };
  /** Anything richer than a single link — a filter reset, a form. */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-empty-state=""
      className={cn(
        'surface-raised-soft border-border flex flex-col items-center rounded-lg border px-6 py-10 text-center',
        className,
      )}
    >
      <span className="surface-inset mb-3 flex size-12 items-center justify-center rounded-full">
        <Icon aria-hidden="true" className={cn('size-5', TONES.neutral.icon)} />
      </span>
      <p className="text-text font-medium">{title}</p>
      {description !== undefined ? (
        <p className="text-text-muted mt-1 max-w-prose text-sm">{description}</p>
      ) : null}
      {action !== undefined ? (
        <ActionLink href={action.href} className="mt-4">
          {action.label}
        </ActionLink>
      ) : null}
      {children !== undefined ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

/**
 * A row of empty cells, for a table that has a shape worth keeping.
 *
 * Preferred over swapping the whole table for an `EmptyState` when the column
 * headings themselves tell the reader what *would* be here.
 */
export function EmptyTableRow({
  colSpan,
  children,
}: {
  readonly colSpan: number;
  readonly children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="text-text-muted px-3 py-8 text-center text-sm"
        data-empty-state=""
      >
        {children}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  /**
   * Which failure this is. It decides the icon and the tone, and — more
   * importantly — whether a retry is offered at all.
   */
  readonly kind?: 'unexpected' | 'network' | 'forbidden' | 'not-found';
  /**
   * A retry control. **Only ever passed for a read.** Re-running a financial
   * mutation from a button is how a borrower gets charged twice, so the
   * payment and reversal paths deliberately do not pass one; they tell the
   * staff member to check the register instead.
   */
  readonly retry?: ReactNode;
  readonly children?: ReactNode;
  readonly className?: string;
}

const ERROR_KINDS = {
  unexpected: { icon: AlertTriangle, tone: 'danger' },
  network: { icon: WifiOff, tone: 'warning' },
  forbidden: { icon: Lock, tone: 'warning' },
  'not-found': { icon: SearchX, tone: 'neutral' },
} as const;

export function ErrorState({
  title,
  description,
  kind = 'unexpected',
  retry,
  children,
  className,
}: ErrorStateProps) {
  const { icon: Icon, tone } = ERROR_KINDS[kind];
  const palette = TONES[tone];

  return (
    <div
      role="alert"
      data-error-state={kind}
      className={cn(
        'border-border bg-surface flex flex-col items-start gap-3 rounded-xl border p-5 sm:flex-row sm:items-center',
        className,
      )}
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full',
          palette.surface,
        )}
      >
        <Icon aria-hidden="true" className={cn('size-5', palette.icon)} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-text font-medium">{title}</p>
        {description !== undefined ? (
          <p className="text-text-muted mt-1 text-sm">{description}</p>
        ) : null}
        {children}
      </div>
      {retry !== undefined ? <div className="shrink-0">{retry}</div> : null}
    </div>
  );
}

/**
 * The refusal shown when a signed-in person reaches a route their role does
 * not cover.
 *
 * Says that *this account* may not do it, and never whether the record exists
 * — a 403 that confirms a loan number is a 403 that leaks a loan number.
 */
export function ForbiddenState({
  action = 'open this page',
  backHref,
  backLabel = 'Back to the dashboard',
}: {
  readonly action?: string;
  readonly backHref?: string;
  readonly backLabel?: string;
}) {
  return (
    <ErrorState
      kind="forbidden"
      title="You do not have access to this"
      description={`Your role does not allow you to ${action}. If you need it, ask the Owner to change your access.`}
    >
      {backHref !== undefined ? (
        <Link
          href={backHref}
          className="text-accent mt-2 inline-block text-sm underline-offset-2 hover:underline"
        >
          {backLabel}
        </Link>
      ) : null}
    </ErrorState>
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * A block that is being fetched.
 *
 * Deliberately plain and deliberately *not* shaped like the data it replaces
 * where money is involved. A skeleton that mimics a row of figures invites a
 * glance to read it as a figure; a labelled, obviously-inert block does not.
 */
export function LoadingBlock({
  label = 'Loading',
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'border-border text-text-muted flex items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-sm',
        className,
      )}
    >
      <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/**
 * A neutral placeholder bar, for text that is still arriving.
 *
 * `aria-hidden`, because a screen reader should hear the `LoadingBlock`'s
 * status message rather than a row of empty boxes.
 */
export function Skeleton({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('bg-surface-raised block animate-pulse rounded', className)}
    />
  );
}
