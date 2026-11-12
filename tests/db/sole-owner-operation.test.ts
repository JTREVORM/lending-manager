/**
 * The whole V1 lending cycle, performed by one Owner and nobody else.
 *
 * The business launching on this release has hired no staff. Every capability
 * is held by a single `owner_admin`, so any control that demands a *different*
 * authorized person cannot be satisfied — there is no second person to be.
 *
 * Two different questions are asked here, and they have different answers:
 *
 *   1. **Lending.** Does the loan lifecycle require a second actor anywhere?
 *      It must not, and this file proves it does not: one Owner takes a loan
 *      from draft to cleared, and the money arithmetic is the database's own.
 *
 *   2. **Company cash movement.** `approve_transfer` and `approve_expense`
 *      deliberately refuse the person who raised the movement. That is a real
 *      control and this file does not weaken it. What it pins down is the
 *      *documented* way a single-operator business is accommodated: a NULL
 *      threshold, which `request_transfer` and `record_expense` read as "no
 *      movement ever waits". Both halves are asserted — the refusal still
 *      bites above a set threshold, and NULL is what clears the road.
 *
 * The second half is the regression that matters for launch. The threshold is
 * reachable only through `finance_settings`, and the Settings form could not
 * express NULL: it rendered NULL as `0` in a required field, so saving the
 * screen turned "never ask for a second signature" into "always ask for one"
 * — unapprovable by construction for a sole Owner. The form is fixed; these
 * tests fix the behaviour it has to keep producing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseApprovedLoan,
  submitLoan,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  newIdempotencyKey,
  readLedger,
} from '../helpers/payment-fixtures';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('sole-owner operation', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

/** Restore the thresholds this suite moves, so it leaves the table as it found it. */
async function setThresholds(
  transfer: number | null,
  expense: number | null,
): Promise<void> {
  await query(
    `update public.finance_settings
        set transfer_approval_threshold = $1, expense_approval_threshold = $2
      where id = 1`,
    [transfer, expense],
  );
}

/**
 * Put money in a cash account, the way the product does.
 *
 * The posting functions refuse to overdraw a drawer — `allow_negative_cash` is
 * off, and a drawer cannot hold less than nothing. Disbursing a loan takes
 * cash out, so a test that then moves cash has to have put some in first.
 * Recorded through `record_other_income` rather than by writing a journal
 * line, so the balance these tests move against was built by the same code
 * the business uses.
 */
