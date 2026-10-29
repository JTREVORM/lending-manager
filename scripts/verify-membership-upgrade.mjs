/**
 * The upgrade path, and the financial regression that goes with it.
 *
 * ## Why this is a script and not a vitest file
 *
 * The database test project rebuilds its database from *every* migration
 * before it runs, which is exactly the clean-install case and is already
 * covered. This verifies the other case, which that setup cannot express: a
 * database that already carries the existing schema **and representative
 * financial records**, upgraded in place by the new migrations alone.
 *
 * That needs two separate migration passes against one database with a seed
 * between them, so it is driven from outside the test runner.
 *
 * ## What it proves
 *
 *   1. Every migration up to, but not including, the Polytos set applies to
 *      an empty database.
 *   2. The end-to-end seed then builds a real book on it — clients, loans,
 *      schedules, payments, penalties and journals, all written through the
 *      real functions.
 *   3. A full financial baseline is taken: loan principal, interest,
 *      penalties, schedules, payments, allocations, outstanding balances,
 *      journal entry and line counts, every ledger account balance, and the
 *      trial balance.
 *   4. The Polytos migrations — Phase 1's membership foundation, Phase 2's
 *      enrolment, consent and savings module, and Phase 3's member loans,
 *      savings eligibility and calendar-month cadence — are applied **on
 *      top**, with the data in place.
 *   5. The same baseline is taken again and compared, value by value.
 *
 * Any difference is a failure. A membership and savings module that moves a
 * shilling of somebody's loan has not been built correctly, whatever else it
 * does.
 *
 * Phase 2 widened this from one prefix to a list, which also makes it a
 * stronger check: every phase is applied in one pass, in order, exactly as a
 * real upgrade from the released schema would apply them. Phase 3 is the first
 * phase to alter a function the existing book already depends on, so it is the
 * first for which that comparison could actually fail.
 *
 *   node scripts/verify-membership-upgrade.mjs
 *
 * Exits non-zero and prints the differing rows on any mismatch.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client } = require('pg');

const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATIONS = join(PROJECT_ROOT, 'supabase', 'migrations');

/**
 * The prefixes that mark the Polytos migrations.
 *
 * A list rather than one prefix, because the released schema is the one
 * *before* Polytos — so an upgrade applies every phase, and verifying only one
 * of them would leave the others' effect on the existing book unmeasured. The
 * order matters and is the sort order of the filenames, which is also the
 * order PostgreSQL needs: Phase 2 references tables Phase 1 creates, and
 * Phase 3 references tables Phase 2 creates.
 *
 * Phase 3 is the one this check matters most for. It is the only phase that
 * **rewrites a function that computes collection dates** —
 * `generate_loan_schedule` gains a second cadence arm — so it is the only one
 * that could move a date on a loan already written. `installment_schedule`
 * below compares every collection date and every scheduled figure, loan by
 * loan, in order.
 *
 * Phase 4 adds benefits and meetings, which touch no loan at all — but it is
 * in this list for two reasons rather than one. It has to be applied *after*
 * Phase 1, because its tables reference `memberships`, and a prefix missing
 * from this list is applied as part of the "existing" schema, which is first.
 * And the claim worth measuring is exactly that it changes nothing: a phase
 * that writes a new expense account and a new journal source type is a phase
 * that could, in principle, move a trial balance.
 */
const PHASE_PREFIXES = ['20261019', '20261020', '20261021', '20261022', '20261028'];

const isPhaseMigration = (name) =>
  PHASE_PREFIXES.some((prefix) => name.startsWith(prefix));

const PORT = process.env.UPGRADE_PG_PORT ?? '5433';
const USER = process.env.UPGRADE_PG_USER ?? 'lending';
const DB = process.env.UPGRADE_PG_DB ?? 'lending_upgrade';
const URL_ = `postgresql://${USER}@127.0.0.1:${PORT}/${DB}`;

const PG_BIN = execFileSync('bash', [
  '-lc',
  'ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1',
])
  .toString()
  .trim();

