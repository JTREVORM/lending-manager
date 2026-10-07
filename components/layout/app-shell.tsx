import { CalendarDays, LogOut, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { AuthContext } from '@/lib/auth/context';
import { APP_SHORT_NAME, ROUTES } from '@/config/app';
import { getCompanyBranding } from '@/lib/data/company';
import { ROLES, effectiveRole } from '@/lib/permissions';
import { SignOutButton } from './sign-out-button';
import { PrimaryNav } from './primary-nav';
import { SidebarToggle } from './sidebar-toggle';

/**
 * The authenticated staff shell, rebuilt as the reference project's frame.
 *
 * ## Structure, measured off the reference
 *
 *   - **Sidebar** — `w-64` (256px), `fixed inset-y-0 left-0 z-40`, the
 *     `.sidebar-gradient` navy wash (`#0b4394 → #0d478f 45% → #072f6b`),
 *     `shadow-2xl` and a `border-r` in deep blue. Three bands: a brand block
 *     on `#083475`, a role strip on `#06295E`, the scrolling accordion menu,
 *     and the signed-in person on `#06295E` at the foot. Off-canvas below
 *     `md` (`-translate-x-full` → `translate-x-0`, 300ms ease-in-out) behind
 *     a `bg-slate-900/50 backdrop-blur-xs` scrim at `z-25`.
 *   - **Header** — `h-16` (64px), `fixed top-0 right-0 left-0 md:left-64
 *     z-20`, solid white with a `border-b border-slate-200` and `shadow-xs`.
 *     Not glass: the reference's header is white, because the dense figures
 *     below it have to be read against something still.
 *     Desktop carries the business-day card, a "Live Server" pulse, the
 *     signed-in person and the icon actions; below `md` it collapses to the
 *     compact icon bar the reference uses, with the menu button in it.
 *   - **Main** — `md:ml-64 pt-16 sm:pt-20` with the reference's
 *     `px-3 sm:px-4 md:px-6 lg:px-8` gutters, on the `.app-shell` tint.
 *
 * ## Role awareness
 *
 * The session is resolved once in the layout and passed down, so the shell
 * makes no database call of its own and the navigation, the role badge and the
 * route guard all read the same resolved context. Capability-driven visibility
 * lives in `PrimaryNav`.
 *
 * ## The business day
 *
 * The reference's header opens with a bordered card reading
 * "Business Day : <date> (<status>)" above a branch selector, backed by an
 * open/close workflow and its own tables. This application has no such
 * workflow and none is invented here: the card keeps the reference's exact
 * shape and states the real date in the lending timezone. The structure, not
 * fake functionality.
 */
export async function AppShell({
  context,
  children,
}: {
  readonly context: AuthContext;
  readonly children: ReactNode;
}) {
  const { branding } = await getCompanyBranding();

  const role = effectiveRole(context.roles);
  const roleLabel = role === null ? 'No role' : ROLES[role].label;
  const initials = toInitials(context.fullName);

  const businessDate = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Africa/Kampala',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  return (
    // `SidebarToggle` is a client island that owns one boolean: whether the
    // off-canvas rail is open. It renders the menu button, the scrim and the
    // `<aside>` wrapper, so the shell around it — and the navigation inside
    // it — stay server components.
    <SidebarToggle
      className="app-shell selection:bg-accent flex min-h-dvh overflow-x-hidden selection:text-white"
      sidebar={
        <>
          {/* --- Brand block (#083475) ------------------------------- */}
          <div className="bg-sidebar-raised flex items-center gap-3 border-b border-blue-800/80 p-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded bg-white p-1 shadow-sm">
              <ShieldCheck aria-hidden="true" className="text-accent size-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-start justify-between gap-2">
                {/*
                  Two lines, not one with an ellipsis. The reference's own
                  mark is the single word "CHETU", so a `truncate` costs it
                  nothing; a real company name is "Kyanja Credit Services",
                  which truncates to "KYANJA CREDIT SE…" — the brand block
                  is the one place in the product that must never abbreviate
                  the business's own name. `tracking-wide` rather than
                  `tracking-wider` buys back most of the width.
                */}
                <span className="line-clamp-2 text-xs leading-tight font-black tracking-wide uppercase">
                  {branding.companyName}
                </span>
                {/* The reference's version chip: amber on near-black. */}
                <span className="bg-accent-2 text-brand-900 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-extrabold uppercase">
                  v1
                </span>
              </span>
              <span className="text-sidebar-muted mt-0.5 block truncate text-[10px] font-bold tracking-widest uppercase">
                {APP_SHORT_NAME}
              </span>
            </span>
          </div>

          {/* --- Role strip (#06295E) -------------------------------- */}
          <div className="bg-sidebar-deep flex items-center justify-between border-b border-blue-800/60 px-3.5 py-2">
            <span className="flex items-center gap-2">
              {/* The reference pulses this dot for an administrator and holds
                  it steady for everyone else. */}
              <span
                aria-hidden="true"
                className="bg-accent-2 size-2.5 rounded-full motion-safe:animate-pulse"
              />
              <span className="text-xs font-bold text-blue-100">{roleLabel}</span>
            </span>
          </div>

          {/* --- The menu ------------------------------------------- */}
          <PrimaryNav variant="sidebar" menu="staff" permissions={context.permissions} />

          {/* --- The signed-in person (#06295E) --------------------- */}
          <div className="bg-sidebar-deep border-t border-blue-800/80 p-2.5">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-800/80 bg-blue-950/60 p-2">
              <Link
                href={ROUTES.account}
                title="My account"
                className="flex min-w-0 items-center gap-2 transition-opacity hover:opacity-80"
              >
                {/* The reference rings the avatar in amber. */}
                <span className="bg-sidebar-raised ring-accent-2 flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ring-2">
                  {initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-bold text-white">
                    {context.fullName}
                  </span>
                  <span className="text-sidebar-muted block truncate text-[9px]">
                    {roleLabel}
                  </span>
                </span>
              </Link>

              <SignOutButton
                variant="on-dark"
                className="text-sidebar-muted w-auto shrink-0 rounded p-1.5 hover:bg-red-500/20 hover:text-red-300"
                icon={<LogOut aria-hidden="true" className="size-4" />}
                iconOnly
              />
            </div>
          </div>
        </>
      }
      header={
        <>
          {/* --- Desktop bar ---------------------------------------- */}
          <div className="hidden min-w-0 flex-1 items-center gap-4 md:flex">
            {/* The business-day card. */}
            <div className="border-border bg-surface flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-1.5">
              <CalendarDays aria-hidden="true" className="text-text size-5 shrink-0" />
              <span className="min-w-0 leading-tight">
                <span className="text-text block text-[12px] font-bold whitespace-nowrap">
                  Business Day : {businessDate}
                </span>
                <span className="text-text-muted block truncate text-[11px]">
                  {branding.companyName}
                </span>
              </span>
            </div>

            <div className="min-w-0 flex-1" />

            {/* Live status — the pulse doubles as proof the session is
                alive. */}
            <span className="hidden shrink-0 items-center gap-2 lg:flex">
              <span aria-hidden="true" className="relative flex size-2.5">
                <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
              </span>
              <span className="text-success text-[15px] font-black">Live</span>
            </span>

            {/* Who is signed in. */}
            <Link
              href={ROUTES.account}
              title="My account"
              className="hover:bg-surface-hover hidden shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 leading-tight transition-colors lg:flex"
            >
              <span className="bg-accent text-accent-contrast flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold">
                {initials}
              </span>
              <span className="max-w-40 text-right">
                <span className="text-text block truncate text-[12px] font-bold">
                  {context.fullName}
                </span>
                <span className="text-text-muted block truncate text-[11px]">
                  ({roleLabel})
                </span>
              </span>
            </Link>

            {/* Actions — only the symbols this system actually has. */}
            <Link
              href={ROUTES.clients}
              title="Search clients and loans"
              className="text-text-muted hover:bg-surface-hover hover:text-text shrink-0 rounded-lg p-1.5 transition-colors"
            >
              <Search aria-hidden="true" className="size-5" />
              <span className="sr-only">Search clients and loans</span>
            </Link>

            <Link
              href={ROUTES.overdue}
              title="Overdue loans"
              className="text-danger hover:bg-danger-surface shrink-0 rounded-full p-1 transition-colors"
            >
              <RefreshCw aria-hidden="true" className="size-5" strokeWidth={2.5} />
              <span className="sr-only">Overdue loans</span>
            </Link>

            {/*
              No sign-out here.

              The reference carries one in both its header and its sidebar
              foot, and on a wide screen both are on show at once. This shell
              keeps the one in the sidebar foot, directly under the name of
              the person it signs out, and leaves the header to search and
              arrears. Two identical controls for one irreversible action is
              redundancy, not emphasis — and the phone header keeps its own,
              because there the rail is off-canvas.
            */}
          </div>

          {/* --- Mobile icon bar ----------------------------------- */}
          {/* The reference's phone header: the business day on the left, then
              a tight row of 24px symbols. The menu button itself is rendered
              by `SidebarToggle`, which owns the open state. */}
          <div className="flex w-full items-center justify-between md:hidden">
            <span className="text-text flex items-center gap-1.5">
              <CalendarDays aria-hidden="true" className="size-6 shrink-0" />
              <span className="text-[11px] leading-tight font-bold">{businessDate}</span>
            </span>

            <span className="flex items-center gap-2.5">
              <Link href={ROUTES.account} className="text-text p-1" title="My account">
                <ShieldCheck aria-hidden="true" className="size-6" />
                <span className="sr-only">My account</span>
              </Link>
              <Link
                href={ROUTES.overdue}
                className="text-danger p-1"
                title="Overdue loans"
              >
                <RefreshCw aria-hidden="true" className="size-6" />
                <span className="sr-only">Overdue loans</span>
              </Link>
              <SignOutButton
                className="w-auto p-1"
                icon={<LogOut aria-hidden="true" className="size-6" />}
                iconOnly
              />
            </span>
          </div>
        </>
      }
      bottomBar={
        <PrimaryNav
          variant="bottom-bar"
          menu="staff"
          permissions={context.permissions}
          sheetFooter={<SignOutButton />}
        />
      }
    >
      {children}
    </SidebarToggle>
  );
}

/** First letters of the first and last name — the avatar fallback. */
function toInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
