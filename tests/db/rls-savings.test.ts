import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import {
  depositOn,
  enrolMember,
  forcePolicyStatus,
  publishTestPolicy,
} from '../helpers/membership';

/**
 * Savings Row Level Security, attacked directly.
 *
 * Every statement below runs as a real database role — `anon` or
 * `authenticated` — with a real JWT subject, exactly as a request arriving at
 * PostgREST would. The application is bypassed by construction, so nothing it
 * does can account for a pass here: a hidden sidebar entry, a guarded Server
 * Component and a disabled button are all irrelevant to the queries below.
 *
 * ## The two questions
 *
 *   1. **Who can read a member's savings?** Staff holding `savings:view`,
 *      within their branch, and the member whose savings they are. Nobody
 *      else — not another member, not a member of staff without the
 *      capability, not a suspended account, not `anon`.
 *   2. **Who can move money?** Nobody, by writing a row. There is no INSERT
 *      or UPDATE grant on the subledger at all, so every movement has to go
 *      through a posting function, and each of those checks its own
 *      capability. That is tested from both ends: the write is refused, and
 *      the function is refused to a caller who should not hold it.
 *
 * The functions are SECURITY DEFINER, which is exactly why they are called
 * directly here rather than only through the fixtures. A definer function
 * runs as the owner; if its capability check were missing or wrong, the
 * table policies would never get a chance to stop it.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('savings RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  /** A second manager, so a withdrawal can be decided by somebody else. */
  approver: TestUser;
  /**
   * A signed-in account holding no savings capability and linked to no client
   * record. The system has exactly four roles and every staff role holds
   * `savings:view`, so the no-capability caller is a `client` account — and
   * one with nothing of their own is the cleanest form of it.
   */
  stranger: TestUser;
  /** The member whose savings these are. */
  member: TestUser;
  /** A different member, with their own account. */
  otherMember: TestUser;
  /** A member whose account has been suspended. */
  suspendedMember: TestUser;

  policyId: string;
  savingsAccountId: string;
  otherSavingsAccountId: string;
  suspendedSavingsAccountId: string;
  membershipId: string;
  clientId: string;
  depositId: string;
  receiptId: string;
  cardId: string;
}

let fx: Fixtures;
let clientSeq = 0;

