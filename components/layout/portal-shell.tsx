import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AuthContext } from '@/lib/auth/context';
import { getPortalBranding } from '@/lib/data/company';
import { SignOutButton } from './sign-out-button';
import { PortalTopNav } from './portal-top-nav';
import { PrimaryNav } from './primary-nav';

/**
 * The client portal shell.
 *
 * Structurally separate from the staff shell rather than a variant of it. A
 * borrower and a cashier see different systems, and keeping the two shells
 * apart means a staff-only menu entry cannot leak into a borrower's view
 * through a shared component gaining a new item.
 *
 * ## Two layouts, not one layout stretched
 *
 * Before Phase 9 this was the phone layout at every width: a 48rem column
 * centred in a 1440px window, with the fixed bottom tab bar floating over the
 * middle of the content. A borrower checking a balance from an office desktop
 * saw a page that looked unfinished, and the bar covered whatever was behind
 * it.
 *
 *   - **< 768px** — the compact layout it always had: a sticky header and a
 *     bottom bar in thumb reach.
 *   - **≥ 768px** — a horizontal top navigation in the header, a wider
 *     content column, and no bottom bar at all. The page is laid out for the
 *     screen it is on.
 */
export async function PortalShell({
  context,
  children,
}: {
  readonly context: AuthContext;
  readonly children: ReactNode;
}) {
  const branding = await getPortalBranding();

  return (
    <div className="min-h-dvh">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <header className="border-border bg-surface sticky top-0 z-20 border-b print:hidden">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2.5 px-4 py-3 sm:px-6">
          <span className="bg-brand-600 flex size-8 shrink-0 items-center justify-center rounded-lg">
            <ShieldCheck aria-hidden="true" className="size-4 text-white" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {branding.companyName}
            </span>
            <span className="text-text-muted block truncate text-xs">
              {context.fullName}
            </span>
          </span>

          {/* Desktop: the two destinations sit in the header, so the bottom
              bar can be dropped entirely rather than floated over content. */}
          <div className="hidden md:block">
            <PortalTopNav permissions={context.permissions} />
          </div>

          <div className="shrink-0">
            <SignOutButton className="w-auto px-2" />
          </div>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl px-4 py-5 pb-24 sm:px-6 md:pb-10"
      >
        {children}
      </main>

      <nav
        aria-label="Main navigation"
        // Named so a test can ask about the bar itself rather than about
        // "whichever nav contains the More button" — the More sheet holds the
        // overflow destinations and lives inside this element, so matching on
        // its contents finds every link, not the four in the bar.
        data-nav="bottom-bar"
        className="border-border bg-surface fixed inset-x-0 bottom-0 z-20 flex gap-0.5 border-t px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden print:hidden"
      >
        <PrimaryNav
          variant="bottom-bar"
          menu="portal"
          permissions={context.permissions}
          sheetFooter={<SignOutButton />}
        />
      </nav>
    </div>
  );
}
