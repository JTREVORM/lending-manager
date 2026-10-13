import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { REPORTS, type ReportId } from '@/lib/reports/registry';

/**
 * Every reporting route guards itself.
 *
 * ## Why this is a source-level test
 *
 * The risk is specific and structural: a report page or an export route
 * shipped without a capability check, or with a weaker one than the report it
 * serves. That cannot be caught by rendering a component, and it is too
 * important to leave to the route map alone — the map gates the `/reports`
 * prefix, but the narrower capabilities (`reports:view_financial`,
 * `reports:view_sensitive`) differ *within* that prefix and are enforced by
 * each page and each handler.
 *
 * So this reads the files and asserts the calls are there, the way
 * `tests/integration/migrations.test.ts` reads the SQL. It is a weaker kind of
 * assertion than exercising the guard, and it is paired with two stronger
 * ones: `tests/unit/permissions.test.ts` fixes who holds each capability, and
 * `tests/db/rls-reports.test.ts` proves which rows come back whatever the
 * application does.
 *
 * ## What the layers are, so nothing here is mistaken for the boundary
 *
 * 1. The proxy, from the route map — turns a borrower away at the door.
 * 2. The page's own `guardPermission` — this test.
 * 3. The export route's `guardExport` — this test. Phase 16 moved the list it
 *    is given into the registry, so the page and the route now read the *same
 *    object*. That is a stronger guarantee than two source files agreeing, and
 *    the assertions below changed shape to check it: the registry against the
 *    expectation here, and the page against the registry.
 * 4. Row Level Security — the actual boundary, and the only layer that holds
 *    against a caller who skips the application entirely.
 */

const APP = join(process.cwd(), 'app', '(app)');
const REPORTS_DIR = join(APP, 'reports');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function listDirs(path: string): readonly string[] {
  return readdirSync(path).filter((entry) => statSync(join(path, entry)).isDirectory());
}

/** The capabilities each report page and its export must both require. */
const EXPECTED: Readonly<Record<string, readonly Permission[]>> = {
  collections: ['reports:view_operational', 'payments:view'],
  arrears: ['reports:view_operational', 'delinquency:view'],
  grace: ['reports:view_operational', 'delinquency:view'],
  clients: ['reports:view_operational', 'clients:view'],
  loans: ['reports:view_financial', 'loans:view'],
  penalties: ['reports:view_financial', 'penalties:view'],
  // Phase 16. The Debt & Security module had the views and the worklists from
  // Phase 14 but no documents; these four are the same rows as reports.
  aging: ['reports:view_financial', 'delinquency:view'],
  recovery: ['reports:view_operational', 'recovery:view'],
  guarantors: ['reports:view_financial', 'guarantors:view'],
  collateral: ['reports:view_financial', 'collateral:view'],
};

