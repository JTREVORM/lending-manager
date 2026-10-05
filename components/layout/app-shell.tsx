import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AuthContext } from '@/lib/auth/context';
import { getCompanyBranding } from '@/lib/data/company';
import { ROLES, effectiveRole } from '@/lib/permissions';
import { SignOutButton } from './sign-out-button';
import { PrimaryNav } from './primary-nav';

/**
 * The authenticated staff shell.
 *
 * ## Responsive strategy
 *
 * Mobile-first, because staff work from phones at a counter:
 *
 *   - **< 768px**  a fixed bottom tab bar, within thumb reach, and a header
 *     carrying the company name and a sign-out control.
 *   - **≥ 768px**  a persistent left sidebar. No hamburger, no drawer: a menu
 *     that is always visible is one fewer thing to teach, and a drawer needs
 *     focus trapping, an escape handler and a scroll lock to be accessible.
 *
 * ## Role awareness
 *
 * The session is resolved once in the layout and passed down, so the shell
 * makes no database call of its own and the navigation, the role badge and the
 * route guard all read the same resolved context.
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

  return (
    <div className="min-h-dvh">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* --- Desktop sidebar ------------------------------------------- */}
      <nav
        aria-label="Main navigation"
        className="border-border bg-surface fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r p-3 md:flex print:hidden"
      >
        <div className="mb-5 flex items-center gap-2.5 px-2 pt-2">
          <span className="bg-brand-600 flex size-9 shrink-0 items-center justify-center rounded-lg">
            <ShieldCheck aria-hidden="true" className="size-5 text-white" />
          </span>
          <span className="min-w-0">
            {/* The company's name and the signed-in person's role. The
                delivery phase used to sit here; a build label is for a
                changelog, not for the chrome a cashier looks at all day. */}
            <span className="line-clamp-2 block text-sm leading-snug font-semibold">
              {branding.companyName}
            </span>
            <span className="text-text-muted block truncate text-xs">{roleLabel}</span>
          </span>
        </div>

        <PrimaryNav variant="sidebar" menu="staff" permissions={context.permissions} />

        <div className="border-border mt-2 shrink-0 border-t pt-2">
          <p className="truncate px-3 pt-1 text-sm font-medium">{context.fullName}</p>
          <p className="text-text-muted mb-1 truncate px-3 text-xs">{roleLabel}</p>
          <SignOutButton />
        </div>
      </nav>

      {/* --- Mobile header -------------------------------------------- */}
      <header className="border-border bg-surface sticky top-0 z-20 flex items-center gap-2.5 border-b px-4 py-3 md:hidden print:hidden">
        <span className="bg-brand-600 flex size-8 shrink-0 items-center justify-center rounded-lg">
          <ShieldCheck aria-hidden="true" className="size-4 text-white" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {branding.companyName}
          </span>
          <span className="text-text-muted block truncate text-xs">
            {context.fullName} · {roleLabel}
          </span>
        </span>
        <div className="shrink-0">
          <SignOutButton className="w-auto px-2" />
        </div>
      </header>

      {/* --- Main region ---------------------------------------------- */}
      {/* `print:pl-0` matters: the sidebar is hidden when printing, so the
          main region's left padding would otherwise leave a 15rem blank
          margin down every printed page. */}
      <div className="md:pl-60 print:pl-0">
        <main
          id="main-content"
          className="mx-auto w-full max-w-5xl px-4 py-5 pb-24 sm:px-6 md:pb-10"
        >
          {children}
        </main>
      </div>

      {/* --- Mobile bottom bar ---------------------------------------- */}
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
          menu="staff"
          permissions={context.permissions}
          sheetFooter={<SignOutButton />}
        />
      </nav>
    </div>
  );
}
