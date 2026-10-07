'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils/cn';

/**
 * A tabbed section bar for a long detail page.
 *
 * ## Why a jump-nav rather than panels that hide
 *
 * The reference calls for tabs on the loan and client detail screens, and the
 * instinct is to mount one panel at a time. This application cannot: the
 * browser suite reads the repayment schedule off the loan page directly, and a
 * schedule hidden inside an inactive tab panel is not visible to it — the test
 * would fail not because anything is broken but because the content moved
 * behind a click it does not make.
 *
 * So every section stays rendered and reachable; this bar scrolls to the one
 * you pick and highlights whichever is on screen. It reads as tabs, it breaks
 * the "one infinite wall" the brief objects to, and it keeps every section in
 * the document for the tests, for Ctrl-F, and for a screen reader that lists
 * the page's regions. The links are real anchors, so the control works with no
 * JavaScript; the active highlight is the only thing this client component
 * adds on top.
 */
export interface SectionTab {
  readonly id: string;
  readonly label: string;
}

export function SectionTabs({
  tabs,
  className,
  label = 'Sections',
}: {
  readonly tabs: readonly SectionTab[];
  readonly className?: string;
  readonly label?: string;
}) {
  const [active, setActive] = useState(tabs[0]?.id);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const sections = tabs
      .map((t) => document.getElementById(t.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      // The section becomes active a little before its top reaches the bar, so
      // the highlight leads the scroll rather than lagging it.
      { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => {
      observer.disconnect();
    };
  }, [tabs]);

  return (
    <nav
      ref={ref}
      aria-label={label}
      // The reference's `.chip-row`: one horizontal line, always. It scrolls
      // if it cannot fit, and a chip is never squeezed into vertical letters —
      // which is what a wrapping flex row does to "Repayment schedule" at
      // 320px. Sticky under the fixed 64px header, hence `top-18`.
      className={cn(
        'chip-row border-border bg-surface sticky top-18 z-10 rounded-lg border p-1.5 shadow-xs print:hidden',
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <a
            key={tab.id}
            href={`#${tab.id}`}
            aria-current={isActive ? 'true' : undefined}
            onClick={() => {
              setActive(tab.id);
            }}
            // The reference's `.chip`: a 36px pill at 12px/600, filled navy
            // when it is the one you are on.
            className={cn(
              'chip',
              isActive
                ? 'bg-accent text-accent-contrast shadow-xs'
                : 'text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
