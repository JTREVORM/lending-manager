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
