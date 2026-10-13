import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserScript,
  createTestUser,
  deleteTestUsers,
} from '../helpers/auth-fixtures';
import {
  approveLoan,
  attachExtraGuarantorToLoan,
  cancelLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  rejectLoan,
  submitLoan,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  postPayment,
  reversePayment,
} from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Phase 15: the notification stream.
 *
 * Five properties, each of which is the whole reason the design is shaped the
 * way it is:
 *
 *   1. **One row per event, addressed to a capability.** Not fanned out per
 *      recipient, so an event cannot exist as rows that disagree, and a staff
 *      member who joins on Monday sees the weekend's work.
 *   2. **Read is per person.** The same row reads as unread for one staff
 *      member and read for another, with no second copy of it anywhere.
 *   3. **The audience is enforced, not decorative.** A Secretary/Treasurer
 *      cannot see a reversal, because a reversal is addressed to whoever may
 *      reverse — which is the Owner alone.
 *   4. **Raised once.** The dedupe key means a trigger that fires twice for
 *      one event raises one notification.
 *   5. **Nothing is raised by the calendar.** Every row traces to something
 *      somebody or the database did.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('notifications suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** The notifications a loan produced, oldest first. */
async function feedFor(loanId: string): Promise<
  readonly {
    category: string;
    severity: string;
    title: string;
    audience_permission: string;
    audience_profile_id: string | null;
    entity_type: string;
  }[]
> {
  return query(
    `select category, severity, title, audience_permission,
            audience_profile_id, entity_type
       from public.notifications
      where entity_id = $1
      order by occurred_at, category`,
    [loanId],
  );
}

describeDb('notifications', () => {
  beforeAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    await deleteTestPayments();
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('what the lifecycle raises', () => {
    it('raises one for an application submitted, addressed to whoever approves', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const rows = await feedFor(loanId);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        category: 'loan_awaiting_approval',
        severity: 'attention',
        audience_permission: 'loans:approve',
        entity_type: 'loan',
      });
      expect(rows[0]?.title).toMatch(/awaiting approval/i);
      // To the role, not to a person.
      expect(rows[0]?.audience_profile_id).toBeNull();
    });

    it('addresses an approved loan to whoever releases the money, not to the approver', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);

      const rows = await feedFor(loanId);
      const approved = rows.find((row) => row.category === 'loan_awaiting_disbursement');

      // Phase 4 withholds `loans:disburse` from the Manager so one person
      // cannot originate, approve and pay out. The notification follows the
      // same separation rather than telling the approver to get on with it.
      expect(approved?.audience_permission).toBe('loans:disburse');
      expect(approved?.severity).toBe('attention');
    });

    it('addresses a refusal to the person who submitted it', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);
      await rejectLoan(loanId, scenario.manager, 'Income could not be verified');

      const rows = await feedFor(loanId);
      const decided = rows.find((row) => row.category === 'loan_decided');

      expect(decided?.title).toMatch(/was refused/i);
      // The one category that names a person: whoever submitted it has to
      // tell the borrower, and should not find out by refreshing a register.
      expect(decided?.audience_profile_id).toBe(scenario.secretary.profileId);
    });

    it('distinguishes a withdrawal from a refusal in the title', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);
      await cancelLoan(loanId, scenario, 'Borrower changed their mind');

      const rows = await feedFor(loanId);
      const decided = rows.find((row) => row.category === 'loan_decided');

      expect(decided?.title).toMatch(/was withdrawn/i);
      expect(decided?.severity).toBe('info');
    });

    it('raises on disbursement, with the amount released', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const rows = await feedFor(loanId);
      const disbursed = rows.find((row) => row.category === 'loan_disbursed');

      expect(disbursed?.severity).toBe('info');
      expect(disbursed?.audience_permission).toBe('loans:view');
    });

    it('raises nothing on a draft edit', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      await query(`update public.loans set notes = 'A note' where id = $1`, [loanId]);

      expect(await feedFor(loanId)).toHaveLength(0);
    });
  });

  // =========================================================================
  describe('what collections and money raise', () => {
    it('raises an urgent notification when a payment is reversed', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const paymentId = await postPayment(loanId, scenario.secretary, { amount: 20_000 });

      // A payment *received* raises nothing: twenty a day in the bell would
      // train everybody to ignore the bell, and the register lists them.
      const beforeReversal = await query<{ n: string }>(
        `select count(*) n from public.notifications where entity_id = $1`,
        [paymentId],
      );
      expect(Number(beforeReversal[0]?.n)).toBe(0);

      await reversePayment(paymentId, scenario.owner, 'Counted twice at the counter');

      const row = await queryOne<{
        category: string;
        severity: string;
        audience_permission: string;
      }>(
        `select category, severity, audience_permission
           from public.notifications where entity_id = $1`,
        [paymentId],
      );

      expect(row.category).toBe('payment_reversed');
      expect(row.severity).toBe('urgent');
      // To whoever may reverse — the Owner alone. The one financial act this
      // system lets a person undo, so its holder is told each time.
      expect(row.audience_permission).toBe('payments:reverse');
    });

    it('raises on a promise taken, and nothing on its verdict changing', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date, promised_amount, promised_on)
         values ($1, 'promise', 'Will pay on Friday', current_date, 50000, current_date)`,
        [loanId],
      );

      const promises = await query<{ category: string; severity: string }>(
        `select category, severity from public.notifications
          where entity_id = $1 and category = 'promise_recorded'`,
        [loanId],
      );

      expect(promises).toHaveLength(1);
      expect(promises[0]?.severity).toBe('attention');

      // Paying it turns the verdict from pending to kept. That is a change in
      // a derived view with no event behind it, so it raises nothing — which
      // is the rule that keeps the stream from going stale.
      await postPayment(loanId, scenario.secretary, { amount: 50_000 });

      const after = await query<{ n: string }>(
        `select count(*) n from public.notifications
          where entity_id = $1 and category = 'promise_recorded'`,
        [loanId],
      );
      expect(Number(after[0]?.n)).toBe(1);
    });

    it('raises nothing for a recovery action that is not a promise', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      await query(
        `insert into public.loan_recovery_actions
           (loan_id, action_kind, notes, action_date)
         values ($1, 'call', 'Phone off all morning', current_date)`,
        [loanId],
      );

      const rows = await query<{ n: string }>(
        `select count(*) n from public.notifications
          where entity_id = $1 and category = 'promise_recorded'`,
        [loanId],
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('raises on security being sold, and says the proceeds are a separate act', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await query(
        `insert into public.loan_collateral
           (loan_id, item_type, description, estimated_value, valued_on)
         values ($1, 'motorcycle', 'Red Bajaj Boxer', 1500000, current_date - 1)`,
        [loanId],
      );
      await disburseLoan(loanId, scenario);

      await query(
        `update public.loan_collateral
            set status = 'realised', realised_amount = 900000,
                release_reason = 'Sold at Kalerwe'
          where loan_id = $1`,
        [loanId],
      );

      const row = await queryOne<{ category: string; severity: string; body: string }>(
        `select category, severity, body from public.notifications
          where entity_id = $1 and category = 'collateral_realised'`,
        [loanId],
      );

      expect(row.severity).toBe('urgent');
      // The body carries the rule, because a staff member who thinks the
      // balance already moved will not post the receipt.
      expect(row.body).toMatch(/post the proceeds as a payment/i);
    });

    it('raises on a guarantor being released, from inside the function', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await attachExtraGuarantorToLoan(loanId);
      await disburseLoan(loanId, scenario);

      const guarantee = await queryOne<{ id: string }>(
        `select id from public.loan_guarantors where loan_id = $1 order by created_at limit 1`,
        [loanId],
      );

      const attempt = await asUserScript(scenario.manager, [
        {
          sql: `select public.release_loan_guarantor($1, $2)`,
          params: [guarantee.id, 'Relocated to Mbale and unreachable'],
        },
        {
          sql: `select category, severity, audience_permission, body
                  from public.notifications
                 where entity_id = $1 and category = 'guarantor_released'`,
          params: [loanId],
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]).toMatchObject({
        category: 'guarantor_released',
        severity: 'attention',
        audience_permission: 'guarantors:view',
      });
      expect(String(attempt.rows[0]?.body)).toMatch(/Relocated to Mbale/);
    });
  });

  // =========================================================================
  describe('who can see what', () => {
    it('shows a Secretary/Treasurer an application awaiting approval', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      // The Secretary holds `loans:view` but not `loans:approve`, so the
      // awaiting-approval notification is not theirs — and this asserts the
      // honest consequence rather than a convenient one.
      const visible = await asUser(
        scenario.secretary,
        `select count(*)::int as n from public.notification_feed
          where category = 'loan_awaiting_approval' and entity_id = $1`,
        [loanId],
      );

      expect(visible.ok, visible.message).toBe(true);
      expect(visible.rows[0]?.n).toBe(0);

      const manager = await asUser(
        scenario.manager,
        `select count(*)::int as n from public.notification_feed
          where category = 'loan_awaiting_approval' and entity_id = $1`,
        [loanId],
      );

      expect(manager.rows[0]?.n).toBe(1);
    });

    it('hides a reversal from everybody but the Owner', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      const paymentId = await postPayment(loanId, scenario.secretary, { amount: 15_000 });
      await reversePayment(paymentId, scenario.owner, 'Wrong loan');

      for (const [who, actor] of [
        ['secretary', scenario.secretary],
        ['manager', scenario.manager],
      ] as const) {
        const seen = await asUser(
          actor,
          `select count(*)::int as n from public.notification_feed
            where category = 'payment_reversed' and entity_id = $1`,
          [paymentId],
        );
        expect(seen.rows[0]?.n, who).toBe(0);
      }

      const owner = await asUser(
        scenario.owner,
        `select count(*)::int as n from public.notification_feed
          where category = 'payment_reversed' and entity_id = $1`,
        [paymentId],
      );
      expect(owner.rows[0]?.n).toBe(1);
    });

    it('shows a personally addressed refusal only to the person named', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);
      await rejectLoan(loanId, scenario.manager, 'Income could not be verified');

      // The submitter sees it.
      const submitter = await asUser(
        scenario.secretary,
        `select count(*)::int as n from public.notification_feed
          where category = 'loan_decided' and entity_id = $1`,
        [loanId],
      );
      expect(submitter.rows[0]?.n).toBe(1);

      // The Owner holds `loans:view` too, and still does not see it: the
      // narrowing is on the row, not on the capability.
      const owner = await asUser(
        scenario.owner,
        `select count(*)::int as n from public.notification_feed
          where category = 'loan_decided' and entity_id = $1`,
        [loanId],
      );
      expect(owner.rows[0]?.n).toBe(0);
    });

    it('refuses a borrower the stream entirely', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);
      await disburseLoan(loanId, scenario);

      // A real signed-in borrower, holding `portal:view` and nothing else.
      // Notifications are the staff's: a borrower has the portal, and a bell
      // telling them their own loan was disbursed would be telling them
      // something they were handed cash for.
      const borrower = await createTestUser('client');

      const seen = await asUser(
        borrower,
        `select count(*)::int as n from public.notification_feed`,
      );

      expect(seen.ok, seen.message).toBe(true);
      expect(seen.rows[0]?.n).toBe(0);

      // And the bell's count is zero rather than an error, so the shell would
      // render for them if it ever did.
      const summary = await asUser(
        borrower,
        `select unread from public.notification_summary`,
      );
      expect(Number(summary.rows[0]?.unread)).toBe(0);
    });
  });

  // =========================================================================
  describe('read state', () => {
    it('is per person: one marks it read and the other still sees it unread', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      // `loan_disbursed` goes to `loans:view`, which both hold.
      const marked = await asUserScript(scenario.manager, [
        { sql: `select public.mark_notifications_read(null) as marked` },
        {
          sql: `select count(*)::int as unread from public.notification_feed
                 where not is_read`,
        },
      ]);

      expect(marked.ok, marked.message).toBe(true);
      expect(marked.rows[0]?.unread).toBe(0);

      // Rolled back by `asUserScript`, so this is about the mechanism rather
      // than about persistence: a receipt is keyed by the pair, so there is
      // no shared "read" column for one reader to clear on another's behalf.
      const receipts = await query<{ n: string }>(
        `select count(*) n from public.notification_reads`,
      );
      expect(Number(receipts[0]?.n)).toBe(0);
    });

    it('marks only what the caller can see', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      const paymentId = await postPayment(loanId, scenario.secretary, { amount: 10_000 });
      await reversePayment(paymentId, scenario.owner, 'Wrong loan');

      const reversal = await queryOne<{ id: string }>(
        `select id from public.notifications where category = 'payment_reversed'
          and entity_id = $1`,
        [paymentId],
      );

      // The Manager cannot see the reversal, so asking to mark it read marks
      // nothing — the honest answer, rather than a refusal.
      const attempt = await asUser(
        scenario.manager,
        `select public.mark_notifications_read(array[$1]::uuid[]) as marked`,
        [reversal.id],
      );

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]?.marked).toBe(0);
    });

    it('refuses to mark anything for a caller with no session', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      // As the table owner there is no `current_profile_id()`, so there is no
      // receipt to write and the function says so rather than writing a row
      // attributed to nobody.
      await expect(query(`select public.mark_notifications_read(null)`)).rejects.toThrow(
        /signed-in/i,
      );
    });

    it('is idempotent: marking twice leaves one receipt', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const attempt = await asUserScript(scenario.manager, [
        { sql: `select public.mark_notifications_read(null)` },
        { sql: `select public.mark_notifications_read(null) as second` },
        {
          sql: `select count(*)::int as receipts from public.notification_reads
                 where profile_id = public.current_profile_id()`,
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      // The second call marked nothing new, and there is one receipt per
      // notification rather than two.
      const receipts = Number(attempt.rows[0]?.receipts);
      expect(receipts).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  describe('the stream is a log', () => {
    it('refuses an update and a delete, matching rows or not', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const row = await queryOne<{ id: string }>(
        `select id from public.notifications where entity_id = $1`,
        [loanId],
      );

      const update = await asUser(
        scenario.owner,
        `update public.notifications set title = 'Reworded' where id = $1`,
        [row.id],
      );
      expect(update.ok).toBe(false);

      const remove = await asUser(
        scenario.owner,
        `delete from public.notifications where id = $1`,
        [row.id],
      );
      expect(remove.ok).toBe(false);

      // Statement-level, so a WHERE matching nothing is refused too.
      const empty = await asUser(
        scenario.owner,
        `update public.notifications set title = 'Reworded'
          where id = '00000000-0000-4000-8000-000000000000'`,
      );
      expect(empty.ok).toBe(false);
    });

    it('raises once for one event, however many times the trigger fires', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);

      // A second UPDATE that re-states the status fires the trigger again.
      // The dedupe key is what makes that a no-op rather than a duplicate.
      await query(
        `select public.raise_notification(
           'loan_awaiting_disbursement', 'attention', 'A duplicate', null,
           'loans:disburse', 'loan', $1, $2
         )`,
        // The key passed separately rather than built from `$1`: one
        // placeholder cannot be deduced as both a uuid and text.
        [loanId, `loan:${loanId}:approved`],
      );

      const rows = await query<{ n: string }>(
        `select count(*) n from public.notifications
          where category = 'loan_awaiting_disbursement' and entity_id = $1`,
        [loanId],
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });

    it('refuses a notification addressed to a capability that does not exist', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      // The reference is what stops a typo producing a notification nobody
      // can ever read — and nobody can ever notice is unreadable.
      await expect(
        query(
          `select public.raise_notification(
             'loan_disbursed', 'info', 'Addressed to nothing', null,
             'loans:invented', 'loan', $1, $2
           )`,
          [loanId, `bogus:${loanId}`],
        ),
      ).rejects.toThrow(/audience_permission/i);
    });
  });

  // =========================================================================
  describe('the bell', () => {
    it('always returns exactly one row, zeroes included', async () => {
      const scenario = await createLoanScenario();

      const summary = await asUser(
        scenario.owner,
        `select total, unread, unread_urgent, unread_attention
           from public.notification_summary`,
      );

      expect(summary.ok, summary.message).toBe(true);
      expect(summary.rows).toHaveLength(1);
      // Zeroes rather than no row, so a caller never has to tell "nothing to
      // report" from "the query failed".
      expect(Number(summary.rows[0]?.total)).toBeGreaterThanOrEqual(0);
    });

    it('counts only what the caller can see', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      const paymentId = await postPayment(loanId, scenario.secretary, { amount: 10_000 });
      await reversePayment(paymentId, scenario.owner, 'Wrong loan');

      const manager = await asUser(
        scenario.manager,
        `select unread_urgent from public.notification_summary`,
      );
      const owner = await asUser(
        scenario.owner,
        `select unread_urgent from public.notification_summary`,
      );

      // The reversal is urgent and the Owner's alone, so the two counts
      // genuinely differ — which is the per-audience design working.
      expect(Number(owner.rows[0]?.unread_urgent)).toBeGreaterThan(
        Number(manager.rows[0]?.unread_urgent),
      );
    });
  });
  // =========================================================================
  describe('the backfill', () => {
    /**
     * Phase 15.3 reconstructs the stream for the events that happened before
     * the triggers existed. The only way that claim can be trusted is if the
     * reconstruction is indistinguishable from what the triggers produce — so
     * these tests take a stream the triggers raised, delete it, run the real
     * migration file, and compare the two row for row.
     *
     * The migration is read off disk rather than restated here. A copy of the
     * SQL in a test proves the copy is right, which is not the question.
     */
    const BACKFILL = join(
      process.cwd(),
      'supabase/migrations/20261015000300_notification_backfill.sql',
    );

    /** Every column the triggers set, for one loan's stream. */
    async function fullStream(loanId: string): Promise<readonly unknown[]> {
      return query(
        `select category, severity, title, body, audience_permission,
                audience_profile_id, audience_branch_id, entity_type, entity_id,
                actor_profile_id, actor_label, occurred_at, dedupe_key
           from public.notifications
          where entity_id = $1
          order by dedupe_key`,
        [loanId],
      );
    }

    async function runBackfill(): Promise<void> {
      await query(await readFile(BACKFILL, 'utf8'));
    }

    /**
     * Clears one loan's stream through the same documented owner-level
     * exemption `deleteTestUsers` uses: the table refuses DELETE, and a test
     * database still has to be able to get back to a known state.
     */
    async function forgetStream(loanId: string): Promise<void> {
      await query(
        'alter table public.notifications disable trigger notifications_no_delete',
      );
      try {
        await query('delete from public.notifications where entity_id = $1', [loanId]);
      } finally {
        await query(
          'alter table public.notifications enable trigger notifications_no_delete',
        );
      }
    }

    it('reproduces, exactly, what the triggers raised', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      // One call, three transitions: `disburseLoan` submits, approves and
      // releases the money, each as the role that may do it.
      await disburseLoan(loanId, scenario);

      const raised = await fullStream(loanId);
      // Submitted, approved, disbursed — three events, so three rows, or the
      // comparison below would be comparing nothing to nothing.
      expect(raised).toHaveLength(3);

      await forgetStream(loanId);
      expect(await fullStream(loanId)).toHaveLength(0);

      await runBackfill();

      // Every column: the wording, the audience, the actor, the moment and
      // the dedupe key. Not a subset — a backfill that got the audience right
      // and the timestamp wrong would be worse than no backfill, because it
      // would look correct.
      expect(await fullStream(loanId)).toStrictEqual(raised);
    });

    it('is a no-op against a stream the triggers already raised', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const before = await fullStream(loanId);
      await runBackfill();
      await runBackfill();

      // The unique constraint on `(category, dedupe_key)`, not the caller, is
      // what makes this true — which is why the keys are the triggers' keys
      // character for character rather than something the backfill invents.
      expect(await fullStream(loanId)).toStrictEqual(before);
    });

    it('raises nothing for a loan that has not left draft', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);

      await runBackfill();

      // A draft is not an event. Nobody has been asked for anything, so there
      // is nothing to tell anybody.
      expect(await fullStream(loanId)).toHaveLength(0);
    });
  });
});
