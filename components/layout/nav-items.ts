import {
  Banknote,
  Bell,
  ChartColumn,
  Landmark,
  LayoutDashboard,
  Network,
  Receipt,
  Settings,
  ShieldAlert,
  UserCircle,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ROUTES } from '@/config/app';
import type { Permission } from '@/lib/permissions';

/**
 * One destination in a menu.
 *
 * `href` may carry a query string and a fragment. Most of this rail is
 * **filtered views of screens that already read those filters** — the loan
 * register's ten workflow stages, the client register's statuses, Debt &
 * Security's five views, the collection summary's five slices — because a
 * label does not earn a route. `navPath` and `navQuery` split an href back
 * apart for the two jobs that need the pieces: matching the capability map,
 * and deciding which single entry is the page being viewed.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * Shorter label for a bottom-bar cell.
   *
   * Only the borrower portal renders a bar, so only its entries need one; the
   * staff rail carries full labels at every width.
   */
  readonly shortLabel?: string;
  readonly icon?: LucideIcon;
  /**
   * The capability that opens the *route* behind this entry.
   *
   * The same map the route guard reads, so a visible link and a protected
   * route cannot disagree. Asserted against `permissionForPath` by the
   * navigation parity test, on the path — a query string is a filter, not a
   * permission.
   */
  readonly permission: Permission;
  /**
   * Further capabilities the destination itself demands, beyond the one its
   * route prefix requires.
   *
   * `/loans/new` sits under the `loans:view` prefix and guards `loans:create`.
   * `/reports/penalties` sits under `reports:view_operational` and guards
   * `reports:view_financial` and `penalties:view`. `/guarantors/register`
   * sits under `guarantors:view` and reads the narrower ones itself. Listing
   * them here means the rail offers no entry that would refuse the person who
   * clicks it, while `permission` stays exactly what the prefix map says.
   *
   * Hiding is never the protection. The pages guard themselves and Row Level
   * Security refuses the rows; this only stops staff clicking into a refusal.
   */
  readonly requires?: readonly Permission[];
  /** The delivery phase that implements this destination. */
  readonly phase: number;
  /** Rank in a bottom bar, lowest first. Portal only. */
  readonly bottomBarRank?: number;
  /**
   * Whether the rail prefetches this destination. Defaults to on.
   *
   * Phase 14's reason, and it still holds: prefetching a dynamic route runs
   * the page server-side, and Debt & Security reads a grouping-sets aggregate
   * over the whole active book. Every visit to any screen would have computed
   * the portfolio's PAR whether or not anybody looked at it.
   *
   * Collapsing the rail into modules reduced the pressure sharply — a closed
   * module renders no links at all, so a cold load now prefetches the
   * dashboard and nothing else — but the opt-out stays on the entries whose
   * destination is expensive to render, because opening that module should
   * not fire five aggregates either.
   */
  readonly prefetch?: boolean;
}

/**
 * A collapsible module in the staff rail.
 *
 * The rail used to carry four broad blocks — Operations, Finance, Insights,
 * Administration — with every destination inside them and all of them open.
 * By Phase 17 that had become twenty flat rows in which lending, collections,
 * arrears, recovery and notifications were one undifferentiated list under
 * "Operations", and the reporting surface — ten reports, an export pipeline
 * and three capabilities of its own — read as a single link under "Insights".
 *
 * These are the business's own divisions instead, each closed until somebody
 * asks for it.
 */
export interface NavModule {
  readonly id: NavModuleId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly items: readonly NavItem[];
}

export const NAV_MODULE_IDS = [
  'clients',
  'loans',
  'collections',
  'debt',
  'finance',
  'reports',
  'branches',
  'administration',
] as const;

export type NavModuleId = (typeof NAV_MODULE_IDS)[number];

/**
 * How many destinations a bottom bar holds before "More".
 *
 * Four, not ten. The pre-Phase-9 bar tried to fit every entry across 390px
 * and produced labels reading `H…`, `Cli…`, `B…`. Only the borrower portal
 * renders a bar now, and it has two entries, but the rule is kept because the
 * portal is the thing that would break if it were deleted.
 */
export const BOTTOM_BAR_SLOTS = 4;

// ---------------------------------------------------------------------------
// The two standalone rows
// ---------------------------------------------------------------------------

/**
 * The dashboard, pinned above the modules as its own row.
 *
 * Reached often enough that opening a module to find it would be a cost.
 */
export const DASHBOARD_ITEM: NavItem = {
  href: ROUTES.dashboard,
  label: 'Dashboard',
  shortLabel: 'Home',
  icon: LayoutDashboard,
  permission: 'dashboard:view',
  phase: 1,
};

