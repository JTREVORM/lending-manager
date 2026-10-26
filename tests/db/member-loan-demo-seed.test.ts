import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  createDraftLoan,
  createLoanScenario,
  disburseLoan,
} from '../helpers/loan-fixtures';
import { postPayment } from '../helpers/payment-fixtures';
import {
  DEMO_MONTH_ANCHOR,
  DEMO_MULTIPLIER_BPS,
  MEMBER_LOAN_ENABLE_PHRASE,
  MEMBER_LOAN_POLICY_VERSION,
  memberLoanDemoRequested,
} from '../../scripts/demo-member-loans';

/**
 * The member loan demonstration seeder, run for real against a database that
 * already has a loan book.
 *
 * ## What is actually at stake
 *
 * Phase 3 is the first part of Polytos that writes a **loan**. Everything
 * before it wrote memberships, fee receipts and savings transactions, which
 * share a ledger with the loan book and nothing else; this writes into
 * `loans`, `loan_periods`, `loan_installments`, `loan_payments` and
 * `payment_allocations` — the same five tables that hold what every existing
 * borrower owes.
 *
 * So the property worth proving is not that the demonstration appears. It is
 * that it appears *beside* an existing book without moving a figure in it. A
 * seeder that nudged one installment date while adding a member loan would be
 * a seeder that changed what a borrower owes, and the person who noticed
 * would be the borrower.
 *
 * These tests therefore build a real book first — two borrowers taken all the
 * way to disbursement, so there are genuine schedules, payments and journal
 * entries to disturb, plus six more so reuse has people to map onto —
 * snapshot every figure loan by loan, run the seeder, and compare.
 *
 * ## And that member lending moves no savings
 *
 * A pledge restricts a member's savings; it does not spend them. There is no
 * journal entry, no savings transaction and no change to account 2100. The
 * suite asserts that from the outside: every demonstration member's balance
 * still equals the sum of their own transactions, while the pledge against it
 * is above zero.
 *
 * ## Why this is its own vitest project
 *
 * Two reasons, and either alone would be enough.
 *
 * The seeder in this mode publishes policy version 998.0 **as the only
 * version in force** — a savings account is frozen to the version it was
 * opened under, so a second published version would supersede the first and
 * silently un-qualify every account opened under it. Any suite that publishes
 * its own version collides with that, which is every membership suite in the
 * database project.
 *
 * And borrower reuse needs a database the synthetic seeder has never touched:
 * once the six scenario fee and deposit keys are spent on synthetic clients,
 * reuse correctly refuses to remap them.
 *
 * Hence a project with its own rebuild rather than another file in `db`,
 * `seed` or `seed-reuse`.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('member loan demo seed suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

const run = promisify(execFile);
const ENABLE_PHRASE = 'yes-seed-polytos-demo-data';
const REUSE_PHRASE = 'yes-reuse-existing-demo-borrowers';

/** Borrowers in the book: six for the scenarios, two that must stay out. */
const BORROWERS = 8;

/** Scenario A's principal, and what it must pledge at the demo multiplier. */
const SCENARIO_A_PRINCIPAL = 200_000;

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
        POLYTOS_DEMO_BORROWER_REUSE: REUSE_PHRASE,
        POLYTOS_SEED_MEMBER_LOANS: MEMBER_LOAN_ENABLE_PHRASE,
        ...env,
      },
      timeout: 240_000,
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

/**
 * Every figure of the loans that existed before the seeder ran, keyed by loan.
 *
 * Keyed rather than summed, deliberately. A total can stay still while two
 * loans swap figures, and the whole claim here is about individual contracts.
 * Read as text so no numeric type rounds a comparison into agreement.
 */
