/**
 * Decision A — no unfunded payouts.
 *
 * The Owner's ruling of 2026-11-16, after the full-system audit reproduced a
 * branch till at **−345,000**: a loan was disbursed from a branch that had
 * never been funded, with `allow_negative_cash = false`, and nothing refused
 * it (GAP-001).
 *
 * Every scenario the ruling names is exercised here. Two mechanisms are under
 * test and they are deliberately independent:
 *
 *   * each payout path asks `assert_cash_funds_available` by name, which is
 *     what produces a refusal naming the account and the shortfall; and
 *   * `journal_lines_assert_funded`, a **deferred** constraint trigger, which
 *     refuses at commit whatever the caller is — `service_role`, a
 *     hand-written INSERT, or a posting path written after today.
 *
 * Because the second only fires at COMMIT, `expectError` — which rolls back —
 * cannot see it. `attemptCommitted` below runs a real transaction and commits,
 * which is the only way to test a deferred constraint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTestUser, deleteTestUsers } from '../helpers/auth-fixtures';
import {
  closePool,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  disburseApprovedLoan,
  fundBranchTill,
  submitLoan,
} from '../helpers/loan-fixtures';

const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('cash sufficiency', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * Run statements in a real transaction and commit, returning the error if one
 * is raised. A deferred constraint trigger fires at commit and nowhere else,
 * so a rolled-back probe would report success for a transaction the database
 * would have refused.
 */
async function attemptCommitted(
  statements: readonly { readonly sql: string; readonly params?: readonly unknown[] }[],
): Promise<string | null> {
  const client = await getClient();
  try {
    await client.query('begin');
    for (const s of statements) {
      await client.query(s.sql, [...(s.params ?? [])]);
    }
    await client.query('commit');
    return null;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return error instanceof Error ? error.message : String(error);
  } finally {
    client.release();
  }
}

async function accountId(code: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = $1`,
    [code],
  );
  return row.id;
}

async function headBranch(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.branches order by branch_code limit 1`,
  );
  return row.id;
}

async function availability(
  account: string,
): Promise<{ booked: number; pending: number; available: number }> {
  const row = await queryOne<{ booked: string; pending: string; available: string }>(
    `select booked::text, pending_confirmation::text as pending, available::text
       from public.cash_account_availability where account_id = $1`,
    [account],
  );
  return {
    booked: Number(row.booked),
    pending: Number(row.pending),
    available: Number(row.available),
  };
}

/** A payout of `amount` out of `account`, as a journal, committed. */
function payoutOf(
  branch: string,
  account: string,
  amount: number,
  sourceType = 'loan_disbursement',
) {
  return [
    {
      sql: `select public.post_journal(
              $1, current_date, 'Payout under test', $4, gen_random_uuid(), null, null,
              jsonb_build_array(
                jsonb_build_object('account_id', public.ledger_account_by_code('1200'),
                                   'debit', $3::bigint, 'credit', 0),
                jsonb_build_object('account_id', $2::uuid, 'debit', 0, 'credit', $3::bigint)))`,
      params: [branch, account, amount, sourceType],
    },
  ];
}

