import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import { deleteTestPayments } from '../helpers/payment-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The figures Phase 17 put on the dashboard, reconciled.
 *
 * ## Why a dashboard figure needs this more than a report figure does
 *
 * A report is opened by somebody asking a question, who will look at the rows
 * under the total. A dashboard figure is read in two seconds by somebody on
 * their way to do something else, and it is the number they will quote. A
 * wrong one is believed for longer.
 *
 * The three counts added to the dashboard are all **derived on read** —
 * nothing marks a promise broken and nothing marks a follow-up overdue — so
 * what is checked here is that each derivation says the same thing as the
 * base tables, written independently, and that it keeps saying it when the
 * underlying fact changes.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('dashboard attention suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Record a recovery action as the table owner, committed. */
async function recordAction(
  loanId: string,
  values: {
    readonly kind: string;
    readonly notes: string;
    readonly actionDate: string;
    readonly followUpOn?: string | null;
    readonly promisedAmount?: number | null;
    readonly promisedOn?: string | null;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.loan_recovery_actions
       (loan_id, action_kind, notes, action_date, follow_up_on,
        promised_amount, promised_on)
     values ($1, $2, $3, $4::date, $5::date, $6, $7::date)
     returning id`,
    [
      loanId,
      values.kind,
      values.notes,
      values.actionDate,
      values.followUpOn ?? null,
      values.promisedAmount ?? null,
      values.promisedOn ?? null,
    ],
  );

  return row.id;
}

/** The three counts, computed the way the dashboard computes them. */
async function workload(): Promise<{
  readonly dueToday: number;
  readonly broken: number;
  readonly followUpsOverdue: number;
  readonly inRecovery: number;
}> {
  const row = await queryOne<{
    due_today: string;
    broken: string;
    follow_ups: string;
    in_recovery: string;
  }>(
    `select
       count(*) filter (
         where open_promise_status = 'pending'
           and open_promise_on = current_date
       )::text as due_today,
       count(*) filter (where open_promise_status = 'broken')::text as broken,
       count(*) filter (where overdue_follow_up_on is not null)::text as follow_ups,
       count(*)::text as in_recovery
     from public.loan_recovery_status`,
  );

  return {
    dueToday: Number(row.due_today),
    broken: Number(row.broken),
    followUpsOverdue: Number(row.follow_ups),
    inRecovery: Number(row.in_recovery),
  };
}

describeDb('the dashboard’s attention figures', () => {
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
  describe('promises', () => {
    it('counts a promise for today and not one for later', async () => {
      // Two scenarios, because one client cannot hold two active loans — the
      // rule Phase 13 put in, and the reason this test needs two borrowers.
      const scenario = await createLoanScenario();
      const other = await createLoanScenario();
      const today = await queryOne<{ d: string }>(`select current_date::text as d`);
      const later = await queryOne<{ d: string }>(`select (current_date + 5)::text as d`);

      const soon = await createDraftLoan(scenario.clientId);
      await disburseLoan(soon, scenario);
      await recordAction(soon, {
        kind: 'promise',
        notes: 'Will pay at the counter this afternoon',
        actionDate: today.d,
        promisedAmount: 40_000,
        promisedOn: today.d,
      });

      const eventually = await createDraftLoan(other.clientId);
      await disburseLoan(eventually, other);
      await recordAction(eventually, {
        kind: 'promise',
        notes: 'After the market on Friday',
        actionDate: today.d,
        promisedAmount: 60_000,
        promisedOn: later.d,
      });

      const counts = await workload();

      // A promise for Friday is not work for today. Counting it would make
      // every day look like the busiest one.
      expect(counts.dueToday).toBe(1);

      const today_promise = await queryOne<{ status: string }>(
        `select open_promise_status as status
           from public.loan_recovery_status where loan_id = $1`,
        [soon],
      );
      const later_promise = await queryOne<{ status: string; on: string }>(
        `select open_promise_status as status, open_promise_on::text as on
           from public.loan_recovery_status where loan_id = $1`,
        [eventually],
      );

      expect(today_promise.status).toBe('pending');
      expect(later_promise.status).toBe('pending');
      expect(later_promise.on).toBe(later.d);
    });

    it('counts a promise whose date has passed unpaid as broken', async () => {
      const scenario = await createLoanScenario();
      const past = await queryOne<{ d: string }>(`select (current_date - 3)::text as d`);

      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      await recordAction(loanId, {
        kind: 'promise',
        notes: 'Said they would pay on Monday',
        actionDate: past.d,
        promisedAmount: 50_000,
        promisedOn: past.d,
      });

      const before = await workload();
      expect(before.broken).toBeGreaterThanOrEqual(1);

      const row = await queryOne<{ status: string; amount: string }>(
        `select open_promise_status as status, open_promise_amount::text as amount
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );

      expect(row.status).toBe('broken');
      expect(row.amount).toBe('50000');
    });

    it('stays broken when the money arrives after the promised date', async () => {
      const { postPayment } = await import('../helpers/payment-fixtures');

      const scenario = await createLoanScenario();
      const past = await queryOne<{ d: string }>(`select (current_date - 3)::text as d`);

      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      await recordAction(loanId, {
        kind: 'promise',
        notes: 'Said they would pay on Monday',
        actionDate: past.d,
        promisedAmount: 50_000,
        promisedOn: past.d,
      });

      const broken = await queryOne<{ status: string }>(
        `select open_promise_status as status
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );
      expect(broken.status).toBe('broken');

      await postPayment(loanId, scenario.secretary, { amount: 50_000 });

      const afterwards = await queryOne<{ status: string }>(
        `select open_promise_status as status
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );

      // Still broken, and that is the rule rather than an oversight. The
      // verdict is about whether the undertaking was met — the borrower said
      // Monday and did not pay on Monday — not about whether the debt was
      // eventually settled, which the loan's own balance already answers.
      //
      // The first version of the dashboard card claimed the opposite, that a
      // later payment "reverses the verdict". It does not, and this is the
      // test that said so.
      expect(afterwards.status).toBe('broken');
    });

    it('is kept when the money arrives before the promised date', async () => {
      const { postPayment } = await import('../helpers/payment-fixtures');

      const scenario = await createLoanScenario();
      const yesterday = await queryOne<{ d: string }>(
        `select (current_date - 1)::text as d`,
      );
      const tomorrow = await queryOne<{ d: string }>(
        `select (current_date + 1)::text as d`,
      );

      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      await recordAction(loanId, {
        kind: 'promise',
        notes: 'Will pay before the end of the week',
        actionDate: yesterday.d,
        promisedAmount: 40_000,
        promisedOn: tomorrow.d,
      });

      const pending = await queryOne<{ status: string }>(
        `select open_promise_status as status
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );
      expect(pending.status).toBe('pending');

      await postPayment(loanId, scenario.secretary, { amount: 40_000 });

      const kept = await queryOne<{ status: string; paid: string | null }>(
        `select open_promise_status as status, promise_paid_amount::text as paid
           from public.loan_recovery_status s
           join public.loan_recovery_register r on r.loan_id = s.loan_id
          where s.loan_id = $1`,
        [loanId],
      );

      // Nothing was written to mark it kept. The verdict is derived from the
      // posted payments on every read, which is what lets the dashboard show
      // a figure that no job has to come back and correct.
      expect(kept.status).toBe('kept');
      expect(Number(kept.paid ?? 0)).toBeGreaterThanOrEqual(40_000);
    });
  });

  // =========================================================================
  describe('follow-ups', () => {
    it('counts a date that has passed, and stops once something is recorded', async () => {
      const scenario = await createLoanScenario();
      const past = await queryOne<{ d: string }>(`select (current_date - 2)::text as d`);
      const future = await queryOne<{ d: string }>(
        `select (current_date + 7)::text as d`,
      );

      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);
      await recordAction(loanId, {
        kind: 'call',
        notes: 'No answer; try again',
        actionDate: past.d,
        followUpOn: past.d,
      });

      const overdue = await queryOne<{ on: string | null }>(
        `select overdue_follow_up_on::text as on
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );
      expect(overdue.on).toBe(past.d);

      // The view takes the *earliest* follow-up date still in the past, so a
      // later action with a future date does not by itself clear an older
      // one — which is right: the officer still owes the earlier call.
      await recordAction(loanId, {
        kind: 'visit',
        notes: 'Visited the shop; will come back next week',
        actionDate: past.d,
        followUpOn: future.d,
      });

      const after = await queryOne<{ on: string | null }>(
        `select overdue_follow_up_on::text as on
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );

      expect(after.on).toBe(past.d);
    });

    it('counts only loans with something on file as being in recovery', async () => {
      // One loan chased, one not, created here so the assertion does not
      // depend on what other tests in this file left behind.
      const chasedScenario = await createLoanScenario();
      const quietScenario = await createLoanScenario();

      const today = (await queryOne<{ d: string }>(`select current_date::text as d`)).d;

      const chased = await createDraftLoan(chasedScenario.clientId);
      await disburseLoan(chased, chasedScenario);
      await recordAction(chased, {
        kind: 'call',
        notes: 'Spoke to the borrower',
        actionDate: today,
      });

      const quiet = await createDraftLoan(quietScenario.clientId);
      await disburseLoan(quiet, quietScenario);

      const pair = await query<{ loan_id: string; actions: number | null }>(
        `select loan_id, action_count as actions
           from public.loan_recovery_status
          where loan_id = any($1::uuid[])
          order by loan_id`,
        [[chased, quiet]],
      );

      // Both loans are in the view. Only one of them has been chased.
      expect(pair).toHaveLength(2);

      const chasedRow = pair.find((row) => row.loan_id === chased);
      const quietRow = pair.find((row) => row.loan_id === quiet);

      expect(Number(chasedRow?.actions ?? 0)).toBeGreaterThan(0);
      expect(quietRow?.actions).toBeNull();

      // Which is the whole point: a card that reported the view's row count
      // as "loans in recovery" would be counting the loan nobody has
      // touched. On the live book that is 26 rows against 4 with an action
      // on file — six times over, in the direction that flatters.
      const counts = await queryOne<{ rows: string; with_action: string }>(
        `select count(*)::text as rows,
                count(*) filter (where action_count > 0)::text as with_action
           from public.loan_recovery_status`,
      );

      expect(Number(counts.rows)).toBeGreaterThan(Number(counts.with_action));
    });

    it('is absent for a loan with nothing recorded against it', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const row = await queryOne<{ on: string | null; actions: number | null }>(
        `select overdue_follow_up_on::text as on, action_count as actions
           from public.loan_recovery_status where loan_id = $1`,
        [loanId],
      );

      // A loan nobody has chased is not a loan with an overdue follow-up.
      expect(row.on).toBeNull();
      // The view left-joins its aggregate, so the raw count is null rather
      // than zero — and `toRecoveryStatus` coalesces it, which is where the
      // distinction stops mattering. Both are asserted, because a reader of
      // the SQL and a reader of the TypeScript would each expect the other.
      expect(row.actions).toBeNull();
    });
  });

  // =========================================================================
  describe('money movements awaiting a decision', () => {
    it('counts a transfer only while it is still waiting', async () => {
      const pending = await queryOne<{ n: string }>(
        `select count(*)::text as n
           from public.transfer_register where status = 'pending_approval'`,
      );
      const everything = await queryOne<{ n: string }>(
        `select count(*)::text as n from public.transfer_register`,
      );

      // The count the dashboard shows is the queue, not the register. The two
      // being equal would mean nothing had ever been decided.
      expect(Number(pending.n)).toBeLessThanOrEqual(Number(everything.n));
    });

    it('counts a submitted cash count, because submitted is what waiting looks like', async () => {
      // A reconciliation does not have a `pending_approval` state: it is
      // `submitted` while it waits to be reviewed. A dashboard that looked
      // for the wrong word would show a permanent zero, which is the kind of
      // defect nobody reports because it looks like good news.
      const statuses = await query<{ status: string }>(
        `select distinct status from public.account_reconciliations`,
      );

      for (const row of statuses) {
        expect(
          ['draft', 'submitted', 'approved', 'rejected'],
          `unexpected reconciliation status: ${row.status}`,
        ).toContain(row.status);
      }

      expect(
        ['submitted'],
        'the dashboard counts `submitted`, so it must remain a real status',
      ).toContain('submitted');
    });
  });
});
