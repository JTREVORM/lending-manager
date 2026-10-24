import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  closePool,
  expectError,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';

/**
 * Enrolment, the ADR-050 activation preconditions, and consent that can be
 * checked.
 *
 * ## What these are really testing
 *
 * Phase 1 shipped a membership record with no way to become a member. The two
 * things it promised Phase 2 would add are the two things most worth
 * attacking:
 *
 *   1. A membership must not reach `active` unless the registration fee has
 *      actually reached the ledger and a **verified** acceptance of the
 *      member's own policy version exists.
 *   2. A typed name must not count as consent.
 *
 * Both are enforced inside the database, above the trusted-path exemption, so
 * each is attacked twice: as a real authenticated role, and as the table
 * owner. A rule that only stops a session is one a leaked service key walks
 * through.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('membership enrolment suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  policyId: string;
  /** A client with no membership, replaced for each test that consumes one. */
  nextClient: () => Promise<string>;
}

let fx: Fixtures;
let clientSeq = 0;

async function makeClient(name: string, phone: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'female', '1990-01-01', $2, 'Trader', 'Kalerwe', 'Kampala')
     returning id`,
    [name, phone],
  );
  return row.id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('client'),
  ]);

  const policyId = await publishTestPolicy({
    version: '7.0',
    effectiveDaysAgo: 1,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
  });

  fx = {
    owner,
    manager,
    secretary,
    borrower,
    policyId,
    nextClient: async () => {
      clientSeq += 1;
      return makeClient(
        `Enrolment Case ${clientSeq}`,
        `+2567002${String(10000 + clientSeq).slice(-5)}`,
      );
    },
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_no_delete`,
  );
  await query(
    `alter table public.membership_policy_versions
       disable trigger audit_membership_policy_change`,
  );
  try {
    await query(`delete from public.membership_policy_versions where version = '7.0'`);
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger audit_membership_policy_change`,
    );
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_no_delete`,
    );
  }
  await closePool();
});

/** A pending membership with nothing else done to it. */
async function pendingMembership(): Promise<{ id: string; clientId: string }> {
  const clientId = await fx.nextClient();
  const row = await queryOne<{ id: string }>(
    `insert into public.memberships (client_id, applied_on)
     values ($1, public.business_date()) returning id`,
    [clientId],
  );
  return { id: row.id, clientId };
}

// ===========================================================================
describeDb('a membership cannot be activated without a posted fee', () => {
  it('refuses activation when no fee has been taken', async () => {
    const { id } = await pendingMembership();

    const refused = await expectError(
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );

    expect(refused?.message).toContain('registration fee has not been posted');
  });

  it('refuses activation when the fee was taken and then reversed', async () => {
    const { id } = await pendingMembership();

    const receipt = await queryOne<{ id: string }>(
      `select public.record_membership_fee($1, 5000, 'cash', null, gen_random_uuid()) as id`,
      [id],
    );
    await query(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed', 'witnessed_in_branch', $2
         from public.memberships where id = $1`,
      [id, fx.manager.profileId],
    );

    // Reversed, so the ledger no longer carries it.
    await query(`select public.reverse_membership_fee($1, 'Posted in error')`, [
      receipt.id,
    ]);

    const refused = await expectError(
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );

    expect(refused?.message).toContain('registration fee has not been posted');
  });

  it('refuses activation when the journal entry behind the fee was reversed', async () => {
    // The receipt still says `posted`; its journal does not. The precondition
    // reads the journal, which is what "successfully posted" has to mean.
    const { id } = await pendingMembership();

    // Two statements, deliberately. A single query that both posts the fee
    // and reads the receipt back finds nothing: the row the function inserts
    // is not in the snapshot the enclosing statement is already reading under.
    const posting = await queryOne<{ id: string }>(
      `select public.record_membership_fee(
                $1, 5000, 'cash', null, gen_random_uuid()) as id`,
      [id],
    );
    const receipt = await queryOne<{ id: string; journal_entry_id: string }>(
      `select id, journal_entry_id
         from public.membership_fee_receipts where id = $1`,
      [posting.id],
    );
    await query(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed', 'witnessed_in_branch', $2
         from public.memberships where id = $1`,
      [id, fx.manager.profileId],
    );

    const posted = await queryOne<{ ok: boolean }>(
      `select public.membership_fee_is_posted($1) as ok`,
      [id],
    );
    expect(posted.ok).toBe(true);

    // Stamp the entry as reversed without touching the receipt.
    await query(
      `alter table public.journal_entries disable trigger journal_entries_guard_update`,
    );
    try {
      await query(
        `update public.journal_entries
            set reversed_by_entry_id = (
              select id from public.journal_entries
               where id <> $1 order by entry_number limit 1)
          where id = $1`,
        [receipt.journal_entry_id],
      );
    } finally {
      await query(
        `alter table public.journal_entries enable trigger journal_entries_guard_update`,
      );
    }

    const stillPosted = await queryOne<{ ok: boolean }>(
      `select public.membership_fee_is_posted($1) as ok`,
      [id],
    );
    expect(stillPosted.ok, 'a reversed entry is not a posted fee').toBe(false);

    const refused = await expectError(
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );
    expect(refused?.message).toContain('registration fee has not been posted');
  });

  it('refuses the activation from a Manager too, not only from the table owner', async () => {
    const { id } = await pendingMembership();

    const refused = await asUser(
      fx.manager,
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );

    expect(refused.ok).toBe(false);
    expect(refused.message ?? '').toContain('registration fee has not been posted');
  });

  it('refuses a fee that is not the published amount', async () => {
    const { id } = await pendingMembership();

    const refused = await expectError(
      `select public.record_membership_fee($1, 4000, 'cash', null, gen_random_uuid())`,
      [id],
    );

    expect(refused?.message).toContain('5000');
  });
});

