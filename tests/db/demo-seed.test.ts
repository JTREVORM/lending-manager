import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The demonstration seeder, run for real.
 *
 * ## Why this is a database test and not a unit test
 *
 * The property worth proving is not that the script parses — it is that
 * running it twice against a real database with real triggers, real
 * constraints, real reference sequences and real journal balancing produces
 * the same database as running it once, **and posts no money the second time**.
 * Nothing short of actually running it twice establishes that.
 *
 * A seeder that doubled its deposits on a second run would be a seeder that
 * doubled a member's savings, and the person who noticed would be the member.
 *
 * ## It runs against the throwaway database, like every other test here
 *
 * `DATABASE_URL` points at the cluster the database project's global setup
 * rebuilt from the migrations. The seeder's own allow-list recognises it as
 * local; the same allow-list is what refuses every hosted project but one,
 * and those refusals are asserted below without any database being touched.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('demo seed suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const run = promisify(execFile);
const ENABLE_PHRASE = 'yes-seed-polytos-demo-data';

interface SeedResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function seed(env: Record<string, string | undefined> = {}): Promise<SeedResult> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', 'scripts/seed-demo.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        POLYTOS_SEED_DEMO: ENABLE_PHRASE,
        ...env,
      },
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/** Everything the seeder wrote, as one comparable snapshot. */
async function snapshot(): Promise<Record<string, string>> {
  const row = await queryOne<Record<string, string>>(
    `select
       (select count(*) from public.clients where full_name like 'DEMO%')::text
         as demo_clients,
       (select count(*) from public.memberships m
          join public.clients c on c.id = m.client_id
         where c.full_name like 'DEMO%')::text as demo_memberships,
       (select count(*) from public.savings_accounts)::text as accounts,
       (select count(*) from public.savings_transactions)::text as transactions,
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select count(*) from public.membership_fee_receipts)::text as receipts,
       (select coalesce(sum(amount) filter (where status = 'posted'), 0)::bigint
          from public.membership_fee_receipts)::text as fees,
       (select count(*) from public.savings_withdrawal_requests)::text as withdrawals,
       (select count(*) from public.journal_entries)::text as journal_entries,
       (select coalesce(sum(debit), 0)::bigint from public.journal_lines)::text
         as journal_debits,
       (select coalesce(sum(credit), 0)::bigint from public.journal_lines)::text
         as journal_credits,
       (select count(*) from public.membership_terms_acceptances)::text as acceptances`,
  );
  return row;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const first = await seed();

  if (first.code !== 0) {
    throw new Error(
      `The seeder failed on a clean database.\n${first.stdout}\n${first.stderr}`,
    );
  }
});

afterAll(async () => {
  if (!hasDatabase) return;
  await closePool();
});

// ===========================================================================
describeDb('the seeder refuses to run where it should not', () => {
  it('refuses without the enabling phrase, and writes nothing', async () => {
    const before = await snapshot();

    const attempt = await seed({ POLYTOS_SEED_DEMO: undefined });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('not enabled');
    expect(attempt.stderr).toContain('Nothing has been written');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a truthy value that is not the phrase', async () => {
    // Not `1`, not `true`, not `yes`. A phrase somebody has to mean to type,
    // so no CI job and no stray environment file turns this on by accident.
    for (const value of ['1', 'true', 'yes', 'YES-SEED-POLYTOS-DEMO-DATA']) {
      const attempt = await seed({ POLYTOS_SEED_DEMO: value });
      expect(attempt.code, value).not.toBe(0);
    }
  });

  it('refuses a Supabase project that is not on its allow-list', async () => {
    const before = await snapshot();

    const attempt = await seed({
      DATABASE_URL:
        'postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
    });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('not on this script');
    expect(attempt.stderr).toContain('allow-list');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a host it cannot identify at all', async () => {
    // The allow-list shape that matters: a target the script cannot name is
    // refused, rather than being given the benefit of the doubt. A deny-list
    // would have had to anticipate this host.
    const attempt = await seed({
      DATABASE_URL: 'postgresql://u:p@db.not-supabase.example:5432/postgres',
    });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('Cannot work out which Supabase project');
  });

  it('refuses a connection string that is not a URL', async () => {
    const attempt = await seed({ DATABASE_URL: 'host=localhost dbname=postgres' });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('not a URL');
  });

  it('refuses when there is no connection string', async () => {
    const attempt = await seed({ DATABASE_URL: '' });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('DATABASE_URL is not set');
  });
});

