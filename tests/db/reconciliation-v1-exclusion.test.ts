/**
 * A cash difference is not closed by the person who counted the drawer.
 *
 * Before 20261112000100 `approve_reconciliation` checked the
 * `reconciliation:approve` capability and nothing else, so the officer who
 * performed a count could approve it — and that approval posts the variance
 * to 5950 Cash Over and Short. There were two routes: approve your own
 * submission, or turn `reconciliation_requires_review` off and have
 * `submit_reconciliation` approve it for you in the same call. The second
 * was the worse of the two, because the setting that governed it lives on
 * `finance_settings`, which the same Owner may edit — a control the person
 * it constrains could remove.
 *
 * Both are closed, and this file holds them closed from four directions:
 *
 *   - a difference is recorded and left `submitted`, writing no journal and
 *     leaving 5950 untouched, with review required;
 *   - the same, with review turned off, so the setting buys nobody a
 *     self-closed variance;
 *   - the person who counted is refused by the function with 42501, and the
 *     reconciliation is still waiting afterwards;
 *   - a self-review written straight to the table — the one caller that never
 *     passes through the function — is refused by the CHECK constraint.
 *
 * What this costs a business with one member of staff is deliberate and
 * small: the Owner can count a drawer and see a difference, and cannot write
 * it off until somebody else is authorised. The variance stays visible and
 * unposted, which is the honest position. No ordinary lending operation is
 * affected — see `sole-owner-operation.test.ts`, which takes a loan from
 * draft to cleared with the Owner as the only actor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { createLoanScenario } from '../helpers/loan-fixtures';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('reconciliation V1 exclusion', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

/** GL 5950 Cash Over and Short — where an approved difference lands. */
async function overShortBalance(): Promise<number> {
  const row = await queryOne<{ balance: string | null }>(
    `select coalesce(sum(jl.debit) - sum(jl.credit), 0)::text as balance
       from public.journal_lines jl
       join public.ledger_accounts a on a.id = jl.account_id
      where a.code = '5950'`,
  );
  return Number(row.balance ?? '0');
}

async function setReview(required: boolean): Promise<void> {
  await queryOne(
    `update public.finance_settings set reconciliation_requires_review = $1
      where id = 1 returning id`,
    [required],
  );
}

/**
 * Put money in the drawer, so there is a balance to disagree with.
 *
 * A freshly migrated database has an empty till, and a count of zero against
 * a ledger of zero is `balanced` — the one status that proves nothing here.
 * Funded through `record_other_income` against 4900 Other Income, because
 * 4100 and 4200 are posted by the lending functions from payment allocations
 * and `record_other_income` rightly refuses to let anything else write them.
 */
