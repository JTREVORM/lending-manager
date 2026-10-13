'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Ellipsis, LayoutDashboard, X } from 'lucide-react';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';

import { LinkPending } from '@/components/ui/link-pending';
import { cn } from '@/lib/utils/cn';
import type { Permission } from '@/lib/permissions';
import {
  DASHBOARD_ITEM,
  NAV_MODULES,
  NOTIFICATIONS_ITEM,
  PORTAL_NAV_ITEMS,
  canReachNavItem,
  currentNavItem,
  currentNavModuleId,
  isNavItemActive,
  splitForBottomBar,
  type NavItem,
  type NavModule,
  type NavModuleId,
} from './nav-items';

export interface PrimaryNavProps {
  readonly variant: 'sidebar' | 'bottom-bar';
  /**
   * Which menu to render: the staff shell's or the borrower portal's.
   *
   * A name, not the items themselves. The entries carry a Lucide icon, which
   * is a React component, and a component **cannot be passed as a prop from a
   * Server Component to a Client Component** — React Server Components refuse
   * it at render time with "Functions cannot be passed directly to Client
   * Components". So the menu is named here and resolved on this side of the
   * boundary.
   */
  readonly menu: 'staff' | 'portal';
  /** The viewer's capabilities, resolved server-side and passed down. */
  readonly permissions: readonly Permission[];
  /**
   * Rendered at the foot of the "More" sheet — in practice the sign-out
   * control.
   *
   * Passed in as an already-rendered element rather than imported here. Sign
   * out is a Server Action, and a module that reaches one is a module this
   * client component would drag into the browser bundle; keeping it out means
   * the navigation knows about destinations and nothing about the session.
   */
  readonly sheetFooter?: ReactNode;
}

/**
 * The primary navigation: the staff rail, or the portal's bottom bar.
 *
 * `menu` and `permissions` are plain serialisable data passed from the
 * server, which is what lets a Client Component render a server-resolved
 * session. The icons live in the item definitions and are imported **here**,
 * on the client side of the boundary, because a React component cannot cross
 * it: passing the items themselves makes every page render as an error.
 *
 * Filtering here hides entries the viewer cannot use. It is not the
 * protection: the same capability is enforced by the route guard and by Row
 * Level Security, and both would refuse a hand-typed URL.
 *
 * ## The rail is modules, closed
 *
 * Seven modules — Clients, Loan Management, Collections, Debt & Security,
 * Finance, Reports, Administration — with the dashboard pinned above them.
 * Every module starts **closed**, one opens at a time, and the module holding
 * the page being viewed opens by itself.
 *
 * That is the opposite of what this rail used to do, and the reason is the
 * destination count. Four open blocks holding eleven entries was a list you
 * read top to bottom; seven closed modules holding fifty is a map you scan,
 * and fifty rows at once is not navigation. Opening one module closes the
 * last, because two open modules put the thing you want below the fold again.
 *
 * The open module is **not** remembered across navigations: arriving
 * somewhere re-derives it from the URL, so the rail always shows where you
 * are rather than where you last clicked.
 *
 * ## Two breakpoints, deliberately
 *
 * The shell switches the rail from drawer to fixed at `md` (768px). The rows
 * inside it switch from touch-sized to compact at **`lg`** (1024px). They are
 * not the same question. Whether the rail can sit beside the content is about
 * width; whether a row should be 11px type with 6px of padding is about what
 * is pointing at it, and everything between 768px and 1024px is a touch
 * device held at arm's length.
 *
 * ## The bottom bar is the borrower portal's alone
 *
 * The portal has a sticky header and no drawer, so its two destinations sit
 * in a bar within thumb reach below `md`.
 */
