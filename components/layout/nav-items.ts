import {
  AlertTriangle,
  Banknote,
  ChartColumn,
  HeartHandshake,
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
  /**
   * Shorter label for a bottom bar cell.
   *
   * Rendered by the borrower portal, which is the only shell with a bottom
   * bar; the staff shell navigates through its rail at every width. Still
   * required of every entry, because `splitForBottomBar` is one rule serving
   * both menus and an entry without a short label would render blank the day
   * it reached a bar.
   */
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
  /**
   * Which part of the job this belongs to. The desktop sidebar renders one
   * labelled block per group, so eleven flat entries become three short
   * lists a reader can scan. Capability filtering still decides what appears;
   * a group with nothing visible in it is not rendered at all.
   */
  readonly group: NavGroup;
  /**
   * Rank in a bottom bar, lowest first. The bar holds four destinations and a
   * "More" button; everything else lives behind More.
   *
   * Undefined means "never in the bar" — it is reachable from More instead.
   *
   * Only the borrower portal renders a bar. The staff ranks are kept because
   * the staff menu, at eleven entries, is the one that exercises the overflow
   * branch of `splitForBottomBar`, and that rule is shared with the portal.
   */
  readonly bottomBarRank?: number;
}

/** The sidebar's three blocks, in the order they are rendered. */
export const NAV_GROUPS = ['operations', 'insights', 'administration'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const NAV_GROUP_LABELS: Readonly<Record<NavGroup, string>> = {
  operations: 'Operations',
  insights: 'Insights',
  administration: 'Administration',
};

/**
 * How many destinations a bottom bar holds before "More".
 *
 * Four, not ten. The pre-Phase-9 bar tried to fit every entry across 390px and
 * produced labels reading `H…`, `Cli…`, `B…` — seven of ten unreadable. Four
 * cells plus More leaves roughly 78px each, which fits "Payments" at the
 * bar's type size with room to spare.
 */
export const BOTTOM_BAR_SLOTS = 4;

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
    group: 'operations',
    bottomBarRank: 1,
  },
  {
    href: ROUTES.clients,
    label: 'Clients',
    shortLabel: 'Clients',
    icon: Users,
    // Its own capability as of Phase 3, rather than `dashboard:view`. A
    // borrower reads their own client record through the portal, never
    // through this directory.
    permission: 'clients:view',
    phase: 3,
    group: 'operations',
    bottomBarRank: 2,
  },
  {
    href: ROUTES.guarantors,
    label: 'Guarantors',
    // Ten characters clips in a bottom-bar cell at 320px. "Backers" is what a
    // loan officer would say out loud, and the sidebar still carries the full
    // word where there is room for it.
    shortLabel: 'Backers',
    icon: HeartHandshake,
    permission: 'guarantors:view',
    phase: 3,
    group: 'operations',
  },
  {
    href: ROUTES.loans,
    label: 'Loans',
    shortLabel: 'Loans',
    icon: Banknote,
    // Its own capability as of Phase 4, rather than `dashboard:view`. A
    // borrower's view of their own loans is a later phase.
    permission: 'loans:view',
    phase: 4,
    group: 'operations',
    bottomBarRank: 3,
  },
  {
    href: ROUTES.payments,
    label: 'Payments',
    shortLabel: 'Pay',
    icon: Receipt,
    // Its own capability as of Phase 6. A borrower reaches their own payment
    // history through the portal, not this entry.
    permission: 'payments:view',
    phase: 6,
    group: 'operations',
    bottomBarRank: 4,
  },
  {
    href: ROUTES.overdue,
    label: 'Overdue',
    shortLabel: 'Late',
    icon: AlertTriangle,
    // Its own capability. A borrower sees their own arrears in the portal and
    // never this directory.
    permission: 'delinquency:view',
    phase: 7,
    group: 'operations',
  },
  {
    href: ROUTES.reports,
    label: 'Reports',
    shortLabel: 'Reports',
    icon: ChartColumn,
    // `reports:view_operational`, which every staff role holds — not
    // `dashboard:view`. The two narrower reporting capabilities gate
    // individual pages inside this section rather than the entry itself, so
    // the menu matches the route map exactly, which is the agreement the
    // navigation parity test asserts.
    permission: 'reports:view_operational',
    phase: 8,
    group: 'insights',
  },
  {
    href: ROUTES.users,
    label: 'Users',
    shortLabel: 'Users',
    icon: UserCog,
    permission: 'users:view',
    phase: 2,
    group: 'administration',
  },
  {
    href: ROUTES.audit,
    label: 'Audit trail',
    shortLabel: 'Audit',
    icon: ScrollText,
    permission: 'audit:view',
    phase: 2,
    group: 'insights',
  },
  {
    href: ROUTES.settings,
    label: 'Settings',
    shortLabel: 'Settings',
    icon: Settings,
    permission: 'settings:view',
    phase: 3,
    group: 'administration',
  },
  {
    href: ROUTES.account,
    label: 'My account',
    shortLabel: 'Me',
    icon: UserCircle,
    permission: 'account:view',
    phase: 2,
    group: 'administration',
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
    group: 'operations',
    bottomBarRank: 1,
  },
  {
    href: ROUTES.account,
    label: 'My account',
    shortLabel: 'Me',
    icon: UserCircle,
    permission: 'account:view',
    phase: 2,
    group: 'administration',
    bottomBarRank: 2,
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

/**
 * The entries a bottom bar shows, and the ones behind "More".
 *
 * The bar takes the four highest-ranked destinations this person can reach,
 * in rank order; everything else they can reach goes to the overflow. Both
 * lists come from the same capability filter, so a destination cannot appear
 * in one and be missing from the other, and a role that cannot reach a
 * destination sees it in neither.
 *
 * When the overflow would be empty — the borrower portal, which has two
 * entries — the bar takes everything and no "More" button is rendered. A
 * button that opens a list of nothing is worse than no button.
 */
export function splitForBottomBar(
  items: readonly NavItem[],
  permissions: readonly Permission[],
): { readonly bar: readonly NavItem[]; readonly overflow: readonly NavItem[] } {
  const visible = visibleNavItems(items, permissions);

  const ranked = visible
    .filter((item) => item.bottomBarRank !== undefined)
    .toSorted((a, b) => (a.bottomBarRank ?? 0) - (b.bottomBarRank ?? 0));

  // Everything else keeps the order it was declared in, which is the order
  // the sidebar uses — so a person who learns the menu in one place is not
  // relearning it in the other.
  const rest = visible.filter((item) => !ranked.includes(item));

  if (visible.length <= BOTTOM_BAR_SLOTS + 1) {
    return { bar: visible, overflow: [] };
  }

  const bar = ranked.slice(0, BOTTOM_BAR_SLOTS);
  const overflow = [...ranked.slice(BOTTOM_BAR_SLOTS), ...rest];

  return { bar, overflow };
}

/**
 * The sidebar's blocks: each group with the entries this person can reach.
 *
 * A group whose entries are all filtered out is dropped, so a Secretary never
 * sees an "Administration" heading with nothing under it.
 */
export function groupedNavItems(
  items: readonly NavItem[],
  permissions: readonly Permission[],
): readonly { readonly group: NavGroup; readonly items: readonly NavItem[] }[] {
  const visible = visibleNavItems(items, permissions);

  return NAV_GROUPS.map((group) => ({
    group,
    items: visible.filter((item) => item.group === group),
  })).filter((block) => block.items.length > 0);
}
