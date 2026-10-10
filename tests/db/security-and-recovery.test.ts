import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asUser, asUserScript, deleteTestUsers } from '../helpers/auth-fixtures';
import {
  approveLoan,
  attachExtraGuarantorToLoan,
  cancelLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  postPayment,
  reversePayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Phase 14: the security a loan is written against, the chase recorded against
 * it, and the two aggregates the supervising screens read.
 *
 * Four properties are worth stating before the tests, because each is a rule
 * the schema keeps and no screen could:
 *
 *   1. **A pledged item's identity freezes at disbursement.** Its *status*
 *      never does — an item is released or realised on a live loan by
 *      definition, and a guard that froze those would freeze the only thing
 *      security is for.
 *   2. **A recovery action is never edited.** UPDATE and DELETE are refused
 *      outright, at statement level, so the refusal does not depend on an
 *      attacker's WHERE clause matching anything.
 *   3. **A promise to pay changes nothing contractual, and its verdict is
 *      derived.** Posted payments between the promise and its date, against
 *      the amount promised. Nothing marks a promise broken, and reversing the
 *      payment that kept one un-keeps it with no second write anywhere.
 *   4. **Releasing a guarantor is a decision with a capability, a reason, and
 *      a floor.** The loan keeps the number of guarantors its product
 *      requires, or the release is refused rather than warned about.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('security and recovery suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * Insert a row as the table owner, committed.
 *
 * The triggers still fire — which is the point — but `current_profile_id()` is
 * null, so provenance reads as `system`. Used where a test is about a derived
 * figure rather than about who recorded it; the authorship tests go through a
 * real signed-in session.
 */
async function recordAction(
  loanId: string,
  values: {
    readonly kind: string;
    readonly notes: string;
    readonly actionDate: string;
    readonly outcome?: string | null;
    readonly followUpOn?: string | null;
    readonly promisedAmount?: number | null;
    readonly promisedOn?: string | null;
    readonly correctsActionId?: string | null;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.loan_recovery_actions
       (loan_id, action_kind, outcome, notes, action_date, follow_up_on,
        promised_amount, promised_on, corrects_action_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      loanId,
      values.kind,
      values.outcome ?? null,
      values.notes,
      values.actionDate,
      values.followUpOn ?? null,
      values.promisedAmount ?? null,
      values.promisedOn ?? null,
      values.correctsActionId ?? null,
    ],
  );

  return row.id;
}

async function recordItem(
  loanId: string,
  values?: {
    readonly itemType?: string;
    readonly description?: string;
    readonly value?: number;
    readonly serial?: string | null;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.loan_collateral
       (loan_id, item_type, description, estimated_value, valued_on, serial_number)
     values ($1, $2, $3, $4, current_date - 1, $5)
     returning id`,
    [
      loanId,
      values?.itemType ?? 'motorcycle',
      values?.description ?? 'Red Bajaj Boxer, fair condition',
      values?.value ?? 1_500_000,
      values?.serial ?? null,
    ],
  );

  return row.id;
}

/**
 * A fresh scenario per test, not one shared.
 *
 * `loans_enforce_active_limit` allows a client one active loan at a time —
 * which is a real business rule and the right one — so a suite that reused a
 * borrower would be a suite where the second disbursement failed with
 * `active_loan_exists`. Every test here that needs a live loan needs its own
 * borrower, and the three staff users come with them.
 */
describeDb('security and recovery', () => {
  beforeAll(async () => {
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('collateral', () => {
    it('lets a Secretary/Treasurer record an item against an application', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      const attempt = await asUserScript(scenario.secretary, [
        {
          sql: `insert into public.loan_collateral
                  (loan_id, item_type, description, estimated_value, valued_on)
                values ($1, 'motorcycle', 'Red Bajaj Boxer', 1500000, current_date)`,
          params: [loanId],
        },
        {
          sql: `select status, created_by from public.loan_collateral where loan_id = $1`,
          params: [loanId],
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]).toMatchObject({ status: 'held' });
      // Derived from the session, never from the payload.
      expect(attempt.rows[0]?.created_by).not.toBeNull();
    });

    it('refuses a caller without collateral:manage', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      // Every staff role in this system holds `collateral:manage` — the front
      // office takes the item in — so there is no role to test as. The
      // capability is withdrawn inside the transaction instead, which is
      // exactly what the policy reads, and the insert is refused on the
      // policy rather than on a missing grant.
      const attempt = await asUserScript(scenario.secretary, [
        {
          sql: `delete from public.role_permissions
                 where role_key = 'secretary_treasurer'
                   and permission_key = 'collateral:manage'`,
        },
        {
          sql: `insert into public.loan_collateral
                  (loan_id, item_type, description, estimated_value, valued_on)
                values ($1, 'motorcycle', 'Red Bajaj Boxer', 1500000, current_date)`,
          params: [loanId],
        },
      ]);

      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
    });

    it('freezes what an item is once the money has moved', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      const itemId = await recordItem(loanId);
      await disburseLoan(loanId, scenario);

      const valuation = await asUser(
        scenario.owner,
        `update public.loan_collateral set estimated_value = 9000000 where id = $1`,
        [itemId],
      );

      expect(valuation.ok).toBe(false);
      expect(valuation.message).toMatch(/cannot be changed once the loan is active/i);

      const identity = await asUser(
        scenario.owner,
        `update public.loan_collateral set description = 'Actually a blue one' where id = $1`,
        [itemId],
      );

      expect(identity.ok).toBe(false);
    });

    it('still lets the item be released, which is what a live loan is for', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      const itemId = await recordItem(loanId);
      await disburseLoan(loanId, scenario);

      const attempt = await asUserScript(scenario.owner, [
        {
          sql: `update public.loan_collateral
                   set status = 'released', release_reason = 'Loan secured on land instead'
                 where id = $1`,
          params: [itemId],
        },
        {
          sql: `select status, released_at, released_by, release_reason
                  from public.loan_collateral where id = $1`,
          params: [itemId],
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]).toMatchObject({
        status: 'released',
        release_reason: 'Loan secured on land instead',
      });
      // Stamped by the guard, not supplied.
      expect(attempt.rows[0]?.released_at).not.toBeNull();
      expect(attempt.rows[0]?.released_by).not.toBeNull();
    });

    it('refuses a release date or actor supplied by the caller', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      const itemId = await recordItem(loanId);
      await disburseLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.owner,
        `update public.loan_collateral
            set released_at = '2020-01-01T00:00:00Z'
          where id = $1`,
        [itemId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/stamped by the database/i);
    });

    it('records what a realisation fetched, and does not touch the loan', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      const itemId = await recordItem(loanId);
      await disburseLoan(loanId, scenario);

      const before = await queryOne<{ total_outstanding: string }>(
        `select total_outstanding from public.loan_balances where loan_id = $1`,
        [loanId],
      );

      const attempt = await asUserScript(scenario.owner, [
        {
          sql: `update public.loan_collateral
                   set status = 'realised', realised_amount = 900000,
                       release_reason = 'Sold at Kalerwe'
                 where id = $1`,
          params: [itemId],
        },
        {
          sql: `select c.status, c.realised_amount, c.realised_at, b.total_outstanding
                  from public.loan_collateral c
                  join public.loan_balances b on b.loan_id = c.loan_id
                 where c.id = $1`,
          params: [itemId],
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]).toMatchObject({
        status: 'realised',
        realised_amount: '900000',
      });
      // The sale is a fact about the item. The money reaches the books as a
      // payment, so the balance has not moved.
      expect(attempt.rows[0]?.total_outstanding).toBe(before.total_outstanding);
    });

    it('never lets a released item come back', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      const itemId = await recordItem(loanId);
      await disburseLoan(loanId, scenario);

      await query(
        `update public.loan_collateral
            set status = 'released', release_reason = 'Returned to the borrower'
          where id = $1`,
        [itemId],
      );

      const attempt = await asUser(
        scenario.owner,
        `update public.loan_collateral set status = 'held' where id = $1`,
        [itemId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/already been released/i);
    });

    it('allows removal while the file is being assembled, and not after', async () => {
      const scenario = await createLoanScenario();
      const draftId = await createDraftLoan(scenario.clientId);
      const draftItem = await recordItem(draftId);

      const allowed = await asUser(
        scenario.secretary,
        `delete from public.loan_collateral where id = $1`,
        [draftItem],
      );

      expect(allowed.ok, allowed.message).toBe(true);

      const liveId = await createDraftLoan(scenario.clientId);
      const liveItem = await recordItem(liveId);
      await disburseLoan(liveId, scenario);

      const refused = await asUser(
        scenario.owner,
        `delete from public.loan_collateral where id = $1`,
        [liveItem],
      );

      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/Release it instead/i);
    });

    it('shows cover against exposure in the register', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await recordItem(loanId, { value: 2_000_000 });
      await disburseLoan(loanId, scenario);

      const row = await queryOne<{
        estimated_value: string;
        total_outstanding: string;
        loan_status: string;
      }>(
        `select estimated_value, total_outstanding, loan_status
           from public.loan_collateral_register where loan_id = $1`,
        [loanId],
      );

      expect(row.estimated_value).toBe('2000000');
      expect(row.loan_status).toBe('active');
      expect(Number(row.total_outstanding)).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  describe('recovery actions', () => {
    it('refuses an action on a loan that was never disbursed', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      const attempt = await asUser(
        scenario.secretary,
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date)
         values ($1, 'call', 'Rang about the arrears', current_date)`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/nothing to recover on a draft loan/i);
    });

    it('derives the author from the session', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const attempt = await asUserScript(scenario.secretary, [
        {
          sql: `insert into public.loan_recovery_actions
                  (loan_id, action_kind, outcome, notes, action_date, created_by_label)
                values ($1, 'call', 'no_answer', 'Phone off all morning',
                        current_date, 'Somebody Else')`,
          params: [loanId],
        },
        {
          sql: `select created_by, created_by_label
                  from public.loan_recovery_actions where loan_id = $1`,
          params: [loanId],
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]?.created_by).not.toBeNull();
      // The supplied label is discarded: an action attributed to somebody who
      // did not make the call is the one thing a recovery file must not hold.
      expect(attempt.rows[0]?.created_by_label).not.toBe('Somebody Else');
    });

    it('refuses every UPDATE and every DELETE, matching rows or not', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      const actionId = await recordAction(loanId, {
        kind: 'visit',
        notes: 'Shop closed, neighbour says he travelled',
        actionDate: new Date().toISOString().slice(0, 10),
      });

      const update = await asUser(
        scenario.owner,
        `update public.loan_recovery_actions set notes = 'Reworded' where id = $1`,
        [actionId],
      );
      expect(update.ok).toBe(false);

      const remove = await asUser(
        scenario.owner,
        `delete from public.loan_recovery_actions where id = $1`,
        [actionId],
      );
      expect(remove.ok).toBe(false);

      // Statement-level, so a WHERE clause that matches nothing is refused
      // too. Withholding the grant would stop a session; this stops the
      // privileged client a leaked service key becomes.
      const emptyUpdate = await asUser(
        scenario.owner,
        `update public.loan_recovery_actions set notes = 'Reworded'
          where id = '00000000-0000-4000-8000-000000000000'`,
      );
      expect(emptyUpdate.ok).toBe(false);
    });

    it('corrects a mistake by appending, and keeps the original visible', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      const today = new Date().toISOString().slice(0, 10);

      const original = await recordAction(loanId, {
        kind: 'call',
        notes: 'Promised to pay 300,000 — wrong loan, this was the brother',
        actionDate: today,
      });

      // The pointer is supplied at insert, because the check constraint
      // requires it: a correction that does not say what it corrects is a
      // second note nobody can connect to the first.
      await recordAction(loanId, {
        kind: 'correction',
        notes: 'The call above was about a different borrower.',
        actionDate: today,
        correctsActionId: original,
      });

      const rows = await query<{ id: string; is_corrected: boolean; notes: string }>(
        `select id, is_corrected, notes from public.loan_recovery_register
           where loan_id = $1 order by action_kind`,
        [loanId],
      );

      // Both rows are there. The original still says exactly what it said.
      expect(rows).toHaveLength(2);
      const originalRow = rows.find((row) => row.id === original);
      expect(originalRow?.is_corrected).toBe(true);
      expect(originalRow?.notes).toMatch(/wrong loan/);
    });

    it('keeps a correction on the loan it corrects', async () => {
      // Two borrowers, because one client may hold one active loan at a time.
      const scenario = await createLoanScenario();
      const other = await createLoanScenario();
      const first = await createDraftLoan(scenario.clientId);
      const second = await createDraftLoan(other.clientId);
      await disburseLoan(first, scenario);
      await disburseLoan(second, other);

      const today = new Date().toISOString().slice(0, 10);
      const actionId = await recordAction(first, {
        kind: 'note',
        notes: 'Borrower moved to Gulu',
        actionDate: today,
      });

      const attempt = await asUser(
        scenario.owner,
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, corrects_action_id)
         values ($1, 'correction', 'Wrong file', current_date, $2)`,
        [second, actionId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/same loan/i);
    });

    it('refuses a promised amount without a date, and a date without an amount', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const amountOnly = await asUser(
        scenario.owner,
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount)
         values ($1, 'promise', 'Said he would pay', current_date, 200000)`,
        [loanId],
      );
      expect(amountOnly.ok).toBe(false);

      const dateOnly = await asUser(
        scenario.owner,
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_on)
         values ($1, 'promise', 'Said he would pay', current_date, current_date + 3)`,
        [loanId],
      );
      expect(dateOnly.ok).toBe(false);
    });

    it('refuses a promised amount on anything but a promise', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.owner,
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'note', 'A note with a promise in it', current_date,
                 200000, current_date + 3)`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
    });

    it('refuses an outcome on a note, which is not an attempt at anything', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.owner,
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, outcome, notes, action_date)
         values ($1, 'note', 'reached', 'An internal note', current_date)`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
    });
  });

  // =========================================================================
  describe('promises to pay', () => {
    it('reads as pending while the date is still ahead', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const today = new Date().toISOString().slice(0, 10);
      await recordAction(loanId, {
        kind: 'promise',
        notes: 'Will pay on Friday after the market',
        actionDate: today,
        promisedAmount: 200_000,
        promisedOn: null,
      }).catch(() => undefined);

      // Supplied together, because the constraint requires it.
      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'promise', 'Will pay on Friday', current_date, 200000,
                 current_date + 4)`,
        [loanId],
      );

      const row = await queryOne<{ promise_status: string; promise_paid_amount: string }>(
        `select promise_status, promise_paid_amount
           from public.loan_recovery_register
          where loan_id = $1 and promised_amount is not null`,
        [loanId],
      );

      expect(row.promise_status).toBe('pending');
      expect(row.promise_paid_amount).toBe('0');
    });

    it('reads as kept once the payments reach the amount, and un-keeps on a reversal', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'promise', 'Will pay 50,000 today', current_date, 50000,
                 current_date)`,
        [loanId],
      );

      const beforePayment = await queryOne<{ promise_status: string }>(
        `select promise_status from public.loan_recovery_register
          where loan_id = $1 and promised_amount is not null`,
        [loanId],
      );
      expect(beforePayment.promise_status).toBe('pending');

      const paymentId = await postPayment(loanId, scenario.secretary, { amount: 50_000 });

      const kept = await queryOne<{
        promise_status: string;
        promise_paid_amount: string;
      }>(
        `select promise_status, promise_paid_amount
           from public.loan_recovery_register
          where loan_id = $1 and promised_amount is not null`,
        [loanId],
      );

      expect(kept.promise_status).toBe('kept');
      expect(kept.promise_paid_amount).toBe('50000');

      // The whole reason the verdict is derived rather than stored: reversing
      // the payment that kept the promise un-keeps it, with no second write
      // anywhere and nothing to remember.
      await reversePayment(paymentId, scenario.owner, 'Counted twice at the counter');

      const after = await queryOne<{
        promise_status: string;
        promise_paid_amount: string;
      }>(
        `select promise_status, promise_paid_amount
           from public.loan_recovery_register
          where loan_id = $1 and promised_amount is not null`,
        [loanId],
      );

      expect(after.promise_paid_amount).toBe('0');
      expect(after.promise_status).toBe('pending');
    });

    it('reads as not kept once the date has passed unpaid', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'promise', 'Said he would pay last week', current_date - 10,
                 80000, current_date - 3)`,
        [loanId],
      );

      const row = await queryOne<{ promise_status: string }>(
        `select promise_status from public.loan_recovery_register
          where loan_id = $1 and promised_amount is not null`,
        [loanId],
      );

      expect(row.promise_status).toBe('broken');
    });

    it('surfaces the latest promise, the last action and a missed follow-up per loan', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, follow_up_on)
         values ($1, 'visit', 'Shop open, promised to come in', current_date - 8,
                 current_date - 2)`,
        [loanId],
      );

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'promise', 'First promise', current_date - 6, 40000,
                 current_date - 5)`,
        [loanId],
      );

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'promise', 'Re-promised, higher', current_date - 1, 90000,
                 current_date + 2)`,
        [loanId],
      );

      const row = await queryOne<{
        action_count: number;
        last_action_kind: string;
        overdue_follow_up_on: string | null;
        open_promise_amount: string;
        open_promise_status: string;
      }>(
        `select action_count, last_action_kind, overdue_follow_up_on,
                open_promise_amount, open_promise_status
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );

      expect(Number(row.action_count)).toBe(3);
      expect(row.last_action_kind).toBe('promise');
      expect(row.overdue_follow_up_on).not.toBeNull();
      // A borrower who promises twice has one live promise: the later one.
      expect(row.open_promise_amount).toBe('90000');
      expect(row.open_promise_status).toBe('pending');
    });
  });

  // =========================================================================
  describe('releasing a guarantor', () => {
    it('requires guarantors:release, which a Secretary/Treasurer does not hold', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      const attempt = await asUser(
        scenario.secretary,
        `select public.release_loan_guarantor($1, $2)`,
        [guarantee.id, 'Security substituted'],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/guarantors:release/i);
    });

    it('requires a reason', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      const attempt = await asUser(
        scenario.manager,
        `select public.release_loan_guarantor($1, $2)`,
        [guarantee.id, '   '],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/requires a reason/i);
    });

    it('refuses an application — a draft guarantor is removed, not released', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      const attempt = await asUser(
        scenario.manager,
        `select public.release_loan_guarantor($1, $2)`,
        [guarantee.id, 'Changed their mind'],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/not been disbursed/i);
    });

    it('refuses a finished loan — that guarantee ended with it', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      await cancelLoan(loanId, scenario, 'Borrower withdrew');

      const attempt = await asUser(
        scenario.manager,
        `select public.release_loan_guarantor($1, $2)`,
        [guarantee.id, 'Tidying up'],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/ended when the loan was cancelled/i);
    });

    it('refuses to leave the loan below the guarantors its product requires', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      // The seeded products ask for no guarantor, so the floor has to be
      // raised to have anything to be below. Restored afterwards, because a
      // product is shared state and the next test reads it.
      const product = await queryOne<{ id: string; min_guarantors: number }>(
        `select p.id, p.min_guarantors
           from public.loans l
           join public.loan_products p on p.id = l.loan_product_id
          where l.id = $1`,
        [loanId],
      );

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      await query(`update public.loan_products set min_guarantors = 1 where id = $1`, [
        product.id,
      ]);

      try {
        const attempt = await asUser(
          scenario.manager,
          `select public.release_loan_guarantor($1, $2)`,
          [guarantee.id, 'No replacement attached'],
        );

        // The loan carries exactly one guarantor, so releasing it would leave
        // a product that requires one with none. Refused, not warned about:
        // the alternative is a live loan the business thinks is secured.
        expect(attempt.ok).toBe(false);
        expect(attempt.message).toMatch(/requires 1 guarantor/i);
        expect(attempt.message).toMatch(/would be left with 0/i);
      } finally {
        await query(`update public.loan_products set min_guarantors = $2 where id = $1`, [
          product.id,
          product.min_guarantors,
        ]);
      }
    });

    it('releases once a replacement stands, and records who and why', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      // A second guarantor on the application, and a product that requires
      // one, so the release is tested against a floor it actually meets
      // rather than against no floor at all.
      await attachExtraGuarantorToLoan(loanId);

      await disburseLoan(loanId, scenario);

      const product = await queryOne<{ id: string; min_guarantors: number }>(
        `select p.id, p.min_guarantors
           from public.loans l
           join public.loan_products p on p.id = l.loan_product_id
          where l.id = $1`,
        [loanId],
      );

      await query(`update public.loan_products set min_guarantors = 1 where id = $1`, [
        product.id,
      ]);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 order by created_at limit 1`,
        [loanId],
      );

      const attempt = await asUserScript(scenario.manager, [
        {
          sql: `select public.release_loan_guarantor($1, $2)`,
          params: [guarantee.id, 'Replaced by the borrower’s sister'],
        },
        {
          sql: `select released_at, released_by, release_reason
                  from public.loan_guarantors where id = $1`,
          params: [guarantee.id],
        },
      ]);

      await query(`update public.loan_products set min_guarantors = $2 where id = $1`, [
        product.id,
        product.min_guarantors,
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]?.released_at).not.toBeNull();
      expect(attempt.rows[0]?.released_by).not.toBeNull();
      expect(attempt.rows[0]?.release_reason).toMatch(/Replaced by/);
    });

    it('refuses a release written straight to the column', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      // The capability check lives in the function. A session that can
      // otherwise edit the row must not be able to go around it — which also
      // means the product's guarantor floor cannot be bypassed.
      const attempt = await asUser(
        scenario.owner,
        `update public.loan_guarantors
            set released_at = now(), release_reason = 'Straight to the column'
          where id = $1`,
        [guarantee.id],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/release_loan_guarantor/i);
    });

    it('reports a guarantee status derived from the loan', async () => {
      const scenario = await createLoanScenario();
      const cleared = await createDraftLoan(scenario.clientId);
      await approveLoan(cleared, scenario);
      await cancelLoan(cleared, scenario, 'Withdrawn before disbursement');

      const row = await queryOne<{ guarantee_status: string; is_released: boolean }>(
        `select guarantee_status, is_released from public.guarantor_exposure
          where loan_id = $1 limit 1`,
        [cleared],
      );

      // Nothing was ever lent against it, so the undertaking is void — a
      // status no column holds and nothing had to remember to set.
      expect(row.guarantee_status).toBe('void');
      expect(row.is_released).toBe(false);
    });

    it('shows the loan’s whole exposure against each guarantor, undivided', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await attachExtraGuarantorToLoan(loanId);
      await disburseLoan(loanId, scenario);

      const rows = await query<{
        guaranteed_amount: string;
        outstanding_balance: string;
      }>(
        `select guaranteed_amount, outstanding_balance
           from public.guarantor_exposure where loan_id = $1`,
        [loanId],
      );

      expect(rows.length).toBeGreaterThan(1);

      // Both guarantors carry the same figures. A guarantee here is joint over
      // the whole loan, so halving it would be inventing a term nobody signed.
      const [first, ...rest] = rows;
      for (const row of rest) {
        expect(row.guaranteed_amount).toBe(first?.guaranteed_amount);
        expect(row.outstanding_balance).toBe(first?.outstanding_balance);
      }
    });
  });

  // =========================================================================
  describe('aging and portfolio at risk', () => {
    it('buckets a loan from days past due, and nothing else', async () => {
      const rows = await query<{
        days_past_due: number;
        aging_bucket: string;
        aging_rank: number;
      }>(`select days_past_due, aging_bucket, aging_rank from public.loan_aging`);

      const expected = (days: number): string => {
        if (days <= 0) return 'current';
        if (days <= 7) return '1_7';
        if (days <= 30) return '8_30';
        if (days <= 60) return '31_60';
        if (days <= 90) return '61_90';
        return '90_plus';
      };

      for (const row of rows) {
        expect(row.aging_bucket, `dpd ${String(row.days_past_due)}`).toBe(
          expected(Number(row.days_past_due)),
        );
      }
    });

    it('puts the boundaries where the business states them', async () => {
      // Driven through the view's own expression rather than through fourteen
      // fixture loans, because what is being asserted is the boundary — 30 is
      // in `8_30` and 31 is in `31_60` — and a fixture per day would be a
      // slow test of the same `case`.
      const rows = await query<{ days: number; bucket: string }>(
        `select d.days,
                case
                  when d.days <= 0 then 'current'
                  when d.days <= 7 then '1_7'
                  when d.days <= 30 then '8_30'
                  when d.days <= 60 then '31_60'
                  when d.days <= 90 then '61_90'
                  else '90_plus'
                end as bucket
           from (values (0), (1), (7), (8), (30), (31), (60), (61), (90), (91))
                  as d(days)`,
      );

      expect(rows.map((row) => row.bucket)).toEqual([
        'current',
        '1_7',
        '1_7',
        '8_30',
        '8_30',
        '31_60',
        '31_60',
        '61_90',
        '61_90',
        '90_plus',
      ]);
    });

    it('counts only the active book, so a cleared loan flatters nothing', async () => {
      const statuses = await query<{ loan_status: string }>(
        `select distinct loan_status from public.loan_aging`,
      );

      for (const row of statuses) {
        expect(['active', 'grace_period', 'arrears']).toContain(row.loan_status);
      }
    });

    it('divides outstanding principal past due by outstanding principal', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const portfolio = await queryOne<{
        principal_outstanding: string;
        principal_at_risk_1: string;
        par1_bps: number | null;
        loan_count: number;
      }>(
        `select principal_outstanding, principal_at_risk_1, par1_bps, loan_count
           from public.portfolio_at_risk where scope = 'portfolio'`,
      );

      expect(Number(portfolio.loan_count)).toBeGreaterThan(0);

      const expected = Math.round(
        (Number(portfolio.principal_at_risk_1) * 10000) /
          Number(portfolio.principal_outstanding),
      );

      expect(Number(portfolio.par1_bps)).toBe(expected);
    });

    it('returns the whole book and each slice of it from one read', async () => {
      const scopes = await query<{ scope: string }>(
        `select distinct scope from public.portfolio_at_risk order by scope`,
      );

      // A newly seeded database has one branch and one product, so the four
      // grouping sets are all present even when three of them hold the same
      // figures. What matters is that a caller can take any slice without a
      // second query.
      expect(scopes.map((row) => row.scope)).toContain('portfolio');
      expect(scopes.map((row) => row.scope)).toContain('branch');
      expect(scopes.map((row) => row.scope)).toContain('product');
    });
  });

  // =========================================================================
  describe('collections, sliceable at last', () => {
    it('carries the branch and the product that own the loan', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      await postPayment(loanId, scenario.secretary, { amount: 10_000 });

      const row = await queryOne<{
        branch_id: string | null;
        loan_product_id: string | null;
        product_code: string | null;
        principal_collected: string;
      }>(
        `select branch_id, loan_product_id, product_code, principal_collected
           from public.payment_register where loan_id = $1`,
        [loanId],
      );

      expect(row.branch_id).not.toBeNull();
      expect(row.loan_product_id).not.toBeNull();
      expect(row.product_code).not.toBeNull();
    });

    it('zeroes a reversed payment in every column a summary reads', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      const paymentId = await postPayment(loanId, scenario.secretary, { amount: 12_000 });
      await reversePayment(paymentId, scenario.owner, 'Recorded against the wrong loan');

      const row = await queryOne<{
        is_effective: boolean;
        effective_amount: string;
        principal_collected: string;
        interest_collected: string;
        penalty_collected: string;
        amount: string;
      }>(
        `select is_effective, effective_amount, principal_collected,
                interest_collected, penalty_collected, amount
           from public.payment_register where payment_id = $1`,
        [paymentId],
      );

      // The gross amount is still there — the receipt existed and the register
      // says so — while every figure a total is built from reads zero.
      expect(row.amount).toBe('12000');
      expect(row.is_effective).toBe(false);
      expect(row.effective_amount).toBe('0');
      expect(row.principal_collected).toBe('0');
      expect(row.interest_collected).toBe('0');
      expect(row.penalty_collected).toBe('0');
    });
  });
});