export function PrimaryNav({ variant, menu, permissions, sheetFooter }: PrimaryNavProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (variant === 'bottom-bar') {
    const items = menu === 'portal' ? PORTAL_NAV_ITEMS : [DASHBOARD_ITEM];
    const { bar, overflow } = splitForBottomBar(items, permissions);

    return (
      <>
        {bar.map((item) => (
          <BottomBarLink key={item.href} item={item} pathname={pathname} />
        ))}
        {overflow.length > 0 ? (
          <MoreMenu items={overflow} pathname={pathname} footer={sheetFooter} />
        ) : null}
      </>
    );
  }

  if (menu === 'portal') {
    return (
      <div className="scroll-area scroll-y flex min-h-0 flex-1 flex-col gap-1 px-2.5 py-2 text-xs">
        {PORTAL_NAV_ITEMS.filter((item) => canReachNavItem(item, permissions)).map(
          (item) => (
            <SidebarTopLink key={item.href} item={item} pathname={pathname} />
          ),
        )}
      </div>
    );
  }

  return (
    <StaffRail pathname={pathname} params={searchParams} permissions={permissions} />
  );
}

/**
 * The staff rail: the pinned dashboard, then the modules.
 *
 * Its own component because it holds the one piece of state the rail has —
 * which module the reader has opened — and that state is keyed by the page it
 * was opened on, so a navigation resets it rather than freezing yesterday's
 * choice over today's page.
 */
function StaffRail({
  pathname,
  params,
  permissions,
}: {
  readonly pathname: string;
  readonly params: URLSearchParams | null;
  readonly permissions: readonly Permission[];
}) {
  const modules = NAV_MODULES.map((module) => ({
    ...module,
    items: module.items.filter((item) => canReachNavItem(item, permissions)),
  })).filter((module) => module.items.length > 0);

  const dashboard = canReachNavItem(DASHBOARD_ITEM, permissions) ? DASHBOARD_ITEM : null;
  const notifications = canReachNavItem(NOTIFICATIONS_ITEM, permissions)
    ? NOTIFICATIONS_ITEM
    : null;

  // The entry that is the page being viewed — resolved once, over what this
  // person can actually reach, so exactly one row claims it however many
  // prefixes match.
  const current = currentNavItem(
    [
      ...(dashboard === null ? [] : [dashboard]),
      ...modules.flatMap((module) => module.items),
      ...(notifications === null ? [] : [notifications]),
    ],
    pathname,
    params,
  );
  const currentModule = currentNavModuleId(modules, pathname, params);

  /*
    Which module is open, and the page it was opened on.

    Stored together and read back as "opened, and still on that page", the
    same shape the shell uses for its drawer. A changed pathname *is* the
    reader's choice expiring, in the same render that shows the new page —
    which is what makes "navigate to Expenses and Finance is open" true
    without an effect that sets state during render.

    `undefined` for the opened module means "nothing chosen here yet", which
    is distinct from `null`, meaning "closed everything on this page".
  */
  const [opened, setOpened] = useState<{
    readonly module: NavModuleId | null;
    readonly path: string;
  } | null>(null);

  const chosen = opened !== null && opened.path === pathname ? opened.module : undefined;
  const openModule = chosen === undefined ? currentModule : chosen;

  const toggle = (id: NavModuleId): void => {
    setOpened({ module: openModule === id ? null : id, path: pathname });
  };

  return (
    // The menu band: `flex-1 min-h-0 scroll-area scroll-y py-2 px-2.5
    // text-xs`. `min-h-0` is what lets it scroll inside a flex column instead
    // of pushing the user footer off the bottom, and the bands above and
    // below it are `shrink-0` so this is the only part that ever gives.
    <div className="scroll-area scroll-y flex min-h-0 flex-1 flex-col gap-1 px-2.5 py-2 text-xs">
      {dashboard === null ? null : (
        <SidebarTopLink item={dashboard} pathname={pathname} params={params} />
      )}

      {modules.map((module) => (
        <SidebarModule
          key={module.id}
          module={module}
          expanded={openModule === module.id}
          onToggle={() => {
            toggle(module.id);
          }}
          currentHref={current?.href}
        />
      ))}

      {/* Pinned below the modules, for the same reason the dashboard is
          pinned above them: it belongs to no module because it is about
          every module, and the header's bell is how somebody reaches it most
          of the time. */}
      {notifications === null ? null : (
        <SidebarTopLink item={notifications} pathname={pathname} params={params} />
      )}
    </div>
  );
}

