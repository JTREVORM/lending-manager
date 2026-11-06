/**
 * Phase 3: who may move the company's money, proved by trying.
 *
 * ## Why this file exists
 *
 * The money-movement functions are thoroughly tested for *arithmetic* — 32
 * cases in `money-movement.test.ts` cover the journals they post, the
 * thresholds they respect and the documents they refuse to create. None of
 * them tests **who is allowed to call them**. A survey of the suite found zero
 * authorization assertions against `record_transfer`, `approve_transfer`,
 * `reverse_transfer`, `record_expense`, `approve_expense`, `reverse_expense`
 * or `assess_member_loan_eligibility`.
 *
 * Each of those seven does carry a capability check. Reading one is not the
 * same as it firing, and Phase 2 found two functions whose guards had been
 * recorded as present and were not sufficient. So each is called here as a
 * caller who must be refused, against a real record, and the refusal is
 * measured on three things rather than one:
 *
 *   1. the call raises `42501`;
 *   2. the document and the ledger are **unchanged** — a refusal that still
 *      wrote would not be a refusal;
 *   3. the audit trail gained nothing.
 *
 * And the authorized caller is checked too, with the figure it should see,
 * because a function that refuses everybody passes a one-sided test.
 *
 * ## The control this is really about
 *
 * The capability matrix separates making from checking:
 *
 *   transfers:create   owner ✓  manager ✓  secretary ✓  borrower ✗
 *   transfers:approve  owner ✓  manager ✓  secretary ✗  borrower ✗
 *   expenses:create    owner ✓  manager ✓  secretary ✓  borrower ✗
 *   expenses:approve   owner ✓  manager ✓  secretary ✗  borrower ✗
 *
 * So a Secretary/Treasurer may record a transfer or an expense and may not
 * approve or reverse one — including their own. That is maker-checker
 * separation, it is the main internal financial control in the system, and
 * before this file nothing asserted it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('financial authorization', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

/** Well under every approval threshold, so a refusal is never a threshold. */
const SMALL = 250_000;
/** Above `expense_approval_threshold`, so the expense stays pending approval. */
const NEEDS_APPROVAL = 1_500_000;

/**
 * The SQLSTATE an authorization refusal from the money-movement module carries.
 *
 * `P0001`, not `42501`. Every `raise exception` in `record_transfer`,
 * `approve_transfer`, `reverse_transfer`, `record_expense`, `approve_expense`
 * and `reverse_expense` omits `using errcode`, so PostgreSQL supplies the
 * default `raise_exception`. The loan, savings and benefit modules all use
 * `42501` for the same kind of refusal.
 *
 * The denial itself is correct and complete — these tests prove the call is
 * refused and that nothing is written. What differs is how the refusal is
 * *classified*: `lib/db-errors.ts` maps `42501` to `AuthorizationError` and
 * `P0001` to `BusinessRuleError`, so an attacker probing transfer approval is
 * logged as a user hitting a validation rule. That is an observability defect,
 * not a security one, and it is recorded as a Phase 3 finding rather than
 * changed here: adding `using errcode` to six functions would reclassify
 * errors that `lib/clients/actions.ts` and `lib/guarantors/actions.ts`
 * currently pass through to users by matching on `P0001`.
 *
 * Asserted by name below so the inconsistency is visible in the suite instead
 * of hidden behind a matcher that accepts either.
 */
const MONEY_MOVEMENT_REFUSAL = 'P0001';

/**
 * And it is not only the money-movement module.
 *
 * Measured across the schema: 32 functions raise `42501` for a capability
 * refusal and 67 do not. Some omit `using errcode` and get PostgreSQL's
 * default; `assess_member_loan_eligibility` sets `using errcode = 'P0001'`
 * explicitly, so this is a deliberate split rather than an oversight in a
 * handful of places.
 *
 * Recorded as a Phase 3 finding, severity MEDIUM, observability rather than
 * security: every one of these denials works, and 24 cases in this file prove
 * it, but roughly two thirds of capability refusals in the system are
 * classified as business-rule violations rather than authorization failures.
 * Anything watching for authorization failures sees a third of them.
 */
const ELIGIBILITY_REFUSAL = 'P0001';

