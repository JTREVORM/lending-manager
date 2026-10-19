'use client';

import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * The three-dot menu at the end of a row.
 *
 * ## What may be in it
 *
 * Only operations that (a) already exist as a route in this application and
 * (b) this user, on this record, in its current state, is actually allowed to
 * perform. The caller builds the list from the same capability checks the
 * destination enforces.
 *
 * Hiding an entry is a **courtesy, not a protection**. Every destination
 * re-checks the permission server-side and Row Level Security applies beneath
 * that, so a hand-typed URL gets the same refusal. What hiding buys is a
 * staff member not pressing something that will turn them away.
 *
 * Three rules this menu is held to:
 *
 *   - **Nothing is invented.** An action appears because the workflow
 *     supports it, never because it would look useful in a menu.
 *   - **No destructive shortcut.** There is no Delete. Approving, rejecting,
 *     disbursing and reversing keep their own screens, their confirmation and
 *     their audit entry; this menu is a way *to* them, not a way around them.
 *   - **It links, mostly.** An entry that navigates is an `<a>`, so it tells
 *     a screen reader it will not spend money, and middle-click and
 *     open-in-new-tab work the way they do everywhere else.
 *
 * ## Keyboard and screen reader
 *
 * A real `aria-haspopup="menu"` button with `aria-expanded`, a `role="menu"`
 * of `role="menuitem"` children. Escape closes and returns focus to the
 * trigger — a menu that closes and drops focus to the body leaves a keyboard
 * user at the top of the document. Arrow keys move within the menu, Tab
 * leaves it, a click outside dismisses it.
 *
 * The trigger is labelled with the record it belongs to, so a reader hears
 * "Actions for loan LN260034" instead of twenty buttons called "Actions".
 */

export interface RowAction {
  readonly label: string;
  /** Where it goes. Every action in this menu navigates. */
  readonly href: string;
  /** Marks an action that leads to a decision or a movement of money. */
  readonly emphasis?: 'default' | 'strong';
}

export function RowActions({
  actions,
  /** What this menu acts on, for the trigger's accessible name. */
  label,
}: {
  readonly actions: readonly RowAction[];
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event: MouseEvent): void {
      if (containerRef.current?.contains(event.target as Node) === false) {
        setOpen(false);
      }
    }

    // Closing on scroll rather than repositioning: the menu is anchored to a
    // row in a table that scrolls in two directions, and a menu that follows
    // its row across a horizontal scroll is more startling than one that
    // simply goes away.
    function onScroll(): void {
      setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  function close(restoreFocus: boolean): void {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function moveFocus(delta: number): void {
    const items =
      containerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items === undefined || items.length === 0) return;

    const list = [...items];
    const current = list.indexOf(document.activeElement as HTMLElement);
    const next = current === -1 ? 0 : (current + delta + list.length) % list.length;
    list[next]?.focus();
  }

  // A row with nothing this person may do to it shows nothing, rather than a
  // button that opens an empty menu.
  if (actions.length === 0) {
    return <span className="sr-only">No actions available for {label}</span>;
  }

  return (
    <div
      ref={containerRef}
      className="relative flex justify-end"
      /*
        The key handling lives here rather than on the menu, because after
        the trigger is clicked focus is still *on the trigger* — a handler
        bound to the menu would never see the Escape. The container holds
        both, so it sees every key pressed while the menu is open wherever
        focus happens to be.
      */
      onKeyDown={(event) => {
        if (!open) return;

        if (event.key === 'Escape') {
          event.preventDefault();
          close(true);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(-1);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Actions for ${label}`}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          // Opening with an arrow lands on the first or last entry. Once
          // open, the container's handler takes over.
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            const backwards = event.key === 'ArrowUp';
            setOpen(true);
            // After the menu paints, not before it exists.
            requestAnimationFrame(() => {
              moveFocus(backwards ? -1 : 1);
            });
          }
        }}
        className={cn(
          'text-text-muted hover:bg-surface-hover hover:text-text focus-visible:outline-accent',
          'inline-flex size-8 items-center justify-center rounded-md',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          open ? 'bg-surface-hover text-text' : undefined,
        )}
      >
        <MoreVertical aria-hidden="true" className="size-4" />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${label}`}
          className={cn(
            'border-border bg-surface absolute top-full right-0 z-20 mt-1 min-w-52 rounded-lg border py-1',
            'shadow-[0_10px_25px_-5px_rgba(15,41,98,0.15),0_8px_10px_-6px_rgba(0,0,0,0.06)]',
          )}
        >
          {actions.map((action) => (
            <Link
              key={`${action.href}:${action.label}`}
              role="menuitem"
              href={action.href}
              onClick={() => {
                setOpen(false);
              }}
              className={cn(
                'hover:bg-surface-hover focus-visible:bg-surface-hover block px-3 py-2 text-[13px] whitespace-nowrap focus-visible:outline-none',
                action.emphasis === 'strong' ? 'text-accent font-medium' : 'text-text',
              )}
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
