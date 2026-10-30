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
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * Monthly meetings, attendance, minutes and actions.
 *
 * ## The most important test in this file asserts an absence
 *
 * The client's documents say the company intends to hold monthly meetings.
 * They do not say that missing one suspends a membership, disqualifies
 * savings, blocks a loan, blocks a benefit or reduces a profit share. So the
 * schema has no column that makes attendance a condition of anything, and
 * `nothing reads the attendance register to decide anything` is asserted
 * mechanically — because an absence that is only documented is an absence
 * somebody adds a feature on top of next year.
 *
 * ## Africa/Kampala
 *
 * A meeting happens at an instant and belongs to a month. Both are stored, the
 * second generated from the first in the business timezone, so a 00:30 Kampala
 * meeting on 1 November is November's and not October's — which it would be if
 * the month were derived in UTC.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('meetings suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  policyId: string;
  branchId: string;
  nextMember: () => Promise<BenefitMember>;
}

let fx: Fixtures;
let meetingSeq = 0;
/**
 * A second branch, for the one test that needs a member who is not on this
 * meeting's register.
 *
 * Created lazily and removed in `afterAll` **after** `deleteTestUsers`,
 * because the membership and client enrolled at it hold it with RESTRICT and
 * the teardown is what clears those. Leaving it behind would change
 * `expected_members` for every suite that runs afterwards.
 */
let extraBranchId: string | null = null;

/** A meeting in a month nothing else in this suite has used. */
async function scheduleMeeting(
  options: {
    readonly type?: string;
    readonly title?: string;
    readonly monthsAhead?: number;
    readonly actor?: TestUser;
  } = {},
): Promise<string> {
  meetingSeq += 1;
  const monthsAhead = options.monthsAhead ?? meetingSeq;

  const created = await asUserCommitted(options.actor ?? fx.manager, [
    {
      sql: `select public.schedule_membership_meeting(
                     $1, $2, $3, 'The back room, Kyanja office',
                     (public.business_date() + ($4::int * 30))::timestamp
                       at time zone 'Africa/Kampala' + interval '14 hours',
                     'Apologies, minutes, savings report, closing.') as id`,
      params: [
        fx.branchId,
        options.type ?? 'monthly_general',
        options.title ?? `Monthly meeting ${meetingSeq}`,
        monthsAhead,
      ],
    },
  ]);

  if (!created.ok) throw new Error(`could not schedule a meeting: ${created.message}`);
  return (created.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('client'),
  ]);

  // Benefits deliberately shut. Meetings wait on no client decision at all —
  // §15 of the brief says scheduling must be implementable independently of
  // the undecided benefit rules — and a policy that opened benefits here
  // would leave that independence untested.
  const policyId = await publishTestPolicy({
    version: '46.0',
    effectiveDaysAgo: 870,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
  });

  const branch = await queryOne<{ id: string }>(
    `select id from public.branches where status = 'active' order by branch_code limit 1`,
  );

  fx = {
    owner,
    manager,
    secretary,
    borrower,
    policyId,
    branchId: branch.id,
    nextMember: () => makeBenefitMember(policyId, { activatedOn: '2024-06-01' }),
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await deleteTestUsers();

  if (extraBranchId !== null) {
    // The accounts before the branch: `ledger_accounts.branch_id` holds it
    // with RESTRICT, and both must go so the next suite sees the chart the
    // migrations left.
    await query(`delete from public.ledger_accounts where branch_id = $1`, [
      extraBranchId,
    ]);
    await query(`delete from public.branches where id = $1`, [extraBranchId]);
    extraBranchId = null;
  }

  await forcePolicyStatus(fx.policyId, 'superseded');
  await closePool();
});

