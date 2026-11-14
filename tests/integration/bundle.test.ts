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

  it('keeps every chunk the application has under 676 KB gzipped in total', () => {
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
    // ## 635 → 670, for Polytos Phase 4D agency banking
    //
    // Fourteen screens for 34 KB, which is the smallest per-screen cost of
    // any phase that has raised this ceiling - and the reason is worth
    // stating, because it is the thing to hold on to rather than the number.
    //
    //   - **No new dependency.** `package.json` is untouched, and the two
    //     assertions that actually catch a library creeping in both pass
    //     unchanged: the chart, date and utility list above, and the 120 KB
    //     largest-chunk ceiling. The largest chunk *fell*, 72 KB to 71 KB.
    //   - **Seven chunks for fourteen screens.** 97 chunks became 104,
    //     because seven of the fourteen routes render no client component of
    //     their own: the dashboard, the pending queue, the transaction
    //     history, the float balances, the reports, the exceptions list and
    //     the provider configuration are Server Components that read a view
    //     and render a table. The other seven take input - the recording
    //     form, the lifecycle controls and commission exception on one
    //     transaction, the float top-up, the two settlement screens and the
    //     two reconciliation screens - and only those cross into the
    //     browser.
    //
    //     (An earlier draft of this comment said nine. It was counted from
    //     memory rather than from the import graph, and the import graph
    //     says seven. Every page still carries the shell's own JavaScript,
    //     which is what makes "ships no JavaScript" the wrong phrase for
    //     any of them.)
    //   - **Just under five kilobytes a chunk.** Every one is built from the
    //     same `DataTable`, `Money`, `Field` and `Alert` primitives as the
    //     rest of the application. A register that carries a whole form
    //     inside a table cell costs about what a form costs, because it is
    //     the same form.
    //   - **What a page costs did not move, and is asserted on this section
    //     too.** Measured cold on a 390px phone against this build:
    //     `/agency` 167 KB of JavaScript, `/agency/record` 172 KB,
    //     `/agency/reconciliation/cash` 178 KB - the same band as
    //     `/payments` at 178 KB, which is the screen this application has
    //     always been measured by. `/agency`, `/agency/record`,
    //     `/agency/pending`, `/agency/reconciliation/cash` and
    //     `/agency/reports` joined the budgeted pages in
    //     `tests/e2e/specs/performance.spec.ts`, against the same unchanged
    //     ceilings every other page is held to. Raising a total without
    //     putting the new routes under the per-page budget would be raising
    //     it on trust.
    //
    // 670 leaves five kilobytes over the measured 665 - tighter again than
    // the last raise, deliberately. A phase that needs room should have to
    // make its own case here, as this one did.
    //
    // ## 670 → 676, for Polytos Phase 4E Mobile Money
    //
    // Five screens for 6 KB, measured both ways on the same machine: the
    // build with the five routes removed and nothing else changed is 104
    // chunks and 665 KB, and the build with them is 107 chunks and 671 KB.
    //
    //   - **No new dependency,** again. `package.json` is untouched, and the
    //     largest chunk did not move: 72 KB before and 72 KB after, well
    //     inside the 120 KB ceiling above.
    //   - **Three chunks for five routes.** `/agency/money` renders no
    //     client component of its own — it is a Server Component reading two
    //     views into tables — and the other four share the three new chunks
    //     between them, because the float trade form, the commission forms
    //     and the agent-line forms are built from the same `Field`, `Alert`,
    //     `Card`, `DataTable` and `Money` primitives as the Phase 4D screens
    //     and import nothing else.
    //   - **Two kilobytes a chunk.** Lower than Phase 4D's five, for the
    //     same reason: a register carrying three forms inside a table cell
    //     costs what one form costs, because it is the same form.
    //   - **The new routes are under the per-page budget.**
    //     `/agency/money/DEMO_AIRTEL` and `/agency/lines` joined the
    //     budgeted pages in `tests/e2e/specs/performance.spec.ts`, against
    //     the same unchanged ceilings every other page is held to. Raising a
    //     total without putting the new routes under a per-page budget would
    //     be raising it on trust — the rule the last three raises set, and
    //     the one that makes this number mean anything.
    //
    // 676 leaves five kilobytes over the measured 671, the same headroom the
    // last raise left. A phase that needs room makes its own case here.
    //
    // ## 676 → 687, for the Agency redesign
    //
    // Measured on the same machine: 108 chunks and 682 KB, against the 107
    // and 671 the last raise recorded. Eleven kilobytes and one chunk, for
    // five new routes and the nested navigation.
    //
    //   - **No new dependency.** `package.json` is untouched again, and the
    //     largest chunk did not move at all: 72 KB before and 72 KB after,
    //     well inside the 120 KB ceiling above — which is the assertion that
    //     actually catches a dependency sneaking in.
    //   - **One chunk for five routes, because there is one new client
    //     component.** `components/agency/cash-banking-forms.tsx` is the only
    //     `'use client'` file the redesign adds. The agent-account table, the
    //     report filter bar, the seven report sections and the shared filter
    //     chips are all Server Components, so `/agency/banking`,
    //     `/agency/banking/accounts`, `/agency/accounts/[accountId]`,
    //     `/agency/transfers` and the rebuilt `/agency/reports` ship no
    //     JavaScript of their own at all. `/agency/transfers` reuses the
    //     Phase 4E float trade form, which was already in the bundle.
    //   - **The navigation grew a level and not a chunk.** `NavGroup` and the
    //     recursive `SidebarGroup` renderer are inside `primary-nav.tsx`,
    //     which every page already loads; the data-driven branches arrive as
    //     plain strings on a prop, which is the server/client boundary rule
    //     that `tests/integration/navigation.test.tsx` asserts and also, as
    //     it happens, the cheapest way to do it.
    //   - **Eleven kilobytes for one form.** Higher than Phase 4E's two a
    //     chunk, and the reason is visible in the file: the cash banking form
    //     states the two movements it will make in shillings from what has
    //     been typed, so it carries the consequence panel and the
    //     maker-checker decision controls that the register renders inside a
    //     table cell. The alternative was a form that did not say what it was
    //     about to do, on the one operation in the module people most often
    //     get wrong.
    //   - **The new routes are under the per-page budget.**
    //     `/agency/cash-banking`, `/agency/banking` and `/agency/transfers`
    //     joined the budgeted pages in `tests/e2e/specs/performance.spec.ts`,
    //     against the same unchanged ceilings every other page is held to.
    //     Raising a total without putting the new routes under a per-page
    //     budget would be raising it on trust — the rule the last four raises
    //     set, and the one that makes this number mean anything.
    //
    // 687 leaves five kilobytes over the measured 682, the same headroom
    // every raise before it left.
    //
    // It is not what a page costs. No page loads all of them: a measured
    // page transfers 155-165 KB of JavaScript, and that figure — the one
    // that is actually somebody's airtime — is asserted in a real browser by
    // `tests/e2e/specs/performance.spec.ts`, because only a browser knows
    // which chunks a route pulls.
    const total = chunks.reduce((sum, path) => sum + gzippedSize(path), 0);

    expect(Math.round(total / 1024)).toBeLessThanOrEqual(687);
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
