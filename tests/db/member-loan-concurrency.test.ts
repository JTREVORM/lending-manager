import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createLoanScenario,
  createMemberLoanDraft,
  submitLoan,
} from '../helpers/loan-fixtures';
import {
  closeMemberLoanProduct,
  depositOn,
  enrolMember,
  forcePolicyStatus,
  openMemberLoanProduct,
  publishTestPolicy,
} from '../helpers/membership';
import { closePool, getClient, hasDatabase, queryOne, skipReason } from '../helpers/db';

/**
 * Member lending under genuine concurrency.
 *
 * Every test here opens real parallel connections holding real transactions.
 * Nothing is simulated: there is no way to test a race by calling a function
 * twice in sequence, and the failure modes are the expensive kind.
 *
 * ## The two races that matter, and why
 *
 * **Approval against approval.** Two member-loan applications for the same
 * member, approved at the same instant. Both read the same untouched savings
 * balance, both compute the same ceiling, and both pass — so the member's
 * savings end up securing twice what they can. `approve_loan` takes
 * `lock_savings_capacity()` on the member's savings account **before** it
 * validates, so the second approval validates against a balance the first has
 * already pledged against, and is refused by the ceiling rather than by a
 * constraint nobody can explain.
 *
 * **Approval against withdrawal.** A member loan is approved while a
 * withdrawal of the savings securing it is being prepared. Both paths take the
 * same lock, on the same key, so one goes first and the other sees what it
 * did. Two locks taken in different orders would deadlock instead, which is
 * why there is one function minting the key rather than the key written out at
 * two call sites.
 *
 * The existing one-active-loan limit is a separate and independent control,
 * enforced by the trigger on `loans` under its own advisory lock. Both apply,
 * and the first test here is the one that proves they do not collapse into
 * each other.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('member loan concurrency suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** Run one statement as a signed-in user, on its own connection, committed. */
