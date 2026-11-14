import Link from 'next/link';

/**
 * A row of filter chips, as links.
 *
 * ## Why links and not controls
 *
 * Every filter in the Agency module carries the whole filter forward in the
 * URL, so the back button works, a narrowed register or report can be
 * bookmarked and shared, and the page is usable with no JavaScript at all.
 * That is worth more here than anywhere else in the application: these screens
 * are read at a counter on a phone, and a filter that needed a round trip
 * through a client component to change would be a filter that stops working
 * when the connection does.
 *
 * ## Why this is one component rather than one per screen
 *
 * The reporting hub has four chip rows, the transaction register has two, and
 * the transfers screen has one. They were the same eighteen lines of Tailwind
 * three times over, and the third copy was declared *inside* a render — which
 * the lint rule refuses, correctly, because a component created during render
 * resets its state on every pass.
 *
 * `aria-current="page"` marks the active chip, so the selection is announced
 * rather than only coloured.
 */
export interface FilterChip {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}

export function FilterChips({
  label,
  options,
}: {
  readonly label: string;
  readonly options: readonly FilterChip[];
}) {
  return (
    <div className="min-w-0">
      <p className="text-text-muted mb-1.5 text-[11px] font-bold tracking-wide uppercase">
        {label}
      </p>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {options.map((option) => (
          <Link
            key={option.href}
            href={option.href}
            aria-current={option.active ? 'page' : undefined}
            className={
              option.active
                ? 'bg-brand rounded-full px-3 py-1.5 text-xs font-bold text-white'
                : 'border-border bg-surface text-text hover:bg-surface-hover rounded-full border px-3 py-1.5 text-xs font-semibold'
            }
          >
            {option.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