/**
 * Notifications, pinned below the modules as its own row.
 *
 * Standalone for the same reason as the dashboard and a different one
 * besides: the header's bell is how somebody reaches this most of the time,
 * and the row is for the person who wants the history and the filters. It
 * belongs to no module because it is *about* every module.
 *
 * The bell itself is untouched — it holds the five most recent unread, which
 * is what somebody standing at the counter needs.
 */
export const NOTIFICATIONS_ITEM: NavItem = {
  href: ROUTES.notifications,
  label: 'Notifications',
  shortLabel: 'Alerts',
  icon: Bell,
  permission: 'notifications:view',
  phase: 15,
};

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/**
 * Staff navigation, as the business's own modules.
 *
 * `docs/NAVIGATION-MAP.md` records every mapping, and the handful of labels
 * that were asked for and left out because this system has nothing behind
 * them yet.
 */
export const NAV_MODULES: readonly NavModule[] = [
  {
    id: 'clients',
    label: 'Clients',
    icon: Users,
    items: [
      {
        href: ROUTES.clients,
        label: 'Client Register',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}/new`,
        label: 'New Client',
        permission: 'clients:view',
        requires: ['clients:create'],
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=active`,
        label: 'Active Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=inactive`,
        label: 'Inactive Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=suspended`,
        label: 'Suspended Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=blacklisted`,
        label: 'Blacklisted Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        // The audit trail filtered to client records: who changed what, and
        // when. The only history of a client this system keeps.
        href: `${ROUTES.audit}?entity=client`,
        label: 'Client History',
        permission: 'audit:view',
        phase: 2,
      },
    ],
  },
  {
    // Phase 13 reorganised the register around the workflow, and its ten
    // stages are exactly the views this module needs — one query, ten `where`
    // clauses, so no two entries here can disagree about what "in arrears"
    // means.
    id: 'loans',
    label: 'Loan Management',
    icon: Banknote,
    items: [
      {
        href: ROUTES.loans,
        label: 'Loan Register',
        permission: 'loans:view',
        phase: 4,
      },
      {
        href: `${ROUTES.loans}/new`,
        label: 'New Loan Application',
        permission: 'loans:view',
        requires: ['loans:create'],
        phase: 4,
      },
      {
        href: `${ROUTES.loans}?stage=draft`,
        label: 'Draft Applications',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=pending_approval`,
        label: 'Pending Approval',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=approved`,
        label: 'Approved Loans',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=awaiting_disbursement`,
        label: 'Awaiting Disbursement',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=active`,
        label: 'Active Loans',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=grace_period`,
        label: 'Grace Period',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=arrears`,
        label: 'Arrears',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=cleared`,
        label: 'Cleared Loans',
        permission: 'loans:view',
        phase: 13,
      },
      {
        // Two stages, two entries. The workflow distinguishes a decision that
        // went against the applicant from an application they withdrew, and
        // one row cannot point at both.
        href: `${ROUTES.loans}?stage=rejected`,
        label: 'Rejected',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=withdrawn`,
        label: 'Cancelled',
        permission: 'loans:view',
        phase: 13,
      },
      {
        // The product breakdown is a monthly management read; the register's
        // own link to it is `prefetch={false}` for the same reason.
        href: `${ROUTES.loans}/by-product`,
        label: 'Loans by Product',
        permission: 'loans:view',
        phase: 13,
        prefetch: false,
      },
      {
        href: `${ROUTES.audit}?entity=loan`,
        label: 'Loan History',
        permission: 'audit:view',
        phase: 2,
      },
    ],
  },
  {
    id: 'collections',
    label: 'Collections',
    icon: Receipt,
    items: [
      {
        href: `${ROUTES.payments}/new`,
        label: 'Collect Payment',
        permission: 'payments:view',
        requires: ['payments:create'],
        phase: 6,
      },
      {
        href: ROUTES.payments,
        label: 'Payment History',
        permission: 'payments:view',
        phase: 6,
      },
      {
        // `period=today` resolves in the *business* timezone, which is why
        // this points at the report rather than at a hand-built date range on
        // the register.
        href: `${ROUTES.reports}/collections?period=today`,
        label: "Today's Collections",
        permission: 'reports:view_operational',
        requires: ['payments:view'],
        phase: 8,
      },
      {
        href: `${ROUTES.payments}?status=reversed`,
        label: 'Reversals',
        permission: 'payments:view',
        phase: 6,
      },
      {
        href: ROUTES.collectionSummary,
        label: 'Collection Summary',
        permission: 'payments:view',
        phase: 13,
      },
      // The summary reads the register once and sums it five ways, so these
      // are sections of one page rather than four more queries. The by-branch
      // slice belongs to Branch Network, which is the module a reader asking
      // a branch question opens.
      {
        href: `${ROUTES.collectionSummary}?section=method#by-method`,
        label: 'Collections by Payment Method',
        permission: 'payments:view',
        phase: 13,
      },
      {
        href: `${ROUTES.collectionSummary}?section=staff#by-staff`,
        label: 'Collections by Staff',
        permission: 'payments:view',
        phase: 13,
      },
      {
        href: `${ROUTES.collectionSummary}?section=product#by-product`,
        label: 'Collections by Loan Product',
        permission: 'payments:view',
        phase: 13,
      },
    ],
  },
  {
    // Phase 14. `/overdue` is the morning worklist a collections officer
    // opens standing up; `/recovery` is the hub above it, with five views in
    // the URL so the server fetches the one being read. Both are here,
    // because both answer "who is behind and what is being done about it".
    id: 'debt',
    label: 'Debt & Security',
    icon: ShieldAlert,
    items: [
      {
        href: ROUTES.overdue,
        label: 'Overdue Loans',
        permission: 'delinquency:view',
        phase: 7,
      },
      {
        href: ROUTES.recovery,
        label: 'Aging Buckets',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=risk`,
        label: 'Risk Monitoring',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=follow-ups`,
        label: 'Follow-Ups',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=promises`,
        label: 'Promise to Pay',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=security`,
        label: 'Collateral / Security',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        // The register — who stands for whom, for how much, and whether the
        // undertaking still binds. This is the one the brief means by "the
        // main Guarantors Register", and it belongs here: a guarantor is
        // security on a loan.
        href: ROUTES.guarantorRegister,
        label: 'Guarantors',
        permission: 'guarantors:view',
        phase: 14,
        prefetch: false,
      },
      {
        // The people records, where a new guarantor is captured. Distinct
        // from the register above, which is the undertakings.
        href: ROUTES.guarantors,
        label: 'Guarantor Directory',
        permission: 'guarantors:view',
        phase: 3,
      },
      {
        href: `${ROUTES.reports}/guarantors`,
        label: 'Guarantor Exposure',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'guarantors:view'],
        phase: 16,
        prefetch: false,
      },
      {
        // "Arrears Report", not "Arrears": Loan Management already carries
        // the arrears *stage* of the register, and two rows called the same
        // thing is a screen reader reading one name twice.
        href: `${ROUTES.reports}/arrears`,
        label: 'Arrears Report',
        permission: 'reports:view_operational',
        requires: ['delinquency:view'],
        phase: 8,
        prefetch: false,
      },
      {
        href: `${ROUTES.reports}/penalties`,
        label: 'Penalties',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'penalties:view'],
        phase: 8,
        prefetch: false,
      },
      {
        // The recovery file: every call, visit, message, notice and promise
        // recorded against a loan, in the order it happened.
        href: `${ROUTES.reports}/recovery`,
        label: 'Recovery Notes',
        permission: 'reports:view_operational',
        requires: ['recovery:view'],
        phase: 16,
        prefetch: false,
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    icon: Landmark,
    items: [
      {
        href: ROUTES.finance,
        label: 'Cash Position',
        permission: 'ledger:view',
        phase: 11,
      },
      {
        href: ROUTES.transfers,
        label: 'Transfers',
        permission: 'transfers:view',
        phase: 11,
      },
      {
        href: ROUTES.expenses,
        label: 'Expenses',
        permission: 'expenses:view',
        phase: 11,
      },
      {
        href: ROUTES.otherIncome,
        label: 'Other Income',
        permission: 'income:view',
        phase: 11,
      },
      {
        href: ROUTES.reconciliation,
        label: 'Reconciliation',
        permission: 'reconciliation:view',
        phase: 11,
      },
      {
        href: ROUTES.ledger,
        label: 'General Ledger',
        permission: 'ledger:view',
        phase: 11,
      },
      {
        href: `${ROUTES.finance}?section=controls#controls-heading`,
        label: 'Finance Controls',
        permission: 'ledger:view',
        phase: 11,
      },
    ],
  },
  {
    // Phase 16 declared every report once, in `lib/reports/registry.ts`, and
    // grouped them four ways. Those groups are this module's entries: the
    // Centre stays the place a report is chosen, filtered and exported from,
    // and ten report definitions in a rail would be the contents of a module
    // inside its own menu.
    id: 'reports',
    label: 'Reports',
    icon: ChartColumn,
    items: [
      {
        href: ROUTES.reports,
        label: 'Reports Centre',
        permission: 'reports:view_operational',
        phase: 8,
      },
      {
        href: `${ROUTES.reports}?group=money-in`,
        label: 'Collections Reports',
        permission: 'reports:view_operational',
        requires: ['payments:view'],
        phase: 16,
      },
      {
        href: `${ROUTES.reports}?group=behind`,
        label: 'Arrears & Risk Reports',
        permission: 'reports:view_operational',
        requires: ['delinquency:view'],
        phase: 16,
      },
      {
        href: `${ROUTES.reports}?group=book`,
        label: 'Loan & Client Reports',
        permission: 'reports:view_operational',
        requires: ['clients:view'],
        phase: 16,
      },
      {
        href: `${ROUTES.reports}?group=security`,
        label: 'Security & Guarantee Reports',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'guarantors:view'],
        phase: 16,
      },
    ],
  },
  {
    // A cross-cutting module, and openly so. Phase 9 has no standalone
    // branch screen: a branch is a dimension of the cash position, of the
    // collection summary, of the aging report and of the portfolio at risk,
    // and it is configured on the settings page. So this module is four deep
    // links into the places a branch question is actually answered, rather
    // than four new screens that would each re-derive somebody else's
    // figures.
    id: 'branches',
    label: 'Branch Network',
    icon: Network,
    items: [
      {
        href: `${ROUTES.settings}?section=branches#branches-heading`,
        label: 'Branches',
        permission: 'settings:view',
        phase: 12,
      },
      {
        href: `${ROUTES.finance}?section=cash#cash-position-heading`,
        label: 'Branch Cash Position',
        permission: 'ledger:view',
        phase: 11,
      },
      {
        href: `${ROUTES.collectionSummary}?section=branch#by-branch`,
        label: 'Branch Performance',
        permission: 'payments:view',
        phase: 13,
      },
      {
        // The aging report carries a branch column and a branch filter, and
        // is the per-branch view of the live book.
        href: `${ROUTES.reports}/aging`,
        label: 'Branch Portfolio',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'delinquency:view'],
        phase: 16,
        prefetch: false,
      },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    icon: Settings,
    items: [
      {
        href: ROUTES.users,
        label: 'Users',
        permission: 'users:view',
        phase: 2,
      },
      {
        // Beside Settings rather than inside it: a Secretary/Treasurer holds
        // `products:view` and no `settings:view` at all.
        href: ROUTES.loanProducts,
        label: 'Loan Products',
        permission: 'products:view',
        phase: 12,
      },
      // The settings subjects are sections of one page. Each entry carries
      // the section twice: as `?section=`, which is what the rail highlights
      // on and what opens the page's chip row at the right section, and as a
      // fragment, which moves the browser with no JavaScript at all.
      // "Branches" is in Branch Network, where a reader looks for it.
      {
        href: ROUTES.settings,
        label: 'Company Settings',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=lending#rules-heading`,
        label: 'Lending Rules',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=guarantors#guarantors-heading`,
        label: 'Guarantor Rules',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=finance#finance-heading`,
        label: 'Finance Settings',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=references#references-heading`,
        label: 'Reference Numbers',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: ROUTES.audit,
        label: 'Audit Trail',
        permission: 'audit:view',
        phase: 2,
      },
      {
        href: ROUTES.account,
        label: 'My Account',
        permission: 'account:view',
        phase: 2,
      },
    ],
  },
];