async function existingBook(
  ids: readonly string[],
): Promise<Record<string, Record<string, string | null>>> {
  if (ids.length === 0) return {};

  const rows = await query<Record<string, string | null>>(
    `select l.id,
            l.loan_number, l.status,
            l.principal_amount::text as principal,
            l.interest_rate_bps::text as rate,
            l.interest_method,
            l.loan_term_months::text as term,
            l.repayment_frequency,
            l.total_interest::text as interest,
            l.total_expected_repayment::text as expected,
            l.disbursed_at::text as disbursed_at,
            (select count(*)::text from public.loan_periods p where p.loan_id = l.id)
              as periods,
            (select string_agg(p.total_obligation::text, ',' order by p.period_number)
               from public.loan_periods p where p.loan_id = l.id) as period_totals,
            (select count(*)::text from public.loan_installments i
              where i.loan_id = l.id) as installments,
            (select string_agg(i.due_date::text || '=' || i.expected_amount::text,
                               ',' order by i.installment_number)
               from public.loan_installments i where i.loan_id = l.id) as schedule,
            (select count(*)::text from public.loan_payments y
              where y.loan_id = l.id) as payments,
            (select coalesce(sum(y.amount), 0)::text from public.loan_payments y
              where y.loan_id = l.id and y.status = 'posted') as collected,
            (select count(*)::text from public.payment_allocations a
               join public.loan_payments y on y.id = a.payment_id
              where y.loan_id = l.id) as allocations,
            (select b.principal_remaining::text from public.loan_balances b
              where b.loan_id = l.id) as principal_remaining,
            (select b.total_outstanding::text from public.loan_balances b
              where b.loan_id = l.id) as outstanding
       from public.loans l
      where l.id = any($1::uuid[])
      order by l.loan_number`,
    [ids],
  );

  return Object.fromEntries(rows.map((row) => [String(row.id), row]));
}

/** Everything the member loan demonstration wrote, as one comparable row. */
async function memberLoanState(): Promise<Record<string, string | null>> {
  return queryOne<Record<string, string | null>>(
    `select
       (select count(*) from public.loans l
          join public.loan_products p on p.id = l.loan_product_id
         where p.requires_membership)::text as member_loans,
       (select string_agg(l.status, ',' order by l.loan_number) from public.loans l
          join public.loan_products p on p.id = l.loan_product_id
         where p.requires_membership) as member_loan_statuses,
       (select coalesce(sum(l.principal_amount), 0)::bigint from public.loans l
          join public.loan_products p on p.id = l.loan_product_id
         where p.requires_membership)::text as member_principal,
       (select coalesce(sum(l.total_expected_repayment), 0)::bigint from public.loans l
          join public.loan_products p on p.id = l.loan_product_id
         where p.requires_membership)::text as member_expected,
       (select count(*) from public.member_loan_savings_pledges)::text as pledges,
       (select coalesce(sum(pledged_amount), 0)::bigint
          from public.member_loan_savings_pledges)::text as pledged,
       (select count(*) from public.member_loan_eligibility_snapshots)::text as snapshots,
       (select count(*) from public.loan_installments)::text as installments,
       (select count(*) from public.loan_payments)::text as payments,
       (select count(*) from public.journal_entries)::text as journal_entries,
       (select count(*) from public.journal_lines)::text as journal_lines,
       (select coalesce(sum(debit), 0)::bigint from public.journal_lines)::text as debits,
       (select coalesce(sum(credit), 0)::bigint from public.journal_lines)::text
         as credits,
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select count(*) from public.savings_transactions)::text as savings_rows,
       (select count(*) from public.memberships)::text as memberships,
       (select count(*) from public.clients)::text as clients,
       (select count(*) from public.membership_policy_versions)::text as policies`,
  );
}

let bookBefore: Record<string, Record<string, string | null>>;
let stateAfterFirst: Record<string, string | null>;
let existingLoanIds: readonly string[] = [];
let borrowerIds: readonly string[] = [];
let firstRun: SeedResult;

beforeAll(async () => {
  if (!hasDatabase) return;

  // Two borrowers driven all the way through — disbursed, then repaid in full
  // — so the book holds real schedules, real payments, real allocations and
  // real journal entries on both sides of the ledger. They are created first,
  // so their client numbers are lowest and the seeder's deterministic
  // ordering maps scenarios onto them: the borrowers with the most to lose
  // are the ones under test.
  //
  // Repaid rather than left running, because `active_loan_exists` refuses a
  // second live loan to anybody — which is the business rule working, and
  // would mean no member loan could be demonstrated against these two at all.
  // A cleared loan carries the same history and is not a live loan.
  const ids: string[] = [];
  const clients: string[] = [];

  for (let index = 0; index < 2; index += 1) {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, { principal: 800_000 });
    await disburseLoan(loanId, { secretary: scenario.secretary, owner: scenario.owner });

    const owed = await queryOne<{ amount: string }>(
      `select total_expected_repayment::text as amount from public.loans where id = $1`,
      [loanId],
    );
    await postPayment(loanId, scenario.owner, { amount: Number(owed.amount) });

    ids.push(loanId);
    clients.push(scenario.clientId);
  }

  // The rest only need to be borrowers, so a draft application is enough.
  for (let index = 0; index < BORROWERS - 2; index += 1) {
    const scenario = await createLoanScenario();
    const loanId = await createDraftLoan(scenario.clientId, {
      withoutLoanGuarantors: true,
    });
    ids.push(loanId);
    clients.push(scenario.clientId);
  }

  existingLoanIds = ids;
  borrowerIds = clients;
  bookBefore = await existingBook(existingLoanIds);

  firstRun = await seed();

  if (firstRun.code !== 0) {
    throw new Error(
      `The member loan seeder failed against an existing loan book.\n` +
        `${firstRun.stdout}\n${firstRun.stderr}`,
    );
  }

  stateAfterFirst = await memberLoanState();
}, 400_000);