// ===========================================================================
describeDb('a membership cannot be activated without verified consent', () => {
  it('refuses activation when the fee is posted but nothing was accepted', async () => {
    const { id } = await pendingMembership();
    await query(
      `select public.record_membership_fee($1, 5000, 'cash', null, gen_random_uuid())`,
      [id],
    );

    const refused = await expectError(
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );

    expect(refused?.message).toContain('no verified acceptance');
  });

  it('refuses an acceptance of a different policy version', async () => {
    const other = await publishTestPolicy({
      version: '7.9',
      effectiveDaysAgo: 40,
      status: 'superseded',
    });

    const { id } = await pendingMembership();
    await query(
      `select public.record_membership_fee($1, 5000, 'cash', null, gen_random_uuid())`,
      [id],
    );
    await query(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id)
       values ($1, $2, pg_catalog.now(), 'Signed', 'witnessed_in_branch', $3)`,
      [id, other, fx.manager.profileId],
    );

    const refused = await expectError(
      `update public.memberships set status = 'active' where id = $1`,
      [id],
    );

    expect(refused?.message).toContain('no verified acceptance');
  });

  it('refuses an acceptance that is nothing but a typed name', async () => {
    const { id } = await pendingMembership();

    const refused = await expectError(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method)
       select $1, policy_version_id, pg_catalog.now(), 'Any Name I Like',
              'legacy_typed_name'
         from public.memberships where id = $1`,
      [id],
    );

    expect(refused?.message).toContain('must use a method that can be checked');
  });

  it('refuses a caller-supplied verified flag, even from the table owner', async () => {
    // The whole Phase 1 defect in one assertion: the column is derived, and
    // asserting it does not make it so.
    const { id } = await pendingMembership();

    await query(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id, verification_status)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'witnessed_in_branch', $2, 'verified'
         from public.memberships where id = $1`,
      [id, fx.manager.profileId],
    );

    // It verified — but because the witness is real, not because the caller
    // said so. The next case proves the difference.
    const row = await queryOne<{ verification_status: string }>(
      `select verification_status from public.membership_terms_acceptances
        where membership_id = $1`,
      [id],
    );
    expect(row.verification_status).toBe('verified');

    const { id: second } = await pendingMembership();
    const refused = await expectError(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id, verification_status)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'witnessed_in_branch',
              '00000000-0000-4000-8000-00000000dead'::uuid, 'verified'
         from public.memberships where id = $1`,
      [second],
    );

    expect(
      refused?.message,
      'a verified flag with no real witness behind it is refused',
    ).toContain('must be a member of staff');
  });

  it('refuses a witness who is the person recording the acceptance', async () => {
    const { id } = await pendingMembership();

    const refused = await asUser(
      fx.manager,
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'witnessed_in_branch', $2
         from public.memberships where id = $1`,
      [id, fx.manager.profileId],
    );

    expect(refused.ok).toBe(false);
    expect(refused.message ?? '').toMatch(/witness cannot be the person recording/i);
  });

  it('refuses a witness whose account is suspended', async () => {
    const suspended = await createTestUser('manager', 'suspended');
    const { id } = await pendingMembership();

    const refused = await expectError(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, witness_profile_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'witnessed_in_branch', $2
         from public.memberships where id = $1`,
      [id, suspended.profileId],
    );

    expect(refused?.message).toContain('suspended');
  });

  it('refuses a signature document that nobody uploaded', async () => {
    const { id } = await pendingMembership();

    const refused = await expectError(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, signature_path)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'signature_document',
              -- Cast, because an uncast parameter in the concatenation is
              -- inferred as text, and the predicate below would then be
              -- comparing uuid to text.
              'memberships/' || $1::uuid || '/signature/claimed.png'
         from public.memberships where id = $1::uuid`,
      [id],
    );

    expect(refused?.message).toContain('No signature document has been uploaded');
  });

  it('accepts a signature document that is actually there, and refuses one belonging to another member', async () => {
    const first = await pendingMembership();
    const second = await pendingMembership();

    const path = `memberships/${first.id}/signature/signed.png`;
    await query(
      `insert into storage.objects (bucket_id, name) values ('membership-consent', $1)`,
      [path],
    );

    await query(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, signature_path)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'signature_document', $2
         from public.memberships where id = $1`,
      [first.id, path],
    );

    const row = await queryOne<{ verification_status: string; evidence_digest: string }>(
      `select verification_status, evidence_digest
         from public.membership_terms_acceptances where membership_id = $1`,
      [first.id],
    );
    expect(row.verification_status).toBe('verified');
    expect(row.evidence_digest).toMatch(/^[0-9a-f]{64}$/);

    // The same file cannot be presented for somebody else's acceptance: the
    // path names the first membership, and the digest is unique anyway.
    const refused = await expectError(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, signature_path)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'signature_document', $2
         from public.memberships where id = $1`,
      [second.id, path],
    );

    expect(refused?.message).toContain('belongs to a different membership');
  });

  it('refuses a portal acceptance recorded by anybody but the member', async () => {
    const { id, clientId } = await pendingMembership();
    await query(`select public.link_client_profile($1, $2)`, [
      clientId,
      fx.borrower.profileId,
    ]);

    const refused = await asUser(
      fx.manager,
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, member_profile_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'member_portal', $2
         from public.memberships where id = $1`,
      [id, fx.borrower.profileId],
    );

    expect(refused.ok).toBe(false);
    expect(refused.message ?? '').toMatch(/must be made by the member/i);
  });
});

