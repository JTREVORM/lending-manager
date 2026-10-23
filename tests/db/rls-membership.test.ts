import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Membership Row Level Security, attacked directly.
 *
 * Every statement below runs as a real database role — `anon` or
 * `authenticated` — with a real JWT subject, exactly as a request arriving at
 * PostgREST would. Nothing goes through the application, so nothing the
 * application does can account for a pass here: the sidebar hiding a link and
 * the page calling `guardPermission` are both bypassed by construction.
 *
 * The question these answer is the one that matters for a programme holding
 * people's savings: somebody with a valid token and a copy of curl — what do
 * they get?
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('membership RLS suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  /** A borrower linked to `memberClientId`, and therefore to `memberId`. */
  borrower: TestUser;
  /** A second borrower, linked to a different client with its own membership. */
  otherBorrower: TestUser;
  /** A borrower whose account has been suspended. */
  suspended: TestUser;

  memberClientId: string;
  memberId: string;
  otherClientId: string;
  otherMemberId: string;
  suspendedClientId: string;

  policyVersionId: string;
  acceptanceId: string;
}

let fx: Fixtures;

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

async function enrol(clientId: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.memberships (client_id, applied_on)
     values ($1, current_date) returning id`,
    [clientId],
  );
  return row.id;
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary, borrower, otherBorrower, suspended] =
    await Promise.all([
      createTestUser('owner_admin'),
      createTestUser('manager'),
      createTestUser('secretary_treasurer'),
      createTestUser('client'),
      createTestUser('client'),
      createTestUser('client'),
    ]);

  const policy = await queryOne<{ id: string }>(
    `update public.membership_policy_versions
        set approved_at = pg_catalog.now(), status = 'active'
      where version = '1.0'
      returning id`,
  );

  const memberClientId = await makeClient('Member Borrower', '+256700200001');
  const otherClientId = await makeClient('Other Borrower', '+256700200002');
  const suspendedClientId = await makeClient('Suspended Borrower', '+256700200003');

  // `link_client_profile` is the only route, and it is service_role only —
  // which is itself part of what is being relied on here.
  await query(`select public.link_client_profile($1, $2)`, [
    memberClientId,
    borrower.profileId,
  ]);
  await query(`select public.link_client_profile($1, $2)`, [
    otherClientId,
    otherBorrower.profileId,
  ]);
  await query(`select public.link_client_profile($1, $2)`, [
    suspendedClientId,
    suspended.profileId,
  ]);

  const memberId = await enrol(memberClientId);
  const otherMemberId = await enrol(otherClientId);
  await enrol(suspendedClientId);

  const acceptance = await queryOne<{ id: string }>(
    `insert into public.membership_terms_acceptances
       (membership_id, policy_version_id, policy_version, accepted_at, signature_name)
     values ($1, $2, '0.0', pg_catalog.now(), 'Member Borrower')
     returning id`,
    [memberId, policy.id],
  );

  // Suspending the account is what makes `current_profile_id()` resolve to
  // NULL for it, which is the mechanism every self-clause below depends on.
  await query(`update public.profiles set status = 'suspended' where id = $1`, [
    suspended.profileId,
  ]);

  fx = {
    owner,
    manager,
    secretary,
    borrower,
    otherBorrower,
    suspended,
    memberClientId,
    memberId,
    otherClientId,
    otherMemberId,
    suspendedClientId,
    policyVersionId: policy.id,
    acceptanceId: acceptance.id,
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await query(`update public.profiles set status = 'active' where id = $1`, [
    fx.suspended.profileId,
  ]);
  await deleteTestUsers();

  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_guard`,
  );
  await query(
    `alter table public.membership_policy_versions
       disable trigger audit_membership_policy_change`,
  );
  try {
    await query(
      `update public.membership_policy_versions
          set status = 'draft', approved_at = null, approved_by = null,
              approved_by_label = null
        where version = '1.0'`,
    );
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger audit_membership_policy_change`,
    );
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_guard`,
    );
  }

  await closePool();
});

