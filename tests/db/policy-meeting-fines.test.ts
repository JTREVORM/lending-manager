import {
  createDraftLoan,
  createLoanScenario,
  approveLoan,
  disburseApprovedLoan,
} from '../helpers/loan-fixtures';
import { enrolMember } from '../helpers/membership';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { makeBenefitMember, type BenefitMember } from '../helpers/benefits';
import { closePool, hasDatabase, queryOne } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

let owner: TestUser;
let manager: TestUser;
let secretary: TestUser;
let borrower: TestUser;
let policyId: string;

beforeAll(async () => {
  if (!hasDatabase) return;
  [owner, manager, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('client'),
  ]);
  policyId = await publishTestPolicy({
    version: '946.3',
    effectiveDaysAgo: 2371,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'blocked',
    meetingAbsenceFine: 5000,
  });
});

afterAll(async () => {
  if (!hasDatabase) return;
  await deleteTestUsers();
  await forcePolicyStatus(policyId, 'superseded');
  await closePool();
});

async function fixture(
  future = false,
): Promise<{ member: BenefitMember; meetingId: string }> {
  const member = await makeBenefitMember(policyId);
  const result = await asUserCommitted(secretary, [
    {
      sql: `select public.schedule_membership_meeting(
      $1, 'special', 'Policy safety test meeting', 'Kalerwe',
      now() + ($2::int * interval '1 day'), null) as id`,
      params: [member.branchId, future ? 1 : -1],
    },
  ]);
  expect(result.ok, result.message).toBe(true);
  return { member, meetingId: (result.rows[0] as { id: string }).id };
}

async function mark(
  meetingId: string,
  member: BenefitMember,
  actor = secretary,
): Promise<void> {
  const result = await asUserCommitted(actor, [
    {
      sql: `select public.mark_meeting_attendance($1, $2, 'absent', 'not_stated', null, null)`,
      params: [meetingId, member.membershipId],
    },
  ]);
  expect(result.ok, result.message).toBe(true);
}

async function assess(meetingId: string, member: BenefitMember): Promise<string> {
  const result = await asUserCommitted(manager, [
    {
      sql: 'select public.assess_meeting_fine($1, $2) as id',
      params: [meetingId, member.membershipId],
    },
  ]);
  expect(result.ok, result.message).toBe(true);
  return (result.rows[0] as { id: string }).id;
}

