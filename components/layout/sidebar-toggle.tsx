'use client';

import { Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The one thing anything inside the rail may ask of it: close.
 *
 * The rail's contents are built by the shell, which is a Server Component, so
 * a close button in the brand strip cannot be handed an `onClick` — a
 * function does not cross the server/client boundary. Context does: the
 * element is created on the server, rendered inside the provider below, and
 * finds the callback at render time on the client.
 *
 * `null` outside the provider, so `SidebarCloseButton` renders nothing rather
 * than throwing if it is ever used somewhere there is no rail to close.
 */
const SidebarContext = createContext<{ readonly close: () => void } | null>(null);

/**
 * The drawer's own close control, for the widths where the drawer exists.
 *
 * Below `md` the rail covers most of a phone and the menu button that opened
 * it is underneath the scrim, so without this the only ways out are the scrim,
 * Escape and picking a destination. A drawer with no visible close is a drawer
 * people learn to distrust. Hidden from `md` up, where the rail is simply the
 * page furniture and there is nothing to close.
 */
export function SidebarCloseButton({ className }: { readonly className?: string }) {
  const controls = useContext(SidebarContext);
  if (controls === null) return null;

  return (
    <button
      type="button"
      onClick={controls.close}
      className={cn(
        '-my-1 -mr-1.5 flex size-9 shrink-0 items-center justify-center rounded',
        'text-blue-100 transition-colors hover:bg-blue-800/60 hover:text-white',
        'md:hidden',
        className,
      )}
    >
      <X aria-hidden="true" className="size-5" />
      {/* Not "Close navigation": that is the scrim's name, and two controls
          answering to one name is a screen reader reading the same label
          twice and a test that cannot say which it clicked. */}
      <span className="sr-only">Close menu</span>
    </button>
  );
}

export interface SidebarToggleProps {
  /** The rail's contents: brand block, role strip, menu, user footer. */
  readonly sidebar: ReactNode;
  /** The header's contents, both the desktop row and the phone icon bar. */
  readonly header: ReactNode;
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
 * in as `sidebar`, `header` and `children` stays on the server. Nothing but
 * the open/closed state is shipped to the browser.
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

  // Stable, because it is both the value the provider hands down and the
  // handler the Escape listener below binds — a new function on every render
  // would re-run that effect and re-render every consumer for nothing.
  const close = useCallback((): void => {
    setOpenedOn(null);
  }, []);

  const controls = useMemo(() => ({ close }), [close]);

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
  }, [isOpen, close]);

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
          /*
            `invisible` when closed, not merely pushed off-screen.

            A transform moves the rail out of view but leaves it in the
            accessibility tree and in the tab order, so on a phone the first
            dozen Tab presses used to walk an invisible menu before reaching
            the page. `visibility: hidden` takes it out of both, and because
            visibility is animatable it still slides rather than blinking.

            Only below `md`: from there up the rail is always on screen.
          */
          isOpen ? 'visible' : 'invisible',
          'md:visible md:translate-x-0',
        )}
      >
        <SidebarContext.Provider value={controls}>{sidebar}</SidebarContext.Provider>
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
          `px-3 sm:px-4 md:px-6 lg:px-8` gutters. The bottom inset is the
          same `pb-10` at every width — there is no fixed bar below the
          content any more, so nothing has to be reserved for one, and a
          phone-only `pb-24` would be a 96px strip of nothing under the last
          row of every list. `print:*` resets both offsets, because the rail
          and the header are hidden on paper and theirs would otherwise leave
          a blank margin down every page. */}
      <main
        id="main-content"
        className={cn(
          'min-h-dvh w-full min-w-0 flex-1 pt-16 pb-10 sm:pt-20',
          'px-3 sm:px-4 md:px-6 lg:px-8',
          'md:ml-64',
          'print:ml-0 print:px-0 print:pt-0 print:pb-0',
        )}
      >
        <div className="mx-auto w-full max-w-[90rem]">{children}</div>
      </main>
    </div>
  );
}
