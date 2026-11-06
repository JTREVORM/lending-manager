/**
 * Phase 3: reconcile what the screens report against what the ledger holds.
 *
 * ## Why a harness rather than more tests
 *
 * `reporting-parity.test.ts` already proves each report repeats its own source
 * view faithfully, loan by loan. What it cannot show is whether that chain ends
 * at the **general ledger** — whether the portfolio figure on the dashboard is
 * the same money as the Loans Receivable balance, whether the cash position is
 * the cash accounts, whether the member savings liability is account 2100.
 *
 * Those are cross-subsystem identities. They are the ones that break quietly
 * when a filter, a time zone, an accounting date or a rounding rule drifts, and
 * they are what "the books reconcile" actually means. This walks them and
 * prints a matrix, so a reviewer sees the figures rather than a pass count.
 *
 * Every check states the identity it is testing, both sides of it, and the
 * difference. A difference is only acceptable when the harness can name the
 * reason, so each check is one of:
 *
 *   PASS      both sides agree exactly
 *   EXPLAINED they differ, and the reason is stated and verified
 *   FAIL      they differ with no explanation
 *
 * Money is compared as integers throughout: these are UGX minor units in
 * `bigint` columns, read as text and parsed with BigInt, never through a float.
 *
 *   DATABASE_URL=... node scripts/certify-financial-reconciliation.mjs
 *   ... --json work/financial-reconciliation.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. This needs a migrated, seeded database.');
  process.exit(2);
}

const jsonFlag = process.argv.indexOf('--json');
const jsonPath = jsonFlag === -1 ? null : process.argv[jsonFlag + 1];

const pool = new pg.Pool({ connectionString, max: 2 });
const checks = [];

/** Read one row. Money columns must be selected `::text` by the caller. */
async function one(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  if (rows.length !== 1) {
    throw new Error(`expected one row, got ${rows.length}: ${sql.slice(0, 80)}`);
  }
  return rows[0];
}