const RUN_AS = process.getuid?.() === 0 ? (process.env.PGLOCAL_RUNAS ?? 'postgres') : '';

function psql(args, database = DB) {
  const command = `${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${USER}' -d '${database}' -v ON_ERROR_STOP=1 -q ${args}`;
  const shell =
    RUN_AS === '' ? command : `su ${RUN_AS} -s /bin/bash -c ${JSON.stringify(command)}`;
  execFileSync('bash', ['-lc', shell], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function log(message) {
  process.stdout.write(`  ${message}\n`);
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

/**
 * Every figure the business would notice if it moved.
 *
 * Deliberately not a checksum over whole tables: a checksum tells you
 * something changed and not what, and the point of a regression baseline is
 * to name the figure. These are the figures the brief lists, each read the
 * way the application reads it — through the same views, so a view that broke
 * would show here too.
 */
const BASELINE = {
  loan_principal: `select coalesce(sum(principal_amount), 0)::text as v from public.loans`,
  loan_interest: `select coalesce(sum(total_interest), 0)::text as v from public.loans`,
  loan_expected: `select coalesce(sum(total_expected_repayment), 0)::text as v from public.loans`,
  loan_count: `select count(*)::text as v from public.loans`,
  loan_statuses: `select status, count(*)::text as n from public.loans group by status order by status`,
  loan_rates: `select loan_number, interest_rate_bps::text as r, loan_term_months::text as t
                 from public.loans order by loan_number`,

  period_rows: `select count(*)::text as v from public.loan_periods`,
  period_totals: `select coalesce(sum(principal_portion), 0)::text as p,
                         coalesce(sum(interest), 0)::text as i,
                         coalesce(sum(total_obligation), 0)::text as t
                    from public.loan_periods`,

  installment_rows: `select count(*)::text as v from public.loan_installments`,
  installment_total: `select coalesce(sum(expected_amount), 0)::text as v
                        from public.loan_installments`,

  // Every collection date and every scheduled figure, loan by loan, in order.
  // The counts and the sums above would both survive a schedule that was
  // regenerated with the same totals on different days — which is exactly
  // what a change to the repayment engine would do, and exactly what a
  // borrower would notice first. This is the figure that refuses it.
  installment_schedule: `select l.loan_number,
                                pg_catalog.string_agg(
                                  i.due_date::text || '/' ||
                                  i.scheduled_principal::text || '/' ||
                                  i.scheduled_interest::text || '/' ||
                                  i.expected_amount::text,
                                  ',' order by i.installment_number) as v
                           from public.loan_installments i
                           join public.loans l on l.id = i.loan_id
                          group by l.loan_number
                          order by l.loan_number`,

  // The contractual breakdown each schedule was built from, the same way.
  period_breakdown: `select l.loan_number,
                            pg_catalog.string_agg(
                              p.opening_principal::text || '/' ||
                              p.principal_portion::text || '/' ||
                              p.interest::text || '/' ||
                              p.closing_principal::text,
                              ',' order by p.period_number) as v
                       from public.loan_periods p
                       join public.loans l on l.id = p.loan_id
                      group by l.loan_number
                      order by l.loan_number`,

  payment_rows: `select count(*)::text as v from public.loan_payments`,
  payment_total: `select coalesce(sum(amount), 0)::text as v from public.loan_payments`,
  allocation_rows: `select count(*)::text as v from public.payment_allocations`,
  allocation_totals: `select coalesce(sum(allocated_principal), 0)::text as p,
                             coalesce(sum(allocated_interest), 0)::text as i,
                             coalesce(sum(allocated_penalty), 0)::text as n
                        from public.payment_allocations`,

  penalty_rows: `select count(*)::text as v from public.loan_penalties`,
  penalty_total: `select coalesce(sum(penalty_amount), 0)::text as v from public.loan_penalties`,

  outstanding: `select loan_number, principal_remaining::text as p,
                       interest_remaining::text as i, penalty_remaining::text as n,
                       total_outstanding::text as t, total_paid::text as paid
                  from public.loan_balances order by loan_number`,

  journal_entries: `select count(*)::text as v from public.journal_entries`,
  journal_lines: `select count(*)::text as v from public.journal_lines`,
  journal_sums: `select coalesce(sum(debit), 0)::text as d, coalesce(sum(credit), 0)::text as c
                   from public.journal_lines`,
  journal_by_source: `select source_type, count(*)::text as n
                        from public.journal_entries group by source_type order by source_type`,

  account_balances: `select code, balance::text as v
                       from public.ledger_account_balances order by code`,

  trial_balance: `select code, total_debit::text as d, total_credit::text as c
                    from public.trial_balance order by code`,

  delinquency: `select loan_number, arrears_amount::text as a,
                       days_past_due::text as dpd, delinquency_state as s,
                       total_outstanding::text as t
                  from public.loan_delinquency order by loan_number`,

  client_count: `select count(*)::text as v from public.clients`,

  /**
   * The audit trail, row by row rather than counted.
   *
   * It was `count(*)` until Phase 3, which seeds a loan product and so writes
   * the first audit row a migration has ever written — `product.created`, by
   * the trigger that has always watched that table. A count cannot tell that
   * row apart from a migration inventing a payment, so the count was the wrong
   * assertion rather than the wrong answer.
   *
   * Compared by `compareAudit` below: every existing row must still be there,
   * unchanged, and an added row is allowed only when it is about configuration
   * the migration itself created. A new row about a loan, a payment, a client
   * or anybody's savings is a failure.
   */
  audit_trail: `select id::text as id, action, entity_type,
                       coalesce(entity_id, '') as entity_id, actor_label
                  from public.audit_log order by id`,
};

async function capture(client) {
  const snapshot = {};
  for (const [name, sql] of Object.entries(BASELINE)) {
    snapshot[name] = (await client.query(sql)).rows;
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const all = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const before = all.filter((name) => !isPhaseMigration(name));
const phase = all.filter(isPhaseMigration);

if (phase.length === 0) {
  console.error('error: no Polytos migrations found.');
  process.exit(1);
}

log(`re-creating ${DB}`);
const admin = `${PG_BIN}/psql -h 127.0.0.1 -p ${PORT} -U '${USER}' -d postgres -v ON_ERROR_STOP=1 -q`;
for (const statement of [
  `drop database if exists ${DB} with (force)`,
  `create database ${DB}`,
]) {
  const command = `${admin} -c ${JSON.stringify(statement)}`;
  execFileSync('bash', [
    '-lc',
    RUN_AS === '' ? command : `su ${RUN_AS} -s /bin/bash -c ${JSON.stringify(command)}`,
  ]);
}

log('applying the Supabase shim');
psql(`-f '${join(PROJECT_ROOT, 'tests', 'helpers', 'supabase-shim.sql')}'`);

log(`applying ${String(before.length)} existing migrations`);
for (const name of before) psql(`-f '${join(MIGRATIONS, name)}'`);

// The end-to-end harness's own additions to the shim: a password column on
// `auth.users` and the PostgREST roles. The seed writes staff logins, so it
// needs them. Applied after the migrations, as `stack.sh` applies them.
log('applying the end-to-end harness schema');
psql(
  `-f '${join(PROJECT_ROOT, 'tests', 'e2e', 'harness', 'harness.sql')}' ` +
    `-v password="'upgrade-check-only'"`,
);

/*
  The seed writes `tests/e2e/harness/fixtures.json`, the manifest the browser
  specs resolve "the loan in arrears" through — and it writes it beside
  itself, with no way to redirect it. That file belongs to the end-to-end
  database, not to this one, so seeding here replaces it with ids from a
  database no running browser suite is pointed at.

  It did exactly that once, while the browser suite was mid-run: the desktop
  project had already resolved the old ids, the mobile project resolved the
  new ones, and seven specs failed with 404s on loans that existed under
  different ids. The suite was right and this script was wrong.

  So the manifest is saved and put back — in a `finally`, because a failed
  upgrade check must not leave the browser harness pointing at this database
  either.
*/
const MANIFEST = join(PROJECT_ROOT, 'tests', 'e2e', 'harness', 'fixtures.json');
const MANIFEST_BACKUP = `${MANIFEST}.upgrade-check-backup`;
const hadManifest = existsSync(MANIFEST);

if (hadManifest) copyFileSync(MANIFEST, MANIFEST_BACKUP);

function restoreManifest() {
  if (!hadManifest) {
    if (existsSync(MANIFEST)) rmSync(MANIFEST);
    return;
  }
  copyFileSync(MANIFEST_BACKUP, MANIFEST);
  rmSync(MANIFEST_BACKUP);
}

log('seeding a representative book');
try {
  execFileSync('node', [join(PROJECT_ROOT, 'tests', 'e2e', 'harness', 'seed.mjs')], {
    env: { ...process.env, E2E_DATABASE_URL: URL_ },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} finally {
  restoreManifest();
}

const client = new Client({ connectionString: URL_ });
await client.connect();

const seeded = await client.query(
  `select (select count(*) from public.loans) as loans,
          (select count(*) from public.loan_payments) as payments,
          (select count(*) from public.journal_entries) as journals`,
);
log(
  `seeded ${seeded.rows[0].loans} loans, ${seeded.rows[0].payments} payments, ${seeded.rows[0].journals} journal entries`,
);

if (Number(seeded.rows[0].loans) === 0 || Number(seeded.rows[0].journals) === 0) {
  console.error(
    'error: the seed produced no financial records; the comparison would be vacuous.',
  );
  process.exit(1);
}

log('capturing the financial baseline');
const beforeSnapshot = await capture(client);

log(`applying ${String(phase.length)} Polytos migrations on top`);
for (const name of phase) {
  psql(`-f '${join(MIGRATIONS, name)}'`);
  log(`  ${name}`);
}

log('capturing the financial baseline again');
const afterSnapshot = await capture(client);

// The membership objects must exist afterwards, or the comparison proves
// only that nothing happened.
const created = await client.query(
  `select count(*)::int as n
     from information_schema.tables
    where table_schema = 'public'
      and table_name in ('memberships', 'membership_policy_versions',
                         'membership_status_history',
                         'membership_terms_acceptances',
                         'membership_fee_receipts', 'membership_cards',
                         'membership_consent_challenges',
                         'savings_accounts', 'savings_transactions',
                         'savings_withdrawal_requests',
                         'member_loan_eligibility_snapshots',
                         'member_loan_savings_pledges',
                         -- Polytos Phase 4.
                         'member_beneficiaries', 'member_beneficiary_identities',
                         'benefit_claims', 'benefit_claim_documents',
                         'benefit_assessment_snapshots', 'benefit_payments',
                         'membership_meetings', 'meeting_attendance',
                         'meeting_attendance_corrections',
                         'meeting_action_items')`,
);

const EXPECTED_TABLES = 22;

if (created.rows[0].n !== EXPECTED_TABLES) {
  console.error(
    `error: expected ${String(EXPECTED_TABLES)} Polytos tables after ` +
      `the upgrade, found ${String(created.rows[0].n)}.`,
  );
  process.exit(1);
}

// Every one of them empty. An upgrade that invented a membership, a savings
// account or a deposit would be an upgrade that invented a member — and
// crucially, one that invented a savings deposit would have moved money,
// which is the thing this whole script exists to rule out.
for (const table of [
  'memberships',
  'membership_terms_acceptances',
  'membership_fee_receipts',
  'membership_cards',
  'membership_consent_challenges',
  'savings_accounts',
  'savings_transactions',
  'savings_withdrawal_requests',
  // Polytos Phase 3. An upgrade that invented a member loan would have
  // invented a pledge against somebody's savings and a snapshot claiming the
  // business assessed them, which is why both are checked empty.
  'member_loan_eligibility_snapshots',
  'member_loan_savings_pledges',
  // Polytos Phase 4. An upgrade that invented a benefit payment would have
  // taken money out of the business against a claim nobody made, and one that
  // invented a beneficiary would have invented a payment instruction — which
  // is why the payment, the claim, the snapshot and the beneficiary are all
  // checked empty rather than only the first.
  'member_beneficiaries',
  'member_beneficiary_identities',
  'benefit_claims',
  'benefit_claim_documents',
  'benefit_assessment_snapshots',
  'benefit_payments',
  'membership_meetings',
  'meeting_attendance',
  'meeting_attendance_corrections',
  'meeting_action_items',
]) {
  const rows = await client.query(`select count(*)::int as n from public.${table}`);
  if (rows.rows[0].n !== 0) {
    console.error(
      `error: the upgrade wrote ${String(rows.rows[0].n)} row(s) to ${table}, which it must not.`,
    );
    process.exit(1);
  }
}

// And the savings liability account exists, at zero. Phase 2 adds `2100`;
// an upgrade that left it with a balance would mean the migration itself had
// posted something.
const liability = await client.query(
  `select coalesce(
            (select balance from public.ledger_account_balances where code = '2100'),
            -1)::int as balance`,
);
if (liability.rows[0].balance !== 0) {
  console.error(
    `error: 2100 Member Savings is ${String(liability.rows[0].balance)} after the upgrade; expected 0.`,
  );
  process.exit(1);
}

await client.end();

// ---------------------------------------------------------------------------
// The comparison
//
// Most figures are compared as whole snapshots: byte-identical, or a defect.
//
// The two that list the chart of accounts need a different comparison, and
// the reason is worth stating because the obvious one is wrong. A migration
// that adds an account — Polytos Phase 2 adds `2000`, `2100` and `4340` —
// lengthens the list without moving a shilling. Comparing the lists as
// strings reports that as a changed financial figure, which is false, and
// would report it on every future chart addition for the rest of the
// system's life.
//
// So those two assert what they actually mean:
//
//   * every account that existed before has **exactly** the same figures
//     after — no balance, debit or credit may move;
//   * any account that **appeared** is at zero on every figure, because a
//     migration that created an account with a balance in it would have
//     posted something;
//   * no account **disappeared**.
//
// That is strictly stronger than string equality on the thing that matters,
// and it stops being noisy about the thing that does not.
// ---------------------------------------------------------------------------

let failures = 0;

/** The chart-keyed snapshots, compared per account rather than as a list. */
const CHART_KEYED = new Set(['account_balances', 'trial_balance']);

/**
 * The entity types a migration may legitimately write an audit row about.
 *
 * Configuration the migration creates itself, and nothing else. A loan, a
 * payment, a client, a membership, a savings account or a journal entry is
 * somebody's money; a product or a cadence is a setting, and the audit trail
 * recording that a migration added one is the trail working correctly.
 */
const CONFIGURATION_ENTITIES = new Set([
  'loan_product',
  'repayment_frequency',
  'business_settings',
  'role_permission',
  'membership_policy',
]);

/**
 * Compare the audit trail.
 *
 * Keyed on `id`, which is `generated always as identity` and append-only, so
 * an existing row that moved or vanished is a defect however it happened.
 */
function compareAudit(beforeRows, afterRows) {
  const problems = [];
  const describe = (row) => JSON.stringify(row);

  const afterById = new Map(afterRows.map((row) => [row.id, row]));

  for (const row of beforeRows) {
    const next = afterById.get(row.id);

    if (next === undefined) {
      problems.push(`audit row ${row.id} disappeared: ${describe(row)}`);
      continue;
    }

    if (describe(row) !== describe(next)) {
      problems.push(
        `audit row ${row.id} was rewritten: ${describe(row)} -> ${describe(next)}`,
      );
    }
  }

  const beforeIds = new Set(beforeRows.map((row) => row.id));

  for (const row of afterRows) {
    if (beforeIds.has(row.id)) continue;

    if (!CONFIGURATION_ENTITIES.has(row.entity_type)) {
      problems.push(
        `the upgrade wrote an audit row about a ${row.entity_type}: ${describe(row)}; ` +
          'a migration may record configuration it creates and nothing else',
      );
    }
  }

  return problems;
}

/**
 * Compare two chart-keyed snapshots.
 *
 * Returns a list of problems, empty when the upgrade moved nothing.
 */
function compareChart(name, beforeRows, afterRows) {
  const problems = [];

  const key = (row) => row.code;
  const figures = (row) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'code')),
    );

  const beforeByCode = new Map(beforeRows.map((row) => [key(row), row]));
  const afterByCode = new Map(afterRows.map((row) => [key(row), row]));

  for (const [code, row] of beforeByCode) {
    const next = afterByCode.get(code);

    if (next === undefined) {
      problems.push(`${code} disappeared from ${name}`);
      continue;
    }

    if (figures(row) !== figures(next)) {
      problems.push(`${code} moved in ${name}: ${figures(row)} -> ${figures(next)}`);
    }
  }

  const zero = (row) =>
    Object.entries(row)
      .filter(([column]) => column !== 'code')
      .every(([, value]) => Number(value) === 0);

  for (const [code, row] of afterByCode) {
    if (beforeByCode.has(code)) continue;

    if (!zero(row)) {
      problems.push(
        `${code} was added to ${name} carrying ${figures(row)}; a new account must be at zero`,
      );
    }
  }

  return problems;
}

for (const name of Object.keys(BASELINE)) {
  if (name === 'audit_trail') {
    const problems = compareAudit(beforeSnapshot[name] ?? [], afterSnapshot[name] ?? []);

    if (problems.length === 0) {
      const added =
        (afterSnapshot[name] ?? []).length - (beforeSnapshot[name] ?? []).length;
      log(
        added === 0
          ? `unchanged: ${name}`
          : `unchanged: ${name} (${String(added)} new row(s), all configuration)`,
      );
      continue;
    }

    failures += 1;
    console.error(`\nCHANGED: ${name}`);
    for (const problem of problems) console.error(`  ${problem}`);
    continue;
  }

  if (CHART_KEYED.has(name)) {
    const problems = compareChart(
      name,
      beforeSnapshot[name] ?? [],
      afterSnapshot[name] ?? [],
    );

    if (problems.length === 0) {
      const added =
        (afterSnapshot[name] ?? []).length - (beforeSnapshot[name] ?? []).length;
      log(
        added === 0
          ? `unchanged: ${name}`
          : `unchanged: ${name} (${String(added)} new account(s), all at zero)`,
      );
      continue;
    }

    failures += 1;
    console.error(`\nCHANGED: ${name}`);
    for (const problem of problems) console.error(`  ${problem}`);
    continue;
  }

  const a = JSON.stringify(beforeSnapshot[name]);
  const b = JSON.stringify(afterSnapshot[name]);

  if (a === b) {
    log(`unchanged: ${name}`);
    continue;
  }

  failures += 1;
  console.error(`\nCHANGED: ${name}`);
  console.error(`  before: ${a}`);
  console.error(`  after:  ${b}`);
}

if (failures > 0) {
  console.error(
    `\n${String(failures)} financial figure(s) changed across the upgrade. This is a defect.`,
  );
  process.exit(1);
}

console.log(
  `\nUpgrade verified: ${String(before.length)} existing migrations, a seeded book, ` +
    `then ${String(phase.length)} new migrations. Every one of ${String(Object.keys(BASELINE).length)} ` +
    `financial figures is identical, the ${String(EXPECTED_TABLES)} membership, ` +
    `savings, member loan, benefit and meeting tables exist and are empty, and ` +
    `2100 Member Savings is zero.`,
);

// ---------------------------------------------------------------------------
// Release gate: integration into an EXISTING seeded loan book, not six new
// synthetic people. Runs only against the throwaway upgrade database.
// ---------------------------------------------------------------------------
log('verifying seeded borrower-to-membership integration on the loan book');
const bridgeDb = new Client({ connectionString: URL_ });
await bridgeDb.connect();
const loanBefore = await capture(bridgeDb);
const clientsBefore = await bridgeDb.query(
  'select count(*)::int as n from public.clients',
);
const seedEnv = {
  ...process.env,
  DATABASE_URL: URL_,
  POLYTOS_SEED_DEMO: 'yes-seed-polytos-demo-data',
  POLYTOS_DEMO_BORROWER_REUSE: 'yes-reuse-existing-demo-borrowers',
};
function runBorrowerSeed() {
  execFileSync('npx', ['tsx', 'scripts/seed-demo.ts'], {
    cwd: PROJECT_ROOT,
    env: seedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
}
runBorrowerSeed();
const linked = await bridgeDb.query(
  'select count(distinct m.client_id)::int as n from public.memberships m ' +
    "where m.notes like 'DEMONSTRATION SCENARIO %' " +
    'and exists (select 1 from public.loans l where l.client_id=m.client_id)',
);
if (linked.rows[0].n !== 6)
  throw new Error('Expected six memberships linked to EXISTING loan borrowers.');
const remaining = await bridgeDb.query(
  'select count(distinct c.id)::int as n from public.clients c ' +
    'join public.loans l on l.client_id=c.id ' +
    'where not exists(select 1 from public.memberships m where m.client_id=c.id ' +
    "and m.status in ('pending','active','suspended'))",
);
if (remaining.rows[0].n < 1)
  throw new Error('No original non-member loan borrowers remain.');
const clientsAfter = await bridgeDb.query(
  'select count(*)::int as n from public.clients',
);
if (clientsAfter.rows[0].n !== clientsBefore.rows[0].n)
  throw new Error('Borrower reuse created or deleted a client.');
const loanAfter = await capture(bridgeDb);
const untouchedKeys = [
  'loan_principal',
  'loan_interest',
  'loan_expected',
  'loan_count',
  'loan_statuses',
  'loan_rates',
  'period_rows',
  'period_totals',
  'installment_rows',
  'installment_total',
  'installment_schedule',
  'period_breakdown',
  'payment_rows',
  'payment_total',
  'allocation_rows',
  'allocation_totals',
  'penalty_rows',
  'penalty_total',
  'outstanding',
  'delinquency',
];
for (const key of untouchedKeys) {
  if (JSON.stringify(loanBefore[key]) !== JSON.stringify(loanAfter[key]))
    throw new Error('Demo integration altered pre-existing loan figure ' + key);
}
for (let attempt = 2; attempt <= 3; attempt++) {
  runBorrowerSeed();
  const afterRetry = await capture(bridgeDb);
  for (const key of Object.keys(loanAfter)) {
    if (JSON.stringify(loanAfter[key]) !== JSON.stringify(afterRetry[key]))
      throw new Error(
        'Demo integration is not idempotent: ' + key + ' after run ' + attempt,
      );
  }
}
const ledger = await bridgeDb.query(
  'select (select coalesce(sum(signed_amount),0)::bigint from public.savings_transactions)::text as subledger,' +
    " (select balance::text from public.ledger_account_balances where code='2100') as gl_balance",
);
if (ledger.rows[0].subledger !== ledger.rows[0].gl_balance)
  throw new Error('Demo member savings subledger is not equal to liability GL.');
await bridgeDb.end();
log(
  'verified: six existing borrowers enrolled, non-members retained, ' +
    'loan book untouched, full financial fixed point on runs 2 and 3, liability reconciled',
);

// Also protect existing membership money and benefit history across this update.
execFileSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'verify-policy-upgrade.mjs')], {
  env: process.env,
  stdio: 'inherit',
});
