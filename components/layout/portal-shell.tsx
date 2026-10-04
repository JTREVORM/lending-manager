import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AuthContext } from '@/lib/auth/context';
import { getCompanyBranding } from '@/lib/data/company';
import { SignOutButton } from './sign-out-button';
import { PORTAL_NAV_ITEMS } from './nav-items';
import { PrimaryNav } from './primary-nav';

/**
 * The client portal shell.
 *
 * Structurally separate from the staff shell rather than a variant of it. A
 * borrower and a cashier see different systems, and keeping the two shells
 * apart means a staff-only menu entry cannot leak into a borrower's view
 * through a shared component gaining a new item.
 *
 * Deliberately simple: a borrower checks a balance on a phone, usually in a
 * hurry, and does not need a sidebar.
 */
export async function PortalShell({
  context,
  children,
}: {
  readonly context: AuthContext;
  readonly children: ReactNode;
}) {
  const { branding } = await getCompanyBranding();

  return (
    <div className="min-h-dvh">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <header className="border-border bg-surface sticky top-0 z-20 border-b print:hidden">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-4 py-3">
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
          <div className="shrink-0">
            <SignOutButton className="w-auto px-2" />
          </div>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl px-4 py-5 pb-24 sm:px-6"
      >
        {children}
      </main>

      <nav
        aria-label="Main navigation"
        className="border-border bg-surface fixed inset-x-0 bottom-0 z-20 flex gap-0.5 border-t px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] print:hidden"
      >
        <PrimaryNav
          variant="bottom-bar"
          items={PORTAL_NAV_ITEMS}
          permissions={context.permissions}
        />
      </nav>
    </div>
  );
}