/** Every staff destination, flat: the two pinned rows plus every module. */
export const NAV_ITEMS: readonly NavItem[] = [
  DASHBOARD_ITEM,
  ...NAV_MODULES.flatMap((module) => module.items),
  NOTIFICATIONS_ITEM,
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
    bottomBarRank: 1,
  },
  {
    href: ROUTES.account,
    label: 'My account',
    shortLabel: 'Me',
    icon: UserCircle,
    permission: 'account:view',
    phase: 2,
    bottomBarRank: 2,
  },
];

// ---------------------------------------------------------------------------
// Splitting an href
// ---------------------------------------------------------------------------

/** The path part of a nav href, without its query string or fragment. */
export function navPath(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * The query parameters a nav href pins, as pairs.
 *
 * Pairs rather than a `URLSearchParams`, because what every caller wants is
 * "how many does it pin" and "do they all match", and both are one line over
 * an array.
 */
export function navQuery(href: string): readonly (readonly [string, string])[] {
  const start = href.indexOf('?');
  if (start === -1) return [];
  const end = href.indexOf('#', start);
  const query = href.slice(start + 1, end === -1 ? undefined : end);
  return [...new URLSearchParams(query).entries()];
}

// ---------------------------------------------------------------------------
// Capability filtering
// ---------------------------------------------------------------------------

/**
 * May this set of capabilities reach this destination?
 *
 * The route's own capability *and* anything the page guards on top of it. A
 * Secretary/Treasurer holds `reports:view_operational`, so the reporting
 * prefix is open to them, but the late-payment charges report guards
 * `reports:view_financial` — an entry for it would be an entry that refuses
 * them.
 */
export function canReachNavItem(
  item: NavItem,
  permissions: readonly Permission[],
): boolean {
  if (!permissions.includes(item.permission)) return false;
  return (item.requires ?? []).every((permission) => permissions.includes(permission));
}

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
  return items.filter((item) => canReachNavItem(item, permissions));
}