describeDb('scheduling', () => {
  it('records a meeting with its month derived in Africa/Kampala', async () => {
    const id = await scheduleMeeting({ title: 'October general meeting' });

    const row = await queryOne<{
      meeting_number: string;
      status: string;
      meeting_date: Date;
      scheduled_at: Date;
      created_by_label: string;
    }>(
      `select meeting_number, status, meeting_date, scheduled_at, created_by_label
         from public.membership_meetings where id = $1`,
      [id],
    );

    expect(row.meeting_number).toMatch(/^MM\d{5,}$/);
    expect(row.status).toBe('scheduled');
    expect(row.created_by_label).toContain('manager');

    // The generated date is the Kampala calendar day of the instant.
    const kampalaDay = await queryOne<{ day: string }>(
      `select ((scheduled_at at time zone 'Africa/Kampala')::date)::text as day
         from public.membership_meetings where id = $1`,
      [id],
    );
    expect(new Date(row.meeting_date).toISOString().slice(0, 10)).toBe(kampalaDay.day);
  });

  it('puts a late-evening meeting in the Kampala day, not the UTC one', async () => {
    // 00:30 on the 1st in Kampala is 21:30 on the previous day in UTC. A month
    // derived in UTC would file this under the wrong month.
    const created = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'special', 'Just after midnight', 'The office',
                       '2026-11-01 00:30+03'::timestamptz, null) as id`,
        params: [fx.branchId],
      },
    ]);

    const row = await queryOne<{ meeting_date: Date }>(
      `select meeting_date from public.membership_meetings where id = $1`,
      [(created.rows[0] as { id: string }).id],
    );

    expect(new Date(row.meeting_date).toISOString().slice(0, 10)).toBe('2026-11-01');
  });

  it('allows one monthly general meeting per branch per month', async () => {
    const first = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'monthly_general', 'June general', 'The office',
                       '2027-06-12 14:00+03'::timestamptz, null) as id`,
        params: [fx.branchId],
      },
    ]);
    expect(first.message ?? 'ok').toBe('ok');

    const second = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'monthly_general', 'June general, again', 'The office',
                       '2027-06-26 14:00+03'::timestamptz, null) as id`,
        params: [fx.branchId],
      },
    ]);

    expect(second.ok).toBe(false);
    expect(second.code).toBe('23505');

    // A special meeting in the same month is fine: the index is on the
    // monthly general one, because that is the one the programme promises.
    const special = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'special', 'June special', 'The office',
                       '2027-06-26 14:00+03'::timestamptz, null) as id`,
        params: [fx.branchId],
      },
    ]);
    expect(special.message ?? 'ok').toBe('ok');
  });

  it('imposes no mandatory day or hour', async () => {
    // A Tuesday at 07:15 and a Sunday at 19:00 are both fine. The documents
    // say monthly and nothing more, so nothing here says more either.
    for (const instant of ['2028-02-01 07:15+03', '2028-03-05 19:00+03']) {
      const created = await asUserCommitted(fx.manager, [
        {
          sql: `select public.schedule_membership_meeting(
                         $1, 'monthly_general', 'Whenever suits', 'The office',
                         $2::timestamptz, null) as id`,
          params: [fx.branchId, instant],
        },
      ]);
      expect(created.message ?? 'ok').toBe('ok');
    }
  });

  it('refuses scheduling without meetings:manage', async () => {
    const attempt = await asUser(
      fx.borrower,
      `select public.schedule_membership_meeting(
                $1, 'special', 'My meeting', 'My house',
                pg_catalog.now() + interval '7 days', null) as id`,
      [fx.branchId],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('meetings:manage');
  });
});