async function fundCashAccount(
  actor: TestUser,
  cashAccountId: string,
  amount: number,
): Promise<void> {
  const incomeAccount = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = '4900'`,
  );

  const funded = await asUserCommitted(actor, [
    {
      sql: 'select public.record_other_income($1, $2, $3, null, $4) as id',
      params: [incomeAccount.id, cashAccountId, amount, 'Opening float for the suite'],
    },
  ]);

  if (!funded.ok) throw new Error(`could not fund the till: ${funded.message ?? ''}`);
}

describeDb('cash reconciliation under the V1 restriction', () => {
  let owner: TestUser;
  let cashAccountId: string;
  let originalReview = true;

  beforeAll(async () => {
    const seeded = await queryOne<{ reconciliation_requires_review: boolean }>(
      'select reconciliation_requires_review from public.finance_settings where id = 1',
    );
    originalReview = seeded.reconciliation_requires_review;

    owner = (await createLoanScenario()).owner;

    const account = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts
        where is_postable = true and cash_kind is not null order by code limit 1`,
    );
    cashAccountId = account.id;

    // A real balance to disagree with.
    await fundCashAccount(owner, cashAccountId, 5_000_000);
  });

  afterAll(async () => {
    await setReview(originalReview);
    await deleteTestUsers();
    await closePool();
  });

  it('records a difference and writes nothing off while review is required', async () => {
    await setReview(true);

    const system = await queryOne<{ balance: string }>(
      'select public.ledger_account_balance($1)::text as balance',
      [cashAccountId],
    );
    const before = await overShortBalance();

    // Count the drawer 50,000 short of the ledger.
    // One reconciliation per account per business date, so each case takes a
    // date of its own. Both are in the past; a future date is refused.
    const counted = Number(system.balance) - 50_000;
    expect(counted, 'the till must hold more than the shortfall').toBeGreaterThan(0);

    const submitted = await asUserCommitted(owner, [
      {
        sql: `select public.submit_reconciliation(
                $1, (public.business_date() - 1), $2, $3) as id`,
        params: [cashAccountId, counted, 'V1 restriction probe'],
      },
    ]);
    expect(submitted.ok, submitted.message).toBe(true);

    const id = submitted.rows?.[0]?.id as string;
    const row = await queryOne<{ status: string }>(
      'select status from public.account_reconciliations where id = $1',
      [id],
    );

    // Recorded, visible, and waiting — not written off.
    expect(row.status).toBe('submitted');
    expect(await overShortBalance()).toBe(before);

    const journals = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.journal_entries
        where source_type like '%reconciliation%' and source_id = $1`,
      [id],
    );
    expect(Number(journals.n)).toBe(0);
  });

  it('still writes nothing off when the review setting is turned OFF', async () => {
    // The setting lives on `finance_settings`, which the same Owner may edit,
    // so a control that depended on it could be removed by the person it
    // constrains. Since 20261112000100 `submit_reconciliation` approves
    // nothing at all, and this asserts the setting can no longer buy anybody
    // a self-closed variance.
    await setReview(false);

    const system = await queryOne<{ balance: string }>(
      'select public.ledger_account_balance($1)::text as balance',
      [cashAccountId],
    );
    const before = await overShortBalance();

    const counted = Number(system.balance) - 25_000;
    expect(counted, 'the till must hold more than the shortfall').toBeGreaterThan(0);

    const submitted = await asUserCommitted(owner, [
      {
        sql: `select public.submit_reconciliation(
                $1, (public.business_date() - 2), $2, $3) as id`,
        params: [cashAccountId, counted, 'Review-off probe'],
      },
    ]);
    expect(submitted.ok, submitted.message).toBe(true);

    const row = await queryOne<{ status: string }>(
      'select status from public.account_reconciliations where id = $1',
      [submitted.rows?.[0]?.id],
    );

    // Recorded and waiting, exactly as when review is required.
    expect(row.status).toBe('submitted');
    expect(await overShortBalance()).toBe(before);

    await setReview(true);
  });

  it('refuses the counter who tries to approve their own difference', async () => {
    await setReview(true);

    const system = await queryOne<{ balance: string }>(
      'select public.ledger_account_balance($1)::text as balance',
      [cashAccountId],
    );
    const before = await overShortBalance();
    const counted = Number(system.balance) - 10_000;

    const submitted = await asUserCommitted(owner, [
      {
        sql: `select public.submit_reconciliation(
                $1, (public.business_date() - 3), $2, $3) as id`,
        params: [cashAccountId, counted, 'Self-approval probe'],
      },
    ]);
    expect(submitted.ok, submitted.message).toBe(true);
    const id = submitted.rows?.[0]?.id as string;

    // The Owner holds reconciliation:approve. It is not enough.
    const selfApproval = await asUser(
      owner,
      'select public.approve_reconciliation($1, $2)',
      [id, 'Closing my own count'],
    );
    expect(selfApproval.ok).toBe(false);
    expect(selfApproval.code).toBe('42501');
    expect(selfApproval.message ?? '').toMatch(/cannot approve it/i);

    // Still waiting, and the ledger has not moved.
    const row = await queryOne<{ status: string }>(
      'select status from public.account_reconciliations where id = $1',
      [id],
    );
    expect(row.status).toBe('submitted');
    expect(await overShortBalance()).toBe(before);
  });

  it('refuses a self-approval written straight to the table, not only through the function', async () => {
    const row = await queryOne<{ id: string; performed_by: string | null }>(
      `select id, performed_by from public.account_reconciliations
        where status = 'submitted' and performed_by is not null
        order by created_at desc limit 1`,
    );

    // The CHECK constraint, reached as the table owner — the one caller that
    // never passes through approve_reconciliation.
    let refused = false;
    try {
      await query(
        `update public.account_reconciliations
            set reviewed_by = performed_by where id = $1`,
        [row.id],
      );
    } catch (error) {
      refused = true;
      expect(String((error as { message?: string }).message ?? '')).toMatch(
        /account_reconciliations_reviewer_is_not_performer/,
      );
    }
    expect(refused, 'the constraint must refuse a self-review').toBe(true);
  });

  it('states the rule in the function as well as the constraint', async () => {
    const definition = await queryOne<{ def: string }>(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'approve_reconciliation'`,
    );

    // Both layers, deliberately: the function raise gives the person a
    // sentence they can act on, and the constraint holds for callers that
    // never reach the function.
    expect(definition.def).toMatch(/reconciliation:approve/);
    expect(definition.def).toMatch(/performed_by\s*=\s*public\.current_profile_id\(\)/);

    const constraint = await queryOne<{ n: string }>(
      `select count(*)::text as n from pg_constraint
        where conname = 'account_reconciliations_reviewer_is_not_performer'`,
    );
    expect(Number(constraint.n)).toBe(1);
  });
});
