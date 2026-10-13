import { afterAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
} from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
} from '../helpers/loan-fixtures';
import { closePool, query, hasDatabase, skipReason } from '../helpers/db';

/**
 * Phase 18 — the policy predicates are hoisted, and they still say the same
 * thing.
 *
 * ## What this file is for
 *
 * Migration `20261018000100` rewrote eighty-one policies, mechanically, to
 * evaluate their authorization helpers once per statement instead of once per
 * candidate row. The gain was large — a read of `loan_workflow_register` went
 * from 20,524 `user_has_permission` invocations to a handful — but a
 * mechanical rewrite of eighty-one security predicates is exactly the kind of
 * change that deserves to be distrusted.
 *
 * So this suite asserts two separate things:
 *
 *   1. **The hoisting is actually in place**, and a policy added later cannot
 *      silently reintroduce the per-row form. This is a performance
 *      invariant, and it is cheap to lose by accident.
 *   2. **The predicates admit exactly what they admitted before.** The
 *      restated branch check is proved against the function it replaced, over
 *      every combination of inputs; `current_user_branch_id` is proved to
 *      follow the profile; and a capability denial is proved still to deny.
 *
 * The broader "who can see what" guarantee is not this file's job — it is
 * already covered by `rls-clients`, `rls-loans`, `rls-payments`,
 * `rls-schedules`, `rls-delinquency`, `rls-identity` and `rls-reports`, all of
 * which run against the rewritten policies. This file covers the shape of the
 * rewrite itself.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('rls hoisting suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/** A constant-argument helper call that is *not* already inside a subselect. */
function hasBarePermissionCall(expression: string): boolean {
  // PostgreSQL re-renders a hoisted call with an alias, so the form in the
  // catalogue is
  //   ( SELECT user_has_permission('loans:view'::text) AS user_has_permission)
  // Strip every hoisted call, then look at what is left.
  const remaining = expression.replaceAll(
    /\(\s*SELECT\s+user_has_permission\('[a-z_:.]+'::text\)(\s+AS\s+\w+)?\s*\)/gi,
    '',
  );

  // What may legitimately remain is the one call whose argument is a column
  // (`notifications.audience_permission`), which is correlated and so cannot
  // be hoisted.
  const withoutCorrelated = remaining.replaceAll(
    /user_has_permission\(audience_permission\)/g,
    '',
  );

  return withoutCorrelated.includes('user_has_permission(');
}

function hasBareProfileCall(expression: string): boolean {
  const remaining = expression.replaceAll(
    /\(\s*SELECT\s+current_profile_id\(\)(\s+AS\s+\w+)?\s*\)/gi,
    '',
  );
  return remaining.includes('current_profile_id(');
}

