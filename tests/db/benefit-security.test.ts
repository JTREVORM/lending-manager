import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asServiceRole,
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  attachVerifiedDocument,
  clearEvidenceBucket,
  makeBenefitMember,
  makeVerifiedBeneficiary,
  putEvidenceObject,
  requiredKindsFor,
  type BenefitMember,
} from '../helpers/benefits';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * The authorization boundary, and the policy gate.
 *
 * ## What these are really testing
 *
 * Everything above Row Level Security — a hidden sidebar entry, a guarded
 * Server Component, a disabled button — exists to give people a coherent
 * experience and to fail early. None of it survives a caller who takes their
 * own token and queries PostgREST directly. So every test here talks to the
 * database as a role, with the application bypassed entirely.
 *
 * Three groups:
 *
 *   1. **the gate** — under the real seeded policy version, where the client
 *      has decided none of the benefit rules, nothing can be assessed,
 *      approved or paid, and each refusal names the decision;
 *   2. **cross-member privacy** — a member reaches their own claim and
 *      nobody else's, and never an assessor's reasoning;
 *   3. **forged everything** — a forged membership, claim, beneficiary,
 *      branch or document reference, a direct function call, and
 *      `service_role`.
 *
 * ## Why the undecided-policy tests are here rather than in their own file
 *
 * They are authorization tests in substance: "may this happen" with the answer
 * "not until somebody decides". Keeping them beside the forged-identity tests
 * makes it hard to delete one group without noticing the other.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('benefit security suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  approver: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  otherBorrower: TestUser;
  /**
   * One TEST ONLY policy for the whole suite, with the benefit rules answered.
   *
   * Only one version may be in force, so a suite cannot hold both an open and
   * a shut one — and swapping between them mid-suite is worse than useless:
   * a superseded version cannot be reinstated, which is the versioning design
   * working correctly. The shut-policy tests are therefore a suite of their
   * own, `benefits-undecided.test.ts`.
   */
  policyId: string;
}

let fx: Fixtures;

const ADMISSION = { in: '2025-03-10 09:00+03', out: '2025-03-14 11:00+03' } as const;

async function openMedical(member: BenefitMember, provider: string): Promise<string> {
  const opened = await asUserCommitted(fx.secretary, [
    {
      sql: `select public.open_benefit_claim(
                     $1, 'medical', null, $2, $3::timestamptz, $4::timestamptz,
                     400000, null, null, null) as id`,
      params: [member.membershipId, provider, ADMISSION.in, ADMISSION.out],
    },
  ]);
  if (!opened.ok) throw new Error(`could not open a claim: ${opened.message}`);
  return (opened.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, approver, secretary, borrower, otherBorrower] =
    await Promise.all([
      createTestUser('owner_admin'),
      createTestUser('manager'),
      createTestUser('manager'),
      createTestUser('secretary_treasurer'),
      createTestUser('client'),
      createTestUser('client'),
    ]);

  await query(
    `insert into public.user_roles (profile_id, role_key) values ($1, 'owner_admin')
     on conflict do nothing`,
    [approver.profileId],
  );

  // TEST ONLY. The client has decided none of these four; this suite is about
  // the authorization boundary, so it needs a policy under which a claim can
  // actually reach a payment and be attacked there.
  const policyId = await publishTestPolicy({
    version: '44.0',
    // Its own effective day. `membership_policy_versions_effective_from_unique`
    // and `..._one_active` between them mean every suite needs a distinct
    // date, and the suites run sequentially in one database.
    effectiveDaysAgo: 897,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
    medicalAnnualCap: 5_000_000,
    medicalClaimsPerYear: 12,
    benefitWaitingPeriodDays: 0,
    medicalYearBasis: 'calendar_year',
  });

  fx = {
    owner,
    manager,
    approver,
    secretary,
    borrower,
    otherBorrower,
    policyId,
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await clearEvidenceBucket();
  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await closePool();
});

