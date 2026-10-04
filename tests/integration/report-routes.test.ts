import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';
import { PERMISSIONS, type Permission } from '@/lib/permissions';

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
 * 3. The export route's `guardExport` — this test.
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

  it.each(Object.entries(EXPECTED))(
    'guards the %s page with every capability it needs',
    (section, needs) => {
      const source = read(join(REPORTS_DIR, section, 'page.tsx'));

      for (const permission of needs) {
        expect(source, `${section} page: ${permission}`).toContain(`'${permission}'`);
      }

      // One `guardPermission` call per capability, so a page needing two does
      // not check only the first.
      const guards = source.match(/guardPermission\(/g) ?? [];
      expect(guards.length, `${section} page guard count`).toBeGreaterThanOrEqual(
        needs.length,
      );
    },
  );

  it.each(Object.entries(EXPECTED))(
    'guards the %s export with the same capabilities as its page',
    (section, needs) => {
      const source = read(join(REPORTS_DIR, section, 'export', 'route.ts'));

      // One call, taking the whole list: a download is refused unless every
      // capability the page required is held.
      expect(source, `${section} export`).toContain('guardExport(');
      for (const permission of needs) {
        expect(source, `${section} export: ${permission}`).toContain(`'${permission}'`);
      }
      expect(source, `${section} export`).toContain(
        'if (!guard.ok) return guard.response',
      );
    },
  );

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
    expect(source).toContain('guardPermission(');
  });

  it('exports no mutation from any report route', () => {
    // §102 and §139: Phase 8 is a reading phase. A route handler exporting
    // POST, PUT, PATCH or DELETE under /reports would be a write surface
    // nobody asked for.
    for (const section of sections) {
      const source = read(join(REPORTS_DIR, section, 'export', 'route.ts'));

      expect(source, section).toContain('export async function GET');
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(source, `${section}: ${verb}`).not.toContain(
          `export async function ${verb}`,
        );
      }
    }
  });

  it('builds every export response through the one shared helper', () => {
    // So the content type, the attachment disposition, `no-store` and
    // `nosniff` are set in one place rather than remembered five times.
    for (const section of sections) {
      const source = read(join(REPORTS_DIR, section, 'export', 'route.ts'));

      expect(source, section).toContain('csvResponse(');
      expect(source, section).not.toContain('new Response(');
    }
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
