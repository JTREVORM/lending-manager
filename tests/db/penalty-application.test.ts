import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
} from '../helpers/loan-fixtures';
import {
  deleteTestPayments,
  postPayment,
  readLedger,
  reversePayment,
  tryPostPayment,
} from '../helpers/payment-fixtures';
import {
  applyEligiblePenalties,
  atClock,
  businessInstant,
  configureLendingTerms,
  createFourThousandLoan,
  deleteTestPenalties,
  ensurePenalty,
  readDelinquency,
  readPenalty,
  restoreSeededLendingTerms,
  shiftDate,
  type FourThousandLoan,
} from '../helpers/delinquency-fixtures';
import { closePool, hasDatabase, query, skipReason } from '../helpers/db';

/**
 * The expiry penalty: when it applies, what it is charged on, and what cannot
 * be done to it.
 *
 * ## The figures here are the specification's own
 *
 * UGX 100,000 outstanding after grace gives a UGX 50,000 charge and a
 * UGX 150,000 obligation. UGX 40,000 paid inside grace gives a UGX 60,000
 * basis, a UGX 30,000 charge and a UGX 90,000 obligation. Every expectation
 * is a literal from §124 to §126 and §146, not a figure this suite computed.
 *
 * ## Every test fixes the business clock
 *
 * A penalty exists because a date passed, so the date is set deliberately.
 * See `tests/helpers/delinquency-fixtures.ts`.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('penalty application suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('the expiry penalty', () => {
  beforeAll(async () => {
    // Payments first: an allocation to a penalty references it, and
    // financial history is `on delete restrict` precisely so it cannot
    // cascade away.
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
  });

  afterAll(async () => {
    // Payments first: an allocation to a penalty references it, and
    // financial history is `on delete restrict` precisely so it cannot
    // cascade away.
    await deleteTestPayments();
    await deleteTestPenalties();
    await deleteTestLoans();
    await deleteTestUsers();
    await restoreSeededLendingTerms();
    await closePool();
  });

  /**
   * A loan standing at exactly UGX 100,000 when its grace period ends, which
   * is the specification's worked example.
   *
   * Built by paying the contract down before the final collection date, so
   * the 100,000 is a real ledger position rather than a contrived total.
   */
  async function loanOwing100kAtGraceEnd(): Promise<{
    readonly scenario: Awaited<ReturnType<typeof createLoanScenario>>;
    readonly loan: FourThousandLoan;
  }> {
    const scenario = await createLoanScenario();
    const loan = await createFourThousandLoan(scenario);

    const payDown = loan.scheduledTotal - 100_000;

    if (payDown < 4_000) {
      throw new Error(
        `a one-month daily loan has only ${String(loan.installments)} collections this month, so it cannot be paid down to 100,000`,
      );
    }

    await postPayment(loan.loanId, scenario.secretary, {
      amount: payDown,
      businessNow: businessInstant(loan.firstDue),
    });

    return { scenario, loan };
  }

  // =========================================================================
  describe('eligibility', () => {
    it('applies nothing before the final collection date', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      const applied = await ensurePenalty(
        loan.loanId,
        businessInstant(await shiftDate(loan.finalDue, -1)),
      );

      expect(applied).toBeNull();
      expect(await readPenalty(loan.loanId)).toBeNull();
    });

    it('applies nothing on the final collection date', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      expect(await ensurePenalty(loan.loanId, businessInstant(loan.finalDue))).toBeNull();
      expect(await readPenalty(loan.loanId)).toBeNull();
    });

    it('applies nothing on any grace day', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      for (const offset of [1, 2, 3]) {
        const day = await shiftDate(loan.finalDue, offset);

        expect(
          await ensurePenalty(loan.loanId, businessInstant(day)),
          `grace day ${String(offset)}`,
        ).toBeNull();
      }

      expect(await readPenalty(loan.loanId)).toBeNull();
    });

    it('specification §146 scenario E — applies UGX 50,000 on the penalty date', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      const penaltyId = await ensurePenalty(
        loan.loanId,
        businessInstant(loan.penaltyEffective),
      );

      expect(penaltyId).not.toBeNull();

      const penalty = await readPenalty(loan.loanId);

      expect(penalty).not.toBeNull();
      // The specification's figures, exactly.
      expect(penalty?.basisAmount).toBe(100_000);
      expect(penalty?.penaltyRateBps).toBe(5_000);
      expect(penalty?.penaltyAmount).toBe(50_000);
      expect(penalty?.remainingAmount).toBe(50_000);
      expect(penalty?.penaltyType).toBe('expiry_penalty');
      expect(penalty?.triggerRule).toBe('grace_period_expired');

      // And the provenance: the dates it followed from.
      expect(penalty?.finalDueDate).toBe(loan.finalDue);
      expect(penalty?.graceDays).toBe(3);
      expect(penalty?.graceEndDate).toBe(loan.graceEnd);
      expect(penalty?.effectiveDate).toBe(loan.penaltyEffective);

      const position = await readDelinquency(
        loan.loanId,
        businessInstant(loan.penaltyEffective),
      );

      expect(position.contractualOutstanding).toBe(100_000);
      expect(position.penaltyRemaining).toBe(50_000);
      // UGX 150,000.
      expect(position.totalOutstanding).toBe(150_000);
      expect(position.state).toBe('penalty_due');
    });

    it('specification §146 scenario D — a loan cleared during grace is never charged', async () => {
      const { scenario, loan } = await loanOwing100kAtGraceEnd();

      // Settle the remaining 100,000 on grace day two.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 100_000,
        businessNow: businessInstant(await shiftDate(loan.finalDue, 2)),
      });

      expect((await readLedger(loan.loanId)).status).toBe('cleared');

      // Long after the penalty date, there is nothing to charge.
      const applied = await ensurePenalty(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 14)),
      );

      expect(applied).toBeNull();
      expect(await readPenalty(loan.loanId)).toBeNull();

      const position = await readDelinquency(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 14)),
      );

      expect(position.state).toBe('cleared');
      expect(position.totalOutstanding).toBe(0);
    });

    it('specification §146 scenario F — a part-payment during grace shrinks the basis', async () => {
      const { scenario, loan } = await loanOwing100kAtGraceEnd();

      // UGX 40,000 on grace day two leaves 60,000 at the deadline.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 40_000,
        businessNow: businessInstant(await shiftDate(loan.finalDue, 2)),
      });

      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));
      const penalty = await readPenalty(loan.loanId);

      // The specification's figures: basis 60,000, charge 30,000.
      expect(penalty?.basisAmount).toBe(60_000);
      expect(penalty?.penaltyAmount).toBe(30_000);

      const position = await readDelinquency(
        loan.loanId,
        businessInstant(loan.penaltyEffective),
      );

      expect(position.contractualOutstanding).toBe(60_000);
      expect(position.penaltyRemaining).toBe(30_000);
      // UGX 90,000.
      expect(position.totalOutstanding).toBe(90_000);
    });

    it('charges on the deadline balance even when materialised much later', async () => {
      // §39. The basis is reconstructed as at the deadline, so a borrower who
      // pays late — after grace, before anything has looked at the loan —
      // does not shrink their own charge.
      const { scenario, loan } = await loanOwing100kAtGraceEnd();

      // 60,000 paid a week after the penalty date. The posting materialises
      // the charge first, so this is the path the business actually takes.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 60_000,
        businessNow: businessInstant(await shiftDate(loan.penaltyEffective, 7)),
      });

      const penalty = await readPenalty(loan.loanId);

      // Charged on the 100,000 that stood at the deadline, not on the 40,000
      // left after the late payment.
      expect(penalty?.basisAmount).toBe(100_000);
      expect(penalty?.penaltyAmount).toBe(50_000);
    });

    it('charges nothing when the loan was never disbursed', async () => {
      await configureLendingTerms({ monthlyRateBps: 1_500, minLoanAmount: 100_000 });
      const scenario = await createLoanScenario();
      const draftId = await createDraftLoan(scenario.clientId);

      expect(await ensurePenalty(draftId, businessInstant('2027-01-01'))).toBeNull();
      expect(await readPenalty(draftId)).toBeNull();
    });

    it('charges nothing at a rate of zero', async () => {
      const scenario = await createLoanScenario();
      const loan = await createFourThousandLoan(scenario, { penaltyRateBps: 0 });

      const applied = await ensurePenalty(
        loan.loanId,
        businessInstant(loan.penaltyEffective),
      );

      // Overdue, but the business has configured no charge — and a penalty
      // row of zero would be a charge claiming to exist.
      expect(applied).toBeNull();
      expect(await readPenalty(loan.loanId)).toBeNull();

      const position = await readDelinquency(
        loan.loanId,
        businessInstant(loan.penaltyEffective),
      );

      expect(position.penaltyEligible).toBe(false);
      expect(position.penaltyProjectedAmount).toBe(0);
    });

    it('uses the loan"s own rate, not the current setting', async () => {
      const scenario = await createLoanScenario();
      // Approved at 25%.
      const loan = await createFourThousandLoan(scenario, { penaltyRateBps: 2_500 });

      // The business then doubles its penalty rate.
      await configureLendingTerms({ penaltyRateBps: 10_000 });

      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));
      const penalty = await readPenalty(loan.loanId);

      // 120,000 x 25%, from the loan's own snapshot.
      expect(penalty?.penaltyRateBps).toBe(2_500);
      expect(penalty?.basisAmount).toBe(loan.scheduledTotal);
      expect(penalty?.penaltyAmount).toBe(loan.scheduledTotal / 4);
    });
  });

  // =========================================================================
  describe('one penalty, ever', () => {
    it('is idempotent however many times it is called', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();
      const at = businessInstant(loan.penaltyEffective);

      const first = await ensurePenalty(loan.loanId, at);
      const second = await ensurePenalty(loan.loanId, at);
      const third = await ensurePenalty(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 30)),
      );

      // The same penalty, returned unchanged.
      expect(second).toBe(first);
      expect(third).toBe(first);

      const rows = await query<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.loan_penalties
          where loan_id = $1`,
        [loan.loanId],
      );

      expect(rows[0]?.n).toBe('1');

      // One amount, and one audit event.
      const penalty = await readPenalty(loan.loanId);
      expect(penalty?.penaltyAmount).toBe(50_000);

      const events = await query<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.audit_log
          where action = 'loan.penalty_applied' and entity_id = $1`,
        [loan.loanId],
      );

      expect(events[0]?.n).toBe('1');
    });

    it('is refused a second row by the database itself', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();
      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));

      const existing = await readPenalty(loan.loanId);

      // A direct insert, as the table owner, bypassing every function.
      const attempt = await query<{ ok: boolean }>(`select true as ok`).then(async () => {
        try {
          await query(
            `insert into public.loan_penalties
               (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
                effective_date, basis_amount, penalty_rate_bps, penalty_amount)
             select loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
                    effective_date, basis_amount, penalty_rate_bps, penalty_amount
               from public.loan_penalties where loan_id = $1`,
            [loan.loanId],
          );
          return 'accepted';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });

      expect(attempt).toMatch(/loan_penalties_one_per_loan/);

      // And the original is untouched.
      expect((await readPenalty(loan.loanId))?.penaltyAmount).toBe(
        existing?.penaltyAmount,
      );
    });

    it('never charges a penalty on a penalty', async () => {
      // §99. The basis is the contractual balance as at the deadline, so a
      // penalty cannot enter its own basis — and with one penalty per loan
      // there is no second charge to compute from a larger total.
      const { loan } = await loanOwing100kAtGraceEnd();
      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));

      const basis = await atClock(
        businessInstant(await shiftDate(loan.penaltyEffective, 30)),
        async (exec) =>
          exec(
            `select public.loan_outstanding_as_of($1, $2::date)::text as basis,
                    public.loan_total_outstanding($1)::text as total
               from public.loans where id = $1`,
            [loan.loanId, loan.graceEnd],
          ),
      );

      // The basis is still the contract's 100,000, while the borrower now
      // owes 150,000.
      expect(basis[0]?.basis).toBe('100000');
      expect(basis[0]?.total).toBe('150000');

      // And calling again charges nothing further.
      await ensurePenalty(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 60)),
      );

      const rows = await query<{ n: string; total: string }>(
        `select pg_catalog.count(*)::text as n,
                pg_catalog.sum(penalty_amount)::text as total
           from public.loan_penalties where loan_id = $1`,
        [loan.loanId],
      );

      expect(rows[0]?.n).toBe('1');
      expect(rows[0]?.total).toBe('50000');
    });

    it('never charges interest on a penalty', async () => {
      // §100. The charge is fixed at creation and nothing accrues on it.
      const { loan } = await loanOwing100kAtGraceEnd();
      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));

      const early = await readDelinquency(
        loan.loanId,
        businessInstant(loan.penaltyEffective),
      );
      const muchLater = await readDelinquency(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 180)),
      );

      expect(early.penaltyRemaining).toBe(50_000);
      expect(muchLater.penaltyRemaining).toBe(50_000);
      // And the contractual balance has not grown either.
      expect(muchLater.contractualOutstanding).toBe(early.contractualOutstanding);
      expect(muchLater.totalOutstanding).toBe(150_000);
    });

    it('does not alter the contract when it is charged', async () => {
      // §101. Principal, interest, the monthly breakdown and the schedule are
      // all untouched: the penalty is a new obligation, not a repricing.
      const { loan } = await loanOwing100kAtGraceEnd();

      const before = await query<{ fingerprint: string }>(
        `select md5(
                  l.principal_amount::text || ':' || l.total_interest::text || ':' ||
                  l.total_expected_repayment::text || ':' || l.interest_rate_bps::text || ':' ||
                  coalesce((select pg_catalog.string_agg(
                             i.installment_number::text || '=' || i.due_date::text || '=' ||
                             i.expected_amount::text, ',' order by i.installment_number)
                           from public.loan_installments i where i.loan_id = l.id), '') || ':' ||
                  coalesce((select pg_catalog.string_agg(
                             p.period_number::text || '=' || p.total_obligation::text,
                             ',' order by p.period_number)
                           from public.loan_periods p where p.loan_id = l.id), '')
                ) as fingerprint
           from public.loans l where l.id = $1`,
        [loan.loanId],
      );

      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));

      const after = await query<{ fingerprint: string }>(
        `select md5(
                  l.principal_amount::text || ':' || l.total_interest::text || ':' ||
                  l.total_expected_repayment::text || ':' || l.interest_rate_bps::text || ':' ||
                  coalesce((select pg_catalog.string_agg(
                             i.installment_number::text || '=' || i.due_date::text || '=' ||
                             i.expected_amount::text, ',' order by i.installment_number)
                           from public.loan_installments i where i.loan_id = l.id), '') || ':' ||
                  coalesce((select pg_catalog.string_agg(
                             p.period_number::text || '=' || p.total_obligation::text,
                             ',' order by p.period_number)
                           from public.loan_periods p where p.loan_id = l.id), '')
                ) as fingerprint
           from public.loans l where l.id = $1`,
        [loan.loanId],
      );

      expect(after[0]?.fingerprint).toBe(before[0]?.fingerprint);
    });
  });

  // =========================================================================
  describe('what cannot be done to a penalty', () => {
    async function penalisedLoan(): Promise<{
      readonly loanId: string;
      readonly penaltyId: string;
    }> {
      const { loan } = await loanOwing100kAtGraceEnd();
      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));
      const penalty = await readPenalty(loan.loanId);

      if (penalty === null) throw new Error('expected a penalty');

      return { loanId: loan.loanId, penaltyId: penalty.penaltyId };
    }

    async function attempt(sql: string, params: readonly unknown[]): Promise<string> {
      try {
        await query(sql, params);
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    it('refuses to change the amount, as the table owner', async () => {
      const { penaltyId } = await penalisedLoan();

      expect(
        await attempt(
          `update public.loan_penalties set penalty_amount = 1 where id = $1`,
          [penaltyId],
        ),
      ).toMatch(/append-only/);
    });

    it('refuses to change the basis, the rate or the dates', async () => {
      const { penaltyId } = await penalisedLoan();

      for (const column of [
        'basis_amount = 1',
        'penalty_rate_bps = 1',
        'effective_date = effective_date + 1',
        'grace_end_date = grace_end_date + 1',
        'final_due_date = final_due_date + 1',
        'grace_period_days = 99',
        'trigger_rule = trigger_rule',
        'applied_at = pg_catalog.now()',
      ]) {
        expect(
          await attempt(`update public.loan_penalties set ${column} where id = $1`, [
            penaltyId,
          ]),
          column,
        ).toMatch(/append-only/);
      }
    });

    it('refuses an UPDATE whose WHERE clause matches nothing', async () => {
      await penalisedLoan();

      // Statement-level, so the refusal does not depend on the attacker's
      // predicate finding a row.
      expect(
        await attempt(
          `update public.loan_penalties set penalty_amount = 1
            where id = '00000000-0000-4000-8000-000000000000'`,
          [],
        ),
      ).toMatch(/append-only/);
    });

    it('refuses to delete a penalty', async () => {
      const { penaltyId } = await penalisedLoan();

      expect(
        await attempt(`delete from public.loan_penalties where id = $1`, [penaltyId]),
      ).toMatch(/append-only/);

      expect(await attempt(`delete from public.loan_penalties where false`, [])).toMatch(
        /append-only/,
      );
    });

    it('refuses a forged amount that does not follow from its basis and rate', async () => {
      // The CHECK re-derives the charge, so a forged penalty is impossible
      // rather than merely unauthorized — even for the table owner, who can
      // bypass every policy in the schema.
      const { loan } = await loanOwing100kAtGraceEnd();

      expect(
        await attempt(
          `insert into public.loan_penalties
             (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
              effective_date, basis_amount, penalty_rate_bps, penalty_amount)
           select l.id, l.client_id, $2::date, 3, $3::date, $4::date, 100000, 5000, 999
             from public.loans l where l.id = $1`,
          [loan.loanId, loan.finalDue, loan.graceEnd, loan.penaltyEffective],
        ),
      ).toMatch(/loan_penalties_amount_matches_basis/);
    });

    it('refuses dates that contradict the grace period they state', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      // Grace days say three, but the grace end is the due date itself. The
      // effective date is kept consistent with the (wrong) grace end, so this
      // isolates the one constraint under test.
      expect(
        await attempt(
          `insert into public.loan_penalties
             (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
              effective_date, basis_amount, penalty_rate_bps, penalty_amount)
           select l.id, l.client_id, $2::date, 3, $2::date, $2::date + 1, 100000, 5000,
                  50000
             from public.loans l where l.id = $1`,
          [loan.loanId, loan.finalDue],
        ),
      ).toMatch(/loan_penalties_grace_end_follows_due_date/);
    });

    it('refuses an effective date that is not the day after grace', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      expect(
        await attempt(
          `insert into public.loan_penalties
             (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
              effective_date, basis_amount, penalty_rate_bps, penalty_amount)
           select l.id, l.client_id, $2::date, 3, $3::date, $3::date, 100000, 5000, 50000
             from public.loans l where l.id = $1`,
          [loan.loanId, loan.finalDue, loan.graceEnd],
        ),
      ).toMatch(/loan_penalties_effective_follows_grace/);
    });

    it('refuses a charge of zero, or a basis or rate of zero', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      // The three guards overlap by construction, and deliberately: the
      // amount must follow from the basis and the rate, so a zero basis or a
      // zero rate forces a zero amount, which `amount_positive` then refuses
      // as well. Which one fires first is not the point — that a charge of
      // nothing cannot be stored is.
      for (const [basis, rate, amount] of [
        [100_000, 0, 0],
        [0, 5_000, 0],
        [-100_000, 5_000, -50_000],
        [100_000, -5_000, -50_000],
      ] as const) {
        expect(
          await attempt(
            `insert into public.loan_penalties
               (loan_id, client_id, final_due_date, grace_period_days, grace_end_date,
                effective_date, basis_amount, penalty_rate_bps, penalty_amount)
             select l.id, l.client_id, $2::date, 3, $3::date, $4::date, $5, $6, $7
               from public.loans l where l.id = $1`,
            [
              loan.loanId,
              loan.finalDue,
              loan.graceEnd,
              loan.penaltyEffective,
              basis,
              rate,
              amount,
            ],
          ),
          `basis ${String(basis)} at ${String(rate)} bps`,
        ).toMatch(
          /loan_penalties_(basis_positive|rate_positive|amount_positive|amount_matches_basis)/,
        );
      }
    });

    it('refuses an unknown penalty type or trigger rule', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();

      expect(
        await attempt(
          `insert into public.loan_penalties
             (loan_id, client_id, penalty_type, final_due_date, grace_period_days,
              grace_end_date, effective_date, basis_amount, penalty_rate_bps,
              penalty_amount)
           select l.id, l.client_id, 'late_fee', $2::date, 3, $3::date, $4::date,
                  100000, 5000, 50000
             from public.loans l where l.id = $1`,
          [loan.loanId, loan.finalDue, loan.graceEnd, loan.penaltyEffective],
        ),
      ).toMatch(/loan_penalties_type_known/);
    });
  });

  // =========================================================================
  describe('the audit trail', () => {
    it('records the charge with its whole derivation and no actor', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();
      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));

      const events = await query<Record<string, string | null>>(
        `select actor_profile_id, actor_auth_user_id, actor_label, action, entity_type,
                new_values->>'basis_amount' as basis,
                new_values->>'penalty_rate_bps' as rate,
                new_values->>'penalty_amount' as amount,
                new_values->>'effective_date' as effective,
                new_values->>'grace_end_date' as grace_end,
                new_values->>'grace_period_days' as grace_days,
                metadata->>'actor_type' as actor_type,
                metadata->>'trigger_rule' as trigger_rule,
                metadata->>'loan_number' as loan_number
           from public.audit_log
          where action = 'loan.penalty_applied' and entity_id = $1`,
        [loan.loanId],
      );

      expect(events).toHaveLength(1);
      const event = events[0];

      // No human actor, and the trail says so explicitly rather than leaving
      // a reader to infer it from an absence.
      expect(event?.actor_profile_id).toBeNull();
      expect(event?.actor_auth_user_id).toBeNull();
      expect(event?.actor_label).toBe('system');
      expect(event?.actor_type).toBe('system');
      expect(event?.trigger_rule).toBe('grace_period_expired');

      // The complete arithmetic.
      expect(event?.basis).toBe('100000');
      expect(event?.rate).toBe('5000');
      expect(event?.amount).toBe('50000');
      expect(event?.effective).toBe(loan.penaltyEffective);
      expect(event?.grace_end).toBe(loan.graceEnd);
      expect(event?.grace_days).toBe('3');
      // The loan's reference, which is not identity evidence, so it belongs
      // in the trail: it is how somebody finds the charge again.
      expect(event?.loan_number).toMatch(/^LN\d{6}$/);
    });

    it('carries no identity data', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();
      await ensurePenalty(loan.loanId, businessInstant(loan.penaltyEffective));

      const nin = await query<{ nin: string }>(
        `select ci.nin from public.client_identities ci
           join public.loans l on l.client_id = ci.client_id
          where l.id = $1`,
        [loan.loanId],
      );

      const rows = await query<{ body: string }>(
        `select coalesce(new_values::text, '') || coalesce(metadata::text, '') as body
           from public.audit_log
          where action = 'loan.penalty_applied' and entity_id = $1`,
        [loan.loanId],
      );

      const body = rows[0]?.body ?? '';

      expect(body).not.toContain(nin[0]?.nin ?? 'NO-NIN');
      expect(body).not.toMatch(/\+2567\d{8}/);
      expect(body).not.toMatch(/date_of_birth|phone|village/);
    });

    it('records nothing at all for a loan that is merely overdue', async () => {
      // §70. Arrears are derived, so there is no event when a date passes.
      // A trail that grew by one row per loan per day would bury the events
      // that matter.
      const { loan } = await loanOwing100kAtGraceEnd();

      await readDelinquency(loan.loanId, businessInstant(loan.penaltyEffective));
      await readDelinquency(
        loan.loanId,
        businessInstant(await shiftDate(loan.penaltyEffective, 10)),
      );

      const rows = await query<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.audit_log
          where entity_id = $1
            and action in ('loan.penalty_applied', 'loan.in_arrears', 'loan.overdue')`,
        [loan.loanId],
      );

      expect(rows[0]?.n).toBe('0');
    });
  });

  // =========================================================================
  describe('the optional sweep', () => {
    it('materialises every eligible penalty and nothing else', async () => {
      const eligible = await loanOwing100kAtGraceEnd();
      const withinGrace = await loanOwing100kAtGraceEnd();
      const settled = await loanOwing100kAtGraceEnd();

      await postPayment(settled.loan.loanId, settled.scenario.secretary, {
        amount: 100_000,
        businessNow: businessInstant(await shiftDate(settled.loan.finalDue, 1)),
      });

      // Run the sweep on a date past the first loan's deadline. All three
      // loans share a schedule shape, so the clock decides: the sweep is run
      // at a date that is past grace, and the settled loan is excluded
      // because it owes nothing.
      const applied = await applyEligiblePenalties(
        businessInstant(eligible.loan.penaltyEffective),
      );

      expect(applied).toBeGreaterThanOrEqual(2);

      expect(await readPenalty(eligible.loan.loanId)).not.toBeNull();
      expect(await readPenalty(withinGrace.loan.loanId)).not.toBeNull();
      expect(await readPenalty(settled.loan.loanId)).toBeNull();
    });

    it('is a no-op when it runs twice', async () => {
      const { loan } = await loanOwing100kAtGraceEnd();
      const at = businessInstant(loan.penaltyEffective);

      await applyEligiblePenalties(at);
      const second = await applyEligiblePenalties(at);

      // Nothing left to do.
      expect(second).toBe(0);

      const rows = await query<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.loan_penalties
          where loan_id = $1`,
        [loan.loanId],
      );

      expect(rows[0]?.n).toBe('1');
    });

    it('is not callable by a session role', async () => {
      for (const fn of [
        'public.ensure_penalty_applied(uuid)',
        'public.apply_eligible_penalties()',
      ]) {
        const rows = await query<{ authenticated: boolean; anon: boolean }>(
          `select has_function_privilege('authenticated', $1, 'execute') as authenticated,
                  has_function_privilege('anon', $1, 'execute') as anon`,
          [fn],
        );

        expect(rows[0]?.authenticated, fn).toBe(false);
        expect(rows[0]?.anon, fn).toBe(false);
      }
    });
  });

  // =========================================================================
  describe('posting a payment cannot bypass the charge', () => {
    it('specification §38 — materialises the penalty before reading a balance', async () => {
      const { scenario, loan } = await loanOwing100kAtGraceEnd();

      // The borrower offers exactly the old contractual balance, a week after
      // the deadline. Without the materialisation this would clear the loan.
      const afterGrace = businessInstant(await shiftDate(loan.penaltyEffective, 7));

      const attempt = await tryPostPayment(loan.loanId, scenario.secretary, {
        amount: 100_000,
        businessNow: afterGrace,
      });

      expect(attempt.ok).toBe(true);

      const ledger = await readLedger(loan.loanId);

      // The contract is settled, the charge is not, and the loan is still
      // active.
      expect(ledger.outstanding).toBe(0);
      expect(ledger.penaltyRemaining).toBe(50_000);
      expect(ledger.totalOutstanding).toBe(50_000);
      expect(ledger.status).toBe('active');

      // And the penalty exists, charged on the deadline balance.
      expect((await readPenalty(loan.loanId))?.penaltyAmount).toBe(50_000);
    });

    it('refuses a payment larger than the penalty-inclusive balance', async () => {
      const { scenario, loan } = await loanOwing100kAtGraceEnd();
      const afterGrace = businessInstant(await shiftDate(loan.penaltyEffective, 1));

      // 150,001 is one shilling more than the whole obligation.
      const attempt = await tryPostPayment(loan.loanId, scenario.secretary, {
        amount: 150_001,
        businessNow: afterGrace,
      });

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/150000/);

      // And 150,000 exactly is accepted and clears the loan.
      const settle = await tryPostPayment(loan.loanId, scenario.secretary, {
        amount: 150_000,
        businessNow: afterGrace,
      });

      expect(settle.ok).toBe(true);
      expect((await readLedger(loan.loanId)).status).toBe('cleared');
    });

    it('specification §146 scenario G — a payment after the charge leaves UGX 110,000', async () => {
      const { scenario, loan } = await loanOwing100kAtGraceEnd();
      const afterGrace = businessInstant(await shiftDate(loan.penaltyEffective, 1));

      await ensurePenalty(loan.loanId, afterGrace);

      await postPayment(loan.loanId, scenario.secretary, {
        amount: 40_000,
        businessNow: afterGrace,
      });

      const ledger = await readLedger(loan.loanId);

      // 100,000 + 50,000 − 40,000. The payment covered contractual
      // obligations first, so the charge stands whole.
      expect(ledger.outstanding).toBe(60_000);
      expect(ledger.penaltyRemaining).toBe(50_000);
      expect(ledger.totalOutstanding).toBe(110_000);
    });

    it('cannot clear a loan while the charge is unpaid', async () => {
      // §131, at the database. The transition guard re-derives the total.
      const { scenario, loan } = await loanOwing100kAtGraceEnd();
      const afterGrace = businessInstant(await shiftDate(loan.penaltyEffective, 1));

      await postPayment(loan.loanId, scenario.secretary, {
        amount: 100_000,
        businessNow: afterGrace,
      });

      expect((await readLedger(loan.loanId)).status).toBe('active');

      // A direct attempt, as the table owner, bypassing every function.
      const forced = await (async (): Promise<string> => {
        try {
          await query(`update public.loans set status = 'cleared' where id = $1`, [
            loan.loanId,
          ]);
          return 'accepted';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      })();

      expect(forced).toMatch(/50000 shillings are still outstanding, penalty included/);
      expect((await readLedger(loan.loanId)).status).toBe('active');

      // Paying the charge clears it.
      await postPayment(loan.loanId, scenario.secretary, {
        amount: 50_000,
        businessNow: afterGrace,
      });

      expect((await readLedger(loan.loanId)).status).toBe('cleared');
    });

    it('specification §146 scenario H — reversing the final payment reopens the loan and keeps the charge', async () => {
      const { scenario, loan } = await loanOwing100kAtGraceEnd();
      const afterGrace = businessInstant(await shiftDate(loan.penaltyEffective, 1));

      // Settle everything, charge included.
      const final = await postPayment(loan.loanId, scenario.secretary, {
        amount: 150_000,
        businessNow: afterGrace,
      });

      expect((await readLedger(loan.loanId)).status).toBe('cleared');

      const penaltyBefore = await readPenalty(loan.loanId);

      await reversePayment(
        final,
        scenario.owner,
        'testing a reversal after a penalty',
        businessInstant(await shiftDate(loan.penaltyEffective, 2)),
      );

      const ledger = await readLedger(loan.loanId);

      // Reopened, with the exact obligation restored.
      expect(ledger.status).toBe('active');
      expect(ledger.outstanding).toBe(100_000);
      expect(ledger.penaltyRemaining).toBe(50_000);
      expect(ledger.totalOutstanding).toBe(150_000);

      // The charge was not recreated and was not recalculated: it is the same
      // row, with the same amount and the same basis.
      const penaltyAfter = await readPenalty(loan.loanId);

      expect(penaltyAfter?.penaltyId).toBe(penaltyBefore?.penaltyId);
      expect(penaltyAfter?.penaltyAmount).toBe(50_000);
      expect(penaltyAfter?.basisAmount).toBe(100_000);

      const rows = await query<{ n: string }>(
        `select pg_catalog.count(*)::text as n from public.loan_penalties
          where loan_id = $1`,
        [loan.loanId],
      );

      expect(rows[0]?.n).toBe('1');
    });

    it('specification §33 — a reversal can make a charge due that never was', async () => {
      // A loan settled inside its grace period, whose settling payment is
      // then withdrawn after the deadline. Exempting it because it
      // temporarily looked cleared would be an exemption anybody could
      // manufacture.
      const { scenario, loan } = await loanOwing100kAtGraceEnd();

      const settling = await postPayment(loan.loanId, scenario.secretary, {
        amount: 100_000,
        businessNow: businessInstant(await shiftDate(loan.finalDue, 2)),
      });

      expect((await readLedger(loan.loanId)).status).toBe('cleared');
      expect(await readPenalty(loan.loanId)).toBeNull();

      // Withdrawn a week after the penalty date.
      await reversePayment(
        settling,
        scenario.owner,
        'the mobile money payment never arrived',
        businessInstant(await shiftDate(loan.penaltyEffective, 7)),
      );

      const ledger = await readLedger(loan.loanId);
      const penalty = await readPenalty(loan.loanId);

      // The loan is active again, and the charge now applies — on the
      // balance that stood at the deadline in the *effective* ledger, in
      // which the reversed payment never counted.
      expect(ledger.status).toBe('active');
      expect(penalty).not.toBeNull();
      expect(penalty?.basisAmount).toBe(100_000);
      expect(penalty?.penaltyAmount).toBe(50_000);
      expect(ledger.totalOutstanding).toBe(150_000);
    });
  });
});