describeDb('cross-member privacy', () => {
  it('shows a member their own claim and nobody else’s', async () => {
    const mine = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });
    const theirs = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });

    await query(`select public.link_client_profile($1, $2)`, [
      mine.clientId,
      fx.borrower.profileId,
    ]);

    try {
      const myClaim = await openMedical(mine, 'My Hospital');
      const theirClaim = await openMedical(theirs, 'Their Hospital');

      const own = await asUser(
        fx.borrower,
        `select id from public.benefit_claims where id = $1`,
        [myClaim],
      );
      expect(own.rowCount).toBe(1);

      const other = await asUser(
        fx.borrower,
        `select id from public.benefit_claims where id = $1`,
        [theirClaim],
      );
      expect(other.rowCount).toBe(0);

      // The staff register is `security_invoker`, so the policies beneath it
      // decide — and it joins `branches`, which a borrower cannot read. The
      // result is that a member sees **nothing** through it, not a filtered
      // version of it. That is the right outcome and worth asserting: the
      // register is a staff screen, and the member's route is
      // `benefit_claim_portal_view`, whose column list is the disclosure
      // policy and which joins nothing a borrower cannot see.
      const register = await asUser(
        fx.borrower,
        `select claim_number from public.benefit_claim_register`,
      );
      expect(register.rowCount).toBe(0);

      const portal = await asUser(
        fx.borrower,
        `select claim_number from public.benefit_claim_portal_view`,
      );
      expect(portal.rowCount).toBe(1);

      // And a staff reader does see it through the register.
      const staff = await asUser(
        fx.manager,
        `select claim_number from public.benefit_claim_register where id = $1`,
        [myClaim],
      );
      expect(staff.rowCount).toBe(1);
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

  it('keeps an assessor’s reasoning away from the member it is about', async () => {
    try {
      const member = await makeBenefitMember(fx.policyId, { activatedOn: '2024-06-01' });
      await query(`select public.link_client_profile($1, $2)`, [
        member.clientId,
        fx.borrower.profileId,
      ]);

      const claimId = await openMedical(member, 'Private Reasoning Hospital');
      await asUserCommitted(fx.secretary, [
        { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
      ]);
      for (const kind of await requiredKindsFor('medical')) {
        await attachVerifiedDocument(
          claimId,
          member.membershipId,
          kind,
          fx.secretary,
          fx.manager,
        );
      }
      await asUserCommitted(fx.manager, [
        {
          sql: `select public.assess_benefit_claim(
                         $1, 'The invoice looks altered around the total.') as amount`,
          params: [claimId],
        },
      ]);

      // The snapshot carries the officer's note and the member's loan and
      // savings position. The member reaches none of it.
      const snapshot = await asUser(
        fx.borrower,
        `select assessment_note from public.benefit_assessment_snapshots
          where claim_id = $1`,
        [claimId],
      );
      expect(snapshot.rowCount).toBe(0);

      // What they do reach is the portal view, whose column list is the
      // disclosure policy — so `assessment_note` is not merely withheld, it
      // is absent and a future `select *` cannot reintroduce it.
      const portal = await asUser(
        fx.borrower,
        `select * from public.benefit_claim_portal_view where id = $1`,
        [claimId],
      );
      expect(portal.rowCount).toBe(1);
      expect(Object.keys(portal.rows[0]!)).not.toContain('assessment_note');
      expect(Object.keys(portal.rows[0]!)).toContain('rejected_reason');
    } finally {
      await query(
        `alter table public.clients disable trigger clients_guard_privileged_columns`,
      );
      await query(
        `update public.clients set profile_id = null
          where profile_id = $1`,
        [fx.borrower.profileId],
      );
      await query(
        `alter table public.clients enable trigger clients_guard_privileged_columns`,
      );
    }
  });

  it('keeps a Secretary/Treasurer out of the assessment snapshot', async () => {
    const snapshot = await asUser(
      fx.secretary,
      `select count(*)::int as n from public.benefit_assessment_snapshots`,
    );

    // Readable only by assess or approve. An assessment snapshot is an
    // officer's working record, not a register.
    expect((snapshot.rows[0] as { n: number }).n).toBe(0);
  });

  it('shows an anonymous caller nothing at all', async () => {
    for (const table of [
      'benefit_claims',
      'benefit_payments',
      'benefit_assessment_snapshots',
      'benefit_claim_documents',
      'member_beneficiaries',
      'member_beneficiary_identities',
      'membership_meetings',
      'meeting_attendance',
    ]) {
      const attempt = await asAnon(`select count(*) from public.${table}`);
      expect(attempt.ok, `anon could read ${table}`).toBe(false);
    }
  });
});