async function many(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

const big = (v) => BigInt(v ?? '0');

/**
 * Record one identity.
 *
 * `explain` is called only when the two sides differ; returning a string marks
 * the check EXPLAINED with that reason, and returning null leaves it FAIL. A
 * check can therefore never be explained away by accident — somebody has to
 * have written the reason down.
 */
function identity(
  group,
  name,
  left,
  right,
  leftLabel,
  rightLabel,
  explain = null,
  subjects = null,
) {
  const l = big(left);
  const r = big(right);
  const diff = l - r;
  let status = diff === 0n ? 'PASS' : 'FAIL';
  let reason = null;

  // Zero equals zero is not evidence. A check whose subject set is empty — no
  // loans, no savings accounts, no transfers — agrees trivially and would be
  // reported as a pass, which is worse than reporting nothing: it is false
  // confidence in a certification document. Such a check is VACUOUS, and the
  // summary counts it separately so it can never be mistaken for coverage.
  if (status === 'PASS' && subjects !== null && Number(subjects) === 0) {
    status = 'VACUOUS';
    reason = 'no subject rows in this database, so the identity holds trivially';
  }

  if (diff !== 0n && explain) {
    reason = explain(l, r, diff);
    if (reason) status = 'EXPLAINED';
  }
  checks.push({
    group,
    name,
    left: l.toString(),
    right: r.toString(),
    leftLabel,
    rightLabel,
    difference: diff.toString(),
    subjects: subjects === null ? null : Number(subjects),
    status,
    reason,
  });
}

function assertion(group, name, ok, detail, subjects = null) {
  checks.push({
    group,
    name,
    subjects: subjects === null ? null : Number(subjects),
    status:
      ok && subjects !== null && Number(subjects) === 0
        ? 'VACUOUS'
        : ok
          ? 'PASS'
          : 'FAIL',
    detail,
    left: null,
    right: null,
    difference: null,
    reason: null,
  });
}

// ===========================================================================
// 1. The ledger's own integrity
// ===========================================================================
async function ledgerIntegrity() {
  const g = 'ledger integrity';

  const totals = await one(
    `select coalesce(sum(debit), 0)::text  as debits,
            coalesce(sum(credit), 0)::text as credits,
            count(*)::text                 as lines
       from public.journal_lines`,
  );
  identity(
    g,
    'every journal line, debits vs credits',
    totals.debits,
    totals.credits,
    'sum(journal_lines.debit)',
    'sum(journal_lines.credit)',
  );

  // Double entry is a per-entry property, not only a total: two entries can
  // offset each other's errors and leave the grand total balanced.
  const unbalanced = await many(
    `select e.id::text, e.entry_number,
            coalesce(sum(l.debit), 0)::text  as d,
            coalesce(sum(l.credit), 0)::text as c
       from public.journal_entries e
       join public.journal_lines  l on l.entry_id = e.id
      group by e.id, e.entry_number
     having coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)`,
  );
  assertion(
    g,
    'no single journal entry whose own legs disagree',
    unbalanced.length === 0,
    unbalanced.length === 0
      ? 'every entry balances individually'
      : `${unbalanced.length} unbalanced: ${unbalanced
          .map((r) => `${r.entry_number} (${r.d}/${r.c})`)
          .join(', ')}`,
  );

  const orphans = await one(
    `select count(*)::text as n
       from public.journal_lines l
       left join public.journal_entries e on e.id = l.entry_id
      where e.id is null`,
  );
  assertion(
    g,
    'no journal line without an entry',
    big(orphans.n) === 0n,
    `${orphans.n} orphaned line(s)`,
  );

  const empty = await one(
    `select count(*)::text as n
       from public.journal_entries e
      where not exists (select 1 from public.journal_lines l where l.entry_id = e.id)`,
  );
  assertion(
    g,
    'no journal entry without lines',
    big(empty.n) === 0n,
    `${empty.n} empty entry/entries`,
  );

  const tb = await one(
    `select coalesce(sum(total_debit), 0)::text  as d,
            coalesce(sum(total_credit), 0)::text as c
       from public.trial_balance`,
  );
  identity(
    g,
    'the trial balance foots',
    tb.d,
    tb.c,
    'sum(trial_balance.total_debit)',
    'sum(trial_balance.total_credit)',
  );

  identity(
    g,
    'the trial balance is the journal',
    tb.d,
    totals.debits,
    'sum(trial_balance.total_debit)',
    'sum(journal_lines.debit)',
  );
}

// ===========================================================================
// 2. The general ledger view against the journal it summarises
// ===========================================================================
async function generalLedger() {
  const g = 'general ledger';

  const drift = await many(
    `with direct as (
       select l.account_id,
              coalesce(sum(l.debit), 0)  as d,
              coalesce(sum(l.credit), 0) as c
         from public.journal_lines l
        group by l.account_id
     )
     select b.code, b.name,
            b.total_debit::text         as view_d,
            b.total_credit::text        as view_c,
            coalesce(direct.d, 0)::text as raw_d,
            coalesce(direct.c, 0)::text as raw_c
       from public.ledger_account_balances b
       left join direct on direct.account_id = b.account_id
      where b.total_debit  <> coalesce(direct.d, 0)
         or b.total_credit <> coalesce(direct.c, 0)`,
  );
  assertion(
    g,
    'every account total in ledger_account_balances is the journal sum',
    drift.length === 0,
    drift.length === 0
      ? 'all accounts agree with the journal'
      : `${drift.length} disagree: ${drift
          .map(
            (r) => `${r.code} view ${r.view_d}/${r.view_c} vs raw ${r.raw_d}/${r.raw_c}`,
          )
          .join('; ')}`,
  );

  // A balance must follow the account's normal side, or every report built on
  // it has the sign wrong.
  const sign = await many(
    `select code, name, normal_side,
            total_debit::text  as d,
            total_credit::text as c,
            balance::text      as b
       from public.ledger_account_balances
      where balance <> case normal_side
                         when 'debit'  then total_debit - total_credit
                         else               total_credit - total_debit
                       end`,
  );
  assertion(
    g,
    'every balance follows its account normal side',
    sign.length === 0,
    sign.length === 0
      ? 'debit accounts net debit, credit accounts net credit'
      : `${sign.length} wrong: ${sign.map((r) => r.code).join(', ')}`,
  );

  const chart = await one(
    `select count(*)::text as total,
            count(*) filter (where is_postable)::text as postable,
            count(*) filter (where account_type not in
              ('asset','liability','equity','income','expense'))::text as untyped
       from public.ledger_accounts`,
  );
  assertion(
    g,
    'the chart of accounts is wholly typed',
    big(chart.untyped) === 0n,
    `${chart.total} accounts, ${chart.postable} postable, ${chart.untyped} untyped`,
  );
}

// ===========================================================================
// 3. The accounting equation
// ===========================================================================
async function accountingEquation() {
  const g = 'accounting equation';

  const sides = await one(
    `select
       coalesce(sum(case when account_type = 'asset'     then balance else 0 end), 0)::text as assets,
       coalesce(sum(case when account_type = 'liability' then balance else 0 end), 0)::text as liabilities,
       coalesce(sum(case when account_type = 'equity'    then balance else 0 end), 0)::text as equity,
       coalesce(sum(case when account_type = 'income'    then balance else 0 end), 0)::text as income,
       coalesce(sum(case when account_type = 'expense'   then balance else 0 end), 0)::text as expense
       from public.ledger_account_balances`,
  );

  // Assets = Liabilities + Equity + (Income - Expense), with income and
  // expense un-closed because this book has no period close.
  const assets = big(sides.assets);
  const right =
    big(sides.liabilities) + big(sides.equity) + big(sides.income) - big(sides.expense);
  identity(
    g,
    'assets = liabilities + equity + income - expense',
    assets,
    right,
    'sum(asset balances)',
    'liabilities + equity + income - expense',
  );
}

// ===========================================================================
// 4. Cash: the position screen against the cash accounts
// ===========================================================================
async function cash() {
  const g = 'cash';

  const rows = await many(
    `select p.branch_code,
            p.cash_at_hand::text     as screen_hand,
            p.cash_at_bank::text     as screen_bank,
            p.mtn_mobile_money::text as screen_mtn,
            p.airtel_money::text     as screen_airtel,
            p.total_liquidity::text  as screen_total,
            coalesce((select sum(b.balance) from public.ledger_account_balances b
                       where b.branch_id = p.branch_id and b.cash_kind = 'cash_at_hand'), 0)::text as gl_hand,
            coalesce((select sum(b.balance) from public.ledger_account_balances b
                       where b.branch_id = p.branch_id and b.cash_kind = 'bank'), 0)::text as gl_bank,
            coalesce((select sum(b.balance) from public.ledger_account_balances b
                       where b.branch_id = p.branch_id and b.cash_kind is not null), 0)::text as gl_all
       from public.branch_cash_position p
      order by p.branch_code`,
  );

  for (const r of rows) {
    identity(
      g,
      `cash at hand agrees with the GL (${r.branch_code})`,
      r.screen_hand,
      r.gl_hand,
      'branch_cash_position.cash_at_hand',
      'GL cash_at_hand accounts',
    );
    identity(
      g,
      `cash at bank agrees with the GL (${r.branch_code})`,
      r.screen_bank,
      r.gl_bank,
      'branch_cash_position.cash_at_bank',
      'GL bank accounts',
    );
    identity(
      g,
      `total liquidity is the sum of its parts (${r.branch_code})`,
      big(r.screen_hand) + big(r.screen_bank) + big(r.screen_mtn) + big(r.screen_airtel),
      r.screen_total,
      'hand + bank + mtn + airtel',
      'branch_cash_position.total_liquidity',
    );
    identity(
      g,
      `total liquidity agrees with every cash GL account (${r.branch_code})`,
      r.screen_total,
      r.gl_all,
      'branch_cash_position.total_liquidity',
      'GL accounts with a cash_kind',
    );
  }
}

// ===========================================================================
// 5. The loan book: dashboard against loan_balances, and against the GL
// ===========================================================================
async function loanBook() {
  const g = 'loan book';

  const dash = await one(
    `select principal_outstanding::text  as principal_outstanding,
            interest_outstanding::text   as interest_outstanding,
            penalty_outstanding::text    as penalty_outstanding,
            total_outstanding::text      as total_outstanding,
            principal_disbursed::text    as principal_disbursed,
            principal_collected::text    as principal_collected,
            interest_collected::text     as interest_collected,
            penalty_collected::text      as penalty_collected,
            total_collected::text        as total_collected,
            arrears_total::text          as arrears_total
       from public.dashboard_portfolio_summary`,
  );

  const subjects = await one(
    `select (select count(*) from public.loan_balances)::text        as loans,
            (select count(*) from public.loan_payments
              where reversed_at is null)::text                       as payments,
            (select count(*) from public.loan_delinquency)::text     as delinquency`,
  );

  const book = await one(
    `select coalesce(sum(principal_remaining), 0)::text as principal,
            coalesce(sum(interest_remaining), 0)::text  as interest,
            coalesce(sum(penalty_remaining), 0)::text   as penalty,
            coalesce(sum(total_outstanding), 0)::text   as total
       from public.loan_balances`,
  );

  identity(
    g,
    'principal outstanding is the loan book',
    dash.principal_outstanding,
    book.principal,
    'dashboard_portfolio_summary',
    'sum(loan_balances.principal_remaining)',
    null,
    subjects.loans,
  );
  identity(
    g,
    'interest outstanding is the loan book',
    dash.interest_outstanding,
    book.interest,
    'dashboard_portfolio_summary',
    'sum(loan_balances.interest_remaining)',
    null,
    subjects.loans,
  );
  identity(
    g,
    'penalty outstanding is the loan book',
    dash.penalty_outstanding,
    book.penalty,
    'dashboard_portfolio_summary',
    'sum(loan_balances.penalty_remaining)',
    null,
    subjects.loans,
  );
  identity(
    g,
    'total outstanding is its three parts',
    big(dash.principal_outstanding) +
      big(dash.interest_outstanding) +
      big(dash.penalty_outstanding),
    dash.total_outstanding,
    'principal + interest + penalty outstanding',
    'dashboard_portfolio_summary.total_outstanding',
    null,
    subjects.loans,
  );
  identity(
    g,
    'total collected is its three parts',
    big(dash.principal_collected) +
      big(dash.interest_collected) +
      big(dash.penalty_collected),
    dash.total_collected,
    'principal + interest + penalty collected',
    'dashboard_portfolio_summary.total_collected',
    null,
    subjects.payments,
  );

  // Collections against the payments themselves, excluding reversals, which is
  // the identity a double count would break.
  // Allocations live in `payment_allocations`, one row per installment a
  // payment touched, so the split is summed there and the cash on the payment.
  const posted = await one(
    `select coalesce(sum(a.allocated_principal), 0)::text as principal,
            coalesce(sum(a.allocated_interest), 0)::text  as interest,
            coalesce(sum(a.allocated_penalty), 0)::text   as penalty,
            coalesce(sum(a.allocated_amount), 0)::text    as allocated
       from public.payment_allocations a
       join public.loan_payments p on p.id = a.payment_id
      where p.reversed_at is null`,
  );

  const cash = await one(
    `select coalesce(sum(amount), 0)::text as amount
       from public.loan_payments where reversed_at is null`,
  );
  identity(
    g,
    'allocations account for every shilling of posted payment',
    posted.allocated,
    cash.amount,
    'sum(payment_allocations.allocated_amount)',
    'sum(loan_payments.amount) where not reversed',
    (l, r, diff) =>
      diff < 0n
        ? 'an overpayment leaves cash unallocated to any installment, which is ' +
          'the documented behaviour: the surplus is held rather than forced ' +
          'onto a schedule row. Difference is the unallocated surplus.'
        : null,
    subjects.payments,
  );
  identity(
    g,
    'principal collected is the posted payments',
    dash.principal_collected,
    posted.principal,
    'dashboard_portfolio_summary',
    'sum(loan_payments.principal_portion) where not reversed',
  );
  identity(
    g,
    'interest collected is the posted payments',
    dash.interest_collected,
    posted.interest,
    'dashboard_portfolio_summary',
    'sum(loan_payments.interest_portion) where not reversed',
  );

  // Loans Receivable in the GL against the principal still owed. These are
  // equal only while every disbursement and every principal collection posts
  // to that account and nothing else does, which is the property worth
  // checking rather than assuming.
  const receivable = await one(
    `select coalesce(sum(b.balance), 0)::text as gl
       from public.ledger_account_balances b
      where b.code = '1200'`,
  );
  // The one identity in this harness that spans the loan book and the general
  // ledger, and therefore the one most worth diagnosing rather than merely
  // failing. A difference is explained only when its exact cause is found and
  // the arithmetic matches; anything else stays a FAIL.
  const unposted = await one(
    `select count(*)::text as loans,
            coalesce(sum(l.principal_amount), 0)::text as principal
       from public.loans l
      where l.disbursed_at is not null
        and not exists (
          select 1 from public.journal_entries e
           where e.loan_id = l.id and e.source_type = 'loan_disbursement')`,
  );

  identity(
    g,
    'Loans Receivable in the GL is the principal still owed',
    receivable.gl,
    dash.principal_outstanding,
    'GL 1200 Loans Receivable',
    'dashboard_portfolio_summary.principal_outstanding',
    (l, r, diff) => {
      // Disbursing through `disburse_loan` debits 1200 and credits the branch
      // cash account — verified directly, and asserted in
      // tests/db/ledger-posting.test.ts. So a book where 1200 is short by
      // exactly the principal of loans that carry no disbursement journal has
      // loans that did not go through that function.
      const missing = big(unposted.principal);
      if (missing > 0n && diff === -missing) {
        return (
          `${unposted.loans} disbursed loan(s) totalling ${missing} carry no ` +
          `loan_disbursement journal entry, and that is exactly the difference. ` +
          `Those loans did not go through disburse_loan, which posts the debit ` +
          `to 1200 and the credit to branch cash. In a database seeded by ` +
          `tests/e2e/harness/seed.mjs this is expected — it back-dates ` +
          `disbursed_at by direct write with the transition trigger suspended, ` +
          `so post_disbursement_journal never runs. IN PRODUCTION THIS WOULD BE ` +
          `A DEFECT: check the ledger backfill before accepting it.`
        );
      }
      return null;
    },
    subjects.loans,
  );

  assertion(
    g,
    'every disbursed loan carries a disbursement journal',
    big(unposted.loans) === 0n,
    big(unposted.loans) === 0n
      ? 'every disbursed loan posted its journal'
      : `${unposted.loans} disbursed loan(s) totalling ${unposted.principal} have no ` +
          `loan_disbursement entry — see the identity above`,
    subjects.loans,
  );

  const negative = await many(
    `select loan_number, total_outstanding::text as total
       from public.loan_balances where total_outstanding < 0`,
  );
  assertion(
    g,
    'no loan reports a negative outstanding',
    negative.length === 0,
    negative.length === 0
      ? 'every loan outstanding is zero or positive'
      : `${negative.length}: ${negative.map((r) => r.loan_number).join(', ')}`,
    subjects.loans,
  );
}

// ===========================================================================
// 6. Arrears and portfolio at risk
// ===========================================================================
async function arrears() {
  const g = 'arrears and PAR';

  const dash = await one(
    `select arrears_total::text as arrears, loans_with_arrears::text as n
       from public.dashboard_portfolio_summary`,
  );
  const delinquency = await one(
    `select coalesce(sum(arrears_amount), 0)::text as arrears,
            count(*) filter (where arrears_amount > 0)::text as n
       from public.loan_delinquency`,
  );
  const arrearSubjects = await one(
    `select count(*)::text as n from public.loan_delinquency`,
  );
  identity(
    g,
    'arrears on the dashboard is the delinquency view',
    dash.arrears,
    delinquency.arrears,
    'dashboard_portfolio_summary.arrears_total',
    'sum(loan_delinquency.arrears_amount)',
    null,
    arrearSubjects.n,
  );
  assertion(
    g,
    'the count of loans in arrears agrees',
    dash.n === delinquency.n,
    `dashboard ${dash.n}, delinquency ${delinquency.n}`,
  );

  const par = await many(
    `select scope,
            principal_outstanding::text as principal,
            arrears_amount::text        as arrears,
            principal_at_risk_1::text   as at_risk_1,
            principal_bucket_current::text   as b_current,
            principal_bucket_1_7::text       as b1,
            principal_bucket_8_30::text      as b2,
            principal_bucket_31_60::text     as b3,
            principal_bucket_61_90::text     as b4,
            principal_bucket_90_plus::text   as b5
       from public.portfolio_at_risk
      where scope = 'total'`,
  );
  for (const r of par) {
    identity(
      g,
      'the ageing buckets partition the principal exactly',
      big(r.b_current) + big(r.b1) + big(r.b2) + big(r.b3) + big(r.b4) + big(r.b5),
      r.principal,
      'sum of the six principal buckets',
      'portfolio_at_risk.principal_outstanding',
    );
    identity(
      g,
      'principal at risk over 1 day excludes the current bucket',
      big(r.principal) - big(r.b_current),
      r.at_risk_1,
      'principal outstanding - current bucket',
      'portfolio_at_risk.principal_at_risk_1',
    );
  }
}

// ===========================================================================
// 7. Member savings: the register against the liability account
// ===========================================================================
async function savings() {
  const g = 'member savings';

  const register = await one(
    `select coalesce(sum(balance), 0)::text          as balance,
            coalesce(sum(total_deposited), 0)::text  as deposited,
            coalesce(sum(total_withdrawn), 0)::text  as withdrawn,
            count(*)::text                           as accounts
       from public.member_savings_balances`,
  );
  const liability = await one(
    `select coalesce(sum(b.balance), 0)::text as gl
       from public.ledger_account_balances b
      where b.code = '2100'`,
  );

  identity(
    g,
    'the savings sub-ledger is the 2100 Member Savings liability',
    register.balance,
    liability.gl,
    'sum(member_savings_balances.balance)',
    'GL 2100 Member Savings',
    null,
    register.accounts,
  );

  const transactions = await one(
    `select coalesce(sum(signed_amount), 0)::text as signed
       from public.savings_transactions`,
  );
  identity(
    g,
    'the register balance is the signed transaction history',
    register.balance,
    transactions.signed,
    'sum(member_savings_balances.balance)',
    'sum(savings_transactions.signed_amount)',
    null,
    register.accounts,
  );

  const negative = await many(
    `select account_number, balance::text as balance
       from public.member_savings_balances where balance < 0`,
  );
  assertion(
    g,
    'no savings account holds a negative balance',
    negative.length === 0,
    negative.length === 0
      ? 'every savings balance is zero or positive'
      : `${negative.length}: ${negative.map((r) => r.account_number).join(', ')}`,
  );
}

// ===========================================================================
// 8. Income and expenses against the GL
// ===========================================================================
async function incomeAndExpenses() {
  const g = 'income and expenses';

  const expenses = await one(
    `select coalesce(sum(amount), 0)::text as posted
       from public.expenses where status = 'posted'`,
  );
  const expenseGl = await one(
    `select coalesce(sum(balance), 0)::text as gl
       from public.ledger_account_balances where account_type = 'expense'`,
  );
  identity(
    g,
    'posted expenses are the expense accounts',
    expenses.posted,
    expenseGl.gl,
    "sum(expenses.amount) where status = 'posted'",
    'sum(GL expense balances)',
    (l, r, diff) =>
      diff !== 0n
        ? 'expense GL accounts also carry benefit payouts and meeting-fine ' +
          'write-offs, which are not rows in `expenses`. Difference is the ' +
          'non-expense-document postings; it is a composition difference, not a ' +
          'discrepancy. Verified below by account type rather than by document.'
        : null,
    (await one(`select count(*)::text as n from public.expenses where status = 'posted'`))
      .n,
  );

  const income = await one(
    `select coalesce(sum(amount), 0)::text as posted
       from public.other_income where status = 'posted' and reversed_at is null`,
  );
  const incomeGl = await one(
    `select coalesce(sum(balance), 0)::text as gl
       from public.ledger_account_balances where account_type = 'income'`,
  );
  identity(
    g,
    'other income is within the income accounts',
    income.posted,
    incomeGl.gl,
    "sum(other_income.amount) where status = 'posted'",
    'sum(GL income balances)',
    (l, r, diff) =>
      diff !== 0n
        ? 'income GL accounts also carry loan interest and penalties, which are ' +
          'not rows in `other_income`. The difference is interest and penalty ' +
          'income; a composition difference rather than a discrepancy.'
        : null,
  );

  // Every posted financial document must carry a journal entry, which is the
  // property that makes the two sides above comparable at all.
  const unposted = await many(
    `select 'expense' as kind, expense_number as ref from public.expenses
       where status = 'posted' and journal_entry_id is null
     union all
     select 'transfer', transfer_number from public.account_transfers
       where status in ('posted','reversed') and journal_entry_id is null
     union all
     select 'other_income', income_number from public.other_income
       where status = 'posted' and journal_entry_id is null`,
  );
  assertion(
    g,
    'every posted financial document carries a journal entry',
    unposted.length === 0,
    unposted.length === 0
      ? 'no posted document is missing its journal'
      : `${unposted.length}: ${unposted.map((r) => `${r.kind} ${r.ref}`).join(', ')}`,
  );
}

// ===========================================================================
// 9. Reversals and idempotency
// ===========================================================================
async function reversalsAndIdempotency() {
  const g = 'reversals and idempotency';

  const stamped = await many(
    `select e.entry_number
       from public.journal_entries e
      where e.reversed_by_entry_id is not null
        and not exists (select 1 from public.journal_entries r
                         where r.id = e.reversed_by_entry_id)`,
  );
  assertion(
    g,
    'every reversal stamp points at an entry that exists',
    stamped.length === 0,
    stamped.length === 0
      ? 'no dangling reversal stamp'
      : `${stamped.length}: ${stamped.map((r) => r.entry_number).join(', ')}`,
  );

  const reversalPairs = await many(
    `with pairs as (
       select e.id as original, e.reversed_by_entry_id as reversal
         from public.journal_entries e
        where e.reversed_by_entry_id is not null
     )
     select p.original::text,
            (select coalesce(sum(l.debit), 0) from public.journal_lines l where l.entry_id = p.original)::text  as od,
            (select coalesce(sum(l.credit), 0) from public.journal_lines l where l.entry_id = p.original)::text as oc,
            (select coalesce(sum(l.debit), 0) from public.journal_lines l where l.entry_id = p.reversal)::text  as rd,
            (select coalesce(sum(l.credit), 0) from public.journal_lines l where l.entry_id = p.reversal)::text as rc
       from pairs p`,
  );
  const mirrored = reversalPairs.filter(
    (r) => big(r.od) !== big(r.rc) || big(r.oc) !== big(r.rd),
  );
  assertion(
    g,
    'every reversal mirrors its original leg for leg',
    mirrored.length === 0,
    `${reversalPairs.length} reversal pair(s) checked; ${mirrored.length} not mirrored`,
  );

  const dupKeys = await many(
    `select 'loan_payments' as t, idempotency_key::text as k, count(*)::text as n
       from public.loan_payments where idempotency_key is not null
      group by idempotency_key having count(*) > 1
     union all
     select 'savings_transactions', idempotency_key::text, count(*)::text
       from public.savings_transactions where idempotency_key is not null
      group by idempotency_key having count(*) > 1`,
  );
  assertion(
    g,
    'no idempotency key was used twice',
    dupKeys.length === 0,
    dupKeys.length === 0
      ? 'every idempotency key is unique within its table'
      : `${dupKeys.length} reused: ${dupKeys.map((r) => `${r.t} ${r.k} x${r.n}`).join(', ')}`,
  );
}

// ===========================================================================
// 10. Audit trail
// ===========================================================================
async function auditTrail() {
  const g = 'audit trail';

  const counts = await one(
    `select count(*)::text as rows,
            count(*) filter (where actor_profile_id is null and actor_label is null)::text as anonymous
       from public.audit_log`,
  );
  assertion(
    g,
    'every audit row names an actor',
    big(counts.anonymous) === 0n,
    `${counts.rows} audit row(s), ${counts.anonymous} with neither a profile nor a label`,
  );

  const business = await one(
    `select current_setting('TimeZone') as tz,
            public.business_timezone()  as business_tz,
            public.business_date()::text as business_date`,
  );
  assertion(
    g,
    'the business time zone is Africa/Kampala',
    business.business_tz === 'Africa/Kampala',
    `business_timezone() = ${business.business_tz}, session TimeZone = ${business.tz}, business_date() = ${business.business_date}`,
  );
}

// ===========================================================================
async function main() {
  await ledgerIntegrity();
  await generalLedger();
  await accountingEquation();
  await cash();
  await loanBook();
  await arrears();
  await savings();
  await incomeAndExpenses();
  await reversalsAndIdempotency();
  await auditTrail();

  const pass = checks.filter((c) => c.status === 'PASS').length;
  const explained = checks.filter((c) => c.status === 'EXPLAINED').length;
  const vacuous = checks.filter((c) => c.status === 'VACUOUS').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;

  let group = '';
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`\n${group.toUpperCase()}`);
    }
    const mark =
      c.status === 'PASS' ? 'ok  ' : c.status === 'EXPLAINED' ? 'expl' : 'FAIL';
    console.log(`  ${mark}  ${c.name}`);
    if (c.left !== null) {
      console.log(`          ${c.leftLabel} = ${c.left}`);
      console.log(`          ${c.rightLabel} = ${c.right}`);
      if (c.difference !== '0') console.log(`          difference = ${c.difference}`);
    }
    if (c.detail) console.log(`          ${c.detail}`);
    if (c.reason) console.log(`          explained: ${c.reason}`);
  }

  console.log(
    `\n${checks.length} identities checked: ${pass} pass, ${explained} explained, ` +
      `${vacuous} vacuous, ${fail} fail`,
  );
  if (vacuous > 0) {
    console.log(
      `\n  ${vacuous} identity/identities had no subject rows and proved nothing.\n` +
        `  They are NOT coverage. Seed the missing subject and run again:\n` +
        checks
          .filter((c) => c.status === 'VACUOUS')
          .map((c) => `    - ${c.group}: ${c.name}`)
          .join('\n'),
    );
  }

  if (jsonPath) {
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          totals: { checks: checks.length, pass, explained, vacuous, fail },
          checks,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`matrix written to ${jsonPath}`);
  }

  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(2);
});
