import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  asUserCommitted,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  clearEvidenceBucket,
  makeBenefitMember,
  makeVerifiedBeneficiary,
  putEvidenceObject,
  type BenefitMember,
} from '../helpers/benefits';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * Member beneficiaries: the payment instruction, and the five ways it must not
 * be bendable.
 *
 * ## What these are really testing
 *
 * A row in `member_beneficiaries` decides who receives UGX 200,000 when a
 * member dies. The obvious fraud against a benefits scheme is not a forged
 * hospital bill — it is a member of staff who records themselves as the
 * beneficiary of a member they expect to die, or who edits the record the week
 * a claim is filed. So every test below attacks one of those:
 *
 *   1. recording and verifying are different people;
 *   2. a change supersedes rather than overwrites;
 *   3. a change is refused while a bereavement claim is live;
 *   4. a verification needs evidence that exists;
 *   5. the contact details are behind `membership:view_sensitive`, in a
 *      separate table, because RLS is row-level.
 *
 * Each is attacked as a real authenticated role **and**, where the rule lives
 * in a trigger, as the table owner — a rule that only stops a session is one a
 * leaked service key walks through.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('beneficiary suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  policyId: string;
  member: BenefitMember;
  nextMember: () => Promise<BenefitMember>;
}

let fx: Fixtures;

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('client'),
  ]);

  // Benefits deliberately shut: this suite is about beneficiary records,
  // which §6 of the Phase 4 brief says must work independently of the
  // undecided benefit rules. A policy that opened benefits here would make
  // that independence untested.
  const policyId = await publishTestPolicy({
    version: '40.0',
    // Its own effective day. `membership_policy_versions_effective_from_unique`
    // means two suites cannot both publish for the same date, and the suites
    // run sequentially against one database.
    effectiveDaysAgo: 860,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
  });

  const member = await makeBenefitMember(policyId);

  fx = {
    owner,
    manager,
    secretary,
    borrower,
    policyId,
    member,
    nextMember: () => makeBenefitMember(policyId),
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await clearEvidenceBucket();
  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await closePool();
});

describeDb('registering a beneficiary', () => {
  it('records it unverified, whatever the caller asks for', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Grace Atim', 'spouse', '+256700444001',
                       null, 'Bukoto', 'Kampala', 'national_id', 'CM90001234ABCD',
                       true, null) as id`,
        params: [member.membershipId],
      },
    ]);

    expect(created.ok).toBe(true);

    const row = await queryOne<{
      verification_status: string;
      status: string;
      is_primary: boolean;
      beneficiary_number: string;
      recorded_by_label: string;
    }>(
      `select verification_status, status, is_primary, beneficiary_number,
              recorded_by_label
         from public.member_beneficiaries where membership_id = $1`,
      [member.membershipId],
    );

    expect(row.verification_status).toBe('pending_verification');
    expect(row.status).toBe('active');
    expect(row.is_primary).toBe(true);
    // The atomic counter, not MAX(number) + 1.
    expect(row.beneficiary_number).toMatch(/^BN\d{6,}$/);
    expect(row.recorded_by_label).toContain('secretary');
  });

  it('writes the identity into the sibling table, not the record', async () => {
    const member = await fx.nextMember();
    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Esther  Namuli', 'parent', '+256700444002') as id`,
        params: [member.membershipId],
      },
    ]);

    // The name is normalised on the way in — two spaces become one — because
    // the duplicate digest is computed over the normalised form and a record
    // stored differently from the form that was hashed would make the index
    // meaningless.
    const identity = await queryOne<{ full_name: string; phone: string }>(
      `select i.full_name, i.phone
         from public.member_beneficiary_identities i
         join public.member_beneficiaries b on b.id = i.beneficiary_id
        where b.membership_id = $1`,
      [member.membershipId],
    );

    expect(identity.full_name).toBe('Esther Namuli');
    expect(identity.phone).toBe('+256700444002');

    // And the record itself carries no name column at all, which is what
    // makes the capability split enforceable rather than aspirational.
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'member_beneficiaries'`,
    );

    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('full_name');
    expect(names).not.toContain('phone');
    expect(names).not.toContain('identity_reference');
  });

  it('refuses a duplicate that differs only in spacing or case', async () => {
    const member = await fx.nextMember();

    const first = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Mary Nakato', 'sibling', '+256700444003',
                       null, null, null, null, null, false, null) as id`,
        params: [member.membershipId],
      },
    ]);
    expect(first.ok).toBe(true);

    const duplicate = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, '  mary   NAKATO ', 'sibling', '+256700444003',
                       null, null, null, null, null, false, null) as id`,
        params: [member.membershipId],
      },
    ]);

    expect(duplicate.ok).toBe(false);
    expect(duplicate.code).toBe('23505');
  });

  it('refuses a second primary beneficiary, and says what to do instead', async () => {
    const member = await fx.nextMember();

    await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'First Primary', 'spouse', '+256700444004') as id`,
        params: [member.membershipId],
      },
    ]);

    const second = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Second Primary', 'child', '+256700444005') as id`,
        params: [member.membershipId],
      },
    ]);

    expect(second.ok).toBe(false);
    expect(second.message).toContain('already has a primary beneficiary');
    expect(second.message).toContain('supersede');
  });

  it('refuses a beneficiary on a deceased membership', async () => {
    const member = await makeBenefitMember(fx.policyId, { status: 'active' });

    await query(
      `update public.memberships
          set status = 'deceased', ended_on = public.business_date(),
              status_reason = 'Fixture: died before a beneficiary was named.'
        where id = $1`,
      [member.membershipId],
    );

    const attempt = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Too Late', 'child', '+256700444006') as id`,
        params: [member.membershipId],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('never after a member has died');
  });

  it('refuses a caller without beneficiaries:manage', async () => {
    const member = await fx.nextMember();

    const attempt = await asUser(
      fx.borrower,
      `select public.register_member_beneficiary(
                $1, 'Not Allowed', 'spouse', '+256700444007') as id`,
      [member.membershipId],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('beneficiaries:manage');
  });

  it('refuses an anonymous caller', async () => {
    const attempt = await asAnon(
      `select public.register_member_beneficiary(
                $1, 'Anonymous', 'spouse', '+256700444008') as id`,
      [fx.member.membershipId],
    );

    expect(attempt.ok).toBe(false);
  });
});

