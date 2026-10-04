'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils/cn';
import type { Permission } from '@/lib/permissions';
import { PORTAL_NAV_ITEMS, visibleNavItems } from './nav-items';
import { isNavItemActive } from './primary-nav';

/**
 * The borrower's navigation on a screen wide enough for it.
 *
 * Horizontal, in the header, beside the company name — so the desktop portal
 * has real navigation rather than a phone bar floating over its content. The
 * same two entries, the same capability filter, the same active rule as the
 * bottom bar; only the shape differs.
 *
 * Client-side for the same reason `PrimaryNav` is: `usePathname` decides which
 * entry is current, and the Lucide icons cannot cross the server boundary.
 */
export function PortalTopNav({
  permissions,
}: {
  readonly permissions: readonly Permission[];
}) {
  const pathname = usePathname();
  const items = visibleNavItems(PORTAL_NAV_ITEMS, permissions);

  if (items.length === 0) return null;

  return (
    <nav aria-label="Main navigation">
      <ul className="flex items-center gap-1">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = isNavItemActive(item.href, pathname);

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'min-h-touch flex items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
                    : 'text-text-muted hover:bg-surface-raised hover:text-text',
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