afterAll(async () => {
  if (!hasDatabase) return;
  await closePool();
});

// ===========================================================================
describeDb('the member loan demonstration is gated separately', () => {
  it('needs its own phrase, and nothing else turns it on', () => {
    expect(memberLoanDemoRequested(MEMBER_LOAN_ENABLE_PHRASE)).toBe(true);

    // The savings phrase is not this phrase. Somebody who means to seed
    // savings does not thereby publish a policy version that answers three
    // decisions the client has not made.
    for (const value of [
      undefined,
      '',
      '1',
      'true',
      'yes',
      ENABLE_PHRASE,
      MEMBER_LOAN_ENABLE_PHRASE.toUpperCase(),
      `${MEMBER_LOAN_ENABLE_PHRASE} `,
    ]) {
      expect(memberLoanDemoRequested(value), String(value)).toBe(false);
    }
  });

  it('refuses a hosted database outright, and writes nothing', async () => {
    const before = await memberLoanState();

    const attempt = await seed({
      DATABASE_URL:
        'postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
    });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('Nothing has been written');
    expect(await memberLoanState()).toEqual(before);
  });

  it('names the second phrase in its own refusal message', async () => {
    // The refusal a developer actually meets. It has to say what to type,
    // including that member lending needs a phrase of its own — otherwise the
    // only way to find that out is to read the source.
    const attempt = await seed({ POLYTOS_SEED_DEMO: undefined });

    expect(attempt.code).not.toBe(0);
    expect(attempt.stderr).toContain('POLYTOS_SEED_MEMBER_LOANS');
    expect(attempt.stderr).toContain(MEMBER_LOAN_ENABLE_PHRASE);
    expect(attempt.stderr).toContain('Nothing has been written');
  });
});

// ===========================================================================
describeDb('the existing loan book is untouched', () => {
  it('leaves every pre-existing loan identical, figure by figure', async () => {
    const after = await existingBook(existingLoanIds);

    expect(Object.keys(after)).toHaveLength(BORROWERS);

    // Loan by loan rather than in total: a sum can stay still while two
    // contracts swap figures, and it is the individual contract that somebody
    // has to repay.
    for (const id of existingLoanIds) {
      expect(after[id], `loan ${id} disappeared`).toBeDefined();
      expect(after[id], `loan ${id} moved`).toEqual(bookBefore[id]);
    }
  });

  it('leaves every collection date on those loans where it was', async () => {
    // Called out separately because Phase 3 rewrote `generate_loan_schedule`
    // to add the calendar-month arm. The fixed-day arm was copied
    // character-for-character, and this is the assertion that says so from the
    // outside, on schedules written before the new function existed.
    const dates = await query<{ loan_id: string; schedule: string }>(
      `select i.loan_id,
              string_agg(i.due_date::text, ',' order by i.installment_number) as schedule
         from public.loan_installments i
        where i.loan_id = any($1::uuid[])
        group by i.loan_id`,
      [existingLoanIds],
    );

    expect(dates.length).toBeGreaterThan(0);

    for (const row of dates) {
      const before = bookBefore[row.loan_id];
      expect(before).toBeDefined();
      expect(row.schedule).toBe((before?.schedule ?? '').replace(/=\d+/g, ''));
    }
  });

  it('adds nothing to the existing loans that is a member loan', async () => {
    // The member loans are new rows under the ML product, never the existing
    // loans re-pointed at it. A seeder that reused a loan row would be
    // rewriting a signed agreement.
    const repointed = await query(
      `select l.id from public.loans l
         join public.loan_products p on p.id = l.loan_product_id
        where l.id = any($1::uuid[]) and p.requires_membership`,
      [existingLoanIds],
    );

    expect(repointed).toHaveLength(0);
  });
});

