import { cn } from '@/lib/utils/cn';

/**
 * A progress meter: a teal fill in the reference's inset track.
 *
 * `value` is a percentage, clamped to 0–100. The semantics are carried on the
 * wrapper with `role="progressbar"` and the aria-value* attributes, so a
 * screen reader reads the figure that the coloured fill only shows; the fill
 * itself is `aria-hidden`. Not used for anything a wrong reading would mislead
 * about money — it is a completion indicator, not a balance.
 */
export function Progress({
  value,
  label,
  className,
  tone = 'accent',
}: {
  readonly value: number;
  readonly label: string;
  readonly className?: string;
  readonly tone?: 'accent' | 'success' | 'warning' | 'danger';
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const fill = {
    accent: 'bg-accent',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
  }[tone];

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('surface-inset h-2.5 overflow-hidden rounded-full', className)}
    >
      <div
        aria-hidden="true"
        className={cn('h-full rounded-full transition-[width] duration-500', fill)}
        style={{ width: `${String(pct)}%` }}
      />
    </div>
  );
}