async function fundCashAccount(
  actor: TestUser,
  cashAccountId: string,
  amount: number,
): Promise<void> {
  // 4900 Other Income. Not 4100 or 4200: interest and penalty income are
  // posted by the lending functions from payment allocations, and
  // `record_other_income` rightly refuses to let anything else write them.
  const incomeAccount = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = '4900'`,
  );

  const funded = await asUserCommitted(actor, [
    {
      sql: `select public.record_other_income($1, $2, $3, null, $4) as income_id`,
      params: [incomeAccount.id, cashAccountId, amount, 'Opening float for the suite'],
    },
  ]);

  if (!funded.ok) throw new Error(`could not fund the till: ${funded.message ?? ''}`);
}

describeDb('a sole Owner can run the business', () => {
  let owner: TestUser;
  let clientId: string;
  let originalTransfer: number | null = null;
  let originalExpense: number | null = null;

  beforeAll(async () => {
    const seeded = await queryOne<{
      transfer_approval_threshold: number | null;
      expense_approval_threshold: number | null;
    }>(
      `select transfer_approval_threshold, expense_approval_threshold
         from public.finance_settings where id = 1`,
    );
    originalTransfer = seeded.transfer_approval_threshold;
    originalExpense = seeded.expense_approval_threshold;

    const scenario = await createLoanScenario();
    clientId = scenario.clientId;
    owner = scenario.owner;
  });

  afterAll(async () => {
    await setThresholds(originalTransfer, originalExpense);
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // ---------------------------------------------------------------------
  // 1. Lending needs no second person
  // ---------------------------------------------------------------------

  it('takes one loan from draft to cleared with the Owner as the only actor', async () => {
    const actors = { secretary: owner, manager: owner, owner };
    const loanId = await createDraftLoan(clientId, { principal: 500_000 });

    await submitLoan(loanId, actors);
    await approveLoan(loanId, actors);
    await disburseApprovedLoan(loanId, actors);

    const afterDisbursement = await queryOne<{ status: string }>(
      'select status from public.loans where id = $1',
      [loanId],
    );
    expect(afterDisbursement.status).toBe('active');

    // A schedule exists, so the borrower has something to pay against.
    const schedule = await queryOne<{ installments: string }>(
      'select count(*) as installments from public.loan_schedules where loan_id = $1',
      [loanId],
    );
    expect(Number(schedule.installments)).toBeGreaterThan(0);

    // Pay the loan off in full, as the Owner, and let the database decide the
    // allocation and the closing balance. Nothing here supplies either.
    const owed = await readLedger(loanId);
    expect(owed.totalOutstanding).toBeGreaterThan(0);

    const settle = await asUserCommitted(owner, [
      {
        sql: 'select public.post_payment($1, $2, $3, null, $4) as payment_id',
        params: [loanId, owed.totalOutstanding, 'cash', newIdempotencyKey()],
      },
    ]);
    expect(settle.ok, settle.message).toBe(true);

    const cleared = await queryOne<{ status: string }>(
      'select status from public.loans where id = $1',
      [loanId],
    );
    expect(cleared.status).toBe('cleared');

    const settled = await readLedger(loanId);
    expect(settled.totalOutstanding).toBe(0);
    expect(settled.fullyRepaid).toBe(true);
  });

  it('offers the Owner every capability the lending cycle asks for', async () => {
    // Read as the Owner rather than from the matrix directly, so this reflects
    // what a session actually resolves.
    for (const capability of [
      'clients:create',
      'loans:create',
      'loans:submit',
      'loans:approve',
      'loans:disburse',
      'payments:create',
      'payments:reverse',
      'reports:view_financial',
    ]) {
      const held = await asUser(owner, 'select public.user_has_permission($1) as held', [
        capability,
      ]);
      expect(held.ok, `${capability}: ${held.message ?? ''}`).toBe(true);
      expect(held.rows?.[0]?.held, `Owner must hold ${capability}`).toBe(true);
    }
  });

  // ---------------------------------------------------------------------
  // 2. Company cash movement: the control stands, and NULL is the way out
  // ---------------------------------------------------------------------

  it('still refuses to let the Owner approve their own transfer above the threshold', async () => {
    await setThresholds(1_000_000, 1_000_000);

    const accounts = await query<{ id: string }>(
      `select a.id from public.ledger_accounts a
        where a.is_postable = true and a.cash_kind is not null
        order by a.code limit 2`,
    );
    expect(accounts.length, 'two cash accounts are needed').toBe(2);

    const raised = await asUserCommitted(owner, [
      {
        sql: `select public.record_transfer($1, $2, $3, null, $4, null) as transfer_id`,
        params: [accounts[0]!.id, accounts[1]!.id, 2_000_000, 'Above the threshold'],
      },
    ]);
    expect(raised.ok, raised.message).toBe(true);
    const transferId = raised.rows?.[0]?.transfer_id as string;

    const held = await queryOne<{ status: string }>(
      'select status from public.account_transfers where id = $1',
      [transferId],
    );
    expect(held.status).toBe('pending_approval');

    // The separation-of-duties rule is intact: the raiser cannot approve.
    const selfApproval = await asUser(owner, 'select public.approve_transfer($1)', [
      transferId,
    ]);
    expect(selfApproval.ok).toBe(false);
    expect(selfApproval.message ?? '').toMatch(
      /cannot be approved by the person who requested it/i,
    );

    // And it is still pending, not quietly posted.
    const stillHeld = await queryOne<{ status: string }>(
      'select status from public.account_transfers where id = $1',
      [transferId],
    );
    expect(stillHeld.status).toBe('pending_approval');
  });

  it('posts a transfer immediately when the threshold is absent', async () => {
    await setThresholds(null, null);

    const accounts = await query<{ id: string }>(
      `select a.id from public.ledger_accounts a
        where a.is_postable = true and a.cash_kind is not null
        order by a.code limit 2`,
    );
    await fundCashAccount(owner, accounts[0]!.id, 12_000_000);

    const posted = await asUserCommitted(owner, [
      {
        sql: `select public.record_transfer($1, $2, $3, null, $4, null) as transfer_id`,
        params: [accounts[0]!.id, accounts[1]!.id, 9_000_000, 'No threshold in force'],
      },
    ]);
    expect(posted.ok, posted.message).toBe(true);

    const row = await queryOne<{ status: string }>(
      'select status from public.account_transfers where id = $1',
      [posted.rows?.[0]?.transfer_id],
    );
    // NULL means no movement waits, however large, so a sole Owner is not
    // stranded. This is the state the Settings form must be able to save.
    expect(row.status).toBe('posted');
  });

  it('posts an expense immediately when the threshold is absent', async () => {
    await setThresholds(null, null);

    const expenseAccount = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts
        where account_type = 'expense' and is_postable = true order by code limit 1`,
    );
    const cashAccount = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts
        where is_postable = true and cash_kind is not null order by code limit 1`,
    );
    await fundCashAccount(owner, cashAccount.id, 6_000_000);

    const posted = await asUserCommitted(owner, [
      {
        sql: `select public.record_expense($1, $2, $3, null, $4, null, null, null) as expense_id`,
        params: [expenseAccount.id, cashAccount.id, 4_000_000, 'No threshold in force'],
      },
    ]);
    expect(posted.ok, posted.message).toBe(true);

    const row = await queryOne<{ status: string }>(
      'select status from public.expenses where id = $1',
      [posted.rows?.[0]?.expense_id],
    );
    expect(row.status).toBe('posted');
  });

  it('leaves the reconciliation path open to a single actor, which is the known gap', async () => {
    // Not an endorsement: recorded so that the behaviour a sole Owner depends
    // on cannot change unnoticed, and so the control gap stays visible. A cash
    // count that disagrees with the ledger is approvable by whoever counted,
    // because `approve_reconciliation` carries no distinct-actor rule. For one
    // operator that is the only way to close a difference at all; once a second
    // person handles cash it is a weakness to close in code.
    const definition = await queryOne<{ def: string }>(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'approve_reconciliation'`,
    );
    expect(definition.def).toMatch(/reconciliation:approve/);
    expect(definition.def).not.toMatch(
      /performed_by\s*=\s*public\.current_profile_id\(\)/,
    );
  });
});
