import type { ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * A record's state, as text.
 *
 * ## Why this replaced the badge
 *
 * Every register used to render its status as a filled, rounded, uppercase
 * pill — and most rows carried two of them, a lifecycle status beside a
 * workflow stage. Twenty rows of that is forty coloured capsules, and they
 * were the loudest thing on a screen whose subject is money. A pill also
 * looks like a control: people try to press them.
 *
 * A status is a *fact about the row*, at the same size and weight as the rest
 * of the row, in a restrained colour that says how much attention it wants.
 * That is what this renders, and it is what the reference design does.
 *
 * ## Colour never carries it alone
 *
 * The label always states the status in words. That is what makes it work for
 * a colour-blind reader, in a printout, and read aloud. The colour is a
 * second channel, never the only one — which is also why the tones are few
 * and mean something rather than being one hue per status.
 *
 * Every tone clears WCAG AA against white and against the row-hover fill.
 *
 * ## Where a pill is still right
 *
 * A pill is a chip: a small bounded thing in a set of them. A user's *roles*
 * are chips, and so is an active filter. Those keep `Badge`. A state does
 * not.
 */

const TONES = {
  /** Running normally, or finished the way it should. */
  positive: 'text-success',
  /** Waiting on somebody, or inside a concession. */
  attention: 'text-warning',
  /** Behind, refused, reversed, or abandoned. */
  critical: 'text-danger',
  /** No urgency either way — a draft, a record simply existing. */
  neutral: 'text-text',
  /** Secondary, settled, or no longer counting. */
  quiet: 'text-text-muted',
} as const;

export type StatusTone = keyof typeof TONES;

export function StatusText({
  children,
  tone = 'neutral',
  /**
   * The longer explanation, as a tooltip. A status label is short by nature;
   * "Awaiting disbursement" does not say that the money has been approved but
   * not released, and somewhere it should.
   */
  title,
  className,
}: {
  readonly children: ReactNode;
  readonly tone?: StatusTone;
  readonly title?: string;
  readonly className?: string;
}) {
  return (
    <span
      data-status-tone={tone}
      className={cn(
        // Medium, not bold: enough to separate it from the figures beside it,
        // not enough to shout. Never wraps — a status broken over two lines
        // is the thing the column widths exist to prevent.
        'font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...(title === undefined ? {} : { title })}
    >
      {children}
    </span>
  );
}

/**
 * The stage a record sits at in its workflow, as quiet text.
 *
 * Separate from `StatusText` because it answers a different question and
 * should not compete with it. A loan's *status* is what it is; its *stage* is
 * where it sits in the process, and on most rows the two agree — an active
 * loan is at the active stage. Giving the stage its own colour would paint
 * the same fact twice.
 *
 * So the stage is neutral by default, and only the two stages that are not
 * implied by the status — arrears and a grace period — take a tone.
 */
export function StageText({
  children,
  tone = 'quiet',
  className,
}: {
  readonly children: ReactNode;
  readonly tone?: StatusTone;
  readonly className?: string;
}) {
  return (
    <span className={cn('whitespace-nowrap', TONES[tone], className)}>{children}</span>
  );
}