describeDb('forged references', () => {
  it('refuses a claim against a membership that does not exist', async () => {
    const attempt = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.open_benefit_claim(
                       gen_random_uuid(), 'medical', null, 'Nowhere Hospital',
                       $1::timestamptz, $2::timestamptz, 400000,
                       null, null, null) as id`,
        params: [ADMISSION.in, ADMISSION.out],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('No such membership');
  });

  it('refuses an assessment of a claim that does not exist', async () => {
    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.assess_benefit_claim(gen_random_uuid(), null) as amount`,
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('No such benefit claim');
  });

  it('refuses a verification of a beneficiary that does not exist', async () => {
    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_member_beneficiary(
                       gen_random_uuid(), true, 'witnessed_in_branch',
                       null, 'ok') as id`,
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('No such beneficiary record');
  });

  it('refuses a meeting at a branch the caller cannot see', async () => {
    // A branch id that is simply not a branch. The function checks
    // `user_can_see_branch`, which is false for a non-existent branch — so
    // the refusal is the authorization one rather than a foreign-key error,
    // which is the right order: the caller learns they may not, not that the
    // branch is missing.
    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.schedule_membership_meeting(
                       gen_random_uuid(), 'monthly_general', 'Forged Branch Meeting',
                       'Nowhere', pg_catalog.now() + interval '7 days', null) as id`,
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('cannot convene a meeting at that branch');
  });

  it('refuses a document whose path names another membership', async () => {
    const mine = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });
    const theirs = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });

    const claimId = await openMedical(mine, 'Path Forgery Hospital');
    await asUserCommitted(fx.secretary, [
      { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
    ]);

    // A real object, under the wrong membership. The existence check alone
    // would pass it; the path check is what refuses it.
    const path = await putEvidenceObject(theirs.membershipId, 'medical_invoice', claimId);

    const attached = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.attach_benefit_document(
                       $1, null, 'medical_invoice', $2,
                       'application/pdf', 20480, null) as id`,
        params: [claimId, path],
      },
    ]);

    expect(attached.ok).toBe(false);
    expect(attached.message).toContain('this membership');
  });

  it('refuses an object written under a membership through the storage policy', async () => {
    // The storage half, independent of the metadata half. A caller with no
    // benefit capability cannot write an object into the bucket at all.
    const member = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });

    const attempt = await asUser(
      fx.borrower,
      `insert into storage.objects (bucket_id, name, metadata)
       values ('benefit-documents', $1, jsonb_build_object('size', 100))`,
      [`benefits/${member.membershipId}/medical_invoice/beneficiary/forged.pdf`],
    );

    expect(attempt.ok).toBe(false);
  });

  it('refuses a counter clerk filing an assessment working paper', async () => {
    const member = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });

    // A clerk who could manufacture the paperwork that makes a claim look
    // authorised would be the whole control, undone by a file upload.
    const attempt = await asUser(
      fx.secretary,
      `insert into storage.objects (bucket_id, name, metadata)
       values ('benefit-documents', $1, jsonb_build_object('size', 100))`,
      [`benefits/${member.membershipId}/assessment_attachment/beneficiary/forged.pdf`],
    );

    expect(attempt.ok).toBe(false);
  });

  it('refuses a borrower calling every benefit function directly', async () => {
    const member = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });
    const claimId = await openMedical(member, 'Direct Call Hospital');

    const calls: readonly { readonly sql: string; readonly params: unknown[] }[] = [
      {
        sql: `select public.submit_benefit_claim($1)`,
        params: [claimId],
      },
      {
        sql: `select public.assess_benefit_claim($1, null)`,
        params: [claimId],
      },
      {
        sql: `select public.approve_benefit_claim($1, null, null)`,
        params: [claimId],
      },
      {
        sql: `select public.reject_benefit_claim($1, 'Because I say so.')`,
        params: [claimId],
      },
      {
        sql: `select public.post_benefit_payment($1, 'cash', null, gen_random_uuid())`,
        params: [claimId],
      },
      {
        sql: `select public.request_benefit_information($1, 'Send me money.')`,
        params: [claimId],
      },
      {
        sql: `select public.schedule_membership_meeting(
                       $1, 'special', 'My Meeting', 'My House',
                       pg_catalog.now() + interval '1 day', null)`,
        params: [member.branchId],
      },
      {
        sql: `select public.mark_meeting_attendance(
                       gen_random_uuid(), $1, 'present', null, null, null)`,
        params: [member.membershipId],
      },
    ];

    for (const call of calls) {
      const attempt = await asUser(fx.borrower, call.sql, call.params);
      expect(attempt.ok, `a borrower got through: ${call.sql}`).toBe(false);
    }
  });

  it('grants no EXECUTE on the reference counter to any application role', async () => {
    // Four new scopes arrived with Phase 4, and a grant here is the kind that
    // gets added by accident when one does. A caller who could mint a
    // reference could inflate the counters for no benefit.
    for (const role of ['anon', 'authenticated']) {
      const row = await queryOne<{ can_execute: boolean }>(
        `select pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') as can_execute
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'next_reference'`,
        [role],
      );
      expect(row.can_execute, `${role} can mint a reference`).toBe(false);
    }
  });

  it('keeps every Phase 4 SECURITY DEFINER function on an empty search path', async () => {
    // A definer function without `search_path = ''` can be hijacked by a
    // caller who creates a schema earlier in their own path. Asserted
    // mechanically, because reviewing it is how it gets missed.
    const loose = await query<{ proname: string }>(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and (
            p.proname like 'benefit%'
            or p.proname like '%beneficiar%'
            or p.proname like 'meeting%'
            or p.proname like '%membership_meeting%'
            or p.proname in (
              'assess_benefit_claim', 'approve_benefit_claim',
              'reject_benefit_claim', 'cancel_benefit_claim',
              'open_benefit_claim', 'submit_benefit_claim',
              'post_benefit_payment', 'reverse_benefit_payment',
              'attach_benefit_document', 'verify_benefit_document',
              'register_member_beneficiary', 'verify_member_beneficiary',
              'revoke_member_beneficiary', 'mark_meeting_attendance',
              'record_meeting_minutes', 'finalise_meeting_minutes',
              'schedule_membership_meeting', 'reschedule_membership_meeting',
              'cancel_membership_meeting', 'add_meeting_action_item',
              'update_meeting_action_item', 'medical_benefit_consumed',
              'benefits_blocked_reason', 'benefit_summary'
            )
          )
          and not exists (
            select 1 from unnest(coalesce(p.proconfig, '{}')) as c
            -- PostgreSQL stores an empty search_path setting as the quoted
            -- empty string, so both spellings count as empty and anything
            -- else counts as a path a caller could get in front of.
            where c in ('search_path=', 'search_path=""')
          )`,
    );

    expect(loose.map((row) => row.proname)).toEqual([]);
  });

  it('leaves service_role able to act, which is the documented trusted path', async () => {
    // Stated as a test rather than left implicit. `service_role` bypasses RLS
    // by design — a privileged server-side task has to be able to work — and
    // what protects the business is that the *rules* live in triggers and
    // functions that bind it too. So this asserts the bypass exists and that
    // the state machine still refuses it.
    const member = await makeBenefitMember(fx.policyId, {
      activatedOn: '2024-06-01',
    });
    const claimId = await openMedical(member, 'Service Role Hospital');

    const readable = await asServiceRole(
      `select id from public.benefit_claims where id = $1`,
      [claimId],
    );
    expect(readable.rowCount).toBe(1);

    const forged = await asServiceRole(
      `update public.benefit_claims set status = 'paid' where id = $1`,
      [claimId],
    );
    expect(forged.ok).toBe(false);
    expect(forged.message).toContain('cannot go from draft to paid');
  });
});

