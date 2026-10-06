import { CalendarDays, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { AuthContext } from '@/lib/auth/context';
import { APP_SHORT_NAME, ROUTES } from '@/config/app';
import { getCompanyBranding } from '@/lib/data/company';
import { ROLES, effectiveRole } from '@/lib/permissions';
import { SignOutButton } from './sign-out-button';
import { PrimaryNav } from './primary-nav';

/**
 * The authenticated staff shell — an enterprise application frame.
 *
 * ## Structure
 *
 *   - **≥ 768px**  a deep-navy fixed sidebar (brand, grouped navigation, the
 *     signed-in person at the foot) plus a glass top header carrying the
 *     business date, a search entry and the current user. A wide working area
 *     sits between them.
 *   - **< 768px**  the Phase 9 phone structure is kept: a compact top header
 *     and a bottom tab bar with four destinations and a More sheet. No attempt
 *     is made to fold the desktop sidebar onto a phone.
 *
 * ## Role awareness
 *
 * The session is resolved once in the layout and passed down, so the shell
 * makes no database call of its own and the navigation, the role badge and the
 * route guard all read the same resolved context. Capability-driven visibility
 * lives in `PrimaryNav`.
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

  // The business date, in the lending timezone. A real figure (today's date),
  // not an invented "business day open/close" workflow this system does not
  // have — the structure of the Chetu header, not fake functionality.
  const businessDate = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Africa/Kampala',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="min-h-dvh">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* --- Desktop sidebar (navy) ----------------------------------- */}
      <nav
        aria-label="Main navigation"
        className="bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-30 hidden w-64 flex-col p-3 md:flex print:hidden"
      >
        <div className="mb-5 flex items-center gap-3 px-2 pt-2">
          <span className="bg-sidebar-active flex size-10 shrink-0 items-center justify-center rounded-lg [box-shadow:0_6px_16px_rgba(0,0,0,0.3)]">
            <ShieldCheck aria-hidden="true" className="size-6 text-[#07233f]" />
          </span>
          <span className="min-w-0">
            <span className="line-clamp-1 block text-sm leading-tight font-semibold">
              {branding.companyName}
            </span>
            <span className="text-sidebar-muted block truncate text-xs">
              {APP_SHORT_NAME}
            </span>
          </span>
        </div>

        <PrimaryNav variant="sidebar" menu="staff" permissions={context.permissions} />

        {/* The signed-in person, at the foot of the shell. */}
        <div className="mt-2 shrink-0 border-t border-white/10 pt-3">
          <div className="flex items-center gap-2.5 px-1">
            <span className="bg-sidebar-raised text-sidebar-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
              {initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {context.fullName}
              </span>
              <span className="text-sidebar-muted block truncate text-xs">
                {roleLabel}
              </span>
            </span>
          </div>
          <div className="mt-2">
            <SignOutButton variant="on-dark" />
          </div>
        </div>
      </nav>

      {/* --- Desktop top header (glass) ------------------------------- */}
      <header className="glass fixed top-0 right-0 left-64 z-20 hidden h-16 items-center gap-4 border-x-0 border-t-0 px-6 md:flex print:hidden">
        <div className="text-text-muted flex min-w-0 items-center gap-2 text-sm">
          <CalendarDays aria-hidden="true" className="text-accent size-4 shrink-0" />
          <span className="truncate font-medium">{businessDate}</span>
        </div>

        <Link
          href={ROUTES.clients}
          className="surface-inset text-text-muted hover:text-text ml-auto flex h-10 w-full max-w-xs items-center gap-2 rounded-md px-3 text-sm transition-colors"
        >
          <Search aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Search clients and loans</span>
        </Link>

        <div className="flex shrink-0 items-center gap-2.5">
          <span className="bg-accent text-accent-contrast flex size-9 items-center justify-center rounded-full text-xs font-semibold">
            {initials}
          </span>
          <span className="min-w-0">
            <span className="text-text block truncate text-sm font-medium">
              {context.fullName}
            </span>
            <span className="text-text-muted block truncate text-xs">{roleLabel}</span>
          </span>
        </div>
      </header>

      {/* --- Mobile header (navy) ------------------------------------- */}
      <header className="bg-sidebar text-sidebar-foreground sticky top-0 z-20 flex items-center gap-2.5 px-4 py-3 md:hidden print:hidden">
        <span className="bg-sidebar-active flex size-8 shrink-0 items-center justify-center rounded-md">
          <ShieldCheck aria-hidden="true" className="size-4 text-[#07233f]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {branding.companyName}
          </span>
          <span className="text-sidebar-muted block truncate text-xs">
            {context.fullName} · {roleLabel}
          </span>
        </span>
        <div className="shrink-0">
          <SignOutButton className="w-auto px-2" variant="on-dark" />
        </div>
      </header>

      {/* --- Main region ---------------------------------------------- */}
      {/* `print:pl-0` matters: the sidebar is hidden when printing, so the
          main region's left padding would otherwise leave a blank margin down
          every printed page. `md:pt-16` clears the fixed top header. */}
      <div className="md:pt-16 md:pl-64 print:pt-0 print:pl-0">
        <main
          id="main-content"
          className="mx-auto w-full max-w-[90rem] px-4 py-5 pb-24 sm:px-6 md:px-8 md:pb-10"
        >
          {children}
        </main>
      </div>

      {/* --- Mobile bottom bar ---------------------------------------- */}
      <nav
        aria-label="Main navigation"
        data-nav="bottom-bar"
        className="glass fixed inset-x-0 bottom-0 z-20 flex gap-0.5 border-x-0 border-b-0 px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden print:hidden"
      >
        <PrimaryNav
          variant="bottom-bar"
          menu="staff"
          permissions={context.permissions}
          sheetFooter={<SignOutButton />}
        />
      </nav>
    </div>
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
