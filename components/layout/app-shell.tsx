import { ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { APP_SHORT_NAME, CURRENT_PHASE } from '@/config/app';
import { getCompanyBranding } from '@/lib/data/company';
import { PrimaryNav } from './primary-nav';

/**
 * The authenticated application shell.
 *
 * ## Responsive strategy
 *
 * Mobile-first, because staff work from phones at a counter:
 *
 *   - **< 768px**  a fixed bottom tab bar, within thumb reach. The main region
 *     carries bottom padding so the bar never covers content.
 *   - **≥ 768px**  a persistent left sidebar. No hamburger, no drawer: a
 *     menu that is always visible is one fewer thing to teach.
 *
 * There is deliberately no collapsing drawer. A drawer needs focus trapping,
 * an escape handler and a scroll lock to be accessible, and none of that earns
 * its keep for five navigation items.
 *
 * The company name comes from the database (`company_settings`), never from a
 * constant, so it changes everywhere when the business registers. In Phase 1
 * the row is not yet readable, so the configured default is used — the
 * dashboard reports which source was used rather than hiding it.
 */
export async function AppShell({ children }: { readonly children: ReactNode }) {
  const { branding } = await getCompanyBranding();

  return (
    <div className="min-h-dvh">
      {/* Lets a keyboard user jump past the navigation. */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* --- Desktop sidebar ------------------------------------------- */}
      <nav
        aria-label="Main navigation"
        className="border-border bg-surface fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r p-3 md:flex"
      >
        <div className="mb-5 flex items-center gap-2.5 px-2 pt-2">
          <span className="bg-brand-600 flex size-9 shrink-0 items-center justify-center rounded-lg">
            <ShieldCheck aria-hidden="true" className="size-5 text-white" />
          </span>
          <span className="min-w-0">
            {/* Two lines before clipping: a registered company name is often
                longer than a 240px sidebar, and "Money Lending ..." tells
                staff nothing. */}
            <span className="line-clamp-2 block text-sm leading-snug font-semibold">
              {branding.companyName}
            </span>
            <span className="text-text-muted block text-xs">Phase {CURRENT_PHASE}</span>
          </span>
        </div>

        <PrimaryNav variant="sidebar" />

        <p className="text-text-muted px-3 py-2 text-xs">{APP_SHORT_NAME}</p>
      </nav>

      {/* --- Mobile header -------------------------------------------- */}
      <header className="border-border bg-surface sticky top-0 z-20 flex items-center gap-2.5 border-b px-4 py-3 md:hidden">
        <span className="bg-brand-600 flex size-8 shrink-0 items-center justify-center rounded-lg">
          <ShieldCheck aria-hidden="true" className="size-4 text-white" />
        </span>
        {/* min-w-0 + truncate: a long company name must not widen the page. */}
        <span className="min-w-0 truncate text-sm font-semibold">
          {branding.companyName}
        </span>
      </header>

      {/* --- Main region ---------------------------------------------- */}
      {/* pb-24 clears the fixed bottom bar on phones; md:pl-60 clears the
          sidebar on larger screens. */}
      <div className="md:pl-60">
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
        // pb-[env(safe-area-inset-bottom)] keeps the bar above the home
        // indicator on a notched phone.
        className="border-border bg-surface fixed inset-x-0 bottom-0 z-20 flex gap-0.5 border-t px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden"
      >
        <PrimaryNav variant="bottom-bar" />
      </nav>
    </div>
  );
}
