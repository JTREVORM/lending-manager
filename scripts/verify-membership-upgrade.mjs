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
 *   1. Every migration up to, but not including, the Polytos Phase 1 set
 *      applies to an empty database.
 *   2. The end-to-end seed then builds a real book on it — clients, loans,
 *      schedules, payments, penalties and journals, all written through the
 *      real functions.
 *   3. A full financial baseline is taken: loan principal, interest,
 *      penalties, schedules, payments, allocations, outstanding balances,
 *      journal entry and line counts, every ledger account balance, and the
 *      trial balance.
 *   4. The Polytos Phase 1 migrations are applied **on top**, with the data
 *      in place.
 *   5. The same baseline is taken again and compared, value by value.
 *
 * Any difference is a failure. A membership foundation that moves a shilling
 * of somebody's loan has not been built correctly, whatever else it does.
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

/** The prefix that marks the migrations this phase adds. */
const PHASE_PREFIX = '20261019';

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
  audit_count: `select count(*)::text as v from public.audit_log`,
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

const before = all.filter((name) => !name.startsWith(PHASE_PREFIX));
const phase = all.filter((name) => name.startsWith(PHASE_PREFIX));

if (phase.length === 0) {
  console.error('error: no Polytos Phase 1 migrations found.');
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

log(`applying ${String(phase.length)} Polytos Phase 1 migrations on top`);
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
                         'membership_terms_acceptances')`,
);

if (created.rows[0].n !== 4) {
  console.error(
    `error: expected four membership tables after the upgrade, found ${String(created.rows[0].n)}.`,
  );
  process.exit(1);
}

const memberships = await client.query(
  `select count(*)::int as n from public.memberships`,
);
if (memberships.rows[0].n !== 0) {
  console.error('error: the upgrade created membership rows, which it must not.');
  process.exit(1);
}

await client.end();

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

let failures = 0;

for (const name of Object.keys(BASELINE)) {
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
    `financial figures is identical, and the four membership tables exist and are empty.`,
);
