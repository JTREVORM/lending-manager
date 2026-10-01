import { Banknote, LayoutDashboard, Receipt, Settings, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ROUTES } from '@/config/app';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Shorter label for the bottom bar on a phone. */
  readonly shortLabel: string;
  readonly icon: LucideIcon;
  /**
   * The phase that implements this section. Anything above the current phase
   * renders a placeholder page that says so, rather than a broken screen.
   */
  readonly phase: number;
}

/**
 * The application's primary navigation.
 *
 * Defined once and consumed by both the desktop sidebar and the mobile bottom
 * bar, so the two cannot drift apart.
 *
 * The Phase 2+ entries are present deliberately. Staff and the business need
 * to see the shape of the finished system, and each one leads to an honest
 * "not built yet" page rather than a dead link or a half-working screen.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: ROUTES.dashboard,
    label: 'Dashboard',
    shortLabel: 'Home',
    icon: LayoutDashboard,
    phase: 1,
  },
  {
    href: ROUTES.clients,
    label: 'Clients',
    shortLabel: 'Clients',
    icon: Users,
    phase: 2,
  },
  {
    href: ROUTES.loans,
    label: 'Loans',
    shortLabel: 'Loans',
    icon: Banknote,
    phase: 3,
  },
  {
    href: ROUTES.payments,
    label: 'Payments',
    shortLabel: 'Pay',
    icon: Receipt,
    phase: 4,
  },
  {
    href: ROUTES.settings,
    label: 'Settings',
    shortLabel: 'Settings',
    icon: Settings,
    phase: 2,
  },
];
