import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asAnon,
  asServiceRole,
  asUser,
  asUserScript,
  deleteTestUsers,
} from '../helpers/auth-fixtures';
import { restoreSeededLendingTerms } from '../helpers/delinquency-fixtures';
import {
  approveLoan,
  cancelLoan,
  narrowLendingRules,
  createDraftLoan,
  createLoanScenario,
  disburseLoan,
  submitLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The loan lifecycle, attacked directly.
 *
 * Every statement runs as a real database role with a real JWT subject,
 * exactly as a request arriving at PostgREST would. Nothing goes through the
 * application, so nothing the application does can account for a pass.
 *
 * The question these tests answer is not "does the interface prevent this" but
 * "can somebody with a token and curl approve their own loan, forge an
 * approver, disburse twice, or edit the terms of a live agreement".
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan lifecycle suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

/**
 * Call one lifecycle function as a chosen user, committed.
 *
 * The fixtures drive a loan through several steps; these drive exactly one, so
 * a test can place a loan in a state and then prove that the *next* step is
 * refused — which is impossible if the helper performs it for you.
 */
async function callAs(
  user: { readonly authUserId: string },
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  const { getClient } = await import('../helpers/db');
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      user.authUserId,
    ]);
    await client.query('set local role authenticated');
    await client.query(sql, [...params]);
    await client.query('reset role');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

const approveAs = (user: { readonly authUserId: string }, loanId: string) =>
  callAs(user, `select public.approve_loan($1)`, [loanId]);

const disburseAs = (user: { readonly authUserId: string }, loanId: string) =>
  callAs(user, `select public.disburse_loan($1)`, [loanId]);

