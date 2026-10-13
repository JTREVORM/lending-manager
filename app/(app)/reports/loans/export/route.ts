import { reportExportRoute } from '@/lib/reports/export';

/**
 * The loans report, as CSV or as a branded PDF.
 *
 * One line, because everything that used to be written here is now read from
 * the registry: the capability list, the filter parsing, the loader, the
 * columns and the filename. The capability list in particular — it is the
 * same object the page checks, so an export route cannot drift behind its
 * page, which is a security defect that looks like a typo.
 *
 * The file exists per report rather than as one `[report]/export` handler
 * because Next resolves a static path segment before a dynamic one: while
 * `loans/` is a real folder, `/reports/loans/export` would never
 * reach a dynamic sibling. So this is the shape the router requires.
 */
export const GET = reportExportRoute('loans');