// ===========================================================================
describeDb('it reuses the borrowers and leaves the non-members alone', () => {
  it('creates no client of its own', async () => {
    const clients = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.clients`,
    );

    // The eight the fixture built, and not one more. Every scenario, savings
    // and member loan alike, attached to somebody already in the book.
    expect(clients.n).toBe(String(BORROWERS));

    const synthetic = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.clients where full_name like 'DEMO %'`,
    );
    expect(synthetic.n).toBe('0');
  });

  it('enrols six and leaves the other two as non-members', async () => {
    const enrolled = await query<{ client_id: string }>(
      `select client_id from public.memberships
        where notes like 'DEMONSTRATION SCENARIO %'`,
    );

    expect(enrolled).toHaveLength(6);
    for (const row of enrolled) expect(borrowerIds).toContain(row.client_id);

    const nonMembers = await query<{ id: string }>(
      `select c.id from public.clients c
        where not exists (select 1 from public.memberships m where m.client_id = c.id)`,
    );

    // Two people who borrow and do not save. The regression that matters:
    // non-member lending has to keep working, and a non-member has to be able
    // to exist at all.
    expect(nonMembers).toHaveLength(BORROWERS - 6);
  });

  it('refuses a member loan to a non-member, which is the point of the flag', async () => {
    const wrong = await query(
      `select l.id from public.loans l
         join public.loan_products p on p.id = l.loan_product_id
        where p.requires_membership and l.membership_id is null
          and l.status not in ('draft', 'pending_approval', 'rejected', 'cancelled')`,
    );

    // A live member loan without a membership frozen onto it would mean the
    // borrower could not be shown to have been a member when it was approved.
    expect(wrong).toHaveLength(0);
  });
});

// ===========================================================================
describeDb('member lending moved no savings', () => {
  it('reconciles the subledger against 2100 after the loans were written', async () => {
    const row = await queryOne<{ subledger: string; gl: string }>(
      `select
         (select coalesce(sum(signed_amount), 0)::bigint
            from public.savings_transactions)::text as subledger,
         (select coalesce(balance, 0)::bigint from public.ledger_account_balances
           where code = '2100')::text as gl`,
    );

    expect(Number(row.subledger)).toBe(Number(row.gl));
    expect(Number(row.subledger)).toBeGreaterThan(0);
  });

  it('restricted savings without spending them', async () => {
    // The pledge's whole design. `balance` is derived from the transactions,
    // so a pledge that had moved money would show up here as a difference,
    // and a pledge that had not been taken would show up as a zero.
    const rows = await query<{
      balance: string;
      from_transactions: string;
      pledged: string;
    }>(
      `select sb.balance::text,
              (select coalesce(sum(t.signed_amount), 0)::bigint
                 from public.savings_transactions t
                where t.savings_account_id = sb.savings_account_id)::text
                as from_transactions,
              public.savings_pledged_amount(sb.savings_account_id)::text as pledged
         from public.member_savings_balances sb`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(Number(row.balance)).toBe(Number(row.from_transactions));
      expect(Number(row.pledged)).toBeLessThanOrEqual(Number(row.balance));
    }

    // And at least one of them is actually pledged, or this proves nothing.
    expect(rows.some((row) => Number(row.pledged) > 0)).toBe(true);
  });

  it('posted no journal entry and no savings transaction for a pledge', async () => {
    const sourced = await query<{ source_type: string }>(
      `select distinct source_type from public.journal_entries
        where source_type ilike '%pledge%'`,
    );

    expect(sourced).toHaveLength(0);

    const transactions = await query<{ kind: string }>(
      `select distinct kind from public.savings_transactions order by kind`,
    );

    // Only the savings kinds. A pledge is not a transaction, and a member
    // loan's disbursement is not a withdrawal.
    for (const row of transactions) {
      expect(['deposit', 'deposit_reversal', 'withdrawal']).toContain(row.kind);
    }
  });

  it('pledged exactly what the multiplier requires, and froze it', async () => {
    const pledge = await queryOne<{
      pledged_amount: string;
      loan_principal: string;
      multiplier_bps: string;
    }>(
      `select p.pledged_amount::text, p.loan_principal::text, p.multiplier_bps::text
         from public.member_loan_savings_pledges p
         join public.loans l on l.id = p.loan_id
        where l.status = 'active'`,
    );

    expect(Number(pledge.multiplier_bps)).toBe(DEMO_MULTIPLIER_BPS);
    expect(Number(pledge.loan_principal)).toBe(SCENARIO_A_PRINCIPAL);

    // Ceiling division, in integer shillings: the savings that *support* this
    // principal, rounded up, so a pledge is never a shilling short of what
    // the multiplier says secures the loan.
    const required = Math.ceil(
      (SCENARIO_A_PRINCIPAL * 10_000) / Number(pledge.multiplier_bps),
    );
    expect(Number(pledge.pledged_amount)).toBe(required);
  });

  it('balances every journal entry it posted, and foots the trial balance', async () => {
    const unbalanced = await query(
      `select e.id from public.journal_entries e
         join public.journal_lines l on l.entry_id = e.id
        group by e.id
       having sum(l.debit) <> sum(l.credit)`,
    );

    expect(unbalanced).toHaveLength(0);

    const trial = await queryOne<{ debit: string; credit: string }>(
      `select coalesce(sum(total_debit), 0)::text as debit,
              coalesce(sum(total_credit), 0)::text as credit
         from public.trial_balance`,
    );

    expect(trial.debit).toBe(trial.credit);
  });
});