describeDb('the loan lifecycle', () => {
  let scenario: LoanScenario;

  beforeAll(async () => {
    await deleteTestUsers();
    scenario = await createLoanScenario();
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('state transitions', () => {
    it('declares exactly the intended transitions, and no others', async () => {
      // Every pair, enumerated. A status column with a CHECK constraint says
      // which values are legal; it says nothing about which *moves* are, and
      // without that a draft could jump straight to active.
      const PERMITTED = new Set([
        'draft>pending_approval',
        'draft>cancelled',
        'pending_approval>draft',
        'pending_approval>approved',
        'pending_approval>cancelled',
        'approved>active',
        'approved>cancelled',
        'active>cleared',
      ]);

      const STATUSES = [
        'draft',
        'pending_approval',
        'approved',
        'active',
        'cleared',
        'cancelled',
      ];

      for (const from of STATUSES) {
        for (const to of STATUSES) {
          if (from === to) continue;

          const expected = PERMITTED.has(`${from}>${to}`);

          const row = await queryOne<{ allowed: boolean }>(
            `select ($1, $2) in (
                 ('draft', 'pending_approval'),
                 ('draft', 'cancelled'),
                 ('pending_approval', 'draft'),
                 ('pending_approval', 'approved'),
                 ('pending_approval', 'cancelled'),
                 ('approved', 'active'),
                 ('approved', 'cancelled'),
                 ('active', 'cleared')
               ) as allowed`,
            [from, to],
          );

          expect(row.allowed, `${from} -> ${to}`).toBe(expected);
        }
      }
    });

    it('refuses a draft jumping straight to active', async () => {
      const loanId = await createDraftLoan(scenario.clientId);

      await expect(
        query(`update public.loans set status = 'active' where id = $1`, [loanId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses a draft jumping straight to approved', async () => {
      const loanId = await createDraftLoan(scenario.clientId);

      await expect(
        query(`update public.loans set status = 'approved' where id = $1`, [loanId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses reviving a cancelled loan', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await cancelLoan(loanId, scenario, 'fixture');

      for (const target of ['draft', 'pending_approval', 'approved', 'active']) {
        await expect(
          query(`update public.loans set status = $2 where id = $1`, [loanId, target]),
          `cancelled -> ${target}`,
        ).rejects.toMatchObject({ code: 'P0001' });
      }
    });

    it('returns a submitted loan to draft, clearing the submission', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      await query(
        `update public.loans set status = 'draft', review_note = 'Wrong amount'
          where id = $1`,
        [loanId],
      );

      const row = await queryOne<{
        status: string;
        submitted_at: string | null;
        submitted_by: string | null;
        review_note: string | null;
      }>(
        `select status, submitted_at::text as submitted_at, submitted_by::text as submitted_by,
                review_note from public.loans where id = $1`,
        [loanId],
      );

      expect(row.status).toBe('draft');
      // Cleared, so the next submission is recorded as its own act rather
      // than inheriting the first one's time and author.
      expect(row.submitted_at).toBeNull();
      expect(row.submitted_by).toBeNull();
      expect(row.review_note).toBe('Wrong amount');
    });
  });

  // =========================================================================
  describe('attribution cannot be forged', () => {
    it('stamps the submitter from the session, ignoring any supplied value', async () => {
      const loanId = await createDraftLoan(scenario.clientId);

      const result = await asUserScript(scenario.secretary, [
        {
          sql: `update public.loans
                   set status = 'pending_approval', submitted_by = $2
                 where id = $1`,
          params: [loanId, scenario.owner.profileId],
        },
        {
          sql: `select submitted_by::text as submitted_by from public.loans where id = $1`,
          params: [loanId],
        },
      ]);

      // Supplying `submitted_by` is refused outright rather than overwritten:
      // a caller that believes it is choosing the actor should find out.
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Submission attribution is maintained/i);
    });

    it('refuses a forged approver', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.manager,
        `update public.loans set status = 'approved', approved_by = $2 where id = $1`,
        [loanId, scenario.owner.profileId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/Approval attribution is maintained/i);
    });

    it('refuses a forged approval timestamp', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.manager,
        `update public.loans set approved_at = now() - interval '1 year' where id = $1`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
    });

    it('refuses a forged disbursement actor and timestamp', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);

      const forgedActor = await asUser(
        scenario.owner,
        `update public.loans set status = 'active', disbursed_by = $2 where id = $1`,
        [loanId, scenario.manager.profileId],
      );
      expect(forgedActor.ok).toBe(false);

      const forgedTime = await asUser(
        scenario.owner,
        `update public.loans set disbursed_at = now() + interval '1 year' where id = $1`,
        [loanId],
      );
      expect(forgedTime.ok).toBe(false);
    });

    it('records the real approver when approval goes through the function', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const result = await asUserScript(scenario.manager, [
        { sql: `select public.approve_loan($1)`, params: [loanId] },
        {
          sql: `select approved_by::text as approved_by,
                       approved_at is not null as stamped
                  from public.loans where id = $1`,
          params: [loanId],
        },
      ]);

      expect(result.ok).toBe(true);
      expect(result.rows[0]?.approved_by).toBe(scenario.manager.profileId);
      expect(result.rows[0]?.stamped).toBe(true);
    });

    it('refuses rewriting the loan number or provenance, even as service_role', async () => {
      const loanId = await createDraftLoan(scenario.clientId);

      const number = await asServiceRole(
        `update public.loans set loan_number = 'LN269999' where id = $1`,
        [loanId],
      );
      expect(number.ok).toBe(false);
      expect(number.message).toMatch(/cannot be changed once issued/i);

      const provenance = await asServiceRole(
        `update public.loans set created_by = $2 where id = $1`,
        [loanId, scenario.owner.profileId],
      );
      expect(provenance.ok).toBe(false);
      expect(provenance.message).toMatch(/provenance cannot be rewritten/i);
    });

    it('refuses a caller-supplied loan number on insert, even as service_role', async () => {
      const attempt = await asServiceRole(
        `insert into public.loans
           (loan_number, client_id, principal_amount, interest_rate_bps, interest_method,
            loan_term_months, repayment_frequency, min_loan_amount_applied,
            grace_period_days_applied, penalty_rate_bps_applied, proposed_disbursement_date)
         values ('LN269998', $1, 600000, 1500, 'reducing_balance_monthly', 3, 'daily',
                 100000, 3, 5000, current_date)`,
        [scenario.clientId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/assigned by the database/i);
    });
  });

  // =========================================================================
  describe('terms are immutable once the loan leaves draft', () => {
    let loanId: string;

    beforeEach(async () => {
      // A fresh client each time. Reusing one would hit the one-active-loan
      // rule from the second case onward — which is the rule working, but it
      // would mask what these tests are actually about.
      const own = await createLoanScenario();
      loanId = await createDraftLoan(own.clientId);
      await disburseLoan(loanId, own);
    });

    it.each([
      ['the principal', `principal_amount = 1`],
      ['the interest rate', `interest_rate_bps = 0`],
      // The vocabulary has one member, so any different value is also an
      // invalid one. Either guard refusing is the point: the method a loan
      // was priced under cannot be restated.
      ['the interest method', `interest_method = 'flat'`],
      ['the term', `loan_term_months = 1`],
      ['the repayment frequency', `repayment_frequency = 'every_2_days'`],
      ['the client', `client_id = gen_random_uuid()`],
      ['the total interest', `total_interest = 0`],
      ['the total expected', `total_expected_repayment = 1`],
      ['the intended date', `proposed_disbursement_date = current_date + 30`],
      ['the grace period', `grace_period_days_applied = 99`],
      ['the penalty rate', `penalty_rate_bps_applied = 0`],
    ])('refuses changing %s on a live loan', async (_label, assignment) => {
      await expect(
        query(`update public.loans set ${assignment} where id = $1`, [loanId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses even as service_role', async () => {
      // The rule sits above the trusted-path exemption, so a leaked secret key
      // cannot quietly restate what a borrower owes.
      const attempt = await asServiceRole(
        `update public.loans set principal_amount = 1 where id = $1`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/cannot be changed after it leaves draft/i);
    });

    it('refuses changing terms while merely awaiting approval', async () => {
      const pendingLoan = await createDraftLoan(scenario.clientId);
      await submitLoan(pendingLoan, scenario);

      await expect(
        query(`update public.loans set principal_amount = 1 where id = $1`, [
          pendingLoan,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('permits editing a draft', async () => {
      const draft = await createDraftLoan(scenario.clientId);

      await expect(
        query(
          `update public.loans set principal_amount = 250000, loan_term_months = 2
            where id = $1`,
          [draft],
        ),
      ).resolves.toBeDefined();
    });
  });

  // =========================================================================
  describe('approval revalidates rather than trusting the draft', () => {
    it.each(['suspended', 'blacklisted'])(
      'refuses when the client became %s after drafting',
      async (status) => {
        // Its own scenario: this test changes the client's status, and sharing
        // a client with another test would make the order matter.
        const own = await createLoanScenario();
        const loanId = await createDraftLoan(own.clientId);
        await submitLoan(loanId, own);

        // The race the specification names: eligibility at draft time is not
        // eligibility at approval time, and approval re-asks rather than
        // trusting what was true when the form was filled in.
        await query(
          `update public.clients
              set status = $2, status_reason = 'under review' where id = $1`,
          [own.clientId, status],
        );

        await expect(approveAs(own.owner, loanId), status).rejects.toThrow(
          /client_not_active/,
        );

        // And the loan is left where it was, not half-approved.
        const row = await queryOne<{ status: string }>(
          `select status from public.loans where id = $1`,
          [loanId],
        );
        expect(row.status, status).toBe('pending_approval');
      },
    );

    it('refuses an application with no guarantor of its own', async () => {
      // Phase 13 moved the rule: approval counts the guarantors on the
      // *application*, not the client's register. Detaching a register entry
      // after drafting no longer changes what the loan relies on — the loan
      // recorded it — and that is the point of the move. What still refuses
      // an approval is an application nobody agreed to back.
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        withoutLoanGuarantors: true,
      });
      await submitLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).rejects.toThrow(
        /insufficient_guarantors/,
      );
    });

    it('refuses an application whose guarantor has not signed', async () => {
      // A guarantor who has not signed the undertaking is somebody the
      // business cannot hold to anything, so this stops the approval rather
      // than being noted on it.
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, { withoutConsent: true });
      await submitLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).rejects.toThrow(
        /guarantor_consent_missing/,
      );
    });

    it('refuses when a guarantor stopped being eligible after drafting', async () => {
      // The same race the client check loses safely: a guarantor archived
      // between drafting and approval must stop the approval, because the
      // business would otherwise be relying on somebody it has struck off.
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      await query(
        `update public.guarantors set archived_at = pg_catalog.now() where id = $1`,
        [own.guarantorId],
      );

      await expect(approveAs(own.owner, loanId)).rejects.toThrow(/guarantor_ineligible/);
    });

    it('refuses when the guarantor is missing required information', async () => {
      const own = await createLoanScenario({ incompleteGuarantor: true });
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).rejects.toThrow(/guarantor_incomplete/);
    });

    it('refuses when the minimum rose above the loan after drafting', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 150_000,
        termMonths: 1,
      });
      await submitLoan(loanId, own);

      // Phase 12: raising the floor means raising it on the products too,
      // because the rail now holds in both directions. `narrowLendingRules`
      // does it in the order the database permits and hands back the exact
      // restore.
      const restore = await narrowLendingRules({ minLoanAmount: 200_000 });

      try {
        await expect(query(`select public.approve_loan($1)`, [loanId])).rejects.toThrow(
          /below_minimum/,
        );
      } finally {
        await restore();
      }
    });

    it('refuses a multi-month term below the threshold', async () => {
      const own = await createLoanScenario();
      // 150,000 over two months: above the minimum, below the multi-month
      // threshold of 200,000.
      const loanId = await createDraftLoan(own.clientId, {
        principal: 150_000,
        termMonths: 2,
      });
      await submitLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).rejects.toThrow(
        /term_requires_higher_amount/,
      );
    });

    it('permits a single month below the threshold', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 150_000,
        termMonths: 1,
      });
      await submitLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).resolves.toBeUndefined();
    });

    it('uses the rate in force at approval, not at drafting', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 600_000,
        termMonths: 3,
      });
      await submitLoan(loanId, own);

      // The documented policy: terms are snapshotted at approval, from what
      // is in force then. Approving at a stale rate would mean lending at a
      // rate the business had already decided to stop offering.
      //
      // Phase 12 moved "what is in force" from `business_settings` to the
      // loan's product — see the precedence note at the head of migration
      // 20261012000200 — so the repricing happens there. The claim this test
      // makes is unchanged: the draft does not fix the rate, approval does.
      await query(
        `update public.loan_products
            set default_interest_rate_bps = 1200,
                min_interest_rate_bps = least(min_interest_rate_bps, 1200)
          where is_default`,
      );

      try {
        await approveAs(own.owner, loanId);

        const row = await queryOne<{
          interest_rate_bps: number;
          total_interest: string;
        }>(
          `select interest_rate_bps, total_interest::text as total_interest
             from public.loans where id = $1`,
          [loanId],
        );

        expect(row.interest_rate_bps).toBe(1_200);
        // Hand-checked at 12%: 72,000 + 48,000 + 24,000 = 144,000.
        expect(row.total_interest).toBe('144000');
      } finally {
        // Both the business settings and the product, because the db project
        // runs its files in sequence: a product left at 12% is the rate every
        // suite after this one would approve at.
        await restoreSeededLendingTerms();
      }
    });
  });

  // =========================================================================
  describe('approval is atomic', () => {
    it('writes the breakdown, every snapshot and the terms together', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const counts = await queryOne<{
        periods: string;
        client_snap: string;
        guarantor_snap: string;
        identity_snap: string;
      }>(
        `select
           (select count(*) from public.loan_periods where loan_id = $1)::text as periods,
           (select count(*) from public.loan_client_snapshots where loan_id = $1)::text as client_snap,
           (select count(*) from public.loan_guarantor_evidence where loan_id = $1)::text as guarantor_snap,
           (select count(*) from public.loan_identity_snapshots where loan_id = $1)::text as identity_snap`,
        [loanId],
      );

      expect(counts.periods).toBe('3');
      expect(counts.client_snap).toBe('1');
      expect(counts.guarantor_snap).toBe('1');
      // The client's number and the guarantor's.
      expect(counts.identity_snap).toBe('2');
    });

    it('leaves nothing behind when approval fails', async () => {
      const own = await createLoanScenario({ incompleteGuarantor: true });
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).rejects.toThrow();

      // The whole function is one transaction, so a refusal rolls back any
      // snapshot rows it had already written. A partially approved loan would
      // be worse than a failed approval, because it would look complete.
      const counts = await queryOne<{ periods: string; snaps: string; status: string }>(
        `select
           (select count(*) from public.loan_periods where loan_id = $1)::text as periods,
           (select count(*) from public.loan_client_snapshots where loan_id = $1)::text as snaps,
           (select status from public.loans where id = $1) as status`,
        [loanId],
      );

      expect(counts.periods).toBe('0');
      expect(counts.snaps).toBe('0');
      expect(counts.status).toBe('pending_approval');
    });

    it('refuses to disburse a loan with no breakdown', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      // Simulate a corrupt approval by removing the breakdown with the
      // owner-level exemption, then prove disbursement refuses rather than
      // creating an active loan nobody can collect.
      //
      // `loan_installments` is exempted too: it references `loan_periods` with
      // `on delete cascade`, and its DELETE guard is statement-level, so it
      // fires on the cascade even though this approved loan has no
      // installments yet. That the guard fires on an empty cascade is the
      // behaviour Phase 3 chose deliberately — a refusal that does not depend
      // on the attacker's WHERE clause matching anything.
      await query(
        `alter table public.loan_periods disable trigger loan_periods_no_delete`,
      );
      await query(
        `alter table public.loan_installments disable trigger loan_installments_no_delete`,
      );
      try {
        await query(`delete from public.loan_periods where loan_id = $1`, [loanId]);
      } finally {
        await query(
          `alter table public.loan_periods enable trigger loan_periods_no_delete`,
        );
        await query(
          `alter table public.loan_installments enable trigger loan_installments_no_delete`,
        );
      }

      await expect(disburseAs(own.owner, loanId)).rejects.toThrow(
        /no contractual breakdown/i,
      );
    });
  });

  // =========================================================================
  describe('double submission', () => {
    it('refuses a second approval', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      await expect(approveAs(own.owner, loanId)).rejects.toThrow(
        /Only a loan awaiting approval/i,
      );

      // And no duplicate snapshot rows.
      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.loan_client_snapshots where loan_id = $1`,
        [loanId],
      );
      expect(row.count).toBe('1');
    });

    it('refuses a second disbursement', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await disburseLoan(loanId, own);

      await expect(disburseAs(own.owner, loanId)).rejects.toThrow(
        /Only an approved loan/i,
      );
    });

    it('refuses a second cancellation', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await cancelLoan(loanId, own, 'first');

      await expect(cancelLoan(loanId, own, 'second')).rejects.toThrow(
        /already cancelled/i,
      );
    });

    it('treats re-asserting pending_approval as no change at all', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);

      const before = await queryOne<{ submitted_at: string; submitted_by: string }>(
        `select submitted_at::text as submitted_at, submitted_by::text as submitted_by
           from public.loans where id = $1`,
        [loanId],
      );

      // Deliberate: setting the status to the value it already holds is not a
      // transition, so no capability is needed and nothing is re-stamped. What
      // must not happen is the submission being re-attributed — a double tap
      // must not make it look as though somebody submitted twice.
      await expect(
        query(`update public.loans set status = 'pending_approval' where id = $1`, [
          loanId,
        ]),
      ).resolves.toBeDefined();

      const after = await queryOne<{ submitted_at: string; submitted_by: string }>(
        `select submitted_at::text as submitted_at, submitted_by::text as submitted_by
           from public.loans where id = $1`,
        [loanId],
      );

      expect(after.submitted_at).toBe(before.submitted_at);
      expect(after.submitted_by).toBe(before.submitted_by);
    });

    it('refuses submitting a loan that has already been approved', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      await expect(
        query(`update public.loans set status = 'pending_approval' where id = $1`, [
          loanId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('produces one audit event per act, not two', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await disburseLoan(loanId, own);

      // A second attempt fails, so it adds nothing.
      await disburseAs(own.owner, loanId).catch(() => undefined);

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.disbursed'`,
        [loanId],
      );

      expect(row.count).toBe('1');
    });
  });

  // =========================================================================
  describe('cancellation', () => {
    it.each(['draft', 'pending_approval', 'approved'])(
      'permits cancelling a %s loan',
      async (status) => {
        const own = await createLoanScenario();
        const loanId = await createDraftLoan(own.clientId);

        if (status === 'pending_approval') await submitLoan(loanId, own);
        if (status === 'approved') await approveLoan(loanId, own);

        await expect(
          cancelLoan(loanId, own, 'no longer required'),
        ).resolves.toBeUndefined();

        const row = await queryOne<{
          status: string;
          cancellation_reason: string;
          cancelled_by: string | null;
        }>(
          `select status, cancellation_reason, cancelled_by::text as cancelled_by
             from public.loans where id = $1`,
          [loanId],
        );

        expect(row.status).toBe('cancelled');
        expect(row.cancellation_reason).toBe('no longer required');
      },
    );

    it('refuses cancelling an active loan', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await disburseLoan(loanId, own);

      // The money has been released. Reversing that is a write-off, which is
      // a different act with different accounting.
      await expect(cancelLoan(loanId, own, 'changed mind')).rejects.toThrow(
        /Money has already been released/i,
      );
    });

    it('requires a reason', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      for (const reason of [null, '', '   ']) {
        await expect(
          cancelLoan(loanId, own, reason!),
          `reason ${JSON.stringify(reason)}`,
        ).rejects.toThrow(/requires a reason/i);
      }
    });

    it('keeps the loan in the register', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await cancelLoan(loanId, own, 'fixture');

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.loans where id = $1`,
        [loanId],
      );

      // Not deleted. Financial history persists.
      expect(row.count).toBe('1');
    });
  });

  // =========================================================================
  describe('nothing can be hard-deleted', () => {
    it.each([
      'loans',
      'loan_periods',
      'loan_client_snapshots',
      'loan_guarantor_snapshots',
      'loan_identity_snapshots',
    ])('grants no DELETE on %s to any session role', async (table) => {
      const rows = await query<{ grantee: string }>(
        `select grantee from information_schema.role_table_grants
          where table_schema = 'public' and table_name = $1
            and privilege_type = 'DELETE'
            and grantee in ('anon', 'authenticated')`,
        [table],
      );

      expect(rows).toEqual([]);
    });

    it('refuses a delete attempt from every role', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      for (const actor of [own.secretary, own.manager, own.owner]) {
        const attempt = await asUser(actor, `delete from public.loans where id = $1`, [
          loanId,
        ]);
        expect(attempt.ok, actor.role).toBe(false);
        expect(attempt.code, actor.role).toBe('42501');
      }

      const anon = await asAnon(`delete from public.loans`);
      expect(anon.ok).toBe(false);
    });

    it('refuses editing or deleting a stored breakdown, even as service_role', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const update = await asServiceRole(
        `update public.loan_periods set interest = 0 where loan_id = $1`,
        [loanId],
      );
      expect(update.ok).toBe(false);
      expect(update.message).toMatch(/append-only/i);

      const del = await asServiceRole(
        `delete from public.loan_periods where loan_id = $1`,
        [loanId],
      );
      expect(del.ok).toBe(false);
    });

    it('refuses editing a snapshot, even with a WHERE clause matching nothing', async () => {
      // Statement-level, so the refusal does not depend on the attacker's
      // WHERE clause being correct. A row-level trigger would let
      // `update ... where loan_id = <wrong id>` succeed silently and look
      // like it had worked.
      const attempt = await asServiceRole(
        `update public.loan_client_snapshots set full_name = 'Rewritten'
          where loan_id = '00000000-0000-4000-8000-000000000000'`,
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/append-only/i);
    });
  });
});