// ===========================================================================
describeDb('the one-time consent code', () => {
  it('verifies an acceptance, and cannot be spent twice', async () => {
    const { id } = await pendingMembership();

    const challenge = await queryOne<{ challenge_id: string; code: string }>(
      `select challenge_id, code
         from public.issue_membership_consent_code(
                $1, (select policy_version_id from public.memberships where id = $1))`,
      [id],
    );

    expect(challenge.code).toMatch(/^[0-9]{6}$/);

    // The digest is stored, never the code.
    const stored = await queryOne<{ code_digest: string }>(
      `select code_digest from public.membership_consent_challenges where id = $1`,
      [challenge.challenge_id],
    );
    expect(stored.code_digest).not.toBe(challenge.code);
    expect(stored.code_digest).toMatch(/^[0-9a-f]{64}$/);

    const wrong = await expectError(
      `select public.redeem_membership_consent_code($1, '000000')`,
      [challenge.challenge_id],
    );
    // A wrong guess is possible but counted; the right one still works.
    expect(wrong === null || wrong.message.includes('does not match')).toBe(true);

    await query(`select public.redeem_membership_consent_code($1, $2)`, [
      challenge.challenge_id,
      challenge.code,
    ]);

    await query(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, challenge_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'one_time_code', $2
         from public.memberships where id = $1`,
      [id, challenge.challenge_id],
    );

    const row = await queryOne<{ verification_status: string }>(
      `select verification_status from public.membership_terms_acceptances
        where membership_id = $1`,
      [id],
    );
    expect(row.verification_status).toBe('verified');

    const consumed = await queryOne<{ consumed_at: string | null }>(
      `select consumed_at from public.membership_consent_challenges where id = $1`,
      [challenge.challenge_id],
    );
    expect(consumed.consumed_at, 'the challenge is spent').not.toBeNull();
  });

  it('refuses a challenge issued for a different membership', async () => {
    const a = await pendingMembership();
    const b = await pendingMembership();

    const challenge = await queryOne<{ challenge_id: string }>(
      `select challenge_id
         from public.issue_membership_consent_code(
                $1, (select policy_version_id from public.memberships where id = $1))`,
      [a.id],
    );

    const refused = await expectError(
      `insert into public.membership_terms_acceptances
         (membership_id, policy_version_id, accepted_at, signature_name,
          consent_method, challenge_id)
       select $1, policy_version_id, pg_catalog.now(), 'Signed',
              'one_time_code', $2
         from public.memberships where id = $1`,
      [b.id, challenge.challenge_id],
    );

    expect(refused?.message).toContain('different membership');
  });
});

// ===========================================================================
describeDb('enrol_member does the whole thing, or none of it', () => {
  it('enrols, takes the fee, verifies consent, activates and opens the account', async () => {
    const clientId = await fx.nextClient();

    const membership = await queryOne<{ id: string }>(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'New Member',
                gen_random_uuid(), null, $2, null, null, null, null, null) as id`,
      [clientId, fx.manager.profileId],
    );

    const row = await queryOne<{
      status: string;
      activated_on: string;
      account_number: string;
      balance: string;
    }>(
      `select m.status, m.activated_on, a.account_number, b.balance
         from public.memberships m
         join public.savings_accounts a on a.membership_id = m.id
         join public.member_savings_balances b on b.savings_account_id = a.id
        where m.id = $1`,
      [membership.id],
    );

    expect(row.status).toBe('active');
    expect(row.activated_on).not.toBeNull();
    expect(row.account_number).toMatch(/^SA\d{6,}$/);
    expect(row.balance).toBe('0');
  });

  it('takes the fee and the first deposit as one payment, split correctly', async () => {
    const clientId = await fx.nextClient();

    const membership = await queryOne<{ id: string }>(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Combined Payer',
                gen_random_uuid(), null, $2, null,
                50000, null, gen_random_uuid(), null) as id`,
      [clientId, fx.manager.profileId],
    );

    const row = await queryOne<{ balance: string }>(
      `select b.balance
         from public.savings_accounts a
         join public.member_savings_balances b on b.savings_account_id = a.id
        where a.membership_id = $1`,
      [membership.id],
    );
    expect(row.balance, 'the deposit, not the whole 55,000').toBe('50000');

    const ledger = await query<{ code: string; dr: string; cr: string }>(
      `select a.code,
              coalesce(sum(l.debit), 0)::text as dr,
              coalesce(sum(l.credit), 0)::text as cr
         from public.journal_lines l
         join public.ledger_accounts a on a.id = l.account_id
         join public.journal_entries e on e.id = l.entry_id
        where e.client_id = (select client_id from public.memberships where id = $1)
        group by a.code order by a.code`,
      [membership.id],
    );

    const byCode = Object.fromEntries(ledger.map((r) => [r.code, r]));
    expect(byCode['2100']?.cr, 'savings are a liability').toBe('50000');
    expect(byCode['4340']?.cr, 'the fee is income').toBe('5000');
    expect(byCode['1010-BR2601']?.dr, 'one payment of 55,000 arrived').toBe('55000');
  });

  it('refuses a second live membership for the same client', async () => {
    const clientId = await fx.nextClient();

    await query(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Once Only',
                gen_random_uuid(), null, $2, null, null, null, null, null)`,
      [clientId, fx.manager.profileId],
    );

    const refused = await expectError(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Twice',
                gen_random_uuid(), null, $2, null, null, null, null, null)`,
      [clientId, fx.manager.profileId],
    );

    expect(refused?.message).toContain('already holds a live membership');
  });

  it('replays a retried enrolment rather than enrolling twice', async () => {
    const clientId = await fx.nextClient();
    const key = (await queryOne<{ k: string }>(`select gen_random_uuid() as k`)).k;

    const first = await queryOne<{ id: string }>(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Retried',
                $2::uuid, null, $3, null, null, null, null, null) as id`,
      [clientId, key, fx.manager.profileId],
    );
    const second = await queryOne<{ id: string }>(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Retried',
                $2::uuid, null, $3, null, null, null, null, null) as id`,
      [clientId, key, fx.manager.profileId],
    );

    expect(second.id, 'the same membership comes back').toBe(first.id);

    const receipts = await query<{ n: string }>(
      `select count(*)::text as n from public.membership_fee_receipts
        where membership_id = $1`,
      [first.id],
    );
    expect(receipts[0]?.n, 'the fee was taken once').toBe('1');
  });

  it('leaves nothing behind when the consent cannot be verified', async () => {
    const clientId = await fx.nextClient();

    const refused = await expectError(
      `select public.enrol_member(
                $1, 'cash', null, 'signature_document', 'Unsigned',
                gen_random_uuid(),
                'memberships/00000000-0000-4000-8000-000000000000/signature/none.png',
                null, null, null, null, null, null)`,
      [clientId],
    );

    expect(refused).not.toBeNull();

    // The whole thing rolled back: no membership, no receipt, no journal.
    const left = await queryOne<{ memberships: string; receipts: string }>(
      `select
         (select count(*)::text from public.memberships where client_id = $1) as memberships,
         (select count(*)::text from public.membership_fee_receipts
            where client_id = $1) as receipts`,
      [clientId],
    );
    expect(left.memberships).toBe('0');
    expect(left.receipts).toBe('0');
  });

  it('refuses enrolment from a Secretary/Treasurer, who may not enrol', async () => {
    const clientId = await fx.nextClient();

    const refused = await asUser(
      fx.secretary,
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Not Allowed',
                gen_random_uuid(), null, $2, null, null, null, null, null)`,
      [clientId, fx.manager.profileId],
    );

    expect(refused.ok).toBe(false);
    expect(refused.message ?? '').toContain('membership:create');
  });
});