describeDb('rls predicate hoisting', () => {
  afterAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  describe('the hoisting is in place', () => {
    it('calls no capability helper per row', async () => {
      const rows = await query<{
        tablename: string;
        policyname: string;
        expression: string;
      }>(
        `select tablename, policyname,
                coalesce(qual, '') || ' ' || coalesce(with_check, '') as expression
           from pg_policies
          where schemaname = 'public'`,
      );

      expect(rows.length).toBeGreaterThan(0);

      const offenders = rows
        .filter((row) => hasBarePermissionCall(row.expression))
        .map((row) => `${row.tablename}.${row.policyname}`);

      // A failure here means a policy calls `user_has_permission(...)`
      // directly in its predicate, which PostgreSQL evaluates for every
      // candidate row. Wrap it: `(select public.user_has_permission('x'))`.
      // The predicate is unchanged; only when it is evaluated changes.
      expect(offenders, offenders.join(', ')).toEqual([]);
    });

    it('resolves the caller’s profile per statement, not per row', async () => {
      const rows = await query<{
        tablename: string;
        policyname: string;
        expression: string;
      }>(
        `select tablename, policyname,
                coalesce(qual, '') || ' ' || coalesce(with_check, '') as expression
           from pg_policies
          where schemaname = 'public'`,
      );

      const offenders = rows
        .filter((row) => hasBareProfileCall(row.expression))
        .map((row) => `${row.tablename}.${row.policyname}`);

      expect(offenders, offenders.join(', ')).toEqual([]);
    });

    it('does not call the branch helper per row either', async () => {
      // `user_can_see_branch(branch_id)` is correlated *and* SECURITY
      // DEFINER, so PostgreSQL will neither hoist it nor inline it: it stayed
      // a real function call per row, each one running two queries against
      // `profiles`. The policies restate it instead. The function itself is
      // kept for other callers and is proved equivalent below.
      const rows = await query<{ tablename: string; policyname: string }>(
        `select tablename, policyname
           from pg_policies
          where schemaname = 'public'
            and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                like '%user_can_see_branch(%'`,
      );

      const offenders = rows.map((row) => `${row.tablename}.${row.policyname}`);

      expect(offenders, offenders.join(', ')).toEqual([]);
    });

    it('still gates every one of those policies on a capability', async () => {
      // The hoisting must not have dropped a term. Every policy that
      // mentioned a capability before must still mention one.
      const rows = await query<{ n: string }>(
        `select count(*) as n
           from pg_policies
          where schemaname = 'public'
            and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
                like '%user_has_permission%'`,
      );

      // Eighty-one policies were rewritten. Eighty of them name a
      // capability; the odd one out is `notification_reads_select_own`, which
      // is scoped to the reader's own profile and named no capability before
      // the rewrite either. An inventory lock rather than a round number: if
      // this drops, the rewrite lost a term.
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(80);
    });
  });

  describe('current_user_branch_id follows the profile', () => {
    it('is NULL with no session', async () => {
      const result = await asAnon(`select public.current_user_branch_id() as branch`);
      // `anon` holds no EXECUTE grant on it, which is itself the answer: an
      // anonymous caller cannot ask. Either outcome is correct; what must not
      // happen is a branch coming back.
      if (result.ok) {
        expect(result.rows[0]?.branch).toBeNull();
      } else {
        expect(result.code).toBe('42501');
      }
    });

    it('is NULL for a profile with no branch', async () => {
      const user = await createTestUser('manager');
      const result = await asUser(
        user,
        `select public.current_user_branch_id() as branch`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.branch).toBeNull();
    });

    it('is the profile’s branch once it has one', async () => {
      const user = await createTestUser('manager');
      const branch = await query<{ id: string }>(
        `select id from public.branches order by created_at limit 1`,
      );
      const branchId = branch[0]?.id;
      expect(branchId).toBeDefined();

      await query(`update public.profiles set branch_id = $2 where id = $1`, [
        user.profileId,
        branchId,
      ]);

      const result = await asUser(
        user,
        `select public.current_user_branch_id() as branch`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.branch).toBe(branchId);
    });

    it('is NULL for a suspended account, branch or no branch', async () => {
      const user = await createTestUser('manager');
      const branch = await query<{ id: string }>(
        `select id from public.branches order by created_at limit 1`,
      );

      await query(
        `update public.profiles set branch_id = $2, status = 'suspended' where id = $1`,
        [user.profileId, branch[0]?.id],
      );

      const result = await asUser(
        user,
        `select public.current_user_branch_id() as branch`,
      );

      // `current_profile_id()` resolves only active profiles, so a suspended
      // account has no branch — and, more to the point, no identity at all.
      expect(result.ok).toBe(true);
      expect(result.rows[0]?.branch).toBeNull();
    });
  });

  describe('the restated branch check is the function it replaced', () => {
    it('agrees with user_can_see_branch over every combination', async () => {
      // The policies no longer call `user_can_see_branch`; they inline its
      // three-way test with the caller's branch hoisted. This proves the two
      // forms are the same predicate, for a caller with a branch and for one
      // without, against a matching branch, a different branch, and NULL.
      const branches = await query<{ id: string }>(
        `select id from public.branches order by created_at`,
      );
      const own = branches[0]?.id;
      expect(own).toBeDefined();

      // A second branch to stand for "somebody else's", created only if the
      // seed has one branch.
      let other = branches[1]?.id;
      if (other === undefined) {
        const created = await query<{ id: string }>(
          `insert into public.branches
             (branch_code, name, location, status, opened_on)
           values ('P18-CMP', 'Phase 18 comparison branch', 'Nowhere',
                   'active', current_date)
           returning id`,
        );
        other = created[0]?.id;
      }
      expect(other).toBeDefined();

      for (const callerHasBranch of [false, true]) {
        const user = await createTestUser('manager');

        if (callerHasBranch) {
          await query(`update public.profiles set branch_id = $2 where id = $1`, [
            user.profileId,
            own,
          ]);
        }

        for (const candidate of [own, other, null]) {
          const result = await asUser(
            user,
            `select
               public.user_can_see_branch($1::uuid) as by_function,
               (
                 $1::uuid is null
                 or (select public.current_user_branch_id()) is null
                 or $1::uuid = (select public.current_user_branch_id())
               ) as by_policy`,
            [candidate],
          );

          expect(result.ok, result.message).toBe(true);

          const row = result.rows[0] as
            { by_function: boolean; by_policy: boolean } | undefined;

          expect(
            row?.by_policy,
            `caller ${callerHasBranch ? 'in a branch' : 'with no branch'}, ` +
              `row branch ${candidate === null ? 'NULL' : candidate === own ? 'own' : 'other'}`,
          ).toBe(row?.by_function);
        }
      }
    });
  });

  describe('a denial is still a denial', () => {
    it('shows an unrelated borrower none of another borrower’s loans', async () => {
      // The cheapest possible regression for this migration would be a
      // predicate hoisted into something that is always true. A borrower may
      // see their *own* disbursed loans and nobody else's, so a borrower with
      // no loans must see an empty register even though loans exist.
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId);
      await disburseLoan(loanId, scenario);

      const total = await query<{ n: string }>(`select count(*) as n from public.loans`);
      expect(Number(total[0]?.n ?? 0)).toBeGreaterThan(0);

      const stranger = await createTestUser('client');
      const seen = await asUser(stranger, `select count(*) as n from public.loans`);

      expect(seen.ok).toBe(true);
      expect(Number(seen.rows[0]?.n ?? -1)).toBe(0);
    });

    it('refuses the staff directory to a secretary/treasurer', async () => {
      const secretary = await createTestUser('secretary_treasurer');

      const holds = await asUser(
        secretary,
        `select public.user_has_permission('users:view') as held`,
      );
      expect(holds.rows[0]?.held).toBe(false);

      // Their own row and nothing else: the policy is
      // `id = current_profile_id() or user_has_permission('users:view')`,
      // and hoisting both terms must not have widened it.
      const seen = await asUser(secretary, `select id from public.profiles`);

      expect(seen.ok).toBe(true);
      expect(seen.rows.map((row) => row.id)).toEqual([secretary.profileId]);
    });
  });
});