/**
 * The modules this person may see, each with the entries they may reach.
 *
 * A module that filtered down to nothing is dropped, so a Secretary never
 * meets an "Administration" header that opens onto an empty list.
 */
export function visibleNavModules(
  permissions: readonly Permission[],
): readonly NavModule[] {
  return NAV_MODULES.map((module) => ({
    ...module,
    items: visibleNavItems(module.items, permissions),
  })).filter((module) => module.items.length > 0);
}

// ---------------------------------------------------------------------------
// Which entry is the page being viewed
// ---------------------------------------------------------------------------

/**
 * Could this entry be the page currently open?
 *
 * Two conditions. The path has to match — exactly, or as the parent of the
 * open subtree, so a loan's detail page keeps the loan register lit. And
 * every parameter the entry pins has to be present and equal in the URL, so
 * `/loans?stage=draft` is not lit by a visit to `/loans`.
 *
 * The dashboard lives at `/`, which prefixes everything, so it matches
 * exactly and nothing else.
 */
export function isNavItemActive(
  href: string,
  pathname: string,
  params?: URLSearchParams | null,
): boolean {
  const path = navPath(href);

  const pathMatches =
    path === ROUTES.dashboard
      ? pathname === ROUTES.dashboard
      : pathname === path || pathname.startsWith(`${path}/`);

  if (!pathMatches) return false;

  return navQuery(href).every(([key, value]) => params?.get(key) === value);
}

