import Link from 'next/link';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils/cn';
import { METRIC_DEFINITIONS, type MetricKey } from '@/lib/domain/reporting';

const TONES = {
  neutral: 'border-border',
  info: 'border-info/40',
  success: 'border-success/40',
  warning: 'border-warning/40',
  danger: 'border-danger/40',
} as const;

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  /** A second line: a count beside a total, or what the figure excludes. */
  readonly secondary?: ReactNode;
  /**
   * What this figure means, in one sentence. Rendered, not a tooltip: a
   * definition nobody can see is a definition nobody agrees on, and two people
   * reading the same card differently is how a business acts on a number
   * twice.
   */
  readonly definition?: string;
  /** Pull the definition from the shared table instead of repeating it. */
  readonly metric?: MetricKey;
  readonly href?: string;
  readonly tone?: keyof typeof TONES;
  readonly badge?: string;
}

/**
 * One figure on a dashboard.
 *
 * ## Every card states what it means
 *
 * `definition` is required in practice, either directly or via `metric`, and a
 * test asserts that every dashboard card carries one. A money figure with a
 * three-word label — "Outstanding", "Collected" — is the thing that makes two
 * staff members confident about different numbers.
 *
 * ## A linked card is a link
 *
 * When `href` is given the whole card becomes an anchor, so it is reachable by
 * keyboard and announced as a link. A `div` with an `onClick` would look
 * identical and be unusable without a mouse.
 */
export function StatCard({
  label,
  value,
  secondary,
  definition,
  metric,
  href,
  tone = 'neutral',
  badge,
}: StatCardProps) {
  const text =
    definition ??
    (metric === undefined ? undefined : METRIC_DEFINITIONS[metric].definition);

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-text-muted text-sm">{label}</span>
        {badge !== undefined ? (
          <Badge tone={tone === 'neutral' ? 'neutral' : tone}>{badge}</Badge>
        ) : null}
      </div>
      <p className="text-text mt-1 text-xl font-semibold break-words sm:text-2xl">
        {value}
      </p>
      {secondary !== undefined ? (
        <p className="text-text-muted mt-0.5 text-sm break-words">{secondary}</p>
      ) : null}
      {text !== undefined ? (
        <p className="text-text-muted mt-2 text-xs leading-snug break-words">{text}</p>
      ) : null}
    </>
  );

  const classes = cn(
    'bg-surface rounded-xl border p-4 min-w-0',
    TONES[tone],
    href !== undefined
      ? 'hover:bg-surface-raised focus-visible:outline-brand-600 block transition-colors focus-visible:outline-2 focus-visible:outline-offset-2'
      : '',
  );

  return href === undefined ? (
    <div className={classes}>{body}</div>
  ) : (
    <Link href={href} className={classes}>
      {body}
    </Link>
  );
}

/**
 * A responsive grid of cards.
 *
 * One column at 320px, two from 480px, three on a tablet, four on a desktop.
 * Cards wrap; nothing is squeezed, and `min-w-0` on each card stops a long
 * figure forcing the whole page sideways.
 */
export function StatGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  );
}