async function makeClient(name: string): Promise<string> {
  clientSeq += 1;
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'female', '1991-03-15', $2, 'Trader', 'Kawempe', 'Kampala')
     returning id`,
    [name, `+2567004${String(10000 + clientSeq).slice(-5)}`],
  );
  return row.id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [
    owner,
    manager,
    secretary,
    approver,
    stranger,
    member,
    otherMember,
    suspendedMember,
  ] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('manager'),
    createTestUser('client'),
    createTestUser('client'),
    createTestUser('client'),
    createTestUser('client'),
  ]);

  const policyId = await publishTestPolicy({
    version: '7.2',
    effectiveDaysAgo: 200,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
  });

  const clientId = await makeClient('Savings Member');
  const otherClientId = await makeClient('Other Savings Member');
  const suspendedClientId = await makeClient('Suspended Savings Member');

  // `link_client_profile` is service_role only, which is itself part of what
  // the member-identity policies rely on.
  await query(`select public.link_client_profile($1, $2)`, [clientId, member.profileId]);
  await query(`select public.link_client_profile($1, $2)`, [
    otherClientId,
    otherMember.profileId,
  ]);
  await query(`select public.link_client_profile($1, $2)`, [
    suspendedClientId,
    suspendedMember.profileId,
  ]);

  const enrolled = await enrolMember(clientId, manager.profileId);
  const otherEnrolled = await enrolMember(otherClientId, manager.profileId);
  const suspendedEnrolled = await enrolMember(suspendedClientId, manager.profileId);

  if (
    enrolled.savingsAccountId === null ||
    otherEnrolled.savingsAccountId === null ||
    suspendedEnrolled.savingsAccountId === null
  ) {
    throw new Error('enrol_member opened no savings account');
  }

  const depositId = await depositOn(enrolled.savingsAccountId, 80_000);
  await depositOn(otherEnrolled.savingsAccountId, 90_000);

  const receipt = await queryOne<{ id: string }>(
    `select id from public.membership_fee_receipts where membership_id = $1`,
    [enrolled.membershipId],
  );
  const card = await queryOne<{ id: string }>(
    `select public.issue_membership_card($1, 'first_issue') as id`,
    [enrolled.membershipId],
  );

  // Suspended *after* the account was opened and the fixtures were built, so
  // what is being tested is the suspension taking effect rather than a user
  // who never had anything.
  await query(`update public.profiles set status = 'suspended' where id = $1`, [
    suspendedMember.profileId,
  ]);

  fx = {
    owner,
    manager,
    secretary,
    approver,
    stranger,
    member,
    otherMember,
    suspendedMember,
    policyId,
    savingsAccountId: enrolled.savingsAccountId,
    otherSavingsAccountId: otherEnrolled.savingsAccountId,
    suspendedSavingsAccountId: suspendedEnrolled.savingsAccountId,
    membershipId: enrolled.membershipId,
    clientId,
    depositId,
    receiptId: receipt.id,
    cardId: card.id,
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
    await query(`delete from public.membership_policy_versions where version = '7.2'`);
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

// ===========================================================================
describeDb('anon gets nothing', () => {
  it('reads no savings table and no savings view', async () => {
    for (const relation of [
      'savings_accounts',
      'savings_transactions',
      'savings_withdrawal_requests',
      'membership_fee_receipts',
      'membership_cards',
      'member_savings_balances',
      'savings_account_register',
      'member_savings_contributions',
    ]) {
      const attempt = await asAnon(`select * from public.${relation}`);
      expect(attempt.ok ? attempt.rowCount : 0, `anon read rows from ${relation}`).toBe(
        0,
      );
    }
  });

  it('cannot call any posting function', async () => {
    const deposit = await asAnon(
      `select public.post_savings_deposit($1, 10000, 'cash', null, gen_random_uuid())`,
      [fx.savingsAccountId],
    );
    expect(deposit.ok).toBe(false);
    expect(deposit.message ?? '').toMatch(/permission denied/i);

    const request = await asAnon(
      `select public.request_savings_withdrawal($1, 10000, 'Mine now')`,
      [fx.savingsAccountId],
    );
    expect(request.ok).toBe(false);
    expect(request.message ?? '').toMatch(/permission denied/i);
  });

  it('cannot reach the consent challenge table, which holds code digests', async () => {
    const attempt = await asAnon(`select * from public.membership_consent_challenges`);
    expect(attempt.ok ? attempt.rowCount : 0).toBe(0);
  });
});

// ===========================================================================
describeDb('staff read what their capability allows and nothing beyond it', () => {
  it('lets a secretary, a manager and the owner read the register', async () => {
    for (const user of [fx.secretary, fx.manager, fx.owner]) {
      const attempt = await asUser(
        user,
        `select savings_account_id from public.savings_account_register`,
      );
      expect(attempt.ok, `${user.role} could not read the register`).toBe(true);
      expect(attempt.rowCount).toBeGreaterThanOrEqual(3);
    }
  });

  it('shows a caller with no savings capability nothing at all', async () => {
    // The register opens to staff through `savings:view` and to a member
    // through their own client record. A caller with neither reads nothing —
    // and reads nothing because the policy says so, not because a menu hid
    // the link.
    const accounts = await asUser(fx.stranger, `select id from public.savings_accounts`);
    expect(accounts.rowCount).toBe(0);

    const transactions = await asUser(
      fx.stranger,
      `select id from public.savings_transactions`,
    );
    expect(transactions.rowCount).toBe(0);

    const register = await asUser(
      fx.stranger,
      `select savings_account_id from public.savings_account_register`,
    );
    expect(register.rowCount).toBe(0);
  });

  it('refuses them the deposit function, not merely the table', async () => {
    // Both ends of the same rule. The table grant stops a row being written;
    // this stops the definer function that would have written it, which is
    // the end that would otherwise run as the owner.
    const attempt = await asUser(
      fx.stranger,
      `select public.post_savings_deposit($1, 10000, 'cash', null, gen_random_uuid())`,
      [fx.savingsAccountId],
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.message ?? '').toMatch(/savings:deposit capability/i);
  });

  it('refuses a secretary the approval, the payment and the reversal', async () => {
    // The secretary takes money in and prepares requests. Deciding one,
    // paying one and reversing a posted transaction are three separate
    // capabilities they do not hold, and the split is the control.
    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 10000, 'Fees') as id`,
      [fx.savingsAccountId],
    );

    try {
      const decided = await asUser(
        fx.secretary,
        `select public.decide_savings_withdrawal($1, true, 'Looks fine')`,
        [request.id],
      );
      expect(decided.ok).toBe(false);
      expect(decided.message ?? '').toMatch(/savings:approve_withdrawal capability/i);

      const reversed = await asUser(
        fx.secretary,
        `select public.reverse_savings_transaction($1, 'Not mine to reverse')`,
        [fx.depositId],
      );
      expect(reversed.ok).toBe(false);
      expect(reversed.message ?? '').toMatch(/savings:reverse capability/i);
    } finally {
      await query(`select public.cancel_savings_withdrawal($1, 'Test fixture cleanup')`, [
        request.id,
      ]);
    }
  });

  it('refuses a manager the reversal, which only the owner holds', async () => {
    const attempt = await asUser(
      fx.manager,
      `select public.reverse_savings_transaction($1, 'Rethinking this')`,
      [fx.depositId],
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.message ?? '').toMatch(/savings:reverse capability/i);
  });
});