/** A receipt of `amount` into `account`, committed, as the counter would. */
async function receiveCash(
  branch: string,
  account: string,
  amount: number,
  sourceType = 'loan_repayment',
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select public.post_journal(
       $1, current_date, 'Receipt under test', $4, gen_random_uuid(), null, null,
       jsonb_build_array(
         jsonb_build_object('account_id', $2::uuid, 'debit', $3::bigint, 'credit', 0),
         jsonb_build_object('account_id', public.ledger_account_by_code('4100'),
                            'debit', 0, 'credit', $3::bigint))) as id`,
    [branch, account, amount, sourceType],
  );
  return row.id;
}

describeDb('Decision A — no unfunded payouts', () => {
  let branch = '';
  let till = '';
  let bank = '';
  let capital = '';

  beforeAll(async () => {
    branch = await headBranch();
    till = await accountId('1010-BR2601');
    bank = await accountId('1040-BR2601');
    capital = await accountId('3000');
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  beforeEach(async () => {
    // Each test starts from a known, empty book. The ledger is append-only
    // and grants DELETE to nobody in the product, so clearing it needs the
    // same documented owner-level trigger exemption every other teardown in
    // this directory uses. The restrictions and deposits cascade from their
    // entries, and a cascade is still a DELETE, so their guards come off too.
    const guards = [
      ['cash_receipt_confirmations', 'cash_receipt_confirmations_no_delete'],
      ['bank_deposits', 'bank_deposits_no_delete'],
      ['bank_deposits', 'bank_deposits_guard'],
      ['journal_lines', 'journal_lines_no_delete'],
      ['journal_entries', 'journal_entries_no_delete'],
      ['journal_entries', 'journal_entries_guard_update'],
    ] as const;

    for (const [table, trigger] of guards) {
      await query(`alter table public.${table} disable trigger ${trigger}`);
    }
    try {
      await query(`update public.journal_entries set reversed_by_entry_id = null`);
      await query(`delete from public.bank_deposits`);
      // The entries only. Lines, restrictions and deposits all cascade from
      // them — and deleting lines on their own would leave an entry with
      // none, which the deferred balance trigger refuses at commit, correctly.
      await query(`delete from public.journal_entries`);
    } finally {
      for (const [table, trigger] of guards) {
        await query(`alter table public.${table} enable trigger ${trigger}`);
      }
    }
  });

  // =========================================================================
  describe('the reproduction', () => {
    it('refuses the −345,000 scenario the audit found, and writes nothing', async () => {
      // The audit's exact shape: a branch whose till has never been funded,
      // and a 400,000 disbursement out of it. Before Decision A this
      // succeeded and left the till at −400,000; two small receipts then
      // brought it to the −345,000 the report records.
      expect((await availability(till)).booked).toBe(0);

      const refusal = await attemptCommitted(payoutOf(branch, till, 400_000));

      expect(refusal).not.toBeNull();
      expect(refusal).toMatch(/does not hold it|less than the/i);

      // And nothing survived: no entry, no line, no balance movement.
      const after = await availability(till);
      expect(after.booked).toBe(0);
      expect(after.available).toBe(0);

      const entries = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries`,
      );
      expect(entries.n).toBe('0');
    });
  });

  // =========================================================================
  describe('the four balances a payout can meet', () => {
    it('permits a payout the account can cover', async () => {
      await fundBranchTill(branch, 500_000);
      expect(await attemptCommitted(payoutOf(branch, till, 500_000))).toBeNull();
      expect((await availability(till)).available).toBe(0);
    });

    it('refuses a payout one shilling beyond the balance', async () => {
      await fundBranchTill(branch, 500_000);
      const refusal = await attemptCommitted(payoutOf(branch, till, 500_001));
      expect(refusal).not.toBeNull();
      expect((await availability(till)).available).toBe(500_000);
    });

    it('refuses a payout from an account holding nothing', async () => {
      expect(await attemptCommitted(payoutOf(branch, till, 1))).not.toBeNull();
    });

    it('refuses a payout covered only by money nobody has confirmed', async () => {
      // The heart of rule 6. The cash is booked — the borrower's repayment is
      // recorded, their arrears are reduced, the ledger balances — and the
      // company may not spend it until a second person has seen it.
      await receiveCash(branch, till, 300_000);

      const held = await availability(till);
      expect(held.booked).toBe(300_000);
      expect(held.pending).toBe(300_000);
      expect(held.available).toBe(0);

      const refusal = await attemptCommitted(payoutOf(branch, till, 300_000));
      expect(refusal).not.toBeNull();
      expect(refusal).toMatch(/awaiting confirmation/i);
    });

    it('permits it once a different officer has confirmed the receipt', async () => {
      const entry = await receiveCash(branch, till, 300_000);

      const confirmation = await queryOne<{ id: string }>(
        `select id from public.cash_receipt_confirmations where journal_entry_id = $1`,
        [entry],
      );
      await query(`select public.confirm_cash_receipt($1, 'Counted in the drawer')`, [
        confirmation.id,
      ]);

      const released = await availability(till);
      expect(released.pending).toBe(0);
      expect(released.available).toBe(300_000);

      expect(await attemptCommitted(payoutOf(branch, till, 300_000))).toBeNull();
    });
  });

  // =========================================================================
  describe('accounts are never pooled', () => {
    it('a funded bank account does not fund a payout from the till', async () => {
      // Rule 3. The branch holds 900,000 — and not in the account the money
      // is being taken out of.
      await query(
        `select public.post_journal(
           $1, current_date, 'Bank capital', 'opening_balance', null, null, null,
           jsonb_build_array(
             jsonb_build_object('account_id', $2::uuid, 'debit', 900000, 'credit', 0),
             jsonb_build_object('account_id', $3::uuid, 'debit', 0, 'credit', 900000)))`,
        [branch, bank, capital],
      );

      expect((await availability(bank)).available).toBe(900_000);
      expect((await availability(till)).available).toBe(0);

      expect(await attemptCommitted(payoutOf(branch, till, 100_000))).not.toBeNull();
    });

    it('one branch cannot fund another branch, in either direction', async () => {
      const other = await queryOne<{ id: string; code: string }>(
        `insert into public.branches (branch_code, name, location, opened_on, status)
         values (public.next_reference('branch'), 'Sufficiency Branch', 'Kampala',
                 current_date, 'active')
         returning id, branch_code as code`,
      );
      const otherTill = await queryOne<{ id: string }>(
        `insert into public.ledger_accounts
           (code, name, account_type, normal_side, cash_kind, branch_id)
         values ('1010-' || $2, 'Cash at Hand — Sufficiency', 'asset', 'debit',
                 'cash_at_hand', $1)
         returning id`,
        [other.id, other.code],
      );

      await fundBranchTill(branch, 800_000);
      expect((await availability(till)).available).toBe(800_000);

      // The company holds 800,000. This branch holds none of it.
      const refusal = await attemptCommitted(payoutOf(other.id, otherTill.id, 50_000));
      expect(refusal).not.toBeNull();
    });
  });

  // =========================================================================
  describe('allow_negative_cash is no longer an override', () => {
    it('does not permit a short payout even when it is switched on', async () => {
      // A-4, and the Owner's instruction 5 in terms. Before Decision A this
      // flag was the only thing standing between a short transfer and the
      // ledger; now nothing reads it.
      await query(
        `update public.finance_settings set allow_negative_cash = true where id = 1`,
      );
      try {
        const refusal = await attemptCommitted(payoutOf(branch, till, 100_000));
        expect(refusal).not.toBeNull();

        // And through the named path, not only the storage trigger.
        const direct = await attemptCommitted([
          {
            sql: `select public.assert_cash_funds_available($1, 100000)`,
            params: [till],
          },
        ]);
        expect(direct).not.toBeNull();
      } finally {
        await query(
          `update public.finance_settings set allow_negative_cash = false where id = 1`,
        );
      }
    });

    it('is recorded in the schema as inert', async () => {
      const row = await queryOne<{ comment: string }>(
        `select col_description('public.finance_settings'::regclass,
                  (select attnum from pg_attribute
                    where attrelid = 'public.finance_settings'::regclass
                      and attname = 'allow_negative_cash')) as comment`,
      );
      expect(row.comment).toMatch(/INERT/);
    });
  });

  // =========================================================================
  describe('money on its way to the bank', () => {
    let deposit = '';

    beforeEach(async () => {
      await fundBranchTill(branch, 600_000);
      const row = await queryOne<{ id: string }>(
        `select public.record_bank_deposit($1, $2, 400000, 'To the bank', gen_random_uuid()) as id`,
        [till, bank],
      );
      deposit = row.id;
    });

    it('leaves the till, and is spendable from neither the till nor the bank', async () => {
      const transit = await queryOne<{ id: string }>(
        `select transit_account_id as id from public.bank_deposits where id = $1`,
        [deposit],
      );

      expect((await availability(till)).available).toBe(200_000);
      expect((await availability(bank)).available).toBe(0);
      expect((await availability(transit.id)).booked).toBe(400_000);

      // Rule 7: it cannot support a payout from anywhere.
      expect(await attemptCommitted(payoutOf(branch, till, 300_000))).not.toBeNull();
      expect(await attemptCommitted(payoutOf(branch, bank, 400_000))).not.toBeNull();

      // Nor can it be spent straight out of transit.
      const fromTransit = await attemptCommitted([
        {
          sql: `select public.assert_spendable_account($1, 'funding')`,
          params: [transit.id],
        },
      ]);
      expect(fromTransit).toMatch(/not spendable until the bank has cleared it/i);
    });

    it('reaches the bank only when a different officer verifies the clearance', async () => {
      const manager = await createTestUser('manager');

      const client = await getClient();
      try {
        await client.query('begin');
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          manager.authUserId,
        ]);
        await client.query('set local role authenticated');
        await client.query(
          `select public.verify_bank_deposit($1, 'BNKREF001', current_date, null, null)`,
          [deposit],
        );
        await client.query('reset role');
        await client.query('commit');
      } finally {
        client.release();
      }

      expect((await availability(bank)).available).toBe(400_000);
      expect(await attemptCommitted(payoutOf(branch, bank, 400_000))).toBeNull();
    });

    it('refuses the officer who recorded it as the one who verifies it', async () => {
      // Rule 8, with a real named session on both halves. The fixture's own
      // connection is the table owner with no JWT, so its `recorded_by` is
      // null — and a constraint comparing two nulls proves nothing. So this
      // deposit is recorded by a named Manager, and the same Manager then
      // tries to clear it.
      const officer = await createTestUser('manager');

      const asOfficer = async (
        sql: string,
        params: readonly unknown[],
      ): Promise<Record<string, unknown>[]> => {
        const client = await getClient();
        try {
          await client.query('begin');
          await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
            officer.authUserId,
          ]);
          await client.query('set local role authenticated');
          const result = await client.query(sql, [...params]);
          await client.query('reset role');
          await client.query('commit');
          return result.rows as Record<string, unknown>[];
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };

      await fundBranchTill(branch, 300_000);
      const recorded = await asOfficer(
        `select public.record_bank_deposit($1, $2, 100000, 'Theirs', gen_random_uuid()) as id`,
        [till, bank],
      );
      const ownDeposit = String(recorded[0]?.id);

      await expect(
        asOfficer(
          `select public.verify_bank_deposit($1, 'SELFREF01', current_date, null, null)`,
          [ownDeposit],
        ),
      ).rejects.toThrow(/cannot verify its clearance|different Manager or Owner/i);

      // Still in transit, and still theirs to hand to somebody else.
      const row = await queryOne<{ status: string }>(
        `select status from public.bank_deposits where id = $1`,
        [ownDeposit],
      );
      expect(row.status).toBe('submitted');
    });

    it('posts nothing when the deposit is investigated, and leaves it in transit', async () => {
      const transit = await queryOne<{ id: string }>(
        `select transit_account_id as id from public.bank_deposits where id = $1`,
        [deposit],
      );
      const before = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries`,
      );

      await query(
        `select public.open_deposit_investigation($1, 'The bank has no record of it')`,
        [deposit],
      );

      const after = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries`,
      );
      expect(after.n).toBe(before.n);
      expect((await availability(transit.id)).booked).toBe(400_000);

      const row = await queryOne<{ status: string }>(
        `select status from public.bank_deposits where id = $1`,
        [deposit],
      );
      expect(row.status).toBe('under_investigation');
    });
  });

  // =========================================================================
  describe('the approval-controlled paths', () => {
    // The Owner's instruction to verify transfers, expenses, Mobile Money and
    // Agency transactions explicitly, and to introduce no second definition
    // of available balance.
    //
    // These four are the ones that already asked `assert_cash_available`
    // before Decision A, so they were never part of the defect. What has to
    // be shown is that they now get the *new* rule rather than the old one —
    // which they do because `assert_cash_available` was redefined to delegate
    // rather than left beside its replacement — and that an approval is
    // checked when it posts rather than only when it was raised. A transfer
    // raised this morning above the threshold posts this afternoon, and what
    // the till holds then is what matters.

    it('refuses an approved transfer whose funds have gone since it was raised', async () => {
      // Raised when the money is there.
      const entry = await receiveCash(branch, till, 500_000);
      const confirmation = await queryOne<{ id: string }>(
        `select id from public.cash_receipt_confirmations where journal_entry_id = $1`,
        [entry],
      );
      await query(`select public.confirm_cash_receipt($1, 'Counted')`, [confirmation.id]);
      expect((await availability(till)).available).toBe(500_000);

      const settings = await queryOne<{ threshold: string | null }>(
        `select transfer_approval_threshold::text as threshold
           from public.finance_settings where id = 1`,
      );

      await query(
        `update public.finance_settings set transfer_approval_threshold = 1 where id = 1`,
      );

      try {
        const raisedId = await queryOne<{ id: string }>(
          `select public.record_transfer($1, $2, 400000, current_date,
                                         'Banking the takings') as id`,
          [till, bank],
        );
        const raised = await queryOne<{ id: string; status: string }>(
          `select id, status from public.account_transfers where id = $1`,
          [raisedId.id],
        );
        expect(raised.status).toBe('pending_approval');

        // Nothing has moved yet: a transfer awaiting approval is not a
        // transfer that has happened.
        expect((await availability(till)).available).toBe(500_000);

        // Then the money leaves by another route before anybody approves.
        const drained = await attemptCommitted(payoutOf(branch, till, 450_000));
        expect(drained).toBeNull();
        expect((await availability(till)).available).toBe(50_000);

        // The approval must now be refused. The check belongs where the
        // journal is posted, not where the document was raised.
        const approval = await attemptCommitted([
          { sql: `select public.approve_transfer($1)`, params: [raised.id] },
        ]);
        expect(approval).not.toBeNull();
        expect(approval).toMatch(/less than the|does not hold it/i);

        const after = await queryOne<{ status: string }>(
          `select status from public.account_transfers where id = $1`,
          [raised.id],
        );
        expect(after.status).toBe('pending_approval');
      } finally {
        await query(
          `update public.finance_settings set transfer_approval_threshold = $1 where id = 1`,
          [settings.threshold],
        );
      }
    });

    it('asks one question, in one place, for every payout path', async () => {
      // There must be exactly one definition of available funds. Every path
      // that asks about cash reaches `assert_cash_funds_available`, either by
      // name or through `assert_cash_available`, which since this migration
      // only delegates to it. A second implementation anywhere would be a
      // second answer, and sooner or later a different one.
      const callers = await query<{ name: string; direct: boolean }>(
        `select p.proname as name,
                pg_get_functiondef(p.oid) ~ 'assert_cash_funds_available' as direct
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            -- prokind first: pg_get_functiondef() raises on an aggregate,
            -- and this schema holds a few.
            and p.prokind = 'f'
            and pg_get_functiondef(p.oid) ~ 'assert_cash(_funds)?_available'
            and p.proname not in ('assert_cash_available', 'assert_cash_funds_available')
          order by p.proname`,
      );

      // Every money-out path the Owner named, and the three that were missing.
      const names = callers.map((c) => c.name);
      for (const required of [
        'post_disbursement_journal',
        'post_savings_withdrawal',
        'post_benefit_payment',
        'post_transfer_journal',
        'post_expense_journal',
        'post_agency_transaction',
      ]) {
        expect(names, `${required} must ask about available funds`).toContain(required);
      }

      // A reversal asks through one more step, and has to: reversing a
      // receipt nobody confirmed should *release* its restriction, while
      // reversing one that was confirmed is a payout like any other. One
      // function decides which, and `post_reversal_journal` calls it.
      expect(names).toContain('release_or_assert_receipt_reversal');
      const reversal = await queryOne<{ body: string }>(
        `select pg_get_functiondef(p.oid) as body
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'post_reversal_journal'`,
      );
      expect(reversal.body).toMatch(/release_or_assert_receipt_reversal/);

      // And `assert_cash_available` is now a delegation, not a second rule:
      // its whole body is one `perform` of the other function.
      const legacy = await queryOne<{ body: string }>(
        `select pg_get_functiondef(p.oid) as body
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'assert_cash_available'`,
      );
      expect(legacy.body).toMatch(/assert_cash_funds_available/);
      expect(legacy.body).not.toMatch(/allow_negative_cash/);
    });
  });

  // =========================================================================
  describe('the loan path, end to end', () => {
    it('refuses a disbursement the branch cannot fund, and leaves the loan approved', async () => {
      const borrower = await createLoanScenario();
      const loanId = await createDraftLoan(borrower.clientId);
      await submitLoan(loanId, borrower);
      await approveLoan(loanId, borrower);

      // Deliberately unfunded — the audit's scenario, through the real path.
      await expect(
        disburseApprovedLoan(loanId, borrower, { fundTill: false }),
      ).rejects.toThrow(/less than|does not hold it/i);

      const loan = await queryOne<{ status: string }>(
        `select status from public.loans where id = $1`,
        [loanId],
      );
      expect(loan.status).toBe('approved');

      // Rule 10 of the original audit: a refused payout moves nothing. No
      // journal, and no schedule either.
      const posted = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.journal_entries
          where source_type = 'loan_disbursement' and source_id = $1`,
        [loanId],
      );
      expect(posted.n).toBe('0');

      const installments = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.loan_installments where loan_id = $1`,
        [loanId],
      );
      expect(installments.n).toBe('0');
    });

    it('disburses once the branch has the money', async () => {
      const borrower = await createLoanScenario();
      const loanId = await createDraftLoan(borrower.clientId);
      await submitLoan(loanId, borrower);
      await approveLoan(loanId, borrower);

      await disburseApprovedLoan(loanId, borrower);

      const loan = await queryOne<{ status: string }>(
        `select status from public.loans where id = $1`,
        [loanId],
      );
      expect(loan.status).toBe('active');
    });

    it('two concurrent disbursements cannot both take the last of the till', async () => {
      // Rule 9. One till, two loans, and only enough for one.
      const first = await createLoanScenario();
      const second = await createLoanScenario();
      const loanA = await createDraftLoan(first.clientId, { principal: 400_000 });
      const loanB = await createDraftLoan(second.clientId, { principal: 400_000 });

      for (const [id, actors] of [
        [loanA, first],
        [loanB, second],
      ] as const) {
        await submitLoan(id, actors);
        await approveLoan(id, actors);
      }

      await fundBranchTill(branch, 400_000);
      expect((await availability(till)).available).toBe(400_000);

      const attempt = async (loanId: string, authUserId: string): Promise<boolean> => {
        const client = await getClient();
        try {
          await client.query('begin');
          await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
            authUserId,
          ]);
          await client.query('set local role authenticated');
          await client.query(`select public.disburse_loan($1)`, [loanId]);
          await client.query('reset role');
          await client.query('commit');
          return true;
        } catch {
          await client.query('rollback').catch(() => undefined);
          return false;
        } finally {
          client.release();
        }
      };

      const outcomes = await Promise.all([
        attempt(loanA, first.owner.authUserId),
        attempt(loanB, second.owner.authUserId),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await availability(till)).available).toBe(0);
    });

    it('a disbursement and another payout cannot both take the last of the till', async () => {
      // Rule 9 across two different kinds of outgoing movement — the shape a
      // disbursement racing a savings withdrawal or a benefit payment has.
      const borrower = await createLoanScenario();
      const loanId = await createDraftLoan(borrower.clientId, { principal: 300_000 });
      await submitLoan(loanId, borrower);
      await approveLoan(loanId, borrower);

      await fundBranchTill(branch, 300_000);

      const disburse = async (): Promise<boolean> => {
        const client = await getClient();
        try {
          await client.query('begin');
          await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
            borrower.owner.authUserId,
          ]);
          await client.query('set local role authenticated');
          await client.query(`select public.disburse_loan($1)`, [loanId]);
          await client.query('reset role');
          await client.query('commit');
          return true;
        } catch {
          await client.query('rollback').catch(() => undefined);
          return false;
        } finally {
          client.release();
        }
      };

      const other = async (): Promise<boolean> =>
        (await attemptCommitted(
          payoutOf(branch, till, 300_000, 'savings_withdrawal'),
        )) === null;

      const [a, b] = await Promise.all([disburse(), other()]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await availability(till)).available).toBe(0);
    });

    it('a benefit payment and another payout cannot both take the last of the till', async () => {
      // The Owner's list names this race by itself, so it is tested by itself
      // rather than by analogy with the one above. Both movements are company
      // money leaving the same drawer, and only one of them may.
      await fundBranchTill(branch, 250_000);
      expect((await availability(till)).available).toBe(250_000);

      const [benefit, other] = await Promise.all([
        attemptCommitted(payoutOf(branch, till, 250_000, 'benefit_payment')),
        attemptCommitted(payoutOf(branch, till, 250_000, 'savings_withdrawal')),
      ]);

      expect([benefit, other].filter((m) => m === null)).toHaveLength(1);
      expect((await availability(till)).available).toBe(0);
    });

    it('a payout and a banking cannot both take the last of the till', async () => {
      // Banking cash takes it out of the drawer as surely as paying it out
      // does, so the two contend for the same available balance. The Owner's
      // list names this one too.
      await fundBranchTill(branch, 500_000);

      const banking = async (): Promise<string | null> =>
        attemptCommitted([
          {
            sql: `select public.record_bank_deposit($1, $2, 500000, 'To the bank',
                                                   gen_random_uuid())`,
            params: [till, bank],
          },
        ]);

      const [paid, banked] = await Promise.all([
        attemptCommitted(payoutOf(branch, till, 500_000)),
        banking(),
      ]);

      expect([paid, banked].filter((m) => m === null)).toHaveLength(1);
      expect((await availability(till)).available).toBe(0);
    });
  });

  // =========================================================================
  describe('reversals, and posting the same thing twice', () => {
    it('releases the restriction when an unconfirmed receipt is reversed', async () => {
      // Booked and pending fall together, so availability never moves and the
      // reversal is not refused for want of funds it never made available.
      const entry = await receiveCash(branch, till, 250_000);
      expect((await availability(till)).available).toBe(0);

      const released = await attemptCommitted([
        {
          sql: `select public.release_or_assert_receipt_reversal($1, $2, 250000)`,
          params: [entry, till],
        },
      ]);
      expect(released).toBeNull();

      const state = await queryOne<{ state: string }>(
        `select state from public.cash_receipt_confirmations where journal_entry_id = $1`,
        [entry],
      );
      expect(state.state).toBe('voided');
      expect((await availability(till)).pending).toBe(0);
    });

    it('treats the reversal of a confirmed receipt as a payout like any other', async () => {
      const entry = await receiveCash(branch, till, 250_000);
      const confirmation = await queryOne<{ id: string }>(
        `select id from public.cash_receipt_confirmations where journal_entry_id = $1`,
        [entry],
      );
      await query(`select public.confirm_cash_receipt($1, null)`, [confirmation.id]);

      // Spent, and then the receipt is reversed: the money is no longer there.
      expect(await attemptCommitted(payoutOf(branch, till, 250_000))).toBeNull();

      const refusal = await attemptCommitted([
        {
          sql: `select public.release_or_assert_receipt_reversal($1, $2, 250000)`,
          params: [entry, till],
        },
      ]);
      expect(refusal).not.toBeNull();
    });

    it('confirms a receipt once, however many times it is asked', async () => {
      const entry = await receiveCash(branch, till, 100_000);
      const confirmation = await queryOne<{ id: string }>(
        `select id from public.cash_receipt_confirmations where journal_entry_id = $1`,
        [entry],
      );

      await query(`select public.confirm_cash_receipt($1, null)`, [confirmation.id]);
      await query(`select public.confirm_cash_receipt($1, null)`, [confirmation.id]);

      const rows = await query(
        `select state from public.cash_receipt_confirmations where journal_entry_id = $1`,
        [entry],
      );
      expect(rows).toHaveLength(1);
      expect((await availability(till)).available).toBe(100_000);
    });

    it('records a deposit once, however many times the same key is used', async () => {
      await fundBranchTill(branch, 500_000);
      const key = await queryOne<{ k: string }>(`select gen_random_uuid()::text as k`);

      const first = await queryOne<{ id: string }>(
        `select public.record_bank_deposit($1, $2, 100000, 'Once', $3::uuid) as id`,
        [till, bank, key.k],
      );
      const second = await queryOne<{ id: string }>(
        `select public.record_bank_deposit($1, $2, 100000, 'Once', $3::uuid) as id`,
        [till, bank, key.k],
      );

      expect(second.id).toBe(first.id);
      const count = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.bank_deposits`,
      );
      expect(count.n).toBe('1');
      expect((await availability(till)).available).toBe(400_000);
    });
  });

  // =========================================================================
  describe('who may see and do what', () => {
    it('hides the confirmation register from a borrower, and shows it to a manager', async () => {
      await receiveCash(branch, till, 50_000);

      const borrower = await createTestUser('client');
      const manager = await createTestUser('manager');

      const seen = async (authUserId: string): Promise<number> => {
        const client = await getClient();
        try {
          await client.query('begin');
          await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
            authUserId,
          ]);
          await client.query('set local role authenticated');
          const rows = await client.query(
            `select id from public.cash_receipt_confirmations`,
          );
          return rows.rowCount ?? 0;
        } finally {
          await client.query('rollback').catch(() => undefined);
          client.release();
        }
      };

      expect(await seen(borrower.authUserId)).toBe(0);
      expect(await seen(manager.authUserId)).toBeGreaterThan(0);
    });

    it('grants the new capabilities to the roles the ruling names', async () => {
      const rows = await query<{ permission_key: string; role_key: string }>(
        `select permission_key, role_key from public.role_permissions
          where permission_key in ('receipts:confirm', 'deposits:verify', 'deposits:reverse')
          order by permission_key, role_key`,
      );
      const by = (key: string) =>
        rows.filter((r) => r.permission_key === key).map((r) => r.role_key);

      // A second pair of eyes, and the Owner alone for a clearance reversal.
      expect(by('receipts:confirm')).toEqual(['manager', 'owner_admin']);
      expect(by('deposits:verify')).toEqual(['manager', 'owner_admin']);
      expect(by('deposits:reverse')).toEqual(['owner_admin']);
    });
  });

  // =========================================================================
  describe('the reporting surface still adds up', () => {
    it('keeps the six components of branch liquidity summing to the total', async () => {
      await fundBranchTill(branch, 700_000);
      await query(
        `select public.record_bank_deposit($1, $2, 200000, 'For the identity',
                                           gen_random_uuid())`,
        [till, bank],
      );

      const row = await queryOne<{
        hand: string;
        mtn: string;
        airtel: string;
        bank: string;
        float: string;
        transit: string;
        total: string;
      }>(
        `select cash_at_hand::text as hand, mtn_mobile_money::text as mtn,
                airtel_money::text as airtel, cash_at_bank::text as bank,
                agency_float::text as float, in_transit::text as transit,
                total_liquidity::text as total
           from public.branch_cash_position where branch_id = $1`,
        [branch],
      );

      const parts =
        Number(row.hand) +
        Number(row.mtn) +
        Number(row.airtel) +
        Number(row.bank) +
        Number(row.float) +
        Number(row.transit);

      expect(parts).toBe(Number(row.total));
      expect(Number(row.transit)).toBe(200_000);
    });

    it('reports availability per account, with no aggregate column', async () => {
      const columns = await query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_name = 'cash_account_availability'`,
      );
      const names = columns.map((c) => c.column_name);
      expect(names).toContain('available');
      expect(names).toContain('pending_confirmation');
      expect(names.some((n) => n.includes('total'))).toBe(false);
    });
  });
});