describeDb('rescheduling and cancelling', () => {
  it('keeps the first announced date and the reason', async () => {
    const id = await scheduleMeeting({ monthsAhead: 40 });

    const moved = await asUserCommitted(fx.manager, [
      {
        sql: `select public.reschedule_membership_meeting(
                       $1, (public.business_date() + 44)::timestamp
                             at time zone 'Africa/Kampala' + interval '14 hours',
                       'The venue was unavailable.', 'The parish hall') as id`,
        params: [id],
      },
    ]);
    expect(moved.message ?? 'ok').toBe('ok');

    const once = await queryOne<{ rescheduled_from: Date; venue: string }>(
      `select rescheduled_from, venue from public.membership_meetings where id = $1`,
      [id],
    );
    const firstAnnounced = once.rescheduled_from;
    expect(once.venue).toBe('The parish hall');

    // Moved twice: the original stays the original. That is the date members
    // remember, and keeping the most recent one instead would lose it.
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.reschedule_membership_meeting(
                       $1, (public.business_date() + 48)::timestamp
                             at time zone 'Africa/Kampala' + interval '14 hours',
                       'Moved again after the rain.', null) as id`,
        params: [id],
      },
    ]);

    const twice = await queryOne<{ rescheduled_from: Date; reschedule_reason: string }>(
      `select rescheduled_from, reschedule_reason
         from public.membership_meetings where id = $1`,
      [id],
    );

    expect(new Date(twice.rescheduled_from).getTime()).toBe(
      new Date(firstAnnounced).getTime(),
    );
    expect(twice.reschedule_reason).toContain('after the rain');
  });

  it('refuses a reschedule or a cancellation with no reason', async () => {
    const id = await scheduleMeeting({ monthsAhead: 50 });

    const moved = await asUserCommitted(fx.manager, [
      {
        sql: `select public.reschedule_membership_meeting(
                       $1, pg_catalog.now() + interval '60 days', '  ', null) as id`,
        params: [id],
      },
    ]);
    expect(moved.ok).toBe(false);
    expect(moved.message).toContain('needs a reason');

    const cancelled = await asUserCommitted(fx.manager, [
      {
        sql: `select public.cancel_membership_meeting($1, '') as id`,
        params: [id],
      },
    ]);
    expect(cancelled.ok).toBe(false);
    expect(cancelled.message).toContain('needs a reason');
  });

  it('refuses to cancel a meeting people attended', async () => {
    const id = await scheduleMeeting({ monthsAhead: 60 });
    const member = await fx.nextMember();

    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);

    const cancelled = await asUserCommitted(fx.manager, [
      {
        sql: `select public.cancel_membership_meeting(
                       $1, 'We would rather it had not happened.') as id`,
        params: [id],
      },
    ]);

    expect(cancelled.ok).toBe(false);
    expect(cancelled.message).toContain('so it happened');
  });

  it('refuses to revive a cancelled meeting', async () => {
    const id = await scheduleMeeting({ monthsAhead: 70 });

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.cancel_membership_meeting(
                       $1, 'Not enough members could travel.') as id`,
        params: [id],
      },
    ]);

    await expect(
      query(`update public.membership_meetings set status = 'scheduled' where id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/was cancelled/);

    const moved = await asUserCommitted(fx.manager, [
      {
        sql: `select public.reschedule_membership_meeting(
                       $1, pg_catalog.now() + interval '90 days',
                       'Let us try again.', null) as id`,
        params: [id],
      },
    ]);
    expect(moved.ok).toBe(false);
    expect(moved.message).toContain('cancelled');
  });

  it('frees the monthly slot once a meeting is cancelled', async () => {
    const first = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'monthly_general', 'August general', 'The office',
                       '2029-08-11 14:00+03'::timestamptz, null) as id`,
        params: [fx.branchId],
      },
    ]);

    await asUserCommitted(fx.manager, [
      {
        sql: `select public.cancel_membership_meeting($1, 'Rained off.') as id`,
        params: [(first.rows[0] as { id: string }).id],
      },
    ]);

    // Which is what a cancellation is usually for.
    const replacement = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'monthly_general', 'August general, take two',
                       'The office', '2029-08-25 14:00+03'::timestamptz, null) as id`,
        params: [fx.branchId],
      },
    ]);

    expect(replacement.message ?? 'ok').toBe('ok');
  });
});

describeDb('attendance', () => {
  it('marks a member once and marks the meeting held', async () => {
    const id = await scheduleMeeting({ monthsAhead: 80 });
    const member = await fx.nextMember();

    const marked = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, 'Arrived at the start.', null) as id`,
        params: [id, member.membershipId],
      },
    ]);
    expect(marked.message ?? 'ok').toBe('ok');

    const row = await queryOne<{
      attendance: string;
      marked_by_label: string;
      correction_count: number;
      meeting_status: string;
    }>(
      `select a.attendance, a.marked_by_label, a.correction_count, m.status as meeting_status
         from public.meeting_attendance a
         join public.membership_meetings m on m.id = a.meeting_id
        where a.meeting_id = $1 and a.membership_id = $2`,
      [id, member.membershipId],
    );

    expect(row.attendance).toBe('present');
    expect(row.marked_by_label).toContain('secretary');
    expect(row.correction_count).toBe(0);
    // Derived from the register rather than set by hand: a meeting with a
    // register and a `scheduled` status would be two statements about one
    // afternoon.
    expect(row.meeting_status).toBe('held');
  });

  it('treats the same answer twice as a double tap', async () => {
    const id = await scheduleMeeting({ monthsAhead: 90 });
    const member = await fx.nextMember();

    const mark = async () =>
      asUserCommitted(fx.secretary, [
        {
          sql: `select public.mark_meeting_attendance(
                         $1, $2, 'apology', 'illness', null, null) as id`,
          params: [id, member.membershipId],
        },
      ]);

    const first = await mark();
    const second = await mark();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.rows[0] as { id: string }).id).toBe(
      (first.rows[0] as { id: string }).id,
    );

    // No correction recorded: nothing changed, so there is nothing to explain.
    const corrections = await query<{ id: string }>(
      `select id from public.meeting_attendance_corrections where meeting_id = $1`,
      [id],
    );
    expect(corrections).toEqual([]);
  });

  it('refuses a different answer without a reason, and records one with', async () => {
    const id = await scheduleMeeting({ monthsAhead: 100 });
    const member = await fx.nextMember();

    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'absent', 'not_stated', null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);

    const silent = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);
    expect(silent.ok).toBe(false);
    expect(silent.message).toContain('needs a reason');

    const corrected = await asUserCommitted(fx.manager, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null,
                       'She signed the paper register; the tablet entry was wrong.') as id`,
        params: [id, member.membershipId],
      },
    ]);
    expect(corrected.message ?? 'ok').toBe('ok');

    // One row in the register, and the history beside it.
    const rows = await query<{ attendance: string; correction_count: number }>(
      `select attendance, correction_count from public.meeting_attendance
        where meeting_id = $1 and membership_id = $2`,
      [id, member.membershipId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attendance).toBe('present');
    expect(rows[0]!.correction_count).toBe(1);

    const history = await queryOne<{
      previous_attendance: string;
      new_attendance: string;
      reason: string;
      corrected_by_label: string;
      previous_marked_by_label: string;
    }>(
      `select previous_attendance, new_attendance, reason, corrected_by_label,
              previous_marked_by_label
         from public.meeting_attendance_corrections
        where meeting_id = $1 and membership_id = $2`,
      [id, member.membershipId],
    );

    expect(history.previous_attendance).toBe('absent');
    expect(history.new_attendance).toBe('present');
    expect(history.reason).toContain('paper register');
    expect(history.corrected_by_label).not.toBe(history.previous_marked_by_label);
  });

  it('never edits or deletes a correction', async () => {
    const id = await scheduleMeeting({ monthsAhead: 110 });
    const member = await fx.nextMember();

    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'absent', 'travel', null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);
    await asUserCommitted(fx.manager, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, 'Marked in error.') as id`,
        params: [id, member.membershipId],
      },
    ]);

    const correction = await queryOne<{ id: string }>(
      `select id from public.meeting_attendance_corrections where meeting_id = $1`,
      [id],
    );

    await expect(
      query(
        `update public.meeting_attendance_corrections set reason = 'something else'
          where id = $1`,
        [correction.id],
      ),
    ).rejects.toThrow();

    await expect(
      query(`delete from public.meeting_attendance_corrections where id = $1`, [
        correction.id,
      ]),
    ).rejects.toThrow();
  });

  it('refuses a duplicate row for one member and meeting', async () => {
    const id = await scheduleMeeting({ monthsAhead: 120 });
    const member = await fx.nextMember();

    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);

    // The constraint, not the function: two staff marking the register at
    // once would both pass a check.
    await expect(
      query(
        `insert into public.meeting_attendance
           (meeting_id, membership_id, client_id, attendance)
         values ($1, $2, $3, 'absent')`,
        [id, member.membershipId, member.clientId],
      ),
    ).rejects.toThrow(/meeting_attendance_one_per_member/);
  });

  it('refuses a member from another branch', async () => {
    const id = await scheduleMeeting({ monthsAhead: 130 });

    const other = await queryOne<{ id: string }>(
      `insert into public.branches
         (branch_code, name, location, district, status, opened_on)
       values ('BR2699', 'Other Branch', 'Elsewhere', 'Wakiso', 'active',
               public.business_date())
       returning id`,
    );
    extraBranchId = other.id;

    // A branch needs its four cash accounts before anybody can be enrolled
    // there: `enrol_member` posts the registration fee, and
    // `branch_cash_account` refuses a branch that has none. The migration
    // seeds them for Head Office only, so a second branch provisions its own
    // — exactly the four kinds, exactly the code shape the chart uses.
    await query(
      `insert into public.ledger_accounts
         (code, name, account_type, normal_side, cash_kind, branch_id, description)
       values
         ('1010-BR2699', 'Cash at Hand — Other Branch', 'asset', 'debit',
          'cash_at_hand', $1, 'Test fixture.'),
         ('1020-BR2699', 'MTN Mobile Money — Other Branch', 'asset', 'debit',
          'mtn_mobile_money', $1, 'Test fixture.'),
         ('1030-BR2699', 'Airtel Money — Other Branch', 'asset', 'debit',
          'airtel_money', $1, 'Test fixture.'),
         ('1040-BR2699', 'Cash at Bank — Other Branch', 'asset', 'debit',
          'bank', $1, 'Test fixture.')`,
      [other.id],
    );

    // Enrolled at the other branch from the start. A membership is held at
    // its client's branch and follows it, so moving one afterwards is refused
    // — correctly — and a test that needs a member elsewhere creates them
    // there.
    const member = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
      branchId: other.id,
    });

    const marked = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);

    // A register is a list of that branch's members, and a member enrolled
    // elsewhere is not on it.
    expect(marked.ok).toBe(false);
    expect(marked.message).toContain('another branch');
  });

  it('keeps the register staff-only, including from the members on it', async () => {
    const id = await scheduleMeeting({ monthsAhead: 140 });
    const mine = await fx.nextMember();
    const theirs = await fx.nextMember();

    for (const member of [mine, theirs]) {
      await asUserCommitted(fx.secretary, [
        {
          sql: `select public.mark_meeting_attendance(
                         $1, $2, 'present', null, null, null) as id`,
          params: [id, member.membershipId],
        },
      ]);
    }

    await query(`select public.link_client_profile($1, $2)`, [
      mine.clientId,
      fx.borrower.profileId,
    ]);

    try {
      // No self-clause, deliberately. An attendance row is only meaningful
      // beside the meeting it belongs to, and meetings are staff-only — so a
      // member holding a row saying `present` with no way to learn which
      // meeting would be a promise the product does not keep. See the header
      // of 20261022001200.
      const own = await asUser(
        fx.borrower,
        `select attendance from public.meeting_attendance where meeting_id = $1`,
        [id],
      );
      expect(own.rowCount).toBe(0);

      const corrections = await asUser(
        fx.borrower,
        `select count(*)::int as n from public.meeting_attendance_corrections`,
      );
      expect((corrections.rows[0] as { n: number }).n).toBe(0);

      // And a staff reader sees both members on the register.
      const staff = await asUser(
        fx.secretary,
        `select member_name from public.meeting_attendance_register
          where meeting_id = $1`,
        [id],
      );
      expect(staff.rowCount).toBe(2);
    } finally {
      await query(
        `alter table public.clients disable trigger clients_guard_privileged_columns`,
      );
      await query(`update public.clients set profile_id = null where id = $1`, [
        mine.clientId,
      ]);
      await query(
        `alter table public.clients enable trigger clients_guard_privileged_columns`,
      );
    }
  });
});

