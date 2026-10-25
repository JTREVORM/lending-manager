import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  createDraftLoan,
  createLoanScenario,
  disburseLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';

/**
 * The demonstration seeder run against a database that already has a loan
 * book, with borrower reuse opted in.
 *
 * ## What is actually at stake
 *
 * The ordinary seeder invents six synthetic people. That is fine for showing
 * the savings module on its own, and useless for showing the business: a
 * member who has never borrowed has no loan beside their savings, so nothing
 * on the dashboard, the client profile or the reports connects the two halves
 * of the system. Reuse maps the six scenarios onto six people who are already
 * in the loan book.
 *
 * Which means the seeder now writes memberships, registration fees and
 * savings transactions against **clients who have real loan contracts,
 * repayment schedules, payments and journal history**. The property worth
 * proving is therefore not that the mapping happens — it is that it happens
 * *without touching any of that*. A seeder that nudged one installment date
 * on a loan it was only supposed to read would be a seeder that changed what
 * a borrower owes.
 *
 * So these tests build a real loan book — two borrowers taken all the way to
 * disbursement, so there are genuine schedules and journal entries to
 * disturb — snapshot every loan figure, run the seeder, and compare.
 *
 * ## Why this is its own vitest project
 *
 * `tests/db/demo-seed.test.ts` runs the seeder in synthetic mode on the
 * shared database. Once it has, the six scenario fee and deposit keys are
 * spent on synthetic clients, and reuse correctly refuses to remap them. The
 * two suites need databases that have not seen each other, so each gets its
 * own project and its own rebuild.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('demo borrower reuse suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const run = promisify(execFile);
const ENABLE_PHRASE = 'yes-seed-polytos-demo-data';
const REUSE_PHRASE = 'yes-reuse-existing-demo-borrowers';

/** Borrowers in the book: six for the scenarios, two that must stay out. */
const BORROWERS = 8;

