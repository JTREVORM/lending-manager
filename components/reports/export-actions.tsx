import { Download, FileText } from 'lucide-react';

import { ActionLink } from '@/components/ui/page-header';
import { reportExportHref, type ReportId } from '@/lib/reports/registry';

/**
 * The two downloads every report offers, and the print view beside them.
 *
 * ## Two formats, because they answer different needs
 *
 * The spreadsheet is for *totalling*: plain digits, no separators, no currency
 * symbols, every matching row rather than the page somebody was on. Somebody
 * opens it, sorts it, sums a column, pivots it.
 *
 * The PDF is for *circulating*: the company's letterhead, the filters that
 * were applied, who ran it and when, page numbers, and figures grouped for
 * reading. Somebody prints it, signs it off, files it, or hands it across a
 * desk. It is not a picture of this page — every figure in it is text, drawn
 * with a standard font, so it can be searched and copied and printed at the
 * printer's resolution rather than the screen's.
 *
 * Offering one and not the other would push somebody into misusing it: a CSV
 * emailed to a committee, or a PDF somebody retypes into a spreadsheet.
 *
 * ## Both links carry the filters, and only the filters
 *
 * Built on the server from the query string the page was rendered with, so
 * each file holds exactly the rows on screen. `page` is not among the filter
 * keys, so neither download can accidentally contain page three of a report.
 *
 * ## Neither link decides anything
 *
 * They are links. The route behind them repeats the page's capability check —
 * from the same registry entry, so the two cannot differ — and reads under the
 * same Row Level Security, because a URL can be typed. Hiding a link is
 * presentation; the handler is the control.
 */
export function ExportActions({
  report,
  filterQuery,
}: {
  readonly report: ReportId;
  /** The report's own filters, already narrowed to its declared keys. */
  readonly filterQuery: string;
}) {
  return (
    <>
      {/*
        `prefetch={false}` on both: these hrefs are file downloads, and
        prefetching one would run the report — and build the PDF — on hover.
      */}
      <ActionLink
        href={reportExportHref(report, 'pdf', filterQuery)}
        prefetch={false}
        variant="secondary"
        className="print:hidden"
      >
        <FileText aria-hidden="true" className="size-4" />
        Download PDF
      </ActionLink>

      <ActionLink
        href={reportExportHref(report, 'csv', filterQuery)}
        prefetch={false}
        variant="secondary"
        className="print:hidden"
      >
        <Download aria-hidden="true" className="size-4" />
        Download CSV
      </ActionLink>
    </>
  );
}
