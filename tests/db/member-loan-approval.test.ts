import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers, type TestUser } from '../helpers/auth-fixtures';
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
  openMonthlyCadence,
  publishTestPolicy,
  resetMonthlyCadence,
} from '../helpers/membership';
import {
  createDraftLoan,
  createLoanScenario,
  createMemberLoanDraft,
  disburseApprovedLoan,
  cancelLoan,
  submitLoan,
  tryApproveLoan,
  tryApproveSubmittedLoan,
} from '../helpers/loan-fixtures';

/**
 * Member loan approval, and the interest engine behind the price.
 *
 * ## What these are really testing
 *
 * A form can be defeated by a POST. The only control that holds against a
 * forged request, a leaked key, a mistaken UPDATE and `psql` is the one inside
 * the function that writes the approval, so every rule here is attacked
 * through `approve_loan` itself rather than through a screen.
 *
 * Three properties carry most of the weight:
 *
 *   1. **An unqualified member is refused at approval.** Not hidden in a form,
 *      not warned about — refused, with the failure code naming which rule
 *      fired.
 *
 *   2. **Ordinary loans are untouched.** Every assertion about the member path
 *      is paired with the same assertion about an Individual Loan, because the
 *      one thing Phase 3 must not do is change what an existing product
 *      charges. The strongest version of this is structural: for a per-month
 *      reducing-balance policy, `member_loan_interest` *delegates* to
 *      `calculate_loan_breakdown`, so the two cannot disagree.
 *
 *   3. **Nothing is priced under an undecided policy.** With the basis, the
 *      method or the multiplier open, approval is refused — and the refusal
 *      names the decision rather than saying "not eligible".
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('member loan approval suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  witnessProfileId: string;
}

let fx: Fixtures;

/** A member with six qualifying months and a guarantor complete enough to approve. */
async function qualifiedMember(options?: {
  readonly deposit?: number;
  readonly months?: readonly number[];
}): Promise<{
  clientId: string;
  membershipId: string;
  savingsAccountId: string;
  actors: { secretary: TestUser; manager: TestUser; owner: TestUser };
}> {
  const scenario = await createLoanScenario();

  const { membershipId, savingsAccountId } = await enrolMember(
    scenario.clientId,
    fx.witnessProfileId,
  );

  if (savingsAccountId === null) throw new Error('expected a savings account');

  const today = await queryOne<{ d: string }>(`select public.business_date()::text as d`);

  for (const monthsBack of options?.months ?? [6, 5, 4, 3, 2, 1]) {
    const on = await queryOne<{ d: string }>(
      `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
      [today.d, monthsBack],
    );
    await depositOn(savingsAccountId, options?.deposit ?? 200_000, { on: on.d });
  }

  return {
    clientId: scenario.clientId,
    membershipId,
    savingsAccountId,
    actors: {
      secretary: scenario.secretary,
      manager: scenario.manager,
      owner: scenario.owner,
    },
  };
}

describeDb('member loan approval', () => {
  beforeAll(async () => {
    const witness = await queryOne<{ id: string }>(
      `insert into public.profiles (full_name, phone, status)
       values ('Approval Witness', '+256700032999', 'active')
       returning id`,
    );
    fx = { witnessProfileId: witness.id };
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('while the lending decisions are open', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '320.1',
        effectiveDaysAgo: 520,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        // The three lending questions deliberately unanswered.
      });
      await openMemberLoanProduct();
    });

    afterAll(async () => {
      await closeMemberLoanProduct();
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('refuses a member loan to a fully qualified member, naming the decisions', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      const refusal = await tryApproveLoan(loanId, member.actors);

      expect(refusal).not.toBeNull();
      expect(refusal).toMatch(/member_policy_not_open/);
      // And the ceiling check fires too: a ceiling that cannot be computed can
      // never be satisfied, so the comparison must not pass for want of
      // something to compare.
      expect(refusal).toMatch(/member_amount_above_ceiling/);
    });

    it('leaves the loan awaiting approval rather than half-approved', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      await tryApproveLoan(loanId, member.actors);

      const loan = await queryOne<{
        status: string;
        membership_id: string | null;
        interest_basis: string | null;
        total_interest: string | null;
      }>(
        `select status, membership_id, interest_basis, total_interest::text as total_interest
           from public.loans where id = $1`,
        [loanId],
      );

      expect(loan.status).toBe('pending_approval');
      expect(loan.membership_id).toBeNull();
      expect(loan.interest_basis).toBeNull();
      expect(Number(loan.total_interest)).toBe(0);

      // Nothing was frozen, nothing was pledged, no breakdown was written.
      for (const table of [
        'loan_periods',
        'member_loan_eligibility_snapshots',
        'member_loan_savings_pledges',
      ]) {
        const rows = await query<{ n: number }>(
          `select count(*)::int as n from public.${table} where loan_id = $1`,
          [loanId],
        );
        expect(rows[0]?.n, table).toBe(0);
      }
    });

    it('approves an ordinary loan for the same client, unaffected', async () => {
      // The member path is shut and the ordinary path is not. A client may
      // hold ordinary loans without membership, and being a member must not
      // take that away.
      const member = await qualifiedMember();
      const loanId = await createDraftLoan(member.clientId, {
        principal: 600_000,
        termMonths: 3,
        frequency: 'daily',
      });

      const refusal = await tryApproveLoan(loanId, member.actors);

      expect(refusal).toBeNull();

      const loan = await queryOne<{
        status: string;
        interest_rate_bps: number;
        interest_method: string;
        interest_basis: string | null;
        membership_id: string | null;
        total_interest: string;
      }>(
        `select status, interest_rate_bps, interest_method, interest_basis,
                membership_id, total_interest::text as total_interest
           from public.loans where id = $1`,
        [loanId],
      );

      expect(loan.status).toBe('approved');
      expect(loan.interest_rate_bps).toBe(1500);
      expect(loan.interest_method).toBe('reducing_balance_monthly');
      // Neither member column is filled in. A client joining the programme
      // does not convert an ordinary loan, and approval does not pretend it
      // did.
      expect(loan.interest_basis).toBeNull();
      expect(loan.membership_id).toBeNull();

      // 600,000 over 3 months at 15%: 30,000 + 20,000 + 10,000... on the
      // reducing-balance rule, 90,000 + 60,000 + 30,000.
      expect(Number(loan.total_interest)).toBe(180_000);
    });
  });

  // =========================================================================
  describe('under a TEST ONLY policy with every decision made', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '320.2',
        effectiveDaysAgo: 521,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'reducing_balance_monthly',
        savingsToLoanMultiplierBps: 20_000,
      });
      await openMemberLoanProduct();
    });

    afterAll(async () => {
      await closeMemberLoanProduct();
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('approves a qualified member and prices from their own policy version', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      expect(await tryApproveLoan(loanId, member.actors)).toBeNull();

      const loan = await queryOne<{
        status: string;
        interest_rate_bps: number;
        interest_method: string;
        interest_basis: string;
        membership_id: string;
        total_interest: string;
        total_expected_repayment: string;
      }>(
        `select status, interest_rate_bps, interest_method, interest_basis,
                membership_id, total_interest::text as total_interest,
                total_expected_repayment::text as total_expected_repayment
           from public.loans where id = $1`,
        [loanId],
      );

      expect(loan.status).toBe('approved');
      // 500 bp, from the policy — not the product's band, and not a figure the
      // application proposed.
      expect(loan.interest_rate_bps).toBe(500);
      expect(loan.interest_method).toBe('reducing_balance_monthly');
      expect(loan.interest_basis).toBe('per_month');
      expect(loan.membership_id).toBe(member.membershipId);

      // 5% per month, reducing balance, 400,000 over two months:
      // 20,000 on 400,000 then 10,000 on 200,000.
      expect(Number(loan.total_interest)).toBe(30_000);
      expect(Number(loan.total_expected_repayment)).toBe(430_000);
    });

    it('produces the same figures as an ordinary loan at the same rate, because it is the same function', async () => {
      // The structural claim, asserted: a per-month reducing-balance member
      // loan and `calculate_loan_breakdown` are one implementation.
      const rows = await query<{
        period_number: number;
        member_interest: string;
        ordinary_interest: string;
        member_principal: string;
        ordinary_principal: string;
      }>(
        `select m.period_number,
                m.interest::text as member_interest,
                o.interest::text as ordinary_interest,
                m.principal_portion::text as member_principal,
                o.principal_portion::text as ordinary_principal
           from public.member_loan_interest(
                  733333::bigint, 500, 5::smallint,
                  'per_month', 'reducing_balance_monthly') m
           join public.calculate_loan_breakdown(733333::bigint, 500, 5::smallint) o
             on o.period_number = m.period_number
          order by m.period_number`,
      );

      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.member_interest, `period ${String(row.period_number)}`).toBe(
          row.ordinary_interest,
        );
        expect(row.member_principal, `period ${String(row.period_number)}`).toBe(
          row.ordinary_principal,
        );
      }
    });

    it('freezes the eligibility assessment as evidence', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      await tryApproveLoan(loanId, member.actors);

      const snapshot = await queryOne<{
        membership_number: string;
        policy_version: string;
        savings_account_id: string;
        months_required: number;
        must_be_consecutive: boolean;
        qualifying_months: number;
        eligible_savings: string;
        multiplier_bps: number;
        max_eligible_loan: string;
        interest_rate_bps: number;
        interest_basis: string;
        interest_method: string;
        required_cadence: string;
        amount_requested: string;
        term_requested: number;
        repayment_frequency: string;
        pledged_savings_before: string;
      }>(
        `select membership_number, policy_version, savings_account_id,
                months_required, must_be_consecutive, qualifying_months,
                eligible_savings::text as eligible_savings, multiplier_bps,
                max_eligible_loan::text as max_eligible_loan,
                interest_rate_bps, interest_basis, interest_method,
                required_cadence, amount_requested::text as amount_requested,
                term_requested, repayment_frequency,
                pledged_savings_before::text as pledged_savings_before
           from public.member_loan_eligibility_snapshots where loan_id = $1`,
        [loanId],
      );

      expect(snapshot.policy_version).toBe('320.2');
      expect(snapshot.savings_account_id).toBe(member.savingsAccountId);
      expect(snapshot.months_required).toBe(6);
      expect(snapshot.must_be_consecutive).toBe(false);
      expect(snapshot.qualifying_months).toBeGreaterThanOrEqual(6);
      expect(Number(snapshot.eligible_savings)).toBe(1_200_000);
      expect(snapshot.multiplier_bps).toBe(20_000);
      expect(Number(snapshot.max_eligible_loan)).toBe(2_400_000);
      expect(snapshot.interest_rate_bps).toBe(500);
      expect(snapshot.interest_basis).toBe('per_month');
      expect(snapshot.interest_method).toBe('reducing_balance_monthly');
      expect(snapshot.required_cadence).toBe('weekly');
      expect(Number(snapshot.amount_requested)).toBe(400_000);
      expect(snapshot.term_requested).toBe(2);
      expect(snapshot.repayment_frequency).toBe('weekly');
      // Nothing was pledged before this loan.
      expect(Number(snapshot.pledged_savings_before)).toBe(0);
    });

    it('pledges the savings capacity the loan consumed, derived from the multiplier', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      await tryApproveLoan(loanId, member.actors);

      const pledge = await queryOne<{
        pledged_amount: string;
        loan_principal: string;
        multiplier_bps: number;
        released_at: string | null;
      }>(
        `select pledged_amount::text as pledged_amount,
                loan_principal::text as loan_principal,
                multiplier_bps, released_at
           from public.member_loan_savings_pledges where loan_id = $1`,
        [loanId],
      );

      // 400,000 at a 2x multiplier consumed 200,000 of savings capacity.
      expect(Number(pledge.pledged_amount)).toBe(200_000);
      expect(Number(pledge.loan_principal)).toBe(400_000);
      expect(pledge.multiplier_bps).toBe(20_000);
      expect(pledge.released_at).toBeNull();

      // And the account reports it.
      const pledged = await queryOne<{ amount: string }>(
        `select public.savings_pledged_amount($1)::text as amount`,
        [member.savingsAccountId],
      );
      expect(Number(pledged.amount)).toBe(200_000);
    });

    it('rounds the pledged capacity up, so two loans cannot over-consume by a shilling', async () => {
      // 300,001 at 3x: 100,000.33 of capacity, which must pledge 100,001.
      const row = await queryOne<{ pledged: string }>(
        `select ((300001::bigint * 10000 + 30000 - 1) / 30000)::text as pledged`,
      );
      expect(Number(row.pledged)).toBe(100_001);
    });

    it('releases the pledge when the loan stops being a live obligation', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      await tryApproveLoan(loanId, member.actors);

      expect(
        Number(
          (
            await queryOne<{ amount: string }>(
              `select public.savings_pledged_amount($1)::text as amount`,
              [member.savingsAccountId],
            )
          ).amount,
        ),
      ).toBe(200_000);

      // Cancelling an approved loan is the reachable way to stop it being a
      // live obligation without posting payments, and it goes through
      // `cancel_loan` because cancellation attribution is maintained by the
      // database — a bare UPDATE is refused, correctly.
      await cancelLoan(loanId, member.actors, 'Test release');

      const pledge = await queryOne<{
        released_at: string | null;
        reason: string | null;
      }>(
        `select released_at, released_reason as reason
           from public.member_loan_savings_pledges where loan_id = $1`,
        [loanId],
      );

      expect(pledge.released_at).not.toBeNull();
      expect(pledge.reason).toMatch(/became cancelled/i);

      // The capacity returned to the member.
      expect(
        Number(
          (
            await queryOne<{ amount: string }>(
              `select public.savings_pledged_amount($1)::text as amount`,
              [member.savingsAccountId],
            )
          ).amount,
        ),
      ).toBe(0);
    });

    it('refuses to change the frozen eligibility evidence, for every caller', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await tryApproveLoan(loanId, member.actors);

      // As the table owner, which is stronger than as a session: there is no
      // UPDATE privilege for a session at all.
      const updated = await expectError(
        `update public.member_loan_eligibility_snapshots
            set max_eligible_loan = 99999999 where loan_id = $1`,
        [loanId],
      );
      expect(updated?.message).toMatch(/append-only|cannot be/i);

      const deleted = await expectError(
        `delete from public.member_loan_eligibility_snapshots where loan_id = $1`,
        [loanId],
      );
      expect(deleted?.message).toMatch(/append-only|cannot be/i);
    });

    it('refuses to change what a loan pledged', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await tryApproveLoan(loanId, member.actors);

      const error = await expectError(
        `update public.member_loan_savings_pledges
            set pledged_amount = 1 where loan_id = $1`,
        [loanId],
      );
      expect(error?.message).toMatch(/cannot be changed/i);

      const deleted = await expectError(
        `delete from public.member_loan_savings_pledges where loan_id = $1`,
        [loanId],
      );
      expect(deleted?.message).toMatch(/released, never deleted/i);
    });

    it('refuses to change the membership or the basis a loan was approved under', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });
      await tryApproveLoan(loanId, member.actors);

      const detached = await expectError(
        `update public.loans set membership_id = null where id = $1`,
        [loanId],
      );
      expect(detached?.message).toMatch(/set at approval and cannot be changed/i);

      const repriced = await expectError(
        `update public.loans set interest_basis = 'per_loan' where id = $1`,
        [loanId],
      );
      expect(repriced?.message).toMatch(/set at approval and cannot be changed/i);
    });

    it('refuses an amount above the ceiling, at approval and not only in the form', async () => {
      const member = await qualifiedMember({ deposit: 60_000 });
      // 360,000 saved, so the ceiling is 720,000.
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 800_000,
        termMonths: 2,
      });

      const refusal = await tryApproveLoan(loanId, member.actors);

      expect(refusal).toMatch(/member_amount_above_ceiling/);
    });

    it('refuses a member who has not served the qualifying months', async () => {
      const member = await qualifiedMember({ months: [3, 2, 1] });
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      expect(await tryApproveLoan(loanId, member.actors)).toMatch(/member_not_qualified/);
    });

    it('refuses a suspended membership', async () => {
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      await submitLoan(loanId, member.actors);

      await query(
        `update public.memberships
            set status = 'suspended', status_reason = 'Suspended mid-application'
          where id = $1`,
        [member.membershipId],
      );

      expect(await tryApproveSubmittedLoan(loanId, member.actors)).toMatch(
        /member_not_active/,
      );
    });

    it('refuses a client who is not a member at all on the member product', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createMemberLoanDraft(scenario.clientId, {
        principal: 400_000,
        termMonths: 2,
      });

      expect(await tryApproveLoan(loanId, scenario)).toMatch(/member_product_not_member/);
    });

    it('refuses a rate the application proposed instead of the policy rate', async () => {
      // A member product permits no override — a CHECK constraint refuses
      // `interest_override_allowed` on one — so a proposed rate is not quietly
      // ignored, which would be a quote the business did not honour.
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 2,
        proposedRateBps: 100,
      });

      expect(await tryApproveLoan(loanId, member.actors)).toMatch(
        /priced at the 500 bp its membership policy version sets/i,
      );
    });

    it('permits a four-month member loan, which the business term ceiling would refuse', async () => {
      // The documented rules are a 5-month member maximum and a 3-month
      // non-member maximum, and `business_settings.max_loan_term_months` is
      // the latter. A member loan is held to the member rule.
      await openMonthlyCadence('clamp_to_month_end');
      const productId = await openMemberLoanProduct({
        cadences: ['weekly', 'monthly'],
      });

      try {
        expect(productId).toBeTruthy();

        const member = await qualifiedMember();
        const loanId = await createMemberLoanDraft(member.clientId, {
          principal: 400_000,
          termMonths: 4,
          frequency: 'monthly',
        });

        expect(await tryApproveLoan(loanId, member.actors)).toBeNull();

        const loan = await queryOne<{ status: string; loan_term_months: number }>(
          `select status, loan_term_months from public.loans where id = $1`,
          [loanId],
        );
        expect(loan.status).toBe('approved');
        expect(loan.loan_term_months).toBe(4);
      } finally {
        await openMemberLoanProduct();
        await resetMonthlyCadence();
      }
    });

    it('still refuses a four-month ordinary loan, because that ceiling has not moved', async () => {
      const scenario = await createLoanScenario();
      const loanId = await createDraftLoan(scenario.clientId, {
        principal: 600_000,
        termMonths: 4,
        frequency: 'daily',
      });

      expect(await tryApproveLoan(loanId, scenario)).toMatch(/term_not_permitted/);
    });

    it('refuses a three-month member loan while the monthly anchor is undecided', async () => {
      // The term needs monthly collection and monthly collection needs a
      // convention nobody has settled, so this is refused — at approval,
      // rather than at the disbursement counter with the borrower present.
      const member = await qualifiedMember();
      const loanId = await createMemberLoanDraft(member.clientId, {
        principal: 400_000,
        termMonths: 3,
        frequency: 'weekly',
      });

      expect(await tryApproveLoan(loanId, member.actors)).toMatch(
        /member_cadence_not_permitted/,
      );
    });
  });

  // =========================================================================
  describe('the interest grid', () => {
    it('charges the flat rate on the original principal every month, per month', async () => {
      const rows = await query<{ period_number: number; interest: string }>(
        `select period_number, interest::text as interest
           from public.member_loan_interest(500000::bigint, 500, 3::smallint,
                                            'per_month', 'flat')
          order by period_number`,
      );

      // 5% of 500,000 is 25,000, charged three times — not reducing.
      expect(rows.map((row) => Number(row.interest))).toEqual([25_000, 25_000, 25_000]);
    });

    it('charges the flat rate once over the loan and spreads it, per loan', async () => {
      const rows = await query<{ period_number: number; interest: string }>(
        `select period_number, interest::text as interest
           from public.member_loan_interest(500000::bigint, 500, 3::smallint,
                                            'per_loan', 'flat')
          order by period_number`,
      );

      // 25,000 over three months: 8,333 + 8,333 + 8,334, the remainder on the
      // final period.
      expect(rows.map((row) => Number(row.interest))).toEqual([8_333, 8_333, 8_334]);
      expect(rows.reduce((total, row) => total + Number(row.interest), 0)).toBe(25_000);
    });

    it('refuses per-loan on a reducing balance, naming what has to be settled', async () => {
      const error = await expectError(
        `select * from public.member_loan_interest(500000::bigint, 500, 3::smallint,
                                                  'per_loan', 'reducing_balance_monthly')`,
      );

      expect(error?.message).toMatch(/not a calculation the business has described/i);
      expect(error?.message).toMatch(/three different prices/i);
    });

    it('refuses an undecided basis or method by name', async () => {
      expect(
        (
          await expectError(
            `select * from public.member_loan_interest(500000::bigint, 500, 3::smallint,
                                                      null, 'flat')`,
          )
        )?.message,
      ).toMatch(/per month or once over the loan has not been decided/i);

      expect(
        (
          await expectError(
            `select * from public.member_loan_interest(500000::bigint, 500, 3::smallint,
                                                      'per_month', null)`,
          )
        )?.message,
      ).toMatch(/flat on the original principal or on a reducing balance/i);
    });

    it('allocates every shilling at every term and on an awkward principal', async () => {
      for (const term of [1, 2, 3, 4, 5]) {
        for (const principal of [100_001, 333_333, 1_000_000, 7_777_777]) {
          for (const [basis, method] of [
            ['per_month', 'reducing_balance_monthly'],
            ['per_month', 'flat'],
            ['per_loan', 'flat'],
          ] as const) {
            const row = await queryOne<{
              principal_sum: string;
              interest_sum: string;
              total_sum: string;
              final_closing: string;
              label: string;
            }>(
              `select coalesce(sum(principal_portion), 0)::text as principal_sum,
                      coalesce(sum(interest), 0)::text as interest_sum,
                      coalesce(sum(total_obligation), 0)::text as total_sum,
                      (array_agg(closing_principal order by period_number desc))[1]::text
                        as final_closing,
                      $1::text || '/' || $2::text || '/' || $3::text || '/' || $4::text
                        as label
                 from public.member_loan_interest($1::bigint, 500, $2::smallint, $3, $4)`,
              [principal, term, basis, method],
            );

            // The principal is fully allocated and nothing is left outstanding.
            expect(Number(row.principal_sum), row.label).toBe(principal);
            expect(Number(row.final_closing), row.label).toBe(0);
            // And the stated obligation is principal plus interest, exactly.
            expect(Number(row.total_sum), row.label).toBe(
              principal + Number(row.interest_sum),
            );
          }
        }
      }
    });

    it('rounds interest half-up rather than truncating', async () => {
      // 1 bp of 50,005 is 5.0005 — truncation gives 5, half-up gives 5.
      // 1 bp of 55,000 is 5.5 exactly, which is the boundary: half-up gives 6.
      const row = await queryOne<{ interest: string }>(
        `select interest::text as interest
           from public.member_loan_interest(55000::bigint, 1, 1::smallint,
                                            'per_loan', 'flat')`,
      );
      expect(Number(row.interest)).toBe(6);
    });
  });

  // =========================================================================
  describe('a policy change after approval', () => {
    it('does not reprice a loan already approved', async () => {
      const policyId = await publishTestPolicy({
        version: '320.3',
        effectiveDaysAgo: 522,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'reducing_balance_monthly',
        savingsToLoanMultiplierBps: 20_000,
      });
      await openMemberLoanProduct();

      try {
        const member = await qualifiedMember();
        const loanId = await createMemberLoanDraft(member.clientId, {
          principal: 400_000,
          termMonths: 2,
        });

        expect(await tryApproveLoan(loanId, member.actors)).toBeNull();
        await disburseApprovedLoan(loanId, member.actors);

        const before = await queryOne<{
          rate: number;
          basis: string;
          method: string;
          interest: string;
          expected: string;
          schedule: string;
        }>(
          `select l.interest_rate_bps as rate, l.interest_basis as basis,
                  l.interest_method as method,
                  l.total_interest::text as interest,
                  l.total_expected_repayment::text as expected,
                  pg_catalog.string_agg(
                    i.due_date::text || '/' || i.expected_amount::text,
                    ',' order by i.installment_number) as schedule
             from public.loans l
             join public.loan_installments i on i.loan_id = l.id
            where l.id = $1
            group by l.interest_rate_bps, l.interest_basis, l.interest_method,
                     l.total_interest, l.total_expected_repayment`,
          [loanId],
        );

        // The programme moves on: a new version, with a different method.
        await forcePolicyStatus(policyId, 'superseded');
        const nextPolicy = await publishTestPolicy({
          version: '320.4',
          effectiveDaysAgo: 523,
          qualifyingMonthsConsecutive: false,
          withdrawalRule: 'allowed',
          interestBasis: 'per_loan',
          interestMethod: 'flat',
          savingsToLoanMultiplierBps: 50_000,
        });

        try {
          const after = await queryOne<{
            rate: number;
            basis: string;
            method: string;
            interest: string;
            expected: string;
            schedule: string;
          }>(
            `select l.interest_rate_bps as rate, l.interest_basis as basis,
                    l.interest_method as method,
                    l.total_interest::text as interest,
                    l.total_expected_repayment::text as expected,
                    pg_catalog.string_agg(
                      i.due_date::text || '/' || i.expected_amount::text,
                      ',' order by i.installment_number) as schedule
               from public.loans l
               join public.loan_installments i on i.loan_id = l.id
              where l.id = $1
              group by l.interest_rate_bps, l.interest_basis, l.interest_method,
                       l.total_interest, l.total_expected_repayment`,
            [loanId],
          );

          // Not one figure has moved, and not one collection date.
          expect(after).toEqual(before);

          // The snapshot still names the version the business actually relied
          // on, so the agreement stays explicable after the programme changed.
          const snapshot = await queryOne<{ policy_version: string }>(
            `select policy_version from public.member_loan_eligibility_snapshots
              where loan_id = $1`,
            [loanId],
          );
          expect(snapshot.policy_version).toBe('320.3');
        } finally {
          await forcePolicyStatus(nextPolicy, 'superseded');
        }
      } finally {
        await closeMemberLoanProduct();
        await forcePolicyStatus(policyId, 'superseded').catch(() => undefined);
      }
    });
  });
});