// ===========================================================================
describeDb('a member sees their own savings and only their own', () => {
  it('reads their own account, balance, statement rows and fee receipt', async () => {
    const account = await asUser(
      fx.member,
      `select id, account_number from public.savings_accounts`,
    );
    expect(account.ok).toBe(true);
    expect(account.rowCount, 'exactly one account: theirs').toBe(1);
    expect(account.rows[0]?.id).toBe(fx.savingsAccountId);

    const balance = await asUser(
      fx.member,
      `select balance from public.member_savings_balances`,
    );
    expect(balance.rowCount).toBe(1);
    expect(Number(balance.rows[0]?.balance)).toBe(80_000);

    const transactions = await asUser(
      fx.member,
      `select id from public.savings_transactions`,
    );
    expect(transactions.rowCount).toBe(1);

    const receipt = await asUser(
      fx.member,
      `select id from public.membership_fee_receipts`,
    );
    expect(receipt.rowCount).toBe(1);
    expect(receipt.rows[0]?.id).toBe(fx.receiptId);
  });

  it('cannot read another member, by selecting them or by naming their id', async () => {
    const byPredicate = await asUser(
      fx.member,
      `select id from public.savings_accounts where id = $1`,
      [fx.otherSavingsAccountId],
    );
    expect(byPredicate.rowCount, 'naming an id is not authority to read it').toBe(0);

    const byView = await asUser(
      fx.member,
      `select balance from public.member_savings_balances where savings_account_id = $1`,
      [fx.otherSavingsAccountId],
    );
    expect(byView.rowCount).toBe(0);

    const byContribution = await asUser(
      fx.member,
      `select contributed from public.member_savings_contributions
        where savings_account_id = $1`,
      [fx.otherSavingsAccountId],
    );
    expect(byContribution.rowCount).toBe(0);
  });

  it('gets nothing from the statement function for an account that is not theirs', async () => {
    // `savings_statement` is SECURITY DEFINER, so it is not filtered by the
    // policies at all — a member calling it with somebody else's id is the
    // attack this answers. The function is granted to `authenticated`, which
    // is why what it returns matters rather than whether it runs.
    const own = await asUser(
      fx.member,
      `select transaction_id from public.savings_statement($1)`,
      [fx.savingsAccountId],
    );
    expect(own.ok).toBe(true);
    expect(own.rowCount).toBe(1);

    const theirs = await asUser(
      fx.member,
      `select transaction_id from public.savings_statement($1)`,
      [fx.otherSavingsAccountId],
    );
    expect(
      theirs.ok ? theirs.rowCount : 0,
      'a definer statement function must not read another member',
    ).toBe(0);
  });

  it('cannot deposit to their own account', async () => {
    // Deliberate. A record of money the business has not received is worse
    // than no record: the money has to arrive at a counter before anything
    // says it did.
    const attempt = await asUser(
      fx.member,
      `select public.post_savings_deposit($1, 50000, 'cash', null, gen_random_uuid())`,
      [fx.savingsAccountId],
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.message ?? '').toMatch(/savings:deposit capability/i);
  });

  it('cannot request, approve, pay or reverse anything', async () => {
    const request = await asUser(
      fx.member,
      `select public.request_savings_withdrawal($1, 10000, 'I would like it')`,
      [fx.savingsAccountId],
    );
    expect(request.ok).toBe(false);
    expect(request.message ?? '').toMatch(/savings:request_withdrawal capability/i);

    const reverse = await asUser(
      fx.member,
      `select public.reverse_savings_transaction($1, 'Undo this')`,
      [fx.depositId],
    );
    expect(reverse.ok).toBe(false);
    expect(reverse.message ?? '').toMatch(/savings:reverse capability/i);
  });

  it('cannot see another member through the card verification code', async () => {
    const own = await asUser(fx.member, `select id from public.membership_cards`);
    expect(own.rowCount, 'a member reads their own card').toBe(1);
    expect(own.rows[0]?.id).toBe(fx.cardId);

    const other = await asUser(
      fx.otherMember,
      `select id from public.membership_cards where id = $1`,
      [fx.cardId],
    );
    expect(other.rowCount).toBe(0);
  });

  it('loses it all the moment the account is suspended', async () => {
    // `current_profile_id()` resolves only active profiles, which is what
    // makes a suspension take effect on the next request rather than at the
    // next sign-in.
    const accounts = await asUser(
      fx.suspendedMember,
      `select id from public.savings_accounts`,
    );
    expect(accounts.rowCount, 'a suspended member reads nothing').toBe(0);

    const balances = await asUser(
      fx.suspendedMember,
      `select balance from public.member_savings_balances`,
    );
    expect(balances.rowCount).toBe(0);
  });
});

