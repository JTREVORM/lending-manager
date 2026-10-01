'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ROUTES } from '@/config/app';
import { cn } from '@/lib/utils/cn';
import { NAV_ITEMS, type NavItem } from './nav-items';

/**
 * The primary navigation, rendered either as the desktop sidebar list or the
 * mobile bottom bar.
 *
 * This is a Client Component and it imports `NAV_ITEMS` itself rather than
 * receiving them as a prop. That is deliberate and not merely tidier: each nav
 * item carries a Lucide icon, which is a React component, and a component
 * cannot be serialised across the server/client boundary. Passing the items
 * down from the server shell would fail at build time with "Functions cannot
 * be passed directly to Client Components". Only the `variant` string crosses.
 */
export function PrimaryNav({ variant }: { readonly variant: 'sidebar' | 'bottom-bar' }) {
  const pathname = usePathname();

  if (variant === 'bottom-bar') {
    return (
      <>
        {NAV_ITEMS.map((item) => (
          <BottomBarLink key={item.href} item={item} pathname={pathname} />
        ))}
      </>
    );
  }

  return (
    <ul className="flex flex-1 flex-col gap-1">
      {NAV_ITEMS.map((item) => (
        <li key={item.href}>
          <SidebarLink item={item} pathname={pathname} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Is this item the page currently being viewed?
 *
 * The dashboard lives at `/`, so a prefix match would make it active on every
 * page; it matches exactly. Every other section matches its own subtree, so a
 * client detail page keeps Clients highlighted.
 *
 * Exported for direct testing.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === ROUTES.dashboard) return pathname === ROUTES.dashboard;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({
  item,
  pathname,
}: {
  readonly item: NavItem;
  readonly pathname: string;
}) {
  const isActive = isNavItemActive(item.href, pathname);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      // What actually tells a screen-reader user where they are. The highlight
      // is the visual equivalent of the same fact, set from one source.
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'min-h-touch flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? // The dark-mode tint is derived from brand-500 rather than
            // brand-900: against a dark surface the darker shade is almost
            // invisible, so the current page would be signalled by text colour
            // alone.
            'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
          : 'text-text-muted hover:bg-surface-raised hover:text-text',
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function BottomBarLink({
  item,
  pathname,
}: {
  readonly item: NavItem;
  readonly pathname: string;
}) {
  const isActive = isNavItemActive(item.href, pathname);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'min-h-touch flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5',
        'text-[0.6875rem] font-medium transition-colors',
        isActive ? 'text-brand-600' : 'text-text-muted hover:text-text',
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <span className="truncate">{item.shortLabel}</span>
    </Link>
  );
}