/**
 * The pinned dashboard row.
 *
 * Its active state is a solid amber fill with near-black text at
 * `font-black` — the loudest thing in the rail, and the only place amber is
 * used as a background rather than an accent.
 */
function SidebarTopLink({
  item,
  pathname,
  params,
}: {
  readonly item: NavItem;
  readonly pathname: string;
  readonly params?: URLSearchParams | null;
}) {
  const isActive = isNavItemActive(item.href, pathname, params);
  const Icon = item.icon ?? LayoutDashboard;

  return (
    <Link
      href={item.href}
      prefetch={item.prefetch}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-bold transition-all',
        isActive
          ? 'bg-accent-2 text-brand-900 font-black shadow-md'
          : 'text-blue-100 hover:bg-blue-800/60 hover:text-white',
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span>{item.label}</span>
      <LinkPending className="ml-auto" label={`Opening ${item.label}`} />
    </Link>
  );
}

/**
 * One module: an amber header that discloses its destinations.
 *
 * The header is a real `<button>` with `aria-expanded` and `aria-controls`,
 * and the panel it names carries the id — so a screen-reader user hears
 * "Finance, collapsed, button" rather than meeting six links with no
 * explanation of why the other forty are missing. Touch-sized up to `lg`
 * (48px tall at the drawer widths), compact from `lg`, because a thumb and a
 * trackpad are not the same instrument.
 */
