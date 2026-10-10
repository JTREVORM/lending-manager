import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

/**
 * What ends up in the browser.
 *
 * ## Why this is asserted and not just measured
 *
 * The people using this system are on phones, on mobile data, in Uganda. Every
 * kilobyte is somebody's airtime, and a bundle only ever grows by accident —
 * one import of a date library, one chart package, one `export *` from a
 * server module. A number in a report is forgotten by the next phase; a test
 * fails.
 *
 * It needs `.next/static` to exist, so it skips when there is no build rather
 * than failing: `npm run verify` builds before this runs, and a developer
 * running the suite alone should not be told their tests are broken.
 *
 * ## The budget
 *
 * Measured gzipped, because that is what crosses the network. The figures
 * recorded when this was written: the four largest chunks were 88, 71, 38 and
 * 35 KB gzipped, 410 KB for all forty, and 155-165 KB of JavaScript on a
 * measured page load. The ceilings below leave room to work and not room to
 * drift.
 */

const CHUNKS = join(process.cwd(), '.next/static/chunks');
const describeBundle = existsSync(CHUNKS) ? describe : describe.skip;

function gzippedSize(path: string): number {
  // `gzipSync` rather than shelling out, so this measures the same thing on
  // every machine.
  return gzipSync(readFileSync(path), { level: 9 }).length;
}

const chunks = existsSync(CHUNKS)
  ? globSync('**/*.js', { cwd: CHUNKS }).map((name) => join(CHUNKS, name))
  : [];

describeBundle('the browser bundle', () => {
  it('ships no Supabase client runtime at all', () => {
    // Not a size claim — an architectural one, and the strongest single fact
    // about this bundle.
    //
    // Every read and write in this application is a Server Component or a
    // Server Action, so nothing in the browser needs a Supabase client. The
    // unused `lib/supabase/client.ts` was removed in Phase 9 to make the
    // session cookie `HttpOnly`, and removing it also dropped GoTrue,
    // PostgREST's query builder and the Realtime client out of the bundle
    // entirely. If any of them reappears, something in a Client Component has
    // started talking to the database directly — which would also break
    // authentication, because it cannot read the session.
    for (const marker of [
      'GoTrueClient',
      'PostgrestQueryBuilder',
      'RealtimeChannel',
      'SupabaseAuthClient',
      'createBrowserClient',
    ]) {
      const guilty = chunks.filter((path) => readFileSync(path, 'utf8').includes(marker));
      expect(
        guilty.map((p) => p.split('/').pop()),
        marker,
      ).toEqual([]);
    }
  });

  it('carries no chart, date or utility library it does not need', () => {
    // §94. A bar is a div with a width; a date is a string in the business
    // timezone. Each of these would be a large dependency for a small need.
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    const dependencies = Object.keys(manifest.dependencies ?? {});

    for (const library of [
      'recharts',
      'chart.js',
      'd3',
      'victory',
      'echarts',
      'moment',
      'dayjs',
      'date-fns',
      'luxon',
      'lodash',
      'axios',
    ]) {
      expect(dependencies, library).not.toContain(library);
    }
  });

  it('keeps the largest single chunk under 120 KB gzipped', () => {
    const largest = chunks
      .map((path) => ({ path, size: gzippedSize(path) }))
      .sort((a, b) => b.size - a.size)[0];

    expect(largest).toBeDefined();
    expect(
      Math.round((largest?.size ?? 0) / 1024),
      `largest chunk is ${largest?.path.split('/').pop() ?? '?'}`,
    ).toBeLessThanOrEqual(120);
  });

  it('keeps every chunk the application has under 520 KB gzipped in total', () => {
    // The sum of every chunk, which is the ceiling on what the application
    // could *ever* ask a phone to download across a whole session. It was
    // 410 KB over forty chunks when this was written, and 506 KB over
    // fifty-seven after Phase 14 added four routes and ten components for
    // Debt & Security.
    //
    // Raised from 480 to 520 with that phase, deliberately and not far: the
    // growth was spread across small per-route chunks with no new dependency
    // behind it — the largest chunk is unchanged and its own assertion still
    // holds — and a whole module's screens genuinely add to this total. The
    // headroom is for one more phase, not for four, so the next phase to
    // cross it has to make its own case.
    //
    // It is not what a page costs. No page loads all forty: a measured page
    // transfers 155-165 KB of JavaScript, and that figure — the one that is
    // actually somebody's airtime — is asserted in a real browser by
    // `tests/e2e/specs/performance.spec.ts`, because only a browser knows
    // which chunks a route pulls.
    const total = chunks.reduce((sum, path) => sum + gzippedSize(path), 0);

    expect(Math.round(total / 1024)).toBeLessThanOrEqual(520);
  });

  it('emits no source map for the browser', () => {
    // A browser source map publishes the application's own source, including
    // the shape of every Server Action and permission check, to anyone who
    // opens devtools. `next.config.ts` turns them off; this is the assertion
    // that it worked.
    const maps = globSync('**/*.js.map', { cwd: CHUNKS });
    expect(maps).toEqual([]);
  });

  it('every chunk is a file the browser can actually fetch', () => {
    // A zero-byte chunk is a build that half-failed.
    for (const path of chunks) {
      expect(statSync(path).size, path).toBeGreaterThan(0);
    }
  });
});
