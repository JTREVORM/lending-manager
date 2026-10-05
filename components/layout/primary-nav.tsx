'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Ellipsis, X } from 'lucide-react';
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

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
      {blocks.map((block) => (
        <div key={block.group}>
          <p className="text-text-muted mb-1 px-3 text-[0.6875rem] font-semibold tracking-wider uppercase">
            {NAV_GROUP_LABELS[block.group]}
          </p>
          <ul className="flex flex-col gap-0.5">
            {block.items.map((item) => (
              <li key={item.href}>
                <SidebarLink item={item} pathname={pathname} />
              </li>
            ))}
          </ul>
        </div>
      ))}
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
        'min-h-touch relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150',
        isActive
          ? 'bg-accent-surface text-accent font-semibold'
          : 'text-text-muted hover:bg-surface-hover hover:text-text',
      )}
    >
      {/* A left indicator bar, so the active destination is marked by shape as
          well as colour — the same belt-and-braces the bottom bar uses. */}
      {isActive ? (
        <span
          aria-hidden="true"
          className="bg-accent absolute top-1/2 left-0 h-5 w-1 -translate-y-1/2 rounded-r-full"
        />
      ) : null}
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <span className="truncate">{item.label}</span>
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
        isActive ? 'text-accent' : 'text-text-muted hover:text-text',
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
        className={cn(
          'bg-surface text-text elevation-5 m-0 mt-auto w-full max-w-none rounded-t-xl p-0',
          'backdrop:bg-black/40',
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
                      ? 'bg-accent-surface text-accent font-semibold'
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