// ===========================================================================
describeDb('who may read the membership register', () => {
  it('shows every membership to the three staff roles', async () => {
    for (const actor of [fx.owner, fx.manager, fx.secretary]) {
      const result = await asUser(
        actor,
        `select id from public.memberships order by membership_number`,
      );

      expect(result.ok, actor.role).toBe(true);
      expect(result.rows.length, actor.role).toBeGreaterThanOrEqual(3);
    }
  });

  it('shows a borrower their own membership and no other', async () => {
    const result = await asUser(fx.borrower, `select id from public.memberships`);

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([{ id: fx.memberId }]);
  });

  it('refuses one borrower another borrower’s membership, by id', async () => {
    // The attack a register page can never make, and curl always can: ask
    // for the row directly.
    const result = await asUser(
      fx.borrower,
      `select id from public.memberships where id = $1`,
      [fx.otherMemberId],
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('refuses one borrower another borrower’s membership through the register view', async () => {
    // A view is where this leaks if `security_invoker` was forgotten: it
    // joins three tables, and as its owner it would hand all of them over.
    const result = await asUser(
      fx.borrower,
      `select id, full_name from public.membership_register`,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.id).toBe(fx.memberId);
  });

  it('gives an anonymous visitor nothing at all', async () => {
    for (const relation of [
      'memberships',
      'membership_register',
      'membership_status_history',
      'membership_terms_acceptances',
      'membership_policy_versions',
    ]) {
      const result = await asAnon(`select * from public.${relation}`);

      // `anon` holds no grant on any of them, so the refusal arrives as
      // insufficient privilege rather than as an empty set. Either is a
      // denial; a row is not.
      expect(result.rows, relation).toEqual([]);
      expect(result.ok, relation).toBe(false);
    }
  });

  it('gives a suspended account nothing, although its token is still valid', async () => {
    // The account holds the `client` role and is linked to a client with a
    // membership. Everything about the token is still well-formed; what has
    // changed is that `current_profile_id()` resolves only active profiles,
    // so the self-clause matches nothing from the next statement onwards.
    const result = await asUser(fx.suspended, `select id from public.memberships`);

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
  });
});

// ===========================================================================
describeDb('who may read a membership’s history', () => {
  it('shows it to the three staff roles', async () => {
    for (const actor of [fx.owner, fx.manager, fx.secretary]) {
      const result = await asUser(
        actor,
        `select id from public.membership_status_history where membership_id = $1`,
        [fx.memberId],
      );

      expect(result.ok, actor.role).toBe(true);
      expect(result.rows.length, actor.role).toBeGreaterThan(0);
    }
  });

  it('shows a member nothing of it, including their own', async () => {
    // Deliberate, and the same rule `client_remarks` follows: a suspension
    // reason is an internal decision written *about* the member. What the
    // portal eventually says about a member's standing is Polytos Phase 5's
    // to choose, in words written for that purpose.
    const own = await asUser(
      fx.borrower,
      `select id from public.membership_status_history where membership_id = $1`,
      [fx.memberId],
    );

    expect(own.ok).toBe(true);
    expect(own.rows).toEqual([]);
  });

  it('lets nobody write one, whatever capability they hold', async () => {
    for (const actor of [fx.owner, fx.manager, fx.secretary]) {
      const result = await asUser(
        actor,
        `insert into public.membership_status_history
           (membership_id, to_status, effective_on)
         values ($1, 'active', current_date)`,
        [fx.memberId],
      );

      expect(result.ok, actor.role).toBe(false);
      expect(result.code, actor.role).toBe('42501');
    }
  });
});

// ===========================================================================
describeDb('who may read the terms a member signed', () => {
  it('shows an acceptance to staff and to the member who signed it', async () => {
    for (const actor of [fx.owner, fx.manager, fx.secretary, fx.borrower]) {
      const result = await asUser(
        actor,
        `select id from public.membership_terms_acceptances where id = $1`,
        [fx.acceptanceId],
      );

      expect(result.ok, actor.role).toBe(true);
      expect(result.rows, actor.role).toHaveLength(1);
    }
  });

  it('refuses it to a different borrower', async () => {
    const result = await asUser(
      fx.otherBorrower,
      `select id from public.membership_terms_acceptances where id = $1`,
      [fx.acceptanceId],
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
  });
});

// ===========================================================================
describeDb('who may read the policy', () => {
  it('shows the published policy to every staff role', async () => {
    for (const actor of [fx.owner, fx.manager, fx.secretary]) {
      const result = await asUser(
        actor,
        `select version from public.membership_policy_versions where id = $1`,
        [fx.policyVersionId],
      );

      expect(result.ok, actor.role).toBe(true);
      expect(result.rows, actor.role).toHaveLength(1);
    }
  });

  it('shows a member the version they are enrolled under', async () => {
    const result = await asUser(
      fx.borrower,
      `select version from public.membership_policy_versions`,
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it('shows a non-member borrower no policy at all', async () => {
    // A draft the business is preparing is nobody's terms yet, and a client
    // with no membership is bound by none of them.
    const stranger = await createTestUser('client');

    try {
      const result = await asUser(
        stranger,
        `select version from public.membership_policy_versions`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows).toEqual([]);
    } finally {
      await query(`delete from public.user_roles where profile_id = $1`, [
        stranger.profileId,
      ]);
      await query(`delete from public.profiles where id = $1`, [stranger.profileId]);
      await query(`delete from auth.users where id = $1`, [stranger.authUserId]);
    }
  });
});

// ===========================================================================
describeDb('who may enrol a member', () => {
  it('refuses a borrower enrolling themselves, or anybody else', async () => {
    const result = await asUser(
      fx.borrower,
      `insert into public.memberships (client_id, applied_on)
       values ($1, current_date)`,
      [fx.otherClientId],
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });

  it('refuses an enrolment that arrives already active', async () => {
    const clientId = await makeClient('Pre-active Member', '+256700201001');

    const result = await asUser(
      fx.manager,
      `insert into public.memberships (client_id, applied_on, status)
       values ($1, current_date, 'active')`,
      [clientId],
    );

    expect(result.ok).toBe(false);
  });
});

// ===========================================================================
describeDb('the new policies weaken nothing that was already protected', () => {
  it('still refuses a Secretary/Treasurer a National Identification Number', async () => {
    const result = await asUser(fx.secretary, `select nin from public.client_identities`);

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('still refuses a borrower another borrower’s client record', async () => {
    const result = await asUser(
      fx.borrower,
      `select id from public.clients where id = $1`,
      [fx.otherClientId],
    );

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
  });

  it('still refuses a Manager the audit trail', async () => {
    const result = await asUser(fx.manager, `select id from public.audit_log limit 1`);

    expect(result.rows).toEqual([]);
  });

  it('adds no policy that evaluates a capability helper per row', async () => {
    // The Phase 18 rule, restated for the membership policies specifically.
    // A bare `user_has_permission(...)` in a predicate is evaluated for every
    // candidate row; wrapped in a scalar subquery it becomes an InitPlan and
    // runs once per statement. `tests/db/rls-hoisting.test.ts` asserts this
    // across the whole schema; this one names the tables so a failure points
    // straight at the migration that caused it.
    const rows = await query<{ tablename: string; policyname: string }>(
      `select tablename, policyname
         from pg_policies
        where schemaname = 'public'
          and tablename like 'membership%'
          and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
              ~ '[^(]\\s*public\\.user_has_permission\\('`,
    );

    expect(rows.map((row) => `${row.tablename}.${row.policyname}`)).toEqual([]);
  });

  it('gates every membership policy on a capability or on the caller themselves', async () => {
    const rows = await query<{ policyname: string; expression: string }>(
      `select policyname,
              coalesce(qual, '') || ' ' || coalesce(with_check, '') as expression
         from pg_policies
        where schemaname = 'public' and tablename like 'membership%'`,
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(
        /user_has_permission|current_profile_id/.test(row.expression),
        row.policyname,
      ).toBe(true);
    }
  });
});