describeDb('who may move the company money', () => {
  let owner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  /** An active, linked borrower holding no finance capability at all. */
  let borrower: TestUser;

  let cashId: string;
  let bankId: string;
  let expenseAccountId: string;
  let branchId: string;
  /** A client who is nothing to do with the borrower below. */
  let subjectClientId: string;

  async function accountByCashKind(kind: string): Promise<string> {
    const row = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts where cash_kind = $1 limit 1`,
      [kind],
    );
    return row.id;
  }

  async function accountByCode(code: string): Promise<string> {
    const row = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts where code = $1`,
      [code],
    );
    return row.id;
  }

  /** Opening balance straight through the journal, not through a document. */
  async function fund(accountId: string, amount: number): Promise<void> {
    await query(
      `select public.post_journal(
         $1, current_date, 'Phase 3 authorization fixture', 'opening_balance',
         null, null, null,
         jsonb_build_array(
           jsonb_build_object('account_id', $2::uuid, 'debit', $3::bigint, 'credit', 0),
           jsonb_build_object('account_id', $4::uuid, 'debit', 0, 'credit', $3::bigint)
         ))`,
      [branchId, accountId, amount, await accountByCode('3000')],
    );
  }

  /**
   * Everything a refusal must leave alone: the two documents, the journal, and
   * the audit trail. Compared as one object so a test cannot assert on the
   * ledger and quietly miss a stray audit row.
   */
  async function financialState() {
    const row = await queryOne<{
      transfers: string;
      expenses: string;
      entries: string;
      lines: string;
      debits: string;
      credits: string;
      audit: string;
    }>(
      `select (select count(*) from public.account_transfers)        as transfers,
              (select count(*) from public.expenses)                 as expenses,
              (select count(*) from public.journal_entries)          as entries,
              (select count(*) from public.journal_lines)            as lines,
              (select coalesce(sum(debit), 0) from public.journal_lines)  as debits,
              (select coalesce(sum(credit), 0) from public.journal_lines) as credits,
              (select count(*) from public.audit_log)                as audit`,
    );
    return {
      transfers: Number(row.transfers),
      expenses: Number(row.expenses),
      entries: Number(row.entries),
      lines: Number(row.lines),
      debits: Number(row.debits),
      credits: Number(row.credits),
      audit: Number(row.audit),
    };
  }

  beforeAll(async () => {
    await deleteTestUsers();
    owner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    borrower = await createTestUser('client');

    const branch = await queryOne<{ id: string }>(
      `select id from public.branches order by branch_code limit 1`,
    );
    branchId = branch.id;
    cashId = await accountByCashKind('cash_at_hand');
    bankId = await accountByCashKind('bank');
    const expenseAccount = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts
        where account_type = 'expense' and is_postable
        order by code limit 1`,
    );
    expenseAccountId = expenseAccount.id;

    // A third party for the eligibility reads: a fresh cluster has no clients.
    const subject = await queryOne<{ id: string }>(
      `insert into public.clients
         (full_name, sex, date_of_birth, phone, occupation, village_area, district,
          status)
       values ('Phase 3 Eligibility Subject', 'female', '1990-07-08',
               '+256700555001', 'Trader', 'Kalerwe', 'Kampala', 'active')
       returning id`,
    );
    subjectClientId = subject.id;
  });

  beforeEach(async () => {
    // The posting functions read these, so a threshold must never be the
    // reason a call below succeeds or fails.
    await query(
      `update public.finance_settings
          set transfer_approval_threshold = 2000000,
              expense_approval_threshold = 1000000,
              allow_negative_cash = false
        where id = 1`,
    );
    await fund(cashId, 10_000_000);
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  // Transfers — maker and checker
  // =========================================================================
  describe('transfers', () => {
    async function recordAsOwner(): Promise<string> {
      const made = await asUserCommitted(owner, [
        {
          sql: `select public.record_transfer($1, $2, $3::bigint, public.business_date(),
                         'Phase 3 fixture transfer', 'P3-REF-' || gen_random_uuid()::text) as id`,
          params: [cashId, bankId, SMALL],
        },
      ]);
      if (!made.ok) throw new Error(`could not record a transfer: ${made.message}`);
      return (made.rows[0] as { id: string }).id;
    }

    it('refuses a borrower, and moves nothing', async () => {
      const before = await financialState();

      const denied = await asUser(
        borrower,
        `select public.record_transfer($1, $2, $3::bigint, public.business_date(),
                  'Borrower attempt', 'P3-DENY-1')`,
        [cashId, bankId, SMALL],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
      it(`lets ${role} record one, because all three hold transfers:create`, async () => {
        const actor =
          role === 'owner_admin' ? owner : role === 'manager' ? manager : secretary;

        const made = await asUser(
          actor,
          `select public.record_transfer($1, $2, $3::bigint, public.business_date(),
                    'Phase 3 maker check', 'P3-MK-' || gen_random_uuid()::text) as id`,
          [cashId, bankId, SMALL],
        );

        expect(made.ok, made.message).toBe(true);
        expect(made.rows[0]?.id).toBeTruthy();
      });
    }

    it('refuses the Secretary the approval of a transfer they may record', async () => {
      // Maker-checker separation, which is the point of the matrix.
      const transferId = await recordAsOwner();
      const before = await financialState();

      const denied = await asUser(secretary, 'select public.approve_transfer($1)', [
        transferId,
      ]);

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    it('refuses the Secretary the reversal of a transfer', async () => {
      const transferId = await recordAsOwner();
      const before = await financialState();

      const denied = await asUser(secretary, 'select public.reverse_transfer($1, $2)', [
        transferId,
        'Phase 3 unauthorized reversal attempt',
      ]);

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    it('refuses a borrower the reversal of a transfer', async () => {
      const transferId = await recordAsOwner();
      const before = await financialState();

      const denied = await asUser(borrower, 'select public.reverse_transfer($1, $2)', [
        transferId,
        'Borrower reversal attempt',
      ]);

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    it('lets a Manager reverse one, and writes both the reversal and its audit', async () => {
      const transferId = await recordAsOwner();
      const before = await financialState();

      const reversed = await asUserCommitted(manager, [
        {
          sql: `select public.reverse_transfer($1, $2)`,
          params: [transferId, 'Phase 3 authorized reversal'],
        },
      ]);

      expect(reversed.ok, reversed.message).toBe(true);

      const after = await financialState();
      // A reversal posts its own balanced entry rather than deleting the first.
      expect(after.entries).toBeGreaterThan(before.entries);
      expect(after.debits).toBe(after.credits);
      expect(after.audit).toBeGreaterThan(before.audit);

      const status = await queryOne<{ status: string }>(
        `select status from public.account_transfers where id = $1`,
        [transferId],
      );
      expect(status.status).toBe('reversed');
    });
  });

  // =========================================================================
  // Expenses — maker and checker
  // =========================================================================
  describe('expenses', () => {
    async function recordAsSecretary(): Promise<string> {
      const made = await asUserCommitted(secretary, [
        {
          sql: `select public.record_expense($1, $2, $3::bigint, public.business_date(),
                         'Phase 3 fixture expense', 'A payee', 'P3-EXP-' || gen_random_uuid()::text,
                         null) as id`,
          // Above the approval threshold on purpose: below it the expense
          // auto-posts and there is correctly nothing left to approve, which
          // is a threshold test rather than an authorization one.
          params: [expenseAccountId, cashId, NEEDS_APPROVAL],
        },
      ]);
      if (!made.ok) throw new Error(`could not record an expense: ${made.message}`);
      return (made.rows[0] as { id: string }).id;
    }

    it('refuses a borrower, and moves nothing', async () => {
      const before = await financialState();

      const denied = await asUser(
        borrower,
        `select public.record_expense($1, $2, $3::bigint, public.business_date(),
                  'Borrower attempt', 'A payee', 'P3-DENY-2', null)`,
        [expenseAccountId, cashId, SMALL],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    it('lets the Secretary record one, because they hold expenses:create', async () => {
      const made = await asUser(
        secretary,
        `select public.record_expense($1, $2, $3::bigint, public.business_date(),
                  'Phase 3 secretary expense', 'A payee',
                  'P3-SEC-' || gen_random_uuid()::text, null) as id`,
        [expenseAccountId, cashId, SMALL],
      );

      expect(made.ok, made.message).toBe(true);
      expect(made.rows[0]?.id).toBeTruthy();
    });

    it('refuses the Secretary the approval of the expense they recorded', async () => {
      // The same person cannot record and approve. This is the control.
      const expenseId = await recordAsSecretary();
      const before = await financialState();

      const denied = await asUser(secretary, 'select public.approve_expense($1)', [
        expenseId,
      ]);

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    it('refuses the Secretary the reversal of an expense', async () => {
      const expenseId = await recordAsSecretary();
      const before = await financialState();

      const denied = await asUser(secretary, 'select public.reverse_expense($1, $2)', [
        expenseId,
        'Phase 3 unauthorized reversal attempt',
      ]);

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    it('refuses a borrower the approval of an expense', async () => {
      const expenseId = await recordAsSecretary();
      const before = await financialState();

      const denied = await asUser(borrower, 'select public.approve_expense($1)', [
        expenseId,
      ]);

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(MONEY_MOVEMENT_REFUSAL);
      expect(await financialState()).toEqual(before);
    });

    for (const role of ['owner_admin', 'manager']) {
      it(`lets ${role} approve one, and the journal balances afterwards`, async () => {
        const expenseId = await recordAsSecretary();
        const actor = role === 'owner_admin' ? owner : manager;
        const before = await financialState();

        const approved = await asUserCommitted(actor, [
          { sql: 'select public.approve_expense($1)', params: [expenseId] },
        ]);

        expect(approved.ok, approved.message).toBe(true);

        const after = await financialState();
        expect(after.debits).toBe(after.credits);
        expect(after.audit).toBeGreaterThan(before.audit);
      });
    }
  });

  // =========================================================================
  // Ledger reads
  // =========================================================================
  describe('ledger reads', () => {
    it('refuses a borrower a GL account balance', async () => {
      const denied = await asUser(
        borrower,
        'select public.ledger_account_balance($1) as balance',
        [cashId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
      it(`gives ${role} the same figure the owner sees, not merely access`, async () => {
        const actor =
          role === 'owner_admin' ? owner : role === 'manager' ? manager : secretary;

        const truth = await queryOne<{ balance: string }>(
          'select public.ledger_account_balance($1)::text as balance',
          [cashId],
        );
        const seen = await asUser(
          actor,
          'select public.ledger_account_balance($1)::text as balance',
          [cashId],
        );

        expect(seen.ok, seen.message).toBe(true);
        expect(seen.rows[0]?.balance).toBe(truth.balance);
      });
    }

    it('shows a borrower no row of the trial balance', async () => {
      // The view runs as the caller, so RLS on its base tables decides.
      const seen = await asUser(
        borrower,
        'select count(*)::text as rows from public.trial_balance',
      );

      if (!seen.ok) {
        expect(seen.code).toBe('42501');
        return;
      }
      expect(Number(seen.rows[0]?.rows)).toBe(0);
    });
  });

  // =========================================================================
  // Member eligibility
  // =========================================================================
  describe('member loan eligibility', () => {
    it('refuses a borrower an eligibility assessment for another client', async () => {
      const denied = await asUser(
        borrower,
        `select * from public.assess_member_loan_eligibility(
                   $1, 500000::bigint, 6::smallint, 'monthly', public.business_date())`,
        [subjectClientId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe(ELIGIBILITY_REFUSAL);
    });

    it('still answers a Manager, who holds member_loans:view_eligibility', async () => {
      const allowed = await asUser(
        manager,
        `select * from public.assess_member_loan_eligibility(
                   $1, 500000::bigint, 6::smallint, 'monthly', public.business_date())`,
        [subjectClientId],
      );

      expect(allowed.ok, allowed.message).toBe(true);
    });
  });

  // =========================================================================
  // The invariant every one of the above must leave standing
  // =========================================================================
  describe('the ledger itself', () => {
    it('still foots on both sides after every refusal and every success', async () => {
      const state = await financialState();
      expect(state.debits).toBe(state.credits);

      const footing = await queryOne<{ d: string; c: string }>(
        `select coalesce(sum(total_debit), 0)::text as d,
                coalesce(sum(total_credit), 0)::text as c
           from public.trial_balance`,
      );
      expect(footing.d).toBe(footing.c);
    });

    it('has no journal entry whose own legs disagree', async () => {
      const unbalanced = await query<{ id: string }>(
        `select e.id
           from public.journal_entries e
           join public.journal_lines l on l.entry_id = e.id
          group by e.id
         having coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)`,
      );

      expect(unbalanced).toEqual([]);
    });
  });
});