function SidebarModule({
  module,
  expanded,
  onToggle,
  currentHref,
}: {
  readonly module: NavModule;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly currentHref?: string;
}) {
  const panelId = useId();
  const Icon = module.icon;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-3 text-left text-[15px] font-bold transition-all lg:py-2 lg:text-xs',
          /*
            The open module's amber `#F5A623` fill.

            Its label takes the near-black the design pairs with amber
            everywhere else — on the active Dashboard link and on the save
            button — which is 8.81:1. White on this amber is 2.03:1, and the
            axe sweep refuses it: this is a navigation label on a screen used
            outdoors in daylight.
          */
          expanded
            ? 'bg-accent-2 text-brand-900 shadow-sm'
            : 'text-white hover:bg-blue-800/60',
        )}
      >
        <span className="flex min-w-0 items-center gap-3 lg:gap-2.5">
          <Icon aria-hidden="true" className="size-4 shrink-0 lg:size-3.5" />
          <span>{module.label}</span>
        </span>
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 lg:size-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 lg:size-3.5" />
        )}
      </button>

      {expanded ? (
        // The sub-tree: indented, with a translucent amber rule down the left
        // edge standing in for the tree's trunk. The children carry no icon
        // of their own — forty glyphs down one rail is the clutter this pass
        // exists to remove, and the module's own icon above them is what
        // names the branch.
        <ul
          id={panelId}
          className="ml-4 flex flex-col gap-0.5 border-l-2 border-amber-500/40 py-1 pr-1 pl-4"
        >
          {module.items.map((item) => (
            <li key={item.href}>
              <SidebarLink item={item} isActive={item.href === currentHref} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SidebarLink({
  item,
  isActive,
}: {
  readonly item: NavItem;
  readonly isActive: boolean;
}) {
  return (
    <Link
      href={item.href}
      prefetch={item.prefetch}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        // 14px and touch-sized up to `lg`, 11px and tight from `lg`, active
        // on a translucent white fill.
        'flex items-center gap-3 rounded-md px-2.5 py-2.5 text-[14px] font-normal transition-all',
        'lg:gap-2 lg:py-1.5 lg:text-[11px] lg:font-medium',
        isActive
          ? 'bg-sidebar-active-surface font-semibold text-white lg:font-bold'
          : 'text-white hover:bg-white/10',
      )}
    >
      <span className="leading-snug">{item.label}</span>
      {/* The application carries no full-page loading spinner — see
          `LinkPending` for why — so the feedback for a tap lives in the thing
          that was tapped. */}
      <LinkPending className="ml-auto" label={`Opening ${item.label}`} />
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
  const Icon = item.icon ?? LayoutDashboard;

  return (
    <Link
      href={item.href}
      prefetch={item.prefetch}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'min-h-touch relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5',
        'text-[0.6875rem] font-medium transition-colors',
        // The active destination is marked twice over: colour, and a bar
        // across the top of the cell. Colour alone fails for a colour-blind
        // reader and in bright daylight, which is where this is used.
        isActive ? 'text-accent font-bold' : 'text-text-muted hover:text-text',
      )}
    >
      {isActive ? (
        <span
          aria-hidden="true"
          className="bg-accent absolute top-0 h-0.5 w-8 rounded-full"
        />
      ) : null}
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      {/* No truncation: with four cells the label fits, and a label that did
          not fit would be a sign the bar is holding too much again. */}
      <span className="w-full text-center">{item.shortLabel ?? item.label}</span>
      {/* Absolutely positioned so an appearing spinner cannot shift the
          label under a finger that is already on its way down. */}
      <LinkPending
        className="absolute right-1 bottom-1"
        label={`Opening ${item.label}`}
      />
    </Link>
  );
}

/**
 * The "More" cell, and the sheet it opens.
 *
 * A native `<dialog>` opened with `showModal()`, which gives focus trapping,
 * Escape-to-close, inertness of the page behind it and a backdrop without a
 * line of focus-management code. A hand-rolled drawer needs all four and
 * usually ships with two.
 */
function MoreMenu({
  items,
  pathname,
  footer,
}: {
  readonly items: readonly NavItem[];
  readonly pathname: string;
  readonly footer?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();

  // Driven imperatively rather than from an effect. `<dialog>` owns its own
  // open state — Escape and the backdrop close it without React being asked —
  // so mirroring that into a state variable and syncing it back in an effect
  // would mean two sources of truth for one boolean. `open` here exists only
  // to report `aria-expanded`, and `onClose` keeps it honest however the
  // dialog was closed.
  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  const openSheet = useCallback(() => {
    dialogRef.current?.showModal();
    setOpen(true);
  }, []);

  const containsCurrent = items.some((item) => isNavItemActive(item.href, pathname));

  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'min-h-touch relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1.5',
          'text-[0.6875rem] font-medium transition-colors',
          containsCurrent ? 'text-accent' : 'text-text-muted hover:text-text',
        )}
      >
        {containsCurrent ? (
          <span
            aria-hidden="true"
            className="bg-accent absolute top-0 h-0.5 w-8 rounded-full"
          />
        ) : null}
        <Ellipsis aria-hidden="true" className="size-5 shrink-0" />
        <span className="w-full text-center">More</span>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onClose={() => {
          setOpen(false);
        }}
        // Clicking the backdrop closes it. The check is on the dialog element
        // itself because the backdrop is not a separate node — a click that
        // lands on the dialog's own box is outside the panel inside it.
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
        className={cn(
          'bg-surface text-text m-0 mt-auto w-full max-w-none rounded-t-xl p-0 shadow-2xl',
          'backdrop:bg-slate-900/50',
        )}
      >
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold">
            More
          </h2>
          <button
            type="button"
            onClick={close}
            className="min-h-touch text-text-muted hover:text-text -mr-2 flex items-center justify-center px-2"
          >
            <X aria-hidden="true" className="size-5" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        <ul className="max-h-[60dvh] overflow-y-auto p-2">
          {items.map((item) => {
            const Icon = item.icon ?? LayoutDashboard;
            const isActive = isNavItemActive(item.href, pathname);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  prefetch={item.prefetch}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={close}
                  className={cn(
                    'min-h-touch flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium',
                    isActive
                      ? 'bg-accent-surface text-accent font-bold'
                      : 'text-text hover:bg-surface-hover',
                  )}
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {footer === undefined ? null : (
          <div className="border-border border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </dialog>
    </>
  );
}