// ===========================================================================
describeDb('what the demonstration shows', () => {
  it('opened six applications: one active, one waiting, four refused', async () => {
    const loans = await query<{ notes: string; status: string }>(
      `select l.notes, l.status from public.loans l
         join public.loan_products p on p.id = l.loan_product_id
        where p.requires_membership
        order by l.notes`,
    );

    expect(loans).toHaveLength(6);
    for (const loan of loans) {
      expect(loan.notes).toMatch(/^DEMONSTRATION MEMBER LOAN /);
    }

    // One loan the business approved and paid out, one application still
    // waiting for a decision, and four the database refused. The refusals are
    // the demonstration: an interface can be made to show a refusal, and only
    // a refusal the database actually issued proves the control exists.
    expect(loans.filter((loan) => loan.status === 'active')).toHaveLength(1);
    expect(loans.filter((loan) => loan.status === 'draft')).toHaveLength(5);

    expect(firstRun.stdout).toContain('approval refused: member_amount_above_ceiling');
    expect(firstRun.stdout).toContain('approval refused: member_not_qualified');
    expect(firstRun.stdout).toContain('member_not_active');
  });

  it('froze the membership, the policy version and the terms onto the active loan', async () => {
    const loan = await queryOne<{
      membership_id: string | null;
      interest_basis: string | null;
      interest_method: string;
      interest_rate_bps: string;
      policy_version: string | null;
    }>(
      `select l.membership_id, l.interest_basis, l.interest_method,
              l.interest_rate_bps::text,
              (select v.version from public.membership_policy_versions v
                join public.memberships m on m.policy_version_id = v.id
               where m.id = l.membership_id) as policy_version
         from public.loans l
         join public.loan_products p on p.id = l.loan_product_id
        where p.requires_membership and l.status = 'active'`,
    );

    expect(loan.membership_id).not.toBeNull();
    // Priced from the borrower's own version, not from the product: the
    // product carries `interest_source = 'membership_policy'` for exactly
    // this reason.
    expect(loan.policy_version).toBe(MEMBER_LOAN_POLICY_VERSION);
    expect(Number(loan.interest_rate_bps)).toBe(500);
    expect(loan.interest_basis).toBe('per_month');
    expect(loan.interest_method).toBe('reducing_balance_monthly');
  });

  it('wrote the eligibility snapshot the approval was made on', async () => {
    const snapshot = await queryOne<{
      policy_version: string;
      months_required: string;
      must_be_consecutive: boolean;
      qualifying_months: string;
      consecutive_qualifying_months: string;
      eligible_savings: string;
      pledged_savings_before: string;
      pending_withdrawals_before: string;
      available_savings: string;
      amount_requested: string;
      term_requested: string;
      max_eligible_loan: string;
      multiplier_bps: string;
      required_cadence: string;
      captured_by_label: string;
    }>(
      `select s.policy_version, s.months_required::text, s.must_be_consecutive,
              s.qualifying_months::text, s.consecutive_qualifying_months::text,
              s.eligible_savings::text, s.pledged_savings_before::text,
              s.pending_withdrawals_before::text, s.available_savings::text,
              s.amount_requested::text, s.term_requested::text,
              s.max_eligible_loan::text, s.multiplier_bps::text,
              s.required_cadence, s.captured_by_label
         from public.member_loan_eligibility_snapshots s
         join public.loans l on l.id = s.loan_id
        where l.status = 'active'`,
    );

    // The assessment the decision was actually made on, frozen: the policy
    // version it was judged against, the months it required, the savings it
    // found, and the ceiling those savings supported.
    expect(snapshot.policy_version).toBe(MEMBER_LOAN_POLICY_VERSION);
    expect(Number(snapshot.amount_requested)).toBe(SCENARIO_A_PRINCIPAL);
    expect(Number(snapshot.multiplier_bps)).toBe(DEMO_MULTIPLIER_BPS);
    expect(snapshot.required_cadence).toBe('weekly');

    // Qualified under the arm this policy version chose. The row's own CHECK
    // constraint says the same thing; restating it here means a constraint
    // quietly dropped is still caught.
    expect(
      snapshot.must_be_consecutive
        ? Number(snapshot.consecutive_qualifying_months)
        : Number(snapshot.qualifying_months),
    ).toBeGreaterThanOrEqual(Number(snapshot.months_required));

    // And the ceiling arithmetic, restated from the figures beside it: what
    // is available is what is eligible less what is already committed, and
    // the ceiling is that multiplied and floored.
    expect(Number(snapshot.available_savings)).toBe(
      Math.max(
        Number(snapshot.eligible_savings) -
          Number(snapshot.pledged_savings_before) -
          Number(snapshot.pending_withdrawals_before),
        0,
      ),
    );
    expect(Number(snapshot.max_eligible_loan)).toBe(
      Math.floor(
        (Number(snapshot.available_savings) * Number(snapshot.multiplier_bps)) / 10_000,
      ),
    );
    expect(Number(snapshot.amount_requested)).toBeLessThanOrEqual(
      Number(snapshot.max_eligible_loan),
    );

    // Attributed to the person who approved, not to the seeder. There is no
    // such thing as a system-performed approval.
    expect(snapshot.captured_by_label).not.toBe('system');
  });

  it('collected once, against the schedule rather than around it', async () => {
    const payment = await queryOne<{
      amount: string;
      status: string;
      allocations: string;
      allocated: string;
    }>(
      `select y.amount::text, y.status,
              (select count(*)::text from public.payment_allocations a
                where a.payment_id = y.id) as allocations,
              (select coalesce(sum(a.allocated_principal + a.allocated_interest
                                   + a.allocated_penalty), 0)::bigint
                 from public.payment_allocations a where a.payment_id = y.id)::text
                as allocated
         from public.loan_payments y
         join public.loans l on l.id = y.loan_id
         join public.loan_products p on p.id = l.loan_product_id
        where p.requires_membership and l.status = 'active'`,
    );

    expect(payment.status).toBe('posted');
    expect(Number(payment.allocations)).toBeGreaterThan(0);
    // Every shilling landed somewhere. An unallocated payment would be money
    // the loan does not know it has received.
    expect(Number(payment.allocated)).toBe(Number(payment.amount));
  });

  it('generated a schedule that collects the contractual total', async () => {
    const rows = await query<{
      loan_number: string;
      expected: string;
      scheduled: string;
      cadence_kind: string;
    }>(
      `select l.loan_number, l.total_expected_repayment::text as expected,
              coalesce(sum(i.expected_amount), 0)::text as scheduled,
              min(s.cadence_kind) as cadence_kind
         from public.loans l
         join public.loan_products p on p.id = l.loan_product_id
         join public.loan_schedules s on s.loan_id = l.id
         left join public.loan_installments i on i.loan_id = l.id
        where p.requires_membership
        group by l.id, l.loan_number, l.total_expected_repayment`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(Number(row.scheduled), row.loan_number).toBe(Number(row.expected));
      // Scenario A runs two months, which is inside the weekly boundary the
      // client confirmed, so its collections are weekly.
      expect(row.cadence_kind).toBe('fixed_days');
    }
  });

  it('labelled the TEST ONLY policy as a demonstration, in the places a reader looks', async () => {
    const policy = await queryOne<{
      version: string;
      title: string;
      notes: string;
      status: string;
      interest_basis: string;
      interest_method: string;
      multiplier: string;
    }>(
      `select version, title, notes, status, interest_basis, interest_method,
              savings_to_loan_multiplier_bps::text as multiplier
         from public.membership_policy_versions
        where version = $1`,
      [MEMBER_LOAN_POLICY_VERSION],
    );

    expect(policy.status).toBe('active');
    expect(policy.title).toContain('TEST ONLY');
    expect(policy.notes).toContain('must not be read as decisions');
    // The three undecided figures are present, and the notes say in so many
    // words that their presence is not a decision.
    expect(policy.notes).toContain('the client has NOT made');
    expect(policy.interest_basis).toBe('per_month');
    expect(policy.interest_method).toBe('reducing_balance_monthly');
    expect(Number(policy.multiplier)).toBe(DEMO_MULTIPLIER_BPS);

    // And it is the only version in force, which is what keeps every savings
    // account opened under it qualifying.
    const inForce = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.membership_policy_versions
        where status = 'active'`,
    );
    expect(inForce.n).toBe('1');
  });

  it('opened the cadence and the product the way the business would', async () => {
    const monthly = await queryOne<{
      cadence_kind: string;
      interval_days: string | null;
      month_anchor: string | null;
      is_active: boolean;
    }>(
      `select cadence_kind, interval_days::text, month_anchor, is_active
         from public.repayment_frequencies where key = 'monthly'`,
    );

    expect(monthly.cadence_kind).toBe('calendar_month');
    // Not 30 days. A calendar month is the thing the client described, and an
    // interval would be a different contract that happens to look similar.
    expect(monthly.interval_days).toBeNull();
    expect(monthly.month_anchor).toBe(DEMO_MONTH_ANCHOR);
    expect(monthly.is_active).toBe(true);

    const product = await queryOne<{
      status: string;
      requires_membership: boolean;
      interest_source: string;
      max_term_months: string;
    }>(
      `select status, requires_membership, interest_source, max_term_months::text
         from public.loan_products where product_code = 'ML'`,
    );

    expect(product.status).toBe('active');
    expect(product.requires_membership).toBe(true);
    expect(product.interest_source).toBe('membership_policy');
    expect(Number(product.max_term_months)).toBe(5);
  });

  it('recorded each assessment in the audit trail without copying anybody in', async () => {
    const rows = await query<{
      action: string;
      metadata: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
    }>(
      `select action, metadata, new_values from public.audit_log
        where action like 'member_loan.%' order by action`,
    );

    // The assessment the approval was made on, and the savings it committed.
    // Both recorded against the loan, because that is the entity a reader is
    // looking at when they ask why this was approved.
    expect(rows.map((row) => row.action)).toEqual([
      'member_loan.assessed',
      'member_loan.pledged',
    ]);

    // The trail carries the membership number, the policy version and the
    // figures of the assessment — never a name, a phone number or the
    // member's savings balance. An audit row is read by people entitled to
    // know an assessment happened, which is not the same as being entitled to
    // the member's account.
    const forbidden = new Set([
      'full_name',
      'client_name',
      'phone',
      'balance',
      'savings_balance',
      'eligible_savings',
      'available_savings',
      'account_number',
    ]);

    for (const row of rows) {
      const keys = [
        ...Object.keys(row.metadata ?? {}),
        ...Object.keys(row.new_values ?? {}),
      ];

      for (const key of keys) expect(forbidden.has(key), key).toBe(false);

      // And no value that is a telephone number, whatever it is called.
      expect(JSON.stringify([row.metadata, row.new_values])).not.toMatch(/\+256/);
    }
  });
});

// ===========================================================================
describeDb('running it again changes nothing', () => {
  it('writes no second member loan on the second run', async () => {
    const second = await seed();

    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('member loans already present      6');

    // Every count and every total, identical. A seeder that opened a second
    // application each run would be a seeder that pledged a member's savings
    // twice over.
    expect(await memberLoanState()).toEqual(stateAfterFirst);
  });

  it('is still a fixed point on the third run, and the old book is still there', async () => {
    // Twice could pass by accident — a guard that happens to catch the exact
    // state the first run leaves. Three times means the second run's state is
    // a fixed point, which is what idempotent means.
    const third = await seed();

    expect(third.code, third.stderr).toBe(0);
    expect(await memberLoanState()).toEqual(stateAfterFirst);

    // And the loans that were there before any of this still hold every
    // figure they held, after three passes over them.
    const after = await existingBook(existingLoanIds);
    for (const id of existingLoanIds) expect(after[id]).toEqual(bookBefore[id]);
  });
});
