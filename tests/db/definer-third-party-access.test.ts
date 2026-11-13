/**
 * The nine SECURITY DEFINER functions carried as PENDING-REVIEW after Phase 2.
 *
 * Each takes a third-party identifier and produced no refusal under the
 * null-argument borrower probe. That probe could not settle them, for a reason
 * worth stating because it is the whole point of this file: most of these
 * functions look up the record they were handed *before* they decide anything,
 * so a NULL identifier returns early and no guard is ever reached. "No refusal"
 * was never a verdict — it was a list of functions nobody had tested properly.
 *
 * So each one is tested here the way the savings disclosure was found: build a
 * real record as the owner, read it as an unrelated borrower who has no
 * relationship to it and no capability over it, and compare against what an
 * authorized caller sees. For the two that mutate, the row count and the audit
 * trail are compared before and after, because a function that refuses to
 * answer but still writes is not refusing.
 *
 * The borrower here is deliberately a *linked* borrower — a real client profile
 * with the `client` role — not an anonymous session. An unlinked session is
 * refused by `require_business_identity` and would prove nothing about these
 * functions' own guards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { makeBenefitMember, type BenefitMember } from '../helpers/benefits';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  disburseApprovedLoan,
} from '../helpers/loan-fixtures';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('definer third-party access', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

describeDb('SECURITY DEFINER functions given a real third-party identifier', () => {
  let policyId: string | undefined;
  let owner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  /** An active, linked borrower with no capability over anything below. */
  let borrower: TestUser;

  let member: BenefitMember;
  let claimId: string;
  let meetingId: string;
  let branchId: string;
  /** A client holding a live, disbursed loan — not the borrower's own. */
  let loanClientId: string;

  beforeAll(async () => {
    await deleteTestUsers();

    policyId = await publishTestPolicy({
      version: '970.1',
      effectiveDaysAgo: 970,
      qualifyingMonthsConsecutive: false,
      withdrawalRule: 'allowed',
      // TEST ONLY figures. Benefits and fines have to be decided for a claim
      // and a fine to exist at all; everything else is left undecided.
      medicalAnnualCap: 500_000,
      medicalClaimsPerYear: 3,
      benefitWaitingPeriodDays: 30,
      medicalYearBasis: 'calendar_year',
    });

    const scenario = await createLoanScenario();
    owner = scenario.owner;
    manager = scenario.manager;
    secretary = scenario.secretary;

    // A live loan on a client who is nothing to do with the borrower below.
    loanClientId = scenario.clientId;
    const loanId = await createDraftLoan(loanClientId);
    await approveLoan(loanId, scenario);
    await disburseApprovedLoan(loanId, scenario);

    member = await makeBenefitMember(policyId, {
      activatedOn: '2024-06-01',
      witnessProfileId: owner.profileId,
    });
    branchId = member.branchId;

    const opened = await asUserCommitted(secretary, [
      {
        sql: `select public.open_benefit_claim(
                       $1, 'medical', null, 'Probe Hospital',
                       (public.business_date() - 10)::timestamptz,
                       (public.business_date() - 8)::timestamptz,
                       200000::bigint, null, null, null, null) as id`,
        params: [member.membershipId],
      },
    ]);
    if (!opened.ok) throw new Error(`could not open a claim: ${opened.message}`);
    claimId = (opened.rows[0] as { id: string }).id;

    const meeting = await asUserCommitted(manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'monthly_general', 'Nine-function probe meeting',
                       'The back room',
                       (public.business_date() + 30)::timestamp
                         at time zone 'Africa/Kampala' + interval '14 hours',
                       'Apologies, minutes.') as id`,
        params: [branchId],
      },
    ]);
    if (!meeting.ok) throw new Error(`could not schedule a meeting: ${meeting.message}`);
    meetingId = (meeting.rows[0] as { id: string }).id;

    // The unrelated borrower, linked to a client of their own so that
    // `require_business_identity` passes and the functions' own guards are
    // what is actually under test.
    borrower = await createTestUser('client');
    const ownClient = await queryOne<{ id: string }>(
      `insert into public.clients
         (full_name, sex, date_of_birth, phone, occupation, village_area, district,
          status)
       values ('Unrelated Probe Borrower', 'male', '1993-05-06',
               '+256700666001', 'Trader', 'Kalerwe', 'Kampala', 'active')
       returning id`,
    );
    await query('select public.link_client_profile($1, $2)', [
      ownClient.id,
      borrower.profileId,
    ]);
  });

  afterAll(async () => {
    if (policyId) await forcePolicyStatus(policyId, 'superseded');
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  // Priority 1 — the two that mutate
  // =========================================================================
  describe('assess_meeting_fines (mutating)', () => {
    async function fineState() {
      const row = await queryOne<{ fines: string; audit: string }>(
        `select (select count(*) from public.meeting_fines where meeting_id = $1) as fines,
                -- audit_log.entity_id is text, so the id is compared as text.
                (select count(*) from public.audit_log
                  where entity_id = $1::text
                     or metadata::text like '%' || $1::text || '%') as audit`,
        [meetingId],
      );
      return { fines: Number(row.fines), audit: Number(row.audit) };
    }

    it('refuses an unrelated borrower, and writes nothing', async () => {
      const before = await fineState();

      const denied = await asUser(
        borrower,
        'select public.assess_meeting_fines($1) as assessed',
        [meetingId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');

      // A refusal that still wrote would not be a refusal.
      expect(await fineState()).toEqual(before);
    });

    it('refuses secretary_treasurer, who may collect fines but not assess them', async () => {
      const before = await fineState();

      const denied = await asUser(
        secretary,
        'select public.assess_meeting_fines($1) as assessed',
        [meetingId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
      expect(await fineState()).toEqual(before);
    });

    for (const role of ['owner_admin', 'manager']) {
      it(`still answers ${role}, who holds fines:assess`, async () => {
        const actor = role === 'owner_admin' ? owner : manager;

        const allowed = await asUser(
          actor,
          'select public.assess_meeting_fines($1) as assessed',
          [meetingId],
        );

        expect(allowed.ok, allowed.message).toBe(true);
        // A future meeting has no absentees recorded, so zero is the correct
        // answer. What matters is that it answered rather than refused.
        expect(Number(allowed.rows[0]?.assessed)).toBeGreaterThanOrEqual(0);
      });
    }
  });

  describe('mark_notifications_read (mutating)', () => {
    /** A notification addressed to staff, not to the borrower. */
    async function staffNotification(): Promise<string> {
      const row = await queryOne<{ id: string }>(
        `insert into public.notifications
           (category, severity, title, body, audience_permission,
            audience_branch_id, entity_type, entity_id, dedupe_key)
         values ('benefit_claim_submitted', 'info', 'Probe notice',
                 'For staff only', 'benefits:view', $1, 'benefit_claim',
                 $2::uuid, 'probe-' || gen_random_uuid()::text)
         returning id`,
        [branchId, claimId],
      );
      return row.id;
    }

    it('does not let an unrelated borrower mark a staff notification read', async () => {
      const id = await staffNotification();

      const attempt = await asUser(
        borrower,
        'select public.mark_notifications_read(array[$1]::uuid[]) as marked',
        [id],
      );

      // The function scopes its write to notifications the caller's own
      // audience covers, so this is a zero-effect call rather than a raise.
      // Either shape is acceptable; what is not is the row changing.
      const after = await queryOne<{ read_count: string }>(
        `select count(*) as read_count
           from public.notification_reads r
          where r.notification_id = $1 and r.profile_id = $2`,
        [id, borrower.profileId],
      );
      expect(Number(after.read_count)).toBe(0);
      if (attempt.ok) expect(Number(attempt.rows[0]?.marked ?? 0)).toBe(0);
    });

    it('still lets staff mark a notification their audience covers', async () => {
      const id = await staffNotification();

      const allowed = await asUser(
        manager,
        'select public.mark_notifications_read(array[$1]::uuid[]) as marked',
        [id],
      );

      expect(allowed.ok, allowed.message).toBe(true);
    });
  });

  // =========================================================================
  // The seven read functions
  // =========================================================================
  describe('client_has_live_loan', () => {
    it('does not tell an unrelated borrower whether another client has a loan', async () => {
      const denied = await asUser(
        borrower,
        'select public.client_has_live_loan($1) as live',
        [loanClientId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
      it(`gives ${role} the right answer, not merely access`, async () => {
        const actor =
          role === 'owner_admin' ? owner : role === 'manager' ? manager : secretary;

        const allowed = await asUser(
          actor,
          'select public.client_has_live_loan($1) as live',
          [loanClientId],
        );

        expect(allowed.ok, allowed.message).toBe(true);
        // The loan was disbursed in beforeAll, so the honest answer is true.
        expect(allowed.rows[0]?.live).toBe(true);
      });
    }

    it('still answers the trusted no-JWT path', async () => {
      const row = await queryOne<{ live: boolean }>(
        'select public.client_has_live_loan($1) as live',
        [loanClientId],
      );
      expect(row.live).toBe(true);
    });
  });

  describe('the benefit read functions', () => {
    // These three refuse by *returning* a safe value rather than raising,
    // which is idiomatic for their return types and still fail-closed:
    // `death_confirmation_count` and `condolence_next_of_kin_status` carry the
    // authorization predicate in the WHERE clause, so an unauthorized caller
    // gets 0 and zero rows; `benefit_payment_blocked_reason` returns a reason,
    // so it returns a refusal as the reason.
    //
    // So the property under test is not "it raises" — a test that demanded
    // that would have called all three vulnerable. It is "the unrelated
    // borrower does not receive what an authorized caller receives".
    const failClosed = [
      {
        fn: 'benefit_payment_blocked_reason',
        call: (name: string) => `select public.${name}($1) as v`,
        safe: (v: unknown) => v === 'That claim cannot be read.',
      },
      {
        fn: 'death_confirmation_count',
        call: (name: string) => `select public.${name}($1) as v`,
        safe: (v: unknown) => Number(v) === 0,
      },
    ] as const;

    for (const { fn, call, safe } of failClosed) {
      it(`${fn} gives an unrelated borrower a safe value, not the real one`, async () => {
        const authorized = await asUser(manager, call(fn), [claimId]);
        const borrowerSaw = await asUser(borrower, call(fn), [claimId]);

        expect(authorized.ok, `${fn} refused a manager: ${authorized.message}`).toBe(
          true,
        );

        if (!borrowerSaw.ok) {
          expect(borrowerSaw.code).toBe('42501');
          return;
        }
        expect(
          safe(borrowerSaw.rows[0]?.v),
          `${fn} returned ${JSON.stringify(borrowerSaw.rows[0]?.v)} to an unrelated borrower`,
        ).toBe(true);
      });
    }

    it('condolence_next_of_kin_status gives an unrelated borrower no rows', async () => {
      const borrowerSaw = await asUser(
        borrower,
        'select * from public.condolence_next_of_kin_status($1)',
        [claimId],
      );

      if (!borrowerSaw.ok) {
        expect(borrowerSaw.code).toBe('42501');
        return;
      }
      // The predicate sits in the WHERE clause, so an unauthorized caller is
      // filtered out rather than refused.
      expect(borrowerSaw.rowCount).toBe(0);
    });

    it('benefit_claim_eligibility refuses an unrelated borrower outright', async () => {
      const denied = await asUser(
        borrower,
        'select * from public.benefit_claim_eligibility($1)',
        [claimId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    it('benefit_claim_eligibility still answers a manager', async () => {
      const allowed = await asUser(
        manager,
        'select * from public.benefit_claim_eligibility($1)',
        [claimId],
      );

      expect(allowed.ok, allowed.message).toBe(true);
    });

    it('member_benefit_position refuses an unrelated borrower a real membership', async () => {
      const denied = await asUser(
        borrower,
        'select * from public.member_benefit_position($1, public.business_date())',
        [member.membershipId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    it('member_benefit_position still answers a manager', async () => {
      const allowed = await asUser(
        manager,
        'select * from public.member_benefit_position($1, public.business_date())',
        [member.membershipId],
      );

      expect(allowed.ok, allowed.message).toBe(true);
    });
  });

  describe('meeting_fine_candidates', () => {
    it('refuses an unrelated borrower a real meeting id', async () => {
      const denied = await asUser(
        borrower,
        'select * from public.meeting_fine_candidates($1)',
        [meetingId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
      it(`still answers ${role}, who holds fines:view`, async () => {
        const actor =
          role === 'owner_admin' ? owner : role === 'manager' ? manager : secretary;

        const allowed = await asUser(
          actor,
          'select * from public.meeting_fine_candidates($1)',
          [meetingId],
        );

        expect(allowed.ok, allowed.message).toBe(true);
      });
    }
  });
});
