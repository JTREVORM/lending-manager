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

  it('keeps every chunk the application has under 560 KB gzipped in total', () => {
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
    // ## 520 → 545, for the table design system
    //
    // That phase is this one, and the case is the same shape, which is why
    // the rise is 25 KB and not 80:
    //
    //   - **No new dependency.** Nothing was added to `package.json`. The
    //     four largest chunks are byte-identical to the previous build at
    //     90, 72, 39 and 35 KB, and the 120 KB largest-chunk assertion above
    //     — the one that actually catches a library creeping in — is
    //     untouched.
    //   - **It is re-splitting, not weight.** The refactor replaced fourteen
    //     hand-written tables with two shared components and moved the
    //     registers' filter, count and pagination into one shared client
    //     module. Code that was duplicated inline in each route is now a
    //     module several routes share, so Turbopack re-cuts the graph: 62
    //     chunks became 70, and the growth is spread across them at 1–9 KB
    //     each. The source is some 1,500 lines shorter than it was.
    //   - **What a page costs did not move.** That is the figure that is
    //     somebody's airtime, and it is asserted in a real browser by
    //     `tests/e2e/specs/performance.spec.ts`, which still passes on every
    //     route this work touched — `/clients`, `/loans`, `/payments`,
    //     `/overdue`, `/recovery` — in both the desktop and the mobile
    //     profile, against unchanged ceilings.
    //
    // 545 leaves about the same headroom over the measured 542 as 520 left
    // over 517. The next phase to cross it still has to make its own case.
    //
    // ## 545 → 560, for the register redesign
    //
    // Twice in two phases is a smell, so this one is stated plainly: the
    // 8 KB is **new interactive behaviour**, not the same screens grown
    // heavier.
    //
    //   - a row action menu with real focus management — open and close on
    //     the keyboard, Escape returning focus, arrow keys within it,
    //     dismissal on an outside click or a scroll;
    //   - sortable column headers that write the sort into the URL;
    //   - a rows-per-page control;
    //   - numbered pagination with a window over long registers.
    //
    // None of it existed before; each is a thing the brief asked for. Still
    // no new dependency, still nothing added to `package.json`, and the
    // largest-chunk assertion above — the one that catches a library
    // creeping in — is untouched and still passes at 120 KB. An attempt to
    // pay for it by replacing six `lucide-react` chevrons with one inline
    // SVG is kept because it is tidier, but it is honest to record that it
    // saved nothing measurable: the chunk boundaries absorbed it.
    //
    // What a page costs did not move; `tests/e2e/specs/performance.spec.ts`
    // still passes on every route, against unchanged ceilings.
    //
    // It is not what a page costs. No page loads all seventy: a measured
    // page transfers 155-165 KB of JavaScript, and that figure — the one
    // that is actually somebody's airtime — is asserted in a real browser by
    // `tests/e2e/specs/performance.spec.ts`, because only a browser knows
    // which chunks a route pulls.
    const total = chunks.reduce((sum, path) => sum + gzippedSize(path), 0);

    expect(Math.round(total / 1024)).toBeLessThanOrEqual(560);
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