async function raceAs(
  authUserId: string,
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');
    await client.query(sql, [...params]);
    await client.query('reset role');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

let policyId: string;
let witnessProfileId: string;

/**
 * A member whose savings support exactly `ceiling`, with a guarantor complete
 * enough to approve.
 *
 * The multiplier is 2x under the TEST ONLY policy, so a deposit history
 * totalling S supports 2S — and two loans of just over S each would between
 * them consume more capacity than the member has, which is the race.
 */
async function member(deposit: number) {
  const scenario = await createLoanScenario();
  const { membershipId, savingsAccountId } = await enrolMember(
    scenario.clientId,
    witnessProfileId,
  );

  if (savingsAccountId === null) throw new Error('expected a savings account');

  const today = await queryOne<{ d: string }>(`select public.business_date()::text as d`);

  for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
    const on = await queryOne<{ d: string }>(
      `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
      [today.d, monthsBack],
    );
    await depositOn(savingsAccountId, deposit, { on: on.d });
  }

  return {
    clientId: scenario.clientId,
    membershipId,
    savingsAccountId,
    actors: scenario,
  };
}

describeDb('member loans under concurrency', () => {
  beforeAll(async () => {
    await deleteTestUsers();

    const witness = await queryOne<{ id: string }>(
      `insert into public.profiles (full_name, phone, status)
       values ('Concurrency Witness', '+256700035999', 'active')
       returning id`,
    );
    witnessProfileId = witness.id;

    policyId = await publishTestPolicy({
      version: '350.1',
      effectiveDaysAgo: 550,
      qualifyingMonthsConsecutive: false,
      withdrawalRule: 'above_pledged',
      interestBasis: 'per_month',
      interestMethod: 'reducing_balance_monthly',
      savingsToLoanMultiplierBps: 20_000,
    });
    await openMemberLoanProduct();
  });

  afterAll(async () => {
    await closeMemberLoanProduct();
    await forcePolicyStatus(policyId, 'superseded');
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  it('lets only one of two simultaneous approvals consume the same capacity', async () => {
    // 600,000 saved at 2x supports 1,200,000. Two loans of 700,000 each would
    // be 1,400,000 — so exactly one may be approved, and which one is
    // immaterial.
    const subject = await member(100_000);

    const first = await createMemberLoanDraft(subject.clientId, {
      principal: 700_000,
      termMonths: 2,
    });
    const second = await createMemberLoanDraft(subject.clientId, {
      principal: 700_000,
      termMonths: 2,
    });

    await submitLoan(first, subject.actors);
    await submitLoan(second, subject.actors);

    const results = await Promise.allSettled([
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [first]),
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [second]),
    ]);

    const approved = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');

    expect(approved, 'exactly one approval should have succeeded').toHaveLength(1);
    expect(refused).toHaveLength(1);

    // And the refusal is the ceiling, not a constraint violation or a
    // deadlock. A member told "the amount exceeds what your savings support"
    // can act on it; a member told "could not serialize access" cannot.
    const reason =
      refused[0]?.status === 'rejected' ? String(refused[0].reason) : '(none)';
    expect(reason).toMatch(/member_amount_above_ceiling/);

    // Exactly one pledge exists, and it does not exceed the balance.
    const state = await queryOne<{
      pledges: number;
      pledged: string;
      balance: string;
    }>(
      `select (select count(*)::int from public.member_loan_savings_pledges p
                where p.savings_account_id = $1 and p.released_at is null) as pledges,
              public.savings_pledged_amount($1)::text as pledged,
              (select coalesce(pg_catalog.sum(signed_amount), 0)::text
                 from public.savings_transactions where savings_account_id = $1)
                as balance`,
      [subject.savingsAccountId],
    );

    expect(state.pledges).toBe(1);
    expect(Number(state.pledged)).toBe(350_000);
    expect(Number(state.pledged)).toBeLessThanOrEqual(Number(state.balance));
  });

  // =========================================================================
  it('refuses the second approval even when both would fit the ceiling alone', async () => {
    // The subtler case: 1,200,000 of capacity and two loans of 800,000. Each
    // fits alone; together they do not. Without the lock, both would validate
    // against the same untouched balance.
    const subject = await member(100_000);

    const first = await createMemberLoanDraft(subject.clientId, {
      principal: 800_000,
      termMonths: 2,
    });
    const second = await createMemberLoanDraft(subject.clientId, {
      principal: 800_000,
      termMonths: 2,
    });

    await submitLoan(first, subject.actors);
    await submitLoan(second, subject.actors);

    const results = await Promise.allSettled([
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [first]),
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [second]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    // The invariant the whole pledge mechanism exists for: a member's live
    // pledges never exceed the savings they hold.
    const state = await queryOne<{ pledged: string; balance: string }>(
      `select public.savings_pledged_amount($1)::text as pledged,
              (select coalesce(pg_catalog.sum(signed_amount), 0)::text
                 from public.savings_transactions where savings_account_id = $1)
                as balance`,
      [subject.savingsAccountId],
    );

    expect(Number(state.pledged)).toBeLessThanOrEqual(Number(state.balance));
  });

  // =========================================================================
  it('serialises an approval against a withdrawal of the savings securing it', async () => {
    // 600,000 saved at 2x: 1,200,000 of capacity. A 1,000,000 loan consumes
    // 500,000, leaving 100,000 withdrawable under `above_pledged`. A
    // simultaneous withdrawal of 400,000 must therefore be refused if the
    // approval goes first, and must succeed if it goes second — but the two
    // must never both succeed, because that would leave the loan secured
    // against money the member has taken back.
    const subject = await member(100_000);

    const loanId = await createMemberLoanDraft(subject.clientId, {
      principal: 1_000_000,
      termMonths: 2,
    });
    await submitLoan(loanId, subject.actors);

    const results = await Promise.allSettled([
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [loanId]),
      raceAs(
        subject.actors.owner.authUserId,
        `select public.request_savings_withdrawal($1, 400000, 'Racing the approval')`,
        [subject.savingsAccountId],
      ),
    ]);

    const approvalSucceeded = results[0]?.status === 'fulfilled';
    const withdrawalSucceeded = results[1]?.status === 'fulfilled';

    // At least one has to have gone through — there is no reason for both to
    // fail, and a test that accepted that would pass on a deadlock.
    expect(approvalSucceeded || withdrawalSucceeded).toBe(true);

    const state = await queryOne<{
      pledged: string;
      balance: string;
      withdrawable: string | null;
      requests: number;
    }>(
      `select public.savings_pledged_amount($1)::text as pledged,
              (select coalesce(pg_catalog.sum(signed_amount), 0)::text
                 from public.savings_transactions where savings_account_id = $1)
                as balance,
              public.savings_withdrawable_amount($1)::text as withdrawable,
              (select count(*)::int from public.savings_withdrawal_requests r
                where r.savings_account_id = $1) as requests`,
      [subject.savingsAccountId],
    );

    // Whichever order they ran in, the member's savings secure no more than
    // they hold. That is the invariant; which transaction won is not.
    expect(Number(state.pledged)).toBeLessThanOrEqual(Number(state.balance));

    if (approvalSucceeded && withdrawalSucceeded) {
      // Both can legitimately succeed when the withdrawal went first: it is
      // only *preparing* a request, and the approval then assessed the
      // balance it found. What must not happen is a prepared withdrawal that
      // exceeds what is left over the pledge.
      const request = await queryOne<{ amount: string }>(
        `select amount::text as amount from public.savings_withdrawal_requests
          where savings_account_id = $1 order by created_at desc limit 1`,
        [subject.savingsAccountId],
      );

      expect(
        Number(state.balance) - Number(state.pledged) - Number(request.amount),
      ).toBeGreaterThanOrEqual(0);
    }

    if (approvalSucceeded && !withdrawalSucceeded) {
      const reason =
        results[1]?.status === 'rejected' ? String(results[1].reason) : '(none)';
      expect(reason).toMatch(/secures a member loan|At most/i);
    }
  });

  // =========================================================================
  it('refuses a withdrawal of pledged savings once a member loan is live', async () => {
    // The sequential case, which is the one a counter will actually meet. Run
    // beside the race so a failure here is distinguishable from a lock
    // problem.
    const subject = await member(100_000);

    const loanId = await createMemberLoanDraft(subject.clientId, {
      principal: 1_000_000,
      termMonths: 2,
    });
    await submitLoan(loanId, subject.actors);
    await raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [
      loanId,
    ]);

    // 600,000 held, 500,000 pledged: 100,000 withdrawable.
    const withdrawable = await queryOne<{ amount: string }>(
      `select public.savings_withdrawable_amount($1)::text as amount`,
      [subject.savingsAccountId],
    );
    expect(Number(withdrawable.amount)).toBe(100_000);

    await expect(
      raceAs(
        subject.actors.owner.authUserId,
        `select public.request_savings_withdrawal($1, 150000, 'Over the pledge')`,
        [subject.savingsAccountId],
      ),
    ).rejects.toThrow(/secures a member loan/i);

    // And the excess over the pledge is permitted, so the rule is a limit
    // rather than a block.
    await expect(
      raceAs(
        subject.actors.owner.authUserId,
        `select public.request_savings_withdrawal($1, 100000, 'Within the excess')`,
        [subject.savingsAccountId],
      ),
    ).resolves.toBeUndefined();
  });

  // =========================================================================
  it('keeps the one-active-loan limit as a separate control', async () => {
    // Capacity and the loan limit are different rules, and the lock must not
    // let one stand in for the other. This member has plenty of capacity and
    // one active loan, so the limit is what refuses.
    const subject = await member(500_000);

    const first = await createMemberLoanDraft(subject.clientId, {
      principal: 400_000,
      termMonths: 2,
    });
    await submitLoan(first, subject.actors);
    await raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [
      first,
    ]);
    await raceAs(subject.actors.owner.authUserId, `select public.disburse_loan($1)`, [
      first,
    ]);

    const second = await createMemberLoanDraft(subject.clientId, {
      principal: 400_000,
      termMonths: 2,
    });
    await submitLoan(second, subject.actors);

    await expect(
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [second]),
    ).rejects.toThrow(/active_loan_exists/);

    // The capacity was never the problem: 3,000,000 saved supports 6,000,000.
    const state = await queryOne<{ pledged: string; balance: string }>(
      `select public.savings_pledged_amount($1)::text as pledged,
              (select coalesce(pg_catalog.sum(signed_amount), 0)::text
                 from public.savings_transactions where savings_account_id = $1)
                as balance`,
      [subject.savingsAccountId],
    );
    expect(Number(state.pledged)).toBe(200_000);
    expect(Number(state.balance)).toBe(3_000_000);
  });

  // =========================================================================
  it('writes one schedule for a member loan disbursed twice at once', async () => {
    // Unchanged from Phase 5, and re-asserted because Phase 3 rewrote the
    // generator: the advisory lock and the primary key on
    // `loan_schedules.loan_id` are what make generation idempotent, and a
    // `create or replace` that dropped either would produce two collection
    // plans for one agreement.
    const subject = await member(500_000);

    const loanId = await createMemberLoanDraft(subject.clientId, {
      principal: 400_000,
      termMonths: 2,
    });
    await submitLoan(loanId, subject.actors);
    await raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [
      loanId,
    ]);

    const results = await Promise.allSettled([
      raceAs(subject.actors.owner.authUserId, `select public.disburse_loan($1)`, [
        loanId,
      ]),
      raceAs(subject.actors.owner.authUserId, `select public.disburse_loan($1)`, [
        loanId,
      ]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const state = await queryOne<{ schedules: number; disbursements: number }>(
      `select (select count(*)::int from public.loan_schedules where loan_id = $1)
                as schedules,
              (select count(*)::int from public.journal_entries
                where source_type = 'loan_disbursement' and source_id = $1)
                as disbursements`,
      [loanId],
    );

    expect(state.schedules).toBe(1);
    expect(state.disbursements).toBeLessThanOrEqual(1);
  });

  // =========================================================================
  it('writes one eligibility snapshot and one pledge per loan, whatever the race', async () => {
    const subject = await member(500_000);

    const loanId = await createMemberLoanDraft(subject.clientId, {
      principal: 400_000,
      termMonths: 2,
    });
    await submitLoan(loanId, subject.actors);

    const results = await Promise.allSettled([
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [loanId]),
      raceAs(subject.actors.owner.authUserId, `select public.approve_loan($1)`, [loanId]),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const state = await queryOne<{
      snapshots: number;
      pledges: number;
      periods: number;
      product_snapshots: number;
    }>(
      `select (select count(*)::int from public.member_loan_eligibility_snapshots
                where loan_id = $1) as snapshots,
              (select count(*)::int from public.member_loan_savings_pledges
                where loan_id = $1) as pledges,
              (select count(*)::int from public.loan_periods where loan_id = $1)
                as periods,
              (select count(*)::int from public.loan_product_snapshots where loan_id = $1)
                as product_snapshots`,
      [loanId],
    );

    expect(state.snapshots).toBe(1);
    expect(state.pledges).toBe(1);
    // Two contractual months, not four: a loan approved twice would carry two
    // breakdowns and the schedule would collect double.
    expect(state.periods).toBe(2);
    expect(state.product_snapshots).toBe(1);
  });
});