// ===========================================================================
describeDb('running it twice changes nothing', () => {
  it('posts no money and writes no row on the second run', async () => {
    const before = await snapshot();

    const second = await seed();

    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('Nothing new was written');

    // Every count and every total, identical. This is the whole point of the
    // file: a seeder that doubled its deposits would be a seeder that doubled
    // a member's savings.
    expect(await snapshot()).toEqual(before);
  });

  it('is still idempotent on a third run', async () => {
    // Twice could pass by accident — a guard that happens to catch the exact
    // state the first run leaves. Three times means the second run's state is
    // a fixed point, which is what idempotent means.
    const before = await snapshot();
    const third = await seed();

    expect(third.code, third.stderr).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});

// ===========================================================================
describeDb('what it seeded', () => {
  it('created six demonstration members, every one unmistakably synthetic', async () => {
    const members = await query<{ full_name: string; phone: string }>(
      `select full_name, phone from public.clients
        where full_name like 'DEMO%' order by full_name`,
    );

    expect(members).toHaveLength(6);

    for (const member of members) {
      // The three markers together. A name alone could be a coincidence; a
      // name in the reserved number range, with a DEMO prefix, could not be
      // mistaken for a real person's record.
      expect(member.full_name.startsWith('DEMO ')).toBe(true);
      expect(member.phone).toMatch(/^\+2567000001\d\d$/);
    }
  });

  it('reconciles: the subledger equals the 2100 ledger balance', async () => {
    const row = await queryOne<{ subledger: string; ledger: string }>(
      `select
         (select coalesce(sum(signed_amount), 0)::bigint
            from public.savings_transactions)::text as subledger,
         (select balance from public.ledger_account_balances where code = '2100')::text
           as ledger`,
    );

    expect(Number(row.subledger)).toBe(Number(row.ledger));
    expect(Number(row.subledger)).toBeGreaterThan(0);
  });

  it('balances every journal entry it posted', async () => {
    const unbalanced = await query(
      `select e.id
         from public.journal_entries e
         join public.journal_lines l on l.entry_id = e.id
        group by e.id
       having sum(l.debit) <> sum(l.credit)`,
    );

    expect(unbalanced).toHaveLength(0);
  });

  it('left one member whose application cannot be activated, and says why', async () => {
    // Member F. The ADR-050 preconditions as seen from the outside: the fee is
    // posted and there is no verified acceptance, so the membership stays
    // pending. It is the state the membership record's own panel exists to
    // explain, and a demonstration without it would show a system where
    // enrolment always succeeds.
    const pending = await queryOne<{
      status: string;
      fee_posted: boolean;
      consent_ok: boolean;
    }>(
      `select m.status,
              public.membership_fee_is_posted(m.id) as fee_posted,
              public.membership_terms_are_accepted(m.id) as consent_ok
         from public.memberships m
         join public.clients c on c.id = m.client_id
        where c.full_name like 'DEMO Patrick%'`,
    );

    expect(pending.status).toBe('pending');
    expect(pending.fee_posted, 'the fee was taken').toBe(true);
    expect(pending.consent_ok, 'and consent was not').toBe(false);
  });

  it('seeded one member who qualifies and one who only qualifies leniently', async () => {
    const outcomes = await query<{
      full_name: string;
      qualifying_months: number;
      longest_consecutive_months: number;
      qualifies: boolean;
    }>(
      `select c.full_name, q.qualifying_months, q.longest_consecutive_months,
              q.qualifies
         from public.clients c
         join public.memberships m on m.client_id = c.id
         join public.savings_accounts a on a.membership_id = m.id
         join lateral public.member_savings_qualification(a.id) q on true
        where c.full_name like 'DEMO%'
        order by c.full_name`,
    );

    const aisha = outcomes.find((row) => row.full_name.includes('Aisha'));
    const joseph = outcomes.find((row) => row.full_name.includes('Joseph'));

    // Six unbroken months: qualifies under either arm of the consecutive
    // rule, so this is the member a Phase 3 member loan can be demonstrated
    // against.
    expect(aisha?.qualifying_months).toBe(6);
    expect(aisha?.longest_consecutive_months).toBe(6);
    expect(aisha?.qualifies).toBe(true);

    // Six months with a gap: six qualifying months, longest run of three. The
    // entire difference the undecided consecutive rule makes, in one member.
    expect(joseph?.qualifying_months).toBe(6);
    expect(joseph?.longest_consecutive_months).toBe(3);
  });

  it('seeded a month met by several deposits rather than one', async () => {
    // How a member who cannot find UGX 50,000 at once still makes the month.
    // Worth demonstrating, because a system that only accepted the minimum as
    // a single payment would exclude most of the people this programme is
    // for.
    const month = await query<{ deposit_count: string; meets_minimum: boolean }>(
      `select k.deposit_count::text, k.meets_minimum
         from public.clients c
         join public.memberships m on m.client_id = c.id
         join public.savings_accounts a on a.membership_id = m.id
         join public.member_savings_contributions k on k.savings_account_id = a.id
        where c.full_name like 'DEMO Grace%' and k.deposit_count > 1
        order by k.contribution_month`,
    );

    expect(month.length).toBeGreaterThan(0);
    expect(month.some((row) => row.meets_minimum)).toBe(true);
  });

  it('seeded a withdrawal that went through the whole lifecycle', async () => {
    const paid = await queryOne<{
      status: string;
      requested_by_label: string;
      decided_by_label: string;
      paid_transaction_id: string | null;
    }>(
      `select status, requested_by_label, decided_by_label, paid_transaction_id
         from public.savings_withdrawal_requests
        where reason like 'DEMONSTRATION%'`,
    );

    expect(paid.status).toBe('paid');
    expect(paid.paid_transaction_id).not.toBeNull();

    // Two different people. `decide_savings_withdrawal` refuses a decision
    // from whoever prepared the request, so a seeder that produced one label
    // twice would be demonstrating a system without that control.
    expect(paid.requested_by_label).not.toBe(paid.decided_by_label);
  });

  it('seeded a reversal, as a contra row rather than an edit', async () => {
    const reversal = await queryOne<{
      kind: string;
      signed_amount: string;
      reverses_transaction_id: string;
      reversal_reason: string;
    }>(
      `select kind, signed_amount::text, reverses_transaction_id, reversal_reason
         from public.savings_transactions where kind = 'deposit_reversal'`,
    );

    expect(reversal.kind).toBe('deposit_reversal');
    expect(Number(reversal.signed_amount)).toBeLessThan(0);
    expect(reversal.reversal_reason).toContain('DEMONSTRATION');

    // The original is still there, untouched, with its own positive amount.
    // A statement printed before the correction still agrees with the ledger.
    const original = await queryOne<{ kind: string; signed_amount: string }>(
      `select kind, signed_amount::text from public.savings_transactions where id = $1`,
      [reversal.reverses_transaction_id],
    );

    expect(original.kind).toBe('deposit');
    expect(Number(original.signed_amount)).toBeGreaterThan(0);
  });

  it('labelled the demonstration policy version as a demonstration', async () => {
    // The version column is constrained to `N.N`, so the warning has to be in
    // the title and the notes — which is where a reader of the policy screen
    // actually sees it.
    const policy = await queryOne<{ version: string; title: string; notes: string }>(
      `select version, title, notes from public.membership_policy_versions
        where version = '999.0'`,
    );

    expect(policy.title).toContain('DEMONSTRATION ONLY');
    expect(policy.notes).toContain('must not be read as decisions');
  });

  it('touched no loan', async () => {
    // The savings module and the loan book share a ledger and nothing else. A
    // demo seeder has no business in a repayment history, and this is the
    // assertion that keeps it out of one.
    const loans = await queryOne<{ n: string }>(`select count(*) as n from public.loans`);
    const payments = await queryOne<{ n: string }>(
      `select count(*) as n from public.loan_payments`,
    );

    expect(Number(loans.n)).toBe(0);
    expect(Number(payments.n)).toBe(0);
  });
});