interface SeedResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function seed(env: Record<string, string | undefined> = {}): Promise<SeedResult> {
  try {
    const { stdout, stderr } = await run('npx', ['tsx', 'scripts/seed-demo.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, POLYTOS_SEED_DEMO: ENABLE_PHRASE, ...env },
      timeout: 150_000,
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

const reuseSeed = async (): Promise<SeedResult> =>
  seed({ POLYTOS_DEMO_BORROWER_REUSE: REUSE_PHRASE });

/**
 * Every pre-existing loan figure, keyed the way the upgrade verifier keys
 * them. Read as text so a numeric type never rounds a comparison into
 * agreement.
 */
async function loanBook(): Promise<Record<string, string>> {
  return queryOne<Record<string, string>>(
    `select
       (select count(*) from public.loans)::text as loans,
       (select coalesce(sum(principal_amount), 0)::bigint from public.loans)::text
         as principal,
       (select coalesce(sum(total_interest), 0)::bigint from public.loans)::text
         as interest,
       (select coalesce(sum(total_expected_repayment), 0)::bigint
          from public.loans)::text as expected,
       (select string_agg(status, ',' order by loan_number) from public.loans)
         as statuses,
       (select count(*) from public.loan_periods)::text as periods,
       (select count(*) from public.loan_installments)::text as installments,
       (select coalesce(sum(expected_amount), 0)::bigint
          from public.loan_installments)::text as installment_total,
       (select string_agg(due_date::text, ',' order by id)
          from public.loan_installments) as installment_dates,
       (select count(*) from public.loan_payments)::text as payments,
       (select coalesce(sum(amount), 0)::bigint from public.loan_payments)::text
         as payment_total,
       (select count(*) from public.payment_allocations)::text as allocations,
       (select count(*) from public.loan_penalties)::text as penalties,
       (select string_agg(principal_remaining::text, ',' order by loan_number)
          from public.loan_balances) as outstanding,
       (select coalesce(count(*), 0) from public.loan_delinquency)::text as delinquency,
       -- Lending-ledger postings. The fixture disburses two loans, so this is
       -- not zero; what matters is that the seeder never adds to it.
       (select count(*) from public.journal_entries
         where source_type ~* 'loan|payment|penalty|disburse')::text as loan_journal`,
  );
}

/** The savings liability, both sides of it. */
async function liability(): Promise<{ subledger: string; gl: string }> {
  return queryOne<{ subledger: string; gl: string }>(
    `select
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select coalesce(balance, 0)::bigint from public.ledger_account_balances
         where code = '2100')::text as gl`,
  );
}

/** What the seeder posted, so a repeat run can be compared against it. */
async function postings(): Promise<Record<string, string>> {
  return queryOne<Record<string, string>>(
    `select
       (select count(*) from public.clients)::text as clients,
       (select count(*) from public.memberships)::text as memberships,
       (select count(*) from public.membership_fee_receipts)::text as receipts,
       (select coalesce(sum(amount) filter (where status = 'posted'), 0)::bigint
          from public.membership_fee_receipts)::text as fees,
       (select count(*) from public.savings_accounts)::text as accounts,
       (select count(*) from public.savings_transactions)::text as transactions,
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select count(*) from public.savings_withdrawal_requests)::text as withdrawals,
       (select count(*) from public.journal_entries)::text as journal_entries,
       (select count(*) from public.journal_lines)::text as journal_lines,
       (select coalesce(sum(debit), 0)::bigint from public.journal_lines)::text
         as debits,
       (select coalesce(sum(credit), 0)::bigint from public.journal_lines)::text
         as credits`,
  );
}

let bookBefore: Record<string, string>;
let postingsAfterFirst: Record<string, string>;
let borrowerIds: readonly string[] = [];
let sourcesBefore: readonly string[] = [];

/** The distinct journal source types currently in the ledger. */
async function journalSources(): Promise<readonly string[]> {
  const rows = await query<{ source_type: string }>(
    `select distinct source_type from public.journal_entries order by source_type`,
  );
  return rows.map((row) => row.source_type);
}

beforeAll(async () => {
  if (!hasDatabase) return;

  // Two borrowers driven to `active`, so the book holds real schedules,
  // real journal entries and a real outstanding balance — the things a
  // careless seeder would disturb. They are created first, so their client
  // numbers are lowest and the seeder's deterministic ordering selects them:
  // the borrowers with the most to lose are the ones under test.
  const scenarios: LoanScenario[] = [];
  for (let index = 0; index < 2; index += 1) {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, { principal: 800_000 });
    await disburseLoan(loanId, { secretary: scenario.secretary, owner: scenario.owner });
    scenarios.push(scenario);
  }

  // The rest only need to be borrowers, so a draft application is enough.
  const rest: string[] = [];
  for (let index = 0; index < BORROWERS - 2; index += 1) {
    const scenario = await createLoanScenario();
    await createDraftLoan(scenario.clientId, { withoutLoanGuarantors: true });
    rest.push(scenario.clientId);
  }

  borrowerIds = [...scenarios.map((s) => s.clientId), ...rest];

  bookBefore = await loanBook();
  sourcesBefore = await journalSources();

  const first = await reuseSeed();
  if (first.code !== 0) {
    throw new Error(
      `The seeder failed against an existing loan book.\n${first.stdout}\n${first.stderr}`,
    );
  }

  postingsAfterFirst = await postings();
}, 300_000);

afterAll(async () => {
  if (!hasDatabase) return;
  await closePool();
});

// ===========================================================================
describeDb('it enrols people who are already in the loan book', () => {
  it('creates no new client, and maps all six scenarios onto existing ones', async () => {
    const marked = await query<{ client_id: string; notes: string }>(
      `select client_id, notes from public.memberships
        where notes like 'DEMONSTRATION SCENARIO %'
        order by notes`,
    );

    expect(marked).toHaveLength(6);

    // Every one of them must be a client that existed before the seeder ran.
    for (const row of marked) {
      expect(borrowerIds).toContain(row.client_id);
      expect(row.notes).toContain('existing loan borrower');
    }

    // Six distinct people, not one person six times.
    expect(new Set(marked.map((row) => row.client_id)).size).toBe(6);

    const clients = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.clients`,
    );
    expect(clients.n).toBe(String(BORROWERS));

    // And nothing that looks like the synthetic seed.
    const synthetic = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.clients where full_name like 'DEMO %'`,
    );
    expect(synthetic.n).toBe('0');
  });

  it('enrols the borrowers who actually have live loans, not only the draft ones', async () => {
    // Without this the suite could pass while mapping all six scenarios onto
    // the borrowers whose only loan is an untouched draft — which would make
    // the "loans unchanged" assertion far weaker than it looks, because a
    // draft has no schedule, no journal entry and no outstanding balance to
    // disturb in the first place.
    const withLiveLoan = await queryOne<{ n: string }>(
      `select count(distinct m.client_id)::text as n
         from public.memberships m
         join public.loans l on l.client_id = m.client_id
        where m.notes like 'DEMONSTRATION SCENARIO %'
          and l.status = 'active'
          and exists (
            select 1 from public.loan_installments i where i.loan_id = l.id)`,
    );
    expect(Number(withLiveLoan.n)).toBe(2);
  });

  it('leaves at least one loan borrower a non-member', async () => {
    const free = await queryOne<{ n: string }>(
      `select count(distinct c.id)::text as n
         from public.clients c
         join public.loans l on l.client_id = c.id
        where not exists (
          select 1 from public.memberships m
           where m.client_id = c.id
             and m.status in ('pending', 'active', 'suspended'))`,
    );
    expect(Number(free.n)).toBeGreaterThanOrEqual(1);
  });

  it('keeps each borrower’s own name on their consent, not a demo alias', async () => {
    // `enrol_member` records the signature name. If the seeder had passed its
    // synthetic `fullName` while pointing at somebody else's client row, the
    // consent evidence would carry a name the member never had.
    const mismatched = await query<{ full_name: string; signature_name: string }>(
      `select c.full_name, a.signature_name
         from public.membership_terms_acceptances a
         join public.memberships m on m.id = a.membership_id
         join public.clients c on c.id = m.client_id
        where m.notes like 'DEMONSTRATION SCENARIO %'
          and a.signature_name is distinct from c.full_name`,
    );
    expect(mismatched).toEqual([]);
  });
});

// ===========================================================================
describeDb('it changes nothing about the loans those people already had', () => {
  it('leaves every loan figure, schedule date and outstanding balance identical', async () => {
    const after = await loanBook();
    expect(after).toEqual(bookBefore);
  });

  it('adds only membership and savings journal sources, never a lending one', async () => {
    // The fixture disburses two loans, so `loan_disbursement` is already in
    // the ledger before the seeder runs — the claim is about what the seeder
    // *adds*. Its own `loan_journal` count is compared in the snapshot above;
    // this pins the shape of what it introduced.
    const added = (await journalSources()).filter(
      (name) => !sourcesBefore.includes(name),
    );

    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      expect(name, `new journal source ${name}`).not.toMatch(
        /loan|payment|penalty|disburse/i,
      );
      expect(name).toMatch(/member|saving|fee|withdraw/i);
    }
  });

  it('wrote no audit row claiming a client or loan was modified', async () => {
    const touched = await query<{ action: string }>(
      `select action from public.audit_log
        where action in ('client.updated', 'loan.updated', 'client.deleted')`,
    );
    expect(touched).toEqual([]);
  });
});

// ===========================================================================
describeDb('the membership, the fee and the savings all point at one person', () => {
  it('links every scenario’s fee receipt and savings account to that same client', async () => {
    const rows = await query<{
      notes: string;
      client_id: string;
      receipt_client: string | null;
      savings_client: string | null;
    }>(
      `select m.notes,
              m.client_id,
              (select r.id::text from public.membership_fee_receipts r
                where r.membership_id = m.id and r.status = 'posted' limit 1)
                as receipt_client,
              (select s.id::text from public.savings_accounts s
                where s.membership_id = m.id limit 1) as savings_client
         from public.memberships m
        where m.notes like 'DEMONSTRATION SCENARIO %'
        order by m.notes`,
    );

    expect(rows).toHaveLength(6);

    for (const row of rows) {
      // Every scenario has a posted registration fee of its own.
      expect(row.receipt_client, `fee for ${row.notes}`).not.toBeNull();
    }

    // Five of the six are enrolled and so have an account; scenario F is the
    // application that cannot be activated, and must not have one.
    const withAccount = rows.filter((row) => row.savings_client !== null);
    expect(withAccount).toHaveLength(5);
  });

  it('keeps the pending application’s explanation beside its scenario marker', async () => {
    // The marker is read back from a fixed offset to recover the mapping, so
    // it has to lead — but the sentence the membership record's own panel
    // exists to show must survive alongside it.
    const pending = await queryOne<{ notes: string }>(
      `select notes from public.memberships
        where notes like 'DEMONSTRATION SCENARIO %' and status = 'pending'`,
    );
    expect(pending.notes).toMatch(/^DEMONSTRATION SCENARIO F — /);
    expect(pending.notes).toContain('cannot be activated');
  });

  it('reconciles the savings subledger against the 2100 liability', async () => {
    const { subledger, gl } = await liability();
    expect(subledger).toBe(gl);
    expect(Number(subledger)).toBeGreaterThan(0);
  });

  it('balances every journal entry it posted', async () => {
    const unbalanced = await query<{ id: string }>(
      `select e.id::text
         from public.journal_entries e
         join public.journal_lines l on l.entry_id = e.id
        group by e.id
       having coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)`,
    );
    expect(unbalanced).toEqual([]);
  });
});

// ===========================================================================
describeDb('running it again posts nothing', () => {
  it('is a financial fixed point on the second and third run', async () => {
    for (const attempt of [2, 3]) {
      const again = await reuseSeed();
      expect(again.code, `run ${String(attempt)}:\n${again.stderr}`).toBe(0);

      const now = await postings();
      expect(now, `run ${String(attempt)} changed a posting`).toEqual(postingsAfterFirst);

      // And the loan book is still untouched after every repeat.
      expect(await loanBook()).toEqual(bookBefore);
    }
  }, 300_000);

  it('re-selects the same six borrowers rather than picking new ones', async () => {
    const marked = await query<{ client_id: string }>(
      `select client_id from public.memberships
        where notes like 'DEMONSTRATION SCENARIO %'`,
    );
    expect(marked).toHaveLength(6);
  });
});

// ===========================================================================
describeDb('it refuses the one combination that would misattribute money', () => {
  it('will not seed synthetic clients over borrowers that already hold the keys', async () => {
    // The mirror of the guard that refuses reuse when synthetic clients
    // exist. Every scenario's fee and deposit key comes from its letter
    // alone, so once a reuse run has spent them, a synthetic run replays
    // them: `enrol_member` hands back the existing borrower's membership,
    // the new synthetic clients are left with no membership, and the money
    // still reconciles while showing one person's fee under another's name.
    //
    // `memberships` is append-only, so that cannot be cleaned up afterwards.
    // Refusing is the only safe answer.
    const result = await seed();

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'already holds demonstration scenarios mapped onto existing loan borrowers',
    );

    // Refused means refused: nothing new, and nothing lost.
    expect(await postings()).toEqual(postingsAfterFirst);
    expect(await loanBook()).toEqual(bookBefore);
  }, 150_000);

  it('still refuses a reuse run that names the wrong phrase', async () => {
    const result = await seed({ POLYTOS_DEMO_BORROWER_REUSE: 'yes' });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'exact POLYTOS_DEMO_BORROWER_REUSE opt-in',
    );
    expect(await postings()).toEqual(postingsAfterFirst);
  });
});