// ===========================================================================
describeDb('membership cards', () => {
  async function activeMembership(): Promise<string> {
    const clientId = await fx.nextClient();
    const row = await queryOne<{ id: string }>(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', 'Card Holder',
                gen_random_uuid(), null, $2, null, null, null, null, null) as id`,
      [clientId, fx.manager.profileId],
    );
    return row.id;
  }

  it('issues one card, and a reissue supersedes it without touching the balance', async () => {
    const membershipId = await activeMembership();

    await query(`select public.issue_membership_card($1)`, [membershipId]);
    await query(
      `select public.post_savings_deposit(
                   (select id from public.savings_accounts where membership_id = $1),
                   40000, 'cash', null, gen_random_uuid())`,
      [membershipId],
    );

    await query(`select public.issue_membership_card($1, 'lost')`, [membershipId]);

    const cards = await query<{ card_number: string; status: string; reason: string }>(
      `select card_number, status, issue_reason as reason
         from public.membership_cards where membership_id = $1
        order by card_number`,
      [membershipId],
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.status).toBe('superseded');
    expect(cards[1]?.status).toBe('active');
    expect(cards[1]?.reason).toBe('lost');

    const balance = await queryOne<{ balance: string }>(
      `select b.balance from public.savings_accounts a
         join public.member_savings_balances b on b.savings_account_id = a.id
        where a.membership_id = $1`,
      [membershipId],
    );
    expect(balance.balance, 'reissuing a card moves no money').toBe('40000');

    const memberships = await queryOne<{ n: string }>(
      `select count(*)::text as n from public.memberships where id = $1`,
      [membershipId],
    );
    expect(memberships.n, 'reissuing a card creates no membership').toBe('1');
  });

  it('refuses a card for a membership that is not yet a membership', async () => {
    const { id } = await pendingMembership();

    const refused = await expectError(`select public.issue_membership_card($1)`, [id]);

    expect(refused?.message).toContain('pending');
  });

  it('gives a verification code that identifies nothing on its own', async () => {
    const membershipId = await activeMembership();
    await query(`select public.issue_membership_card($1)`, [membershipId]);

    const card = await queryOne<{ code: string; number: string; client_id: string }>(
      `select verification_code as code, card_number as number, client_id
         from public.membership_cards where membership_id = $1`,
      [membershipId],
    );

    expect(card.code).toMatch(/^[A-Z0-9]{12}$/);
    // Not derived from anything the member is identified by, so a scanned
    // code reveals nothing by itself.
    expect(card.code).not.toContain(card.number);
    expect(card.code).not.toContain(card.client_id.slice(0, 8).toUpperCase());
    // And the letters that are read aloud as each other are absent.
    expect(card.code).not.toMatch(/[IO01]/);
  });
});
