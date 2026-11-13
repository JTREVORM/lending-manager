/**
 * Phase 2 security hardening: the authorization surface of privileged objects.
 *
 * Three findings are closed here, and each gets both halves of the proof — the
 * caller who must be refused is refused, and the caller who must still work
 * still works. A one-sided test would pass just as happily against a function
 * that refuses everybody.
 *
 *   20261106000100  validate_loan_for_approval  — borrower disclosure
 *   20261106000200  redeem_membership_consent_code — attempt exhaustion
 *   20261106000300  company_identity — reviewed definer-view exemption
 *   20261106000500  savings amounts — confirmed cross-member disclosure
 *
 * The structural assertions (grants, which name holds the rules) matter as
 * much as the behavioural ones: the whole point of the loan-validation fix is
 * that the rules moved behind a name the Data API cannot reach, and a future
 * `create or replace` could undo that silently while every behavioural test
 * still passed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asAnon,
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import { createDraftLoan, createLoanScenario } from '../helpers/loan-fixtures';
import { forcePolicyStatus, publishTestPolicy } from '../helpers/membership';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('security definer surface', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

describeDb('the privileged authorization surface', () => {
  const users: Record<string, TestUser> = {};
  let loanId: string;
  let clientId: string;
  let policyId: string | undefined;

  beforeAll(async () => {
    await deleteTestUsers();
    const scenario = await createLoanScenario();
    users.owner_admin = scenario.owner;
    users.manager = scenario.manager;
    users.secretary_treasurer = scenario.secretary;
    users.client = await createTestUser('client');
    clientId = scenario.clientId;
    await query('select public.link_client_profile($1, $2)', [
      clientId,
      users.client.profileId,
    ]);
    loanId = await createDraftLoan(clientId);

    // A membership cannot be recorded without a policy version in force, and
    // the consent-code cases below need one. Its own effective day: the
    // unique index on effective_from means no two suites may share one, and
    // the suites run sequentially against a single database. Every rule this
    // policy does not need is left undecided, so nothing here opens lending
    // or benefits for other suites.
    policyId = await publishTestPolicy({ version: '950.1', effectiveDaysAgo: 950 });
  });

  afterAll(async () => {
    // `membership_policy_versions_one_active` permits exactly one version in
    // force, so a suite that publishes one must retire it or every later
    // suite's own publish collides. This is the same handover the benefit
    // suites make.
    if (policyId) await forcePolicyStatus(policyId, 'superseded');
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  // 20261106000100 — the loan-validation disclosure
  // =========================================================================
  describe('validate_loan_for_approval', () => {
    it('refuses a borrower who holds no loan capability', async () => {
      const denied = await asUser(
        users.client!,
        'select * from public.validate_loan_for_approval($1)',
        [loanId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    it('refuses an anonymous caller', async () => {
      const denied = await asAnon('select * from public.validate_loan_for_approval($1)', [
        loanId,
      ]);

      expect(denied.ok).toBe(false);
    });

    for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
      it(`still answers ${role}, who holds loans:view`, async () => {
        const allowed = await asUser(
          users[role]!,
          'select * from public.validate_loan_for_approval($1)',
          [loanId],
        );

        expect(allowed.ok).toBe(true);
      });
    }

    it('returns the same assessment it did before the guard was added', async () => {
      // A draft loan with no guarantor consent is not approvable, and the
      // wrapper must report precisely the codes the rules produce — not an
      // empty list, which would read as "approvable" on the approval screen.
      const viaWrapper = await asUser(
        users.manager!,
        `select failure_code from public.validate_loan_for_approval($1)
         order by failure_code`,
        [loanId],
      );
      const viaInternal = await query<{ failure_code: string }>(
        `select failure_code from public.validate_loan_for_approval_internal($1)
         order by failure_code`,
        [loanId],
      );

      expect(viaWrapper.ok).toBe(true);
      expect(viaWrapper.rows.map((r) => r.failure_code)).toEqual(
        viaInternal.map((r) => r.failure_code),
      );
    });

    it('keeps the internal rules function off the Data API', async () => {
      const grants = await queryOne<{
        authenticated: boolean;
        anon: boolean;
        service_role: boolean;
      }>(
        `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
                has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname = 'validate_loan_for_approval_internal'`,
      );

      // PostgREST can only reach what the request's role may execute.
      expect(grants.authenticated).toBe(false);
      expect(grants.anon).toBe(false);
      // Trusted maintenance and seed paths keep it.
      expect(grants.service_role).toBe(true);
    });

    it('refuses a borrower calling the internal name directly', async () => {
      const denied = await asUser(
        users.client!,
        'select * from public.validate_loan_for_approval_internal($1)',
        [loanId],
      );

      expect(denied.ok).toBe(false);
      // A missing EXECUTE privilege, not a capability refusal.
      expect(denied.code).toBe('42501');
    });

    it('keeps the approval rules behind the internal name only', async () => {
      // If a later migration moves the two-hundred-line body back into the
      // public name, the guard becomes decoration. Assert the split directly.
      const rows = await query<{ proname: string; holds_rules: boolean }>(
        `select p.proname,
                (pg_get_functiondef(p.oid) ~ 'member_amount_above_ceiling') as holds_rules
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like 'validate_loan_for_approval%'
          order by p.proname`,
      );

      expect(rows).toHaveLength(2);
      expect(
        rows.find((r) => r.proname === 'validate_loan_for_approval')?.holds_rules,
        'the public wrapper must hold no approval rules',
      ).toBe(false);
      expect(
        rows.find((r) => r.proname === 'validate_loan_for_approval_internal')
          ?.holds_rules,
        'the internal function must still hold the approval rules',
      ).toBe(true);
    });

    it('preserves the signature the application and approve_loan call', async () => {
      const shape = await queryOne<{ result: string; args: string }>(
        `select pg_get_function_result(p.oid) as result,
                pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'validate_loan_for_approval'`,
      );

      expect(shape.result).toBe('TABLE(failure_code text, detail text)');
      expect(shape.args).toBe('p_loan_id uuid');
    });
  });

  // =========================================================================
  // 20261106000200 — consent-attempt exhaustion
  // =========================================================================
  describe('redeem_membership_consent_code', () => {
    /** A pending membership with a live consent challenge issued to it. */
    async function issueChallenge(): Promise<{
      challengeId: string;
      code: string;
      membershipId: string;
    }> {
      const client = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district,
            status)
         values ('Consent Member', 'female', '1992-03-04',
                 '+256' || pg_catalog.lpad(
                   (pg_catalog.floor(pg_catalog.random() * 1000000000))::bigint::text,
                   9, '7'),
                 'Trader', 'Kalerwe', 'Kampala', 'active')
         returning id`,
      );
      const membership = await queryOne<{ id: string }>(
        `insert into public.memberships (client_id, applied_on)
         values ($1, public.business_date()) returning id`,
        [client.id],
      );
      const challenge = await queryOne<{ challenge_id: string; code: string }>(
        `select challenge_id, code
           from public.issue_membership_consent_code(
                  $1, (select policy_version_id from public.memberships where id = $1))`,
        [membership.id],
      );
      return {
        challengeId: challenge.challenge_id,
        code: challenge.code,
        membershipId: membership.id,
      };
    }

    async function attemptsOn(challengeId: string): Promise<number> {
      const row = await queryOne<{ attempts: number }>(
        `select attempts from public.membership_consent_challenges where id = $1`,
        [challengeId],
      );
      return Number(row.attempts);
    }

    it('refuses a borrower, and spends none of the member’s attempts', async () => {
      const { challengeId } = await issueChallenge();
      const before = await attemptsOn(challengeId);

      const denied = await asUser(
        users.client!,
        'select public.redeem_membership_consent_code($1, $2)',
        [challengeId, '000000'],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');

      // The point of the fix: an unauthorized caller must not be able to burn
      // the five attempts the member needs.
      expect(await attemptsOn(challengeId)).toBe(before);
    });

    it('cannot be used by a borrower to exhaust the cap', async () => {
      const { challengeId } = await issueChallenge();

      for (let i = 0; i < 6; i += 1) {
        const denied = await asUser(
          users.client!,
          'select public.redeem_membership_consent_code($1, $2)',
          [challengeId, '000000'],
        );
        expect(denied.ok).toBe(false);
        expect(denied.code).toBe('42501');
      }

      expect(await attemptsOn(challengeId)).toBe(0);
    });

    it('refuses before revealing whether the challenge exists', async () => {
      const denied = await asUser(
        users.client!,
        'select public.redeem_membership_consent_code($1, $2)',
        ['00000000-0000-0000-0000-000000000000', '000000'],
      );

      // The same authorization refusal a real challenge id gets, so the id is
      // not an oracle.
      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    for (const role of ['owner_admin', 'manager']) {
      it(`still lets ${role}, who may issue a code, redeem one`, async () => {
        const { challengeId, code } = await issueChallenge();

        const allowed = await asUser(
          users[role]!,
          'select public.redeem_membership_consent_code($1, $2) as id',
          [challengeId, code],
        );

        expect(allowed.ok).toBe(true);
        expect(allowed.rows[0]?.id).toBe(challengeId);
      });
    }

    it('refuses secretary_treasurer, who may not issue one either', async () => {
      // The guard mirrors issue_membership_consent_code exactly, and that role
      // holds membership:view alone. Denying the redemption of a code it
      // cannot issue is the consistent answer, not a new restriction.
      const { challengeId, code } = await issueChallenge();

      const denied = await asUser(
        users.secretary_treasurer!,
        'select public.redeem_membership_consent_code($1, $2)',
        [challengeId, code],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    it('still counts a wrong code against an authorized caller', async () => {
      const { challengeId } = await issueChallenge();

      const wrong = await asUser(
        users.manager!,
        `select public.redeem_membership_consent_code($1, '000000')`,
        [challengeId],
      );

      expect(wrong.ok).toBe(false);
      expect(wrong.message).toContain('does not match');
    });

    it('still refuses an expired code to an authorized caller', async () => {
      const { challengeId } = await issueChallenge();
      // Both timestamps move: `expires_after_issue` forbids an expiry that
      // precedes the issue.
      await query(
        `update public.membership_consent_challenges
            set issued_at  = pg_catalog.now() - interval '20 minutes',
                expires_at = pg_catalog.now() - interval '1 minute'
          where id = $1`,
        [challengeId],
      );

      const expired = await asUser(
        users.manager!,
        'select public.redeem_membership_consent_code($1, $2)',
        [challengeId, '000000'],
      );

      expect(expired.ok).toBe(false);
      expect(expired.message).toContain('expired');
    });

    it('refuses an anonymous caller', async () => {
      const { challengeId, code } = await issueChallenge();

      const denied = await asAnon(
        'select public.redeem_membership_consent_code($1, $2)',
        [challengeId, code],
      );

      expect(denied.ok).toBe(false);
    });
  });

  // =========================================================================
  // 20261106000300 — the company_identity exemption
  // =========================================================================
  describe('company_identity', () => {
    it('stays SECURITY DEFINER, because invoker mode would empty it', async () => {
      const view = await queryOne<{ reloptions: string | null }>(
        `select c.reloptions::text as reloptions
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'company_identity'`,
      );

      expect(view.reloptions).toContain('security_invoker=off');
    });

    it('is readable by a borrower, which is the reason it is a definer view', async () => {
      const read = await asUser(
        users.client!,
        'select company_name from public.company_identity',
      );

      expect(read.ok).toBe(true);
      expect(read.rowCount).toBe(1);
    });

    it('would return nothing to a borrower in invoker mode', async () => {
      // The evidence behind the exemption, kept executable rather than
      // asserted in a comment: the borrower holds no settings:view, and
      // company_settings requires it.
      const probe = await asUser(
        users.client!,
        `select (select public.user_has_permission('settings:view')) as has_cap,
                (select count(*) from public.company_settings where id = 1) as invoker_rows,
                (select count(*) from public.company_identity) as definer_rows`,
      );

      expect(probe.ok).toBe(true);
      expect(probe.rows[0]?.has_cap).toBe(false);
      expect(Number(probe.rows[0]?.invoker_rows)).toBe(0);
      expect(Number(probe.rows[0]?.definer_rows)).toBe(1);
    });

    it('exposes only the published identity, never registration or tax numbers', async () => {
      const columns = await query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'company_identity'
          order by column_name`,
      );
      const names = columns.map((c) => c.column_name);

      expect(names).toEqual([
        'address_line1',
        'address_line2',
        'brand_primary_color',
        'city',
        'company_name',
        'country',
        'currency_code',
        'locale',
        'logo_path',
        'phone',
        'phone_secondary',
        'postal_address',
        'tagline',
        'timezone',
      ]);
      for (const forbidden of ['registration_number', 'tax_identification_number']) {
        expect(names).not.toContain(forbidden);
      }
    });

    it('grants only SELECT, because a write would bypass company_settings RLS', async () => {
      // The view is auto-updatable and runs as its owner, so the grant is the
      // entire control. A stray GRANT UPDATE here would be a write path around
      // the settings:update capability.
      const grants = await query<{ privilege_type: string }>(
        `select privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and table_name = 'company_identity'
            and grantee in ('authenticated', 'anon', 'PUBLIC')
          order by privilege_type`,
      );

      expect(grants.map((g) => g.privilege_type)).toEqual(['SELECT']);
    });

    it('is not readable anonymously', async () => {
      const denied = await asAnon('select company_name from public.company_identity');

      expect(denied.ok === false || denied.rowCount === 0).toBe(true);
    });
  });

  // =========================================================================
  // 20261106000500 — the confirmed cross-member savings disclosure
  //
  // Before the migration an unrelated borrower read a member's true
  // withdrawable balance: a 750,000 deposit came back as 750,000. The amount
  // matters here, not just the refusal — a test that only asserted "throws"
  // would pass against a function that returned zero to everybody, and a test
  // that only asserted "staff can read it" would pass against one that
  // returned the wrong figure.
  // =========================================================================
  describe('savings amounts', () => {
    const DEPOSIT = 750_000;
    let savingsAccountId: string;

    beforeAll(async () => {
      const member = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district,
            status)
         values ('Savings Disclosure Member', 'female', '1991-02-03',
                 '+256700777001', 'Trader', 'Kalerwe', 'Kampala', 'active')
         returning id`,
      );
      const membership = await queryOne<{ id: string; branch_id: string }>(
        `insert into public.memberships (client_id, applied_on)
         values ($1, public.business_date()) returning id, branch_id`,
        [member.id],
      );
      const account = await queryOne<{ id: string }>(
        `insert into public.savings_accounts (membership_id) values ($1) returning id`,
        [membership.id],
      );
      // Written as the owner. The transaction number is assigned by a trigger,
      // which refuses a caller-supplied one.
      await query(
        `insert into public.savings_transactions
           (savings_account_id, membership_id, client_id, branch_id, kind, amount,
            payment_method, idempotency_key, value_date)
         values ($1, $2, $3, $4, 'deposit', $5, 'cash', gen_random_uuid(),
                 public.business_date())`,
        [account.id, membership.id, member.id, membership.branch_id, DEPOSIT],
      );
      savingsAccountId = account.id;
    });

    it('refuses an unrelated borrower the withdrawable amount', async () => {
      const denied = await asUser(
        users.client!,
        'select public.savings_withdrawable_amount($1, public.business_date()) as amount',
        [savingsAccountId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    it('refuses an unrelated borrower the pledged amount', async () => {
      const denied = await asUser(
        users.client!,
        'select public.savings_pledged_amount($1, public.business_date()) as amount',
        [savingsAccountId],
      );

      expect(denied.ok).toBe(false);
      expect(denied.code).toBe('42501');
    });

    for (const role of ['owner_admin', 'manager', 'secretary_treasurer']) {
      it(`gives ${role} the correct withdrawable figure, not merely access`, async () => {
        const allowed = await asUser(
          users[role]!,
          'select public.savings_withdrawable_amount($1, public.business_date()) as amount',
          [savingsAccountId],
        );

        expect(allowed.ok, allowed.message).toBe(true);
        expect(Number(allowed.rows[0]?.amount)).toBe(DEPOSIT);
      });
    }

    it('still answers the trusted no-JWT maintenance path', async () => {
      const asOwner = await queryOne<{ amount: string }>(
        'select public.savings_withdrawable_amount($1, public.business_date()) as amount',
        [savingsAccountId],
      );

      expect(Number(asOwner.amount)).toBe(DEPOSIT);
    });

    it('keeps the withdrawal arithmetic off the Data API', async () => {
      const rows = await query<{
        proname: string;
        authenticated: boolean;
        service_role: boolean;
      }>(
        `select p.proname,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
                has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('savings_withdrawable_amount_internal',
                              'savings_pledged_amount_internal',
                              'require_savings_account_access')
          order by p.proname`,
      );

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.authenticated, `${row.proname} is reachable by authenticated`).toBe(
          false,
        );
        expect(row.service_role, `${row.proname} lost its service_role grant`).toBe(true);
      }
    });

    it('refuses a borrower calling the internal names directly', async () => {
      for (const name of [
        'savings_withdrawable_amount_internal',
        'savings_pledged_amount_internal',
      ]) {
        const denied = await asUser(
          users.client!,
          `select public.${name}($1, public.business_date())`,
          [savingsAccountId],
        );

        expect(denied.ok, `${name} answered a borrower`).toBe(false);
        expect(denied.code).toBe('42501');
      }
    });

    it('leaves the arithmetic behind the internal names', async () => {
      const rows = await query<{ proname: string; holds_arithmetic: boolean }>(
        `select p.proname,
                (pg_get_functiondef(p.oid) ~ 'savings_withdrawal_with_active_loan')
                  as holds_arithmetic
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like 'savings_withdrawable_amount%'
          order by p.proname`,
      );

      expect(
        rows.find((r) => r.proname === 'savings_withdrawable_amount')?.holds_arithmetic,
        'the public wrapper must hold no withdrawal arithmetic',
      ).toBe(false);
      expect(
        rows.find((r) => r.proname === 'savings_withdrawable_amount_internal')
          ?.holds_arithmetic,
        'the internal function must still hold the withdrawal arithmetic',
      ).toBe(true);
    });
  });
});