describeDb('minutes and actions', () => {
  it('refuses minutes for a meeting that has not been held', async () => {
    const id = await scheduleMeeting({ monthsAhead: 150 });

    const minuted = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.record_meeting_minutes($1, 'We discussed nothing.') as id`,
        params: [id],
      },
    ]);

    expect(minuted.ok).toBe(false);
    expect(minuted.message).toContain('has not been held');
  });

  it('records, finalises and then amends only with a note', async () => {
    const id = await scheduleMeeting({ monthsAhead: 160 });
    const member = await fx.nextMember();
    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);

    const written = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.record_meeting_minutes(
                       $1, 'The savings report was read and accepted.') as id`,
        params: [id],
      },
    ]);
    expect(written.message ?? 'ok').toBe('ok');

    const finalised = await asUserCommitted(fx.manager, [
      { sql: `select public.finalise_meeting_minutes($1) as id`, params: [id] },
    ]);
    expect(finalised.message ?? 'ok').toBe('ok');

    // A silent edit is refused: a record of decisions that can be changed
    // without trace is not a record.
    const silent = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.record_meeting_minutes(
                       $1, 'Actually we accepted nothing.') as id`,
        params: [id],
      },
    ]);
    expect(silent.ok).toBe(false);
    expect(silent.message).toContain('needs a note');

    const amended = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.record_meeting_minutes(
                       $1, 'The savings report was read and accepted, with one
                            correction to the June figure.',
                       'Corrected the June savings figure, which was transposed.') as id`,
        params: [id],
      },
    ]);
    expect(amended.message ?? 'ok').toBe('ok');

    const row = await queryOne<{
      minutes_finalised_by_label: string;
      minutes_amendment_note: string;
      minutes_amended_at: Date;
    }>(
      `select minutes_finalised_by_label, minutes_amendment_note, minutes_amended_at
         from public.membership_meetings where id = $1`,
      [id],
    );

    expect(row.minutes_finalised_by_label).toContain('manager');
    expect(row.minutes_amendment_note).toContain('transposed');
    expect(row.minutes_amended_at).not.toBeNull();
  });

  it('refuses finalising minutes twice, or minutes that do not exist', async () => {
    const id = await scheduleMeeting({ monthsAhead: 170 });
    const member = await fx.nextMember();
    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.mark_meeting_attendance(
                       $1, $2, 'present', null, null, null) as id`,
        params: [id, member.membershipId],
      },
    ]);

    const empty = await asUserCommitted(fx.manager, [
      { sql: `select public.finalise_meeting_minutes($1) as id`, params: [id] },
    ]);
    expect(empty.ok).toBe(false);
    expect(empty.message).toContain('no minutes');

    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.record_meeting_minutes($1, 'Short and to the point.') as id`,
        params: [id],
      },
    ]);
    await asUserCommitted(fx.manager, [
      { sql: `select public.finalise_meeting_minutes($1) as id`, params: [id] },
    ]);

    const again = await asUserCommitted(fx.manager, [
      { sql: `select public.finalise_meeting_minutes($1) as id`, params: [id] },
    ]);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('were finalised');
  });

  it('assigns an action to a staff account, and closes it once', async () => {
    const id = await scheduleMeeting({ monthsAhead: 180 });

    const added = await asUserCommitted(fx.manager, [
      {
        sql: `select public.add_meeting_action_item(
                       $1, 'Follow up the four members whose savings lapsed.',
                       $2, (public.business_date() + 14)) as id`,
        params: [id, fx.secretary.profileId],
      },
    ]);
    expect(added.message ?? 'ok').toBe('ok');

    const actionId = (added.rows[0] as { id: string }).id;

    const row = await queryOne<{
      assigned_to_label: string;
      status: string;
      due_on: Date;
    }>(
      `select assigned_to_label, status, due_on
         from public.meeting_action_items where id = $1`,
      [actionId],
    );
    expect(row.assigned_to_label).toContain('secretary');
    expect(row.status).toBe('open');

    const closed = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.update_meeting_action_item(
                       $1, 'completed', 'All four were telephoned.') as id`,
        params: [actionId],
      },
    ]);
    expect(closed.message ?? 'ok').toBe('ok');

    const again = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.update_meeting_action_item($1, 'open', null) as id`,
        params: [actionId],
      },
    ]);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('already completed');
  });

  it('refuses an action assigned to an account that is not active', async () => {
    const id = await scheduleMeeting({ monthsAhead: 190 });
    const archived = await createTestUser('manager', 'suspended');

    const added = await asUserCommitted(fx.manager, [
      {
        sql: `select public.add_meeting_action_item(
                       $1, 'Do the thing.', $2, null) as id`,
        params: [id, archived.profileId],
      },
    ]);

    expect(added.ok).toBe(false);
    expect(added.message).toContain('active account');
  });
});

