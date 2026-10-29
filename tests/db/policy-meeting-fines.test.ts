import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asAnon, asUser, asUserCommitted, createTestUser, deleteTestUsers, type TestUser } from '../helpers/auth-fixtures';
import { makeBenefitMember, type BenefitMember } from '../helpers/benefits';
import { closePool, hasDatabase, query, queryOne } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

let owner: TestUser;
let manager: TestUser;
let secretary: TestUser;
let borrower: TestUser;
let policyId: string;

beforeAll(async () => {
  if (!hasDatabase) return;
  [owner, manager, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'), createTestUser('manager'),
    createTestUser('secretary_treasurer'), createTestUser('client'),
  ]);
  policyId = await publishTestPolicy({
    version: '946.3', effectiveDaysAgo: 2371,
    qualifyingMonthsConsecutive: false, withdrawalRule: 'blocked',
    meetingAbsenceFine: 5000,
  });
});

afterAll(async () => {
  if (!hasDatabase) return;
  await deleteTestUsers();
  await forcePolicyStatus(policyId, 'superseded');
  await closePool();
});

async function fixture(future = false): Promise<{ member: BenefitMember; meetingId: string }> {
  const member = await makeBenefitMember(policyId);
  const result = await asUserCommitted(secretary, [{
    sql: `select public.schedule_membership_meeting(
      $1, 'special', 'Policy safety test meeting', 'Kalerwe',
      now() + ($2::int * interval '1 day'), null) as id`,
    params: [member.branchId, future ? 1 : -1],
  }]);
  expect(result.ok, result.message).toBe(true);
  return { member, meetingId: (result.rows[0] as { id: string }).id };
}

async function mark(meetingId: string, member: BenefitMember, actor = secretary): Promise<void> {
  const result = await asUserCommitted(actor, [{
    sql: `select public.mark_meeting_attendance($1, $2, 'absent', 'not_stated', null, null)`,
    params: [meetingId, member.membershipId],
  }]);
  expect(result.ok, result.message).toBe(true);
}

async function assess(meetingId: string, member: BenefitMember): Promise<string> {
  const result = await asUserCommitted(manager, [{
    sql: 'select public.assess_meeting_fine($1, $2) as id',
    params: [meetingId, member.membershipId],
  }]);
  expect(result.ok, result.message).toBe(true);
  return (result.rows[0] as { id: string }).id;
}

