'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';

export interface SidebarToggleProps {
  /** The rail's contents: brand block, role strip, menu, user footer. */
  readonly sidebar: ReactNode;
  /** The header's contents, both the desktop row and the phone icon bar. */
  readonly header: ReactNode;
  /** The phone's bottom tab bar. */
  readonly bottomBar: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * The shell's one piece of client state: whether the off-canvas rail is open.
 *
 * ## Why it is its own component
 *
 * The reference's `ProtectedLayout` holds `isSidebarOpen` and hands it to both
 * the `Sidebar` and the `Header`, because the rail is off-canvas below `md`
 * and the button that opens it lives in the header. That is one boolean shared
 * by two siblings.
 *
 * In this application the shell is a Server Component — it awaits the
 * company's branding and reads the resolved session — so the boolean cannot
 * live there. It lives here instead, in the smallest island that can hold it:
 * this component renders the frame and the menu button, and everything passed
 * in as `sidebar`, `header`, `bottomBar` and `children` stays on the server.
 * Nothing but the open/closed state is shipped to the browser.
 *
 * ## The rail's geometry
 *
 * The reference's exact transform: `-translate-x-full` closed,
 * `translate-x-0` open, `md:translate-x-0` always, over 300ms `ease-in-out`,
 * with a `bg-slate-900/50 backdrop-blur-xs` scrim at `z-25` between the rail
 * (`z-40`) and the header (`z-20`).
 */
export function SidebarToggle({
  sidebar,
  header,
  bottomBar,
  children,
  className,
}: SidebarToggleProps) {
  // The rail's open state is stored together with the pathname it was opened
  // on, and read back as "open, and still on that page".
  //
  // Navigating has to close it: tapping a destination on a phone must not
  // leave the menu sitting over the page you just asked for. The obvious way
  // to do that is an effect on the pathname that calls `setIsOpen(false)`,
  // but setting state from an effect body schedules a second render of the
  // whole shell on every navigation purely to put a boolean back to its
  // default — and React now flags it, because that is how cascading-render
  // problems start.
  //
  // Deriving it instead costs nothing and cannot fall out of step: a changed
  // pathname *is* the rail being closed, in the same render that shows the
  // new page.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const pathname = usePathname();
  const isOpen = openedOn === pathname;

  const toggle = (): void => {
    setOpenedOn((current) => (current === pathname ? null : pathname));
  };

  const close = (): void => {
    setOpenedOn(null);
  };

  // Escape closes it, which is what a user who has opened an overlay by
  // accident reaches for first. Only bound while it is open.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  return (
    <div className={className}>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {/* --- The rail ------------------------------------------------- */}
      <nav
        aria-label="Main navigation"
        className={cn(
          'sidebar-gradient text-sidebar-foreground fixed inset-y-0 left-0 z-40 flex w-64 flex-col',
          'border-r border-blue-900/60 shadow-2xl',
          'transition-transform duration-300 ease-in-out print:hidden',
          isOpen ? 'translate-x-0' : '-translate-x-full',
          'md:translate-x-0',
        )}
      >
        {sidebar}
      </nav>

      {/* The scrim, between the rail and the header. */}
      {isOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={close}
          className="fixed inset-0 z-[25] bg-slate-900/50 backdrop-blur-[2px] md:hidden"
        />
      ) : null}

      {/* --- The header ----------------------------------------------- */}
      <header
        className={cn(
          'border-border bg-surface fixed top-0 right-0 left-0 z-20 flex h-16 items-center justify-between gap-4',
          'border-b px-4 shadow-xs transition-all duration-300 md:left-64 md:px-6 print:hidden',
        )}
      >
        {/* The menu button is the one header control that has to know the
            state, so it is rendered here rather than passed in. */}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-label="Main menu"
          className="text-text -ml-1 shrink-0 p-1 md:hidden"
        >
          <Menu aria-hidden="true" className="size-6" />
        </button>

        {header}
      </header>

      {/* --- Main region ---------------------------------------------- */}
      {/* The reference's `main`: `md:ml-64 pt-16 sm:pt-20` with its
          `px-3 sm:px-4 md:px-6 lg:px-8` gutters. `print:*` resets both,
          because the rail and the header are hidden on paper and their
          offsets would otherwise leave a blank margin down every page. */}
      <main
        id="main-content"
        className={cn(
          'min-h-dvh w-full min-w-0 flex-1 pt-16 pb-24 sm:pt-20',
          'px-3 sm:px-4 md:px-6 lg:px-8',
          'md:ml-64 md:pb-10',
          'print:ml-0 print:px-0 print:pt-0 print:pb-0',
        )}
      >
        <div className="mx-auto w-full max-w-[90rem]">{children}</div>
      </main>

      {/* --- Mobile bottom bar ---------------------------------------- */}
      <nav
        aria-label="Quick navigation"
        data-nav="bottom-bar"
        className={cn(
          'border-border bg-surface fixed inset-x-0 bottom-0 z-20 flex gap-0.5 border-t px-1 pt-1',
          'pb-[max(0.25rem,env(safe-area-inset-bottom))] shadow-[0_-1px_3px_rgba(0,0,0,0.06)]',
          'md:hidden print:hidden',
        )}
      >
        {bottomBar}
      </nav>
    </div>
  );
}
