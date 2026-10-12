import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';
import { deleteTestUsers } from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseApprovedLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import {
  postPayment,
  readMinimum,
  reversePayment,
  tryPostPayment,
} from '../helpers/payment-fixtures';
import { ensurePenalty } from '../helpers/delinquency-fixtures';

/**
 * The ledger and the lending records move together, or neither moves.
 *
 * Phase 10.3 put a `perform public.post_*_journal(...)` inside
 * `disburse_loan`, `post_payment` and `reverse_payment`. What makes that
 * worth anything is not that the journal appears — it is that a journal which
 * *cannot* appear takes the money record down with it. Several tests below
 * therefore break the ledger on purpose, by deactivating the account the
 * posting needs, and then assert that the disbursement or the payment did not
 * happen either.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('ledger posting suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await deleteTestLoans();
  await deleteTestUsers();
});

interface Entry {
  readonly id: string;
  readonly entry_number: string;
  readonly source_type: string;
  readonly entry_date: string;
}

async function entriesFor(sourceId: string): Promise<readonly Entry[]> {
  return query<Entry>(
    `select id, entry_number, source_type, entry_date::text as entry_date
       from public.journal_entries where source_id = $1 order by posted_at`,
    [sourceId],
  );
}

async function legs(entryId: string): Promise<Record<string, number>> {
  const rows = await query<{ code: string; debit: string; credit: string }>(
    `select a.code, l.debit::text, l.credit::text
       from public.journal_lines l
       join public.ledger_accounts a on a.id = l.account_id
      where l.entry_id = $1 order by l.line_number`,
    [entryId],
  );
  // Signed the way the account reads: a debit to an asset is positive.
  return Object.fromEntries(
    rows.map((r) => [r.code, Number(r.debit) - Number(r.credit)]),
  );
}

async function balance(code: string): Promise<number> {
  const row = await queryOne<{ balance: string }>(
    `select balance::text from public.ledger_account_balances where code = $1`,
    [code],
  );
  return Number(row.balance);
}

async function cashCode(kind: string): Promise<string> {
  const row = await queryOne<{ code: string }>(
    `select code from public.ledger_accounts where cash_kind = $1 limit 1`,
    [kind],
  );
  return row.code;
}

/** Take an account out of service, so the posting that needs it must fail. */
async function deactivate(kind: string): Promise<void> {
  await query(
    `update public.ledger_accounts set status = 'inactive' where cash_kind = $1`,
    [kind],
  );
}

async function reactivate(): Promise<void> {
  await query(`update public.ledger_accounts set status = 'active'`);
}

async function scenarioWithApprovedLoan(
  principal = 600_000,
): Promise<{ scenario: LoanScenario; loanId: string }> {
  const scenario = await createLoanScenario();
  const loanId = await createDraftLoan(scenario.clientId, { principal });
  await approveLoan(loanId, scenario);
  return { scenario, loanId };
}

describeDb('a disbursement and its journal are one transaction', () => {
  it('debits Loans Receivable and credits the branch Cash at Hand', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan(750_000);
    await disburseApprovedLoan(loanId, scenario);

    const entries = await entriesFor(loanId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_type).toBe('loan_disbursement');

    expect(await legs(entries[0]!.id)).toEqual({
      '1200': 750_000,
      [await cashCode('cash_at_hand')]: -750_000,
    });
  });

  it('dates the journal the day the money left, not the day it was posted', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);

    const row = await queryOne<{ same: boolean }>(
      `select (e.entry_date = (l.disbursed_at at time zone public.business_timezone())::date)
                as same
         from public.journal_entries e
         join public.loans l on l.id = e.loan_id
        where e.source_type = 'loan_disbursement' and e.source_id = $1`,
      [loanId],
    );
    expect(row.same).toBe(true);
  });

  it('refuses the disbursement when the journal cannot be posted', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await deactivate('cash_at_hand');

    try {
      await expect(disburseApprovedLoan(loanId, scenario)).rejects.toThrow(
        /no active cash_at_hand account/i,
      );
    } finally {
      await reactivate();
    }

    // The whole transaction went back: the loan is still approved, no
    // schedule exists, and no journal was left behind.
    const loan = await queryOne<{ status: string; disbursed_at: string | null }>(
      `select status, disbursed_at::text from public.loans where id = $1`,
      [loanId],
    );
    expect(loan.status).toBe('approved');
    expect(loan.disbursed_at).toBeNull();

    expect(await entriesFor(loanId)).toHaveLength(0);
    const schedule = await query(
      `select 1 from public.loan_schedules where loan_id = $1`,
      [loanId],
    );
    expect(schedule).toHaveLength(0);
  });
});

