'use client';

import { Printer } from 'lucide-react';

import { Button } from '@/components/ui/button';

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
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => {
        window.print();
      }}
      className="print:hidden"
    >
      <Printer aria-hidden="true" className="size-4" />
      {label}
    </Button>
  );
}