describe('the reporting routes', () => {
  const sections = listDirs(REPORTS_DIR);

  it('covers every section that exists, with nothing undeclared', () => {
    // A new report added without an entry here fails, rather than shipping
    // unasserted.
    expect([...sections].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('declares only capabilities that exist', () => {
    for (const [section, needs] of Object.entries(EXPECTED)) {
      for (const permission of needs) {
        expect(PERMISSIONS as readonly string[], `${section}: ${permission}`).toContain(
          permission,
        );
      }
    }
  });

  it.each(Object.keys(EXPECTED))(
    'guards the %s page with the registry\u2019s own capability list',
    (section) => {
      const source = read(join(REPORTS_DIR, section, 'page.tsx'));

      // A report page guards itself with one `guardReportPage` call that takes
      // every capability it needs, checks them in turn, and then consumes the
      // report read budget — which is the other reason that function exists.
      //
      // Phase 16 made the list it passes `REPORTS.<id>.needs` rather than a
      // literal, in every page. That is what this asserts, and it is stronger
      // than matching the literals: a page and its export route now read the
      // *same object*, so neither can drift behind the other, and the list
      // itself is pinned against `EXPECTED` by the assertion above.
      expect(source, `${section} page: guardReportPage call`).toMatch(
        new RegExp(
          `guardReportPage\\(\\s*reportHref\\('${section}'\\),\\s*REPORTS\\.${section}\\.needs\\s*\\)`,
        ),
      );
    },
  );

  it.each(Object.entries(EXPECTED))(
    'declares the %s report\u2019s capabilities in the registry, exactly',
    (section, needs) => {
      // The registry is now the single declaration, so this is where the
      // expectation is pinned. `toStrictEqual` rather than `toContain`: a
      // report that quietly gained a capability would be a widening nobody
      // reviewed, and one that lost one would be the defect this file exists
      // for.
      expect([...REPORTS[section as ReportId].needs]).toStrictEqual([...needs]);
    },
  );

  it.each(Object.keys(EXPECTED))(
    'routes the %s export through the shared handler, under its own id',
    (section) => {
      const source = read(join(REPORTS_DIR, section, 'export', 'route.ts'));

      // The whole route. It cannot carry a weaker capability list than its
      // page, because it does not carry one at all: `reportExportRoute` reads
      // `REPORTS[id].needs` and calls `guardExport` with it. What this checks
      // is the one thing the route still decides — that it passes *its own*
      // id, so `/reports/arrears/export` cannot serve the clients report.
      expect(source, `${section} export`).toContain(`reportExportRoute('${section}')`);
      expect(source, `${section} export`).not.toContain('guardExport');
    },
  );

  it('checks the capability in the shared handler, once, for every report', () => {
    const source = read(join(process.cwd(), 'lib', 'reports', 'export.ts'));

    expect(source).toContain('guardExport(definition.needs)');
    expect(source).toContain('if (!guard.ok) return guard.response');
  });

  it('gives every section an export, so no report is a dead end', () => {
    for (const section of sections) {
      expect(
        () => read(join(REPORTS_DIR, section, 'export', 'route.ts')),
        section,
      ).not.toThrow();
    }
  });

  it('never grants a report on dashboard:view', () => {
    // The defect this project has been told about three times: Phase 3 on
    // /clients, Phase 6 on /payments, and §98 for reports.
    for (const section of sections) {
      const source = read(join(REPORTS_DIR, section, 'page.tsx'));
      expect(source, section).not.toContain("'dashboard:view'");
    }

    expect(permissionForPath(ROUTES.reports)).not.toBe('dashboard:view');
  });

  it('puts the reporting index behind the operational capability', () => {
    const source = read(join(REPORTS_DIR, 'page.tsx'));

    expect(source).toContain("'reports:view_operational'");
    // Phase 9: the index guards itself through `guardReportPage`, which runs
    // the capability check and then consumes the report read budget.
    expect(source).toContain('guardReportPage(');
  });

  it('exports no mutation from any report route', () => {
    // §102 and §139: reporting is a reading surface. A route handler exporting
    // POST, PUT, PATCH or DELETE under /reports would be a write surface
    // nobody asked for. Matched on the export rather than on a declaration
    // style, because a handler can be a function or a const.
    for (const section of sections) {
      const source = read(join(REPORTS_DIR, section, 'export', 'route.ts'));

      expect(source, section).toMatch(/export (const|async function) GET\b/);
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(source, `${section}: ${verb}`).not.toMatch(
          new RegExp(`export (const|async function) ${verb}\\b`),
        );
      }
    }
  });

  it('builds every export response through the one shared helper', () => {
    // No route builds a response at all now, which is the strongest form of
    // this assertion: the content type, the attachment disposition,
    // `no-store` and `nosniff` are set once in the handler and cannot be
    // forgotten by a report that is added later.
    for (const section of sections) {
      const source = read(join(REPORTS_DIR, section, 'export', 'route.ts'));
      expect(source, section).not.toContain('new Response(');
    }

    const handler = read(join(process.cwd(), 'lib', 'reports', 'export.ts'));

    expect(handler).toContain('csvResponse(');
    expect(handler).toContain('pdfResponse(');

    // Both formats carry the same four headers, for the same reasons.
    for (const header of [
      'application/pdf',
      'content-disposition',
      'x-content-type-options',
      'no-store',
    ]) {
      expect(handler, header).toContain(header);
    }
  });

  it('gives every report both a spreadsheet and a document', () => {
    // A branded PDF is not an alternative to the CSV — the two answer
    // different needs. The file is for totalling; the document is what gets
    // printed, signed off and handed across a desk. Every report produces
    // both, from the same rows and the same fields.
    const handler = read(join(process.cwd(), 'lib', 'reports', 'export.ts'));

    expect(handler).toContain("=== 'pdf' ? 'pdf' : 'csv'");
    expect(handler).toContain('renderReportPdf(');
    // And the PDF reads the same `fields` the CSV does, rather than its own
    // column list, which is what stops the two disagreeing.
    expect(handler).toContain('csvColumns(fields)');
  });

  it('guards a statement with the capability of the record it states', () => {
    const staff = read(join(APP, 'loans', '[loanId]', 'statement', 'page.tsx'));
    expect(staff).toContain("'loans:view'");

    const portal = read(
      join(process.cwd(), 'app', '(portal)', 'portal', 'loans', '[loanId]', 'page.tsx'),
    );
    expect(portal).toContain("'portal:view'");
    // And checks the loan is the borrower's own, as a second layer above the
    // policy that actually decides it.
    expect(portal).toContain('notFound()');
  });

  it('uses no privileged client anywhere in the reporting surface', () => {
    // §94 and §95: a report is business-wide only because the caller is
    // entitled to every row in it. A service-role read would make Row Level
    // Security irrelevant, which is the one thing that must not happen here.
    const files: string[] = [join(REPORTS_DIR, 'page.tsx')];

    for (const section of sections) {
      files.push(join(REPORTS_DIR, section, 'page.tsx'));
      files.push(join(REPORTS_DIR, section, 'export', 'route.ts'));
    }

    files.push(join(process.cwd(), 'lib', 'data', 'reports.ts'));
    files.push(join(process.cwd(), 'lib', 'data', 'dashboard.ts'));
    files.push(join(process.cwd(), 'app', '(app)', 'page.tsx'));

    for (const file of files) {
      // Comments are stripped first: several of these files *discuss*
      // `service_role` — explaining that the database refuses it too — and a
      // test that could not tell a sentence from a call would punish the
      // documentation.
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

      expect(source, file).not.toContain('createSupabasePrivilegedClient');
      expect(source, file).not.toContain('service_role');
      expect(source, file).not.toContain('SUPABASE_SECRET_KEY');
      expect(source, file).not.toMatch(/privileged/i);
    }
  });
});
