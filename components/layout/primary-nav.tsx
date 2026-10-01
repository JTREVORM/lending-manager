'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ROUTES } from '@/config/app';
import { cn } from '@/lib/utils/cn';
import type { Permission } from '@/lib/permissions';
import { visibleNavItems, type NavItem } from './nav-items';

export interface PrimaryNavProps {
  readonly variant: 'sidebar' | 'bottom-bar';
  readonly items: readonly NavItem[];
  /** The viewer's capabilities, resolved server-side and passed down. */
  readonly permissions: readonly Permission[];
}

/**
 * The primary navigation, as a sidebar list or a bottom bar.
 *
 * `items` and `permissions` are plain serialisable data passed from the
 * server, which is what lets a Client Component render a server-resolved
 * session. The icons live in the item definitions, which are imported here
 * rather than passed as props — a React component cannot cross the
 * server/client boundary.
 *
 * Filtering here hides entries the viewer cannot use. It is not the
 * protection: the same capability is enforced by the route guard and by Row
 * Level Security, and both would refuse a hand-typed URL.
 */
export function PrimaryNav({ variant, items, permissions }: PrimaryNavProps) {
  const pathname = usePathname();
  const visible = visibleNavItems(items, permissions);

  if (variant === 'bottom-bar') {
    return (
      <>
        {visible.map((item) => (
          <BottomBarLink key={item.href} item={item} pathname={pathname} />
        ))}
      </>
    );
  }

  return (
    <ul className="flex flex-1 flex-col gap-1">
      {visible.map((item) => (
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
 * detail page keeps its parent highlighted.
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
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'min-h-touch flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
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
        'min-h-touch flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5',
        'text-[0.6875rem] font-medium transition-colors',
        isActive ? 'text-brand-600' : 'text-text-muted hover:text-text',
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <span className="w-full truncate text-center">{item.shortLabel}</span>
    </Link>
  );
}