describeDb('what the meeting module must not do', () => {
  it('keeps attendance consequences confined to the meeting fine', async () => {
    // The brief is explicit: the client's documents do not establish that
    // missing a meeting suspends a membership, disqualifies savings, blocks a
    // loan, blocks a benefit or reduces a profit share. So no table anywhere
    // carries an attendance-derived column, and this is the test that keeps
    // it that way after somebody adds a feature next year.
    const suspects = await query<{ table_name: string; column_name: string }>(
      `select c.table_name, c.column_name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public'
          -- Base tables only. The two meeting registers are views whose whole
          -- job is to report attendance, and counting them here would make
          -- this assertion fail for doing the thing it is for.
          and t.table_type = 'BASE TABLE'
          and (c.table_name, c.column_name) not in (
            ('membership_policy_versions', 'meeting_absence_fine'),
            ('meeting_fines', 'attendance_at_assessment'),
            ('meeting_fines', 'absence_reason_at_assessment'))
          and c.table_name not in (
            'meeting_attendance', 'meeting_attendance_corrections')
          and (
            c.column_name like '%attendance%'
            or c.column_name like '%absence%'
            or c.column_name like '%meetings_missed%'
            or c.column_name like '%meetings_attended%'
          )`,
    );

    expect(suspects).toEqual([]);
  });

  it('is read by no function that decides anything', async () => {
    // Mechanical, because the absence is the design. A function that consulted
    // the register to decide an outcome would be enforcing an attendance rule
    // nobody wrote down.
    //
    // `benefit_summary` is the one permitted reader, and it only **counts**
    // for the dashboard: "attendance recorded this period" is a figure, not a
    // consequence. Named explicitly rather than matched by a pattern, so
    // adding a second reader fails this test and has to be argued for.
    const readers = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosrc like '%meeting_attendance%'
          and p.proname not like '%meeting%'
          and p.proname not like '%attendance%'
          and p.proname <> 'benefit_summary'`,
    );

    expect(readers.map((row) => row.proname)).toEqual([]);

    // And the functions that do decide something are checked by name, because
    // that is the list a reviewer cares about.
    const deciders = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'assess_benefit_claim', 'approve_benefit_claim',
            'benefit_claim_eligibility', 'post_benefit_payment',
            'member_savings_qualification', 'member_loan_eligibility_of',
            'validate_loan_for_approval', 'approve_loan',
            'open_savings_account', 'request_savings_withdrawal',
            'decide_savings_withdrawal', 'post_savings_deposit')
          and p.prosrc like '%meeting%'`,
    );

    expect(deciders.map((row) => row.proname)).toEqual([]);
  });

  it('shows an anonymous caller nothing', async () => {
    for (const table of [
      'membership_meetings',
      'meeting_attendance',
      'meeting_attendance_corrections',
      'meeting_action_items',
    ]) {
      const attempt = await asAnon(`select count(*) from public.${table}`);
      expect(attempt.ok, `anon could read ${table}`).toBe(false);
    }
  });

  it('grants no INSERT on any meeting table to authenticated', async () => {
    const grants = await query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'authenticated'
          and table_schema = 'public'
          and table_name in (
            'membership_meetings', 'meeting_attendance',
            'meeting_attendance_corrections', 'meeting_action_items')
        order by table_name, privilege_type`,
    );

    // Every write is a SECURITY DEFINER function, so the branch check and the
    // correction history cannot be skipped by writing the row directly.
    expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
      'meeting_action_items:SELECT',
      'meeting_attendance:SELECT',
      'meeting_attendance_corrections:SELECT',
      'membership_meetings:SELECT',
      'membership_meetings:UPDATE',
    ]);
  });
});
