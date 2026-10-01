import {
  Banknote,
  LayoutDashboard,
  Receipt,
  ScrollText,
  Settings,
  UserCircle,
  Users,
  UserCog,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ROUTES } from '@/config/app';
import type { Permission } from '@/lib/permissions';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Shorter label for the bottom bar on a phone. */
  readonly shortLabel: string;
  readonly icon: LucideIcon;
  /**
   * The capability required to see — and to reach — this entry.
   *
   * The same map the route guard uses, so a hidden link and a protected route
   * cannot disagree. Hiding a menu entry is never the protection; it is the
   * courtesy that stops staff clicking into a refusal.
   */
  readonly permission: Permission;
  /**
   * The delivery phase that implements this section. Anything above the
   * current phase renders a placeholder saying so, rather than a dead screen.
   */
  readonly phase: number;
}

/**
 * Staff navigation.
 *
 * Filtered by capability at render time, so a Secretary/Treasurer sees four
 * entries and an Owner sees seven, from one definition.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: ROUTES.dashboard,
    label: 'Dashboard',
    shortLabel: 'Home',
    icon: LayoutDashboard,
    permission: 'dashboard:view',
    phase: 1,
  },
  {
    href: ROUTES.clients,
    label: 'Clients',
    shortLabel: 'Clients',
    icon: Users,
    permission: 'dashboard:view',
    phase: 3,
  },
  {
    href: ROUTES.loans,
    label: 'Loans',
    shortLabel: 'Loans',
    icon: Banknote,
    permission: 'dashboard:view',
    phase: 4,
  },
  {
    href: ROUTES.payments,
    label: 'Payments',
    shortLabel: 'Pay',
    icon: Receipt,
    permission: 'dashboard:view',
    phase: 5,
  },
  {
    href: ROUTES.users,
    label: 'Users',
    shortLabel: 'Users',
    icon: UserCog,
    permission: 'users:view',
    phase: 2,
  },
  {
    href: ROUTES.audit,
    label: 'Audit trail',
    shortLabel: 'Audit',
    icon: ScrollText,
    permission: 'audit:view',
    phase: 2,
  },
  {
    href: ROUTES.settings,
    label: 'Settings',
    shortLabel: 'Settings',
    icon: Settings,
    permission: 'settings:view',
    phase: 3,
  },
  {
    href: ROUTES.account,
    label: 'My account',
    shortLabel: 'Me',
    icon: UserCircle,
    permission: 'account:view',
    phase: 2,
  },
];

/** Borrower navigation. Deliberately tiny, and structurally separate. */
export const PORTAL_NAV_ITEMS: readonly NavItem[] = [
  {
    href: ROUTES.portal,
    label: 'My loans',
    shortLabel: 'Loans',
    icon: Banknote,
    permission: 'portal:view',
    phase: 6,
  },
  {
    href: ROUTES.account,
    label: 'My account',
    shortLabel: 'Me',
    icon: UserCircle,
    permission: 'account:view',
    phase: 2,
  },
];

/**
 * The entries a given set of capabilities may see.
 *
 * Exported for direct testing: the filtering rule is a visible part of the
 * authorization model and is asserted independently of any component.
 */
export function visibleNavItems(
  items: readonly NavItem[],
  permissions: readonly Permission[],
): readonly NavItem[] {
  return items.filter((item) => permissions.includes(item.permission));
}
