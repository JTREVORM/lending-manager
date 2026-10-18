import { describe, expect, it } from 'vitest';

import { allWithLimit } from '@/lib/async/with-limit';

/**
 * The ceiling on how much the dashboard asks the database for at once.
 *
 * ## What this is guarding
 *
 * The dashboard issued eleven reads with `Promise.all`, which has no ceiling.
 * On a database where CPU is the constraint that bought nothing — wall clock
 * was flat from a limit of 1 to 6 — while making each individual statement up
 * to eight times slower, until PostgreSQL cancelled them one at a time with
 * `57014` against the `authenticated` role's eight-second budget.
 *
 * So the properties that matter here are not incidental. **The ceiling must
 * actually hold**, or the cancellations come back. **Order must be
 * preserved**, because nine results are destructured positionally and a
 * mis-ordered result would put the collection sheet's rows in the portfolio
 * summary's variable. And **tasks must start in order**, because with a
 * ceiling the order decides which reads get the quiet database — the
 * dashboard's headline figures are listed first for that reason.
 */
describe('allWithLimit', () => {
  /** A task that records when it starts and stops, then resolves to `value`. */
  function tracked<T>(
    value: T,
    ms: number,
    log: { started: unknown[]; inFlight: number; peak: number },
  ) {
    return async () => {
      log.started.push(value);
      log.inFlight += 1;
      log.peak = Math.max(log.peak, log.inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.inFlight -= 1;
      return value;
    };
  }

  it('never exceeds the limit', async () => {
    const log = { started: [] as unknown[], inFlight: 0, peak: 0 };
    const tasks = Array.from({ length: 11 }, (_, i) => tracked(i, 5, log));

    await allWithLimit(tasks, 3);

    expect(log.peak).toBe(3);
  });

  it('runs everything, in order, and returns results positionally', async () => {
    const log = { started: [] as unknown[], inFlight: 0, peak: 0 };

    // Deliberately uneven durations: if the implementation returned results in
    // completion order rather than input order, this is where it shows.
    const results = await allWithLimit(
      [tracked('a', 30, log), tracked('b', 1, log), tracked('c', 15, log)],
      2,
    );

    expect(results).toEqual(['a', 'b', 'c']);
    expect(log.started).toEqual(['a', 'b', 'c']);
  });

  it('keeps each task’s own result type', async () => {
    // The dashboard destructures nine differently-typed results from one call,
    // so the tuple must survive inference rather than widening to a union.
    const [summary, rows, count] = await allWithLimit(
      [
        () => Promise.resolve({ loans: 35 } as const),
        () => Promise.resolve(['a', 'b']),
        () => Promise.resolve(7),
      ],
      2,
    );

    expect(summary.loans).toBe(35);
    expect(rows).toHaveLength(2);
    expect(count + 1).toBe(8);
  });

  it('is serial at a limit of one', async () => {
    const log = { started: [] as unknown[], inFlight: 0, peak: 0 };
    await allWithLimit(
      Array.from({ length: 5 }, (_, i) => tracked(i, 2, log)),
      1,
    );

    expect(log.peak).toBe(1);
  });

  it('does not stall when the limit exceeds the number of tasks', async () => {
    const log = { started: [] as unknown[], inFlight: 0, peak: 0 };
    const results = await allWithLimit([tracked('only', 1, log)], 11);

    expect(results).toEqual(['only']);
    expect(log.peak).toBe(1);
  });

  it('resolves to nothing for no tasks', async () => {
    await expect(allWithLimit([], 3)).resolves.toEqual([]);
  });

  it('refuses a limit that is not a positive integer', async () => {
    // A zero or negative limit would start no workers and hang for ever, which
    // on a page means a request that never answers. Fail loudly instead.
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(allWithLimit([() => Promise.resolve(1)], bad)).rejects.toThrow(
        RangeError,
      );
    }
  });

  it('rejects when a task rejects, like Promise.all', async () => {
    await expect(
      allWithLimit(
        [() => Promise.resolve(1), () => Promise.reject(new Error('read failed'))],
        2,
      ),
    ).rejects.toThrow('read failed');
  });
});