/**
 * The one entry that is the page being viewed, or `null`.
 *
 * Several entries can match at once — `/loans`, `/loans?stage=active` and
 * `/loans/{id}` all live under the same prefix — and a rail that lit two of
 * them would be telling the reader they are in two places. The most specific
 * match wins: the longest path first, then the most pinned parameters.
 */
export function currentNavItem(
  items: readonly NavItem[],
  pathname: string,
  params?: URLSearchParams | null,
): NavItem | null {
  const matches = items.filter((item) => isNavItemActive(item.href, pathname, params));
  if (matches.length === 0) return null;

  return matches.reduce((best, item) => {
    const bestPath = navPath(best.href).length;
    const itemPath = navPath(item.href).length;
    if (itemPath !== bestPath) return itemPath > bestPath ? item : best;
    return navQuery(item.href).length > navQuery(best.href).length ? item : best;
  });
}

/**
 * The module holding the page being viewed, or `null` for the two pinned
 * rows.
 *
 * What the rail auto-expands on arrival: navigating to Expenses opens
 * Finance, and opening a promise register opens Debt & Security, without the
 * reader hunting for where they are.
 */
export function currentNavModuleId(
  modules: readonly NavModule[],
  pathname: string,
  params?: URLSearchParams | null,
): NavModuleId | null {
  const current = currentNavItem(
    modules.flatMap((module) => module.items),
    pathname,
    params,
  );
  if (current === null) return null;

  return (
    modules.find((module) => module.items.some((item) => item.href === current.href))
      ?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// The borrower portal's bottom bar
// ---------------------------------------------------------------------------

/**
 * The entries a bottom bar shows, and the ones behind "More".
 *
 * The bar takes the four highest-ranked destinations this person can reach,
 * in rank order; everything else they can reach goes to the overflow. Both
 * lists come from the same capability filter, so a destination cannot appear
 * in one and be missing from the other.
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

  const rest = visible.filter((item) => !ranked.includes(item));

  if (visible.length <= BOTTOM_BAR_SLOTS + 1) {
    return { bar: visible, overflow: [] };
  }

  const bar = ranked.slice(0, BOTTOM_BAR_SLOTS);
  const overflow = [...ranked.slice(BOTTOM_BAR_SLOTS), ...rest];

  return { bar, overflow };
}
