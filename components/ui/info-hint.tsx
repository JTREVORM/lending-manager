'use client';

import { Info } from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '@/lib/utils/cn';

export interface InfoHintProps {
  /**
   * What the figure or control this sits beside actually means, in one
   * sentence.
   */
  readonly text: string;
  /**
   * What it explains, used to name the control: "What Total collected
   * means". A bare "Info" button repeated eleven times down a dashboard is
   * eleven identically-named controls in a screen reader's list.
   */
  readonly subject: string;
  readonly className?: string;
}

/**
 * A definition, available without being in the way.
 *
 * ## Why not simply print it
 *
 * Every figure in this system states what it means, and that is not
 * negotiable: a money figure with a three-word label is how two people end up
 * confident about different numbers. It used to be printed under each card,
 * which made a dashboard of eleven cards read as documentation — three lines
 * of explanation under two lines of fact, eleven times over.
 *
 * So the sentence is still there, in the markup, always, and still reachable:
 * by pressing the icon, or by a screen reader, which reads it from the
 * element this button names. What changed is that it no longer occupies the
 * card when nobody has asked for it.
 *
 * ## One copy of the text, in one element
 *
 * The same node is either the popover or `sr-only` — never both, and never
 * two copies. Two would mean a reader hearing the definition twice, and a
 * test that cannot say which one it found.
 *
 * The popover is absolutely positioned, so opening it does not move anything:
 * a row of cards must not change height because somebody asked what one of
 * them means.
 *
 * ## Why a button and not a `title`
 *
 * A `title` attribute does not open on a touch screen, is not reachable by
 * keyboard, and is announced inconsistently. This is a real `<button>` with
 * `aria-expanded` and `aria-controls` naming the text it reveals, which works
 * with a thumb, with Tab and Enter, and with a screen reader.
 */
export function InfoHint({ text, subject, className }: InfoHintProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={cn('relative inline-flex shrink-0 print:hidden', className)}>
      <button
        type="button"
        onClick={() => {
          setOpen((shown) => !shown);
        }}
        aria-expanded={open}
        aria-controls={id}
        className={cn(
          'hover:text-accent focus-visible:outline-accent inline-flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-2',
          open ? 'text-accent' : 'text-text-muted',
        )}
      >
        <Info aria-hidden="true" className="size-3.5" />
        <span className="sr-only">What {subject} means</span>
      </button>

      <span
        id={id}
        role="note"
        className={
          open
            ? 'border-border bg-surface text-text-muted absolute top-full right-0 z-20 mt-1 w-56 rounded-md border p-2 text-[11px] leading-snug shadow-lg'
            : 'sr-only'
        }
      >
        {text}
      </span>
    </span>
  );
}