describe.skipIf(!hasDatabase)('policy meeting fine safety', () => {
  it('keeps the official draft unapproved with no assumed activation date', async () => {
    const row = await queryOne<{ status: string; approved_at: string | null; effective_from: string | null }>(
      `select status, approved_at, effective_from from public.membership_policy_versions where version = '2.0'`,
    );
    expect(row).toMatchObject({ status: 'draft', approved_at: null, effective_from: null });
  });

  it('does not let a borrower record policy activation timing', async () => {
    const result = await asUser(borrower,
      `select public.record_draft_policy_timing(
        (select id from public.membership_policy_versions where version = '2.0'),
        public.business_date() + 10, 'Board reference test')`);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });

  it('requires an authorization reference when recording draft timing', async () => {
    const result = await asUser(owner,
      `select public.record_draft_policy_timing(
        (select id from public.membership_policy_versions where version = '2.0'),
        public.business_date() + 10, '')`);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('authorization reference');
  });

  it('charges exactly 5000 once, without recognizing unpaid income', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    const before = await queryOne<{ count: string }>('select count(*) from public.journal_entries');
    const fineId = await assess(meetingId, member);
    const again = await asUser(manager, 'select public.assess_meeting_fines($1)', [meetingId]);
    expect(again.ok, again.message).toBe(true);
    const fine = await queryOne<{ amount: string; paid: string }>(
      'select amount::text, amount_paid::text as paid from public.meeting_fines where id = $1', [fineId]);
    expect(fine).toEqual({ amount: '5000', paid: '0' });
    expect(await queryOne('select count(*) from public.journal_entries')).toEqual(before);
  });

  it('refuses a fine assessed by the person who marked attendance', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member, manager);
    const result = await asUser(manager, 'select public.assess_meeting_fine($1, $2)', [meetingId, member.membershipId]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('marked the register');
  });

  it('holds an advance notice pending review, then excuses an approved reason', async () => {
    const { member, meetingId } = await fixture(true);
    const notice = await asUserCommitted(secretary, [{
      sql: `select public.record_meeting_absence_notice($1, $2, 'illness', 'Hospital appointment', 'telephone') as id`,
      params: [meetingId, member.membershipId],
    }]);
    expect(notice.ok, notice.message).toBe(true);
    await mark(meetingId, member);
    const candidates = await asUser(manager,
      'select fineable, reason from public.meeting_fine_candidates($1)', [meetingId]);
    expect(candidates.rows[0]).toMatchObject({ fineable: false });
    const selfReview = await asUser(secretary,
      'select public.review_meeting_absence_notice($1, true, null)', [(notice.rows[0] as { id: string }).id]);
    expect(selfReview.ok).toBe(false);
    const reviewed = await asUserCommitted(manager, [{
      sql: 'select public.review_meeting_absence_notice($1, true, null)',
      params: [(notice.rows[0] as { id: string }).id],
    }]);
    expect(reviewed.ok, reviewed.message).toBe(true);
    const excused = await asUser(manager,
      'select fineable, excused from public.meeting_fine_candidates($1)', [meetingId]);
    expect(excused.rows[0]).toMatchObject({ fineable: false, excused: true });
  });

  it('refuses a retrospective absence notice', async () => {
    const { member, meetingId } = await fixture();
    const result = await asUser(secretary,
      `select public.record_meeting_absence_notice($1, $2, 'work', 'Could not leave work', 'telephone')`,
      [meetingId, member.membershipId]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('in advance');
  });

  it('serializes concurrent collection and reconciles a reversal to the ledger', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    const fineId = await assess(meetingId, member);
    const results = await Promise.all([randomUUID(), randomUUID()].map((key) =>
      asUserCommitted(secretary, [{
        sql: `select public.post_meeting_fine_payment($1, 5000, 'cash', null, $2::uuid) as id`,
        params: [fineId, key],
      }]),
    ));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const paid = results.find((r) => r.ok)!;
    const paymentId = (paid.rows[0] as { id: string }).id;
    const summaryBefore = await asUser(manager, 'select * from public.meeting_fine_summary($1)', [member.branchId]);
    expect(summaryBefore.rows[0]).toMatchObject({ reconciles: true });
    const reversal = await asUserCommitted(owner, [{
      sql: 'select public.reverse_meeting_fine_payment($1, $2)',
      params: [paymentId, 'Receipt entered for the wrong member'],
    }]);
    expect(reversal.ok, reversal.message).toBe(true);
    const summaryAfter = await asUser(manager, 'select * from public.meeting_fine_summary($1)', [member.branchId]);
    expect(summaryAfter.rows[0]).toMatchObject({ reconciles: true });
    const fine = await queryOne<{ paid: string; status: string }>(
      'select amount_paid::text as paid, status from public.meeting_fines where id = $1', [fineId]);
    expect(fine).toEqual({ paid: '0', status: 'outstanding' });
    const repeated = await asUser(owner, 'select public.reverse_meeting_fine_payment($1, $2)', [paymentId, 'Repeated reversal']);
    expect(repeated.ok).toBe(false);
  });

  it('collects a retried request once and refuses cancellation of a paid charge', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    const fineId = await assess(meetingId, member);
    const key = randomUUID();
    const results = await Promise.all([1, 2].map(() => asUserCommitted(secretary, [{
      sql: `select public.post_meeting_fine_payment($1, 3000, 'cash', null, $2::uuid) as id`,
      params: [fineId, key],
    }])));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.rows[0]).toEqual(results[1]?.rows[0]);
    const cancelled = await asUser(owner, 'select public.cancel_meeting_fine($1, $2)', [fineId, 'Incorrect attendance']);
    expect(cancelled.ok).toBe(false);
    const fine = await queryOne<{ paid: string }>(
      'select amount_paid::text as paid from public.meeting_fines where id = $1', [fineId]);
    expect(fine.paid).toBe('3000');
  });

  it('exposes no candidates or collection helper to an anonymous caller', async () => {
    const { member, meetingId } = await fixture();
    await mark(meetingId, member);
    expect((await asAnon('select * from public.meeting_fine_candidates($1)', [meetingId])).ok).toBe(false);
    expect((await asAnon('select public.loan_collection_period_total(gen_random_uuid(), current_date)')).ok).toBe(false);
    expect((await asUser(borrower, 'select * from public.meeting_fine_candidates($1)', [meetingId])).ok).toBe(false);
  });
});
