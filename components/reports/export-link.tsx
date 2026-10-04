import { Download } from 'lucide-react';
import Link from 'next/link';

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
    <Link
      href={href}
      prefetch={false}
      className="min-h-touch border-border-strong bg-surface text-text hover:bg-surface-raised focus-visible:outline-brand-600 inline-flex items-center gap-2 rounded-lg border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 print:hidden"
    >
      <Download aria-hidden="true" className="size-4" />
      {label}
    </Link>
  );
}
