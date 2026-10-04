import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The rate limit counter, against a real PostgreSQL.
 *
 * The interesting properties are concurrency and isolation, and neither can
 * be checked by reading the SQL: whether two simultaneous requests both get
 * counted, and whether one person's budget can be spent by another.
 */
const describeDb = hasDatabase ? describe : describe.skip;

afterAll(async () => {
  await closePool();
});

if (!hasDatabase) {
  describe('rate limit suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Verdict {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

const key = (seed: string): string =>
  seed
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0');

async function consume(
  bucket: string,
  action: string,
  limit: number,
  windowSeconds: number,
): Promise<Verdict> {
  return await queryOne<Verdict>(
    'select * from public.consume_rate_limit($1, $2, $3, $4)',
    [key(bucket), action, limit, windowSeconds],
  );
}

describeDb('consume_rate_limit', () => {
  beforeEach(async () => {
    await query('delete from public.rate_limit_counters');
  });

  it('allows requests up to the limit and refuses the next one', async () => {
    const bucket = 'aaa1';

    expect((await consume(bucket, 'test', 3, 60)).allowed).toBe(true);
    expect((await consume(bucket, 'test', 3, 60)).allowed).toBe(true);
    expect((await consume(bucket, 'test', 3, 60)).allowed).toBe(true);

    const refused = await consume(bucket, 'test', 3, 60);
    expect(refused.allowed).toBe(false);
    expect(refused.retry_after_seconds).toBeGreaterThan(0);
  });

  it('reports what is left, so a caller is never surprised', async () => {
    const bucket = 'bbb2';

    expect((await consume(bucket, 'test', 3, 60)).remaining).toBe(2);
    expect((await consume(bucket, 'test', 3, 60)).remaining).toBe(1);
    expect((await consume(bucket, 'test', 3, 60)).remaining).toBe(0);
    expect((await consume(bucket, 'test', 3, 60)).remaining).toBe(0);
  });

  it('keeps one bucket out of another"s budget', async () => {
    // The property that makes a per-profile key safe: one cashier's busy
    // morning must not throttle the cashier beside them.
    await consume('ccc3', 'test', 1, 60);
    expect((await consume('ccc3', 'test', 1, 60)).allowed).toBe(false);

    expect((await consume('ddd4', 'test', 1, 60)).allowed).toBe(true);
  });

  it('starts a fresh window once the old one closes', async () => {
    const bucket = 'eee5';

    await consume(bucket, 'test', 1, 1);
    expect((await consume(bucket, 'test', 1, 1)).allowed).toBe(false);

    // Move the window into the past rather than sleeping: the behaviour under
    // test is the rollover, not the clock.
    await query(
      `update public.rate_limit_counters
          set window_started_at = window_started_at - interval '10 seconds'
        where bucket_key = $1`,
      [key(bucket)],
    );

    expect((await consume(bucket, 'test', 1, 1)).allowed).toBe(true);
  });

  it('counts every request when several arrive at once', async () => {
    // The failure this guards against is two requests both reading zero and
    // both writing one, which would double every limit under load. The
    // counter is a single INSERT … ON CONFLICT so the row lock serialises
    // them.
    const bucket = 'fff6';

    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => consume(bucket, 'test', 5, 60)),
    );

    expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(5);

    const row = await queryOne<{ request_count: number }>(
      'select request_count from public.rate_limit_counters where bucket_key = $1',
      [key(bucket)],
    );
    expect(Number(row.request_count)).toBe(20);
  });

  it('refuses a limit that would permit nothing', async () => {
    await expect(consume('ggg7', 'test', 0, 60)).rejects.toThrow(/at least one/i);
  });

  it('stores no identity', async () => {
    // A dump of this table should say that something was limited, not who was
    // trying to sign in as whom.
    await consume('hhh8', 'auth.sign-in', 5, 60);

    const rows = await query<{ bucket_key: string; action: string }>(
      'select bucket_key, action from public.rate_limit_counters',
    );

    for (const row of rows) {
      expect(row.bucket_key).toMatch(/^[0-9a-f]{64}$/);
      // The action names an endpoint, which is not personal.
      expect(row.action).toBe('auth.sign-in');
    }
  });
});

describeDb('the counter table itself', () => {
  it('is readable by nobody', async () => {
    // RLS with no policies denies everything. The REVOKE is what makes that
    // meaningful, because Supabase grants broadly in `public` by default.
    const rows = await query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'rate_limit_counters'
          and grantee in ('anon', 'authenticated')`,
    );

    expect(rows).toEqual([]);
  });

  it('has row level security enabled and no policies', async () => {
    const enabled = await queryOne<{ relrowsecurity: boolean }>(
      `select c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'rate_limit_counters'`,
    );
    expect(enabled.relrowsecurity).toBe(true);

    const policies = await query<{ polname: string }>(
      `select p.polname
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relname = 'rate_limit_counters'`,
    );
    expect(policies).toEqual([]);
  });
});

describeDb('purge_expired_rate_limits', () => {
  beforeEach(async () => {
    await query('delete from public.rate_limit_counters');
  });

  it('deletes windows that closed long ago', async () => {
    await consume('iii9', 'test', 5, 60);

    await query(
      `update public.rate_limit_counters
          set window_started_at = window_started_at - interval '1 day'`,
    );

    const deleted = await queryOne<{ purge_expired_rate_limits: number }>(
      'select public.purge_expired_rate_limits()',
    );
    expect(Number(deleted.purge_expired_rate_limits)).toBe(1);
  });

  it('never deletes a window that is still counting', async () => {
    // Deleting a live counter would hand whoever is being limited a fresh
    // budget, which is worse than leaving a stale row behind.
    await consume('jjj0', 'test', 5, 3600);

    const deleted = await queryOne<{ purge_expired_rate_limits: number }>(
      'select public.purge_expired_rate_limits()',
    );
    expect(Number(deleted.purge_expired_rate_limits)).toBe(0);

    const remaining = await query('select 1 from public.rate_limit_counters');
    expect(remaining).toHaveLength(1);
  });
});
