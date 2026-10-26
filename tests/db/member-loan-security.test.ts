import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asServiceRole,
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
import {
  closeMemberLoanProduct,
  depositOn,
  enrolMember,
  forcePolicyStatus,
  openMemberLoanProduct,
  publishTestPolicy,
} from '../helpers/membership';
import {
  createLoanScenario,
  createMemberLoanDraft,
  submitLoan,
  tryApproveLoan,
  tryApproveSubmittedLoan,
} from '../helpers/loan-fixtures';

/**
 * Member lending, attacked.
 *
 * ## What a forged request would try
 *
 * The member-loan application form carries a requested amount, a term, a
 * cadence and — in any implementation that trusted its client — an eligibility
 * verdict and a membership id. Each of those is a thing an attacker would
 * change, so each is attacked here against the database directly rather than
 * through a screen:
 *
 *   * a **forged eligibility verdict**: there is no such parameter. Approval
 *     re-derives the assessment from the loan's own figures, so there is
 *     nothing to forge;
 *   * a **modified amount**: changed after submission, which the terms freeze
 *     refuses, and changed before it, which the ceiling catches at approval;
 *   * a **manipulated savings balance**: the subledger refuses UPDATE and
 *     DELETE to everybody, so the ceiling's input cannot be moved;
 *   * a **wrong membership id**: `loans.membership_id` is written only by
 *     approval and frozen, and a session has no UPDATE path to it that the
 *     guard permits;
 *   * a **suspended account**: refused, and refused again when the suspension
 *     lands between submission and approval;
 *   * an **unauthorised approver**: `loans:approve` is still the gate, and
 *     holding the member-loan capabilities grants nothing towards it;
 *   * **direct function execution**: the authoritative assessment is revoked
 *     from every application role, so there is no path to a ceiling for an
 *     arbitrary client id;
 *   * the **privileged service path**: every rule above binds `service_role`
 *     too, because a rule that only stops a session is one a leaked secret key
 *     walks through.
 *
 * ## Cross-member disclosure
 *
 * A member in the portal must never read another member's eligibility, loans
 * or pledges. The self-clauses grant exactly one row, keyed on
 * `clients.profile_id`, and that is asserted by id rather than by count.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('member loan security suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Member {
  clientId: string;
  membershipId: string;
  savingsAccountId: string;
  loanId: string;
  actors: { secretary: TestUser; manager: TestUser; owner: TestUser };
}

let policyId: string;
let witnessProfileId: string;
let memberA: Member;
let memberB: Member;
let borrowerA: TestUser;
let borrowerB: TestUser;

async function approvedMemberLoan(): Promise<Member> {
  const scenario = await createLoanScenario();
  const { membershipId, savingsAccountId } = await enrolMember(
    scenario.clientId,
    witnessProfileId,
  );

  if (savingsAccountId === null) throw new Error('expected a savings account');

  const today = await queryOne<{ d: string }>(`select public.business_date()::text as d`);

  for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
    const on = await queryOne<{ d: string }>(
      `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
      [today.d, monthsBack],
    );
    await depositOn(savingsAccountId, 200_000, { on: on.d });
  }

  const loanId = await createMemberLoanDraft(scenario.clientId, {
    principal: 400_000,
    termMonths: 2,
  });

  const refusal = await tryApproveLoan(loanId, scenario);
  if (refusal !== null) throw new Error(`fixture could not approve: ${refusal}`);

  return {
    clientId: scenario.clientId,
    membershipId,
    savingsAccountId,
    loanId,
    actors: scenario,
  };
}

describeDb('member loan security', () => {
  beforeAll(async () => {
    const witness = await queryOne<{ id: string }>(
      `insert into public.profiles (full_name, phone, status)
       values ('Security Witness', '+256700034999', 'active')
       returning id`,
    );
    witnessProfileId = witness.id;

    policyId = await publishTestPolicy({
      version: '340.1',
      effectiveDaysAgo: 540,
      qualifyingMonthsConsecutive: false,
      withdrawalRule: 'allowed',
      interestBasis: 'per_month',
      interestMethod: 'reducing_balance_monthly',
      savingsToLoanMultiplierBps: 20_000,
    });
    await openMemberLoanProduct();

    memberA = await approvedMemberLoan();
    memberB = await approvedMemberLoan();

    borrowerA = await createTestUser('client');
    borrowerB = await createTestUser('client');
    // `link_client_profile` is service_role only, which is itself part of what
    // keeps a borrower's login tied to exactly one client record.
    await query(`select public.link_client_profile($1, $2)`, [
      memberA.clientId,
      borrowerA.profileId,
    ]);
    await query(`select public.link_client_profile($1, $2)`, [
      memberB.clientId,
      borrowerB.profileId,
    ]);
  });

  afterAll(async () => {
    await closeMemberLoanProduct();
    await forcePolicyStatus(policyId, 'superseded');
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('a forged request', () => {
    it('offers no eligibility verdict to forge', async () => {
      // The strongest form of this control is that the parameter does not
      // exist. `approve_loan` takes a loan id and nothing else, and derives
      // the assessment from the loan's own figures — so an attacker who could
      // supply a verdict has nowhere to put it.
      const args = await queryOne<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'approve_loan'`,
      );

      expect(args.args).toBe('p_loan_id uuid');
    });

    it('refuses an amount changed after submission, for service_role too', async () => {
      const scenario = await createLoanScenario();
      await enrolMember(scenario.clientId, witnessProfileId);

      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await submitLoan(loanId, scenario);

      // As the privileged service path, which is the one that matters: the
      // terms freeze sits above the trusted-path exemption.
      const service = await asServiceRole(
        `update public.loans set principal_amount = 10000000 where id = $1`,
        [loanId],
      );

      expect(service.ok).toBe(false);
      expect(service.message).toMatch(/cannot be changed after it leaves draft/i);

      // And as the table owner, which is stronger still.
      const owner = await expectError(
        `update public.loans set principal_amount = 10000000 where id = $1`,
        [loanId],
      );
      expect(owner?.message).toMatch(/cannot be changed after it leaves draft/i);
    });

    it('catches an amount raised while still a draft, at approval', async () => {
      const scenario = await createLoanScenario();
      const { savingsAccountId } = await enrolMember(scenario.clientId, witnessProfileId);

      if (savingsAccountId === null) throw new Error('expected a savings account');

      const today = await queryOne<{ d: string }>(
        `select public.business_date()::text as d`,
      );
      for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
        const on = await queryOne<{ d: string }>(
          `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
          [today.d, monthsBack],
        );
        await depositOn(savingsAccountId, 60_000, { on: on.d });
      }

      // 360,000 saved, so a 720,000 ceiling. A draft raised to 5,000,000
      // before submission is the realistic attack, and it is caught by the
      // ceiling at approval rather than by the form.
      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 5_000_000,
        termMonths: 2,
      });

      expect(await tryApproveLoan(loanId, scenario)).toMatch(
        /member_amount_above_ceiling/,
      );
    });

    it('refuses to manipulate the savings balance the ceiling is computed from', async () => {
      // The ceiling's only input is the subledger, which refuses UPDATE and
      // DELETE to everybody — so there is no way to inflate it short of
      // depositing real money, which is the point.
      const updated = await expectError(
        `update public.savings_transactions set amount = 99999999
          where savings_account_id = $1`,
        [memberA.savingsAccountId],
      );
      expect(updated?.message).toMatch(/append-only|not permitted/i);

      const service = await asServiceRole(
        `update public.savings_transactions set amount = 99999999
          where savings_account_id = $1`,
        [memberA.savingsAccountId],
      );
      expect(service.ok).toBe(false);

      // And no session holds INSERT either, so a forged deposit row is not a
      // path even without the triggers.
      const inserted = await asUser(
        memberA.actors.owner,
        `insert into public.savings_transactions
           (savings_account_id, membership_id, client_id, branch_id, kind, amount,
            signed_amount, value_date)
         values ($1, $2, $3,
                 (select branch_id from public.savings_accounts where id = $1),
                 'deposit', 99999999, 99999999, public.business_date())`,
        [memberA.savingsAccountId, memberA.membershipId, memberA.clientId],
      );
      expect(inserted.ok).toBe(false);
    });

    it('refuses to point an approved loan at another member', async () => {
      const service = await asServiceRole(
        `update public.loans set membership_id = $2 where id = $1`,
        [memberA.loanId, memberB.membershipId],
      );

      expect(service.ok).toBe(false);
      expect(service.message).toMatch(/set at approval and cannot be changed/i);
    });

    it('refuses to forge an eligibility snapshot or a pledge', async () => {
      // No session holds INSERT on either table, by any role.
      for (const user of [
        memberA.actors.owner,
        memberA.actors.manager,
        memberA.actors.secretary,
        borrowerA,
      ]) {
        const snapshot = await asUser(
          user,
          `insert into public.member_loan_eligibility_snapshots
             (loan_id, membership_id, membership_number, client_id,
              policy_version_id, policy_version, savings_account_id,
              savings_account_number, assessed_on, months_required,
              must_be_consecutive, qualifying_months,
              consecutive_qualifying_months, eligible_savings, multiplier_bps,
              max_eligible_loan, interest_rate_bps, interest_basis,
              interest_method, max_term_months, required_cadence,
              amount_requested, term_requested, repayment_frequency,
              active_loan_count, outstanding_principal, pledged_savings_before,
              pending_withdrawals_before, available_savings)
           values (gen_random_uuid(), $1, 'MB000000', $2, $3, 'forged', $4,
                   'SA000000', public.business_date(), 6, false, 6, 6,
                   999999999, 999999, 999999999, 0, 'per_month', 'flat', 5,
                   'weekly', 999999999, 1, 'weekly', 0, 0, 0, 0, 999999999)`,
          [memberA.membershipId, memberA.clientId, policyId, memberA.savingsAccountId],
        );

        expect(snapshot.ok, `${user.role} snapshot`).toBe(false);

        const pledge = await asUser(
          user,
          `insert into public.member_loan_savings_pledges
             (loan_id, savings_account_id, membership_id, client_id,
              policy_version_id, pledged_amount, loan_principal, multiplier_bps,
              eligible_savings_at_pledge)
           values (gen_random_uuid(), $1, $2, $3, $4, 1, 1, 10000, 0)`,
          [memberA.savingsAccountId, memberA.membershipId, memberA.clientId, policyId],
        );

        expect(pledge.ok, `${user.role} pledge`).toBe(false);
      }
    });

    it('cannot store a snapshot recording an approval above the ceiling, even as the owner', async () => {
      // The constraints restate the rules, so the row is evidence rather than
      // a claim: a snapshot saying the business lent more than the ceiling
      // supported cannot exist by any route at all.
      const error = await expectError(
        `insert into public.member_loan_eligibility_snapshots
           (loan_id, membership_id, membership_number, client_id,
            policy_version_id, policy_version, savings_account_id,
            savings_account_number, assessed_on, months_required,
            must_be_consecutive, qualifying_months, consecutive_qualifying_months,
            eligible_savings, multiplier_bps, max_eligible_loan,
            interest_rate_bps, interest_basis, interest_method, max_term_months,
            required_cadence, amount_requested, term_requested,
            repayment_frequency, active_loan_count, outstanding_principal,
            pledged_savings_before, pending_withdrawals_before, available_savings)
         values ($5, $1, 'MB000001', $2, $3, 'impossible', $4, 'SA000001',
                 public.business_date(), 6, false, 6, 6,
                 100000, 20000, 200000,
                 500, 'per_month', 'flat', 5, 'weekly',
                 999999999, 2, 'weekly', 0, 0, 0, 0, 100000)`,
        [
          memberA.membershipId,
          memberA.clientId,
          policyId,
          memberA.savingsAccountId,
          memberB.loanId,
        ],
      );

      expect(error?.message).toMatch(/within_ceiling/i);
    });

    it('cannot store a snapshot recording an unqualified member', async () => {
      const error = await expectError(
        `insert into public.member_loan_eligibility_snapshots
           (loan_id, membership_id, membership_number, client_id,
            policy_version_id, policy_version, savings_account_id,
            savings_account_number, assessed_on, months_required,
            must_be_consecutive, qualifying_months, consecutive_qualifying_months,
            eligible_savings, multiplier_bps, max_eligible_loan,
            interest_rate_bps, interest_basis, interest_method, max_term_months,
            required_cadence, amount_requested, term_requested,
            repayment_frequency, active_loan_count, outstanding_principal,
            pledged_savings_before, pending_withdrawals_before, available_savings)
         values ($5, $1, 'MB000002', $2, $3, 'impossible', $4, 'SA000002',
                 public.business_date(), 6, false, 2, 2,
                 100000, 20000, 200000,
                 500, 'per_month', 'flat', 5, 'weekly',
                 100000, 2, 'weekly', 0, 0, 0, 0, 100000)`,
        [
          memberA.membershipId,
          memberA.clientId,
          policyId,
          memberA.savingsAccountId,
          memberB.loanId,
        ],
      );

      expect(error?.message).toMatch(/snapshots_qualified/i);
    });

    it('cannot store a pledge whose figure does not follow from its own inputs', async () => {
      const error = await expectError(
        `insert into public.member_loan_savings_pledges
           (loan_id, savings_account_id, membership_id, client_id,
            policy_version_id, pledged_amount, loan_principal, multiplier_bps,
            eligible_savings_at_pledge)
         values ($5, $1, $2, $3, $4, 1, 400000, 20000, 1200000)`,
        [
          memberA.savingsAccountId,
          memberA.membershipId,
          memberA.clientId,
          policyId,
          memberB.loanId,
        ],
      );

      expect(error?.message).toMatch(/amount_follows/i);
    });
  });

  // =========================================================================
  describe('who may approve', () => {
    it('refuses an approval from a role that does not hold loans:approve', async () => {
      const scenario = await createLoanScenario();
      const { savingsAccountId } = await enrolMember(scenario.clientId, witnessProfileId);

      if (savingsAccountId === null) throw new Error('expected a savings account');

      const today = await queryOne<{ d: string }>(
        `select public.business_date()::text as d`,
      );
      for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
        const on = await queryOne<{ d: string }>(
          `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
          [today.d, monthsBack],
        );
        await depositOn(savingsAccountId, 200_000, { on: on.d });
      }

      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await submitLoan(loanId, scenario);

      // The Secretary/Treasurer holds `member_loans:view_eligibility`, which
      // grants nothing towards approving a loan. This is the assertion that
      // the new capability is not a back door.
      const attempt = await asUser(scenario.secretary, `select public.approve_loan($1)`, [
        loanId,
      ]);

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/loans:approve capability/i);
    });

    it('refuses an approval from a borrower, who holds no lending capability at all', async () => {
      const attempt = await asUser(borrowerA, `select public.approve_loan($1)`, [
        memberB.loanId,
      ]);

      expect(attempt.ok).toBe(false);
    });

    it('refuses an approval whose membership was suspended between submission and decision', async () => {
      const scenario = await createLoanScenario();
      const { membershipId, savingsAccountId } = await enrolMember(
        scenario.clientId,
        witnessProfileId,
      );

      if (savingsAccountId === null) throw new Error('expected a savings account');

      const today = await queryOne<{ d: string }>(
        `select public.business_date()::text as d`,
      );
      for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
        const on = await queryOne<{ d: string }>(
          `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
          [today.d, monthsBack],
        );
        await depositOn(savingsAccountId, 200_000, { on: on.d });
      }

      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await submitLoan(loanId, scenario);

      await query(
        `update public.memberships
            set status = 'suspended', status_reason = 'Suspended after submission'
          where id = $1`,
        [membershipId],
      );

      // This is the race the re-check exists to lose safely: the business
      // decides on what is true when it decides, not on what was true when
      // the application was taken.
      expect(await tryApproveSubmittedLoan(loanId, scenario)).toMatch(
        /member_not_active/,
      );
    });
  });

  // =========================================================================
  describe('cross-member disclosure', () => {
    it('shows a member their own eligibility snapshot and no other', async () => {
      const result = await asUser(
        borrowerA,
        `select loan_id::text as loan_id
           from public.member_loan_eligibility_snapshots order by loan_id`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows.map((row) => row.loan_id)).toEqual([memberA.loanId]);
    });

    it('shows a member their own pledge and no other', async () => {
      const result = await asUser(
        borrowerB,
        `select loan_id::text as loan_id
           from public.member_loan_savings_pledges order by loan_id`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows.map((row) => row.loan_id)).toEqual([memberB.loanId]);
    });

    it('shows a member their own row in the member loan register and no other', async () => {
      const result = await asUser(
        borrowerA,
        `select loan_id::text as loan_id from public.member_loan_register`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows.map((row) => row.loan_id)).toEqual([memberA.loanId]);
    });

    it('shows a member nothing in the eligibility register, which is staff-only', async () => {
      // The register carries a ceiling for every live membership, which is a
      // lending offer. A member sees their own membership through
      // `memberships`, and the ceiling is not published to them.
      const result = await asUser(
        borrowerA,
        `select count(*)::int as n from public.member_loan_eligibility`,
      );

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.n).toBe(0);
    });

    it('refuses a member an assessment of anybody, including themselves', async () => {
      for (const [label, clientId] of [
        ['their own', memberA.clientId],
        ["another member's", memberB.clientId],
      ] as const) {
        const result = await asUser(
          borrowerA,
          `select * from public.assess_member_loan_eligibility($1)`,
          [clientId],
        );

        expect(result.ok, label).toBe(false);
        expect(result.message, label).toMatch(/member_loans:view_eligibility/i);
      }
    });

    it('shows a suspended staff account nothing, because the profile is not active', async () => {
      const manager = await createTestUser('manager');

      await query(`update public.profiles set status = 'suspended' where id = $1`, [
        manager.profileId,
      ]);

      const result = await asUser(
        manager,
        `select count(*)::int as n from public.member_loan_eligibility`,
      );

      // `user_has_permission` resolves only active profiles, which is what
      // makes suspending an account take effect on the next request.
      expect(result.ok).toBe(true);
      expect(result.rows[0]?.n).toBe(0);
    });
  });

  // =========================================================================
  describe('direct function execution', () => {
    it('gives no role a path to the authoritative assessment', async () => {
      for (const user of [
        memberA.actors.owner,
        memberA.actors.manager,
        memberA.actors.secretary,
        borrowerA,
      ]) {
        const result = await asUser(
          user,
          `select * from public.member_loan_eligibility_of($1)`,
          [memberB.clientId],
        );

        expect(result.ok, user.role).toBe(false);
        expect(result.message, user.role).toMatch(/permission denied/i);
      }
    });

    it('gives no role a path to the savings-capacity lock', async () => {
      for (const user of [memberA.actors.owner, borrowerA]) {
        const result = await asUser(user, `select public.lock_savings_capacity($1)`, [
          memberA.savingsAccountId,
        ]);

        expect(result.ok, user.role).toBe(false);
        expect(result.message, user.role).toMatch(/permission denied/i);
      }
    });

    it('gives no role a path to the schedule generator', async () => {
      // Unchanged from Phase 5, and re-asserted because Phase 3 rewrote the
      // function: a `create or replace` that dropped the revoke would hand
      // every signed-in caller the ability to write a collection plan.
      const result = await asUser(
        memberA.actors.owner,
        `select public.generate_loan_schedule($1)`,
        [memberA.loanId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/permission denied/i);
    });
  });

  // =========================================================================
  describe('the privileged service path', () => {
    it('refuses service_role an approval that fails eligibility', async () => {
      const scenario = await createLoanScenario();
      await enrolMember(scenario.clientId, witnessProfileId);

      // No deposits at all, so no qualifying months.
      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await submitLoan(loanId, scenario);

      const service = await asServiceRole(`select public.approve_loan($1)`, [loanId]);

      expect(service.ok).toBe(false);
      expect(service.message).toMatch(/member_not_qualified/);
    });

    it('refuses service_role an approval above the ceiling', async () => {
      const scenario = await createLoanScenario();
      const { savingsAccountId } = await enrolMember(scenario.clientId, witnessProfileId);

      if (savingsAccountId === null) throw new Error('expected a savings account');

      const today = await queryOne<{ d: string }>(
        `select public.business_date()::text as d`,
      );
      for (const monthsBack of [6, 5, 4, 3, 2, 1]) {
        const on = await queryOne<{ d: string }>(
          `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
          [today.d, monthsBack],
        );
        await depositOn(savingsAccountId, 60_000, { on: on.d });
      }

      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 5_000_000,
        termMonths: 2,
      });
      await submitLoan(loanId, scenario);

      const service = await asServiceRole(`select public.approve_loan($1)`, [loanId]);

      expect(service.ok).toBe(false);
      expect(service.message).toMatch(/member_amount_above_ceiling/);
    });

    it('refuses service_role the frozen member terms on an approved loan', async () => {
      const basis = await asServiceRole(
        `update public.loans set interest_basis = 'per_loan' where id = $1`,
        [memberA.loanId],
      );
      expect(basis.ok).toBe(false);

      const pledge = await asServiceRole(
        `update public.member_loan_savings_pledges set pledged_amount = 1
          where loan_id = $1`,
        [memberA.loanId],
      );
      expect(pledge.ok).toBe(false);

      const snapshot = await asServiceRole(
        `update public.member_loan_eligibility_snapshots set max_eligible_loan = 99999999
          where loan_id = $1`,
        [memberA.loanId],
      );
      expect(snapshot.ok).toBe(false);
    });

    it('refuses service_role a redefinition of what a cadence means', async () => {
      const kind = await asServiceRole(
        `update public.repayment_frequencies set cadence_kind = 'calendar_month'
          where key = 'weekly'`,
      );
      expect(kind.ok).toBe(false);

      const interval = await asServiceRole(
        `update public.repayment_frequencies set interval_days = 1 where key = 'weekly'`,
      );
      expect(interval.ok).toBe(false);
    });
  });
});
