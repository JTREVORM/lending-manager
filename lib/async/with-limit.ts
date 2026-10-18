/**
 * Run async work with a ceiling on how much is in flight at once.
 *
 * ## Why a dashboard needs this
 *
 * `Promise.all` has no ceiling: hand it eleven reads and all eleven are issued
 * at once. That is the right shape when the work is waiting on eleven
 * independent things. It is the wrong shape when all eleven are queued behind
 * one scarce resource, and the dashboard's reads are all queued behind the same
 * database CPU.
 *
 * Measured on the harness with PostgreSQL pinned to a single core, running the
 * eleven reads an Owner's dashboard issues, each worker reusing one connection
 * the way PostgREST's pool does:
 *
 *   limit   slowest statement   sum of statement time   wall clock
 *      1           66 ms               260 ms            260 ms
 *      2          134 ms               569 ms            285 ms
 *      3          224 ms              1012 ms            346 ms
 *      4          352 ms              1523 ms            425 ms
 *      6          381 ms              2108 ms            381 ms
 *     11          395 ms              2543 ms            395 ms
 *
 * Three things to read off that, none of them intuitive. **Serial is the
 * fastest.** Every level of concurrency finishes the page later than running
 * the reads one at a time, because the database is the constraint and
 * dividing one core's attention eleven ways does not create more of it. **The
 * slowest individual statement grows sixfold**, 66 ms to 395 ms. And **the
 * database's own total work-time grows nearly tenfold**, 260 ms to 2543 ms,
 * for exactly the same eleven results — that is contention, billed to the
 * instance.
 *
 * The second line is what broke production. PostgreSQL's `statement_timeout`
 * judges each statement on its own, and the `authenticated` role has eight
 * seconds. The dashboard's reads are not individually slow; they were made
 * slow by being run together, and then cancelled one by one with `57014`.
 * Production's `pg_stat_statements` shows the same shape at scale: 1.6-4.9 s
 * mean per statement with maxima at 7.1 and 7.3 s, against that eight-second
 * budget, and `shared_blks_read = 0` throughout — no I/O, pure contention for
 * CPU.
 *
 * So the fan-out was costing latency *and* correctness, and buying nothing.
 *
 * ## Why not simply `for ... await`
 *
 * Because a limit of one gives up the parallelism that does help when the
 * database is not the constraint. On the same harness *without* the single-core
 * pin, wall clock falls from 528 ms at a limit of 1 to 126 ms at a limit of 4
 * — so on a provisioned instance the fan-out is worth having. A small limit
 * keeps the page safe on a scarce tier without pinning it to serial
 * everywhere.
 */

/**
 * Resolve `tasks` with at most `limit` of them running at once, preserving
 * order and each task's own result type.
 *
 * Tasks are started in the order given, so the ones that matter most should
 * come first: with a ceiling, order decides who runs while the budget is
 * tightest. The result array matches the input positionally, like
 * `Promise.all`.
 *
 * A task that rejects rejects the whole call, again like `Promise.all`. The
 * dashboard's readers do not reject — they report failure in their return
 * value — so this stays a straightforward swap there.
 */
export async function allWithLimit<T extends readonly (() => Promise<unknown>)[]>(
  // `readonly [...T]` rather than `T`: it makes TypeScript infer the argument
  // as a tuple instead of widening it to an array of the union of its element
  // types, which is what keeps each task's own result type in the output.
  tasks: readonly [...T],
  limit: number,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `allWithLimit needs a positive integer limit, got ${String(limit)}`,
    );
  }

  const results = new Array<unknown>(tasks.length);
  let next = 0;

  // One worker per slot, each taking the next unclaimed task. `next++` is safe
  // without a lock because this is a single-threaded event loop: the increment
  // completes before any await can interleave.
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;

      const task = tasks[index];
      if (task === undefined) return;

      results[index] = await task();
    }
  });

  await Promise.all(workers);

  // The mapped return type is the tuple of each task's awaited result, which
  // is exactly what was written positionally into `results`. TypeScript cannot
  // follow that through the worker loop, so the shape is asserted once here
  // rather than at each of the nine call sites.
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
