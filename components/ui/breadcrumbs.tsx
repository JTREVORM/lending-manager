import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils/cn';

/**
 * A compact breadcrumb trail for a deep page.
 *
 * The last crumb is the current page and is not a link — it is marked
 * `aria-current="page"` so a screen reader announces where the trail ends.
 * Earlier crumbs are links back up the hierarchy. Hidden in print, where the
 * page's own heading already says what it is.
 */
export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

export function Breadcrumbs({
  items,
  className,
}: {
  readonly items: readonly Crumb[];
  readonly className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0 print:hidden', className)}>
      <ol className="text-text-muted flex flex-wrap items-center gap-1 text-xs">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1">
              {item.href !== undefined && !last ? (
                <Link
                  href={item.href}
                  className="hover:text-accent rounded px-0.5 underline-offset-2 hover:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={cn('px-0.5', last && 'text-text font-medium')}
                  {...(last ? { 'aria-current': 'page' as const } : {})}
                >
                  {item.label}
                </span>
              )}
              {!last ? (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 opacity-60"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
