import { Download } from 'lucide-react';

import { ActionLink } from '@/components/ui/page-header';

/**
 * Download the current report as CSV.
 *
 * ## It carries the filters, and only the filters
 *
 * The link is built on the server from the same query string the page was
 * rendered with, so the file contains exactly the rows on screen. A download
 * that quietly ignored a filter — or applied a different one — would be the
 * worst kind of reporting bug: a file somebody circulates, believing it is the
 * report they were looking at.
 *
 * ## The route checks permission again
 *
 * This is a link, so it decides nothing. The route handler behind it performs
 * the same capability check the page did and reads under the same Row Level
 * Security, because a URL can be typed. Hiding this link is presentation, not
 * protection.
 */
export function ExportLink({
  href,
  label = 'Download CSV',
}: {
  readonly href: string;
  readonly label?: string;
}) {
  return (
    // The banner's secondary action shape, matching `PrintButton` beside it.
    // `prefetch={false}` stays: this href is a file download, and prefetching
    // it would generate the CSV on hover.
    <ActionLink href={href} prefetch={false} variant="secondary" className="print:hidden">
      <Download aria-hidden="true" className="size-4" />
      {label}
    </ActionLink>
  );
}