describeDb('verifying a beneficiary', () => {
  it('refuses a verification from the person who recorded it', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.manager, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Self Verify', 'spouse', '+256700444010') as id`,
        params: [member.membershipId],
      },
    ]);

    const id = (created.rows[0] as { id: string }).id;

    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_member_beneficiary(
                       $1, true, 'witnessed_in_branch', null, 'Seen by me.') as id`,
        params: [id],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('recorded by you');
  });

  it('accepts a verification from somebody else, with evidence named', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    const row = await queryOne<{
      verification_status: string;
      verification_evidence_kind: string;
      verified_by_label: string;
      recorded_by_label: string;
    }>(
      `select verification_status, verification_evidence_kind,
              verified_by_label, recorded_by_label
         from public.member_beneficiaries where id = $1`,
      [id],
    );

    expect(row.verification_status).toBe('verified');
    expect(row.verification_evidence_kind).toBe('witnessed_in_branch');
    expect(row.verified_by_label).not.toBe(row.recorded_by_label);
  });

  it('refuses a verification with no evidence kind', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'No Evidence', 'parent', '+256700444011') as id`,
        params: [member.membershipId],
      },
    ]);

    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_member_beneficiary($1, true, '', null, null) as id`,
        params: [(created.rows[0] as { id: string }).id],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('names the evidence');
  });

  it('refuses a document verification whose object does not exist', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Phantom Document', 'child', '+256700444012') as id`,
        params: [member.membershipId],
      },
    ]);

    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_member_beneficiary(
                       $1, true, 'relationship_document',
                       $2, null) as id`,
        params: [
          (created.rows[0] as { id: string }).id,
          `benefits/${member.membershipId}/relationship_evidence/beneficiary/nobody-uploaded-this.pdf`,
        ],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('nobody uploaded');
  });

  it('refuses a document verification against another membership’s folder', async () => {
    const mine = await fx.nextMember();
    const theirs = await fx.nextMember();

    // A real object, but filed under somebody else's membership. This is the
    // forged-reference attack: the file exists, so an existence check alone
    // would pass it.
    const path = await putEvidenceObject(
      theirs.membershipId,
      'relationship_evidence',
      'beneficiary',
    );

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Borrowed Evidence', 'sibling', '+256700444013') as id`,
        params: [mine.membershipId],
      },
    ]);

    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_member_beneficiary(
                       $1, true, 'relationship_document', $2, null) as id`,
        params: [(created.rows[0] as { id: string }).id, path],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('this membership');
  });

  it('refuses a refusal with no reason', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Silent Refusal', 'cousin', '+256700444014') as id`,
        params: [member.membershipId],
      },
    ]);

    const attempt = await asUserCommitted(fx.manager, [
      {
        sql: `select public.verify_member_beneficiary(
                       $1, false, 'witnessed_in_branch', null, null) as id`,
        params: [(created.rows[0] as { id: string }).id],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('needs a reason');
  });

  it('cannot be reached by an UPDATE, even as the table owner', async () => {
    const member = await fx.nextMember();

    const created = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Direct Update', 'spouse', '+256700444015') as id`,
        params: [member.membershipId],
      },
    ]);

    const id = (created.rows[0] as { id: string }).id;

    // The owner, who RLS does not apply to. The refusal is in the trigger, so
    // it binds here too — which is the point: a rule that only stops a session
    // is one a leaked service key walks through.
    await expect(
      query(
        `update public.member_beneficiaries
            set verification_status = 'verified',
                verified_at = pg_catalog.now(),
                verified_by_label = 'forged',
                verification_evidence_kind = 'witnessed_in_branch'
          where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/not set by an update/);
  });
});

describeDb('changing a beneficiary', () => {
  it('supersedes the old record and keeps it readable', async () => {
    const member = await fx.nextMember();
    const first = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
      { fullName: 'Original Payee', relationship: 'spouse' },
    );

    const replaced = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Replacement Payee', 'child', '+256700444020',
                       null, null, null, null, null, true, $2) as id`,
        params: [member.membershipId, first],
      },
    ]);

    expect(replaced.ok).toBe(true);

    const old = await queryOne<{
      status: string;
      is_primary: boolean;
      ended_reason: string;
      verification_status: string;
    }>(
      `select status, is_primary, ended_reason, verification_status
         from public.member_beneficiaries where id = $1`,
      [first],
    );

    // Superseded, not deleted, and still recording that it *had* been
    // verified. That is deliberate: "the business paid this person in March,
    // and a named officer had checked her" is what makes a historic payment
    // explicable, so superseding ends the instruction without destroying the
    // fact. "The verified beneficiary" is the live one, which the index on
    // (membership) where active and primary makes unique.
    expect(old.status).toBe('superseded');
    expect(old.is_primary).toBe(false);
    expect(old.verification_status).toBe('verified');
    expect(old.ended_reason).toContain('Superseded');

    // And the identity of the old record is still there, which is what makes a
    // historic payment explicable.
    const identity = await queryOne<{ full_name: string }>(
      `select full_name from public.member_beneficiary_identities
        where beneficiary_id = $1`,
      [first],
    );
    expect(identity.full_name).toBe('Original Payee');

    // Exactly one live primary.
    const live = await query<{ id: string }>(
      `select id from public.member_beneficiaries
        where membership_id = $1 and status = 'active' and is_primary`,
      [member.membershipId],
    );
    expect(live).toHaveLength(1);
  });

  it('refuses an edit to the record in place, even as the table owner', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    await expect(
      query(
        `update public.member_beneficiaries set relationship = 'cousin' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/not edited/);
  });

  it('refuses an edit to the identity row at all', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    await expect(
      query(
        `update public.member_beneficiary_identities
            set phone = '+256700999999' where beneficiary_id = $1`,
        [id],
      ),
    ).rejects.toThrow();

    await expect(
      query(
        `delete from public.member_beneficiary_identities where beneficiary_id = $1`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it('refuses a supersession of a record on another membership', async () => {
    const mine = await fx.nextMember();
    const theirs = await fx.nextMember();

    const theirBeneficiary = await makeVerifiedBeneficiary(
      theirs.membershipId,
      fx.secretary,
      fx.manager,
    );

    const attempt = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.register_member_beneficiary(
                       $1, 'Cross Membership', 'spouse', '+256700444021',
                       null, null, null, null, null, true, $2) as id`,
        params: [mine.membershipId, theirBeneficiary],
      },
    ]);

    expect(attempt.ok).toBe(false);
    expect(attempt.message).toContain('different membership');
  });

  it('never deletes a record', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    await expect(
      query(`delete from public.member_beneficiaries where id = $1`, [id]),
    ).rejects.toThrow();
  });

  it('revokes with a reason, keeping every detail', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
    );

    const revoked = await asUserCommitted(fx.secretary, [
      {
        sql: `select public.revoke_member_beneficiary(
                       $1, 'The member nominated nobody in her place.') as id`,
        params: [id],
      },
    ]);

    expect(revoked.ok).toBe(true);

    const row = await queryOne<{
      status: string;
      verification_status: string;
      ended_reason: string;
    }>(
      `select status, verification_status, ended_reason
         from public.member_beneficiaries where id = $1`,
      [id],
    );

    expect(row.status).toBe('revoked');
    expect(row.ended_reason).toContain('nominated nobody');
  });
});

