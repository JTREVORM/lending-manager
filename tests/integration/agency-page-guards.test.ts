/**
 * Every Agency page guards itself with the capability its route declares.
 *
 * ## The drift this exists to catch
 *
 * A capability for one screen is restated in up to four places: the route map
 * in `lib/auth/routing.ts`, the page's own `guardPermission`, the server
 * action's `authorize`, and the navigation entry. `navigation.test.tsx`
 * already compares the rail against the route map, and
 * `report-routes.test.ts` compares pages against the registry for `/reports`.
 * Nothing compared an *Agency* page's own guard against its route.
 *
 * It cost exactly what you would expect. `/agency/staffing` was moved from
 * `agency:providers` to `agency:settlements` so a Manager could reach the
 * screen the database admits them to — the route map, both actions and both
 * rail entries were changed, and the page's own `guardPermission` was not.
 * Three layers agreed, the fourth refused, and the Manager stayed locked out.
 * Every test passed: the page guard is a string argument nothing compares.
 *
 * ## Why source-level
 *
 * The guard runs inside a server component against a live session. Rendering
 * every Agency page as every role would be a browser suite, and the thing
 * worth asserting is narrower: the two strings agree. So this reads the files,
 * as the migrations and report-route tests do.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';

const AGENCY = join(process.cwd(), 'app', '(app)', 'agency');

/** Every page file under the Agency module. */
function pages(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...pages(path));
    } else if (entry === 'page.tsx') {
      out.push(path);
    }
  }
  return out;
}

/** Comments stripped, so a note quoting a guard is not read as one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The ROUTES key → path map, so a guard's first argument can be resolved. */
const ROUTE_PATHS = new Map<string, string>(
  Object.entries(ROUTES).map(([key, value]) => [key, String(value)]),
);

describe('Agency page guards', () => {
  const files = pages(AGENCY);

  it('finds the Agency pages, so a passing run is not vacuous', () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it('guards each page with exactly the capability its route declares', () => {
    const mismatches: string[] = [];
    let compared = 0;

    for (const file of files) {
      const text = code(readFileSync(file, 'utf8'));
      // `guardPermission(ROUTES.someKey, 'some:capability')`
      const pattern =
        /guardPermission\(\s*ROUTES\.([A-Za-z0-9_]+)\s*,\s*'([a-z_]+:[a-z_]+)'/g;
      for (const match of text.matchAll(pattern)) {
        const [, key, declared] = match;
        if (key === undefined || declared === undefined) continue;
        const path = ROUTE_PATHS.get(key);
        if (path === undefined) {
          mismatches.push(`${file}: ROUTES.${key} is not a route`);
          continue;
        }
        const expected = permissionForPath(path);
        compared += 1;
        if (expected !== declared) {
          mismatches.push(
            `${file.replace(process.cwd(), '.')}: guards '${declared}' but ${path} declares '${String(expected)}'`,
          );
        }
      }
    }

    expect(compared, 'no Agency page guard was compared at all').toBeGreaterThanOrEqual(
      15,
    );
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });
});
