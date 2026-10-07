'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronRight, Ellipsis, LayoutDashboard, X } from 'lucide-react';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';

import { ROUTES } from '@/config/app';
import { LinkPending } from '@/components/ui/link-pending';
import { cn } from '@/lib/utils/cn';
import type { Permission } from '@/lib/permissions';
import {
  NAV_GROUP_LABELS,
  NAV_ITEMS,
  PORTAL_NAV_ITEMS,
  groupedNavItems,
  splitForBottomBar,
  type NavItem,
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
   * An element crosses the server/client boundary cleanly — a component would
   * not, which is the whole reason `menu` is a name rather than a list.
   */
  readonly sheetFooter?: ReactNode;
}

/**
 * The primary navigation, as a grouped sidebar or a phone bottom bar.
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
 * ## Why the two variants are shaped so differently
 *
 * The sidebar has room for every destination, so it shows every destination,
 * grouped into Operations / Insights / Administration — eleven flat rows is a
 * list you read, three short blocks is a map you scan.
 *
 * The bottom bar has 390px. It shows four destinations and a "More" button
 * that opens the rest in a sheet. The previous design put all eleven in the
 * bar and let the labels truncate, which produced `H…`, `Cli…`, `B…` — a
 * navigation you cannot read is not navigation.
 */
export function PrimaryNav({ variant, menu, permissions, sheetFooter }: PrimaryNavProps) {
  const pathname = usePathname();
  const items = menu === 'portal' ? PORTAL_NAV_ITEMS : NAV_ITEMS;

  if (variant === 'bottom-bar') {
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

  const blocks = groupedNavItems(items, permissions);

  // The dashboard is pinned above the accordion as its own row, which is what
  // the reference does: it is the one destination you reach often enough that
  // opening a group to find it would be a cost.
  const dashboard = items.find(
    (item) => item.href === ROUTES.dashboard && permissions.includes(item.permission),
  );
  const groups = blocks
    .map((block) => ({
      ...block,
      items: block.items.filter((item) => item.href !== ROUTES.dashboard),
    }))
    .filter((block) => block.items.length > 0);

  return (
    // The reference's menu band: `flex-1 min-h-0 scroll-area scroll-y py-2
    // px-2.5 space-y-1.5 text-xs`. `min-h-0` is what lets it scroll inside a
    // flex column instead of pushing the user footer off the bottom.
    <div className="scroll-area scroll-y flex min-h-0 flex-1 flex-col gap-1.5 px-2.5 py-2 text-xs">
      {dashboard === undefined ? null : (
        <SidebarTopLink item={dashboard} pathname={pathname} />
      )}

      {groups.map((block) => (
        <SidebarGroup
          key={block.group}
          label={NAV_GROUP_LABELS[block.group]}
          items={block.items}
          pathname={pathname}
        />
      ))}
    </div>
  );
}

/**
 * The pinned dashboard row.
 *
 * The reference's active state for it is a solid amber fill with near-black
 * text at `font-black` — the loudest thing in the rail, and the only place
 * amber is used as a background rather than an accent.
 */
function SidebarTopLink({
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
 * One accordion group.
 *
 * ## Why an accordion rather than the flat labelled blocks
 *
 * The reference's rail is thirteen collapsed groups, each opening onto its own
 * sub-tree. That shape is the design, and it is not arbitrary: a rail that
 * shows every destination at once is a list you read top to bottom, while a
 * rail of closed groups is a map you scan. This application has eleven
 * destinations in three groups, so the groups are the three it already has —
 * Operations, Insights, Administration — and the capability filter still
 * decides what appears inside them.
 *
 * ## The open state
 *
 * A group starts open when it contains the page being viewed, so arriving on
 * a screen never hides where you are. After that it is the reader's to
 * control, and the state is intentionally *not* persisted: the reference does
 * not persist it either, and a rail that remembers a group you opened once a
 * week is a rail that is always half open.
 *
 * The header is a real `<button>` with `aria-expanded` and `aria-controls`,
 * and the panel it names carries the id — so a screen-reader user hears
 * "Operations, collapsed, button" rather than meeting four links with no
 * explanation of why the other nine are missing.
 */
function SidebarGroup({
  label,
  items,
  pathname,
}: {
  readonly label: string;
  readonly items: readonly NavItem[];
  readonly pathname: string;
}) {
  const panelId = useId();
  const containsCurrent = items.some((item) => isNavItemActive(item.href, pathname));
  const [isOpen, setIsOpen] = useState(containsCurrent);

  // The group holding the current page is open whenever it holds it, even if
  // the reader collapsed it before navigating into it — otherwise a link in a
  // collapsed group navigates to a screen whose own menu entry is hidden.
  const expanded = isOpen || containsCurrent;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={cn(
          'flex w-full items-center justify-between rounded-lg px-3 py-3 text-left text-[15px] font-bold transition-all md:py-2 md:text-xs',
          /*
            The reference's active/open group: the amber `#F5A623` fill.

            Its own label on that fill is white, which is 2.03:1 — the axe
            sweep refuses it, and rightly: this is a navigation label on a
            screen used outdoors in daylight. The amber is kept, because it is
            the single most recognisable thing about the rail; the label takes
            the near-black the reference itself pairs with amber everywhere
            else, on its active Dashboard link (`bg-amber-500 text-blue-950`)
            and on its save button (`#fbbf24` on `#0f172a`). That is 8.81:1,
            and it is the reference's own pairing rather than a substitution.
          */
          expanded
            ? 'bg-accent-2 text-brand-900 shadow-sm'
            : 'text-white hover:bg-blue-800/60',
        )}
      >
        <span className="flex items-center gap-3 md:gap-2.5">{label}</span>
        {expanded ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 md:size-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 md:size-3.5" />
        )}
      </button>

      {expanded ? (
        // The reference's sub-tree: indented, with a translucent amber rule
        // down the left edge standing in for the tree's trunk.
        <ul
          id={panelId}
          className="ml-4 flex flex-col gap-0.5 border-l-2 border-amber-500/40 py-1 pr-1 pl-4"
        >
          {items.map((item) => (
            <li key={item.href}>
              <SidebarLink item={item} pathname={pathname} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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
        // The reference's sub-item: 14px touch-sized on a phone, 11px and
        // tight on the desktop, active on a translucent white fill.
        'flex items-center gap-3 rounded-md px-2.5 py-2.5 text-[14px] font-normal transition-all',
        'md:gap-2 md:py-1.5 md:text-[11px] md:font-medium',
        isActive
          ? 'bg-sidebar-active-surface font-semibold text-white md:font-bold'
          : 'text-white hover:bg-white/10',
      )}
    >
      {/* Amber on the desktop, plain white on a phone — the reference tints
          the tree's leaf icons to match the trunk rule beside them, and drops
          the tint at the larger mobile size where it would read as disabled. */}
      <Icon
        aria-hidden="true"
        className="size-[18px] shrink-0 text-white/90 md:size-3 md:text-amber-300"
      />
      <span className="leading-snug md:truncate">{item.label}</span>
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
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
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
      <span className="w-full text-center">{item.shortLabel}</span>
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
        // The reference's modal shell: a white panel with its own bordered
        // header, `shadow-2xl`, over a `slate-900/50` backdrop.
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
            const Icon = item.icon;
            const isActive = isNavItemActive(item.href, pathname);

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
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