// ===========================================================================
describeDb('nothing is written through a policy', () => {
  it('grants no INSERT, UPDATE or DELETE on the subledger to any role', async () => {
    const grants = await query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name = 'savings_transactions'
          and grantee in ('anon', 'authenticated')
        order by grantee, privilege_type`,
    );

    expect(
      grants.map((g) => `${g.grantee}:${g.privilege_type}`),
      'SELECT for authenticated, and nothing else, for either role',
    ).toEqual(['authenticated:SELECT']);
  });

  it('refuses a direct insert into the subledger even from the owner role', async () => {
    const attempt = await asUser(
      fx.owner,
      `insert into public.savings_transactions
         (savings_account_id, membership_id, client_id, kind, amount,
          payment_method, value_date)
       values ($1, $2, $3, 'deposit', 999999, 'cash', current_date)`,
      [fx.savingsAccountId, fx.membershipId, fx.clientId],
    );

    expect(
      attempt.ok,
      'a transaction with no journal behind it is money nobody posted',
    ).toBe(false);
    expect(attempt.message ?? '').toMatch(/permission denied/i);
  });

  it('grants no INSERT on savings_accounts, fee receipts, requests or cards', async () => {
    const grants = await query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public'
          and grantee = 'authenticated'
          and table_name in ('savings_accounts', 'membership_fee_receipts',
                             'savings_withdrawal_requests', 'membership_cards')
        order by table_name, privilege_type`,
    );

    expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
      'membership_cards:SELECT',
      'membership_fee_receipts:SELECT',
      // UPDATE, because restricting or closing an account is a supervisory
      // act; `savings_accounts_guard` decides which columns that reaches.
      'savings_accounts:SELECT',
      'savings_accounts:UPDATE',
      'savings_withdrawal_requests:SELECT',
    ]);
  });

  it('lets only a savings:reverse holder update an account, and only through the guard', async () => {
    const asManager = await asUser(
      fx.manager,
      `update public.savings_accounts set status = 'restricted' where id = $1`,
      [fx.savingsAccountId],
    );
    expect(
      asManager.ok ? asManager.rowCount : 0,
      'a manager holds no savings:reverse, so the policy filters the row out',
    ).toBe(0);

    const asMember = await asUser(
      fx.member,
      `update public.savings_accounts set status = 'closed' where id = $1`,
      [fx.savingsAccountId],
    );
    expect(asMember.ok ? asMember.rowCount : 0).toBe(0);
  });

  it('refuses a forged consent challenge insert', async () => {
    // The challenge table is written and consumed by definer functions. A
    // caller who could insert one could consent on somebody else's behalf.
    const attempt = await asUser(
      fx.manager,
      `insert into public.membership_consent_challenges
         (membership_id, policy_version_id, delivered_to, code_digest, expires_at)
       select $1, policy_version_id, '+256700000000',
              pg_catalog.encode(pg_catalog.sha256('000000'::bytea), 'hex'),
              pg_catalog.now() + interval '1 hour'
         from public.memberships where id = $1`,
      [fx.membershipId],
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.message ?? '').toMatch(/permission denied/i);
  });
});

