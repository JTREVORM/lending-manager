/**
 * The Agency export route guards itself, and carries what it claims to carry.
 *
 * ## Why this route needed its own test
 *
 * `tests/integration/report-routes.test.ts` asserts all of this for the ten
 * reports under `/reports`, and it walks that directory — so the Agency hub's
 * export, which lives at `/agency/reports/export`, was outside every one of
 * its assertions. The route was written with the right guard; nothing
 * required it to stay that way, and the Owner's decision 3 asked for the
 * export authorization tests to be strengthened.
 *
 * ## Why source-level assertions
 *
 * The risk is structural: a download route shipped without a capability
 * check, or with a weaker one than the page whose link produced it. A download
 * is a separate request to a separate URL — the link can be typed, copied, or
 * kept after a role changes — so the route repeats the page's check rather
 * than trusting where the caller came from. That cannot be caught by rendering
 * anything, so this reads the file, the way the migrations test reads the SQL.
 *
 * It is the weaker kind of assertion, and it is deliberately paired with
 * stronger ones: `tests/unit/permissions.test.ts` fixes who holds
 * `agency:reports`, and the agency Row Level Security suites prove which rows
 * come back whatever the application does. Row Level Security is the
 * boundary; this is the layer that stops a file being offered at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import {
  AGENCY_REPORT_GRAINS,
  AGENCY_REPORT_PARAMS,
  AGENCY_REPORT_SECTIONS,
} from '@/lib/agency/reporting';
import { permissionForPath } from '@/lib/auth/routing';

const ROUTE = join(
  process.cwd(),
  'app',
  '(app)',
  'agency',
  'reports',
  'export',
  'route.ts',
);
const FIELDS = join(process.cwd(), 'lib', 'reports', 'agency-fields.ts');

const source = readFileSync(ROUTE, 'utf8');
const fields = readFileSync(FIELDS, 'utf8');

/**
 * The file with its comments removed.
 *
 * Needed because this route's own documentation quotes the calls it makes —
 * the header explains `guardExport(['agency:reports'])` in prose — and a test
 * counting calls would count the explanation. Which it did, on the first run:
 * the assertion that the guard is called once found two, and both were right.
 *
 * Assertions about *calls* read this; assertions about words the document
 * carries read the raw source, because those are string literals and survive
 * stripping either way.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const code = withoutComments(source);
const fieldCode = withoutComments(fields);

describe('the Agency export route — authorization', () => {
  it('guards itself with the capability its own page requires', () => {
    // Not a capability chosen here: the one the route map gives the hub. If
    // the page is ever moved to a stronger capability, the download must move
    // with it, or the link becomes the way around the page.
    const expected = permissionForPath(ROUTES.agencyReports);
    expect(expected).toBe('agency:reports');
    expect(code).toContain(`guardExport(['${String(expected)}'])`);
  });

  it('calls the guard exactly once, before anything is read', () => {
    const calls = code.match(/guardExport\(/g) ?? [];
    expect(calls).toHaveLength(1);

    // Before the first database read. A guard that ran after the query would
    // still return 403, having already done the work and touched the rows —
    // and a timing difference is the sort of thing that becomes an oracle.
    const guardAt = code.indexOf('await guardExport(');
    const firstRead = code.indexOf('await getAgency');
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstRead);
  });

  it('refuses the request rather than redirecting it', () => {
    // A redirect would answer a request for a CSV with an HTML page, which
    // arrives as a file full of markup named like a spreadsheet.
    expect(code).not.toMatch(/\bredirect\(/);
    expect(code).not.toMatch(/\bnotFound\(/);
  });

  it('uses no privileged client anywhere', () => {
    // The service-role key bypasses Row Level Security, which is the only
    // layer that holds against a caller who skips the application. A download
    // route is the last place it belongs.
    expect(code).not.toContain('createSupabaseAdminClient');
    expect(code).not.toContain('SERVICE_ROLE');
    expect(code).not.toContain('service_role');
  });

  it('exports a reader and nothing else', () => {
    // A download is a GET. An export route that exported POST would be a
    // mutation reachable with a link, outside every maker-checker control.
    expect(code).toMatch(/export async function GET\(/);
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(code).not.toMatch(new RegExp(`export async function ${verb}\\(`));
    }
  });

  it('reads its filters through the same function the page does', () => {
    // So a file cannot cover a different period or scope than the screen that
    // offered it. Two readers of one query string would disagree eventually,
    // and the disagreement would be invisible — a correct-looking document
    // about the wrong fortnight.
    expect(code).toContain('readAgencyReportFilter');
  });
});

describe('the Agency export route — what it produces', () => {
  it('handles every section that has rows to export', () => {
    // A section added to the hub without an export case would fall through to
    // a 400 from a link the Export Centre itself renders.
    for (const section of AGENCY_REPORT_SECTIONS) {
      if (section === 'overview' || section === 'export') continue;
      expect(code, `no export case for ${section}`).toContain(`case '${section}':`);
    }
  });

  it('handles both commission grains', () => {
    // The Owner's decision 3. `position` is the default and `daily` is the
    // breakdown; both must be reachable, or the Export Centre renders a link
    // to a file that cannot be built.
    expect(AGENCY_REPORT_GRAINS).toContain('daily');
    expect(AGENCY_REPORT_GRAINS).toContain('position');
    expect(code).toContain("filter.grain === 'daily'");
    expect(code).toContain('agencyCommissionDailyFields');
  });

  it('declares the grain as a parameter the destination reads', () => {
    // The navigation parity test asserts a link may only pin a parameter its
    // destination reads. This asserts the other direction: the parameter the
    // route reads is in the list an export link carries, so a download link
    // built from a filtered page keeps the grain.
    expect(AGENCY_REPORT_PARAMS).toContain('grain');
  });

  it('builds every response through the one shared helper', () => {
    // CSV and PDF from the same rows through the same fields, so a column
    // cannot appear in one and be missing from the other. Each case returns
    // `respond(...)`; a case that built a Response itself would be a second
    // implementation to keep in step.
    const cases = code.match(/case '[a-z-]+':/g) ?? [];
    expect(cases.length).toBeGreaterThanOrEqual(6);
    const responds = code.match(/return respond\(/g) ?? [];
    expect(responds.length).toBeGreaterThanOrEqual(6);

    expect(code).toContain('csvResponse(');
    expect(code).toContain('pdfResponse(');
    // Both inside the helper, which is what makes them the same rows.
    const helperAt = code.indexOf('async function respond<Row>');
    expect(helperAt).toBeGreaterThan(-1);
    expect(code.indexOf('csvResponse(', helperAt)).toBeGreaterThan(helperAt);
    expect(code.indexOf('pdfResponse(', helperAt)).toBeGreaterThan(helperAt);
  });

  it('says in the document what produced it', () => {
    // A printout that has left the screen has to be readable for what it is:
    // the heading, the period, the filters and the moment it was generated.
    // Without them a PDF is a table of figures about an unstated fortnight.
    for (const claim of [
      'title:',
      'coverage:',
      'filters:',
      'generatedBy: context.fullName',
      'generatedAt:',
      'branding',
    ]) {
      expect(code, `the PDF omits ${claim}`).toContain(claim);
    }
  });

  it('names the commission grain in the document itself', () => {
    // The commission report is the one section with two grains, and the two
    // say different things about the same period. A printout of one must not
    // be mistakable for the other.
    expect(code).toContain("filter.section === 'commission'");
    expect(source).toMatch(/outstanding is a position and is not shown by day/);
  });

  it('never puts an unmasked line number in an export', () => {
    // An agent line's MSISDN is masked in every view that exposes it, and a
    // download is the easiest way for a full number to leave the building.
    // The masked form is the only one any field may read.
    expect(fieldCode).not.toMatch(/\.lineMsisdn\b/);
    expect(code).not.toMatch(/\.lineMsisdn\b/);
    expect(fieldCode).not.toContain('line_msisdn');
    expect(code).not.toContain('line_msisdn');
  });

  it('states the figures it does not have, rather than printing zero', () => {
    // The float roll-up's three totals are omitted when the roll-up cannot be
    // read. A printed zero against "bought from providers" is a claim, and a
    // financial document must not state a figure it does not have.
    expect(code).toContain('...(rollup.ok');
  });
});
