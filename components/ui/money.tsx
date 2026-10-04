import type { ReactNode } from 'react';

import { formatUgx, type UgxAmount } from '@/lib/domain/money';
import { cn } from '@/lib/utils/cn';

/**
 * The one way this application puts a sum of money on screen.
 *
 * ## Why a component rather than a call to `formatUgx`
 *
 * `formatUgx` returns `UGX 1,250,000` — a string with an ordinary space in
 * it. Dropped straight into a narrow table cell or a dashboard card, the
 * browser is free to break that space, and the pre-Phase-9 screenshots are
 * full of cells reading `UGX` on one line and `148,705` on the next. A
 * currency code severed from its figure is not a smaller problem than a wrong
 * figure: on the payments register it happened on *every* row.
 *
 * The fix is structural, so it is made once, here:
 *
 *   - `whitespace-nowrap` keeps the code and the number together, and keeps
 *     the groups of a long number together. A column that cannot fit the
 *     value widens or scrolls; it never guesses where to break.
 *   - `tabular-nums` makes the digits one width, so a column of figures lines
 *     up on the thousands separator instead of drifting.
 *   - `inline-block` gives the span a box, so `text-right` on a cell aligns
 *     the whole value rather than its last line.
 *
 * ## What this component does not do
 *
 * It does not add, subtract, convert or round. It takes an amount that some
 * trusted engine already decided and renders it. There is no arithmetic in
 * this file and there must never be: the moment a display component starts
 * computing, the screen and the ledger can disagree.
 *
 * `null` is a real answer — a loan that has no penalty, an approval that has
 * not fixed its amounts yet — and renders as an em dash rather than `UGX 0`,
 * because "nothing recorded" and "zero shillings" are different statements.
 */

const TONES = {
  default: 'text-text',
  muted: 'text-text-muted',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  /** Inherit whatever the surrounding text is using. */
  inherit: '',
} as const;

const WEIGHTS = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
  inherit: '',
} as const;

const SIZES = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  /** The headline figure on a summary card. */
  display: 'text-2xl sm:text-3xl',
  inherit: '',
} as const;

export interface MoneyProps {
  /**
   * The amount, already decided by the engine that owns it. A plain `number`
   * is accepted for values read straight from the database, which arrive as
   * whole shillings before they are branded.
   */
  readonly amount: UgxAmount | number | null | undefined;
  /**
   * `'full'` renders `UGX 1,250,000`.
   * `'bare'` renders `1,250,000`, for a table whose column heading already
   * says the currency and would otherwise repeat it on every row.
   */
  readonly variant?: 'full' | 'bare';
  readonly tone?: keyof typeof TONES;
  readonly weight?: keyof typeof WEIGHTS;
  readonly size?: keyof typeof SIZES;
  /**
   * A reversed payment. Struck through *and* given a title, because a line
   * through a number is easy to miss and impossible to hear.
   */
  readonly struck?: boolean;
  /** What to render when `amount` is null. */
  readonly placeholder?: ReactNode;
  readonly currencyCode?: string;
  readonly locale?: string;
  readonly className?: string;
}

export function Money({
  amount,
  variant = 'full',
  tone = 'inherit',
  weight = 'inherit',
  size = 'inherit',
  struck = false,
  placeholder = '—',
  currencyCode,
  locale,
  className,
}: MoneyProps) {
  if (amount === null || amount === undefined) {
    return (
      <span className={cn('text-text-muted', className)} aria-label="Not recorded">
        {placeholder}
      </span>
    );
  }

  const text = formatUgx(amount as UgxAmount, {
    withCurrency: variant === 'full',
    ...(currencyCode === undefined ? {} : { currencyCode }),
    ...(locale === undefined ? {} : { locale }),
  });

  return (
    <span
      // `data-money` is what the layout tests assert on: it marks every
      // rendered sum so a test can prove none of them is breakable, without
      // depending on a class name.
      data-money=""
      className={cn(
        'tabular inline-block whitespace-nowrap',
        TONES[tone],
        WEIGHTS[weight],
        SIZES[size],
        struck ? 'line-through' : undefined,
        className,
      )}
      {...(struck ? { title: 'Reversed — this amount no longer counts' } : {})}
    >
      {text}
    </span>
  );
}

/**
 * A money figure with its label, as a summary card states it.
 *
 * The pairing is the point: a figure without its definition is the thing this
 * system most wants to avoid putting on a screen. `note` carries the one-line
 * caveat ("Reversed payments excluded"); the longer explanation belongs in
 * `detail`, which pages may choose to render behind a disclosure.
 */
export interface MoneyStatProps {
  readonly label: string;
  readonly amount: UgxAmount | number | null;
  readonly note?: ReactNode;
  readonly tone?: MoneyProps['tone'];
  readonly className?: string;
}

export function MoneyStat({ label, amount, note, tone, className }: MoneyStatProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-text-muted text-sm">{label}</p>
      <Money
        amount={amount}
        size="lg"
        weight="semibold"
        {...(tone === undefined ? {} : { tone })}
      />
      {note !== undefined ? (
        <p className="text-text-muted mt-0.5 text-xs">{note}</p>
      ) : null}
    </div>
  );
}