describeDb('a payment and its journal are one transaction', () => {
  it('credits receivable, interest and penalty by its own allocations', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);

    const minimum = (await readMinimum(loanId)) ?? 50_000;
    const paymentId = await postPayment(loanId, scenario.secretary, { amount: minimum });

    const entries = await entriesFor(paymentId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_type).toBe('loan_repayment');

    const posted = await legs(entries[0]!.id);
    const allocation = await queryOne<{
      amount: string;
      principal: string;
      interest: string;
      penalty: string;
    }>(
      `select p.amount::text,
              coalesce(sum(a.allocated_principal),0)::text as principal,
              coalesce(sum(a.allocated_interest),0)::text as interest,
              coalesce(sum(a.allocated_penalty),0)::text as penalty
         from public.loan_payments p
         left join public.payment_allocations a on a.payment_id = p.id
        where p.id = $1 group by p.amount`,
      [paymentId],
    );

    expect(posted[await cashCode('cash_at_hand')]).toBe(Number(allocation.amount));
    expect(posted['1200'] ?? 0).toBe(-Number(allocation.principal));
    expect(posted['4100'] ?? 0).toBe(-Number(allocation.interest));
  });

  it('refuses the payment when the journal cannot be posted', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);
    const minimum = (await readMinimum(loanId)) ?? 50_000;

    const paymentsBefore = await query(`select 1 from public.loan_payments`);
    await deactivate('mtn_mobile_money');

    let outcome;
    try {
      outcome = await tryPostPayment(loanId, scenario.secretary, {
        amount: minimum,
        method: 'mtn_mobile_money',
        externalReference: 'MTNFAIL001',
      });
    } finally {
      await reactivate();
    }

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no active mtn_mobile_money account/i);

    // No payment, no allocation, no journal. The money record cannot survive
    // its own ledger posting failing.
    expect(await query(`select 1 from public.loan_payments`)).toHaveLength(
      paymentsBefore.length,
    );
  });
});

describeDb('a reversal posts the exact contra', () => {
  it('reverses every leg and stamps the original', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);
    const minimum = (await readMinimum(loanId)) ?? 50_000;

    const cash = await cashCode('cash_at_hand');
    const cashBefore = await balance(cash);
    const receivableBefore = await balance('1200');
    const interestBefore = await balance('4100');

    const paymentId = await postPayment(loanId, scenario.secretary, { amount: minimum });
    await reversePayment(paymentId, scenario.owner);

    const entries = await entriesFor(paymentId);
    expect(entries.map((e) => e.source_type)).toEqual([
      'loan_repayment',
      'payment_reversal',
    ]);

    // Net effect of the pair is nothing at all.
    expect(await balance(cash)).toBe(cashBefore);
    expect(await balance('1200')).toBe(receivableBefore);
    expect(await balance('4100')).toBe(interestBefore);

    const stamped = await queryOne<{ reversed_by: string | null }>(
      `select reversed_by_entry_id as reversed_by from public.journal_entries
        where source_type = 'loan_repayment' and source_id = $1`,
      [paymentId],
    );
    expect(stamped.reversed_by).toBe(entries[1]!.id);
  });
});

describeDb('a penalty is charged but not yet income', () => {
  it('posts no journal when the charge is raised', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan(400_000);
    await disburseApprovedLoan(loanId, scenario);

    const penaltyIncomeBefore = await balance('4200');
    const entriesBefore = await query(`select 1 from public.journal_entries`);

    await ensurePenalty(loanId, '2099-01-01 08:00:00+03');

    const charged = await query(
      `select 1 from public.loan_penalties where loan_id = $1`,
      [loanId],
    );
    expect(charged.length).toBeGreaterThan(0);

    // Charged, and recorded — but no money moved, so under cash-basis
    // recognition there is nothing to post and no income to recognise.
    expect(await balance('4200')).toBe(penaltyIncomeBefore);
    expect(await query(`select 1 from public.journal_entries`)).toHaveLength(
      entriesBefore.length,
    );
  });
});

describeDb('Bank is a payment method', () => {
  it('lands a bank payment in the branch bank account', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);
    const minimum = (await readMinimum(loanId)) ?? 50_000;

    const bank = await cashCode('bank');
    const before = await balance(bank);

    const paymentId = await postPayment(loanId, scenario.secretary, {
      amount: minimum,
      method: 'bank',
      externalReference: 'FT26100800123',
    });

    expect(await balance(bank)).toBe(before + minimum);
    const entries = await entriesFor(paymentId);
    expect((await legs(entries[0]!.id))[bank]).toBe(minimum);
  });

  it('demands a reference, because an untraceable transfer cannot be reconciled', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);
    const minimum = (await readMinimum(loanId)) ?? 50_000;

    const outcome = await tryPostPayment(loanId, scenario.secretary, {
      amount: minimum,
      method: 'bank',
      externalReference: null,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/reference/i);
  });

  it("reaches the dashboard's method split, which once had only three columns", async () => {
    // Before 20261010000400 `dashboard_collection_summary` split today's
    // receipts into cash, MTN and Airtel. A bank transfer therefore counted
    // in `collected_today` and in none of the method columns, so the split
    // did not sum to its own total — a card disagreeing with its own detail
    // report, which is the defect §124 exists about.
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);
    const minimum = (await readMinimum(loanId)) ?? 50_000;

    await postPayment(loanId, scenario.secretary, {
      amount: minimum,
      method: 'bank',
      externalReference: 'FT26100800999',
    });

    const summary = await queryOne<{
      collected_today: string;
      cash_received: string;
      mtn_received: string;
      airtel_received: string;
      bank_received: string;
    }>(
      `select collected_today::text, cash_received::text, mtn_received::text,
              airtel_received::text, bank_received::text
         from public.dashboard_collection_summary`,
    );

    expect(Number(summary.bank_received)).toBeGreaterThanOrEqual(minimum);
    expect(
      Number(summary.cash_received) +
        Number(summary.mtn_received) +
        Number(summary.airtel_received) +
        Number(summary.bank_received),
    ).toBe(Number(summary.collected_today));
  });

  it('still refuses an unknown method', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);

    const outcome = await tryPostPayment(loanId, scenario.secretary, {
      amount: 10_000,
      method: 'cheque' as 'cash',
    });
    expect(outcome.ok).toBe(false);
  });
});