describe.skipIf(!hasDatabase)('policy meeting fine safety', () => {
  it('keeps the official draft unapproved with no assumed activation date', async () => {
    const row = await queryOne<{
      status: string;
      approved_at: string | null;
      effective_from: string | null;
    }>(
      `select status, approved_at, effective_from from public.membership_policy_versions where version = '2.0'`,
    );
    expect(row).toMatchObject({
      status: 'draft',
      approved_at: null,
      effective_from: null,
    });
  });

  it('does not let a borrower record policy activation timing', async () => {
    const result = await asUser(
      borrower,
      `select public.record_draft_policy_timing(
        (select id from public.membership_policy_versions where version = '2.0'),
        public.business_date() + 10, 'Board reference test')`,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });

  it('requires an authorization reference when recording draft timing', async () => {
    const result = await asUser(
      owner,
      `select public.record_draft_policy_timing(
        (select id from public.membership_policy_versions where version = '2.0'),
        public.business_date() + 10, '')`,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('authorization reference');
  });

  it('charges exactly 5000 once, without recognizing unpaid income', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    const before = await queryOne<{ count: string }>(
      'select count(*) from public.journal_entries',
    );
    const fineId = await assess(meetingId, member);
    const again = await asUser(manager, 'select public.assess_meeting_fines($1)', [
      meetingId,
    ]);
    expect(again.ok, again.message).toBe(true);
    const fine = await queryOne<{ amount: string; paid: string }>(
      'select amount::text, amount_paid::text as paid from public.meeting_fines where id = $1',
      [fineId],
    );
    expect(fine).toEqual({ amount: '5000', paid: '0' });
    expect(await queryOne('select count(*) from public.journal_entries')).toEqual(before);
  });

  it('refuses a fine assessed by the person who marked attendance', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member, manager);
    const result = await asUser(manager, 'select public.assess_meeting_fine($1, $2)', [
      meetingId,
      member.membershipId,
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('marked the register');
  });

  it('holds an advance notice pending review, then excuses an approved reason', async () => {
    const { member, meetingId } = await fixture(true);
    const notice = await asUserCommitted(secretary, [
      {
        sql: `select public.record_meeting_absence_notice($1, $2, 'illness', 'Hospital appointment', 'telephone') as id`,
        params: [meetingId, member.membershipId],
      },
    ]);
    expect(notice.ok, notice.message).toBe(true);
    await mark(meetingId, member);
    const candidates = await asUser(
      manager,
      'select fineable, reason from public.meeting_fine_candidates($1)',
      [meetingId],
    );
    expect(candidates.rows[0]).toMatchObject({ fineable: false });
    const selfReview = await asUser(
      secretary,
      'select public.review_meeting_absence_notice($1, true, null)',
      [(notice.rows[0] as { id: string }).id],
    );
    expect(selfReview.ok).toBe(false);
    const reviewed = await asUserCommitted(manager, [
      {
        sql: 'select public.review_meeting_absence_notice($1, true, null)',
        params: [(notice.rows[0] as { id: string }).id],
      },
    ]);
    expect(reviewed.ok, reviewed.message).toBe(true);
    const excused = await asUser(
      manager,
      'select fineable, excused from public.meeting_fine_candidates($1)',
      [meetingId],
    );
    expect(excused.rows[0]).toMatchObject({ fineable: false, excused: true });
  });

  it('refuses a retrospective absence notice', async () => {
    const { member, meetingId } = await fixture();
    const result = await asUser(
      secretary,
      `select public.record_meeting_absence_notice($1, $2, 'work', 'Could not leave work', 'telephone')`,
      [meetingId, member.membershipId],
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('in advance');
  });

  it('serializes concurrent collection and reconciles a reversal to the ledger', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    const fineId = await assess(meetingId, member);
    const results = await Promise.all(
      [randomUUID(), randomUUID()].map((key) =>
        asUserCommitted(secretary, [
          {
            sql: `select public.post_meeting_fine_payment($1, 5000, 'cash', null, $2::uuid) as id`,
            params: [fineId, key],
          },
        ]),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const paid = results.find((r) => r.ok)!;
    const paymentId = (paid.rows[0] as { id: string }).id;
    const summaryBefore = await asUser(
      manager,
      'select * from public.meeting_fine_summary($1)',
      [member.branchId],
    );
    expect(summaryBefore.rows[0]).toMatchObject({ reconciles: true });
    const reversal = await asUserCommitted(owner, [
      {
        sql: 'select public.reverse_meeting_fine_payment($1, $2)',
        params: [paymentId, 'Receipt entered for the wrong member'],
      },
    ]);
    expect(reversal.ok, reversal.message).toBe(true);
    const summaryAfter = await asUser(
      manager,
      'select * from public.meeting_fine_summary($1)',
      [member.branchId],
    );
    expect(summaryAfter.rows[0]).toMatchObject({ reconciles: true });
    const fine = await queryOne<{ paid: string; status: string }>(
      'select amount_paid::text as paid, status from public.meeting_fines where id = $1',
      [fineId],
    );
    expect(fine).toEqual({ paid: '0', status: 'outstanding' });
    const repeated = await asUser(
      owner,
      'select public.reverse_meeting_fine_payment($1, $2)',
      [paymentId, 'Repeated reversal'],
    );
    expect(repeated.ok).toBe(false);
  });

  it('collects a retried request once and refuses cancellation of a paid charge', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    const fineId = await assess(meetingId, member);
    const key = randomUUID();
    const results = await Promise.all(
      [1, 2].map(() =>
        asUserCommitted(secretary, [
          {
            sql: `select public.post_meeting_fine_payment($1, 3000, 'cash', null, $2::uuid) as id`,
            params: [fineId, key],
          },
        ]),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.rows[0]).toEqual(results[1]?.rows[0]);
    const cancelled = await asUser(owner, 'select public.cancel_meeting_fine($1, $2)', [
      fineId,
      'Incorrect attendance',
    ]);
    expect(cancelled.ok).toBe(false);
    const fine = await queryOne<{ paid: string }>(
      'select amount_paid::text as paid from public.meeting_fines where id = $1',
      [fineId],
    );
    expect(fine.paid).toBe('3000');
  });

  it('exposes no candidates or collection helper to an anonymous caller', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    expect(
      (await asAnon('select * from public.meeting_fine_candidates($1)', [meetingId])).ok,
    ).toBe(false);
    expect(
      (
        await asAnon(
          'select public.loan_collection_period_total(gen_random_uuid(), current_date)',
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await asUser(borrower, 'select * from public.meeting_fine_candidates($1)', [
          meetingId,
        ])
      ).ok,
    ).toBe(false);
  });
  it('blocks savings for an approved ordinary loan with no member-loan pledge', async () => {
    const actors = await createLoanScenario();
    const loanId = await createDraftLoan(actors.clientId);
    await approveLoan(loanId, actors);
    const member = await enrolMember(actors.clientId, actors.manager.profileId, {
      initialDeposit: 1000000,
    });
    expect(member.savingsAccountId).toBeTruthy();
    const pledge = await queryOne<{ count: string }>(
      'select count(*)::text from public.member_loan_savings_pledges where loan_id = $1',
      [loanId],
    );
    expect(pledge.count).toBe('0');
    const result = await asUser(
      actors.secretary,
      `select public.request_savings_withdrawal($1, 1000, 'Ordinary loan restriction test')`,
      [member.savingsAccountId],
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('outstanding loan');
  });

  it('rechecks ordinary loans after withdrawal approval without moving savings or ledger money', async () => {
    const actors = await createLoanScenario();
    const member = await enrolMember(actors.clientId, actors.manager.profileId, {
      initialDeposit: 1000000,
    });
    const requested = await asUserCommitted(actors.secretary, [
      {
        sql: `select public.request_savings_withdrawal($1, 1000, 'Payment-time restriction test') as id`,
        params: [member.savingsAccountId],
      },
    ]);
    expect(requested.ok, requested.message).toBe(true);
    const requestId = (requested.rows[0] as { id: string }).id;
    const decision = await asUserCommitted(actors.manager, [
      {
        sql: 'select public.decide_savings_withdrawal($1, true, null)',
        params: [requestId],
      },
    ]);
    expect(decision.ok, decision.message).toBe(true);
    const loanId = await createDraftLoan(actors.clientId);
    await approveLoan(loanId, actors);
    const before = await queryOne(
      `select (select count(*)::text from public.journal_entries) as journals,
        (select coalesce(sum(signed_amount),0)::text from public.savings_transactions where savings_account_id=$1) as savings`,
      [member.savingsAccountId],
    );
    const payment = await asUser(
      actors.manager,
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [requestId],
    );
    expect(payment.ok).toBe(false);
    expect(payment.message).toContain('outstanding loan');
    expect(
      await queryOne(
        `select (select count(*)::text from public.journal_entries) as journals,
        (select coalesce(sum(signed_amount),0)::text from public.savings_transactions where savings_account_id=$1) as savings`,
        [member.savingsAccountId],
      ),
    ).toEqual(before);
  });

  it('opens withdrawal after full ordinary-loan clearance and preserves liability 2100', async () => {
    const actors = await createLoanScenario();
    const loanId = await createDraftLoan(actors.clientId);
    await approveLoan(loanId, actors);
    const member = await enrolMember(actors.clientId, actors.manager.profileId, {
      initialDeposit: 1000000,
    });
    await disburseApprovedLoan(loanId, actors);
    const repaid = await asUserCommitted(actors.secretary, [
      {
        sql: `select public.post_payment($1, public.loan_total_outstanding($1),
        'cash', null, gen_random_uuid(), 'Full clearance regression') as id`,
        params: [loanId],
      },
    ]);
    expect(repaid.ok, repaid.message).toBe(true);
    const loan = await queryOne<{ status: string }>(
      'select status from public.loans where id=$1',
      [loanId],
    );
    expect(loan.status).toBe('cleared');
    const amount = await queryOne<{ savings: string }>(
      'select coalesce(sum(signed_amount),0)::text as savings from public.savings_transactions where savings_account_id=$1',
      [member.savingsAccountId],
    );
    expect(amount.savings).toBe('1000000');
    const requested = await asUserCommitted(actors.secretary, [
      {
        sql: `select public.request_savings_withdrawal($1, 1000, 'Loan fully cleared') as id`,
        params: [member.savingsAccountId],
      },
    ]);
    expect(requested.ok, requested.message).toBe(true);
    const reconciliation = await queryOne<{ savings: string; ledger: string }>(
      `select (select coalesce(sum(signed_amount),0)::text from public.savings_transactions) as savings,
        (select balance::text from public.ledger_account_balances where code='2100') as ledger`,
    );
    expect(reconciliation.savings).toBe(reconciliation.ledger);
  });
  it('carries unpaid collections concurrently once without altering the contract or ledger', async () => {
    const actors = await createLoanScenario();
    const loanId = await createDraftLoan(actors.clientId);
    await approveLoan(loanId, actors);
    await disburseApprovedLoan(loanId, actors);
    const snapshotSql = `select
      (select to_jsonb(l)::text from public.loans l where id=$1) as loan,
      (select jsonb_agg(to_jsonb(i) order by i.installment_number)::text
        from public.loan_installments i where loan_id=$1) as installments,
      (select jsonb_agg(to_jsonb(s) order by s.loan_id)::text
        from public.loan_schedules s where loan_id=$1) as schedules,
      (select count(*)::text from public.journal_entries) as journals,
      (select sum(debit)::text from public.journal_lines) as debits,
      (select sum(credit)::text from public.journal_lines) as credits`;
    const before = await queryOne(snapshotSql, [loanId]);
    const carry = () => asUserCommitted(actors.secretary, [
      { sql: "select set_config('app.business_now', (public.business_now() + interval '35 days')::text, true)" },
      { sql: 'select public.carry_forward_unpaid_installments($1, public.business_date(), $2) as carried', params: [loanId, 'Concurrent monthly collection test'] },
    ]);
    const results = await Promise.all([carry(), carry()]);
    expect(results.every((result) => result.ok)).toBe(true);
    const counts = results.map((result) => Number((result.rows.at(-1) as { carried: number }).carried));
    expect(counts.filter((count) => count > 0)).toHaveLength(1);
    expect(counts.filter((count) => count === 0)).toHaveLength(1);
    expect(await queryOne(snapshotSql, [loanId])).toEqual(before);
    const moved = await queryOne<{ count: string; original: boolean }>(
      `select count(*)::text,
        bool_and(c.original_due_date=i.due_date) as original
       from public.loan_installment_carry_forwards c
       join public.loan_installments i on i.id=c.installment_id
       where c.loan_id=$1`, [loanId],
    );
    expect(Number(moved.count)).toBeGreaterThan(0);
    expect(moved.original).toBe(true);
    const future = await asUser(actors.secretary,
      'select public.carry_forward_unpaid_installments($1, public.business_date()+1, $2)',
      [loanId, 'Premature future collection'],
    );
    expect(future.ok).toBe(false);
    expect(future.message).toContain('future installment');
  });

});
