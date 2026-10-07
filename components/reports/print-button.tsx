'use client';

import { Printer } from 'lucide-react';

import { ActionButton } from '@/components/ui/page-header';

/**
 * Print this page.
 *
 * The browser's own print view, against the page's print styles, rather than a
 * server-rendered PDF. A PDF pipeline is a dependency, a font-embedding
 * problem and a second rendering of every figure; the browser already knows
 * how to put this page on paper, and `print:hidden` on the navigation and
 * controls is the whole of what it needed.
 *
 * A client component because printing is a browser action. Rendered beside a
 * plain explanation so somebody who cannot use the button still knows the page
 * is meant to be printable.
 */
export function PrintButton({ label = 'Print' }: { readonly label?: string }) {
  return (
    // `ActionButton` rather than a bespoke button, so this and `ExportLink`
    // beside it are the same control at the same height — the two always
    // appear as a pair under a report's banner, and before this they were a
    // `Button size="sm"` next to a hand-rolled link, which did not match.
    <ActionButton
      variant="secondary"
      onClick={() => {
        window.print();
      }}
      className="print:hidden"
    >
      <Printer aria-hidden="true" className="size-4" />
      {label}
    </ActionButton>
  );
}