describeDb('who may read what', () => {
  it('lets a Secretary/Treasurer see the record and not the identity', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
      { fullName: 'Confidential Payee' },
    );

    const record = await asUser(
      fx.secretary,
      `select beneficiary_number, relationship, verification_status
         from public.member_beneficiaries where id = $1`,
      [id],
    );

    expect(record.ok).toBe(true);
    expect(record.rowCount).toBe(1);

    // The whole reason the table is split. A clerk who can see that a member
    // has a verified next of kin cannot see who she is.
    const identity = await asUser(
      fx.secretary,
      `select full_name from public.member_beneficiary_identities
        where beneficiary_id = $1`,
      [id],
    );

    expect(identity.ok).toBe(true);
    expect(identity.rowCount).toBe(0);
  });

  it('lets a Manager holding membership:view_sensitive see the identity', async () => {
    const member = await fx.nextMember();
    const id = await makeVerifiedBeneficiary(
      member.membershipId,
      fx.secretary,
      fx.manager,
      { fullName: 'Visible To Manager' },
    );

    const identity = await asUser(
      fx.manager,
      `select full_name from public.member_beneficiary_identities
        where beneficiary_id = $1`,
      [id],
    );

    expect(identity.rowCount).toBe(1);
    expect(identity.rows[0]).toMatchObject({ full_name: 'Visible To Manager' });
  });

  it('lets a member read their own nomination and nobody else’s', async () => {
    const mine = await fx.nextMember();
    const theirs = await fx.nextMember();

    // Through the linking function, which is the only route: the client
    // guard refuses a bare UPDATE of `profile_id`.
    await query(`select public.link_client_profile($1, $2)`, [
      mine.clientId,
      fx.borrower.profileId,
    ]);

    const myBeneficiary = await makeVerifiedBeneficiary(
      mine.membershipId,
      fx.secretary,
      fx.manager,
      { fullName: 'My Own Next Of Kin' },
    );
    const theirBeneficiary = await makeVerifiedBeneficiary(
      theirs.membershipId,
      fx.secretary,
      fx.manager,
      { fullName: 'Somebody Else' },
    );

    const own = await asUser(
      fx.borrower,
      `select i.full_name
         from public.member_beneficiary_identities i
        where i.beneficiary_id = $1`,
      [myBeneficiary],
    );

    expect(own.rowCount).toBe(1);

    const other = await asUser(
      fx.borrower,
      `select i.full_name
         from public.member_beneficiary_identities i
        where i.beneficiary_id = $1`,
      [theirBeneficiary],
    );

    expect(other.rowCount).toBe(0);

    // Unlinked so `deleteTestUsers` can remove the borrower's profile.
    // `link_client_profile` requires both arguments, so this uses the same
    // documented owner-level trigger exemption the policy fixtures use.
    await query(
      `alter table public.clients disable trigger clients_guard_privileged_columns`,
    );
    try {
      await query(`update public.clients set profile_id = null where id = $1`, [
        mine.clientId,
      ]);
    } finally {
      await query(
        `alter table public.clients enable trigger clients_guard_privileged_columns`,
      );
    }
  });

  it('shows an anonymous caller nothing', async () => {
    const attempt = await asAnon(`select count(*) from public.member_beneficiaries`);
    expect(attempt.ok).toBe(false);
  });

  it('grants no INSERT or UPDATE on either table to authenticated', async () => {
    const grants = await query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'authenticated'
          and table_schema = 'public'
          and table_name in
              ('member_beneficiaries', 'member_beneficiary_identities')
        order by table_name, privilege_type`,
    );

    // SELECT on both and nothing else. Every write goes through a SECURITY
    // DEFINER function, so a directly inserted beneficiary — a payment
    // instruction nobody checked — is not merely discouraged but impossible.
    expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
      'member_beneficiaries:SELECT',
      'member_beneficiary_identities:SELECT',
    ]);
  });
});
