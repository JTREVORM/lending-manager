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
import {
  depositOn,
  enrolMember,
  forcePolicyStatus,
  publishTestPolicy,
  satisfyActivationPreconditions,
} from '../helpers/membership';

/**
 * The member loan eligibility engine.
 *
 * ## What these are really testing
 *
 * The engine answers one question — may this member borrow, and how much —
 * and the dangerous way to get it wrong is to answer it when the business has
 * not decided the rule. So two properties are attacked throughout:
 *
 *   1. **Nothing is invented.** With the savings-to-loan multiplier undecided,
 *      the ceiling is NULL and the reason names the decision. There is no
 *      default multiplier, no fallback, and no arithmetic that quietly treats
 *      a missing multiplier as 1.
 *
 *   2. **The savings base is the balance, not the deposits.** A member who
 *      saved UGX 600,000 and withdrew UGX 500,000 has UGX 100,000 securing a
 *      loan. Computing the ceiling from lifetime contributions would lend
 *      against money the business has already given back.
 *
 * And one property that is structural rather than arithmetic: the assessment
 * delegates to `member_savings_qualification`, Phase 2's calculation, rather
 * than counting months itself. A second contribution calculator is the kind of
 * duplication that passes its own tests and refuses a real member.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('member loan eligibility suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  borrower: TestUser;
  witnessProfileId: string;
}

let fx: Fixtures;
let seq = 0;

async function makeClient(name: string): Promise<string> {
  seq += 1;
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'female', '1990-01-01', $2, 'Trader', 'Kalerwe', 'Kampala')
     returning id`,
    [name, `+256700${String(31_000 + seq).padStart(6, '0')}`],
  );
  return row.id;
}

/**
 * A member with a chosen number of qualifying months behind them.
 *
 * Deposits are back-dated through `depositOn`, which honours
 * `app.business_now` for an owner session — the same mechanism the Phase 2
 * contribution tests use. `monthsBack` counts from the current month, so a
 * member asked for six months has deposits in the six months before this one
 * and qualifies today.
 */
async function memberWithMonths(
  name: string,
  months: readonly number[],
  options?: { readonly amount?: number },
): Promise<{
  clientId: string;
  membershipId: string;
  savingsAccountId: string;
}> {
  const clientId = await makeClient(name);
  const { membershipId, savingsAccountId } = await enrolMember(
    clientId,
    fx.witnessProfileId,
  );

  if (savingsAccountId === null) {
    throw new Error('the fixture expected a savings account');
  }

  const today = await queryOne<{ d: string }>(`select public.business_date()::text as d`);

  for (const monthsBack of months) {
    const on = await queryOne<{ d: string }>(
      `select ($1::date - ($2::int || ' months')::interval)::date::text as d`,
      [today.d, monthsBack],
    );
    await depositOn(savingsAccountId, options?.amount ?? 60_000, { on: on.d });
  }

  return { clientId, membershipId, savingsAccountId };
}

interface Assessment {
  membership_id: string | null;
  membership_status: string | null;
  policy_version: string | null;
  savings_account_id: string | null;
  savings_account_status: string | null;
  savings_qualifies: boolean | null;
  qualifying_months: number | null;
  consecutive_qualifying_months: number | null;
  eligible_savings: string | null;
  multiplier_bps: number | null;
  max_eligible_loan: string | null;
  max_term_months: number | null;
  required_cadence: string | null;
  active_loan_count: number | null;
  pledged_savings: string | null;
  is_eligible: boolean;
  may_proceed: boolean;
  blocking_reasons: string[];
}

async function assess(
  clientId: string,
  options?: {
    readonly amount?: number | null;
    readonly termMonths?: number | null;
    readonly frequency?: string | null;
    readonly asOf?: string | null;
  },
): Promise<Assessment> {
  return queryOne<Assessment>(
    `select * from public.member_loan_eligibility_of($1, $2::bigint, $3::smallint, $4, $5::date)`,
    [
      clientId,
      options?.amount ?? null,
      options?.termMonths ?? null,
      options?.frequency ?? null,
      options?.asOf ?? null,
    ],
  );
}