// ===========================================================================
describeDb('idempotency keys are not a way in', () => {
  it('replaying another caller’s key returns that caller’s transaction and posts nothing', async () => {
    const key = await queryOne<{ k: string }>(`select gen_random_uuid() as k`);

    const posted = await queryOne<{ id: string }>(
      `select public.post_savings_deposit($1, 30000, 'cash', null, $2) as id`,
      [fx.savingsAccountId, key.k],
    );

    const before = await queryOne<{ n: string; total: string }>(
      `select count(*) as n, coalesce(sum(signed_amount), 0)::bigint as total
         from public.savings_transactions where savings_account_id = $1`,
      [fx.savingsAccountId],
    );

    // The replay comes from a caller who may deposit, with a *different*
    // amount and a different account. The key wins: it returns the original
    // and writes nothing, so a replayed form cannot be turned into a second
    // movement by changing its figures.
    const replay = await asUser(
      fx.secretary,
      `select public.post_savings_deposit($1, 999999, 'cash', null, $2) as id`,
      [fx.otherSavingsAccountId, key.k],
    );

    expect(replay.ok).toBe(true);
    expect(replay.rows[0]?.id, 'the key identifies the movement, not the request').toBe(
      posted.id,
    );

    const after = await queryOne<{ n: string; total: string }>(
      `select count(*) as n, coalesce(sum(signed_amount), 0)::bigint as total
         from public.savings_transactions where savings_account_id = $1`,
      [fx.savingsAccountId],
    );
    expect(after.n).toBe(before.n);
    expect(after.total).toBe(before.total);

    const otherTotal = await queryOne<{ total: string }>(
      `select coalesce(sum(signed_amount), 0)::bigint as total
         from public.savings_transactions where savings_account_id = $1`,
      [fx.otherSavingsAccountId],
    );
    expect(
      Number(otherTotal.total),
      'nothing landed in the account the replay named',
    ).toBe(90_000);
  });

  it('refuses the replay to a caller who holds no deposit capability', async () => {
    // The capability check must not be behind the replay shortcut. A caller
    // who cannot deposit must not learn a transaction id by guessing a key
    // either.
    const key = await queryOne<{ k: string }>(`select gen_random_uuid() as k`);
    await query(`select public.post_savings_deposit($1, 20000, 'cash', null, $2)`, [
      fx.savingsAccountId,
      key.k,
    ]);

    const attempt = await asUser(
      fx.stranger,
      `select public.post_savings_deposit($1, 20000, 'cash', null, $2) as id`,
      [fx.savingsAccountId, key.k],
    );

    expect(attempt.ok).toBe(false);
    expect(attempt.message ?? '').toMatch(/savings:deposit capability/i);
  });
});

// ===========================================================================
describeDb('the consent bucket', () => {
  it('shows a member their own signature and not another member’s', async () => {
    const own = `memberships/${fx.membershipId}/signature/mine.png`;
    const other = `memberships/${fx.otherSavingsAccountId}/signature/theirs.png`;

    await query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('membership-consent', $1, '{}'::jsonb),
              ('membership-consent', $2, '{}'::jsonb)`,
      [own, other],
    );

    try {
      const mine = await asUser(
        fx.member,
        `select name from storage.objects where bucket_id = 'membership-consent'`,
      );
      expect(mine.ok).toBe(true);
      expect(mine.rows.map((r) => r.name)).toEqual([own]);

      const theirs = await asUser(
        fx.otherMember,
        `select name from storage.objects
          where bucket_id = 'membership-consent' and name = $1`,
        [own],
      );
      expect(theirs.rowCount, 'a signature is not public to other members').toBe(0);

      // Staff holding membership:view read the bucket, which is what lets a
      // branch produce the evidence when a member disputes an acceptance.
      const staff = await asUser(
        fx.manager,
        `select name from storage.objects where bucket_id = 'membership-consent'`,
      );
      expect(staff.rowCount).toBe(2);
    } finally {
      await query(`delete from storage.objects where bucket_id = 'membership-consent'`);
    }
  });

  it('has no UPDATE or DELETE policy, so evidence is not replaced', async () => {
    const policies = await query<{ cmd: string }>(
      `select cmd from pg_catalog.pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and policyname like 'membership_consent%'
        order by cmd`,
    );

    expect(policies.map((p) => p.cmd).sort()).toEqual(['INSERT', 'SELECT', 'SELECT']);
  });
});
