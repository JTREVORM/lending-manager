import { cn } from '@/lib/utils/cn';

export interface SpinnerProps {
  readonly className?: string;
  /** Announced to assistive technology. */
  readonly label?: string;
}

/**
 * A loading indicator.
 *
 * The spinner itself is `aria-hidden` and the state is conveyed by text in a
 * `role="status"` region — a spinning border means nothing to a screen reader.
 */
export function Spinner({ className, label = 'Loading' }: SpinnerProps) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn(
          'border-brand-500 size-5 animate-spin rounded-full border-2 border-t-transparent',
          className,
        )}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * The reference project's loading indicator: a "Loading..." wordmark with a
 * sweep that fills the letters left to right.
 *
 * ## Why a wordmark rather than a spinner
 *
 * It is the reference's single loading state — table bodies, card bodies, the
 * full-screen refresh veil — and it says what is happening in words instead of
 * asking the reader to infer it from a rotating arc. On a slow connection at a
 * counter, "Loading..." is information and a spinning circle is not.
 *
 * The animation and the text both come from `.loader` in `globals.css`: the
 * word lives in `::before` so the element itself can carry the moving
 * gradient, which is then clipped to the glyphs. That is why this renders no
 * children. Under `prefers-reduced-motion` the sweep stops and the stylesheet
 * shows solid text, because a sweep that never resolves is worse than none.
 *
 * `role="status"` with an `aria-label`, since a screen reader cannot see a
 * gradient and there is no real text node to announce.
 */
export function Loader({
  size = 'md',
  onDark = false,
  className,
  label = 'Loading',
}: {
  /** `sm` (16px) for table and card bodies, `md` (30px) for a whole page. */
  readonly size?: 'sm' | 'md';
  /** Inverts the sweep for use on the navy surfaces. */
  readonly onDark?: boolean;
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        'loader',
        size === 'sm' ? 'loader-sm' : undefined,
        onDark ? 'loader-on-dark' : undefined,
        className,
      )}
    />
  );
}

/** Centred loader for an empty panel, a table body or a whole page. */
export function LoaderBlock({
  size = 'sm',
  className,
  label,
}: {
  readonly size?: 'sm' | 'md';
  readonly className?: string;
  readonly label?: string;
}) {
  return (
    <div className={cn('flex items-center justify-center py-10', className)}>
      <Loader size={size} {...(label === undefined ? {} : { label })} />
    </div>
  );
}