describeDb('the sensitive-data boundary on payments', () => {
  it('hides a beneficiary payment from a caller without view_sensitive', async () => {
    {
      const member = await makeBenefitMember(fx.policyId, { activatedOn: '2024-06-01' });
      const beneficiaryId = await makeVerifiedBeneficiary(
        member.membershipId,
        fx.secretary,
        fx.manager,
        { fullName: 'Hidden From The Counter' },
      );

      const opened = await asUserCommitted(fx.secretary, [
        {
          sql: `select public.open_benefit_claim(
                         $1, 'member_bereavement', '2025-05-01'::date,
                         null, null, null, null, 'The Deceased', null, $2) as id`,
          params: [member.membershipId, beneficiaryId],
        },
      ]);
      const claimId = (opened.rows[0] as { id: string }).id;

      await asUserCommitted(fx.secretary, [
        { sql: `select public.submit_benefit_claim($1) as id`, params: [claimId] },
      ]);
      for (const kind of await requiredKindsFor('member_bereavement')) {
        await attachVerifiedDocument(
          claimId,
          member.membershipId,
          kind,
          fx.secretary,
          fx.manager,
        );
      }
      await asUserCommitted(fx.manager, [
        {
          sql: `select public.assess_benefit_claim($1, null) as amount`,
          params: [claimId],
        },
      ]);
      await asUserCommitted(fx.approver, [
        {
          sql: `select public.approve_benefit_claim($1, null, null) as amount`,
          params: [claimId],
        },
      ]);
      await asUserCommitted(fx.manager, [
        {
          sql: `select public.post_benefit_payment(
                         $1, 'cash', null, gen_random_uuid()) as id`,
          params: [claimId],
        },
      ]);

      // The payment row carries the payee's name, so the row itself needs
      // `membership:view_sensitive` — which the counter does not hold.
      const asCounter = await asUser(
        fx.secretary,
        `select recipient_name from public.benefit_payments where claim_id = $1`,
        [claimId],
      );
      expect(asCounter.rowCount).toBe(0);

      const asSupervisor = await asUser(
        fx.manager,
        `select recipient_name from public.benefit_payments where claim_id = $1`,
        [claimId],
      );
      expect(asSupervisor.rowCount).toBe(1);
      expect(asSupervisor.rows[0]).toMatchObject({
        recipient_name: 'Hidden From The Counter',
      });
    }
  });
});
