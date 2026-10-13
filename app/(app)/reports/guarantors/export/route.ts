import { reportExportRoute } from '@/lib/reports/export';

/**
 * The guarantors report, as CSV or as a branded PDF.
 *
 * One line: the capability list, the filter parsing, the loader, the columns
 * and the filename all come from the registry entry, so this route cannot
 * carry a weaker capability list than its page — it carries none at all.
 */
export const GET = reportExportRoute('guarantors');
