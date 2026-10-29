/**
 * Upgrade the production-base schema with existing membership money and history.
 * Uses only a fixed loopback PostgreSQL database. Never reads hosted credentials.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseCommit = '56b77e97fd776bd29dc10a5411e003a28f84774f';
const database = 'lending_policy_upgrade';
const port = Number(process.env.UPGRADE_PG_PORT ?? '5433');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local PostgreSQL port.');
const admin = new pg.Client({ host: '127.0.0.1', port, user: 'lending', database: 'postgres' });
await admin.connect();
await admin.query('drop database if exists lending_policy_upgrade with (force)');
await admin.query('create database lending_policy_upgrade');
const db = new pg.Client({ host: '127.0.0.1', port, user: 'lending', database });
await db.connect();
const work = join(root, 'work');
mkdirSync(work, { recursive: true });
const report = { baseCommit, migrations: [], comparisons: [], before: null, after: null, passed: false };

const financialTables = [
  'clients', 'client_identities', 'memberships', 'membership_terms_acceptances',
  'membership_fee_receipts', 'membership_cards', 'savings_accounts',
  'savings_transactions', 'savings_withdrawal_requests', 'loans',
  'loan_periods', 'loan_schedules', 'loan_installments', 'loan_payments',
  'payment_allocations', 'loan_penalties', 'member_loan_eligibility_snapshots',
  'member_loan_savings_pledges', 'member_beneficiaries',
  'benefit_claims', 'benefit_claim_documents', 'benefit_assessment_snapshots',
  'benefit_payments', 'journal_entries', 'journal_lines', 'reference_sequences',
];
const columns = new Map();
const digest = (text) => createHash('sha256').update(text).digest('hex');

async function tableSnapshot(table, names) {
  const selected = names.map((n) => '"' + n.replaceAll('"', '""') + '"').join(', ');
  const result = await db.query(
    "select coalesce(jsonb_agg(value order by value::text), '[]'::jsonb)::text as value " +
    'from (select to_jsonb(t) as value from (select ' + selected + ' from public."' + table + '") t) q',
  );
  return result.rows[0].value;
}

async function totals() {
  return (await db.query(`select
    (select count(*)::text from public.loans) as loans,
    (select coalesce(sum(principal_amount),0)::text from public.loans) as loan_principal,
    (select coalesce(sum(total_interest),0)::text from public.loans) as loan_interest,
    (select coalesce(sum(expected_amount),0)::text from public.loan_installments) as scheduled_repayment,
    (select count(*)::text from public.loan_payments) as loan_payments,
    (select count(*)::text from public.memberships) as memberships,
    (select count(*)::text from public.membership_terms_acceptances) as acceptances,
    (select coalesce(sum(signed_amount),0)::text from public.savings_transactions) as savings_subledger,
    (select balance::text from public.ledger_account_balances where code='2100') as liability_2100,
    (select count(*)::text from public.benefit_payments) as benefit_payments,
    (select coalesce(sum(amount),0)::text from public.benefit_payments) as historical_benefit_payments,
    (select coalesce(sum(debit),0)::text from public.journal_lines) as ledger_debits,
    (select coalesce(sum(credit),0)::text from public.journal_lines) as ledger_credits`)).rows[0];
}

try {
  await db.query(readFileSync(join(root, 'tests/helpers/supabase-shim.sql'), 'utf8'));
  const migrations = readdirSync(join(root, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort();
  for (const migration of migrations.filter((n) => n < '20261028')) {
    await db.query(readFileSync(join(root, 'supabase/migrations', migration), 'utf8'));
  }

  // The historical browser seed stores local sign-in hashes; no hosted auth is involved.
  await db.query('alter table auth.users add column if not exists encrypted_password text');

  const historicalSeed = execFileSync('git', ['show', baseCommit + ':tests/e2e/harness/seed.mjs'], { cwd: root, encoding: 'utf8' })
    .replace("new URL('../../../package.json', import.meta.url)", "new URL('../package.json', import.meta.url)");
  const seedPath = join(work, 'policy-upgrade-production-seed.mjs');
  writeFileSync(seedPath, historicalSeed);
  execFileSync(process.execPath, [seedPath], {
    cwd: root,
    env: { ...process.env, E2E_DATABASE_URL: 'postgresql://lending@127.0.0.1:' + port + '/' + database },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  report.before = await totals();
  for (const key of ['loans', 'loan_payments', 'memberships', 'acceptances', 'benefit_payments']) {
    if (BigInt(report.before[key]) < 1n) throw new Error('Vacuous production-base seed: ' + key);
  }
  if (BigInt(report.before.savings_subledger) <= 0n) throw new Error('No existing savings liability to protect.');
  if (report.before.savings_subledger !== report.before.liability_2100) throw new Error('Baseline savings liability does not reconcile.');
  if (report.before.ledger_debits !== report.before.ledger_credits) throw new Error('Baseline ledger does not balance.');

  const baseline = new Map();
  for (const table of financialTables) {
    const result = await db.query(
      'select column_name from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position',
      ['public', table],
    );
    const names = result.rows.map((r) => r.column_name);
    if (names.length === 0) throw new Error('Missing baseline table ' + table);
    columns.set(table, names);
    baseline.set(table, await tableSnapshot(table, names));
  }
  const policyBefore = (await db.query(`select id, version, status, approved_at, approved_by,
    registration_fee, monthly_savings_minimum, savings_qualifying_months,
    member_loan_interest_rate_bps, member_loan_max_term_months,
    savings_to_loan_multiplier_bps, qualifying_months_consecutive,
    savings_withdrawal_with_active_loan, medical_benefit_annual_cap,
    medical_benefit_claims_per_year, benefit_waiting_period_days
    from public.membership_policy_versions order by id`)).rows;
  const accountsBefore = (await db.query('select code, balance::text as balance from public.ledger_account_balances order by code')).rows;
  const auditBefore = (await db.query('select id, to_jsonb(a)::text as value from public.audit_log a order by id')).rows;

  for (const migration of migrations.filter((n) => n >= '20261028')) {
    await db.query(readFileSync(join(root, 'supabase/migrations', migration), 'utf8'));
    report.migrations.push(migration);
  }
  for (const table of financialTables) {
    const after = await tableSnapshot(table, columns.get(table));
    const before = baseline.get(table);
    const matches = before === after;
    report.comparisons.push({ table, before: digest(before), after: digest(after), matches });
    if (!matches) throw new Error('Existing financial or identity records changed: ' + table);
  }
  const policyAfter = (await db.query(`select id, version, status, approved_at, approved_by,
    registration_fee, monthly_savings_minimum, savings_qualifying_months,
    member_loan_interest_rate_bps, member_loan_max_term_months,
    savings_to_loan_multiplier_bps, qualifying_months_consecutive,
    savings_withdrawal_with_active_loan, medical_benefit_annual_cap,
    medical_benefit_claims_per_year, benefit_waiting_period_days
    from public.membership_policy_versions where id = any($1::uuid[]) order by id`,
    [policyBefore.map((p) => p.id)])).rows;
  if (JSON.stringify(policyBefore) !== JSON.stringify(policyAfter)) throw new Error('An existing recorded policy term or approval changed.');
  const accountsAfter = (await db.query('select code, balance::text as balance from public.ledger_account_balances order by code')).rows;
  for (const row of accountsBefore) {
    if (accountsAfter.find((a) => a.code === row.code)?.balance !== row.balance) throw new Error('Existing ledger balance changed: ' + row.code);
  }
  for (const row of accountsAfter) {
    if (!accountsBefore.some((a) => a.code === row.code) && row.balance !== '0') throw new Error('A migration created a funded account.');
  }
  const auditAfter = (await db.query('select id, entity_type, to_jsonb(a)::text as value from public.audit_log a order by id')).rows;
  const oldIds = new Set(auditBefore.map((a) => String(a.id)));
  for (const row of auditBefore) {
    if (auditAfter.find((a) => String(a.id) === String(row.id))?.value !== row.value) throw new Error('Historical audit record changed.');
  }
  for (const row of auditAfter) {
    if (!oldIds.has(String(row.id)) && !['membership_policy', 'ledger_account', 'role_permission'].includes(row.entity_type)) {
      throw new Error('Upgrade wrote an operational audit event: ' + row.entity_type);
    }
  }
  report.after = await totals();
  if (JSON.stringify(report.before) !== JSON.stringify(report.after)) throw new Error('Financial reconciliation changed across the policy update.');
  report.passed = true;
  console.log('Policy upgrade financial reconciliation: ' + JSON.stringify(report.after));
  console.log('Verified ' + report.comparisons.length + ' existing financial/identity tables; all records, balances and historical approvals preserved.');
} finally {
  writeFileSync(join(work, 'policy-upgrade-financial-report.json'), JSON.stringify(report, null, 2) + '\n');
  await db.end();
  await admin.query('drop database if exists lending_policy_upgrade with (force)');
  await admin.end();
}
