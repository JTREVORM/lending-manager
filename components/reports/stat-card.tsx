import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { InfoHint } from '@/components/ui/info-hint';
import { cn } from '@/lib/utils/cn';
import { METRIC_DEFINITIONS, type MetricKey } from '@/lib/domain/reporting';

/**
 * The reference outlines a card in the status colour it carries rather than
 * filling it: a bordered white panel stays readable beside eleven others,
 * where four tinted fills in a row read as an alarm.
 */
const TONES = {
  neutral: 'border-border',
  info: 'border-info/40',
  success: 'border-success/40',
  warning: 'border-warning/40',
  danger: 'border-danger/40',
} as const;

export interface StatCardProps {
  readonly label: string;
  /**
   * The figure. A node rather than a string so a card can hold a `<Money>`,
   * which is what keeps `UGX` on the same line as its number — the pre-Phase-9
   * dashboard wrapped on exactly these cards.
   */
  readonly value: ReactNode;
  /** A second line: a count beside a total, or what the figure excludes. */
  readonly secondary?: ReactNode;
  /**
   * What this figure means, in one sentence.
   *
   * Carried by every card, and reachable from every card — behind the small
   * info control in its corner rather than printed under the figure. The
   * sentence still exists, in the markup, for a screen reader and for
   * anybody who presses the icon; what it no longer does is turn a strip of
   * four figures into twelve lines of prose.
   */
  readonly definition?: string;
  /** Pull the definition from the shared table instead of repeating it. */
  readonly metric?: MetricKey;
  readonly href?: string;
  readonly tone?: keyof typeof TONES;
  readonly badge?: string;
  /**
   * The icon for the tile to the left of the figure. The reference puts one on
   * every summary card — a navy glyph on a navy-at-10% rounded square — which
   * is what lets a row of four be told apart at a glance rather than read.
   */
  readonly icon?: LucideIcon;
}

/**
 * One figure on a dashboard.
 *
 * ## Every card states what it means, and says it once
 *
 * `definition` is required in practice, either directly or via `metric`, and a
 * test asserts that every dashboard card carries one. A money figure with a
 * three-word label — "Outstanding", "Collected" — is the thing that makes two
 * staff members confident about different numbers.
 *
 * It is reached through `InfoHint` rather than printed: the card holds the
 * title, the figure and at most one supporting line, which is what makes a
 * row of four readable at a glance. See `InfoHint` for why the sentence is
 * still in the markup either way.
 *
 * ## A linked card is a link
 *
 * When `href` is given the whole card becomes an anchor, so it is reachable by
 * keyboard and announced as a link. A `div` with an `onClick` would look
 * identical and be unusable without a mouse.
 *
 * Which is why the info control sits *outside* that anchor, pinned to the
 * card's corner by its wrapper: a `<button>` inside an `<a>` is invalid, and
 * in practice a press on it would both open the definition and navigate away
 * from the card being asked about.
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
  icon,
}: StatCardProps) {
  const text =
    definition ??
    (metric === undefined ? undefined : METRIC_DEFINITIONS[metric].definition);

  const Icon = icon;

  const body = (
    <>
      <div className="flex items-start gap-3">
        {/* The reference's icon tile: a 40px rounded square in the navy at
            10% opacity, with the navy icon inside it. */}
        {Icon === undefined ? null : (
          <span className="bg-accent/10 text-accent flex size-10 shrink-0 items-center justify-center rounded-xl">
            <Icon aria-hidden="true" className="size-5" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="t-label">{label}</span>
            {badge !== undefined ? (
              <Badge tone={tone === 'neutral' ? 'neutral' : tone}>{badge}</Badge>
            ) : null}
          </div>
          {/* The headline figure, the loudest thing on the card. The
              reference sets these in `font-black`. */}
          <p className="t-metric-sm text-text mt-0.5 break-words">{value}</p>
          {secondary !== undefined ? (
            <p className="t-helper mt-1 break-words">{secondary}</p>
          ) : null}
        </div>
      </div>
    </>
  );

  const classes = cn(
    // The reference's summary card: `rounded-2xl border border-slate-200
    // bg-white p-4 shadow-xs`. A flat bordered panel, not a glass one — its
    // summary strips sit directly under the gradient banner, and a second
    // translucent surface there muddies both.
    'bg-surface min-w-0 rounded-2xl border p-4 shadow-xs',
    TONES[tone],
    // Room for the info control in the corner, so a long label never runs
    // underneath it.
    text === undefined ? '' : 'pr-9',
    href !== undefined
      ? 'lift block focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-2'
      : '',
  );

  return (
    <div className="relative min-w-0">
      {href === undefined ? (
        <div className={classes}>{body}</div>
      ) : (
        <Link href={href} className={classes}>
          {body}
        </Link>
      )}

      {text === undefined ? null : (
        <InfoHint className="absolute top-2 right-1.5" text={text} subject={label} />
      )}
    </div>
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