describeDb('the backfill is idempotent', () => {
  it('posts nothing the second time, and cannot double-post if it tried', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);
    await postPayment(loanId, scenario.secretary, { amount: 50_000 });

    // Only the entries that stand for an event. The backfill legitimately
    // adds the opening capital the first time it runs, because none exists
    // in a fixture database; what must not change is the event journals.
    const countBefore = (
      await query(`select 1 from public.journal_entries where source_id is not null`)
    ).length;

    const again = await queryOne<{
      disbursements: number;
      repayments: number;
      reversals: number;
    }>(`select * from public.backfill_ledger_history()`);

    expect(again.disbursements).toBe(0);
    expect(again.repayments).toBe(0);
    expect(again.reversals).toBe(0);
    expect(
      await query(`select 1 from public.journal_entries where source_id is not null`),
    ).toHaveLength(countBefore);
  });

  it('refuses a second journal for the same event at the index', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan();
    await disburseApprovedLoan(loanId, scenario);

    const branch = await queryOne<{ id: string }>(
      `select id from public.branches limit 1`,
    );
    const account = await queryOne<{ id: string }>(
      `select id from public.ledger_accounts where code = '1200'`,
    );

    await expect(
      query(
        `insert into public.journal_entries
           (entry_number, branch_id, entry_date, description, source_type, source_id)
         values ('JV-DUP-1', $1, current_date, 'Duplicate', 'loan_disbursement', $2)`,
        [branch.id, loanId],
      ),
    ).rejects.toThrow(/journal_entries_one_per_source/);

    void account;
  });
});

describeDb('the books reconcile after a full lifecycle', () => {
  it('balances the trial balance, the branch position and Loans Receivable', async () => {
    const { scenario, loanId } = await scenarioWithApprovedLoan(500_000);
    await disburseApprovedLoan(loanId, scenario);

    for (let i = 0; i < 3; i += 1) {
      const minimum = await readMinimum(loanId);
      if (minimum === null || minimum <= 0) break;
      await postPayment(loanId, scenario.secretary, {
        amount: minimum,
        method: i === 1 ? 'bank' : 'cash',
        externalReference: i === 1 ? `FT2610080${i}` : null,
      });
    }

    const trial = await queryOne<{ debits: string; credits: string }>(
      `select sum(total_debit)::text as debits, sum(total_credit)::text as credits
         from public.trial_balance`,
    );
    expect(trial.debits).toBe(trial.credits);

    // The branch view is the sum of that branch's cash accounts, not a
    // separately maintained figure.
    const position = await queryOne<{ view_total: string; account_total: string }>(
      `select (select total_liquidity from public.branch_cash_position)::text as view_total,
              (select coalesce(sum(balance),0) from public.ledger_account_balances
                where cash_kind is not null)::text as account_total`,
    );
    expect(position.view_total).toBe(position.account_total);

    // Loans Receivable is principal paid out less principal recovered, which
    // is exactly what the portfolio view already reports.
    const receivable = await queryOne<{ ledger: string; portfolio: string }>(
      `select (select balance from public.ledger_account_balances where code = '1200')::text
                as ledger,
              (select principal_outstanding from public.dashboard_portfolio_summary)::text
                as portfolio`,
    );
    expect(receivable.ledger).toBe(receivable.portfolio);

    // Cash is negative at this point, and correctly so: a fixture loan was
    // paid out of an account nobody has put money into. Deriving the opening
    // capital is what fixes that, and the figure is not chosen — it is the
    // deepest the position ever reaches. Running the backfill here posts it
    // (the disbursement and the payments are already posted and are skipped)
    // and is the test of that derivation.
    const negativeBefore = await query(
      `select 1 from public.ledger_account_balances where cash_kind is not null and balance < 0`,
    );
    expect(negativeBefore.length).toBeGreaterThan(0);

    await query(`select * from public.backfill_ledger_history()`);

    const negatives = await query(
      `select 1 from public.ledger_account_balances where cash_kind is not null and balance < 0`,
    );
    expect(negatives).toHaveLength(0);

    // And the opening entry leaves the books balanced too.
    const after = await queryOne<{ debits: string; credits: string }>(
      `select sum(total_debit)::text as debits, sum(total_credit)::text as credits
         from public.trial_balance`,
    );
    expect(after.debits).toBe(after.credits);
  });
});