describeDb('member loan eligibility', () => {
  beforeAll(async () => {
    fx = {
      owner: await createTestUser('owner_admin'),
      manager: await createTestUser('manager'),
      secretary: await createTestUser('secretary_treasurer'),
      borrower: await createTestUser('client'),
      witnessProfileId: '',
    };

    const witness = await queryOne<{ id: string }>(
      `insert into public.profiles (full_name, phone, status)
       values ('Eligibility Witness', '+256700031999', 'active')
       returning id`,
    );
    fx.witnessProfileId = witness.id;
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('with the savings-to-loan multiplier undecided', () => {
    let policyId: string;

    beforeAll(async () => {
      // The savings questions answered, the three lending questions open —
      // which is where the client actually is. Savings work; lending does not.
      policyId = await publishTestPolicy({
        version: '310.1',
        // Each version needs its own effective date, and the namespace is
        // shared by the **whole suite**: the uniqueness constraint is over
        // every row rather than only the in-force one, so a version this file
        // supersedes keeps its date for the rest of the run. Polytos Phase 3
        // takes 500 upwards, leaving the earlier range to the Phase 1 and
        // Phase 2 files. Far enough back that every back-dated deposit below
        // falls inside the version that governs it.
        effectiveDaysAgo: 500,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
      });
    });

    afterAll(async () => {
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('shows no ceiling at all, rather than a default multiple of savings', async () => {
      const member = await memberWithMonths('Undecided Multiplier', [6, 5, 4, 3, 2, 1]);
      const result = await assess(member.clientId);

      // Qualified on the savings record — six months served.
      expect(result.savings_qualifies).toBe(true);
      expect(Number(result.qualifying_months)).toBe(6);

      // And still not eligible, because the price and the size of the loan
      // are undecided. The ceiling is absent rather than permissive.
      expect(result.multiplier_bps).toBeNull();
      expect(result.max_eligible_loan).toBeNull();
      expect(result.is_eligible).toBe(false);
      expect(result.may_proceed).toBe(false);
    });

    it('names each undecided decision rather than only refusing', async () => {
      const member = await memberWithMonths('Named Decisions', [6, 5, 4, 3, 2, 1]);
      const result = await assess(member.clientId, { amount: 400_000, termMonths: 2 });

      const reasons = result.blocking_reasons.join(' | ');

      expect(reasons).toMatch(/per month or once over the loan is undecided/i);
      expect(reasons).toMatch(/flat or on a reducing balance is undecided/i);
      expect(reasons).toMatch(/multiple of savings a member may borrow is undecided/i);
    });

    it('still reports the savings evidence, so a counter can answer "do I qualify yet?"', async () => {
      const member = await memberWithMonths('Evidence Shown', [4, 3, 2, 1]);
      const result = await assess(member.clientId);

      expect(Number(result.qualifying_months)).toBe(4);
      expect(Number(result.eligible_savings)).toBe(240_000);
      expect(result.savings_account_id).toBe(member.savingsAccountId);

      // The savings answer and the lending answer are separate: a member can
      // be told exactly where they stand on the clock while the loan itself
      // waits on the business.
      expect(result.blocking_reasons.join(' ')).toMatch(
        /4 of the 6 qualifying months have been saved/i,
      );
    });
  });

  // =========================================================================
  describe('with every decision made, under a TEST ONLY policy', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '310.2',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 501,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        // TEST ONLY figures. 20000 bp is twice savings; it is this fixture's
        // choice and not a Polytos rule.
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });
    });

    afterAll(async () => {
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('computes the ceiling as the balance times the multiplier, half-up', async () => {
      // 60,000 x 6 = 360,000 saved; at 2x that is 720,000.
      const member = await memberWithMonths('Ceiling Arithmetic', [6, 5, 4, 3, 2, 1]);
      const result = await assess(member.clientId);

      expect(Number(result.eligible_savings)).toBe(360_000);
      expect(result.multiplier_bps).toBe(20_000);
      expect(Number(result.max_eligible_loan)).toBe(720_000);
      expect(result.is_eligible).toBe(true);
    });

    it('rounds the ceiling down, so it always agrees with the pledge', async () => {
      // 12,345 bp on 55,555 is 68,582.5 exactly. A ceiling rounds **down**,
      // because a pledge rounds up: at a multiplier below 1x a loan taken at a
      // half-up ceiling would pledge one shilling more than the member holds,
      // and `approve_loan`'s own invariant would then refuse a legitimate
      // approval. Found by the property test in tests/unit/member-loan.test.ts.
      const member = await memberWithMonths('Rounding Boundary', [6, 5, 4, 3, 2, 1], {
        amount: 55_555,
      });

      // Six deposits of 55,555 is 333,330. At 2x that is 666,660 exactly, so
      // a cleaner case is needed to see the rounding — asserted through the
      // engine rather than through the arithmetic, so the test is about the
      // function and not about a SQL expression written twice.
      const result = await assess(member.clientId);
      expect(Number(result.eligible_savings)).toBe(333_330);
      expect(Number(result.max_eligible_loan)).toBe(666_660);

      // And the rule itself, where it bites: the pledge a loan at the ceiling
      // would consume never exceeds what is held.
      const rounding = await queryOne<{ ceiling: string; pledged: string }>(
        `select ((333330::bigint * 5000) / 10000)::text as ceiling,
                ((((333330::bigint * 5000) / 10000) * 10000 + 5000 - 1) / 5000)::text
                  as pledged`,
      );
      expect(Number(rounding.ceiling)).toBe(166_665);
      expect(Number(rounding.pledged)).toBeLessThanOrEqual(333_330);
    });

    it('lends against the balance, not against lifetime deposits', async () => {
      const member = await memberWithMonths('Withdrew Later', [6, 5, 4, 3, 2, 1], {
        amount: 100_000,
      });

      const before = await assess(member.clientId);
      expect(Number(before.eligible_savings)).toBe(600_000);
      expect(Number(before.max_eligible_loan)).toBe(1_200_000);

      // Take UGX 500,000 back out, all the way through the lifecycle.
      const request = await queryOne<{ id: string }>(
        `select public.request_savings_withdrawal($1, 500000, 'Test withdrawal') as id`,
        [member.savingsAccountId],
      );
      await query(`select public.decide_savings_withdrawal($1, true, 'approved')`, [
        request.id,
      ]);
      await query(
        `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
        [request.id],
      );

      const after = await assess(member.clientId);

      // The months served do not change — taking savings back out does not
      // un-pay what was paid in.
      expect(Number(after.qualifying_months)).toBe(Number(before.qualifying_months));

      // The ceiling does. This is the assertion that would fail if the engine
      // multiplied `total_contributed` instead of `balance`.
      expect(Number(after.eligible_savings)).toBe(100_000);
      expect(Number(after.max_eligible_loan)).toBe(200_000);
    });

    it('refuses an amount above the ceiling and says what the ceiling is', async () => {
      const member = await memberWithMonths('Above Ceiling', [6, 5, 4, 3, 2, 1]);

      const within = await assess(member.clientId, { amount: 700_000, termMonths: 2 });
      expect(within.may_proceed).toBe(true);
      expect(within.blocking_reasons).toEqual([]);

      const over = await assess(member.clientId, { amount: 800_000, termMonths: 2 });
      expect(over.may_proceed).toBe(false);
      expect(over.blocking_reasons.join(' ')).toMatch(
        /exceeds the 720000 this member's savings support/i,
      );
    });

    it('refuses a term beyond the policy maximum', async () => {
      const member = await memberWithMonths('Long Term', [6, 5, 4, 3, 2, 1]);

      expect(
        (await assess(member.clientId, { amount: 400_000, termMonths: 5 }))
          .blocking_reasons,
      ).toEqual([]);

      expect(
        (
          await assess(member.clientId, { amount: 400_000, termMonths: 6 })
        ).blocking_reasons.join(' '),
      ).toMatch(/runs for at most 5 months; 6 was requested/i);
    });

    it('requires weekly collection up to the policy boundary and monthly beyond it', async () => {
      const member = await memberWithMonths('Cadence Rule', [6, 5, 4, 3, 2, 1]);

      for (const [term, cadence] of [
        [1, 'weekly'],
        [2, 'weekly'],
        [3, 'monthly'],
        [5, 'monthly'],
      ] as const) {
        const result = await assess(member.clientId, {
          amount: 400_000,
          termMonths: term,
        });
        expect(result.required_cadence, `term ${String(term)}`).toBe(cadence);
      }
    });

    it('refuses a cadence that is not the one the term requires', async () => {
      const member = await memberWithMonths('Wrong Cadence', [6, 5, 4, 3, 2, 1]);

      const result = await assess(member.clientId, {
        amount: 400_000,
        termMonths: 2,
        frequency: 'daily',
      });

      expect(result.blocking_reasons.join(' ')).toMatch(
        /2-month member loan is collected weekly, not daily/i,
      );
    });

    it('refuses a calendar-monthly cadence while its anchor is undecided', async () => {
      const member = await memberWithMonths('Monthly Undecided', [6, 5, 4, 3, 2, 1]);

      const result = await assess(member.clientId, {
        amount: 400_000,
        termMonths: 3,
        frequency: 'monthly',
      });

      // The term needs monthly collection, and monthly collection needs a
      // convention nobody has settled. Both sentences appear, which is the
      // honest answer: the cadence is right and unavailable.
      expect(result.required_cadence).toBe('monthly');
      expect(result.blocking_reasons.join(' ')).toMatch(
        /monthly collection does in a month that has no such day/i,
      );
    });
  });

  // =========================================================================
  describe('who is not eligible, and why', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '310.3',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 502,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });
    });

    afterAll(async () => {
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('refuses a client who is not a member, and says the ordinary product is unaffected', async () => {
      const clientId = await makeClient('Not A Member');
      const result = await assess(clientId, { amount: 400_000, termMonths: 2 });

      expect(result.membership_id).toBeNull();
      expect(result.blocking_reasons.join(' ')).toMatch(
        /not a member of the savings programme/i,
      );
      expect(result.blocking_reasons.join(' ')).toMatch(/ordinary loan product/i);
    });

    it('refuses a member who has not served the qualifying months', async () => {
      const member = await memberWithMonths('Three Months Only', [3, 2, 1]);
      const result = await assess(member.clientId, { amount: 100_000, termMonths: 1 });

      expect(result.savings_qualifies).toBe(false);
      expect(result.blocking_reasons.join(' ')).toMatch(
        /3 of the 6 qualifying months have been saved/i,
      );
    });

    it('refuses a suspended membership and quotes the reason recorded on it', async () => {
      const member = await memberWithMonths('Suspended Member', [6, 5, 4, 3, 2, 1]);

      await query(
        `update public.memberships
            set status = 'suspended', status_reason = 'Under review by the committee'
          where id = $1`,
        [member.membershipId],
      );

      const result = await assess(member.clientId, { amount: 400_000, termMonths: 2 });

      expect(result.membership_status).toBe('suspended');
      expect(result.blocking_reasons.join(' ')).toMatch(
        /suspended — Under review by the committee/i,
      );
      expect(result.is_eligible).toBe(false);
    });

    it('refuses a pending membership, naming both activation preconditions', async () => {
      const clientId = await makeClient('Pending Member');
      await query(
        `insert into public.memberships (client_id, applied_on, policy_version_id)
         values ($1, public.business_date(), $2)`,
        [clientId, policyId],
      );

      const result = await assess(clientId, { amount: 400_000, termMonths: 2 });

      expect(result.membership_status).toBe('pending');
      expect(result.blocking_reasons.join(' ')).toMatch(
        /registration fee and a verified acceptance/i,
      );
    });

    it('refuses a member with no savings account at all', async () => {
      // A real state, not a contrived one: `enrol_member` opens an account
      // only when the savings rules are open, so a member enrolled while they
      // were shut has none — and savings accounts are append-only, so a
      // fixture cannot fake it by deleting one.
      //
      // Built the way the product reaches it: the membership, its fee and its
      // acceptance written directly, then activated. The activation guard
      // still checks both preconditions, which is why
      // `satisfyActivationPreconditions` is used rather than a bare UPDATE.
      const clientId = await makeClient('No Savings Account');

      const membership = await queryOne<{ id: string }>(
        `insert into public.memberships (client_id, applied_on, policy_version_id)
         values ($1, public.business_date(), $2)
         returning id`,
        [clientId, policyId],
      );

      await satisfyActivationPreconditions(membership.id, fx.witnessProfileId);
      await query(`update public.memberships set status = 'active' where id = $1`, [
        membership.id,
      ]);

      const result = await assess(clientId, { amount: 400_000, termMonths: 2 });

      expect(result.membership_status).toBe('active');
      expect(result.savings_account_id).toBeNull();
      expect(result.blocking_reasons.join(' ')).toMatch(/has no savings account/i);
    });

    it('refuses a member whose savings account is not active', async () => {
      const member = await memberWithMonths('Dormant Account', [6, 5, 4, 3, 2, 1]);

      await query(
        `update public.savings_accounts
            set status = 'dormant', status_reason = 'No activity for a year'
          where id = $1`,
        [member.savingsAccountId],
      );

      const result = await assess(member.clientId, { amount: 400_000, termMonths: 2 });

      expect(result.savings_account_status).toBe('dormant');
      expect(result.blocking_reasons.join(' ')).toMatch(
        /dormant — No activity for a year/i,
      );
      expect(result.is_eligible).toBe(false);
    });

    it('refuses when the client already holds the permitted number of active loans', async () => {
      const member = await memberWithMonths('Has Ordinary Loan', [6, 5, 4, 3, 2, 1]);

      // An active loan, written directly: what matters here is the count the
      // engine reads, and `business_settings.max_active_loans_per_client` is 1.
      await query(
        `insert into public.loans
           (client_id, principal_amount, interest_rate_bps, interest_method,
            loan_term_months, repayment_frequency, min_loan_amount_applied,
            grace_period_days_applied, penalty_rate_bps_applied, status,
            approved_at, approved_by, disbursed_at, disbursed_by,
            total_interest, total_expected_repayment, proposed_disbursement_date)
         values ($1, 300000, 1500, 'reducing_balance_monthly', 1, 'daily', 100000, 3,
                 5000, 'active', pg_catalog.now(), $2, pg_catalog.now(), $2,
                 45000, 345000, public.business_date())`,
        [member.clientId, fx.witnessProfileId],
      );

      const result = await assess(member.clientId, { amount: 400_000, termMonths: 2 });

      expect(Number(result.active_loan_count)).toBe(1);
      expect(result.blocking_reasons.join(' ')).toMatch(
        /already has 1 active loan\(s\), and the business permits 1/i,
      );
      // And the sentence says what membership does *not* do to that loan.
      expect(result.blocking_reasons.join(' ')).toMatch(
        /not converted or repriced by membership/i,
      );
    });
  });

  // =========================================================================
  describe('the consecutive rule, both arms', () => {
    it('counts a broken run as qualified when the months need not be consecutive', async () => {
      const policyId = await publishTestPolicy({
        version: '310.4',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 503,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });

      try {
        // Seven, six, five, then a gap, then three, two, one: six qualifying
        // months, longest unbroken run of three.
        const member = await memberWithMonths('Gap Allowed', [7, 6, 5, 3, 2, 1]);
        const result = await assess(member.clientId);

        expect(Number(result.qualifying_months)).toBe(6);
        expect(Number(result.consecutive_qualifying_months)).toBe(3);
        expect(result.savings_qualifies).toBe(true);
      } finally {
        await forcePolicyStatus(policyId, 'superseded');
      }
    });

    it('refuses the same history when the months must be consecutive', async () => {
      const policyId = await publishTestPolicy({
        version: '310.5',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 504,
        qualifyingMonthsConsecutive: true,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });

      try {
        const member = await memberWithMonths('Gap Refused', [7, 6, 5, 3, 2, 1]);
        const result = await assess(member.clientId);

        expect(Number(result.qualifying_months)).toBe(6);
        expect(Number(result.consecutive_qualifying_months)).toBe(3);
        expect(result.savings_qualifies).toBe(false);
        expect(result.blocking_reasons.join(' ')).toMatch(
          /longest unbroken run of qualifying months is 3 of the 6 required/i,
        );
      } finally {
        await forcePolicyStatus(policyId, 'superseded');
      }
    });
  });

  // =========================================================================
  describe('"as of" means what was known then', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '310.6',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 505,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });
    });

    afterAll(async () => {
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('does not let a later deposit change a historical assessment', async () => {
      const member = await memberWithMonths('Historical Snapshot', [8, 7, 6, 5, 4, 3]);

      const asOf = await queryOne<{ d: string }>(
        `select (public.business_date() - interval '2 months')::date::text as d`,
      );

      const before = await assess(member.clientId, { asOf: asOf.d });

      // A deposit made now, after the assessment date.
      await depositOn(member.savingsAccountId, 500_000);

      const again = await assess(member.clientId, { asOf: asOf.d });
      const today = await assess(member.clientId);

      // The historical answer is unchanged, to the shilling.
      expect(again.eligible_savings).toBe(before.eligible_savings);
      expect(again.max_eligible_loan).toBe(before.max_eligible_loan);
      expect(Number(again.qualifying_months)).toBe(Number(before.qualifying_months));

      // And today's answer has moved, so the assertion above is not passing
      // because nothing happened.
      expect(Number(today.eligible_savings)).toBeGreaterThan(
        Number(before.eligible_savings),
      );
    });
  });

  // =========================================================================
  describe('the register view and the function agree', () => {
    let policyId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '310.7',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 506,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });
    });

    afterAll(async () => {
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('reports the same savings, ceiling and months for every live membership', async () => {
      await memberWithMonths('Agreement A', [6, 5, 4, 3, 2, 1]);
      await memberWithMonths('Agreement B', [3, 2, 1]);
      await memberWithMonths('Agreement C', [6, 5, 4, 3, 2, 1], { amount: 120_000 });

      const rows = await query<{
        client_id: string;
        eligible_savings: string;
        max_eligible_loan: string | null;
        qualifying_months: number;
        savings_months_met: boolean;
      }>(
        `select client_id, eligible_savings, max_eligible_loan, qualifying_months,
                savings_months_met
           from public.member_loan_eligibility
          where policy_version_id = $1`,
        [policyId],
      );

      // The view exists so a dashboard is one read rather than a function
      // call per member. Two implementations of one answer is a real risk, so
      // it is tested as one thing — every row, not a sample.
      expect(rows.length).toBeGreaterThanOrEqual(3);

      for (const row of rows) {
        const direct = await assess(row.client_id);

        expect(row.eligible_savings, row.client_id).toBe(direct.eligible_savings);
        expect(row.max_eligible_loan, row.client_id).toBe(direct.max_eligible_loan);
        expect(Number(row.qualifying_months), row.client_id).toBe(
          Number(direct.qualifying_months),
        );
        expect(row.savings_months_met, row.client_id).toBe(direct.savings_qualifies);
      }
    });
  });

  // =========================================================================
  describe('who may read an assessment', () => {
    let policyId: string;
    let memberClientId: string;

    beforeAll(async () => {
      policyId = await publishTestPolicy({
        version: '310.8',
        // Its own effective date; see the note on the first one.
        effectiveDaysAgo: 507,
        qualifyingMonthsConsecutive: false,
        withdrawalRule: 'allowed',
        interestBasis: 'per_month',
        interestMethod: 'flat',
        savingsToLoanMultiplierBps: 20_000,
      });

      const member = await memberWithMonths('Readable Member', [6, 5, 4, 3, 2, 1]);
      memberClientId = member.clientId;
    });

    afterAll(async () => {
      await forcePolicyStatus(policyId, 'superseded');
    });

    it('lets the three staff roles read it through the wrapper', async () => {
      for (const user of [fx.owner, fx.manager, fx.secretary]) {
        const result = await asUser(
          user,
          `select max_eligible_loan::text as ceiling
             from public.assess_member_loan_eligibility($1)`,
          [memberClientId],
        );

        expect(result.ok, user.role).toBe(true);
        expect(result.rows[0]?.ceiling, user.role).toBe('720000');
      }
    });

    it('refuses a borrower, who holds no eligibility capability', async () => {
      const result = await asUser(
        fx.borrower,
        `select * from public.assess_member_loan_eligibility($1)`,
        [memberClientId],
      );

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/member_loans:view_eligibility/i);
    });

    it('gives nobody a path to the authoritative assessment directly', async () => {
      // `member_loan_eligibility_of` is SECURITY DEFINER with no capability
      // check, so the only thing standing between a session and a ceiling for
      // any client id is the absent EXECUTE grant. Asserted as every role,
      // because a grant to one of them would be the hole.
      for (const user of [fx.owner, fx.manager, fx.secretary, fx.borrower]) {
        const result = await asUser(
          user,
          `select * from public.member_loan_eligibility_of($1)`,
          [memberClientId],
        );

        expect(result.ok, user.role).toBe(false);
        expect(result.message, user.role).toMatch(/permission denied/i);
      }
    });

    it('answers the same way for a client who does not exist and one who cannot be seen', async () => {
      const error = await expectError(
        `select * from public.assess_member_loan_eligibility(gen_random_uuid())`,
      );

      expect(error?.message).toMatch(/No such client/i);
    });
  });
});
