/**
 * The CSV response.
 *
 * No `server-only` marker, deliberately — see below.
 *
 * ## What used to be here
 *
 * Five `*CsvColumns` builders, one per report, each a list of
 * `{ header, cell }` pairs. Phase 16 replaced them with the field sets in
 * `fields.ts`, because a report's columns existed twice over: once for the
 * download and once as JSX on the screen, and the two drifted in the way that
 * is hardest to notice — a heading that says one thing and cells that hold
 * another. A field now declares a column once and both renderings are derived
 * from it.
 *
 * `tests/unit/report-fields.test.ts` pins the heading row of every file this
 * application produces, exactly, so the replacement did not change a download
 * somebody has a saved formula against, and nothing can change one later
 * without the test saying so.
 *
 * What remains here is the response: the headers that make a browser save the
 * file rather than render it, and the reasons for each.
 *
 * ## No `server-only` marker
 *
 * Nothing in this file reaches a database or holds a credential, and the
 * export's security properties — the formula disarming and the absence of any
 * identification number — live in `lib/domain/reporting.ts` and
 * `lib/reports/columns.ts`, which are tested directly for the same reason.
 */

/** The response a CSV export returns. One place, so every route agrees. */
export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      // `attachment` matters beyond convenience: it stops a browser rendering
      // the file in place, which is what turns a CSV holding user-supplied text
      // into a content-sniffing problem.
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
