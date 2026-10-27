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

  it('keeps every chunk the application has under 635 KB gzipped in total', () => {
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
    // ## 545 → 550, for Polytos Phase 3 member lending
    //
    // That phase is this one, and the case is the smallest of the three:
    //
    //   - **No new dependency.** Nothing was added to `package.json`, and the
    //     120 KB largest-chunk assertion above — the one that actually catches
    //     a library creeping in — is untouched. The largest chunk in fact
    //     *fell*, from 90 KB to 72 KB, because the re-split below moved weight
    //     out of it.
    //   - **Five kilobytes, spread over twelve chunks.** 70 chunks became 82
    //     and the measured total went 542 → 547, so the growth is well under
    //     half a kilobyte per chunk. Three new client components arrived — the
    //     eligibility register, the member loan register and the application
    //     form — and each is built from the shared `DataTable`, `Money` and
    //     `Register*` primitives rather than from markup of its own, which is
    //     why a whole module's screens cost this little.
    //   - **What a page costs did not move.** That is the figure that is
    //     somebody's airtime, and it is asserted in a real browser by
    //     `tests/e2e/specs/performance.spec.ts` against unchanged ceilings.
    //
    // 550 leaves about the same headroom over the measured 547 as 545 left
    // over 542. The next phase to cross it still has to make its own case.
    //
    // ## 550 → 635, for Polytos Phase 4 benefits and meetings
    //
    // This is a far bigger jump than the three above — 84 KB against five —
    // so it needs a better case than they did, and the honest one starts by
    // saying what the previous raises could not: **this phase is thirteen
    // screens, not three.**
    //
    //   - **No new dependency.** `package.json` is untouched, and the
    //     assertions that actually catch a library creeping in — the chart,
    //     date and utility list above, and the 120 KB largest-chunk ceiling —
    //     both pass unchanged. The largest chunk did not move: 72 KB before
    //     this phase, 72 KB after.
    //   - **Fifteen chunks for fifteen interactive components.** 82 chunks
    //     became 97. Every one of the new ones is a screen that cannot be a
    //     Server Component: a register whose filters live in the URL, a form
    //     driving a Server Action through `useActionState`, a panel that
    //     reveals a reason field before it submits. The other sixteen Phase 4
    //     components — every badge, every read-only panel, the whole claim
    //     facts page, the eligibility list, the assessment snapshot, both
    //     reports — ship no JavaScript at all.
    //   - **Five and a half kilobytes a chunk, which is what a form costs.**
    //     The claim forms carry a bill parser, a three-reading admission
    //     preview and a half-up rate calculation; the attendance register
    //     carries a per-member correction flow. They are built from the same
    //     `DataTable`, `Money`, `Field` and `Register*` primitives as every
    //     other screen — which is why thirteen screens cost 84 KB and not
    //     three times that.
    //   - **What a page costs did not move, and is now asserted on this
    //     section too.** `/benefits`, `/benefits/claims` and `/meetings`
    //     joined the budgeted pages in
    //     `tests/e2e/specs/performance.spec.ts`, against the same unchanged
    //     ceilings every other page is held to. That is the figure that is
    //     somebody's airtime, and raising a total without adding the new
    //     routes to the per-page budget would have been raising it on trust.
    //
    // 635 leaves about four kilobytes over the measured 631 — tighter
    // headroom than the earlier raises, deliberately, because a phase that
    // adds 84 KB should not also be handed room for the next one.
    //
    // It is not what a page costs. No page loads all seventy: a measured
    // page transfers 155-165 KB of JavaScript, and that figure — the one
    // that is actually somebody's airtime — is asserted in a real browser by
    // `tests/e2e/specs/performance.spec.ts`, because only a browser knows
    // which chunks a route pulls.
    const total = chunks.reduce((sum, path) => sum + gzippedSize(path), 0);

    expect(Math.round(total / 1024)).toBeLessThanOrEqual(635);
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
